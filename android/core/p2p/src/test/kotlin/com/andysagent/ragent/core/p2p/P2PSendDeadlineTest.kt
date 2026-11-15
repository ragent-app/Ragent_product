package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class P2PSendDeadlineTest {
    @Test fun `successful send completes normally`() = runTest {
        var calls = 0
        withP2PSendDeadline(20) { calls++ }
        assertEquals(1, calls)
    }

    @Test fun `internal send timeout becomes a transport error`() = runTest {
        assertFailsWith<P2PSendTimeoutException> { withP2PSendDeadline(20) { delay(100) } }
    }

    @Test fun `caller cancellation is not converted to a timeout`() = runTest {
        val started = CompletableDeferred<Unit>()
        val task = async { withP2PSendDeadline(10_000) { started.complete(Unit); awaitCancellation() } }
        started.await()
        task.cancel()
        assertFailsWith<CancellationException> { task.await() }
    }
}
