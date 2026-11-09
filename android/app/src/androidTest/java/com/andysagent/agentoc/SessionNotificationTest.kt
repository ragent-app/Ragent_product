package com.andysagent.agentoc

import android.app.NotificationManager
import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.agentoc.core.appapi.SessionNavigationRequest
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SessionNotificationTest {
    @Test fun sourceAndHashCollisionSessionsHaveIndependentImmutablePendingIntentsAndTerminalCancellation() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = context.getSystemService(NotificationManager::class.java)
        assertTrue("Host must grant notifications before instrumentation starts", manager.areNotificationsEnabled())
        val suffix = UUID.randomUUID().toString().take(8)
        val a = "qa-a-$suffix"; val b = "qa-b-$suffix"
        val requests = listOf(SessionNavigationRequest("Aa", a, "question", "q1"), SessionNavigationRequest("BB", a, "question", "q2"),
            SessionNavigationRequest("Aa", b, "question", "q1"))
        val publisher = AgentoCFirebaseMessagingService.Publisher(context)
        fun publish(r: SessionNavigationRequest) = publisher.publish(mapOf("notificationContractVersion" to "1", "instanceId" to r.targetInstanceId!!,
            "sessionId" to r.sessionId, "kind" to r.kind, "awaitingKey" to r.awaitingKey), "Synthetic QA", "Synthetic notification")
        val completion = requests[0].copy(kind = "completion", awaitingKey = "")
        val ownedTags = (requests + completion).map(SessionNavigationRequest::identity).toSet()
        fun awaitPostedTags(expected: Set<String>) {
            // NotificationManager's cancel/notify calls enqueue work in system_server.
            // Observe the actual system state before asserting its final membership.
            val started = SystemClock.elapsedRealtime()
            var actual: Set<String>
            do {
                actual = manager.activeNotifications.mapNotNull { it.tag }.filter { it in ownedTags }.toSet()
                if (actual == expected) break
                SystemClock.sleep(25)
            } while (SystemClock.elapsedRealtime() - started < 5_000)
            Log.i("SessionNotificationTest", "System notification reconciliation: ${SystemClock.elapsedRealtime() - started} ms")
            assertEquals(expected, actual)
        }
        try {
            requests.forEach(::publish)
            awaitPostedTags(requests.map(SessionNavigationRequest::identity).toSet())
            val posted = manager.activeNotifications.filter { it.tag in requests.map(SessionNavigationRequest::identity) }
            assertEquals(3, posted.size)
            assertEquals(3, posted.map { it.notification.contentIntent }.distinct().size)
            if (android.os.Build.VERSION.SDK_INT >= 31) assertTrue(posted.all { it.notification.contentIntent.isImmutable })
            requests.forEach(::publish)
            awaitPostedTags(requests.map(SessionNavigationRequest::identity).toSet())
            assertEquals(3, manager.activeNotifications.count { it.tag in requests.map(SessionNavigationRequest::identity) })
            publish(completion)
            awaitPostedTags(setOf(requests[1].identity(), requests[2].identity(), completion.identity()))
            val tags = manager.activeNotifications.map { it.tag }
            assertFalse(requests[0].identity() in tags)
            assertTrue(requests[1].identity() in tags); assertTrue(requests[2].identity() in tags)
            assertTrue(completion.identity() in tags)
        } finally {
            (requests + completion).forEach { manager.cancel(it.identity(), 1) }
        }
    }

    @Test fun lateApprovalPushCannotRecreateNotificationAfterItsRunEnded() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = context.getSystemService(NotificationManager::class.java)
        assertTrue("Host must grant notifications before instrumentation starts", manager.areNotificationsEnabled())
        val suffix = UUID.randomUUID().toString().take(8)
        val session = "lifecycle-$suffix"
        val target = "target-$suffix"
        val publisher = AgentoCFirebaseMessagingService.Publisher(context)
        fun publish(kind: String, runId: String, eventId: String, sentAt: Long) = publisher.publish(
            mapOf(
                "notificationContractVersion" to "1",
                "instanceId" to target,
                "sessionId" to session,
                "kind" to kind,
                "awaitingKey" to if (kind == "approval") eventId else "",
                "eventId" to eventId,
                "runId" to runId,
            ),
            "Lifecycle QA",
            "Synthetic notification",
            sentAt,
        )
        val approval = SessionNavigationRequest(session, target, "approval", "approval-1", "approval-1")
        val legacyApproval = SessionNavigationRequest(session, target, "approval", "legacy-approval", "legacy-approval")
        val completion = SessionNavigationRequest(session, target, "completion", "", "run-1")
        val nextApproval = SessionNavigationRequest(session, target, "approval", "approval-2", "approval-2")
        val nextCompletion = SessionNavigationRequest(session, target, "completion", "", "run-2")
        val oldApprovalTag = approval.identity()
        val legacyApprovalTag = legacyApproval.identity()
        val completionTag = completion.identity()
        val nextApprovalTag = nextApproval.identity()
        val nextCompletionTag = nextCompletion.identity()
        fun awaitPostedTags(expected: Set<String>) {
            val started = SystemClock.elapsedRealtime()
            var actual: Set<String>
            do {
                actual = manager.activeNotifications.mapNotNull { it.tag }
                    .filter { it in setOf(oldApprovalTag, legacyApprovalTag, completionTag, nextApprovalTag, nextCompletionTag) }.toSet()
                if (actual == expected) break
                SystemClock.sleep(25)
            } while (SystemClock.elapsedRealtime() - started < 5_000)
            assertEquals(expected, actual)
        }
        try {
            publish("approval", "run-1", "approval-1", 1_000L)
            awaitPostedTags(setOf(oldApprovalTag))
            publish("completion", "run-1", "run-1", 2_000L)
            awaitPostedTags(setOf(completionTag))

            // Even with a newer FCM delivery timestamp, this approval belongs
            // to a run already fenced as terminal.
            publish("approval", "run-1", "approval-1", 3_000L)
            awaitPostedTags(setOf(completionTag))

            // Older approval messages may not carry a run id. The run-level
            // timestamp fence rejects those sent before its terminal push.
            publisher.publish(
                mapOf(
                    "notificationContractVersion" to "1",
                    "instanceId" to target,
                    "sessionId" to session,
                    "kind" to "approval",
                    "awaitingKey" to "legacy-approval",
                    "eventId" to "legacy-approval",
                ),
                "Lifecycle QA",
                "Synthetic notification",
                1_500L,
            )
            awaitPostedTags(setOf(completionTag))

            // A different run remains actionable even if its push was sent
            // before the old run's completion reached this device.
            publish("approval", "run-2", "approval-2", 1_500L)
            awaitPostedTags(setOf(completionTag, nextApprovalTag))

            publish("completion", "run-2", "run-2", 4_000L)
            awaitPostedTags(setOf(completionTag, nextCompletionTag))

            // A delayed terminal push for the old run must not remove or
            // replace the newer run's completion notification.
            publish("completion", "run-1", "run-1", 1_500L)
            awaitPostedTags(setOf(completionTag, nextCompletionTag))
        } finally {
            listOf(oldApprovalTag, legacyApprovalTag, completionTag, nextApprovalTag, nextCompletionTag).forEach { manager.cancel(it, 1) }
        }
    }

    @Test fun resolvedApprovalCleanupCanTargetOneEventWithoutClearingOtherRunsOrSources() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = context.getSystemService(NotificationManager::class.java)
        assertTrue("Host must grant notifications before instrumentation starts", manager.areNotificationsEnabled())
        val suffix = UUID.randomUUID().toString().take(8)
        val session = "event-cleanup-$suffix"
        val targetA = "target-a-$suffix"
        val targetB = "target-b-$suffix"
        val publisher = AgentoCFirebaseMessagingService.Publisher(context)
        fun publish(target: String, eventId: String, runId: String) = publisher.publish(
            mapOf(
                "notificationContractVersion" to "1",
                "instanceId" to target,
                "sessionId" to session,
                "kind" to "approval",
                "awaitingKey" to eventId,
                "eventId" to eventId,
                "runId" to runId,
            ),
            "Cleanup QA",
            "Synthetic notification",
        )
        val stale = SessionNavigationRequest(session, targetA, "approval", "approval-stale", "approval-stale").identity()
        val sameRun = SessionNavigationRequest(session, targetA, "approval", "approval-other", "approval-other").identity()
        val otherSource = SessionNavigationRequest(session, targetB, "approval", "approval-stale", "approval-stale").identity()
        fun awaitTags(expected: Set<String>) {
            val started = SystemClock.elapsedRealtime()
            var actual: Set<String>
            do {
                actual = manager.activeNotifications.mapNotNull { it.tag }
                    .filter { it in setOf(stale, sameRun, otherSource) }.toSet()
                if (actual == expected) break
                SystemClock.sleep(25)
            } while (SystemClock.elapsedRealtime() - started < 5_000)
            assertEquals(expected, actual)
        }
        try {
            publish(targetA, "approval-stale", "run-1")
            publish(targetA, "approval-other", "run-1")
            publish(targetB, "approval-stale", "run-1")
            awaitTags(setOf(stale, sameRun, otherSource))

            AgentoCFirebaseMessagingService.Publisher(context).cancelAttentionNotifications(
                context,
                targetA,
                session,
                eventId = "approval-stale",
            )

            awaitTags(setOf(sameRun, otherSource))
        } finally {
            listOf(stale, sameRun, otherSource).forEach { manager.cancel(it, 1) }
        }
    }

    @Test fun sessionTerminalPushFencesLegacyApprovalButAllowsANewerRun() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = context.getSystemService(NotificationManager::class.java)
        assertTrue("Host must grant notifications before instrumentation starts", manager.areNotificationsEnabled())
        val suffix = UUID.randomUUID().toString().take(8)
        val session = "session-fence-$suffix"
        val target = "target-$suffix"
        val publisher = AgentoCFirebaseMessagingService.Publisher(context)
        fun publish(kind: String, awaitingKey: String, eventId: String, runId: String, sentAt: Long) = publisher.publish(
            mapOf(
                "notificationContractVersion" to "1",
                "instanceId" to target,
                "sessionId" to session,
                "kind" to kind,
                "awaitingKey" to awaitingKey,
                "eventId" to eventId,
                "runId" to runId,
            ),
            "Session fence QA",
            "Synthetic notification",
            sentAt,
        )
        val oldApproval = SessionNavigationRequest(session, target, "approval", "legacy-approval", "legacy-approval").identity()
        val completion = SessionNavigationRequest(session, target, "completion", "", "session-end").identity()
        val newApproval = SessionNavigationRequest(session, target, "approval", "new-approval", "new-approval").identity()
        fun awaitTags(expected: Set<String>) {
            val started = SystemClock.elapsedRealtime()
            var actual: Set<String>
            do {
                actual = manager.activeNotifications.mapNotNull { it.tag }
                    .filter { it in setOf(oldApproval, completion, newApproval) }.toSet()
                if (actual == expected) break
                SystemClock.sleep(25)
            } while (SystemClock.elapsedRealtime() - started < 5_000)
            assertEquals(expected, actual)
        }
        try {
            publish("approval", "legacy-approval", "legacy-approval", "", 1_000L)
            awaitTags(setOf(oldApproval))
            publish("completion", "", "session-end", "", 2_000L)
            awaitTags(setOf(completion))

            publish("approval", "legacy-approval", "legacy-approval", "", 1_500L)
            awaitTags(setOf(completion))

            publish("approval", "new-approval", "new-approval", "run-2", 3_000L)
            awaitTags(setOf(completion, newApproval))
        } finally {
            listOf(oldApproval, completion, newApproval).forEach { manager.cancel(it, 1) }
        }
    }
}
