package com.andysagent.ragent.core.network

/** The owner serializes this decision with credential writes before invalidating a connection. */
fun interface CredentialRejectionHandler {
    suspend fun reject(attemptedCredential: String?, stillCurrent: () -> Boolean, invalidate: () -> Unit)
}
