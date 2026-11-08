package com.andysagent.agentoc

import com.andysagent.agentoc.core.auth.AccountSessionException
import com.andysagent.agentoc.core.domain.AccountsRepositoryException
import com.andysagent.agentoc.feature.workbench.accounts.GoogleAccountStatus
import com.andysagent.agentoc.feature.workbench.PairingOnboardingEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class StartupAccountSessionGateTest {
    @Test
    fun `active temporary control keeps signed out phone on workbench after activity recreation`() {
        for (active in listOf(true, false)) assertEquals(!active, shouldShowWelcomeAtLaunch(
            startupOnboardingLoading = false, hasPendingGoogleBinding = false,
            welcomeSuppressedBySignIn = false, hasLocalComputers = false,
            accountStatus = GoogleAccountStatus.SignedOut, pairingOpen = false, temporaryControlActive = active))
    }

    @Test
    fun `startup waits for directory and account session`() {
        var resolved = false

        resolved = updateStartupAccountSessionResolved(
            directoryLoaded = false,
            accountSessionResolved = true,
            alreadyResolved = resolved,
        )
        assertFalse(resolved)

        resolved = updateStartupAccountSessionResolved(
            directoryLoaded = true,
            accountSessionResolved = false,
            alreadyResolved = resolved,
        )
        assertFalse(resolved)

        resolved = updateStartupAccountSessionResolved(
            directoryLoaded = true,
            accountSessionResolved = true,
            alreadyResolved = resolved,
        )
        assertTrue(resolved)
    }

    @Test
    fun `account refresh does not reopen completed startup gate`() {
        val resolved = updateStartupAccountSessionResolved(
            directoryLoaded = true,
            accountSessionResolved = false,
            alreadyResolved = true,
        )

        assertTrue(resolved)
    }

    @Test
    fun `missing local account session resolves startup as signed out`() {
        val resolved = updateStartupAccountSessionResolved(
            directoryLoaded = true,
            accountSessionResolved = false,
            alreadyResolved = false,
            accountSessionMetadataLoaded = true,
        )

        assertTrue(resolved)
    }

    @Test
    fun `stored local account session cache resolves startup before verification`() {
        val resolved = updateStartupAccountSessionResolved(
            directoryLoaded = true,
            accountSessionResolved = false,
            alreadyResolved = false,
            accountSessionMetadataLoaded = true,
        )

        assertTrue(resolved)
    }

    @Test
    fun `stored account session can be reused while the account view is still refreshing`() {
        assertTrue(
            shouldReuseStoredAccountSession(
                hasVerifiedAccountSession = false,
                accountSessionMetadataLoaded = true,
                hasStoredAccountSession = true,
            ),
        )
        assertFalse(
            shouldReuseStoredAccountSession(
                hasVerifiedAccountSession = false,
                accountSessionMetadataLoaded = true,
                hasStoredAccountSession = false,
            ),
        )
    }

    @Test
    fun `valid desktop account handoff can start before local account metadata loads`() {
        val accountHandoff = "agentoc://pair?v=4&i=inst_protocol_test_0001" +
            "&q=rpinv_protocol_test_0001&t=rpi_test_token" +
            "&x=2099-01-01T00%3A00%3A00Z&p=key&f=${"a".repeat(64)}&accountType=google"
        val computerPairing = "agentoc://pair?v=3&i=inst_protocol_test_0001" +
            "&e=https%3A%2F%2Fcomputer.example&t=rpi_test_token&x=2099-01-01T00%3A00%3A00Z"

        assertTrue(isValidAccountHandoffPairingUri(accountHandoff))
        assertFalse(isValidAccountHandoffPairingUri(computerPairing))
        assertFalse(isValidAccountHandoffPairingUri("agentoc://pair?v=4&invalid=true"))
        assertFalse(shouldWaitForAccountSessionMetadataBeforePairing(accountHandoff, accountSessionMetadataLoaded = false))
        assertTrue(shouldWaitForAccountSessionMetadataBeforePairing(computerPairing, accountSessionMetadataLoaded = false))
        assertFalse(shouldWaitForAccountSessionMetadataBeforePairing(computerPairing, accountSessionMetadataLoaded = true))
        assertTrue(
            shouldWaitForAccountSessionMetadataBeforePairing(
                "agentoc://pair?v=4&invalid=true",
                accountSessionMetadataLoaded = false,
            ),
        )
    }

    @Test
    fun `only account authorization failures request Google sign in`() {
        assertTrue(
            isAccountReauthorizationFailure(
                AccountSessionException(401, "account_session_expired", "expired"),
            ),
        )
        assertTrue(
            isAccountReauthorizationFailure(
                AccountsRepositoryException(403, "owner_auth_account_credential_invalid", "forbidden", retryable = false),
            ),
        )
        assertFalse(
            isAccountReauthorizationFailure(
                AccountSessionException(400, "account_session_target_invalid", "target invalid"),
            ),
        )
        assertFalse(
            isAccountReauthorizationFailure(
                AccountsRepositoryException(0, "accounts_unavailable", "offline", retryable = true),
            ),
        )
    }

    @Test
    fun `connection quota is not presented as a transient rate limit`() {
        for (code in listOf("turn_connection_quota_exceeded", "turn_quota_exceeded")) {
            assertEquals(ConnectionErrorCopy(R.string.computer_connection_quota_reached),
                connectionErrorMessage(AccountSessionException(429, code, "quota", retryable = true)))
            assertEquals(ConnectionErrorCopy(R.string.computer_connection_quota_reached),
                connectionErrorMessage(AccountsRepositoryException(429, code, "quota", retryable = true)))
        }
    }

    @Test
    fun `rate limited connection uses the server retry delay in its message`() {
        assertEquals(
            ConnectionErrorCopy(R.string.computer_connection_busy_retry_after, 3L),
            connectionErrorMessage(
                AccountSessionException(
                    statusCode = 429,
                    code = "owner_auth_rate_limited",
                    message = "busy",
                    retryable = true,
                    retryAfterMs = 2_100L,
                ),
            ),
        )
    }

    @Test
    fun `computer connection failures keep account authorization separate`() {
        assertEquals(
            ComputerConnectionFailureUi.ReauthorizeAccount,
            computerConnectionFailureUi(
                AccountSessionException(401, "account_session_expired", "expired"),
            ),
        )
        assertEquals(
            ComputerConnectionFailureUi.ReauthorizeAccount,
            computerConnectionFailureUi(
                AccountsRepositoryException(403, "owner_auth_account_credential_invalid", "forbidden", retryable = false),
            ),
        )
        assertEquals(
            ComputerConnectionFailureUi.ShowConnectionError(ConnectionErrorCopy(R.string.computer_connection_unavailable)),
            computerConnectionFailureUi(IllegalStateException("transport unavailable")),
        )
        assertEquals(
            ComputerConnectionFailureUi.ShowConnectionError(
                ConnectionErrorCopy(R.string.computer_connection_busy),
            ),
            computerConnectionFailureUi(
                AccountSessionException(429, "owner_auth_rate_limited", "busy", retryable = true),
            ),
        )
    }

    @Test
    fun `signed out account returns to login even when a local computer remains`() {
        assertTrue(
            shouldShowWelcomeAtLaunch(
                startupOnboardingLoading = false,
                hasPendingGoogleBinding = false,
                welcomeSuppressedBySignIn = true,
                hasLocalComputers = true,
                accountStatus = GoogleAccountStatus.SignedOut,
                pairingOpen = false,
            ),
        )
    }

    @Test
    fun `verified account without a computer opens the connection welcome`() {
        assertTrue(
            shouldShowWelcomeAtLaunch(
                startupOnboardingLoading = false,
                hasPendingGoogleBinding = false,
                welcomeSuppressedBySignIn = false,
                hasLocalComputers = false,
                accountStatus = GoogleAccountStatus.SignedIn,
                pairingOpen = false,
            ),
        )
    }

    @Test
    fun `signed out first launch opens the sign in connection welcome`() {
        assertTrue(
            shouldShowWelcomeAtLaunch(
                startupOnboardingLoading = false,
                hasPendingGoogleBinding = false,
                welcomeSuppressedBySignIn = false,
                hasLocalComputers = false,
                accountStatus = GoogleAccountStatus.SignedOut,
                pairingOpen = false,
            ),
        )
    }

    @Test
    fun `temporary account verification failure keeps existing local workbench`() {
        assertFalse(
            shouldShowWelcomeAtLaunch(
                startupOnboardingLoading = false,
                hasPendingGoogleBinding = false,
                welcomeSuppressedBySignIn = false,
                hasLocalComputers = true,
                accountStatus = GoogleAccountStatus.VerificationUnavailable,
                pairingOpen = false,
            ),
        )
    }

    @Test
    fun `pairing entry opens signed in welcome only for a verified account session`() {
        assertTrue(pairingEntryEvent(hasVerifiedAccountSession = true) is PairingOnboardingEvent.OpenWelcome)
        assertTrue(pairingEntryEvent(hasVerifiedAccountSession = false) is PairingOnboardingEvent.Open)
    }
}
