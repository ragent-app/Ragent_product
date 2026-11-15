package com.andysagent.ragent.feature.workbench.accounts

import com.andysagent.ragent.core.domain.AccountsRepository
import com.andysagent.ragent.core.domain.AccountsRepositoryException
import com.andysagent.ragent.core.domain.AccountPermissionPolicy
import com.andysagent.ragent.core.domain.ActiveAccountSession
import com.andysagent.ragent.core.domain.AccountSessionStateSource
import com.andysagent.ragent.core.domain.AccountSessionVerification
import com.andysagent.ragent.core.domain.GoogleAccountStatusResult
import com.andysagent.ragent.core.domain.GoogleTokenSubmitResult
import com.andysagent.ragent.core.domain.GoogleAccountIdentityStore
import com.andysagent.ragent.core.domain.GoogleAccountProfile
import com.andysagent.ragent.core.model.RuntimeConnectionState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.Flow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class AccountsViewModelTest {

    private class FakeGoogleAccountIdentityStore : GoogleAccountIdentityStore {
        private val mutableProfile = MutableStateFlow<GoogleAccountProfile?>(null)
        override val profile: Flow<GoogleAccountProfile?> = mutableProfile

        override suspend fun save(profile: GoogleAccountProfile) {
            mutableProfile.value = profile
        }

        override suspend fun clearSelectedAccount() {
            mutableProfile.value = null
        }
    }

    private class FakeAccountSessionStateSource(
        var verification: AccountSessionVerification,
    ) : AccountSessionStateSource {
        var clearCalls = 0
        var pendingVerification: CompletableDeferred<AccountSessionVerification>? = null

        override suspend fun verify(): AccountSessionVerification = pendingVerification?.await() ?: verification

        override suspend fun clear() {
            clearCalls += 1
        }
    }

    @Test
    fun `revalidation keeps the verified account visible until a result arrives`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val active = AccountSessionVerification.Active(
                ActiveAccountSession("acct_1", "adev_phone", "cred_1", "account-directory", "2099-01-01T00:00:00Z"),
            )
            val source = FakeAccountSessionStateSource(active)
            val viewModel = AccountsViewModel(FakeAccountsRepository(), accountSessionStateSource = source)
            advanceUntilIdle()
            val pending = CompletableDeferred<AccountSessionVerification>()
            source.pendingVerification = pending
            viewModel.onEvent(AccountsEvent.ConnectionChanged(RuntimeConnectionState.Connected, true))
            testScheduler.runCurrent()
            assertTrue(viewModel.state.value.hasVerifiedAccountSession)
            assertEquals("acct_1", viewModel.state.value.accountId)
            pending.complete(AccountSessionVerification.ReauthorizationRequired)
            advanceUntilIdle()
            assertEquals(GoogleAccountStatus.SignedOut, viewModel.state.value.status)
            assertTrue(!viewModel.state.value.hasVerifiedAccountSession)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `temporary revalidation failure retains a still valid verified account`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val source = FakeAccountSessionStateSource(AccountSessionVerification.Active(
                ActiveAccountSession("acct_1", "adev_phone", "cred_1", "account-directory", "2099-01-01T00:00:00Z"),
            ))
            val viewModel = AccountsViewModel(FakeAccountsRepository(), accountSessionStateSource = source)
            advanceUntilIdle()
            source.verification = AccountSessionVerification.Unavailable()
            viewModel.onEvent(AccountsEvent.Refresh)
            advanceUntilIdle()
            assertTrue(viewModel.state.value.hasVerifiedAccountSession)
            assertEquals("acct_1", viewModel.state.value.accountId)
            assertTrue(viewModel.state.value.errorMessage != null)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `temporary revalidation failure never retains an expired account`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val source = FakeAccountSessionStateSource(AccountSessionVerification.Active(
                ActiveAccountSession("acct_1", "adev_phone", "cred_1", "account-directory", "2000-01-01T00:00:00Z"),
            ))
            val viewModel = AccountsViewModel(FakeAccountsRepository(), accountSessionStateSource = source)
            advanceUntilIdle()
            source.verification = AccountSessionVerification.Unavailable()
            viewModel.onEvent(AccountsEvent.Refresh)
            advanceUntilIdle()
            assertEquals(GoogleAccountStatus.VerificationUnavailable, viewModel.state.value.status)
            assertTrue(!viewModel.state.value.hasVerifiedAccountSession)
        } finally { Dispatchers.resetMain() }
    }

    private class FakeAccountsRepository(
        private var status: GoogleAccountStatusResult = GoogleAccountStatusResult(enabled = true, bound = false, mode = "legacy"),
        private val result: GoogleTokenSubmitResult = GoogleTokenSubmitResult(bound = true, mode = "legacy"),
        private val error: AccountsRepositoryException? = null,
        val submittedTokens: MutableList<String> = mutableListOf(),
        val submittedAliases: MutableList<String?> = mutableListOf(),
        val submittedRequestIds: MutableList<String> = mutableListOf(),
    ) : AccountsRepository {
        var policy = AccountPermissionPolicy()
        var pendingPolicyRead: CompletableDeferred<AccountPermissionPolicy>? = null
        override suspend fun getAccountPermissionPolicy(): AccountPermissionPolicy = pendingPolicyRead?.await() ?: policy
        override suspend fun setAccountPermissionPolicy(permissionPolicy: String, idempotencyKey: String): AccountPermissionPolicy {
            policy = AccountPermissionPolicy(permissionPolicy)
            return policy
        }
        fun markBound() {
            status = status.copy(bound = true, mode = "accounts", deviceState = "bound", deviceId = "device-join")
        }

        override suspend fun getGoogleAccountStatus(): GoogleAccountStatusResult = status

        override suspend fun submitGoogleIdToken(idToken: String, alias: String?): GoogleTokenSubmitResult {
            submittedTokens.add(idToken)
            submittedAliases.add(alias)
            error?.let { throw it }
            if (result.bound) {
                status = status.copy(
                    bound = true,
                    mode = result.mode,
                    deviceState = result.deviceState ?: "bound",
                    deviceId = result.deviceId,
                )
            }
            return result
        }

        override suspend fun submitGoogleIdToken(
            idToken: String,
            alias: String?,
            idempotencyKey: String,
        ): GoogleTokenSubmitResult {
            submittedRequestIds.add(idempotencyKey)
            return submitGoogleIdToken(idToken, alias)
        }
    }

    @Test
    fun `account revalidation preserves the selected permission policy`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository()
            val session = FakeAccountSessionStateSource(AccountSessionVerification.Active(
                ActiveAccountSession("acct_1", "adev_phone", "cred_1", "account-directory", "2099-01-01T00:00:00Z"),
            ))
            val viewModel = AccountsViewModel(repository, accountSessionStateSource = session)
            advanceUntilIdle()
            viewModel.onEvent(AccountsEvent.ConnectionChanged(RuntimeConnectionState.Connected, true))
            advanceUntilIdle()
            viewModel.onEvent(AccountsEvent.SetAccountPermissionPolicy("approval"))
            advanceUntilIdle()
            assertEquals("approval", viewModel.state.value.accountPermissionPolicy?.permissionPolicy)
            viewModel.onEvent(AccountsEvent.Refresh)
            advanceUntilIdle()
            assertEquals("approval", repository.policy.permissionPolicy)
            assertEquals("approval", viewModel.state.value.accountPermissionPolicy?.permissionPolicy)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `an older policy read cannot overwrite a newer selection`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository()
            val viewModel = AccountsViewModel(repository)
            viewModel.onEvent(AccountsEvent.ConnectionChanged(RuntimeConnectionState.Connected, true))
            advanceUntilIdle()
            val staleRead = CompletableDeferred<AccountPermissionPolicy>()
            repository.pendingPolicyRead = staleRead
            viewModel.onEvent(AccountsEvent.Refresh)
            testScheduler.runCurrent()
            viewModel.onEvent(AccountsEvent.SetAccountPermissionPolicy("approval"))
            advanceUntilIdle()
            staleRead.complete(AccountPermissionPolicy("full-auto"))
            advanceUntilIdle()
            assertEquals("approval", viewModel.state.value.accountPermissionPolicy?.permissionPolicy)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `refresh exposes enabled unbound instance as not bound`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = AccountsViewModel(
                FakeAccountsRepository(status = GoogleAccountStatusResult(enabled = true, bound = false, mode = "accounts")),
            )

            viewModel.onEvent(AccountsEvent.Refresh)
            advanceUntilIdle()

            assertEquals(GoogleAccountStatus.SignedOut, viewModel.state.value.status)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `refresh exposes provisional device as requiring Google completion`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = AccountsViewModel(
                FakeAccountsRepository(status = GoogleAccountStatusResult(
                    enabled = true,
                    bound = false,
                    mode = "accounts",
                    deviceState = "provisional",
                    deviceId = "device-1",
                    temporaryExpiresAt = "2026-08-14T00:02:00Z",
                )),
            )

            viewModel.onEvent(AccountsEvent.Refresh)
            advanceUntilIdle()

            assertEquals(GoogleAccountStatus.SignedOut, viewModel.state.value.status)
            assertEquals("device-1", viewModel.state.value.deviceId)
            assertEquals("2026-08-14T00:02:00Z", viewModel.state.value.temporaryExpiresAt)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `id token submit marks bound on success`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository(result = GoogleTokenSubmitResult(bound = true, mode = "legacy"))
            val viewModel = AccountsViewModel(repository)

            viewModel.onEvent(AccountsEvent.IdTokenReceived("token-1"))
            advanceUntilIdle()

            assertEquals(GoogleAccountStatus.SignedIn, viewModel.state.value.status)
            assertEquals(listOf("token-1"), repository.submittedTokens)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `phone sign in persists independently when no computer is connected`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository()
            val identities = FakeGoogleAccountIdentityStore()
            val profile = GoogleAccountProfile(
                displayName = "Mina Example",
                email = "mina@example.test",
                photoUrl = "https://example.test/mina.png",
            )
            val viewModel = AccountsViewModel(repository, identityStore = identities)

            viewModel.onEvent(AccountsEvent.SignIn)
            viewModel.onEvent(AccountsEvent.IdTokenReceived("short-lived-token", profile))
            viewModel.onEvent(AccountsEvent.ConnectionChanged(RuntimeConnectionState.Disconnected, targetSelected = false))
            advanceUntilIdle()

            assertEquals(GoogleAccountStatus.SignedIn, viewModel.state.value.status)
            assertEquals(profile, viewModel.state.value.accountProfile)
            assertTrue(repository.submittedTokens.isEmpty())

            val restored = AccountsViewModel(repository, identityStore = identities)
            advanceUntilIdle()
            assertEquals(GoogleAccountStatus.SignedIn, restored.state.value.status)
            assertEquals(profile, restored.state.value.accountProfile)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `cached Google profile cannot produce signed in UI without an active rac session`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val identities = FakeGoogleAccountIdentityStore()
            val profile = GoogleAccountProfile(displayName = "Mina Example", email = "mina@example.test")
            identities.save(profile)
            val session = FakeAccountSessionStateSource(AccountSessionVerification.ReauthorizationRequired)

            val viewModel = AccountsViewModel(
                repository = FakeAccountsRepository(),
                identityStore = identities,
                accountSessionStateSource = session,
            )
            advanceUntilIdle()

            assertEquals(GoogleAccountStatus.SignedOut, viewModel.state.value.status)
            assertTrue(!viewModel.state.value.hasVerifiedAccountSession)
            assertEquals(null, viewModel.state.value.accountProfile)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `only an active rac session makes the UI signed in and projects its metadata`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val identities = FakeGoogleAccountIdentityStore()
            val profile = GoogleAccountProfile(displayName = "Mina Example", email = "mina@example.test")
            identities.save(profile)
            val session = FakeAccountSessionStateSource(
                AccountSessionVerification.Active(
                    ActiveAccountSession(
                        accountId = "acct_1",
                        deviceId = "adev_phone",
                        credentialId = "cred_1",
                        scope = "account-directory",
                        expiresAt = "2099-01-01T00:00:00Z",
                    ),
                ),
            )

            val viewModel = AccountsViewModel(
                repository = FakeAccountsRepository(),
                identityStore = identities,
                accountSessionStateSource = session,
            )
            advanceUntilIdle()

            assertEquals(GoogleAccountStatus.SignedIn, viewModel.state.value.status)
            assertTrue(viewModel.state.value.hasVerifiedAccountSession)
            assertEquals("acct_1", viewModel.state.value.accountId)
            assertEquals("adev_phone", viewModel.state.value.deviceId)
            assertEquals("cred_1", viewModel.state.value.credentialId)
            assertEquals("account-directory", viewModel.state.value.accountSessionScope)
            assertEquals("2099-01-01T00:00:00Z", viewModel.state.value.accountSessionExpiresAt)
            assertEquals(profile, viewModel.state.value.accountProfile)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `temporary validation failure is never rendered as either signed in or signed out`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val identities = FakeGoogleAccountIdentityStore()
            identities.save(GoogleAccountProfile(displayName = "Mina Example"))
            val viewModel = AccountsViewModel(
                repository = FakeAccountsRepository(),
                identityStore = identities,
                accountSessionStateSource = FakeAccountSessionStateSource(AccountSessionVerification.Unavailable()),
            )
            advanceUntilIdle()

            assertEquals(GoogleAccountStatus.VerificationUnavailable, viewModel.state.value.status)
            assertTrue(!viewModel.state.value.hasVerifiedAccountSession)
            assertEquals(null, viewModel.state.value.accountProfile)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `sign out clears the real account session rather than only hiding the Google profile`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val session = FakeAccountSessionStateSource(
                AccountSessionVerification.Active(
                    ActiveAccountSession("acct_1", "adev_phone", "cred_1", "account-directory", "2099-01-01T00:00:00Z"),
                ),
            )
            val identities = FakeGoogleAccountIdentityStore()
            var loggedOut = false
            val viewModel = AccountsViewModel(
                repository = FakeAccountsRepository(),
                identityStore = identities,
                accountSessionStateSource = session,
                logoutAccountSession = { loggedOut = true },
            )
            advanceUntilIdle()

            viewModel.onEvent(AccountsEvent.Unbind)
            advanceUntilIdle()

            assertEquals(1, session.clearCalls)
            assertTrue(loggedOut)
            assertEquals(GoogleAccountStatus.SignedOut, viewModel.state.value.status)
            assertTrue(!viewModel.state.value.hasVerifiedAccountSession)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `binding mismatch surfaces a non-retryable error`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository(
                error = AccountsRepositoryException(403, "owner_auth_binding_mismatch", "not bound", retryable = false),
            )
            val viewModel = AccountsViewModel(repository)

            viewModel.onEvent(AccountsEvent.IdTokenReceived("token-2"))
            advanceUntilIdle()

            assertEquals(GoogleAccountStatus.Error, viewModel.state.value.status)
            assertTrue(viewModel.state.value.errorMessage.isNullOrBlank().not())
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `retry after a failed submission reuses the same request id`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository(
                error = AccountsRepositoryException(502, "owner_auth_account_invalid", "temporary", retryable = true),
            )
            val viewModel = AccountsViewModel(repository)

            viewModel.onEvent(AccountsEvent.SignIn)
            viewModel.onEvent(AccountsEvent.IdTokenReceived("token-3"))
            advanceUntilIdle()
            viewModel.onEvent(AccountsEvent.SignIn)
            viewModel.onEvent(AccountsEvent.IdTokenReceived("token-4"))
            advanceUntilIdle()

            assertEquals(2, repository.submittedRequestIds.size)
            assertEquals(repository.submittedRequestIds[0], repository.submittedRequestIds[1])
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `cancelled sign-in returns to not bound without submitting`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository()
            val viewModel = AccountsViewModel(repository)

            viewModel.onEvent(AccountsEvent.SignInCancelled)

            assertEquals(GoogleAccountStatus.SignedOut, viewModel.state.value.status)
            assertTrue(repository.submittedTokens.isEmpty())
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `connection readiness controls status refresh instead of showing unavailable`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository(
                status = GoogleAccountStatusResult(enabled = true, bound = true, mode = "accounts", deviceState = "bound"),
            )
            val viewModel = AccountsViewModel(repository)

            viewModel.onEvent(AccountsEvent.ConnectionChanged(RuntimeConnectionState.Connecting, targetSelected = true))
            assertEquals(GoogleAccountStatus.SignedOut, viewModel.state.value.status)

            viewModel.onEvent(AccountsEvent.ConnectionChanged(RuntimeConnectionState.Connected, targetSelected = true))
            advanceUntilIdle()

            assertEquals(GoogleAccountStatus.SignedIn, viewModel.state.value.status)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `connection loss leaves account status unchanged and reconnect refreshes status`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository(
                status = GoogleAccountStatusResult(enabled = true, bound = true, mode = "accounts", deviceState = "bound"),
            )
            val viewModel = AccountsViewModel(repository)

            viewModel.onEvent(AccountsEvent.ConnectionChanged(RuntimeConnectionState.Connected, targetSelected = true))
            advanceUntilIdle()
            viewModel.onEvent(AccountsEvent.ConnectionChanged(RuntimeConnectionState.Disconnected, targetSelected = true))

            assertEquals(GoogleAccountStatus.SignedIn, viewModel.state.value.status)
            viewModel.onEvent(AccountsEvent.ConnectionChanged(RuntimeConnectionState.Connected, targetSelected = true))
            advanceUntilIdle()
            assertEquals(GoogleAccountStatus.SignedIn, viewModel.state.value.status)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `disabled Google service is distinct from transport unavailability`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = AccountsViewModel(
                FakeAccountsRepository(status = GoogleAccountStatusResult(enabled = false, bound = false, mode = "legacy")),
            )

            viewModel.onEvent(AccountsEvent.Refresh)
            advanceUntilIdle()

            assertEquals(GoogleAccountStatus.NotConfigured, viewModel.state.value.status)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `provider failure stays visible as an error instead of unavailable`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = AccountsViewModel(FakeAccountsRepository())

            viewModel.onEvent(AccountsEvent.SignIn)
            viewModel.onEvent(AccountsEvent.SignInFailed("OAuth client configuration is invalid."))

            assertEquals(GoogleAccountStatus.Error, viewModel.state.value.status)
            assertEquals("OAuth client configuration is invalid.", viewModel.state.value.errorMessage)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `account join uses target instance without forwarding a Google token and refreshes status`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository(
                status = GoogleAccountStatusResult(
                    enabled = true,
                    bound = false,
                    mode = "accounts",
                    accountJoinEnabled = true,
                ),
            )
            var joinedInstanceId: String? = null
            val viewModel = AccountsViewModel(
                repository = repository,
                joinWithAccountComputer = { instanceId ->
                    joinedInstanceId = instanceId
                    repository.markBound()
                },
            )

            viewModel.onEvent(AccountsEvent.Refresh)
            advanceUntilIdle()
            viewModel.onEvent(AccountsEvent.TargetInstanceChanged("target-instance"))
            viewModel.onEvent(AccountsEvent.JoinWithGoogle)
            advanceUntilIdle()

            assertEquals("target-instance", joinedInstanceId)
            assertTrue(repository.submittedTokens.isEmpty())
            assertEquals(GoogleAccountStatus.SignedIn, viewModel.state.value.status)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `account join requires a target instance before opening verification`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository(
                status = GoogleAccountStatusResult(
                    enabled = true,
                    bound = false,
                    mode = "accounts",
                    accountJoinEnabled = true,
                ),
            )
            var callbackCalled = false
            val viewModel = AccountsViewModel(repository, joinWithAccountComputer = { callbackCalled = true })

            viewModel.onEvent(AccountsEvent.Refresh)
            advanceUntilIdle()
            viewModel.onEvent(AccountsEvent.JoinWithGoogle)
            advanceUntilIdle()

            assertEquals(GoogleAccountStatus.Error, viewModel.state.value.status)
            assertTrue(viewModel.state.value.errorMessage?.contains("target computer") == true)
            assertTrue(!callbackCalled)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `account join maps unknown failure without exposing internal error text`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeAccountsRepository(
                status = GoogleAccountStatusResult(
                    enabled = true,
                    bound = false,
                    mode = "accounts",
                    accountJoinEnabled = true,
                ),
            )
            val viewModel = AccountsViewModel(
                repository = repository,
                joinWithAccountComputer = { error("internal account binding row 42") },
            )

            viewModel.onEvent(AccountsEvent.Refresh)
            advanceUntilIdle()
            viewModel.onEvent(AccountsEvent.TargetInstanceChanged("target-instance"))
            viewModel.onEvent(AccountsEvent.JoinWithGoogle)
            advanceUntilIdle()

            val message = viewModel.state.value.errorMessage.orEmpty()
            assertEquals("Could not join the target computer. Try again.", message)
            assertTrue("internal account binding row 42" !in message)
        } finally {
            Dispatchers.resetMain()
        }
    }
}
