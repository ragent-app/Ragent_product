package com.andysagent.ragent.core.auth

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class BrowserSignInRecoveryTest {
    private val now = Instant.parse("2026-10-23T13:00:00Z")
    private val pending = BrowserSignInRecovery("ManageDevices", AccountSessionChallenge(
        transactionId = "asess_browser_restore_0001", requestId = "request_browser_restore_0001",
        deviceId = "adev_browser_restore_0001", publicKeyFingerprint = "a".repeat(64),
        nonce = "nonce_browser_restore_0001", expiresAt = "2026-10-23T13:15:00Z", browserTicket = "obv_browser_restore_0001",
    ), computerId = "inst_browser_restore_0001", primaryComputer = false)

    @Test fun `new activity restores exact browser nonce request and target without creating another Google challenge`() {
        val saved = encodeBrowserSignInRecovery(pending)
        assertEquals(pending, restoreBrowserSignInRecovery(saved, now.plusSeconds(600)))
        assertFalse(saved.contains("idToken"))
        assertFalse(saved.contains("credential"))
    }
    @Test fun `exact deadline and malformed saved state cannot restore authority`() {
        assertNull(restoreBrowserSignInRecovery(encodeBrowserSignInRecovery(pending), now.plusSeconds(900)))
        assertNull(restoreBrowserSignInRecovery("not-json", now))
        assertNull(restoreBrowserSignInRecovery("x".repeat(8193), now))
        assertNull(restoreBrowserSignInRecovery(encodeBrowserSignInRecovery(pending.copy(challenge = pending.challenge.copy(browserTicket = ""))), now))
    }
}
