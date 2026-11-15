package com.andysagent.ragent.core.protocol

import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

@Serializable
data class AccountPairingResponse(
    val instanceId: String,
    val invitationId: String,
    val status: String,
    val expiresAt: Long,
    val session: CompleteAccountSessionResponse? = null,
)

/** Keep aligned with lib/account-pairing-protocol.mjs, including canonical payload hashing. */
fun buildAccountPairingProof(action: String, instanceId: String, invitationId: String,
    issuedAt: Long, nonce: String, payload: JsonObject): String {
    require(action in setOf("claim", "result"))
    require(listOf(instanceId, invitationId, nonce).all { it.matches(Regex("^[A-Za-z0-9_-]{16,160}$")) })
    require(issuedAt >= 0)
    val hash = MessageDigest.getInstance("SHA-256")
        .digest(ConnectionBootstrapVerifier.canonicalJson(payload).toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    return JsonArray(listOf(JsonPrimitive("ragent-account-pairing-v1"), JsonPrimitive(action),
        JsonPrimitive(instanceId), JsonPrimitive(invitationId), JsonPrimitive(issuedAt),
        JsonPrimitive(nonce), JsonPrimitive(hash))).toString()
}
