package com.andysagent.ragent.core.auth

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class PendingAccountPairing(val instanceId: String, val invitationId: String, val challenge: AccountSessionChallenge)

interface AccountPairingJournal {
    fun read(): PendingAccountPairing?
    fun write(value: PendingAccountPairing)
    fun clear()
}

class MemoryAccountPairingJournal : AccountPairingJournal {
    private var pending: PendingAccountPairing? = null
    override fun read() = pending
    override fun write(value: PendingAccountPairing) { pending = value }
    override fun clear() { pending = null }
}

/** One pending exchange survives process death; no Google token or QR bearer is stored here. */
class AndroidAccountPairingJournal(context: Context) : AccountPairingJournal {
    private val store = AndroidTemporaryEncryptedStore(context, "ragent-account-pairing", "ragent_account_pairing_v1", maxPlaintextBytes = 8192)
    override fun read(): PendingAccountPairing? = store.read("pending")?.let { Json.decodeFromString<PendingAccountPairing>(it) }
    override fun write(value: PendingAccountPairing) = store.write("pending", Json.encodeToString(value))
    override fun clear() = store.clear("pending")
}
