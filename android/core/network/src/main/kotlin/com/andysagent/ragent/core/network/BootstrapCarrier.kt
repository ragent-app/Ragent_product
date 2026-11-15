package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.p2p.P2PCandidate

/** The server-authorized carrier used for the first connection attempt. */
data class TurnCarrier(
    val endpoint: String,
    val candidateId: String?,
    val provider: String?,
    val p2pCandidate: P2PCandidate,
    val connectionId: String? = null,
)
