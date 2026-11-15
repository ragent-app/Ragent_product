package com.andysagent.ragent.core.auth

import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Android saved-instance state for an interrupted browser handoff; contains no account or Google credential. */
@Serializable
data class BrowserSignInRecovery(
    val purpose: String,
    val challenge: AccountSessionChallenge,
    val computerId: String? = null,
    val primaryComputer: Boolean = true,
)

private val browserRecoveryJson = Json { ignoreUnknownKeys = true }
private val browserRecoveryField = Regex("[A-Za-z0-9_.:-]{1,160}")

fun encodeBrowserSignInRecovery(value: BrowserSignInRecovery): String = browserRecoveryJson.encodeToString(value)

fun restoreBrowserSignInRecovery(payload: String?, now: Instant = Instant.now()): BrowserSignInRecovery? {
    if (payload == null || payload.length > 8192) return null
    val value = runCatching { browserRecoveryJson.decodeFromString<BrowserSignInRecovery>(payload) }.getOrNull() ?: return null
    val challenge = value.challenge
    if (!browserRecoveryField.matches(value.purpose) || listOf(challenge.transactionId, challenge.requestId,
            challenge.deviceId, challenge.publicKeyFingerprint, challenge.nonce).any { !browserRecoveryField.matches(it) }
        || challenge.browserTicket.isBlank() || challenge.browserTicket.length > 2048
        || challenge.completionRecoveryWindowMs !in 0L..120_000L
        || value.computerId?.let { !browserRecoveryField.matches(it) } == true) return null
    val expiry = runCatching { Instant.parse(challenge.expiresAt) }.getOrNull() ?: return null
    return value.takeIf { expiry.isAfter(now) }
}
