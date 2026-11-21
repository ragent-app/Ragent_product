package com.andysagent.ragent

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

/**
 * Contract tests for the FCM notification identity. The server producer
 * (Accounts push delivery) adds the durable source instance to its versioned data contract.
 * Identity must also isolate target/session when a producer supplies an eventId.
 */
class FcmNotificationIdentityTest {

    @Test
    fun `repeated waiting_user events for one session share one identity`() {
        val first = RagentFirebaseMessagingService.notificationIdentity(
            sessionId = "s1",
            kind = "attention",
            awaitingKey = "waiting_user",
            eventId = null,
        )
        val second = RagentFirebaseMessagingService.notificationIdentity(
            sessionId = "s1",
            kind = "attention",
            awaitingKey = "waiting_user",
            eventId = "",
        )
        assertEquals(first, second)
    }

    @Test
    fun `different sessions or kinds never collide`() {
        val waiting = RagentFirebaseMessagingService.notificationIdentity("s1", "attention", "waiting_user", null)
        val completion = RagentFirebaseMessagingService.notificationIdentity("s1", "completion", "", null)
        val otherSession = RagentFirebaseMessagingService.notificationIdentity("s2", "attention", "waiting_user", null)
        assertNotEquals(waiting, completion)
        assertNotEquals(waiting, otherSession)
    }

    @Test
    fun `a future eventId takes precedence over the composite key`() {
        val composite = RagentFirebaseMessagingService.notificationIdentity("s1", "attention", "waiting_user", null)
        val withEvent = RagentFirebaseMessagingService.notificationIdentity("s1", "attention", "waiting_user", "evt-9")
        assertEquals(withEvent, RagentFirebaseMessagingService.notificationIdentity("s1", "completion", "", "evt-9"))
        assertNotEquals(composite, withEvent)
    }

    @Test
    fun `legacy payload with only sessionId still yields a stable identity`() {
        val only = RagentFirebaseMessagingService.notificationIdentity("s1", null, null, null)
        val again = RagentFirebaseMessagingService.notificationIdentity("s1", "", "", "")
        assertEquals(only, again)
        assertEquals(64, only.length)
    }

    @Test fun `same event and session on different computers remain isolated`() {
        val a = RagentFirebaseMessagingService.notificationIdentity("s1", "attention", "question", "evt-1", "a")
        val b = RagentFirebaseMessagingService.notificationIdentity("s1", "attention", "question", "evt-1", "b")
        assertNotEquals(a, b)
    }

    @Test fun `responsibility events have distinct identities across sequences and computers`() {
        val keyA = "resp:v1:rid=responsibility_1&act=plan_awaiting_approval&raw=plan_proposed&pid=plan_1"
        val keyB = "resp:v1:rid=responsibility_2&act=workflow_completed&raw=workflow_completed"
        val first = RagentFirebaseMessagingService.notificationIdentity(
            sessionId = "root-sess",
            kind = "plan",
            awaitingKey = keyA,
            eventId = "responsibility:responsibility_1:10",
            targetInstanceId = "inst_a",
        )
        val second = RagentFirebaseMessagingService.notificationIdentity(
            sessionId = "root-sess",
            kind = "plan",
            awaitingKey = keyA,
            eventId = "responsibility:responsibility_1:11",
            targetInstanceId = "inst_a",
        )
        val otherPc = RagentFirebaseMessagingService.notificationIdentity(
            sessionId = "root-sess",
            kind = "plan",
            awaitingKey = keyA,
            eventId = "responsibility:responsibility_1:10",
            targetInstanceId = "inst_b",
        )
        val otherResp = RagentFirebaseMessagingService.notificationIdentity(
            sessionId = "root-sess",
            kind = "completion",
            awaitingKey = keyB,
            eventId = "responsibility:responsibility_2:1",
            targetInstanceId = "inst_a",
        )
        assertEquals(64, first.length)
        assertNotEquals(first, second)
        assertNotEquals(first, otherPc)
        assertNotEquals(first, otherResp)
    }
}
