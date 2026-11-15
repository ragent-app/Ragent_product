package com.andysagent.ragent.core.auth

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
enum class TemporaryTextStage { PendingSession, Preparing, Prepared, Committing, Accepted }

@Serializable
data class TemporaryTextOperation(
    val version: Int = 1,
    val operationId: String,
    val instanceId: String,
    val grantId: String,
    val sessionKey: String,
    val messageRequestId: String,
    val tool: String,
    val text: String,
    val createdAt: Long,
    val expiresAt: Long,
    val stage: TemporaryTextStage = TemporaryTextStage.PendingSession,
    val sessionId: String? = null,
    val scopeRevision: String? = null,
    val projectId: String? = null,
    val preparationId: String? = null,
    val runId: String? = null,
    val attachments: List<StagedTemporaryAttachment> = emptyList(),
    /** Set only after a terminal Run result has been fetched for display in the share UI. */
    val resultRetrievedAt: Long? = null,
) {
    fun scope(): TemporarySessionScope = TemporarySessionScope(requireNotNull(sessionId),
        requireNotNull(scopeRevision), projectId)
}

fun TemporaryTextOperation.canBeForgottenAfterResultReview(): Boolean =
    stage == TemporaryTextStage.Accepted && resultRetrievedAt != null

interface TemporaryTextOperationJournal {
    fun read(instanceId: String, grantId: String, operationId: String): TemporaryTextOperation?
    fun list(instanceId: String, grantId: String): List<TemporaryTextOperation>
    fun write(operation: TemporaryTextOperation)
    fun clear(instanceId: String, grantId: String, operationId: String)
}

/** Index and records use the same isolated encrypted namespace; a dangling index is harmless. */
class AndroidTemporaryTextOperationJournal(context: Context) : TemporaryTextOperationJournal {
    private val store = AndroidTemporaryEncryptedStore(context, "ragent-temporary-text-operations-v1",
        "ragent_temporary_operations_key_v1")
    private val json = Json { ignoreUnknownKeys = false }
    private val lock = Any()
    private val operationIdPattern = Regex("^top_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")

    override fun read(instanceId: String, grantId: String, operationId: String): TemporaryTextOperation? {
        require(operationIdPattern.matches(operationId))
        val raw = store.read(recordKey(instanceId, grantId, operationId)) ?: return null
        return json.decodeFromString<TemporaryTextOperation>(raw).also {
            require(it.version == 1 && it.instanceId == instanceId && it.grantId == grantId &&
                it.operationId == operationId) { "Temporary operation journal identity mismatch" }
        }
    }

    override fun list(instanceId: String, grantId: String): List<TemporaryTextOperation> = synchronized(lock) {
        index(instanceId, grantId).mapNotNull { read(instanceId, grantId, it) }
    }

    override fun write(operation: TemporaryTextOperation) = synchronized(lock) {
        require(operation.version == 1 && operationIdPattern.matches(operation.operationId) &&
            operation.text.toByteArray(Charsets.UTF_8).size <= 65_536)
        read(operation.instanceId, operation.grantId, operation.operationId)?.let { old ->
            require(operation.sessionKey == old.sessionKey && operation.messageRequestId == old.messageRequestId &&
                operation.tool == old.tool && operation.text == old.text && operation.createdAt == old.createdAt &&
                operation.expiresAt == old.expiresAt && operation.stage.ordinal >= old.stage.ordinal &&
                (old.resultRetrievedAt == null || operation.resultRetrievedAt == old.resultRetrievedAt) &&
                (operation.resultRetrievedAt == null || operation.stage == TemporaryTextStage.Accepted) &&
                old.attachments.size == operation.attachments.size && old.attachments.indices.all { index ->
                    val before = old.attachments[index]
                    val after = operation.attachments[index]
                    before.stageId == after.stageId && before.requestId == after.requestId &&
                        before.originalName == after.originalName && before.mimeType == after.mimeType &&
                        before.sizeBytes == after.sizeBytes && before.sha256 == after.sha256 &&
                        (before.assetId == null || before.assetId == after.assetId) &&
                        (!before.ready || after.ready)
                } && operation.attachments.all { (!it.ready && it.assetId == null) || (it.ready && it.assetId != null) } &&
                (old.sessionId == null || old.sessionId == operation.sessionId) &&
                (old.sessionId == null || old.projectId == operation.projectId) &&
                (old.scopeRevision == null || old.scopeRevision == operation.scopeRevision) &&
                (old.preparationId == null || old.preparationId == operation.preparationId) &&
                (old.runId == null || old.runId == operation.runId)) { "Temporary operation identity changed" }
        }
        val ids = index(operation.instanceId, operation.grantId)
        if (operation.operationId !in ids) {
            require(ids.size < 64) { "Temporary operation journal is full" }
            store.write(indexKey(operation.instanceId, operation.grantId),
                json.encodeToString(ids + operation.operationId))
        }
        store.write(recordKey(operation.instanceId, operation.grantId, operation.operationId),
            json.encodeToString(operation))
    }

    override fun clear(instanceId: String, grantId: String, operationId: String) = synchronized(lock) {
        require(operationIdPattern.matches(operationId))
        store.clear(recordKey(instanceId, grantId, operationId))
        store.write(indexKey(instanceId, grantId), json.encodeToString(index(instanceId, grantId) - operationId))
    }

    private fun index(instanceId: String, grantId: String): List<String> =
        (store.read(indexKey(instanceId, grantId))?.let { json.decodeFromString<List<String>>(it) } ?: emptyList()).also {
            require(it.size <= 64 && it.size == it.toSet().size && it.all(operationIdPattern::matches)) {
                "Temporary operation index is damaged"
            }
        }
    private fun indexKey(instanceId: String, grantId: String) = "index:$instanceId:$grantId"
    private fun recordKey(instanceId: String, grantId: String, operationId: String) =
        "operation:$instanceId:$grantId:$operationId"
}
