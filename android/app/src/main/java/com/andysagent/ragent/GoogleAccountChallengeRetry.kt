package com.andysagent.ragent

import com.andysagent.ragent.core.auth.AccountSessionChallenge
import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.core.domain.GoogleAccountProfile
import com.andysagent.ragent.feature.workbench.accounts.GoogleSignInFailure
import com.andysagent.ragent.feature.workbench.accounts.GoogleSignInOutcome
import kotlinx.coroutines.CancellationException

internal sealed interface GoogleAccountChallengeResult {
    data class Success(val profile: GoogleAccountProfile) : GoogleAccountChallengeResult
    data object Cancelled : GoogleAccountChallengeResult
    data class Failed(val error: Throwable? = null, val providerFailure: GoogleSignInFailure? = null) : GoogleAccountChallengeResult
}

/** Retry an expired challenge with a new nonce and a newly issued Google token. */
internal suspend fun completeGoogleAccountChallengeWithRetry(
    createChallenge: suspend () -> AccountSessionChallenge,
    requestToken: suspend (nonce: String, preferAuthorized: Boolean) -> GoogleSignInOutcome,
    complete: suspend (AccountSessionChallenge, String, GoogleAccountProfile) -> Unit,
    preferAuthorized: Boolean,
): GoogleAccountChallengeResult {
    var selectedAccount: String? = null
    for (attempt in 0..1) {
        val challenge = try {
            createChallenge()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            return GoogleAccountChallengeResult.Failed(error = error)
        }
        val outcome = try {
            requestToken(challenge.nonce, preferAuthorized || attempt > 0)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            return GoogleAccountChallengeResult.Failed(error = error)
        }
        when (outcome) {
            is GoogleSignInOutcome.Success -> try {
                val currentAccount = outcome.accountProfile.email?.trim()?.takeIf { it.isNotEmpty() }
                if (attempt > 0 && (currentAccount == null || !currentAccount.equals(selectedAccount, ignoreCase = true))) {
                    return GoogleAccountChallengeResult.Failed(
                        error = IllegalStateException("Google account changed during sign-in. Please start again."),
                    )
                }
                complete(challenge, outcome.idToken, outcome.accountProfile)
                return GoogleAccountChallengeResult.Success(outcome.accountProfile)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                val expired = error is AccountSessionException && error.code in setOf(
                    "account_session_expired", "owner_auth_account_session_expired",
                )
                if (attempt == 0 && expired) {
                    selectedAccount = outcome.accountProfile.email?.trim()?.takeIf { it.isNotEmpty() }
                    if (selectedAccount != null) continue
                    return GoogleAccountChallengeResult.Failed(
                        error = IllegalStateException("Could not confirm the Google account. Please start again."),
                    )
                }
                return GoogleAccountChallengeResult.Failed(error = error)
            }
            GoogleSignInOutcome.Cancelled -> return GoogleAccountChallengeResult.Cancelled
            is GoogleSignInOutcome.Failed -> return GoogleAccountChallengeResult.Failed(providerFailure = outcome.reason)
        }
    }
    return GoogleAccountChallengeResult.Failed(error = IllegalStateException("Google sign-in challenge expired."))
}
