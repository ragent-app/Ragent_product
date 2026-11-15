package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.domain.DiscoveredComputer
import com.andysagent.ragent.core.domain.AccountsRepositoryException
import com.andysagent.ragent.core.network.ApiException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class PairingOnboardingViewModelTest {
    @Test fun `unlimited account selection ignores compatibility numeric budget`() {
        val computer = DiscoveredComputer("inst_one", "First", null,
            maximumConcurrentConnections = 1, activeComputerConnections = 10,
            unlimitedConnections = true)
        val state = PairingOnboardingUiState(discoveredComputers = listOf(computer))
        assertTrue(state.unlimitedConnections)
        assertEquals(Int.MAX_VALUE, state.availableSelections)
        assertEquals(0, state.copy(discoveredComputers = listOf(computer.copy(unlimitedConnections = false))).availableSelections)
    }

    @Test
    fun `stop waiting hides an in flight claim and preserves its result for reopening`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val completed = CompletableDeferred<Unit>()
            var calls = 0
            val vm = PairingOnboardingViewModel("Phone", completePairing = { _, _ ->
                calls++
                completed.await()
            })
            vm.onEvent(PairingOnboardingEvent.PairingUriReceived(pairingUri))
            runCurrent()
            assertEquals(PairingOnboardingStep.GoogleRequired, vm.state.value.step)
            vm.onEvent(PairingOnboardingEvent.AccountSessionReady)
            runCurrent()
            assertEquals(PairingOnboardingStep.Verifying, vm.state.value.step)

            vm.onEvent(PairingOnboardingEvent.StopWaiting)
            assertFalse(vm.state.value.open)
            vm.onEvent(PairingOnboardingEvent.PairingUriReceived(pairingUri))
            assertEquals(1, calls)
            completed.complete(Unit)
            advanceUntilIdle()
            assertFalse(vm.state.value.open)
            assertEquals(PairingOnboardingStep.Bound, vm.state.value.step)

            vm.onEvent(PairingOnboardingEvent.Open)
            assertTrue(vm.state.value.open)
            assertEquals(PairingOnboardingStep.Bound, vm.state.value.step)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `late claim failure stays hidden until reopened and retry is explicit`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val failed = CompletableDeferred<Unit>()
            var calls = 0
            val vm = PairingOnboardingViewModel("Phone", completePairing = { _, _ ->
                calls++
                if (calls == 1) failed.await()
            })
            vm.onEvent(PairingOnboardingEvent.PairingUriReceived(pairingUri))
            vm.onEvent(PairingOnboardingEvent.AccountSessionReady)
            runCurrent()
            vm.onEvent(PairingOnboardingEvent.StopWaiting)
            failed.completeExceptionally(IllegalStateException("network unavailable"))
            advanceUntilIdle()

            assertEquals(1, calls)
            assertFalse(vm.state.value.open)
            assertEquals(PairingOnboardingStep.Error, vm.state.value.step)
            vm.onEvent(PairingOnboardingEvent.Open)
            assertTrue(vm.state.value.errorMessage?.contains("reached") == true)
            vm.onEvent(PairingOnboardingEvent.Retry)
            advanceUntilIdle()
            assertEquals(2, calls)
            assertEquals(PairingOnboardingStep.Bound, vm.state.value.step)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `account conflict starts a new code flow instead of replaying the rejected code`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var attempts = 0
            val vm = PairingOnboardingViewModel("Phone", completePairing = { _, _ ->
                attempts++
                throw AccountsRepositoryException(409, "owner_auth_conflict", "conflict", false)
            })
            vm.onEvent(PairingOnboardingEvent.PairingUriReceived(pairingUri))
            vm.onEvent(PairingOnboardingEvent.AccountSessionReady)
            advanceUntilIdle()
            assertEquals(PairingOnboardingStep.Error, vm.state.value.step)
            assertTrue(vm.state.value.requiresNewCode)

            vm.onEvent(PairingOnboardingEvent.Retry)
            advanceUntilIdle()
            assertEquals(1, attempts)
            assertEquals(PairingOnboardingStep.AccountClaimRequired, vm.state.value.step)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `stop waiting during discovery does not restart discovery or reopen the dialog`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val discovered = CompletableDeferred<List<DiscoveredComputer>>()
            var calls = 0
            val vm = PairingOnboardingViewModel("Phone", completePairing = { _, _ -> },
                discoverComputers = { calls++; discovered.await() })
            vm.onEvent(PairingOnboardingEvent.AccountSessionReady)
            runCurrent()
            vm.onEvent(PairingOnboardingEvent.StopWaiting)
            vm.onEvent(PairingOnboardingEvent.StartComputerConnection)
            assertEquals(1, calls)
            discovered.complete(emptyList())
            advanceUntilIdle()

            assertFalse(vm.state.value.open)
            assertEquals(PairingOnboardingStep.AccountClaimRequired, vm.state.value.step)
            vm.onEvent(PairingOnboardingEvent.Open)
            assertTrue(vm.state.value.open)
            assertEquals(1, calls)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `external ordinary QR resumes the existing account after onboarding was dismissed`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val uri = "ragent://pair?v=3&i=inst_protocol_test_0001&t=rpi_secret&x=2099-01-01T00%3A00%3A00Z&p=key&f=${"a".repeat(64)}"
            var paired = false
            val vm = PairingOnboardingViewModel("Phone", completePairing = { received, _ ->
                assertEquals(uri, received); paired = true
            })
            vm.onEvent(PairingOnboardingEvent.AccountSessionReady)
            vm.onEvent(PairingOnboardingEvent.Dismiss)
            vm.onEvent(PairingOnboardingEvent.Open)
            vm.onEvent(PairingOnboardingEvent.PairingUriReceived(uri))
            assertEquals(PairingOnboardingStep.GoogleRequired, vm.state.value.step)
            vm.onEvent(PairingOnboardingEvent.AccountSessionReady)
            advanceUntilIdle()
            assertTrue(paired)
            assertEquals(PairingOnboardingStep.Bound, vm.state.value.step)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `signed out phone starts desktop account sign in on scan without Google and can retry`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var attempts = 0
            val uri = "ragent://pair?v=4&i=inst_protocol_test_0001&q=rpinv_protocol_test_0001&t=rpi_secret&x=2099-01-01T00%3A00%3A00Z&p=key&f=${"a".repeat(64)}"
            val vm = PairingOnboardingViewModel("Phone", completePairing = { _, _ ->
                attempts++; if (attempts == 1) error("Network unavailable")
            })
            vm.onEvent(PairingOnboardingEvent.PairingUriReceived(uri))
            assertEquals(PairingOnboardingStep.Verifying, vm.state.value.step)
            assertTrue(vm.state.value.accountHandoff)
            advanceUntilIdle()
            assertEquals(PairingOnboardingStep.Error, vm.state.value.step)
            vm.onEvent(PairingOnboardingEvent.Retry)
            advanceUntilIdle()
            assertEquals(PairingOnboardingStep.Bound, vm.state.value.step)
            assertEquals(2, attempts)
        } finally { Dispatchers.resetMain() }
    }
    private val pairingUri =
        "ragent://pair?v=3&instance=instance-1&endpoint=https%3A%2F%2Fcomputer.example&token=rpi_test&expires=2099-01-01T00%3A00%3A00Z"

    @Test
    fun `temporary code connects without an account session`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var received: String? = null
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Honor Test",
                completePairing = { _, _ -> error("Account pairing must not run") },
                completeTemporaryPairing = { received = it },
            )
            viewModel.onEvent(PairingOnboardingEvent.OpenWelcome)
            viewModel.onEvent(PairingOnboardingEvent.PairingUriReceived("{\"version\":1}"))
            assertEquals(PairingOnboardingStep.Verifying, viewModel.state.value.step)
            assertTrue(viewModel.state.value.temporaryPairing)
            advanceUntilIdle()
            assertEquals("{\"version\":1}", received)
            assertEquals(PairingOnboardingStep.Bound, viewModel.state.value.step)
            assertTrue(viewModel.state.value.temporaryPairing)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `temporary setup failure does not suggest Google account linking`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Honor Test",
                completePairing = { _, _ -> error("Account pairing must not run") },
                completeTemporaryPairing = { error("Transport unavailable") },
            )
            viewModel.onEvent(PairingOnboardingEvent.OpenWelcome)
            viewModel.onEvent(PairingOnboardingEvent.PairingUriReceived("{\"version\":1}"))
            advanceUntilIdle()

            val message = requireNotNull(viewModel.state.value.errorMessage)
            assertEquals(PairingOnboardingStep.Error, viewModel.state.value.step)
            assertTrue(message.contains("temporary connection", ignoreCase = true))
            assertFalse(message.contains("Google", ignoreCase = true))
            assertFalse(message.contains("account-link", ignoreCase = true))
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `temporary turn quota is shown as phone capacity and does not require subscription`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Honor Test",
                completePairing = { _, _ -> error("Account pairing must not run") },
                completeTemporaryPairing = {
                    throw ApiException(429, "temporary_broker_turn_quota_exceeded", "phone limit reached")
                },
            )
            viewModel.onEvent(PairingOnboardingEvent.PairingUriReceived("{\"version\":1}"))
            advanceUntilIdle()

            assertEquals(PairingOnboardingStep.Error, viewModel.state.value.step)
            assertEquals(TemporaryPairingFailure.PhoneQuotaExceeded, viewModel.state.value.temporaryPairingFailure)
            assertFalse(viewModel.state.value.subscriptionRequired)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `temporary host timeout remains retryable with explicit slow host failure`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Honor Test",
                completePairing = { _, _ -> error("Account pairing must not run") },
                completeTemporaryPairing = {
                    throw ApiException(408, "temporary_host_timeout", "request timed out")
                },
            )
            viewModel.onEvent(PairingOnboardingEvent.PairingUriReceived("{\"version\":1}"))
            advanceUntilIdle()

            assertEquals(TemporaryPairingFailure.HostSlow, viewModel.state.value.temporaryPairingFailure)
            assertFalse(viewModel.state.value.subscriptionRequired)
            assertFalse(viewModel.state.value.requiresNewCode)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `conflicting temporary claim offers explicit replacement and reconnects`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var completionCalls = 0
            var replacementCalls = 0
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Honor Test",
                completePairing = { _, _ -> error("Account pairing must not run") },
                completeTemporaryPairing = {
                    completionCalls++
                    if (completionCalls == 1) error("temporary claim conflict")
                },
                isTemporaryClaimConflict = { it.message == "temporary claim conflict" },
                replaceTemporaryClaim = {
                    replacementCalls++
                    TemporaryClaimReplacementOutcome.ReadyToRetry
                },
            )

            viewModel.onEvent(PairingOnboardingEvent.PairingUriReceived("{\"version\":1}"))
            advanceUntilIdle()
            assertEquals(PairingOnboardingStep.Error, viewModel.state.value.step)
            assertTrue(viewModel.state.value.canReplaceTemporaryClaim)

            viewModel.onEvent(PairingOnboardingEvent.ReplaceTemporaryClaimAndRetry)
            advanceUntilIdle()

            assertEquals(1, replacementCalls)
            assertEquals(2, completionCalls)
            assertEquals(PairingOnboardingStep.Bound, viewModel.state.value.step)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `temporary replacement refuses to discard operations awaiting result retrieval`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var completionCalls = 0
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Honor Test",
                completePairing = { _, _ -> error("Account pairing must not run") },
                completeTemporaryPairing = { completionCalls++; error("temporary claim conflict") },
                isTemporaryClaimConflict = { it.message == "temporary claim conflict" },
                replaceTemporaryClaim = {
                    TemporaryClaimReplacementOutcome.BlockedByOperations(2)
                },
            )

            viewModel.onEvent(PairingOnboardingEvent.PairingUriReceived("{\"version\":1}"))
            advanceUntilIdle()
            viewModel.onEvent(PairingOnboardingEvent.ReplaceTemporaryClaimAndRetry)
            advanceUntilIdle()

            assertEquals(1, completionCalls)
            assertEquals(PairingOnboardingStep.Error, viewModel.state.value.step)
            assertEquals(2, viewModel.state.value.replacementBlockedOperationCount)
            assertFalse(viewModel.state.value.canReplaceTemporaryClaim)
        } finally {
            Dispatchers.resetMain()
        }
    }
    @Test
    fun `saved temporary claim resumes without Google or a second scan`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val instanceId = "inst_${"a".repeat(32)}"
            var resumed: String? = null
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Honor Test",
                completePairing = { _, _ -> error("Account pairing must not run") },
                resumeTemporaryPairing = { resumed = it },
            )
            viewModel.onEvent(PairingOnboardingEvent.ResumeTemporaryPairing(instanceId))
            assertEquals(PairingOnboardingStep.Verifying, viewModel.state.value.step)
            advanceUntilIdle()
            assertEquals(instanceId, resumed)
            assertEquals(PairingOnboardingStep.Bound, viewModel.state.value.step)
            assertTrue(viewModel.state.value.temporaryPairing)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `first run opens welcome before the pairing flow`() = runTest {
        val viewModel = PairingOnboardingViewModel(
            deviceName = "Pixel Test",
            completePairing = { _, _ -> },
        )

        viewModel.onEvent(PairingOnboardingEvent.OpenWelcome)
        assertTrue(viewModel.state.value.open)
        assertEquals(PairingOnboardingStep.Welcome, viewModel.state.value.step)

        viewModel.onEvent(PairingOnboardingEvent.ContinueFromWelcome)
        assertEquals(PairingOnboardingStep.GoogleRequired, viewModel.state.value.step)
        assertEquals(PairingOnboardingMode.ConnectComputerFromWelcome, viewModel.state.value.mode)

        viewModel.onEvent(PairingOnboardingEvent.BackToWelcome)
        viewModel.onEvent(PairingOnboardingEvent.SignInFromWelcome)
        assertEquals(PairingOnboardingMode.SignIn, viewModel.state.value.mode)

        viewModel.onEvent(PairingOnboardingEvent.BackToWelcome)
        assertEquals(PairingOnboardingStep.Welcome, viewModel.state.value.step)

        viewModel.onEvent(PairingOnboardingEvent.LearnConnectionMethods)
        assertEquals(PairingOnboardingStep.ConnectionMethods, viewModel.state.value.step)

        viewModel.onEvent(PairingOnboardingEvent.BackToWelcome)
        assertEquals(PairingOnboardingStep.Welcome, viewModel.state.value.step)
    }

    @Test
    fun `scanner failure from welcome retains the connection return path`() = runTest {
        val viewModel = PairingOnboardingViewModel(
            deviceName = "Pixel Test",
            completePairing = { _, _ -> },
        )

        viewModel.onEvent(PairingOnboardingEvent.OpenWelcome)
        viewModel.onEvent(PairingOnboardingEvent.ScannerFailed(returnToWelcome = true))

        assertEquals(PairingOnboardingStep.Error, viewModel.state.value.step)
        assertTrue(viewModel.state.value.scannerFailureReturnsToWelcome)
        assertTrue(viewModel.state.value.scannerUnavailable)

        viewModel.onEvent(PairingOnboardingEvent.Retry)
        assertEquals(PairingOnboardingStep.Welcome, viewModel.state.value.step)
    }

    @Test
    fun `account session discovers computers without carrying a Google token`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var discoveryCalls = 0
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Pixel Test",
                completePairing = { _, _ -> },
                discoverComputers = {
                    discoveryCalls += 1
                    emptyList()
                },
            )

            viewModel.onEvent(PairingOnboardingEvent.Open)
            viewModel.onEvent(PairingOnboardingEvent.AccountSessionReady)
            advanceUntilIdle()

            assertEquals(1, discoveryCalls)
            assertEquals(PairingOnboardingStep.AccountClaimRequired, viewModel.state.value.step)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `account session then scan completes the bound flow`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var received: Triple<String, String, String>? = null
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Pixel Test",
                completePairing = { _, _ -> error("alias callback should be used") },
                completePairingWithAlias = { uri, name, alias ->
                    received = Triple(uri, name, alias)
                },
            )

            viewModel.onEvent(PairingOnboardingEvent.Open)
            viewModel.onEvent(PairingOnboardingEvent.AccountSessionReady)
            assertEquals(PairingOnboardingStep.AccountClaimRequired, viewModel.state.value.step)
            viewModel.onEvent(PairingOnboardingEvent.PairingUriReceived(pairingUri))
            assertEquals(PairingOnboardingStep.Verifying, viewModel.state.value.step)
            advanceUntilIdle()

            assertEquals(Triple(pairingUri, "Pixel Test", ""), received)
            assertEquals(PairingOnboardingStep.Bound, viewModel.state.value.step)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `scan before account session is held only in memory and resumes after sign in`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var callbackCount = 0
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Pixel Test",
                completePairing = { _, _ -> callbackCount++ },
            )

            viewModel.onEvent(PairingOnboardingEvent.PairingUriReceived(pairingUri))
            assertEquals(PairingOnboardingStep.GoogleRequired, viewModel.state.value.step)
            viewModel.onEvent(PairingOnboardingEvent.AccountSessionReady)
            assertEquals(PairingOnboardingStep.Verifying, viewModel.state.value.step)
            advanceUntilIdle()

            assertEquals(1, callbackCount)
            assertEquals(PairingOnboardingStep.Bound, viewModel.state.value.step)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `invalid QR code never starts pairing and exposes recovery`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var callbackCalled = false
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Pixel Test",
                completePairing = { _, _ -> callbackCalled = true },
            )

            viewModel.onEvent(PairingOnboardingEvent.AccountSessionReady)
            viewModel.onEvent(PairingOnboardingEvent.PairingUriReceived("https://example.test/not-a-pair"))
            advanceUntilIdle()

            assertTrue(!callbackCalled)
            assertEquals(PairingOnboardingStep.Error, viewModel.state.value.step)
            assertTrue(viewModel.state.value.errorMessage?.contains("valid") == true)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `account session discovers same-account computers and takeover requires selection`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val computer = DiscoveredComputer(
                instanceId = "instance-1",
                alias = "Office computer",
                endpoint = "https://computer.example",
                canTakeOver = true,
            )
            var takenOver: Pair<String, String>? = null
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Pixel Test",
                completePairing = { _, _ -> error("QR path should not run") },
                discoverComputers = { name ->
                    assertEquals("Pixel Test", name)
                    listOf(computer)
                },
                takeOverComputers = { selected, name ->
                    takenOver = selected.single().instanceId to name
                },
            )

            viewModel.onEvent(PairingOnboardingEvent.Open)
            viewModel.onEvent(PairingOnboardingEvent.AccountSessionReady)
            advanceUntilIdle()

            assertEquals(PairingOnboardingStep.ComputerSelect, viewModel.state.value.step)
            assertEquals(null, viewModel.state.value.selectedComputer)
            viewModel.onEvent(PairingOnboardingEvent.ComputerSelected(computer))
            viewModel.onEvent(PairingOnboardingEvent.TakeOverSelected)
            advanceUntilIdle()

            assertEquals("instance-1" to "Pixel Test", takenOver)
            assertEquals(PairingOnboardingStep.Bound, viewModel.state.value.step)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `computer selection respects the account concurrent connection limit`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            fun computer(id: String) = DiscoveredComputer(
                instanceId = id,
                alias = id,
                endpoint = "https://$id.example",
                canTakeOver = true,
                connectionPlan = "plus",
                maximumConcurrentConnections = 3,
                activeComputerConnections = 1,
            )
            val first = computer("first")
            val second = computer("second")
            val third = computer("third")
            var connected: List<String> = emptyList()
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Pixel Test",
                completePairing = { _, _ -> error("QR path should not run") },
                discoverComputers = { listOf(first, second, third) },
                takeOverComputers = { selected, _ -> connected = selected.map { it.instanceId } },
            )

            viewModel.onEvent(PairingOnboardingEvent.Open)
            viewModel.onEvent(PairingOnboardingEvent.AccountSessionReady)
            advanceUntilIdle()
            viewModel.onEvent(PairingOnboardingEvent.ComputerSelected(first))
            viewModel.onEvent(PairingOnboardingEvent.ComputerSelected(second))
            viewModel.onEvent(PairingOnboardingEvent.ComputerSelected(third))

            assertEquals(setOf("first", "second"), viewModel.state.value.selectedComputerIds)
            assertEquals(2, viewModel.state.value.availableSelections)
            viewModel.onEvent(PairingOnboardingEvent.TakeOverSelected)
            advanceUntilIdle()
            assertEquals(listOf("first", "second"), connected)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `empty same-account discovery keeps QR fallback`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Pixel Test",
                completePairing = { _, _ -> },
                discoverComputers = { emptyList() },
            )

            viewModel.onEvent(PairingOnboardingEvent.AccountSessionReady)
            advanceUntilIdle()

            assertEquals(PairingOnboardingStep.AccountClaimRequired, viewModel.state.value.step)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `unconfigured Google account service explains the binding failure`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Pixel Test",
                completePairing = { _, _ ->
                    throw AccountsRepositoryException(
                        statusCode = 409,
                        code = "google_login_not_configured",
                        message = "Google login is not configured on this instance.",
                        retryable = false,
                    )
                },
            )

            viewModel.onEvent(PairingOnboardingEvent.AccountSessionReady)
            viewModel.onEvent(PairingOnboardingEvent.PairingUriReceived(pairingUri))
            viewModel.onEvent(PairingOnboardingEvent.ConfirmComputerAlias)
            advanceUntilIdle()

            assertEquals(PairingOnboardingStep.Error, viewModel.state.value.step)
            assertTrue(viewModel.state.value.errorMessage?.contains("not configured") == true)
            assertEquals(R.string.pairing_error_accounts_not_configured, viewModel.state.value.errorMessageRes)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `device quota failure exposes a subscription action state`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = PairingOnboardingViewModel(
                deviceName = "Pixel Test",
                completePairing = { _, _ ->
                    throw AccountsRepositoryException(
                        statusCode = 409,
                        code = "device_phone_quota_exceeded",
                        message = "phone device quota exceeded.",
                        retryable = false,
                    )
                },
            )

            viewModel.onEvent(PairingOnboardingEvent.AccountSessionReady)
            viewModel.onEvent(PairingOnboardingEvent.PairingUriReceived(pairingUri))
            viewModel.onEvent(PairingOnboardingEvent.ComputerAliasChanged("Workstation"))
            viewModel.onEvent(PairingOnboardingEvent.ConfirmComputerAlias)
            advanceUntilIdle()

            assertEquals(PairingOnboardingStep.Error, viewModel.state.value.step)
            assertTrue(viewModel.state.value.subscriptionRequired)
            assertTrue(viewModel.state.value.errorMessage?.contains("Free plan limit of 1 phone") == true)
        } finally {
            Dispatchers.resetMain()
        }
    }
}
