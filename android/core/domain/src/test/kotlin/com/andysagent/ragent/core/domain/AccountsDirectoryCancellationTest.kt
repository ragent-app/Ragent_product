package com.andysagent.ragent.core.domain

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.Assert.*

class AccountsDirectoryCancellationTest {
    @Test fun directoryCancellationKeepsItsIdentity() = runBlocking {
        val cancelled = CancellationException("Retired account directory request")
        val transport = DirectoryTransport { throw cancelled }
        try { DefaultAccountsRepository(transport, discoveryTransport = transport).listAccountDevices(); fail("Expected cancellation") }
        catch (error: Throwable) { assertSame(cancelled, error) }
    }
    @Test fun directoryApiFailuresRemainTypedAndRetryable() = runBlocking {
        val transport = DirectoryTransport { throw ApiException(503, "offline", "Offline", retryable = true) }
        try { DefaultAccountsRepository(transport, discoveryTransport = transport).listAccountDevices(); fail("Expected API failure") }
        catch (error: AccountsRepositoryException) { assertEquals(503, error.statusCode); assertTrue(error.retryable) }
    }
    @Test fun malformedDirectoryStillFailsClosed() = runBlocking {
        val transport = DirectoryTransport { ApiResponse(200, "not-json") }
        try { DefaultAccountsRepository(transport, discoveryTransport = transport).listAccountDevices(); fail("Expected invalid response") }
        catch (error: AccountsRepositoryException) { assertEquals("accounts_response_invalid", error.code); assertFalse(error.retryable) }
    }
    private class DirectoryTransport(val respond: suspend () -> ApiResponse) : RagentTransport {
        override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
        override val invalidations = emptyFlow<InvalidationHint>()
        override suspend fun execute(request: ApiRequest) = respond()
        override fun connectInvalidationSocket() = Unit
        override suspend fun close() = Unit
    }
}