package com.andysagent.agentoc.feature.workbench.accounts

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.andysagent.agentoc.core.domain.AccountsRepository
import com.andysagent.agentoc.core.domain.AccountsRepositoryException
import com.andysagent.agentoc.core.domain.AccountPermissionPolicy
import com.andysagent.agentoc.core.domain.AccountSessionStateSource
import com.andysagent.agentoc.core.domain.AccountSessionVerification
import com.andysagent.agentoc.core.domain.GoogleAccountProfile
import com.andysagent.agentoc.core.domain.GoogleAccountStatusResult
import com.andysagent.agentoc.core.domain.GoogleAccountIdentityStore
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import java.util.UUID
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collectLatest

/** Server-owned Google account and trusted-device lifecycle. */
enum class GoogleAccountStatus {
    /** The Keystore-backed Accounts session has not been verified yet. */
    Checking,
    SignedOut,
    SignedIn,
    SigningIn,
    /** A transient failure means the app must not claim either signed-in or signed-out. */
    VerificationUnavailable,
    NotConfigured,
    Error,
}

enum class GoogleDeviceBindingStatus {
    Unknown,
    Bound,
    AccountClaimRequired,
    ReconnectRequired,
    Revoked,
    TemporaryConnected,
}

data class GoogleAccountUiState(
    val status: GoogleAccountStatus = GoogleAccountStatus.Checking,
    /** True only after the real `rac_` session has been checked. */
    val accountSessionResolved: Boolean = false,
    val accountProfile: GoogleAccountProfile? = null,
    val accountId: String? = null,
    val credentialId: String? = null,
    val accountSessionScope: String? = null,
    val accountSessionExpiresAt: String? = null,
    val demoAccessMode: String? = null,
    val deviceId: String? = null,
    val deviceBindingStatus: GoogleDeviceBindingStatus = GoogleDeviceBindingStatus.Unknown,
    val temporaryExpiresAt: String? = null,
    val accountJoinEnabled: Boolean = false,
    val targetInstanceId: String = "",
    val errorMessage: String? = null,
    val accountPermissionPolicy: AccountPermissionPolicy? = null,
    val accountPermissionPolicySaving: Boolean = false,
) {
    /** Cached Google profile data is display-only; it cannot make this true. */
    val hasVerifiedAccountSession: Boolean
        get() = accountSessionResolved && status == GoogleAccountStatus.SignedIn

    val isDemoAccount: Boolean
        get() = hasVerifiedAccountSession && accountId?.matches(Regex("^acct_demo_[a-f0-9]{48}$")) == true

    val isRestrictedDemoAccount: Boolean
        // Authentication provider is not a workbench permission. Actual
        // instance capabilities and entitlements remain authoritative.
        get() = false
}

sealed interface AccountsEvent {
    data object Refresh : AccountsEvent
    data class ConnectionChanged(
        val state: RuntimeConnectionState,
        val targetSelected: Boolean,
    ) : AccountsEvent
    data object SignIn : AccountsEvent
    data class SetAccountPermissionPolicy(val permissionPolicy: String) : AccountsEvent
    data object Bind : AccountsEvent
    data class TargetInstanceChanged(val instanceId: String) : AccountsEvent
    data object JoinWithGoogle : AccountsEvent
    data object Unbind : AccountsEvent
    data object DismissError : AccountsEvent
    /** Accounts v2 session was completed by the runtime; no Google token enters this ViewModel. */
    data class AccountSessionEstablished(val accountProfile: GoogleAccountProfile) : AccountsEvent
    data class IdTokenReceived(val idToken: String, val accountProfile: GoogleAccountProfile? = null) : AccountsEvent
    data class AccountSelected(val accountProfile: GoogleAccountProfile) : AccountsEvent
    data class SignInFailed(val message: String) : AccountsEvent
    data object SignInCancelled : AccountsEvent
}

/**
 * Accounts state machine. Credential Manager only obtains the short-lived ID
 * token; every durable state shown here is projected back from the server.
 */
class AccountsViewModel(
    private val repository: AccountsRepository,
    private val identityStore: GoogleAccountIdentityStore? = null,
    private val accountSessionStateSource: AccountSessionStateSource? = null,
    private val joinWithAccountComputer: (suspend (targetInstanceId: String) -> Unit)? = null,
    private val revokeAccountDevice: (suspend (deviceId: String) -> Unit)? = null,
    private val logoutAccountSession: (suspend () -> Unit)? = null,
) : ViewModel() {
    private val mutableState = MutableStateFlow(
        GoogleAccountUiState(
            status = if (accountSessionStateSource == null) GoogleAccountStatus.SignedOut else GoogleAccountStatus.Checking,
            accountSessionResolved = accountSessionStateSource == null,
        ),
    )
    val state: StateFlow<GoogleAccountUiState> = mutableState.asStateFlow()
    private var stableState = mutableState.value
    private var pendingRequestId: String? = null
    private var pendingOperation = PendingOperation.Legacy
    private var submissionInFlight = false
    private var connectionState: RuntimeConnectionState = RuntimeConnectionState.Disconnected
    private var targetSelected = false
    private var connectionStateKnown = false
    private var refreshJob: Job? = null
    private var accountSessionRefreshJob: Job? = null
    private var connectionRevision = 0L
    private var permissionPolicyRevision = 0L
    private var localAccountProfile: GoogleAccountProfile? = null

    private enum class PendingOperation {
        Legacy,
        AccountJoin,
    }

    init {
        identityStore?.let { store ->
            viewModelScope.launch {
                store.profile.collectLatest { profile ->
                    localAccountProfile = profile
                    if (accountSessionStateSource == null && mutableState.value.status != GoogleAccountStatus.SigningIn) {
                        publish(localIdentityUiState(profile))
                    } else if (accountSessionStateSource != null) {
                        // A profile is purely presentational. Never turn it into
                        // a login state until the Accounts-only session source
                        // has verified its Keystore-backed `rac_` credential.
                        mutableState.value = mutableState.value.copy(
                            accountProfile = if (mutableState.value.hasVerifiedAccountSession) profile else null,
                        )
                    }
                }
            }
        }
        accountSessionStateSource?.let { refreshAccountSession() }
    }

    fun onEvent(event: AccountsEvent) {
        when (event) {
            AccountsEvent.Refresh -> refresh()
            is AccountsEvent.ConnectionChanged -> onConnectionChanged(event)
            AccountsEvent.SignIn, AccountsEvent.Bind -> beginVerification()
            is AccountsEvent.SetAccountPermissionPolicy -> setAccountPermissionPolicy(event.permissionPolicy)
            is AccountsEvent.TargetInstanceChanged -> {
                mutableState.value = mutableState.value.copy(
                    targetInstanceId = event.instanceId,
                    errorMessage = null,
                )
            }
            AccountsEvent.JoinWithGoogle -> beginAccountJoin()
            is AccountsEvent.AccountSessionEstablished -> {
                rememberSelectedAccount(event.accountProfile)
                if (accountSessionStateSource != null) refreshAccountSession() else completeLocalSignIn(event.accountProfile)
            }
            is AccountsEvent.IdTokenReceived -> {
                event.accountProfile?.let(::rememberSelectedAccount)
                if (pendingOperation == PendingOperation.AccountJoin) {
                    // An old UI event must never route a Google token to the
                    // target computer. Account joins use an Accounts grant.
                    submitAccountJoin()
                } else if (identityStore != null && event.accountProfile != null) {
                    completeLocalSignIn(event.accountProfile)
                } else {
                    submitToken(event.idToken)
                }
            }
            is AccountsEvent.AccountSelected -> rememberSelectedAccount(event.accountProfile)
            is AccountsEvent.SignInFailed -> {
                pendingRequestId = null
                pendingOperation = PendingOperation.Legacy
                submissionInFlight = false
                showError(event.message)
            }
            AccountsEvent.SignInCancelled -> {
                pendingRequestId = null
                pendingOperation = PendingOperation.Legacy
                mutableState.value = stableState
            }
            AccountsEvent.Unbind -> unbind()
            AccountsEvent.DismissError -> {
                publish(stableState.copy(errorMessage = null))
            }
        }
    }

    private fun refresh() {
        if (connectionStateKnown && connectionState == RuntimeConnectionState.Connected) {
            refreshAccountPermissionPolicy()
        }
        if (accountSessionStateSource != null) {
            refreshAccountSession()
            return
        }
        if (connectionStateKnown && connectionState != RuntimeConnectionState.Connected) {
            return
        }
        refreshJob?.cancel()
        val revision = connectionRevision
        refreshJob = viewModelScope.launch {
            try {
                val next = repository.getGoogleAccountStatus().toUiState()
                if (revision == connectionRevision && (!connectionStateKnown || connectionState == RuntimeConnectionState.Connected)) {
                    publish(next)
                }
            } catch (error: AccountsRepositoryException) {
                if (revision == connectionRevision && (!connectionStateKnown || connectionState == RuntimeConnectionState.Connected)) {
                    publish(
                        GoogleAccountUiState(
                            status = if (error.statusCode == 409) GoogleAccountStatus.NotConfigured else currentAccountStatus(),
                            accountSessionResolved = true,
                            accountProfile = localAccountProfile,
                            accountPermissionPolicy = mutableState.value.accountPermissionPolicy,
                            errorMessage = if (error.statusCode == 409) messageForStatus(error) else null,
                        )
                    )
                }
            } catch (_: Throwable) {
                if (revision == connectionRevision && (!connectionStateKnown || connectionState == RuntimeConnectionState.Connected)) {
                    mutableState.value = mutableState.value.copy(
                        accountProfile = localAccountProfile ?: mutableState.value.accountProfile,
                    )
                }
            }
        }
    }

    private fun refreshAccountPermissionPolicy() {
        val revision = permissionPolicyRevision
        viewModelScope.launch {
            runCatching { repository.getAccountPermissionPolicy() }
                .onSuccess { policy ->
                    if (revision == permissionPolicyRevision) {
                        stableState = stableState.copy(accountPermissionPolicy = policy)
                        mutableState.value = mutableState.value.copy(accountPermissionPolicy = policy)
                    }
                }
        }
    }

    private fun setAccountPermissionPolicy(permissionPolicy: String) {
        if (permissionPolicy !in setOf("", "full-auto", "approval", "conservative-auto") || mutableState.value.accountPermissionPolicySaving) return
        val revision = ++permissionPolicyRevision
        stableState = stableState.copy(accountPermissionPolicySaving = true)
        mutableState.value = mutableState.value.copy(accountPermissionPolicySaving = true, errorMessage = null)
        viewModelScope.launch {
            try {
                val policy = repository.setAccountPermissionPolicy(permissionPolicy, UUID.randomUUID().toString())
                if (revision != permissionPolicyRevision) return@launch
                stableState = stableState.copy(accountPermissionPolicy = policy, accountPermissionPolicySaving = false)
                mutableState.value = mutableState.value.copy(
                    accountPermissionPolicy = policy,
                    accountPermissionPolicySaving = false,
                )
            } catch (error: AccountsRepositoryException) {
                if (revision != permissionPolicyRevision) return@launch
                stableState = stableState.copy(accountPermissionPolicySaving = false)
                mutableState.value = mutableState.value.copy(
                    accountPermissionPolicySaving = false,
                    errorMessage = if (error.statusCode == 403) "Only the owner can change the account permission mode." else "Could not update the account permission mode. Try again.",
                )
            } catch (_: Throwable) {
                if (revision != permissionPolicyRevision) return@launch
                stableState = stableState.copy(accountPermissionPolicySaving = false)
                mutableState.value = mutableState.value.copy(
                    accountPermissionPolicySaving = false,
                    errorMessage = "Could not update the account permission mode. Try again.",
                )
            }
        }
    }

    /**
     * The v2 account UI is driven exclusively by this result. It validates the
     * Keystore-held `rac_` together with accountId/deviceId/credentialId/scope/
     * expiresAt, and may renew it with the Android device key. A Google profile
     * or target-device credential is never considered proof here.
     */
    private fun refreshAccountSession() {
        val source = accountSessionStateSource ?: return
        accountSessionRefreshJob?.cancel()
        fun verifiedSessionStillValid() = stableState.hasVerifiedAccountSession &&
            runCatching { Instant.parse(stableState.accountSessionExpiresAt).isAfter(Instant.now()) }.getOrDefault(false)
        mutableState.value = if (verifiedSessionStillValid()) stableState.copy(errorMessage = null) else stableState.copy(
            status = GoogleAccountStatus.Checking,
            accountSessionResolved = false,
            accountProfile = null,
            errorMessage = null,
        )
        accountSessionRefreshJob = viewModelScope.launch {
            val verification = try { source.verify() } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                AccountSessionVerification.Unavailable()
            }
            currentCoroutineContext().ensureActive()
            when (verification) {
                is AccountSessionVerification.Active -> {
                    val session = verification.session
                    publish(
                        stableState.copy(
                            status = GoogleAccountStatus.SignedIn,
                            accountSessionResolved = true,
                            accountProfile = localAccountProfile,
                            accountId = session.accountId,
                            credentialId = session.credentialId,
                            accountSessionScope = session.scope,
                            accountSessionExpiresAt = session.expiresAt,
                            demoAccessMode = session.demoAccessMode,
                            deviceId = session.deviceId,
                            errorMessage = null,
                        ),
                    )
                }
                AccountSessionVerification.ReauthorizationRequired -> {
                    localAccountProfile = null
                    identityStore?.let { store -> viewModelScope.launch { store.clearSelectedAccount() } }
                    publish(signedOutAccountSessionState())
                }
                is AccountSessionVerification.Unavailable -> {
                    val message = verification.message
                        ?: "Could not verify the account session. Check the connection and try again."
                    publish(if (verifiedSessionStillValid()) stableState.copy(errorMessage = message) else
                        signedOutAccountSessionState(status = GoogleAccountStatus.VerificationUnavailable, errorMessage = message))
                }
            }
        }
    }

    private fun onConnectionChanged(event: AccountsEvent.ConnectionChanged) {
        connectionRevision += 1
        permissionPolicyRevision += 1
        stableState = stableState.copy(accountPermissionPolicySaving = false)
        mutableState.value = mutableState.value.copy(accountPermissionPolicySaving = false)
        refreshJob?.cancel()
        connectionState = event.state
        targetSelected = event.targetSelected
        connectionStateKnown = true
        when (event.state) {
            RuntimeConnectionState.Connected -> refresh()
            RuntimeConnectionState.Connecting,
            RuntimeConnectionState.Reconnecting,
            RuntimeConnectionState.Disconnected,
            RuntimeConnectionState.Error,
            RuntimeConnectionState.AuthenticationRequired,
            -> Unit
        }
    }

    private fun beginVerification() {
        if (mutableState.value.status == GoogleAccountStatus.SigningIn) return
        pendingOperation = PendingOperation.Legacy
        submissionInFlight = false
        stableState = mutableState.value.copy(errorMessage = null)
        if (pendingRequestId == null) pendingRequestId = UUID.randomUUID().toString()
        mutableState.value = stableState.copy(status = GoogleAccountStatus.SigningIn)
    }

    private fun beginAccountJoin() {
        if (mutableState.value.status == GoogleAccountStatus.SigningIn) return
        pendingOperation = PendingOperation.AccountJoin
        // A discovered target may not be the currently selected transport, so
        // its `/api/auth/google/status` capability projection is legitimately
        // unavailable here. The target's account-intent route is authoritative
        // and will return a typed `account_join_disabled` error if it really is
        // not enabled; do not reject a valid same-account join from stale local
        // capability state.
        submissionInFlight = false
        stableState = mutableState.value.copy(errorMessage = null)
        mutableState.value = stableState.copy(status = GoogleAccountStatus.SigningIn)
        submitAccountJoin()
    }

    private fun submitToken(idToken: String) {
        if (pendingOperation == PendingOperation.AccountJoin) {
            submitAccountJoin()
            return
        }
        if (submissionInFlight) return
        if (mutableState.value.status != GoogleAccountStatus.SigningIn) beginVerification()
        submissionInFlight = true
        viewModelScope.launch {
            try {
                val result = repository.submitGoogleIdToken(
                    idToken = idToken,
                    idempotencyKey = pendingRequestId ?: UUID.randomUUID().toString().also { pendingRequestId = it },
                )
                if (!result.bound) {
                    showError("Google sign-in did not bind this instance.")
                    return@launch
                }
                val status = repository.getGoogleAccountStatus()
                if (!status.bound) {
                    showError("Google sign-in was accepted, but the server did not confirm the binding.")
                    return@launch
                }
                pendingRequestId = null
                publish(status.toUiState())
            } catch (error: AccountsRepositoryException) {
                showError(messageFor(error))
            } catch (_: Throwable) {
                showError("Google sign-in failed. Try again.")
            } finally {
                submissionInFlight = false
            }
        }
    }

    private fun submitAccountJoin() {
        val targetInstanceId = mutableState.value.targetInstanceId.trim()
        val joinComputer = joinWithAccountComputer
        if (targetInstanceId.isBlank()) {
            showError("Select a target computer before joining.")
            return
        }
        if (joinComputer == null) {
            showError("Account-based device joining is unavailable in this build.")
            return
        }
        if (submissionInFlight) return
        submissionInFlight = true
        viewModelScope.launch {
            try {
                // The pairing runtime exchanges its Accounts-only credential for
                // a one-time grant. Neither rac_ nor a Google token reaches the
                // target computer.
                // The target is addressed by Accounts identity. Its endpoint
                // may be absent because TURN is the carrier.
                joinComputer(targetInstanceId)
                publish(repository.getGoogleAccountStatus().toUiState())
                pendingOperation = PendingOperation.Legacy
            } catch (error: AccountsRepositoryException) {
                showError(messageForJoin(error))
            } catch (error: Throwable) {
                showError(messageForJoin(error))
            } finally {
                submissionInFlight = false
            }
        }
    }

    private fun unbind() {
        accountSessionStateSource?.let { source ->
            val currentDeviceId = mutableState.value.deviceId
            val logout = logoutAccountSession
            if (currentDeviceId.isNullOrBlank() || logout == null) {
                showError("This phone cannot complete account unbind until the Accounts service is available.")
                return
            }
            accountSessionRefreshJob?.cancel()
            mutableState.value = stableState.copy(
                status = GoogleAccountStatus.Checking,
                accountSessionResolved = false,
                accountProfile = null,
                errorMessage = null,
            )
            viewModelScope.launch {
                try {
                    // Account sign-out revokes only the current `rac_`; the
                    // server keeps this installation's `adev_` reusable.
                    logout()
                    source.clear()
                    localAccountProfile = null
                    identityStore?.clearSelectedAccount()
                    pendingRequestId = null
                    pendingOperation = PendingOperation.Legacy
                    publish(signedOutAccountSessionState())
                } catch (_: Throwable) {
                    showError("Could not sign out this phone. Try again.")
                }
            }
            return
        }
        if (identityStore != null) {
            viewModelScope.launch { identityStore.clearSelectedAccount() }
            localAccountProfile = null
            pendingRequestId = null
            pendingOperation = PendingOperation.Legacy
            publish(localIdentityUiState(profile = null))
            return
        }
        if (mutableState.value.status != GoogleAccountStatus.SignedIn) return
        stableState = mutableState.value.copy(errorMessage = null)
        mutableState.value = stableState.copy(status = GoogleAccountStatus.SigningIn)
        viewModelScope.launch {
            try {
                repository.unbindGoogleAccount(UUID.randomUUID().toString())
                val status = repository.getGoogleAccountStatus()
                if (status.bound) {
                    showError("The server did not confirm that the account was unbound.")
                    return@launch
                }
                publish(status.toUiState())
            } catch (error: AccountsRepositoryException) {
                showError(if (error.retryable) "Could not unbind the account. Try again." else "Could not unbind the account.")
            } catch (_: Throwable) {
                showError("Could not unbind the account. Try again.")
            }
        }
    }

    private fun publish(next: GoogleAccountUiState) {
        stableState = next
        mutableState.value = stableState
    }

    private fun showError(message: String) {
        mutableState.value = stableState.copy(status = GoogleAccountStatus.Error, errorMessage = message)
    }

    private fun GoogleAccountStatusResult.toUiState(): GoogleAccountUiState {
        if (identityStore == null && !bound) {
            localAccountProfile = null
        } else if (identityStore == null && accountProfile != null) {
            localAccountProfile = accountProfile
        }
        val profile = if (identityStore != null) localAccountProfile else if (bound) accountProfile ?: localAccountProfile else null
        return GoogleAccountUiState(
            status = when {
                profile != null -> GoogleAccountStatus.SignedIn
                identityStore != null -> GoogleAccountStatus.SignedOut
                !enabled -> GoogleAccountStatus.NotConfigured
                bound -> GoogleAccountStatus.SignedIn
                else -> GoogleAccountStatus.SignedOut
            },
            accountSessionResolved = true,
            accountProfile = profile,
            accountId = accountId,
            deviceId = deviceId,
            deviceBindingStatus = when (deviceState) {
                "bound" -> GoogleDeviceBindingStatus.Bound
                "account_claim_required", "qr_required", "provisional" -> GoogleDeviceBindingStatus.AccountClaimRequired
                "reconnect_required" -> GoogleDeviceBindingStatus.ReconnectRequired
                "revoked" -> GoogleDeviceBindingStatus.Revoked
                "temporary_connected" -> GoogleDeviceBindingStatus.TemporaryConnected
                else -> GoogleDeviceBindingStatus.Unknown
            },
            temporaryExpiresAt = temporaryExpiresAt,
            accountJoinEnabled = accountJoinEnabled,
            targetInstanceId = mutableState.value.targetInstanceId,
            accountPermissionPolicy = mutableState.value.accountPermissionPolicy,
            errorMessage = if (!enabled && identityStore == null) {
                "Google sign-in is not configured on this computer."
            } else {
                null
            },
        )
    }

    private fun messageForStatus(error: AccountsRepositoryException): String = when {
        error.statusCode == 409 -> "Google sign-in is not configured on this computer."
        else -> "Google account status could not be refreshed right now."
    }

    private fun currentAccountStatus(): GoogleAccountStatus = when {
        mutableState.value.status == GoogleAccountStatus.NotConfigured -> GoogleAccountStatus.NotConfigured
        localAccountProfile != null || mutableState.value.accountProfile != null -> GoogleAccountStatus.SignedIn
        else -> GoogleAccountStatus.SignedOut
    }

    private fun rememberSelectedAccount(profile: GoogleAccountProfile) {
        localAccountProfile = profile
        if (accountSessionStateSource != null) {
            // AccountSessionEstablished is followed by a verified projection.
            // Until then, do not let an OAuth profile look like a login.
            if (mutableState.value.hasVerifiedAccountSession) {
                publish(stableState.copy(accountProfile = profile, errorMessage = null))
            }
        } else if (mutableState.value.status == GoogleAccountStatus.SigningIn) {
            mutableState.value = mutableState.value.copy(accountProfile = profile, errorMessage = null)
        } else {
            publish(localIdentityUiState(profile))
        }
        identityStore?.let { store -> viewModelScope.launch { store.save(profile) } }
    }

    private fun completeLocalSignIn(profile: GoogleAccountProfile) {
        pendingRequestId = null
        pendingOperation = PendingOperation.Legacy
        submissionInFlight = false
        publish(localIdentityUiState(profile))
    }

    private fun localIdentityUiState(profile: GoogleAccountProfile?): GoogleAccountUiState = stableState.copy(
        status = if (profile == null) GoogleAccountStatus.SignedOut else GoogleAccountStatus.SignedIn,
        accountSessionResolved = true,
        accountProfile = profile,
        errorMessage = null,
    )

    private fun signedOutAccountSessionState(
        status: GoogleAccountStatus = GoogleAccountStatus.SignedOut,
        errorMessage: String? = null,
    ): GoogleAccountUiState = stableState.copy(
        status = status,
        accountSessionResolved = true,
        accountProfile = null,
        accountId = null,
        credentialId = null,
        accountSessionScope = null,
        accountSessionExpiresAt = null,
        demoAccessMode = null,
        deviceId = null,
        errorMessage = errorMessage,
    )

    private fun messageFor(error: AccountsRepositoryException): String = when (error.statusCode) {
        401 -> "Google sign-in could not be verified. Try again."
        403 -> "This Google account is not the one bound to this instance."
        409 -> "Google sign-in is not configured on this instance."
        else -> if (error.retryable) "Google sign-in failed. Try again." else "Google sign-in failed."
    }

    private fun messageForJoin(error: Throwable): String {
        val detail = error.message.orEmpty().lowercase()
        return when {
            "endpoint" in detail && "invalid" in detail -> "Enter a valid target endpoint starting with http:// or https://."
            ("account join" in detail || "account claim" in detail) && ("expired" in detail || "replay" in detail) ->
                "The target computer account authorization expired. Start the connection again."
            "account" in detail && ("mismatch" in detail || "different" in detail) ->
                "This account cannot join the target computer. Check the account and try again."
            "credential" in detail || "token" in detail -> "Account verification failed. Try again."
            else -> "Could not join the target computer. Try again."
        }
    }
}

class AccountsViewModelFactory(
    private val repository: AccountsRepository,
    private val identityStore: GoogleAccountIdentityStore? = null,
    private val accountSessionStateSource: AccountSessionStateSource? = null,
    private val joinWithAccountComputer: (suspend (targetInstanceId: String) -> Unit)? = null,
    private val revokeAccountDevice: (suspend (deviceId: String) -> Unit)? = null,
    private val logoutAccountSession: (suspend () -> Unit)? = null,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        AccountsViewModel(repository, identityStore, accountSessionStateSource, joinWithAccountComputer, revokeAccountDevice, logoutAccountSession) as T
}
