package com.andysagent.ragent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals

class BrokerDecisionJournalKeyTest {
    @Test
    fun `decision guard is stable for the same challenge and distinct across targets and nonces`() {
        val first = "a".repeat(64)
        val renewed = "b".repeat(64)
        val key = brokerDecisionJournalKey("computer-a", "request-1", first)
        assertEquals(key, brokerDecisionJournalKey("computer-a", "request-1", first))
        assertNotEquals(key, brokerDecisionJournalKey("computer-b", "request-1", first))
        assertNotEquals(key, brokerDecisionJournalKey("computer-a", "request-2", first))
        assertNotEquals(key, brokerDecisionJournalKey("computer-a", "request-1", renewed))
    }

    @Test
    fun `lost reply leaves a durable guard before POST and a recreated journal cannot resubmit`() = runBlocking {
        val stored = mutableMapOf<String, String>()
        val key = brokerDecisionJournalKey("computer-a", "request-1", "a".repeat(64))
        val first = journal(stored)
        var posts = 0
        assertFailsWith<IllegalStateException> {
            first.submitOnce(key) {
                assertEquals("submitted", stored[key])
                posts++
                error("reply lost")
            }
        }
        val afterRecreation = journal(stored)
        val recorded = assertFailsWith<BrokerDecisionAlreadyRecordedException> {
            afterRecreation.submitOnce(key) { posts++ }
        }
        assertEquals("submitted", recorded.recordedStatus)
        assertEquals(1, posts)

        val otherTarget = brokerDecisionJournalKey("computer-b", "request-1", "a".repeat(64))
        val renewedChallenge = brokerDecisionJournalKey("computer-a", "request-1", "b".repeat(64))
        afterRecreation.submitOnce(otherTarget) { posts++ }
        afterRecreation.submitOnce(renewedChallenge) { posts++ }
        assertEquals(3, posts)
    }

    @Test
    fun `cancellation after submission retains the guard`() = runBlocking {
        val stored = mutableMapOf<String, String>()
        val key = brokerDecisionJournalKey("computer-a", "request-1", "a".repeat(64))
        assertFailsWith<CancellationException> {
            journal(stored).submitOnce(key) { throw CancellationException("process stopped") }
        }
        assertEquals("submitted", stored[key])
        assertFailsWith<BrokerDecisionAlreadyRecordedException> {
            journal(stored).submitOnce(key) { error("must not POST") }
        }
        Unit
    }

    @Test
    fun `failed persistence prevents POST`() = runBlocking {
        var posts = 0
        val journal = BrokerDecisionJournal(Any(), { null }, { _, _ -> false })
        assertFailsWith<BrokerDecisionNotRecordedException> {
            journal.submitOnce("key") { posts++ }
        }
        assertEquals(0, posts)
    }

    private fun journal(stored: MutableMap<String, String>) = BrokerDecisionJournal(
        lock = stored,
        read = { stored[it] },
        write = { key, status -> stored[key] = status; true },
    )
}
