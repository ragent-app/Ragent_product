package com.andysagent.ragent.core.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class VerifiedTemporaryConnection(
    val instanceId: String,
    val deviceId: String,
    val connectionRequestId: String,
    val expiresAt: Long,
    val businessAccessReady: Boolean,
    val roomId: String,
    val roomSecret: String,
    val signalingEndpoint: String,
    val iceServers: List<TemporaryIceServer>,
    val signedBootstrap: String,
)

data class TemporaryIceServer(val urls: String, val username: String, val password: String)

/** The original PC, not Accounts, must sign both the delivery and nested v3 carrier contract. */
object TemporaryConnectionProtocol {
    private val json = Json { ignoreUnknownKeys = false }
    private val id = Regex("^rtr_[A-Za-z0-9_-]{24,64}$")
    private val room = Regex("^[a-f0-9]{40}$")
    private val secret = Regex("^[a-f0-9]{64}$")
    private val turnUrl = Regex("^turns?:[A-Za-z0-9.\\[\\]:-]+(?:\\?transport=(?:udp|tcp))?$")
    private val iso = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")

    fun verifyDelivery(raw: String, envelope: TemporaryPairingEnvelope,
        claim: TemporaryAccessProtocol.Claim, completion: TemporaryAccessProtocol.Completion,
        connectionRequestId: String, nowMs: Long): VerifiedTemporaryConnection {
        require(raw.length <= 24_576 && id.matches(connectionRequestId))
        val i = envelope.invitation
        val grant = completion.grant
        val credential = completion.credential
        require(nowMs >= grant.grantedAt && nowMs < credential.expiresAt &&
            claim.instanceId == i.instanceId && claim.invitationId == i.invitationId &&
            grant.requestId == claim.requestId && grant.accessExpiresAt == i.accessExpiresAt)
        val delivery = json.parseToJsonElement(raw).jsonObject
        exact(delivery, "instanceId", "invitationId", "requestId", "issuedAt", "nonce", "payload", "signature")
        require(delivery.string("instanceId") == i.instanceId && delivery.string("invitationId") == i.invitationId)
        require(id.matches(delivery.string("requestId")) && delivery.string("nonce").matches(Regex("^rtn_[A-Za-z0-9_-]{24,64}$")))
        val payload = delivery.getValue("payload").jsonObject
        exact(payload, "connectionRequestId", "bootstrap", "p2p", "carrierReady", "businessAccessReady")
        require(payload.string("connectionRequestId") == connectionRequestId && payload.bool("carrierReady"))
        val issuedAt = delivery.long("issuedAt")
        require(issuedAt in grant.grantedAt..nowMs && issuedAt < credential.expiresAt)
        val brokerMessage = JsonArray(listOf(JsonPrimitive("ragent-temporary-broker-v1"),
            JsonPrimitive("connection-publish"), JsonPrimitive(i.instanceId), JsonPrimitive(i.invitationId),
            JsonPrimitive(delivery.string("requestId")), JsonPrimitive(issuedAt),
            JsonPrimitive(delivery.string("nonce")), JsonPrimitive(hex(sha(TemporaryAccessProtocol.canonical(payload).toByteArray()))))).toString()
        TemporaryAccessProtocol.verifyEd25519(envelope.publicKey, brokerMessage, delivery.string("signature"))

        val contract = payload.getValue("bootstrap").jsonObject
        exact(contract, "contractVersion", "enrollmentKind", "instanceId", "deviceId", "connectionMode",
            "issuedAt", "expiresAt", "temporaryAccess", "candidates", "turn", "turnAuthorization",
            "initialCarrier", "upgrade", "fallback", "signature")
        require(contract.long("contractVersion") == 3L && contract.string("enrollmentKind") == "temporary-device" &&
            contract.string("instanceId") == i.instanceId && contract.string("deviceId") == grant.deviceId &&
            contract.string("connectionMode") == "turn-first" && contract["fallback"] == JsonNull)
        val contractIssued = timestamp(contract.string("issuedAt"))
        val expiry = timestamp(contract.string("expiresAt"))
        require(contractIssued in grant.grantedAt..issuedAt && expiry > nowMs && expiry <= credential.expiresAt)
        val signature = contract.getValue("signature").jsonObject
        exact(signature, "algorithm", "keyId", "signedAt", "value")
        require(signature.string("algorithm") == "ed25519" && signature.string("keyId") == i.instanceKeyFingerprint &&
            signature.string("signedAt") == contract.string("issuedAt"))
        val body = JsonObject(contract.filterKeys { it != "signature" })
        val signedPayload = "ragent-temporary-connection-bootstrap-v3\n" +
            hex(sha(TemporaryAccessProtocol.canonical(body).toByteArray()))
        TemporaryAccessProtocol.verifyEd25519(envelope.publicKey, signedPayload, signature.string("value"))

        val access = contract.getValue("temporaryAccess").jsonObject
        exact(access, "grantId", "invitationId", "requestId", "deviceKeyFingerprint", "deviceJwkThumbprint",
            "capabilities", "sessionScope", "expiresAt")
        require(access.string("grantId") == grant.grantId && access.string("invitationId") == i.invitationId &&
            access.string("requestId") == claim.requestId && access.string("deviceKeyFingerprint") == grant.deviceKeyFingerprint &&
            access.string("deviceJwkThumbprint") == TemporaryAccessProtocol.deviceJwkThumbprint(claim.devicePublicKey) &&
            access.string("sessionScope") == i.sessionScope && timestamp(access.string("expiresAt")) == credential.expiresAt &&
            access.getValue("capabilities").jsonArray.map { it.jsonPrimitive.content } == i.capabilities)

        val turn = contract.getValue("turn").jsonObject
        exact(turn, "provider", "transport", "appTrafficOnly", "credentialScope", "temporaryGrantId",
            "temporaryInvitationId", "accessExpiresAt", "expiresAt", "connectionId", "iceServers")
        val connectionId = turn.string("connectionId")
        require(turn.string("provider") == "cloudflare-realtime" && turn.string("transport") == "turn" &&
            turn.bool("appTrafficOnly") && turn.string("credentialScope") == "temporary-device-access" &&
            turn.string("temporaryGrantId") == grant.grantId && turn.string("temporaryInvitationId") == i.invitationId &&
            timestamp(turn.string("accessExpiresAt")) == credential.expiresAt &&
            timestamp(turn.string("expiresAt")) == expiry && connectionId.matches(Regex("^[A-Za-z0-9_-]{10,160}$")))
        val ice = turn.getValue("iceServers").jsonArray.map { value ->
            val server = value.jsonObject
            exact(server, "urls", "username", "password")
            require(turnUrl.matches(server.string("urls")) && server.string("username").isNotBlank() &&
                server.string("username").length <= 1024 && server.string("password").isNotBlank() &&
                server.string("password").length <= 2048)
            TemporaryIceServer(server.string("urls"), server.string("username"), server.string("password"))
        }
        require(ice.size in 1..8)
        val auth = contract.getValue("turnAuthorization").jsonObject
        require(auth.keys.containsAll(setOf("policyVersion", "authorized", "status", "deviceKind", "connectionId")) &&
            auth.string("policyVersion") == "turn-account-quota-v1" && auth.bool("authorized") &&
            auth.string("status") == "authorized" && auth.string("deviceKind") == "phone" &&
            auth.string("connectionId") == connectionId)

        val p2p = payload.getValue("p2p").jsonObject
        exact(p2p, "roomId", "secret", "signalingEndpoint")
        val roomId = p2p.string("roomId")
        val roomSecret = p2p.string("secret")
        val endpoint = p2p.string("signalingEndpoint")
        require(room.matches(roomId) && secret.matches(roomSecret) && roomId == roomIdFromSecret(roomSecret))
        val uri = java.net.URI(endpoint)
        require(uri.scheme in setOf("https", "wss") && uri.userInfo == null && uri.rawQuery == null &&
            uri.rawFragment == null && uri.host != null)

        val candidates = contract.getValue("candidates").jsonArray.map { it.jsonObject }
        require(candidates.size == 2)
        val turnCandidate = candidates[0]; val rtc = candidates[1]
        listOf(turnCandidate, rtc).forEach { exact(it, "id", "kind", "provider", "endpoint", "priority",
            "expiresAt", "requiresUserConsent", "metadata") }
        require(turnCandidate.string("kind") == "turn" && turnCandidate.string("provider") == "cloudflare-realtime" &&
            turnCandidate.string("endpoint") == ice.first().urls && timestamp(turnCandidate.string("expiresAt")) == expiry &&
            !turnCandidate.bool("requiresUserConsent") && rtc.string("kind") == "webrtc" &&
            rtc.string("provider") == "core_p2p" && rtc.string("endpoint") == endpoint &&
            timestamp(rtc.string("expiresAt")) == expiry && !rtc.bool("requiresUserConsent"))
        val rtcMeta = rtc.getValue("metadata").jsonObject
        exact(rtcMeta, "roomId", "turnAllowed")
        require(rtcMeta.string("roomId") == roomId && rtcMeta.bool("turnAllowed"))
        val turnMeta = turnCandidate.getValue("metadata").jsonObject
        exact(turnMeta, "appTrafficOnly", "carrier", "connectionId", "iceServers")
        require(turnMeta.bool("appTrafficOnly") && turnMeta.string("carrier") == "cloudflare-realtime-turn" &&
            turnMeta.string("connectionId") == connectionId && turnMeta.getValue("iceServers") == turn.getValue("iceServers"))
        val initial = contract.getValue("initialCarrier").jsonObject
        exact(initial, "candidateId", "kind", "provider", "endpoint")
        require(initial.string("candidateId") == turnCandidate.string("id") && initial.string("kind") == "turn" &&
            initial.string("provider") == "cloudflare-realtime" && initial.string("endpoint") == ice.first().urls)
        val upgrade = contract.getValue("upgrade").jsonObject
        exact(upgrade, "strategy", "targets", "retainCurrentWhenNoP2PPath")
        require(upgrade.string("strategy") == "probe-after-bootstrap" &&
            upgrade.getValue("targets").jsonArray.map { it.jsonPrimitive.content } == listOf("webrtc") &&
            upgrade.bool("retainCurrentWhenNoP2PPath"))
        return VerifiedTemporaryConnection(i.instanceId, grant.deviceId, connectionRequestId, expiry,
            payload.bool("businessAccessReady"), roomId, roomSecret, endpoint, ice, contract.toString())
    }

    private fun roomIdFromSecret(value: String): String = Mac.getInstance("HmacSHA256").apply {
        init(SecretKeySpec(value.toByteArray(), "HmacSHA256"))
    }.doFinal("ragent-p2p-room-v1".toByteArray()).let(::hex).take(40)

    private fun timestamp(value: String): Long {
        require(iso.matches(value))
        return Instant.parse(value).toEpochMilli()
    }

    private fun exact(value: JsonObject, vararg keys: String) { require(value.keys == keys.toSet()) }
    private fun JsonObject.string(key: String): String = getValue(key).jsonPrimitive.content
    private fun JsonObject.long(key: String): Long = getValue(key).jsonPrimitive.long
    private fun JsonObject.bool(key: String): Boolean = getValue(key).jsonPrimitive.boolean
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
