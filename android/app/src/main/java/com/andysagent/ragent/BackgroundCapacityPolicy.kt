package com.andysagent.ragent

import com.andysagent.ragent.core.auth.AccountSessionException

/** Only fresh account capacity can establish that a new target exceeds the limit. */
internal fun checkBackgroundConnectionCapacity(
    capacityFresh: Boolean,
    alreadyConnected: Boolean,
    currentConnections: Int,
    maximumConnections: Int,
    cooldownMs: Long,
) {
    if (!capacityFresh && cooldownMs > 0L) {
        throw AccountSessionException(429, "account_capacity_rate_limited",
            "Account capacity is temporarily unavailable.", retryable = true, retryAfterMs = cooldownMs)
    }
    if (capacityFresh) {
        require(alreadyConnected || currentConnections < maximumConnections) {
            "Your current account plan allows $maximumConnections computer connection(s)."
        }
    }
}
