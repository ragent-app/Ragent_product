package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.model.RuntimeConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class SwitchingRagentTransportTest {
    @Test fun nonOwningUiFacadeOnlyDetachesAndCannotCloseSharedCarriers() = runBlocking {
        val facade = SwitchingRagentTransport(CoroutineScope(Dispatchers.Unconfined), closeDelegates = false)
        val computerA = FakeTransport("computer-a"); val computerB = FakeTransport("computer-b")
        facade.switchTo(computerA); facade.switchTo(computerB); facade.close()
        assertEquals(0, computerA.closeCount); assertEquals(0, computerB.closeCount)
        assertEquals(null, facade.delegate.value)
        assertEquals("computer-a", computerA.execute(ApiRequest("GET", "/api/target")).body)
    }

    @Test
    fun switchingTargetRoutesRequestsToOnlyTheSelectedTransport() = runBlocking {
        val facade = SwitchingRagentTransport(CoroutineScope(Dispatchers.Unconfined))
        val computerA = FakeTransport("computer-a")
        val computerB = FakeTransport("computer-b")

        facade.switchTo(computerA)
        assertEquals("computer-a", facade.execute(ApiRequest("GET", "/api/target")).body)

        facade.switchTo(computerB)
        assertEquals("computer-b", facade.execute(ApiRequest("GET", "/api/target")).body)
        assertEquals(1, computerA.requestCount)
        assertEquals(1, computerB.requestCount)
    }

    @Test
    fun noSelectedTargetCannotIssueARequest() {
        runBlocking {
            val facade = SwitchingRagentTransport(CoroutineScope(Dispatchers.Unconfined))
            assertFailsWith<IllegalStateException> {
                facade.execute(ApiRequest("POST", "/api/write", "{}"))
            }
        }
    }

    @Test
    fun exposesTheSelectedTransportPollingCapability() {
        runBlocking {
            val facade = SwitchingRagentTransport(CoroutineScope(Dispatchers.Unconfined))
            val endpointful = FakeTransport("endpointful", requiresEventPolling = false)
            val endpointless = FakeTransport("endpointless", requiresEventPolling = true)

            assertEquals(false, facade.requiresEventPolling)
            facade.switchTo(endpointful)
            assertEquals(false, facade.requiresEventPolling)
            facade.switchTo(endpointless)
            assertEquals(true, facade.requiresEventPolling)
        }
    }

    @Test
    fun switchingTargetClosesThePreviousTransportBeforeInstallingTheNextOne() = runBlocking {
        val facade = SwitchingRagentTransport(CoroutineScope(Dispatchers.Unconfined))
        val computerA = FakeTransport("computer-a")
        val computerB = FakeTransport("computer-b")

        facade.switchTo(computerA)
        facade.switchTo(computerB)

        assertEquals(1, computerA.closeCount)
        assertEquals(0, computerB.closeCount)
        assertEquals(computerB, facade.delegate.value)
    }

    @Test
    fun closingFacadeClosesTheSelectedTransport() = runBlocking {
        val facade = SwitchingRagentTransport(CoroutineScope(Dispatchers.Unconfined))
        val computer = FakeTransport("computer")

        facade.switchTo(computer)
        facade.close()

        assertEquals(1, computer.closeCount)
        assertEquals(null, facade.delegate.value)
    }
}

private class FakeTransport(
    private val responseBody: String,
    override val requiresEventPolling: Boolean = false,
) : RagentTransport {
    private val mutableState = MutableStateFlow(RuntimeConnectionState.Connected)
    var requestCount: Int = 0
        private set
    var closeCount: Int = 0
        private set

    override val invalidations: Flow<InvalidationHint> = emptyFlow()
    override val connectionState = mutableState

    override suspend fun execute(request: ApiRequest): ApiResponse {
        requestCount += 1
        return ApiResponse(200, responseBody)
    }

    override fun connectInvalidationSocket() = Unit
    override suspend fun close() {
        closeCount += 1
    }
}
