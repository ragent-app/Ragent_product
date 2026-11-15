package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.protocol.TemporaryAccessProtocol
import com.andysagent.ragent.core.protocol.TemporaryPairingEnvelope
import com.andysagent.ragent.core.protocol.TemporaryPairingProtocol
import com.andysagent.ragent.core.protocol.TemporaryConnectionProtocol
import com.andysagent.ragent.core.protocol.VerifiedTemporaryConnection
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** A physical QR carries both fields. The Accounts URL comes from app configuration, never this value. */
@Serializable
data class TemporaryPairingTicket(val version: Int, val envelope: TemporaryPairingEnvelope, val token: String)

@Serializable
data class TemporaryClaimRecord(
    val version: Int = 1,
    val ticket: TemporaryPairingTicket,
    val claim: TemporaryAccessProtocol.Claim,
    val claimAccepted: Boolean = false,
    val completion: String? = null,
    val connectionRequestId: String? = null,
    val connectionAccepted: Boolean = false,
    val connection: String? = null,
)

class TemporaryClaimConflictException(val instanceId: String) :
    IllegalStateException("Finish or clear the existing temporary claim first")

/** Implementations must encrypt the entire record and commit before effects at the broker. */
interface TemporaryClaimJournal {
    fun read(instanceId: String): TemporaryClaimRecord?
    /** Recover pending claims after Android has killed the process. */
    fun listInstanceIds(): List<String>
    fun write(instanceId: String, record: TemporaryClaimRecord)
    fun clear(instanceId: String)
}

/** Strictly anonymous broker flow. Results are returned only after original PC signatures verify. */
class TemporaryPairingClient(
    private val broker: RagentTransport,
    private val identity: DeviceIdentityStore,
    private val journal: TemporaryClaimJournal,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val randomBytes: (ByteArray) -> Unit = SecureRandom()::nextBytes,
) {
    private val json = Json { ignoreUnknownKeys = false }

    suspend fun claimFromQr(raw: String): TemporaryClaimRecord {
        val ticket = validateTicket(raw)
        val i = ticket.envelope.invitation
        val previous = journal.read(i.instanceId)
        if (previous != null && nowMs() < previous.ticket.envelope.invitation.accessExpiresAt) {
            if (previous.ticket != ticket) throw TemporaryClaimConflictException(i.instanceId)
            return submitSavedClaim(previous)
        }
        val key = identity.publicKeyEncoded()
        val requestId = newId("rtr")
        val claim = TemporaryAccessProtocol.Claim(i.instanceId, i.invitationId,
            TemporaryPairingProtocol.invitationDigest(i), requestId, key, ticket.token,
            identity.sign(TemporaryPairingProtocol.claimMessage(i, requestId, key)))
        val record = TemporaryClaimRecord(ticket = ticket, claim = claim)
        journal.write(i.instanceId, record)
        return submitSavedClaim(record)
    }

    /** Verifies the full signed payload and token before UI recovery is allowed to replace a claim. */
    fun validateTicket(raw: String): TemporaryPairingTicket {
        require(raw.length <= 20_000)
        val ticket = json.decodeFromString<TemporaryPairingTicket>(raw)
        require(ticket.version == 1 && Regex("^rtt_[A-Za-z0-9_-]{24,64}$").matches(ticket.token))
        val invitation = ticket.envelope.invitation
        TemporaryPairingProtocol.verifyForClaim(json.encodeToString(ticket.envelope),
            invitation.instanceId, invitation.instanceKeyFingerprint, nowMs())
        val hash = MessageDigest.getInstance("SHA-256").digest(ticket.token.toByteArray())
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        require(hash == invitation.secretHash) { "Temporary pairing code does not match its signed invitation" }
        return ticket
    }

    /** Safe after process death or unknown claim response: reuses the original signed request. */
    suspend fun resume(instanceId: String): TemporaryAccessProtocol.Completion? {
        val record = journal.read(instanceId) ?: return null
        val i = record.ticket.envelope.invitation
        if (nowMs() >= i.accessExpiresAt) {
            journal.clear(instanceId)
            return null
        }
        require(record.claim.instanceId == instanceId && record.claim.invitationId == i.invitationId)
        if (!record.claimAccepted) submitSavedClaim(record)
        val current = journal.read(instanceId) ?: return null
        current.completion?.let { return verifiedCompletion(current, it) }
        val proof = TemporaryAccessProtocol.brokerProof("result", i, current.claim.requestId,
            nowMs(), newId("rtn"), JsonObject(emptyMap()), identity::sign)
        val response = broker.execute(ApiRequest("POST", "/v1/temporary-pairing/result", proof.toString()))
        val completion = json.parseToJsonElement(response.body).jsonObject["completion"]
        if (completion == null || completion.toString() == "null") return null
        val raw = completion.toString()
        val verified = verifiedCompletion(current, raw)
        journal.write(instanceId, current.copy(completion = raw))
        return verified
    }

    /** A user action starts one connection exchange. The identity is durable before broker I/O. */
    suspend fun startConnection(instanceId: String): String {
        requireNotNull(resume(instanceId)) { "Temporary claim is not completed" }
        val record = requireNotNull(journal.read(instanceId))
        val requestId = record.connectionRequestId ?: newId("rtr")
        val pending = if (record.connectionRequestId == null) record.copy(connectionRequestId = requestId).also {
            journal.write(instanceId, it)
        } else record
        submitSavedConnection(pending)
        return requestId
    }

    /** Poll the original request; a lost response never creates a second TURN lease or room. */
    suspend fun resumeConnection(instanceId: String): VerifiedTemporaryConnection? {
        val completed = resume(instanceId) ?: return null
        val record = journal.read(instanceId) ?: return null
        val requestId = record.connectionRequestId ?: return null
        record.connection?.let { return verifiedConnection(record, completed, requestId, it) }
        if (!record.connectionAccepted) submitSavedConnection(record)
        val current = journal.read(instanceId) ?: return null
        val payload = JsonObject(mapOf("connectionRequestId" to JsonPrimitive(requestId)))
        val proof = TemporaryAccessProtocol.brokerProof("connection-result", current.ticket.envelope.invitation,
            current.claim.requestId, nowMs(), newId("rtn"), payload, identity::sign)
        val response = broker.execute(ApiRequest("POST", "/v1/temporary-pairing/connection-result", proof.toString()))
        val connection = json.parseToJsonElement(response.body).jsonObject["connection"]
        if (connection == null || connection.toString() == "null") return null
        val raw = connection.toString()
        val verified = verifiedConnection(current, completed, requestId, raw)
        journal.write(instanceId, current.copy(connection = raw))
        return verified
    }

    private suspend fun submitSavedConnection(record: TemporaryClaimRecord) {
        if (record.connectionAccepted) return
        val requestId = requireNotNull(record.connectionRequestId)
        require(record.completion != null) { "Temporary claim is not completed" }
        val payload = JsonObject(mapOf("connectionRequestId" to JsonPrimitive(requestId)))
        val proof = TemporaryAccessProtocol.brokerProof("connect", record.ticket.envelope.invitation,
            record.claim.requestId, nowMs(), newId("rtn"), payload, identity::sign)
        val response = broker.execute(ApiRequest("POST", "/v1/temporary-pairing/connect", proof.toString()))
        val body = json.parseToJsonElement(response.body).jsonObject
        require(body.getValue("connectionRequestId").jsonPrimitive.content == requestId &&
            body.getValue("connectionStatus").jsonPrimitive.content in setOf("PENDING", "READY"))
        journal.write(record.claim.instanceId, record.copy(connectionAccepted = true))
    }

    private fun verifiedConnection(record: TemporaryClaimRecord, completed: TemporaryAccessProtocol.Completion,
        requestId: String, raw: String): VerifiedTemporaryConnection {
        val verified = TemporaryConnectionProtocol.verifyDelivery(raw, record.ticket.envelope,
            record.claim, completed, requestId, nowMs())
        require(verified.businessAccessReady) { "Computer temporary business API is not ready" }
        return verified
    }

    private suspend fun submitSavedClaim(record: TemporaryClaimRecord): TemporaryClaimRecord {
        if (record.claimAccepted) return record
        val i = record.ticket.envelope.invitation
        require(nowMs() < i.accessExpiresAt)
        require(TemporaryPairingProtocol.deviceKeyFingerprint(identity.publicKeyEncoded()) ==
            TemporaryPairingProtocol.deviceKeyFingerprint(record.claim.devicePublicKey))
        val body = JsonObject(mapOf(
            "instanceId" to JsonPrimitive(record.claim.instanceId),
            "invitationId" to JsonPrimitive(record.claim.invitationId),
            "invitationDigest" to JsonPrimitive(record.claim.invitationDigest),
            "requestId" to JsonPrimitive(record.claim.requestId),
            "devicePublicKey" to JsonPrimitive(record.claim.devicePublicKey),
            "token" to JsonPrimitive(record.claim.token),
            "signature" to JsonPrimitive(record.claim.signature),
        ))
        val response = broker.execute(ApiRequest("POST", "/v1/temporary-pairing/claim", body.toString()))
        val status = json.parseToJsonElement(response.body).jsonObject.getValue("status").jsonPrimitive.content
        require(status == "CLAIMED" || status == "COMPLETED")
        return record.copy(claimAccepted = true).also { journal.write(i.instanceId, it) }
    }

    private fun verifiedCompletion(record: TemporaryClaimRecord, raw: String): TemporaryAccessProtocol.Completion {
        val i = record.ticket.envelope.invitation
        require(TemporaryPairingProtocol.deviceKeyFingerprint(identity.publicKeyEncoded()) ==
            TemporaryPairingProtocol.deviceKeyFingerprint(record.claim.devicePublicKey))
        return TemporaryAccessProtocol.verifyCompletion(raw, record.ticket.envelope, record.claim,
            i.instanceId, i.instanceKeyFingerprint, nowMs())
    }

    private fun newId(prefix: String): String = ByteArray(24).also(randomBytes).let {
        "${prefix}_${Base64.getUrlEncoder().withoutPadding().encodeToString(it)}"
    }
}
