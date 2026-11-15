package com.andysagent.ragent.core.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.net.URI
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Verify the original desktop signature and every binding before using carrier credentials. */
object TemporaryControlConnectionProtocol {
    private val json = Json { ignoreUnknownKeys = false }
    private val requestId = Regex("^rtr_[A-Za-z0-9_-]{24,64}$")
    private val nonce = Regex("^rtn_[A-Za-z0-9_-]{24,64}$")
    private val turnUrl = Regex("^turns?:[A-Za-z0-9.\\[\\]:-]+(?:\\?transport=(?:udp|tcp))?$")

    fun brokerMessage(action: String, instanceId: String, invitationId: String, requestId: String,
        issuedAt: Long, nonce: String, payload: JsonObject): String {
        require(action in setOf("result", "connect", "connection-result", "connection-publish"))
        require(requestId.matches(this.requestId) && nonce.matches(this.nonce) && issuedAt >= 0)
        return JsonArray(listOf(JsonPrimitive("ragent-temporary-control-broker-v1"), JsonPrimitive(action),
            JsonPrimitive(instanceId), JsonPrimitive(invitationId), JsonPrimitive(requestId), JsonPrimitive(issuedAt),
            JsonPrimitive(nonce), JsonPrimitive(hex(sha(TemporaryAccessProtocol.canonical(payload).toByteArray()))))).toString()
    }

    fun verify(raw: String, ticket: TemporaryControlTicket, grant: TemporaryControlProtocol.VerifiedGrant,
        expectedRequestId: String, nowMs: Long): VerifiedTemporaryConnection {
        require(raw.length <= 24_576 && requestId.matches(expectedRequestId))
        val invitation = TemporaryControlProtocol.verifyEnvelope(ticket.envelope, ticket.envelope.invitation.createdAt)
        val delivery = json.parseToJsonElement(raw).jsonObject
        require(delivery.keys == setOf("instanceId", "invitationId", "requestId", "issuedAt", "nonce", "payload", "signature"))
        require(delivery.string("instanceId") == invitation.instanceId && delivery.string("invitationId") == invitation.invitationId)
        val issuedAt = delivery.long("issuedAt")
        require(issuedAt in grant.grantedAt..nowMs && nowMs < grant.expiresAt)
        val payload = delivery.getValue("payload").jsonObject
        require(payload.keys == setOf("connectionRequestId", "connection") && payload.string("connectionRequestId") == expectedRequestId)
        val message = brokerMessage("connection-publish", invitation.instanceId, invitation.invitationId,
            delivery.string("requestId"), issuedAt, delivery.string("nonce"), payload)
        TemporaryAccessProtocol.verifyEd25519(ticket.envelope.publicKey, message, delivery.string("signature"))
        val c = payload.getValue("connection").jsonObject
        require(c.keys == setOf("version", "instanceId", "invitationId", "grantId", "deviceId", "connectionId", "connectionRequestId",
            "issuedAt", "expiresAt", "signalingEndpoint", "roomId", "secret", "iceServers"))
        require(c.long("version") == 1L && c.string("instanceId") == invitation.instanceId &&
            c.string("invitationId") == invitation.invitationId && c.string("grantId") == grant.grantId &&
            c.string("deviceId") == grant.deviceId && c.string("connectionRequestId") == expectedRequestId &&
            c.string("connectionId").matches(Regex("^[A-Za-z0-9_-]{10,160}$")))
        val createdAt = c.long("issuedAt"); val expiresAt = c.long("expiresAt")
        require(createdAt in grant.grantedAt..issuedAt && expiresAt in (nowMs + 1)..grant.expiresAt)
        val endpoint = c.string("signalingEndpoint"); val uri = URI(endpoint)
        require(uri.scheme in setOf("https", "wss") && !uri.host.isNullOrBlank() && uri.userInfo == null &&
            uri.query == null && uri.fragment == null && endpoint.length <= 2048)
        val secret = c.string("secret"); val roomId = c.string("roomId")
        require(secret.matches(Regex("^[a-f0-9]{64}$")) && roomId == roomId(secret))
        val ice = c.getValue("iceServers").jsonArray.map {
            val server = it.jsonObject
            require(server.keys == setOf("urls", "username", "password"))
            val urls = server.string("urls"); val username = server.string("username"); val password = server.string("password")
            require(turnUrl.matches(urls) && username.length in 1..1024 && password.length in 1..2048)
            TemporaryIceServer(urls, username, password)
        }
        require(ice.size in 1..8)
        return VerifiedTemporaryConnection(invitation.instanceId, grant.deviceId, expectedRequestId, expiresAt,
            true, roomId, secret, endpoint, ice, raw)
    }

    private fun roomId(secret: String): String = Mac.getInstance("HmacSHA256").apply {
        init(SecretKeySpec(secret.toByteArray(), "HmacSHA256"))
    }.doFinal("ragent-p2p-room-v1".toByteArray()).let(::hex).take(40)
    private fun JsonObject.string(key: String) = getValue(key).jsonPrimitive.content
    private fun JsonObject.long(key: String) = getValue(key).jsonPrimitive.long
    private fun sha(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value)
    private fun hex(value: ByteArray) = value.joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
