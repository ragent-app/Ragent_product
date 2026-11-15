package com.andysagent.ragent

import android.content.Context
import com.andysagent.ragent.core.auth.AndroidTemporaryEncryptedStore
import com.andysagent.ragent.core.auth.DeviceIdentityStore
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.Base64
import java.util.UUID

/** Independent of account profiles: logout must not erase its own recovery fence. */
internal data class LocalAccountLinkRecord(
    val instanceId: String,
    val linkId: String,
    val deviceId: String,
    val accountId: String,
    val generation: Long,
    val tombstone: Boolean = false,
    val pendingEventId: String? = null,
    val pendingAction: String? = null,
    val localClearCompleted: Boolean = true,
    /** Encrypted, logout-only outbox; never used as active account authority. */
    val pendingCloudToken: String? = null,
    val pendingCloudEventId: String? = null,
    val unbindPending: Boolean = false,
) {
    override fun toString(): String = "LocalAccountLinkRecord(instanceId=$instanceId, linkId=$linkId, generation=$generation, tombstone=$tombstone)"
}

internal class LocalAccountLinkStore(context: Context) {
    private val encrypted = AndroidTemporaryEncryptedStore(context, "ragent-local-account-link", "ragent_local_account_link_v1", maxPlaintextBytes = 4096)
    private val index = context.getSharedPreferences("ragent-local-account-link-index", Context.MODE_PRIVATE)

    @Synchronized fun instanceIds(): Set<String> = index.getStringSet("instances", emptySet())?.toSet() ?: emptySet()
    @Synchronized fun epoch(instanceId: String): Long = index.getLong("epoch:$instanceId", 0L)
    @Synchronized fun invalidate(instanceId: String) {
        val next = Math.addExact(epoch(instanceId), 1L)
        check(index.edit().putLong("epoch:$instanceId", next).commit())
    }

    @Synchronized fun read(instanceId: String): LocalAccountLinkRecord? = encrypted.read(instanceId)?.let { raw ->
        val obj = Json.parseToJsonElement(raw).jsonObject
        val record = LocalAccountLinkRecord(
            instanceId = obj.getValue("instanceId").jsonPrimitive.content,
            linkId = obj.getValue("linkId").jsonPrimitive.content,
            deviceId = obj.getValue("deviceId").jsonPrimitive.content,
            accountId = obj.getValue("accountId").jsonPrimitive.content,
            generation = obj.getValue("generation").jsonPrimitive.longOrNull ?: error("Invalid link generation"),
            tombstone = obj.getValue("tombstone").jsonPrimitive.content == "true",
            pendingEventId = obj["pendingEventId"]?.jsonPrimitive?.contentOrNull,
            pendingAction = obj["pendingAction"]?.jsonPrimitive?.contentOrNull,
            localClearCompleted = obj["localClearCompleted"]?.jsonPrimitive?.content != "false",
            pendingCloudToken = obj["pendingCloudToken"]?.jsonPrimitive?.contentOrNull,
            pendingCloudEventId = obj["pendingCloudEventId"]?.jsonPrimitive?.contentOrNull,
            unbindPending = obj["unbindPending"]?.jsonPrimitive?.content == "true",
        )
        require(record.instanceId == instanceId && record.generation >= 0 &&
            record.linkId.matches(Regex("^lnk_[A-Za-z0-9_-]{16,128}$")) &&
            record.deviceId.matches(Regex("^rdev_[A-Za-z0-9_-]{1,128}$")) &&
            record.accountId.matches(Regex("^acct_[A-Za-z0-9_-]{1,128}$"))) { "Invalid account link record" }
        record
    }

    @Synchronized fun write(record: LocalAccountLinkRecord) {
        require(record.generation >= 0)
        // Index first: a crash may leave an empty entry, but must not hide an outbox.
        check(index.edit().putStringSet("instances", instanceIds() + record.instanceId).commit())
        encrypted.write(record.instanceId, buildJsonObject {
            put("instanceId", record.instanceId); put("linkId", record.linkId); put("deviceId", record.deviceId)
            put("accountId", record.accountId); put("generation", record.generation); put("tombstone", record.tombstone)
            record.pendingEventId?.let { put("pendingEventId", it) }
            record.pendingAction?.let { put("pendingAction", it) }
            put("localClearCompleted", record.localClearCompleted)
            record.pendingCloudToken?.let { put("pendingCloudToken", it) }
            record.pendingCloudEventId?.let { put("pendingCloudEventId", it) }
            put("unbindPending", record.unbindPending)
        }.toString())
    }

    /** Durable before any local logout or acknowledgement to the peer. */
    @Synchronized fun fenceLogout(instanceId: String, accountToken: String?): LocalAccountLinkRecord? {
        val current = read(instanceId) ?: return null
        return current.copy(tombstone = true,
            pendingEventId = current.pendingEventId.takeIf { current.tombstone && current.pendingAction == "logout" } ?: UUID.randomUUID().toString(), pendingAction = "logout",
            localClearCompleted = false, pendingCloudToken = accountToken,
            pendingCloudEventId = accountToken?.let { UUID.randomUUID().toString() }).also(::write)
    }

    @Synchronized fun clear(instanceId: String) {
        encrypted.clear(instanceId)
        check(index.edit().putStringSet("instances", instanceIds() - instanceId).commit())
    }
}

/** Independent encrypted records permit old and late-granted sessions to be revoked separately. */
internal class LocalSessionRevocationOutbox(context: Context) {
    private val encrypted = AndroidTemporaryEncryptedStore(context, "ragent-session-revocations", "ragent_session_revocations_v1", maxPlaintextBytes = 131040)
    private fun entries(): Map<String, String> = encrypted.read("queue")?.let { raw ->
        Json.parseToJsonElement(raw).jsonObject.mapValues { it.value.jsonPrimitive.content }
    } ?: emptyMap()
    private fun save(entries: Map<String, String>) = encrypted.write("queue", buildJsonObject {
        entries.forEach { (id, token) -> put(id, token) }
    }.toString())
    @Synchronized fun ids(): Set<String> = entries().keys
    @Synchronized fun enqueue(token: String, taskId: String = UUID.randomUUID().toString()): String {
        save(entries() + (taskId to "token:$token"))
        return taskId
    }
    @Synchronized fun beginRecovery(handle: String, id: String): String = id.also {
        save(entries() + (id to "handoff:$handle"))
    }
    @Synchronized fun token(taskId: String): String? = entries()[taskId]?.removePrefix("token:")?.takeIf { entries()[taskId]?.startsWith("token:") == true }
    @Synchronized fun recovery(taskId: String): String? = entries()[taskId]?.removePrefix("handoff:")?.takeIf { entries()[taskId]?.startsWith("handoff:") == true }
    @Synchronized fun replaceWithToken(taskId: String, token: String) { save(entries() + (taskId to "token:$token")) }
    @Synchronized fun remove(taskId: String) {
        save(entries() - taskId)
    }
}

internal data class LocalAccountLinkStatus(
    val instanceId: String,
    val state: String,
    val linkId: String?,
    val deviceId: String?,
    val accountId: String?,
    val generation: Long,
    val ownerAccountId: String?,
    val ownerAuthority: String,
)

internal fun parseLocalAccountLinkStatus(body: String, expectedInstanceId: String): LocalAccountLinkStatus {
    val obj = Json.parseToJsonElement(body).jsonObject
    require(obj["version"]?.jsonPrimitive?.content == "1") { "Unsupported account link version" }
    fun value(name: String) = obj[name]?.jsonPrimitive?.contentOrNull
    val result = LocalAccountLinkStatus(
        instanceId = requireNotNull(value("instanceId")), state = requireNotNull(value("state")),
        linkId = value("linkId"), deviceId = value("deviceId"), accountId = value("accountId"),
        generation = obj["generation"]?.jsonPrimitive?.longOrNull ?: error("Invalid link generation"),
        ownerAccountId = value("ownerAccountId"), ownerAuthority = requireNotNull(value("ownerAuthority")),
    )
    require(result.instanceId == expectedInstanceId && result.generation >= 0 &&
        result.state in setOf("unlinked", "active", "signed_out", "login_pending") &&
        result.ownerAuthority in setOf("active", "unavailable", "unbound")) { "Invalid account link status" }
    return result
}

/** Re-signing an outbox retry changes only its validity window, never its event identity. */
internal fun localAccountLinkEvent(record: LocalAccountLinkRecord, action: String,
    identity: DeviceIdentityStore, eventId: String, nowMs: Long): ApiRequest {
    require(action in setOf("link", "logout", "invite") && nowMs > 0 && nowMs <= Long.MAX_VALUE - 300_000)
    val expiresAt = nowMs + 300_000
    val canonical = JsonArray(listOf(JsonPrimitive("ragent-local-account-link-v1"), JsonPrimitive(1),
        JsonPrimitive(record.instanceId), JsonPrimitive(record.linkId), JsonPrimitive(record.deviceId),
        JsonPrimitive(record.accountId), JsonPrimitive(action), JsonPrimitive(eventId), JsonPrimitive(record.generation),
        JsonPrimitive(nowMs), JsonPrimitive(expiresAt))).toString()
    val signature = Base64.getEncoder().encodeToString(Base64.getUrlDecoder().decode(identity.sign(canonical)))
    return ApiRequest("POST", "/api/local/account-link", buildJsonObject {
        put("version", 1); put("action", action); put("instanceId", record.instanceId); put("linkId", record.linkId)
        put("deviceId", record.deviceId); put("accountId", record.accountId); put("eventId", eventId)
        put("expectedGeneration", record.generation); put("issuedAt", nowMs); put("expiresAt", expiresAt); put("signature", signature)
    }.toString(), requestId = eventId, idempotencyKey = eventId)
}
