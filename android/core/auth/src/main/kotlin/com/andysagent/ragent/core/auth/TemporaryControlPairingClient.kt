package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.protocol.TemporaryControlProtocol
import com.andysagent.ragent.core.protocol.TemporaryControlConnectionProtocol
import com.andysagent.ragent.core.protocol.TemporaryControlTicket
import com.andysagent.ragent.core.protocol.TemporaryPairingProtocol
import com.andysagent.ragent.core.protocol.VerifiedTemporaryConnection
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.SecureRandom
import java.util.Base64

@Serializable
data class TemporaryControlClaim(
    val instanceId: String, val invitationId: String, val invitationDigest: String,
    val requestId: String, val devicePublicKey: String, val token: String, val signature: String,
)

@Serializable
data class TemporaryControlClaimRecord(
    val ticket: TemporaryControlTicket,
    val claim: TemporaryControlClaim,
    val accepted: Boolean = false,
    val connectionRequestId: String? = null,
)

/** Encrypt the complete record and commit it before any broker request. */
interface TemporaryControlClaimJournal {
    fun read(instanceId: String): TemporaryControlClaimRecord?
    fun write(instanceId: String, record: TemporaryControlClaimRecord)
    fun clear(instanceId: String)
}

/** Device-bound enrollment and desktop-signed credential verification. */
class TemporaryControlPairingClient(
    private val broker: RagentTransport,
    private val identity: DeviceIdentityStore,
    private val journal: TemporaryControlClaimJournal,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val randomBytes: (ByteArray) -> Unit = SecureRandom()::nextBytes,
) {
    private val json = Json { ignoreUnknownKeys = false }

    suspend fun claim(raw: String): TemporaryControlClaimRecord {
        val ticket = requireNotNull(TemporaryControlProtocol.parseIfControl(raw, nowMs())) { "Not a temporary control QR" }
        val invitation = ticket.envelope.invitation
        val saved = journal.read(invitation.instanceId)
        if (saved != null) {
            require(saved.ticket == ticket) { "A different temporary control claim is already saved" }
            return submit(saved)
        }
        val publicKey = identity.publicKeyEncoded()
        val fingerprint = TemporaryPairingProtocol.deviceKeyFingerprint(publicKey)
        val requestId = id("rtr")
        val claim = TemporaryControlClaim(invitation.instanceId, invitation.invitationId,
            TemporaryControlProtocol.invitationDigest(invitation), requestId, publicKey, ticket.token,
            identity.sign(TemporaryControlProtocol.claimMessage(invitation, requestId, fingerprint)))
        val pending = TemporaryControlClaimRecord(ticket, claim)
        journal.write(invitation.instanceId, pending)
        return submit(pending)
    }

    /** A completion is usable only after checking the original QR, desktop signature and device key. */
    suspend fun poll(instanceId: String): TemporaryControlProtocol.VerifiedGrant? {
        val saved = requireNotNull(journal.read(instanceId)) { "Temporary control claim is not saved" }
        val claim = saved.claim
        require(TemporaryPairingProtocol.deviceKeyFingerprint(identity.publicKeyEncoded()) ==
            TemporaryPairingProtocol.deviceKeyFingerprint(claim.devicePublicKey)) { "Temporary device key changed" }
        val result = deviceRequest("result", saved, JsonObject(emptyMap()))
        require(result.getValue("instanceId").jsonPrimitive.content == claim.instanceId &&
            result.getValue("invitationId").jsonPrimitive.content == claim.invitationId)
        val completion = result["completion"] ?: return null
        return if (completion.toString() == "null") null else
            TemporaryControlProtocol.verifyCompletion(completion.toString(), saved.ticket, claim.devicePublicKey, nowMs())
    }

    /** Persist the request identity before sending, so retries select the original carrier. */
    suspend fun startConnection(instanceId: String) {
        requireNotNull(poll(instanceId)) { "Desktop confirmation is required" }
        val record = requireNotNull(journal.read(instanceId))
        val saved = if (record.connectionRequestId == null) record.copy(connectionRequestId = id("rtr"))
            .also { journal.write(instanceId, it) } else record
        val requestId = requireNotNull(saved.connectionRequestId)
        val response = deviceRequest("connect", saved, JsonObject(mapOf("connectionRequestId" to JsonPrimitive(requestId))))
        require(response.getValue("connectionRequestId").jsonPrimitive.content == requestId &&
            response.getValue("connectionStatus").jsonPrimitive.content in setOf("PENDING", "READY"))
    }

    suspend fun pollConnection(instanceId: String): VerifiedTemporaryConnection? {
        val grant = requireNotNull(poll(instanceId)) { "Desktop confirmation is required" }
        val saved = requireNotNull(journal.read(instanceId))
        val requestId = requireNotNull(saved.connectionRequestId) { "Connection has not been requested" }
        val response = deviceRequest("connection-result", saved, JsonObject(mapOf("connectionRequestId" to JsonPrimitive(requestId))))
        require(response.getValue("connectionRequestId").jsonPrimitive.content == requestId)
        val connection = response["connection"] ?: return null
        if (connection.toString() == "null") return null
        require(response.getValue("connectionStatus").jsonPrimitive.content == "READY")
        return TemporaryControlConnectionProtocol.verify(connection.toString(), saved.ticket, grant, requestId, nowMs())
    }

    private suspend fun deviceRequest(action: String, record: TemporaryControlClaimRecord, payload: JsonObject): JsonObject {
        val claim = record.claim; val nonce = id("rtn"); val issuedAt = nowMs()
        val message = TemporaryControlConnectionProtocol.brokerMessage(action, claim.instanceId, claim.invitationId,
            claim.requestId, issuedAt, nonce, payload)
        val proof = JsonObject(mapOf("instanceId" to JsonPrimitive(claim.instanceId),
            "invitationId" to JsonPrimitive(claim.invitationId), "requestId" to JsonPrimitive(claim.requestId),
            "issuedAt" to JsonPrimitive(issuedAt), "nonce" to JsonPrimitive(nonce), "payload" to payload,
            "signature" to JsonPrimitive(identity.sign(message))))
        val response = broker.execute(ApiRequest("POST", "/v1/temporary-control/$action", proof.toString()))
        return json.parseToJsonElement(response.body).jsonObject.also {
            require(it.getValue("instanceId").jsonPrimitive.content == claim.instanceId &&
                it.getValue("invitationId").jsonPrimitive.content == claim.invitationId)
        }
    }

    private suspend fun submit(record: TemporaryControlClaimRecord): TemporaryControlClaimRecord {
        if (record.accepted) return record
        val invitation = record.ticket.envelope.invitation
        TemporaryControlProtocol.verifyEnvelope(record.ticket.envelope, nowMs())
        require(TemporaryPairingProtocol.deviceKeyFingerprint(identity.publicKeyEncoded()) ==
            TemporaryPairingProtocol.deviceKeyFingerprint(record.claim.devicePublicKey))
        val response = broker.execute(ApiRequest("POST", "/v1/temporary-control/claim",
            json.encodeToString(TemporaryControlClaim.serializer(), record.claim)))
        val body = json.parseToJsonElement(response.body).jsonObject
        require(body.getValue("instanceId").jsonPrimitive.content == invitation.instanceId &&
            body.getValue("invitationId").jsonPrimitive.content == invitation.invitationId &&
            body.getValue("status").jsonPrimitive.content in setOf("CLAIMED", "ACTIVE"))
        return record.copy(accepted = true).also { journal.write(invitation.instanceId, it) }
    }

    private fun id(prefix: String): String = "${prefix}_${Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(24).also(randomBytes))}"
}
