package com.andysagent.ragent.core.domain

import com.andysagent.ragent.core.network.*
import java.net.URLEncoder
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.*

@Serializable
data class RunApiRun(
    val version: Int, val sessionId: String, val runId: String, val state: String, val terminal: Boolean,
    val createdAt: String, val updatedAt: String, val startedAt: String?, val completedAt: String?,
    val cancelRequested: Boolean, val cancelRequestedAt: String?, val launchAdmittedAt: String?,
    val dispatched: Boolean, val revision: String,
)
@Serializable
data class RunApiRunReply(val version: Int, val run: RunApiRun, val observedAt: String)
@Serializable
data class RunApiList(val version: Int, val sessionId: String, val runs: List<RunApiRun>, val nextCursor: String?, val observedAt: String)
@Serializable
data class RunApiEvent(
    val seq: Long, val runId: String, val type: String, val role: String?, val timestamp: String?,
    val text: String?, val textTruncated: Boolean, val toolName: String?,
)
@Serializable
data class RunApiEvents(
    val version: Int, val sessionId: String, val runId: String, val historyRevision: Long,
    val events: List<RunApiEvent>, val scannedThrough: Long, val latestSeq: Long, val hasMore: Boolean, val observedAt: String,
)
@Serializable
data class RunApiArtifact(val assetId: String, val originalName: String, val mimeType: String, val sizeBytes: Long?)
@Serializable
data class RunApiResult(
    val version: Int, val resultContractVersion: Int, val sessionId: String, val runId: String?, val finalRunId: String?,
    val state: String, val text: String?, val textTruncated: Boolean, val artifacts: List<RunApiArtifact>,
    val hasAttachments: Boolean, val observedAt: String,
)
@Serializable
data class RunApiWait(
    val version: Int, val sessionId: String, val runId: String, val run: RunApiRun,
    val changed: Boolean, val timedOut: Boolean, val observedAt: String,
)
@Serializable
data class RunApiCancellation(val version: Int, val run: RunApiRun, val disposition: String, val observedAt: String)

/** Fixed target protocol only. Phone caller policy and durable effect journal belong to the App API coordinator. */
class ScopedRunClient(val instanceId: String, private val transport: RagentTransport) {
    init { require(canonicalIdentifier(instanceId, 256) && transport !is SwitchingRagentTransport) }
    suspend fun readScope(sessionId: String) = ScopedMessageClient(instanceId, transport).readScope(sessionId)

    suspend fun requireSupport() {
        val c = scopedObject(scopedExecute(transport, ApiRequest("GET", "/api/run-api-contract")))
        fun unsupported(): Nothing = throw ApiException(501, "CAPABILITY_UNSUPPORTED", "Required conditional Run protocol is unavailable")
        if (c["version"] != JsonPrimitive(1) || c["scopeHeader"] != JsonPrimitive(SessionScopeCondition.HEADER) ||
            c["scopeContextPath"] != JsonPrimitive("/api/sessions/{sessionId}/app-api-context") ||
            c["readsDispatch"] != JsonPrimitive(false) || c["cancellationDeadline"] != JsonPrimitive(true) ||
            c["cancellationRequestedIsTerminal"] != JsonPrimitive(false) || c["cancellationReceipt"] != JsonPrimitive(false) ||
            (c["maxResponseBytes"] as? JsonPrimitive)?.intOrNull?.let { it >= 131072 } != true ||
            (c["listLimit"] as? JsonPrimitive)?.intOrNull?.let { it >= 32 } != true ||
            (c["eventScanLimit"] as? JsonPrimitive)?.intOrNull != 128 ||
            (c["eventTextBytes"] as? JsonPrimitive)?.intOrNull?.let { it >= 8192 } != true ||
            (c["maxWaitMs"] as? JsonPrimitive)?.intOrNull?.let { it >= 30000 } != true) unsupported()
        val operations = c["operations"] as? JsonArray ?: unsupported()
        for ((id, endpoint) in OPERATIONS) {
            val rows = operations.filter { (it as? JsonObject)?.get("id") == JsonPrimitive(id) }
            if (rows.size != 1) unsupported()
            val row = rows.single() as JsonObject
            if (row["method"] != JsonPrimitive(endpoint.first) || row["path"] != JsonPrimitive(endpoint.second) ||
                row["readonly"] != JsonPrimitive(endpoint.first == "GET")) unsupported()
        }
    }

    suspend fun get(scope: SessionScopeCondition, runId: String): RunApiRunReply =
        decode<RunApiRunReply>(request(scope, runId)).also {
            check(it.version == 1 && scopedTimestamp(it.observedAt)); validateRun(it.run, scope, runId)
        }

    suspend fun list(scope: SessionScopeCondition, limit: Int = 32, cursor: String? = null): RunApiList {
        require(limit in 1..32 && (cursor == null || CURSOR.matches(cursor)))
        val query = "?limit=$limit" + (cursor?.let { "&cursor=${encode(it)}" } ?: "")
        return decode<RunApiList>(request(scope, suffix = query)).also {
            check(it.version == 1 && it.sessionId == scope.sessionId && scopedTimestamp(it.observedAt) &&
                it.runs.size <= limit && it.runs.map { run -> run.runId }.distinct().size == it.runs.size &&
                (it.nextCursor == null || CURSOR.matches(it.nextCursor)))
            it.runs.forEach { run -> validateRun(run, scope, run.runId) }
        }
    }

    suspend fun events(scope: SessionScopeCondition, runId: String, afterSeq: Long = 0, historyRevision: Long? = null, limit: Int = 32): RunApiEvents {
        require(afterSeq in 0..MAX_SAFE_INTEGER && (historyRevision == null || historyRevision in 0..MAX_SAFE_INTEGER) && limit in 1..32)
        require(afterSeq == 0L || historyRevision != null)
        val query = "/events?afterSeq=$afterSeq&limit=$limit" + (historyRevision?.let { "&historyRevision=$it" } ?: "")
        return decode<RunApiEvents>(request(scope, runId, query)).also {
            check(it.version == 1 && it.sessionId == scope.sessionId && it.runId == runId && scopedTimestamp(it.observedAt))
            check(it.historyRevision in 0..MAX_SAFE_INTEGER && (historyRevision == null || it.historyRevision == historyRevision))
            check(it.scannedThrough in afterSeq..MAX_SAFE_INTEGER && it.latestSeq in it.scannedThrough..MAX_SAFE_INTEGER)
            check(it.scannedThrough - afterSeq <= 128 && it.events.size <= limit && it.hasMore == (it.scannedThrough < it.latestSeq))
            var previous = afterSeq
            it.events.forEach { event ->
                check(event.seq > previous && event.seq <= it.scannedThrough && event.runId == runId)
                check(Regex("[a-z][a-z0-9_]{0,63}").matches(event.type) && event.role in setOf(null, "user", "assistant", "system"))
                check(event.timestamp == null || scopedTimestamp(event.timestamp))
                check(boundedText(event.text, 8192) && boundedText(event.toolName, 256))
                previous = event.seq
            }
        }
    }

    suspend fun result(scope: SessionScopeCondition, runId: String): RunApiResult =
        decode<RunApiResult>(request(scope, runId, "/result")).also {
            check(it.version == 1 && it.resultContractVersion == 1 && it.sessionId == scope.sessionId && it.runId == runId && scopedTimestamp(it.observedAt))
            check(it.state in setOf("queued", "checking", "running", "failed", "cancelled", "ready") && boundedText(it.text, 49152))
            check(it.finalRunId == null || identifier(it.finalRunId)); check(it.artifacts.size <= 16)
            check(it.artifacts.map { item -> item.assetId }.distinct().size == it.artifacts.size)
            if (it.state == "ready") check(it.finalRunId != null && it.text != null)
            else check(it.text == null && it.finalRunId == null && it.artifacts.isEmpty() && !it.hasAttachments)
            it.artifacts.forEach { item ->
                check(Regex("fasset_[a-f0-9]{24}").matches(item.assetId) && boundedText(item.originalName, 1020) &&
                    boundedText(item.mimeType, 512) && (item.sizeBytes == null || item.sizeBytes in 0..MAX_SAFE_INTEGER))
            }
        }

    suspend fun wait(scope: SessionScopeCondition, runId: String, afterRevision: String? = null, timeoutMs: Int = 15000): RunApiWait {
        require(timeoutMs in 0..30000 && (afterRevision == null || REVISION.matches(afterRevision)))
        val query = "/wait?timeoutMs=$timeoutMs" + (afterRevision?.let { "&afterRevision=$it" } ?: "")
        return decode<RunApiWait>(request(scope, runId, query)).also {
            check(it.version == 1 && it.sessionId == scope.sessionId && it.runId == runId && scopedTimestamp(it.observedAt))
            validateRun(it.run, scope, runId)
            check(it.changed == (it.run.revision != afterRevision) && it.timedOut == (!it.changed && !it.run.terminal))
        }
    }

    /** One explicit POST. Unknown response is recovered through get(), never an internal POST retry. */
    suspend fun cancel(scope: SessionScopeCondition, runId: String, expiresAt: String): RunApiCancellation {
        require(scopedTimestamp(expiresAt))
        val body = buildJsonObject { put("version", 1); put("expiresAt", expiresAt) }.toString()
        return decode<RunApiCancellation>(request(scope, runId, "/cancel", "POST", body)).also {
            check(it.version == 1 && scopedTimestamp(it.observedAt)); validateRun(it.run, scope, runId)
            check(it.disposition in setOf("already_terminal", "cancellation_requested"))
            if (it.disposition == "already_terminal") check(it.run.terminal) else check(it.run.cancelRequested)
        }
    }

    private fun request(scope: SessionScopeCondition, runId: String? = null, suffix: String = "", method: String = "GET", body: String? = null): ApiRequest {
        scope.validate(); require(identifier(scope.sessionId) && (runId == null || identifier(runId)))
        val path = "/api/sessions/${encode(scope.sessionId)}/app-api-runs" + (runId?.let { "/${encode(it)}" } ?: "") + suffix
        return ApiRequest(method, path, body = body, headers = scope.headers(), contentType = if (body == null) null else "application/json")
    }
    private suspend inline fun <reified T> decode(request: ApiRequest): T =
        SessionMutationJson.decodeFromString<T>(scopedObject(scopedExecute(transport, request)).toString())
    private fun validateRun(run: RunApiRun, scope: SessionScopeCondition, runId: String) {
        check(run.version == 1 && run.sessionId == scope.sessionId && run.runId == runId && identifier(runId))
        check(Regex("[a-z][a-z0-9_-]{0,63}").matches(run.state) && run.terminal == (run.state in setOf("completed", "failed", "cancelled")))
        check(REVISION.matches(run.revision) && scopedTimestamp(run.createdAt) && scopedTimestamp(run.updatedAt))
        listOf(run.startedAt, run.completedAt, run.cancelRequestedAt, run.launchAdmittedAt).forEach { check(it == null || scopedTimestamp(it)) }
    }
    private fun identifier(value: String) = canonicalIdentifier(value, 256) && '/' !in value && '\\' !in value && value !in setOf(".", "..")
    private fun boundedText(value: String?, maximum: Int) = value == null || (scopedUnicode(value) && value.toByteArray(Charsets.UTF_8).size <= maximum)
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    companion object {
        const val MAX_SAFE_INTEGER = 9007199254740991L
        const val LIST_PATH = "/api/sessions/{sessionId}/app-api-runs"
        const val ITEM_PATH = "$LIST_PATH/{runId}"
        private val REVISION = Regex("[a-f0-9]{64}")
        private val CURSOR = Regex("[a-f0-9]{64}:(0|[1-9][0-9]{0,3})")
        private val OPERATIONS = mapOf("runs.list" to ("GET" to LIST_PATH), "runs.get" to ("GET" to ITEM_PATH),
            "runs.events" to ("GET" to "$ITEM_PATH/events"), "runs.result" to ("GET" to "$ITEM_PATH/result"),
            "runs.wait" to ("GET" to "$ITEM_PATH/wait"), "runs.cancel" to ("POST" to "$ITEM_PATH/cancel"))
    }
}
