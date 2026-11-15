package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.p2p.P2PHttpRequest
import com.andysagent.ragent.core.p2p.P2PHttpResponse

/** Versioned extension point for a future user-authorized carrier. */
data class FutureCarrierCandidate(
    val endpoint: String,
    val requiresUserConsent: Boolean = false,
    val candidateId: String? = null,
    val kind: String = "future",
    val provider: String? = null,
)

/** A transport session supplied by a future carrier integration. */
interface FutureCarrierSession {
    val isOpen: Boolean

    /** Establish the connection. */
    suspend fun connect(): Result<Unit>

    /**
     * Send an HTTP request through the future carrier and wait for the response.
     * Responses are correlated by [P2PHttpRequest.id].
     */
    suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse>

    /** Release all resources. */
    fun close()
}

/** Injectable factory so ConnectivitySupervisor can remain testable. */
fun interface FutureCarrierSessionFactory {
    suspend fun create(candidate: FutureCarrierCandidate): FutureCarrierSession
}
