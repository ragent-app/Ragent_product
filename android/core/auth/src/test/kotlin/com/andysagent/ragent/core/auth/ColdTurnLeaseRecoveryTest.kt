package com.andysagent.ragent.core.auth

import kotlinx.coroutines.*
import kotlin.test.*

class ColdTurnLeaseRecoveryTest {
    private fun id(index: Int) = "turn_${"a".repeat(32)}_1790000000000_${index.toString().padStart(32, '0')}"
    private fun page(ids: List<String>, next: String? = null) = AccountTurnConnectionsPage(1, "acct_1", "adev_test",
        "2026-10-25T00:00:00Z", ids.map { AccountTurnConnection(it, "inst_primary", "rdev_primary", "2099-01-01T00:00:00Z") }, next)

    private class Client : AccountTurnLeaseClient {
        val reads = mutableListOf<String?>()
        val releases = mutableListOf<List<String>>()
        var read: suspend (String?) -> AccountTurnConnectionsPage = { error("Unexpected inventory") }
        var release: suspend (List<String>) -> Unit = {}
        override suspend fun listOwnTurnConnections(afterConnectionId: String?): AccountTurnConnectionsPage {
            reads += afterConnectionId; return read(afterConnectionId)
        }
        override suspend fun releaseOwnTurnConnections(connectionIds: List<String>, reason: String): AccountTurnConnectionsRelease {
            assertEquals("cold-process-recovery", reason)
            releases += connectionIds; release(connectionIds)
            return AccountTurnConnectionsRelease(1, "acct_1", "adev_test", connectionIds.size, connectionIds.size)
        }
    }

    @Test fun `all new carrier callers wait for the single exact-ID cleanup`() = runBlocking {
        val entered = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        val client = Client().apply { read = { page(listOf(id(1), id(2))) }; release = { entered.complete(Unit); finish.await() } }
        val recovery = ColdTurnLeaseRecovery(client)
        var started = 0
        val primary = launch { recovery.beforeNewReservations(); started++ }
        entered.await()
        val background = launch { recovery.beforeNewReservations(); started++ }
        yield(); assertEquals(0, started)
        finish.complete(Unit); primary.join(); background.join()
        assertEquals(2, started); assertEquals(1, client.reads.size)
        assertEquals(listOf(listOf(id(1), id(2))), client.releases)
    }

    @Test fun `offline inventory cannot retry after new carriers are admitted`() = runBlocking {
        val client = Client().apply { read = { throw IllegalStateException("Accounts offline") } }
        val recovery = ColdTurnLeaseRecovery(client)
        recovery.beforeNewReservations()
        client.read = { error("Must not inventory fresh live reservations") }
        recovery.beforeNewReservations()
        assertEquals(1, client.reads.size); assertTrue(client.releases.isEmpty())
    }

    @Test fun `bounded startup timeout opens once and never retries a fresh inventory`() = runBlocking {
        val client = Client().apply { read = { delay(Long.MAX_VALUE); page(listOf(id(99))) } }
        val recovery = ColdTurnLeaseRecovery(client, timeoutMs = 20)
        withTimeout(1_000) { recovery.beforeNewReservations() }
        recovery.beforeNewReservations()
        assertEquals(1, client.reads.size); assertTrue(client.releases.isEmpty())
    }

    @Test fun `caller cancellation cannot release IDs from a late inventory response`() = runBlocking {
        val entered = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        val client = Client().apply { read = { entered.complete(Unit); withContext(NonCancellable) { finish.await() }; page(listOf(id(3))) } }
        val recovery = ColdTurnLeaseRecovery(client)
        val cancelled = launch { recovery.beforeNewReservations() }
        entered.await(); cancelled.cancel(); finish.complete(Unit); cancelled.join()
        assertTrue(cancelled.isCancelled); assertTrue(client.releases.isEmpty())
        recovery.beforeNewReservations(); assertEquals(1, client.reads.size)
    }

    @Test fun `pagination is bounded and an initially missing RAC is never swept after login`() = runBlocking {
        val client = Client().apply { read = { page(listOf(id(reads.size)), id(reads.size)) } }
        val recovery = ColdTurnLeaseRecovery(client, maximumPages = 2)
        recovery.beforeNewReservations(); recovery.beforeNewReservations()
        assertEquals(2, client.reads.size); assertEquals(listOf(null, id(1)), client.reads)
        assertEquals(2, client.releases.size)
        var enabled = false
        val skipped = Client()
        val noRac = ColdTurnLeaseRecovery(skipped, enabled = { enabled })
        noRac.beforeNewReservations(); enabled = true; noRac.beforeNewReservations()
        assertTrue(skipped.reads.isEmpty())
    }
}
