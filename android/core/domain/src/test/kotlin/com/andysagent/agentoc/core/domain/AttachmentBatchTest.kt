package com.andysagent.agentoc.core.domain

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.test.assertFailsWith

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class AttachmentBatchTest {
    @Test fun uploadsAtMostTwoAndKeepsMessageOrder() = runTest {
        val started = Channel<Int>(Channel.UNLIMITED)
        val gates = List(3) { CompletableDeferred<Unit>() }
        val result = async {
            mapAttachmentBatch(listOf("first", "second", "third")) { index, name ->
                started.send(index)
                gates[index].await()
                name
            }
        }
        runCurrent()
        assertEquals(0, started.receive())
        assertEquals(1, started.receive())
        assertTrue(started.tryReceive().isFailure)
        gates[1].complete(Unit)
        runCurrent()
        assertEquals(2, started.receive())
        gates[2].complete(Unit)
        gates[0].complete(Unit)
        assertEquals(listOf("first", "second", "third"), result.await())
    }

    @Test fun failureCancelsSiblingAndDoesNotStartQueuedFile() = runTest {
        val started = mutableListOf<Int>()
        val releaseFailure = CompletableDeferred<Unit>()
        var siblingCancelled = false
        assertFailsWith<IllegalStateException> {
            mapAttachmentBatch(listOf(0, 1, 2)) { index, _ ->
                started += index
                if (index == 0) {
                    releaseFailure.await()
                    error("upload failed")
                }
                try {
                    releaseFailure.complete(Unit)
                    awaitCancellation()
                } finally {
                    siblingCancelled = true
                }
            }
        }
        assertEquals(listOf(0, 1), started)
        assertTrue(siblingCancelled)
    }
}
