package com.andysagent.ragent.feature.workbench.accounts

import android.content.Context
import android.util.Log
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.andysagent.ragent.core.domain.GoogleAccountProfile
import kotlin.coroutines.cancellation.CancellationException

sealed interface GoogleSignInOutcome {
    data class Success(val idToken: String, val accountProfile: GoogleAccountProfile) : GoogleSignInOutcome
    data object Cancelled : GoogleSignInOutcome
    data class Failed(val reason: GoogleSignInFailure) : GoogleSignInOutcome
}

enum class GoogleSignInFailure {
    NoGoogleAccount,
    GooglePlayServicesUnavailable,
    ProviderError,
}

/**
 * Native Google Sign-In via Credential Manager (GMS).
 *
 * Invokes the phone's Google Play Services sign-in sheet and returns a Google
 * ID token for [serverClientId]. This must be the Web/server OAuth client ID
 * accepted by the Accounts native audience allowlist. The Android OAuth client
 * remains a Google Cloud package/signing-certificate registration and is not
 * passed to [GetGoogleIdOption]. This is protocol-independent: the token exchange
 * with the runtime backend is a separate step (see the backend contract doc).
 * Credential Manager may launch UI, so it must be called from the main/UI
 * coroutine. The outcome keeps provider failures distinguishable from an
 * intentional cancellation; callers must not treat every failure as null.
 */
class GoogleSignInHelper(
    private val context: Context,
    private val serverClientId: String,
) {
    private val credentialManager = CredentialManager.create(context)

    /**
     * Requests an ID token bound to the one-time nonce issued by Accounts.
     * A caller-generated nonce is intentionally not accepted: server-side
     * challenge state is what lets Accounts reject replayed Google tokens.
     */
    suspend fun getIdToken(
        nonce: String,
        preferAuthorizedAccount: Boolean = false,
    ): GoogleSignInOutcome {
        require(nonce.isNotBlank() && !nonce.contains('\n') && !nonce.contains('\r')) {
            "Accounts Google nonce must not be blank"
        }
        val firstAttempt = requestIdToken(
            nonce = nonce,
            filterByAuthorizedAccounts = preferAuthorizedAccount,
            autoSelectEnabled = preferAuthorizedAccount,
        )
        // A persisted Ragent account profile means the user has already selected
        // an account on this phone, but Credential Manager may no longer expose an
        // authorized credential after a provider/account reset. Fall back to the
        // normal picker only in that case; callers still avoid their own extra
        // confirmation dialog for an already signed-in account.
        return if (
            preferAuthorizedAccount &&
            firstAttempt == GoogleSignInOutcome.Failed(GoogleSignInFailure.NoGoogleAccount)
        ) {
            requestIdToken(nonce = nonce, filterByAuthorizedAccounts = false, autoSelectEnabled = false)
        } else {
            firstAttempt
        }
    }

    private suspend fun requestIdToken(
        nonce: String,
        filterByAuthorizedAccounts: Boolean,
        autoSelectEnabled: Boolean,
    ): GoogleSignInOutcome {
        val request = GetCredentialRequest(
            listOf(
                GetGoogleIdOption(
                    serverClientId = serverClientId,
                    nonce = nonce,
                    filterByAuthorizedAccounts = filterByAuthorizedAccounts,
                    linkedServiceId = null,
                    idTokenDepositionScopes = emptyList(),
                    autoSelectEnabled = autoSelectEnabled,
                    requestVerifiedPhoneNumber = false,
                ),
            ),
        )
        return try {
            val response: GetCredentialResponse = credentialManager.getCredential(context, request)
            val credential = response.credential
            if (credential is CustomCredential &&
                credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
            ) {
                GoogleIdTokenCredential.createFrom(credential.data).let { googleCredential ->
                    GoogleSignInOutcome.Success(
                        idToken = googleCredential.idToken,
                        accountProfile = GoogleAccountProfile(
                            displayName = googleCredential.displayName,
                            email = googleCredential.id,
                            photoUrl = googleCredential.profilePictureUri?.toString(),
                        ),
                    )
                }
            } else {
                GoogleSignInOutcome.Failed(GoogleSignInFailure.ProviderError)
            }
        } catch (_: GetCredentialCancellationException) {
            GoogleSignInOutcome.Cancelled
        } catch (_: NoCredentialException) {
            GoogleSignInOutcome.Failed(GoogleSignInFailure.NoGoogleAccount)
        } catch (error: GetCredentialProviderConfigurationException) {
            Log.e(TAG, "Credential Manager provider unavailable: ${error::class.java.simpleName}: ${error.message}")
            GoogleSignInOutcome.Failed(GoogleSignInFailure.GooglePlayServicesUnavailable)
        } catch (_: GetCredentialUnsupportedException) {
            GoogleSignInOutcome.Failed(GoogleSignInFailure.GooglePlayServicesUnavailable)
        } catch (error: GetCredentialException) {
            Log.e(TAG, "Credential Manager failed: ${error::class.java.simpleName}: ${error.message}")
            GoogleSignInOutcome.Failed(GoogleSignInFailure.ProviderError)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            Log.e(TAG, "Google sign-in failed: ${error::class.java.simpleName}: ${error.message}")
            GoogleSignInOutcome.Failed(GoogleSignInFailure.ProviderError)
        }
    }

    private companion object {
        const val TAG = "Ragent.GoogleSignIn"
    }
}
