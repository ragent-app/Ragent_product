package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.network.ApiException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

/** One durable text share. Unknown responses are reconciled under the original identities. */
class TemporaryTextTaskCoordinator(
    private val instanceId: String,
    private val grantId: String,
    private val grantExpiresAt: Long,
    private val api: TemporaryTextTaskApi,
    private val journal: TemporaryTextOperationJournal,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val attachmentBytes: TemporaryAttachmentByteStore? = null,
) {
    private val mutex = Mutex()
    private val iso = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    init {
        require(instanceId.matches(Regex("^inst_[A-Za-z0-9_-]{24,64}$")) &&
            grantId.matches(Regex("^rtg_[A-Za-z0-9_-]{24,64}$")) && grantExpiresAt > 0)
    }

    fun create(
        text: String,
        tool: String = "codex",
        attachments: List<StagedTemporaryAttachment> = emptyList(),
    ): TemporaryTextOperation {
        val now = nowMs()
        val expiry = minOf(grantExpiresAt - 1_000, now + 120_000)
        require(attachments.size <= 16 && attachments.sumOf { it.sizeBytes } <= 100L * 1024 * 1024)
        require(attachments.map { it.stageId }.distinct().size == attachments.size &&
            attachments.map { it.requestId }.distinct().size == attachments.size)
        attachments.forEach {
            require(it.stageId.matches(Regex("^tast_[a-f0-9]{32}$")) &&
                it.requestId.matches(Regex("^[A-Za-z0-9_-]{1,128}$")) && it.assetId == null && !it.ready &&
                it.sizeBytes in 1..TemporaryAttachmentUploader.MAX_ATTACHMENT_BYTES.toLong() &&
                it.sha256.matches(Regex("^[a-f0-9]{64}$")))
        }
        require(expiry > now + 5_000 && text.isNotBlank() && !text.contains('\u0000') &&
            text.toByteArray(Charsets.UTF_8).size <= 65_536 && tool.matches(Regex("^[A-Za-z0-9_-]{1,64}$")))
        val operation = TemporaryTextOperation(operationId = "top_${UUID.randomUUID()}", instanceId = instanceId,
            grantId = grantId, sessionKey = "session_${UUID.randomUUID()}",
            messageRequestId = "message_${UUID.randomUUID()}", tool = tool, text = text,
            createdAt = now, expiresAt = expiry, attachments = attachments)
        journal.write(operation)
        return operation
    }

    suspend fun advance(operationId: String,
        onAttachmentProgress: (name: String, sentBytes: Long, totalBytes: Long) -> Unit = { _, _, _ -> }): TemporaryTextOperation = mutex.withLock {
        require(operationId.matches(Regex("^top_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")))
        var state = requireNotNull(journal.read(instanceId, grantId, operationId))
        repeat(5) {
            when (state.stage) {
                TemporaryTextStage.PendingSession -> {
                    require(nowMs() < state.expiresAt) { "Temporary message deadline passed before Session creation" }
                    val response = api.createSession(JsonObject(mapOf(
                        "idempotencyKey" to JsonPrimitive(state.sessionKey), "tool" to JsonPrimitive(state.tool),
                        "name" to JsonPrimitive("Shared from Android"))))
                    val session = response.getValue("session").jsonObject
                    require(response.getValue("version").jsonPrimitive.content == "1" &&
                        response.getValue("startsRun").jsonPrimitive.content == "false")
                    val sessionId = session.getValue("sessionId").jsonPrimitive.content
                    val revision = session.getValue("scopeRevision").jsonPrimitive.content
                    val project = session.getValue("projectId").jsonPrimitive.contentOrNull
                    TemporarySessionScope(sessionId, revision, project).json()
                    state = state.copy(stage = TemporaryTextStage.Preparing, sessionId = sessionId,
                        scopeRevision = revision, projectId = project)
                    journal.write(state)
                }
                TemporaryTextStage.Preparing -> {
                    state = uploadAttachments(state, onAttachmentProgress)
                    val prepared = lookupPreparation(state) ?: run {
                        require(nowMs() < state.expiresAt) { "Temporary message deadline passed before preparation" }
                        api.prepareMessage(state.scope(), JsonObject(mapOf(
                            "version" to JsonPrimitive(1), "requestId" to JsonPrimitive(state.messageRequestId),
                            "text" to JsonPrimitive(state.text), "attachments" to JsonArray(
                                state.attachments.map { attachment ->
                                    require(attachment.ready && attachment.assetId != null)
                                    JsonObject(mapOf(
                                        "assetId" to JsonPrimitive(attachment.assetId),
                                        "sha256" to JsonPrimitive(attachment.sha256),
                                        "sizeBytes" to JsonPrimitive(attachment.sizeBytes),
                                    ))
                                }),
                            "runOptions" to JsonObject(emptyMap()),
                            "expiresAt" to JsonPrimitive(iso.format(Instant.ofEpochMilli(state.expiresAt))))))
                    }
                    require(prepared.getValue("requestId").jsonPrimitive.content == state.messageRequestId &&
                        prepared.getValue("sessionId").jsonPrimitive.content == state.sessionId &&
                        prepared.getValue("state").jsonPrimitive.content == "prepared")
                    val preparationId = prepared.getValue("preparationId").jsonPrimitive.content
                    require(preparationId.matches(Regex("^mprep_[a-f0-9-]{36}$")))
                    state = state.copy(stage = TemporaryTextStage.Prepared, preparationId = preparationId)
                    journal.write(state)
                }
                TemporaryTextStage.Prepared -> {
                    // Publish intent before a commit response can be lost.
                    state = state.copy(stage = TemporaryTextStage.Committing)
                    journal.write(state)
                }
                TemporaryTextStage.Committing -> {
                    val receipt = lookupReceipt(state) ?: run {
                        require(nowMs() < state.expiresAt) { "Temporary message expired before Run acceptance" }
                        api.commitMessage(state.scope(), state.messageRequestId,
                            JsonObject(mapOf("version" to JsonPrimitive(1),
                                "preparationId" to JsonPrimitive(requireNotNull(state.preparationId)))))
                    }
                    require(receipt.getValue("requestId").jsonPrimitive.content == state.messageRequestId &&
                        receipt.getValue("sessionId").jsonPrimitive.content == state.sessionId)
                    if (receipt.getValue("accepted").jsonPrimitive.content != "true") return@withLock state
                    val runId = receipt.getValue("runId").jsonPrimitive.content
                    require(runId.isNotBlank() && runId.length <= 256)
                    state = state.copy(stage = TemporaryTextStage.Accepted, runId = runId)
                    journal.write(state)
                }
                TemporaryTextStage.Accepted -> return@withLock state
            }
        }
        state
    }

    private suspend fun lookupPreparation(state: TemporaryTextOperation): JsonObject? =
        try { api.preparation(state.scope(), state.messageRequestId) }
        catch (error: ApiException) { if (error.statusCode == 404) null else throw error }

    private suspend fun lookupReceipt(state: TemporaryTextOperation): JsonObject? =
        try {
            api.messageReceipt(state.scope(), state.messageRequestId).takeIf {
                it["accepted"]?.jsonPrimitive?.content == "true"
            }
        }
        catch (error: ApiException) { if (error.statusCode == 404) null else throw error }

    private suspend fun uploadAttachments(original: TemporaryTextOperation,
        onProgress: (name: String, sentBytes: Long, totalBytes: Long) -> Unit): TemporaryTextOperation {
        if (original.attachments.isEmpty() || original.attachments.all { it.ready }) return original
        val byteStore = requireNotNull(attachmentBytes) { "Temporary attachment staging is unavailable" }
        val attachmentApi = api as? TemporaryAttachmentApi
            ?: error("Temporary computer does not support attachment upload")
        val uploader = TemporaryAttachmentUploader(attachmentApi)
        var state = original
        for (index in state.attachments.indices) {
            val source = state.attachments[index]
            if (source.ready) continue
            require(nowMs() < state.expiresAt) { "Temporary attachment upload deadline passed" }
            val receipt = uploader.upload(state.scope(), TemporaryAttachmentBodySource(
                requestId = source.requestId,
                originalName = source.originalName,
                mimeType = source.mimeType,
                sizeBytes = source.sizeBytes,
                sha256 = source.sha256,
                openStream = { byteStore.openVerifiedStream(source.stageId, source.sizeBytes, source.sha256) },
            )) { sent, total -> onProgress(source.originalName, sent, total) }
            require(receipt.status == "ready" && receipt.sizeBytes == source.sizeBytes &&
                receipt.sha256 == source.sha256 && receipt.originalName == source.originalName &&
                receipt.mimeType == source.mimeType)
            val nextAttachments = state.attachments.toMutableList().also {
                it[index] = source.copy(assetId = receipt.assetId, ready = true)
            }
            state = state.copy(attachments = nextAttachments)
            journal.write(state)
            byteStore.delete(source.stageId)
        }
        return state
    }
}
