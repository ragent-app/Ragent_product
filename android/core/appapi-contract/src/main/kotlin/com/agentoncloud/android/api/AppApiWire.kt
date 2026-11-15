package com.agentoncloud.android.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/** Standalone public types; no engine, database, UI or phone-owner dependency. */
object AppApiWire {
    const val VERSION = 1
    const val PACKAGE = "com.agentoncloud.android"
    const val SERVICE = "com.andysagent.ragent.AppApiService"
    const val ACTION = "com.agentoncloud.android.action.BIND_APP_API"
    const val MAX_REQUEST_BYTES = 64 * 1024
    const val MAX_RESPONSE_BYTES = 128 * 1024
    val json = Json { encodeDefaults = true; ignoreUnknownKeys = false }
    inline fun <reified T> decode(value: String): T {
        require(value.toByteArray(Charsets.UTF_8).size <= MAX_REQUEST_BYTES) { "Request exceeds the transport budget" }
        return json.decodeFromString(value)
    }
    inline fun <reified T> encode(value: T): String = json.encodeToString(value)
    fun identifier(value: String) {
        require(value.isNotBlank() && value.length <= 256 && value.none(Char::isISOControl)) { "Invalid identifier" }
    }
}

@Serializable data class PublicError(val code: String, val message: String, val retryable: Boolean = false)
@Serializable data class PublicResponse(val apiVersion: Int = 1, val status: String = "COMPLETED",
    val data: JsonElement = JsonNull, val error: PublicError? = null)
@Serializable data class ApiInfo(val apiVersion: Int = 1, val minimumClientVersion: Int = 1,
    val maximumClientVersion: Int = 1, val maxRequestBytes: Int = AppApiWire.MAX_REQUEST_BYTES,
    val maxResponseBytes: Int = AppApiWire.MAX_RESPONSE_BYTES, val maxPageSize: Int = 32,
    val maxConcurrentCalls: Int = 8, val maxSubscriptions: Int = 4,
    val subscriptionMode: String = "OPERATION_REVISION_SNAPSHOTS",
    val consentAction: String = "com.agentoncloud.android.action.REQUEST_API_ACCESS")
@Serializable data class PageFilter(val apiVersion: Int = 1, val targetInstanceId: String? = null,
    val limit: Int = 16, val cursor: String? = null) {
    fun validate() { require(apiVersion == 1 && limit in 1..32); targetInstanceId?.let(AppApiWire::identifier)
        require(cursor == null || cursor.length <= 128) }
}
@Serializable data class PublicPage<T>(val items: List<T>, val nextCursor: String? = null,
    val observedAt: Long, val revision: String)
@Serializable data class PublicCapability(val id: String, val version: Int, val description: String,
    val mutates: Boolean, val targetRequired: Boolean, val implemented: Boolean,
    val authorization: String, val runtimeAvailability: String = "NOT_CHECKED")
@Serializable data class PublicTarget(val instanceId: String, val name: String, val aliases: Set<String>)
@Serializable data class PublicRuntime(val tool: String, val providerProfile: String? = null,
    val model: String? = null, val effort: String? = null, val serviceTier: String = "standard",
    val interactionMode: String = "agent")
@Serializable data class PublicResource(val resourceId: String, val revision: Long, val originalName: String,
    val mimeType: String, val sizeBytes: Long, val sha256: String, val renderAsFile: Boolean = true)
@Serializable data class PublicTaskRequest(val operationId: String, val instruction: String, val runtime: PublicRuntime,
    val apiVersion: Int = 1, val targetInstanceId: String? = null, val targetAlias: String? = null,
    val existingSessionId: String? = null, val projectId: String? = null, val agentId: String? = null,
    val title: String? = null, val sharedText: String? = null, val sourceUrls: List<String> = emptyList(),
    val deadlineAt: Long? = null, val allowDeferredSubmission: Boolean = false,
    val resources: List<PublicResource> = emptyList())
@Serializable data class PublicPreparedTask(val operationId: String, val preparationId: String,
    val targetInstanceId: String, val deadlineAt: Long, val stage: String)
/** No caller binding, original input, creation key, upload receipts or private paths. */
@Serializable data class PublicOperation(val operationId: String, val preparationId: String,
    val targetInstanceId: String, val deadlineAt: Long, val stage: String, val sessionId: String?,
    val runId: String?, val requestId: String, val queued: Boolean, val duplicate: Boolean,
    val revision: Long, val lastError: PublicError?)
@Serializable data class OperationWatch(val apiVersion: Int = 1, val operationId: String,
    val afterRevision: Long = -1, val lifetimeMs: Long = 60_000) {
    fun validate() { require(apiVersion == 1 && afterRevision >= -1 && lifetimeMs in 1..300_000); AppApiWire.identifier(operationId) }
}
@Serializable data class OperationEvent(val subscriptionId: String, val kind: String,
    val operation: PublicOperation? = null, val observedAt: Long, val error: PublicError? = null)
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable data class PublicInvocation(val capabilityId: String, val apiVersion: Int = 1,
    val operationId: String? = null, val page: PageFilter? = null, val revision: String? = null,
    val resourceId: String? = null, val downloadId: String? = null,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER)
    val session: PublicSessionRequest? = null,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER)
    val sessionMutation: PublicSessionMutationRequest? = null)
@Serializable data class PublicArtifact(val assetId: String, val originalName: String, val mimeType: String, val sizeBytes: Long?)
@Serializable data class PublicTaskResult(val sessionId: String, val requestId: String, val runId: String?,
    val finalRunId: String?, val state: String, val text: String?, val textTruncated: Boolean,
    val artifacts: List<PublicArtifact>, val observedAt: String, val hasAttachments: Boolean)
@Serializable data class PublicExportResource(val resourceId: String, val originalName: String, val mimeType: String,
    val available: Boolean, val sizeBytes: Long?, val sha256: String?, val errorCode: String?)
@Serializable data class PublicExportManifest(val targetInstanceId: String, val sessionId: String, val requestId: String,
    val runId: String, val finalRunId: String, val resources: List<PublicExportResource>,
    val expiresAt: String, val revision: String)
@Serializable data class PublicDownload(val downloadId: String, val state: String, val uri: String,
    val originalName: String, val mimeType: String, val sizeBytes: Long, val sha256: String,
    val expiresAt: Long)

@Serializable data class PublicConsentRequest(val capabilityIds: Set<String>, val targetIds: Set<String> = emptySet(),
    val sessionIds: Set<String>? = null, val projectIds: Set<String>? = null,
    val mayCreateSessions: Boolean = false, val lifetimeMs: Long = 3_600_000, val version: Int = 1)
@Serializable data class PublicConsentReceipt(val grantId: String, val capabilityIds: Set<String>, val targetIds: Set<String>,
    val expiresAt: Long, val sessionIds: Set<String>?, val projectIds: Set<String>?, val mayCreateSessions: Boolean, val version: Int = 1)

/** Bounded read-only Session arguments. Old invocations omit the new optional field entirely. */
@Serializable data class PublicSessionRequest(val targetInstanceId: String, val sessionId: String? = null,
    val query: String? = null, val projectId: String? = null, val limit: Int = 16, val cursor: String? = null)
@Serializable data class PublicSession(val targetInstanceId: String, val sessionId: String, val title: String,
    val projectId: String?, val state: String, val updatedAt: String?, val titleTruncated: Boolean)

@Serializable enum class PublicSessionMutationKind { RENAME, SET_PINNED, SET_ARCHIVED, SET_REVIEWED }
@Serializable data class PublicSessionMutationRequest(val operationId: String, val targetInstanceId: String,
    val sessionId: String, val kind: PublicSessionMutationKind, val title: String? = null,
    val flag: Boolean? = null, val projectId: String? = null, val deadlineAt: Long? = null, val apiVersion: Int = 1)
/** No caller binding, frozen command, request hash, original title or private journal payload. */
@Serializable data class PublicSessionMutation(val operationId: String, val targetInstanceId: String,
    val sessionId: String, val projectId: String?, val kind: PublicSessionMutationKind,
    val deadlineAt: Long, val stage: String, val revision: Long, val receipt: PublicSessionMutationReceipt?)
@Serializable data class PublicSessionMutationReceipt(val changed: Boolean, val revision: String,
    val scopeRevision: String, val observedAt: String)
