package com.andysagent.ragent.core.auth

import android.content.Context
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Full-control claims have a separate encrypted namespace from v1 shares and trusted-device credentials. */
class AndroidTemporaryControlClaimJournal(context: Context) : TemporaryControlClaimJournal {
    private val store = AndroidTemporaryEncryptedStore(context, "ragent-temporary-control-claim-v1",
        "ragent_temporary_control_claim_key_v1", keyPrefix = "control_", maxPlaintextBytes = 32_768)
    private val json = Json { ignoreUnknownKeys = false }
    private val pattern = Regex("^inst_[A-Za-z0-9_-]{24,64}$")

    override fun read(instanceId: String): TemporaryControlClaimRecord? {
        require(pattern.matches(instanceId))
        val raw = store.read(instanceId) ?: return null
        return json.decodeFromString<TemporaryControlClaimRecord>(raw).also { validate(instanceId, it) }
    }

    override fun write(instanceId: String, record: TemporaryControlClaimRecord) {
        validate(instanceId, record)
        store.write(instanceId, json.encodeToString(record))
    }

    override fun clear(instanceId: String) {
        require(pattern.matches(instanceId))
        store.clear(instanceId)
    }

    private fun validate(instanceId: String, record: TemporaryControlClaimRecord) {
        require(pattern.matches(instanceId) && record.ticket.version == 1 &&
            record.ticket.kind == com.andysagent.ragent.core.protocol.TemporaryControlProtocol.QR_KIND &&
            record.ticket.envelope.invitation.instanceId == instanceId && record.claim.instanceId == instanceId &&
            record.claim.invitationId == record.ticket.envelope.invitation.invitationId)
    }
}
