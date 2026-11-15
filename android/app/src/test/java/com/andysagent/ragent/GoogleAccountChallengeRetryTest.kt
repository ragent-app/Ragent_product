package com.andysagent.ragent

import com.andysagent.ragent.core.auth.AccountSessionChallenge
import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.core.domain.GoogleAccountProfile
import com.andysagent.ragent.feature.workbench.accounts.GoogleSignInOutcome
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs

class GoogleAccountChallengeRetryTest {
    private val profile = GoogleAccountProfile(displayName = "Test", email = "test@example.invalid")
    private fun challenge(number: Int) = AccountSessionChallenge(
        "transaction-$number", "request-$number", "adev_test", "fingerprint", "nonce-$number", "2099-01-01T00:00:00Z",
    )

    @Test fun `expired challenge acquires a new token bound to a new nonce`() = runBlocking {
        var count = 0
        val requested = mutableListOf<Pair<String, Boolean>>()
        val completed = mutableListOf<Pair<String, String>>()
        val result = completeGoogleAccountChallengeWithRetry(
            createChallenge = { challenge(++count) },
            requestToken = { nonce, prefer ->
                requested += nonce to prefer
                GoogleSignInOutcome.Success("token-$nonce", profile)
            },
            complete = { item, token, _ ->
                completed += item.nonce to token
                if (item.nonce == "nonce-1") throw AccountSessionException(410, "owner_auth_account_session_expired", "expired")
            },
            preferAuthorized = false,
        )
        assertIs<GoogleAccountChallengeResult.Success>(result)
        assertEquals(listOf("nonce-1" to false, "nonce-2" to true), requested)
        assertEquals(listOf("nonce-1" to "token-nonce-1", "nonce-2" to "token-nonce-2"), completed)
    }

    @Test fun `other errors including unrelated 410 do not retry`() = runBlocking {
        for ((status, code) in listOf(401 to "account_session_signature_invalid", 410 to "other_gone")) {
            var count = 0
            val result = completeGoogleAccountChallengeWithRetry(
                createChallenge = { challenge(++count) },
                requestToken = { _, _ -> GoogleSignInOutcome.Success("token", profile) },
                complete = { _, _, _ -> throw AccountSessionException(status, code, "failed") },
                preferAuthorized = false,
            )
            assertIs<GoogleAccountChallengeResult.Failed>(result)
            assertEquals(1, count)
        }
    }

    @Test fun `retry refuses a different Google account before completing`() = runBlocking {
        var count = 0
        var completed = 0
        val result = completeGoogleAccountChallengeWithRetry(
            createChallenge = { challenge(++count) },
            requestToken = { _, _ ->
                GoogleSignInOutcome.Success("token", if (count == 1) profile else GoogleAccountProfile(email = "other@example.invalid"))
            },
            complete = { _, _, _ ->
                completed++
                throw AccountSessionException(410, "owner_auth_account_session_expired", "expired")
            },
            preferAuthorized = false,
        )
        assertIs<GoogleAccountChallengeResult.Failed>(result)
        assertEquals(2, count)
        assertEquals(1, completed)
    }

    @Test fun `expired challenge with no identifiable account does not retry`() = runBlocking {
        var count = 0
        val result = completeGoogleAccountChallengeWithRetry(
            createChallenge = { challenge(++count) },
            requestToken = { _, _ -> GoogleSignInOutcome.Success("token", GoogleAccountProfile()) },
            complete = { _, _, _ -> throw AccountSessionException(410, "owner_auth_account_session_expired", "expired") },
            preferAuthorized = false,
        )
        assertIs<GoogleAccountChallengeResult.Failed>(result)
        assertEquals(1, count)
    }

    @Test fun `user cancellation is not retried`() = runBlocking {
        var count = 0
        val result = completeGoogleAccountChallengeWithRetry(
            createChallenge = { challenge(++count) },
            requestToken = { _, _ -> GoogleSignInOutcome.Cancelled },
            complete = { _, _, _ -> error("completion must not run") },
            preferAuthorized = false,
        )
        assertIs<GoogleAccountChallengeResult.Cancelled>(result)
        assertEquals(1, count)
    }

    @Test fun `expired second challenge fails without a third attempt`() = runBlocking {
        var count = 0
        val result = completeGoogleAccountChallengeWithRetry(
            createChallenge = { challenge(++count) },
            requestToken = { _, _ -> GoogleSignInOutcome.Success("token", profile) },
            complete = { _, _, _ -> throw AccountSessionException(401, "account_session_expired", "expired") },
            preferAuthorized = false,
        )
        assertIs<GoogleAccountChallengeResult.Failed>(result)
        assertEquals(2, count)
    }

    @Test fun `coroutine cancellation propagates`() = runBlocking {
        assertFailsWith<CancellationException> {
            completeGoogleAccountChallengeWithRetry(
                createChallenge = { throw CancellationException("cancelled") },
                requestToken = { _, _ -> error("must not run") },
                complete = { _, _, _ -> error("must not run") },
                preferAuthorized = false,
            )
        }
        Unit
    }
}
