package com.andysagent.ragent.feature.workbench.accounts

import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.core.domain.GoogleAccountProfile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class DemoSignInViewModelTest {
    @Test fun `an existing personal connection has a distinct recovery message and clears the password`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val vm = DemoSignInViewModel { _, _ -> throw AccountSessionException(409, "demo_existing_connections", "fixture") }
            vm.open(); vm.usernameChanged("review-fixture"); vm.passwordChanged("fixture-password-long")
            vm.submit(); advanceUntilIdle()
            assertEquals(DemoSignInError.ExistingConnections, vm.state.value.error)
            assertEquals("", vm.state.value.password)
        } finally { Dispatchers.resetMain() }
    }
    @Test fun `duplicate taps do not create parallel logins and success clears passwords`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var calls = 0
            val done = CompletableDeferred<Unit>()
            val vm = DemoSignInViewModel { user, password ->
                calls++; assertEquals("review-fixture", user); assertEquals("fixture-password-long", password)
                done.await(); GoogleAccountProfile(displayName = "Demo workspace", email = null, photoUrl = null)
            }
            vm.open(); vm.usernameChanged("review-fixture"); vm.passwordChanged("fixture-password-long")
            assertFalse(vm.state.value.toString().contains("fixture-password-long"))
            vm.submit(); vm.submit(); advanceUntilIdle()
            assertEquals(1, calls); assertTrue(vm.state.value.busy)
            vm.dismiss(); assertTrue(vm.state.value.open)
            done.complete(Unit); advanceUntilIdle()
            assertEquals("", vm.state.value.password); assertFalse(vm.state.value.open)
            assertEquals("Demo workspace", vm.state.value.signedInProfile?.displayName)
            vm.consumeSuccess(); assertEquals(DemoSignInUiState(), vm.state.value)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `failure is sanitized and dismiss clears all typed credentials`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            for ((status, expected) in listOf(401 to DemoSignInError.Credentials, 403 to DemoSignInError.Unavailable,
                429 to DemoSignInError.RateLimited, 503 to DemoSignInError.Network)) {
                val vm = DemoSignInViewModel { _, _ -> throw AccountSessionException(status, "fixture", "sensitive server diagnostic") }
                vm.open(); vm.usernameChanged("review-fixture"); vm.passwordChanged("fixture-password-long")
                vm.submit(); advanceUntilIdle()
                assertEquals(expected, vm.state.value.error); assertEquals("", vm.state.value.password)
                assertFalse(vm.state.value.toString().contains("sensitive"))
                vm.dismiss(); assertEquals(DemoSignInUiState(), vm.state.value)
            }
        } finally { Dispatchers.resetMain() }
    }
}
