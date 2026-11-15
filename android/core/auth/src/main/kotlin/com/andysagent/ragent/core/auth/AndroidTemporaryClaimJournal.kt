package com.andysagent.ragent.core.auth

import android.content.Context
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Separate encrypted namespace: a temporary DPoP token can never be read as an Owner bearer. */
class AndroidTemporaryClaimJournal(context: Context) : TemporaryClaimJournal {
    private val store = AndroidTemporaryEncryptedStore(context, "ragent-temporary-claim-v1",
        "ragent_temporary_claim_key_v1", keyPrefix = "claim_", maxPlaintextBytes = 32_768)
    private val json = Json { ignoreUnknownKeys = false }
    private val lock = Any()
    private val indexKey = "temporary-claim-index-v1"
    private val instanceIdPattern = Regex("^inst_[A-Za-z0-9_-]{24,64}$")

    override fun read(instanceId: String): TemporaryClaimRecord? {
        val raw = store.read(instanceId) ?: return null
        val record = json.decodeFromString<TemporaryClaimRecord>(raw)
        require(record.version == 1 && record.ticket.version == 1 &&
            record.ticket.envelope.invitation.instanceId == instanceId && record.claim.instanceId == instanceId)
        return record
    }

    override fun listInstanceIds(): List<String> = synchronized(lock) {
        index().filter { read(it) != null }
    }

    override fun write(instanceId: String, record: TemporaryClaimRecord) = synchronized(lock) {
        require(instanceIdPattern.matches(instanceId))
        require(record.version == 1 && record.ticket.version == 1 &&
            record.ticket.envelope.invitation.instanceId == instanceId && record.claim.instanceId == instanceId)
        val ids = index()
        if (instanceId !in ids) {
            require(ids.size < 16) { "Temporary claim journal is full" }
            // Publish the index first; a missing record is harmless, an unindexed claim is not recoverable.
            store.write(indexKey, json.encodeToString(ids + instanceId))
        }
        store.write(instanceId, json.encodeToString(record))
    }

    override fun clear(instanceId: String) = synchronized(lock) {
        require(instanceIdPattern.matches(instanceId))
        store.clear(instanceId)
        store.write(indexKey, json.encodeToString(index() - instanceId))
    }

    private fun index(): List<String> =
        (store.read(indexKey)?.let { json.decodeFromString<List<String>>(it) } ?: emptyList()).also {
            require(it.size <= 16 && it.size == it.toSet().size && it.all(instanceIdPattern::matches)) {
                "Temporary claim index is damaged"
            }
        }
}
