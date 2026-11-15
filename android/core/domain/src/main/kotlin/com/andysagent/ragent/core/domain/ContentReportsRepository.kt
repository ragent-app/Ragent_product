package com.andysagent.ragent.core.domain

import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

enum class ContentReportReason(val wire: String) {
    Unsafe("unsafe"), Harassment("hate_or_harassment"), Sexual("sexual_content"),
    Privacy("privacy"), Deceptive("deceptive"), Other("other"),
}

@Serializable
data class ContentReportPayload(
    val schemaVersion: Int = 1,
    val requestId: String,
    val reason: String,
    val details: String,
    val includeContent: Boolean,
    val content: String,
    val appVersion: String,
) {
    fun validate() {
        require(schemaVersion == 1 && REPORT_UUID.matches(requestId))
        require(ContentReportReason.entries.any { it.wire == reason })
        require(details.length <= 1000 && content.length <= 4000 && appVersion.length <= 64)
        require(listOf(details, content, appVersion).none { '\u0000' in it })
        require(includeContent || content.isEmpty())
    }
}

private val REPORT_UUID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")

@Serializable
data class ContentReportReceipt(val id: String, val status: String, val receivedAt: String, val updatedAt: String)

@Serializable
data class ContentReportRecord(val payload: ContentReportPayload, val receipt: ContentReportReceipt? = null)

@Serializable
private data class ReceiptEnvelope(val contractVersion: Int, val requestId: String, val receipt: ContentReportReceipt)

/** One private, bounded local record. Loading never sends or retries a report. */
interface ContentReportJournal {
    suspend fun read(): ContentReportRecord?
    suspend fun write(record: ContentReportRecord)
    suspend fun clear()
}

enum class ContentReportError { Storage, Unavailable, RateLimited, Rejected, Conflict, Unconfirmed }
class ContentReportException(val kind: ContentReportError) : RuntimeException(kind.name)

interface ContentReportsRepository {
    suspend fun saved(): ContentReportRecord?
    suspend fun submit(reason: ContentReportReason, details: String, includeContent: Boolean, content: String): ContentReportRecord
    suspend fun checkReceipt(retryIfMissing: Boolean = false): ContentReportRecord
    /** Clears this phone's copy only; it cannot withdraw an already accepted report. */
    suspend fun clearLocal()
}

/** Fixed anonymous Accounts transport; never the selected computer's transport. */
class HttpContentReportsRepository(
    private val transport: RagentTransport,
    private val journal: ContentReportJournal,
    private val appVersion: String,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) : ContentReportsRepository {
    private val mutex = Mutex()
    private val json = Json { encodeDefaults = true; ignoreUnknownKeys = false }

    private suspend fun load(): ContentReportRecord? = storage { journal.read()?.also { validateContentReportRecord(it) } }
    override suspend fun saved(): ContentReportRecord? = mutex.withLock { load() }
    override suspend fun clearLocal() = mutex.withLock { storage { journal.clear() } }

    override suspend fun submit(reason: ContentReportReason, details: String, includeContent: Boolean, content: String): ContentReportRecord = mutex.withLock {
        // Concurrent taps cannot replace a saved request or issue another POST.
        if (load() != null) throw ContentReportException(ContentReportError.Conflict)
        val payload = ContentReportPayload(requestId = newId(), reason = reason.wire,
            details = details.trim(), includeContent = includeContent,
            content = if (includeContent) content.trim() else "", appVersion = appVersion)
        payload.validate()
        if (json.encodeToString(payload).toByteArray(Charsets.UTF_8).size > 20 * 1024) {
            throw ContentReportException(ContentReportError.Rejected)
        }
        val record = ContentReportRecord(payload)
        storage { journal.write(record) } // Persist identity/payload BEFORE any possible external effect.
        post(record)
    }

    override suspend fun checkReceipt(retryIfMissing: Boolean): ContentReportRecord = mutex.withLock {
        val record = load() ?: throw ContentReportException(ContentReportError.Storage)
        try {
            val response = execute(ApiRequest("GET", "/v1/content-reports/${record.payload.requestId}"))
            acknowledge(record, response)
        } catch (error: ApiException) {
            // Never replay a receipt already known accepted, even if a later server loses it.
            if (error.statusCode == 404 && record.receipt == null && retryIfMissing) post(record)
            else throw classify(error)
        }
    }

    private suspend fun post(record: ContentReportRecord): ContentReportRecord {
        try {
            val response = execute(ApiRequest("POST", "/v1/content-reports",
                body = json.encodeToString(record.payload), contentType = "application/json; charset=utf-8"))
            return acknowledge(record, response)
        } catch (error: ApiException) { throw classify(error) }
    }

    private suspend fun execute(request: ApiRequest): String {
        val response = try { transport.execute(request) }
        catch (cancel: CancellationException) { throw cancel }
        catch (error: ApiException) { throw error }
        catch (_: Exception) { throw ContentReportException(ContentReportError.Unconfirmed) }
        if (!response.isSuccessful) throw ApiException(response.statusCode, null, "Report request failed")
        // A receipt is tiny; reject accidental HTML/history/body responses without displaying them.
        if (response.body.length > 4096) throw ContentReportException(ContentReportError.Unconfirmed)
        return response.body
    }

    private suspend fun acknowledge(record: ContentReportRecord, body: String): ContentReportRecord {
        val reply = try {
            json.decodeFromString<ReceiptEnvelope>(body).also {
                require(it.contractVersion == 1 && it.requestId == record.payload.requestId)
                validateContentReportRecord(ContentReportRecord(record.payload, it.receipt))
                val old = record.receipt
                if (old != null) {
                    require(it.receipt.receivedAt == old.receivedAt)
                    require(reportStatusRank(it.receipt.status) >= reportStatusRank(old.status))
                    require(Instant.parse(it.receipt.updatedAt) >= Instant.parse(old.updatedAt))
                }
            }
        } catch (_: Exception) { throw ContentReportException(ContentReportError.Unconfirmed) }
        return record.copy(receipt = reply.receipt).also { storage { journal.write(it) } }
    }

    private fun classify(error: ApiException) = ContentReportException(when (error.statusCode) {
        409 -> ContentReportError.Conflict
        429 -> ContentReportError.RateLimited
        400, 413, 415 -> ContentReportError.Rejected
        503 -> ContentReportError.Unavailable
        else -> ContentReportError.Unconfirmed
    })
    private suspend fun <T> storage(block: suspend () -> T): T = try { block() }
    catch (cancel: CancellationException) { throw cancel }
    catch (_: Exception) { throw ContentReportException(ContentReportError.Storage) }
}

private fun reportStatusRank(status: String): Int = listOf("received", "in_review", "closed").indexOf(status)

fun validateContentReportRecord(record: ContentReportRecord) {
    record.payload.validate()
    record.receipt?.let {
        require(it.id == "report_${record.payload.requestId}" && reportStatusRank(it.status) >= 0)
        require(Instant.parse(it.updatedAt) >= Instant.parse(it.receivedAt))
    }
}
