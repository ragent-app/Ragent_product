package com.andysagent.ragent.core.auth

/** The caller fences local pairing writes against an explicit target removal. */
fun interface PairingWriteGuard {
    suspend fun persist(instanceId: String, writes: suspend () -> Unit)

    companion object {
        val Direct = PairingWriteGuard { _, writes -> writes() }
    }
}
