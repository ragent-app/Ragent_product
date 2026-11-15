package com.andysagent.ragent

import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Opt-in live product flow on the owned phone and already authenticated reviewer. */
class HonorLiveQueueAcceptanceTest {
    @get:Rule val rule = createEmptyComposeRule()
    @Test fun realReviewerQueuesASecondMessageAndRetainsBothCompletedReplies() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveHonorQueue") == "ADNQ6R5716008635")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val graph = app.runtime
        val credential = runBlocking { withTimeout(15_000) { graph.ensureAccountSession() } }
        check(credential.accountId.matches(Regex("^acct_demo_[a-f0-9]{48}$")))
        instrumentation.runOnMainSync { app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        rule.waitUntil(45_000) {
            rule.onAllNodesWithTag("demo-connection-gate").fetchSemanticsNodes().isEmpty() &&
                rule.onAllNodesWithText("review-samples").fetchSemanticsNodes().isNotEmpty()
        }
        InstrumentationRegistry.getArguments().getString("reviewInstanceId")?.let { expected ->
            check(runBlocking { graph.configStore.directory.first().activeTargetId } == expected) { "Unexpected active instance" }
        }
        val newChat = app.getString(com.andysagent.ragent.core.navigation.R.string.navigation_new_session)
        repeat(2) {
            if (rule.onAllNodesWithContentDescription(newChat).fetchSemanticsNodes().isEmpty()) {
                rule.onAllNodesWithText("review-samples").onFirst().performClick()
                rule.waitForIdle()
            }
        }
        val before = runBlocking { graph.sessions.observeSessions().first().map { it.id }.toSet() }
        rule.onNodeWithContentDescription(newChat).performClick()
        rule.waitUntil(30_000) { rule.onAllNodesWithTag("inline-composer-editor").fetchSemanticsNodes().isNotEmpty() }
        var sessionId: String? = null
        rule.waitUntil(15_000) {
            sessionId = runBlocking { graph.sessions.observeSessions().first().firstOrNull { it.id !in before }?.id }
            sessionId != null
        }
        val ownedSession = requireNotNull(sessionId)
        instrumentation.sendStatus(2, Bundle().apply { putString("ownedQueueSession", ownedSession) })
        val firstPrompt = "Count from 1 to 1000. One number per line. Do not use tools."
        val secondPrompt = "After the previous response reply exactly QUEUE_CHECK_COMPLETE. Do not use tools."
        rule.waitUntil(30_000) { rule.onAllNodes(hasTestTag("inline-composer-editor") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("inline-composer-editor").performTextInput(firstPrompt)
        val traceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val traceLengths = java.util.concurrent.ConcurrentSkipListSet<Int>()
        val traceTimings = java.util.concurrent.ConcurrentLinkedQueue<String>()
        val traceStart = android.os.SystemClock.elapsedRealtime()
        val trace = traceScope.launch {
            graph.sessions.observeTimeline(ownedSession).collect { items ->
                items.filterIsInstance<com.andysagent.ragent.core.timeline.TimelineItem.Message>()
                    .filter { it.role == com.andysagent.ragent.core.timeline.TimelineRole.Agent && !it.completed }
                    .forEach { item ->
                        val freshLength = traceLengths.add(item.text.length)
                        if (freshLength) traceTimings.add("${android.os.SystemClock.elapsedRealtime() - traceStart}:${item.text.length}")
                        if (freshLength && traceLengths.size <= 4) {
                            instrumentation.sendStatus(2, Bundle().apply { putString("liveProjectionLength", item.text.length.toString()) })
                            // Keep screenshots out of the timing collector.
                        }
                    }
            }
        }
        try {
        rule.onNodeWithTag("composer-send-action").performClick()
        val stop = app.getString(com.andysagent.ragent.core.agentui.R.string.agentui_stop_generating)
        rule.waitUntil(15_000) { rule.onAllNodesWithContentDescription(stop).fetchSemanticsNodes().isNotEmpty() }
        val visibleStreamingLengths = linkedSetOf<Int>()
        rule.waitUntil(30_000) {
            val rows = runBlocking { graph.sessions.observeMessages(ownedSession).first() }
            val timeline = runBlocking { graph.sessions.observeTimeline(ownedSession).first() }
            val stillStreaming = timeline.filterIsInstance<com.andysagent.ragent.core.timeline.TimelineItem.Message>()
                .any { it.role == com.andysagent.ragent.core.timeline.TimelineRole.Agent && !it.completed }
            if (stillStreaming) {
                rule.onAllNodes(hasText("1", substring = true), useUnmergedTree = true)
                    .fetchSemanticsNodes().forEach { node ->
                        val text = node.config.getOrNull(SemanticsProperties.Text)?.joinToString("\n") { it.text }.orEmpty()
                        if (text.trimStart().startsWith("1\n2")) visibleStreamingLengths.add(text.length)
                    }
            }
            visibleStreamingLengths.size >= 2 || rows.any { it.role == "assistant" && it.completed }
        }
        instrumentation.sendStatus(2, Bundle().apply {
            putString("streamingVisibleLengths", visibleStreamingLengths.joinToString(","))
        })
        assertTrue("Expected two growing visible assistant snapshots before completion", visibleStreamingLengths.size >= 2)
        if (InstrumentationRegistry.getArguments().getString("streamOnly") == "1") {
            val messages = runBlocking { withTimeout(90_000) {
                graph.sessions.observeMessages(ownedSession).first { rows -> rows.any { it.role == "assistant" && it.completed } }
            } }
            assertEquals(1, messages.count { it.role == "user" })
            assertTrue(messages.any { it.role == "assistant" && it.completed && it.content.contains("1000") })
            screenshot(app, "stream-only-completed.png")
            instrumentation.sendStatus(2, Bundle().apply { putString("streamOnlyResult", "real-run-completed-with-growing-visible-text") })
            return
        }
        rule.onNodeWithTag("inline-composer-editor").performTextInput(secondPrompt)
        rule.onNodeWithTag("composer-send-action").performClick()
        rule.waitUntil(10_000) {
            rule.onAllNodesWithTag("queue-island-pill").fetchSemanticsNodes().isNotEmpty() ||
                rule.onAllNodesWithTag("composer-queue-rail").fetchSemanticsNodes().isNotEmpty()
        }
        screenshot(app, "queued.png")
        instrumentation.sendStatus(2, Bundle().apply { putString("queueUi", "visible-during-first-run") })
        try {


            val messages = runBlocking { withTimeout(90_000) {
                graph.sessions.observeMessages(ownedSession).first { rows ->
                    rows.any { it.role == "assistant" && it.content.contains("QUEUE_CHECK_COMPLETE") && it.completed }
                }
            } }
            assertEquals(2, messages.count { it.role == "user" })
            val replies = messages.filter { it.role == "assistant" }
            assertTrue(replies.size >= 2)
            assertTrue(replies.all { it.completed })
            assertEquals(2, messages.filter { it.role == "user" }.mapNotNull { it.runId }.distinct().size)
            screenshot(app, "before-scroll-completed.png")
            rule.onNodeWithTag("chat-timeline").performScrollToNode(hasText("QUEUE_CHECK_COMPLETE", substring = true))
            rule.onAllNodesWithText("QUEUE_CHECK_COMPLETE", substring = true).onFirst().assertIsDisplayed()
            screenshot(app, "queue-completed.png")
            instrumentation.sendStatus(2, Bundle().apply { putString("queueResult", "two-user-turns-and-completed-durable-replies") })
        } finally {
            screenshot(app, "queue-final-state.png")
            File(app.cacheDir, "honor-live-queue/semantics.txt").writeText(rule.onRoot(useUnmergedTree = true).printToString())
            val rows = runBlocking { graph.sessions.observeMessages(ownedSession).first() }
            instrumentation.sendStatus(2, Bundle().apply { putString("durableMessageStates", rows.joinToString(";") {
                "${it.role}:${it.completed}:${it.messageState}:${it.seq}:${it.lastEventSeq}:${it.content.length}"
            }) })
        }
        } finally {
            trace.cancel(); traceScope.cancel()
            instrumentation.sendStatus(2, Bundle().apply { putString("liveProjectionLengths", traceLengths.joinToString(",")); putString("liveProjectionTimingsMsAndLength", traceTimings.joinToString(",")) })
        }
    }
    private fun screenshot(app: RagentApplication, name: String) {
        val root = File(app.cacheDir, "honor-live-queue").apply { mkdirs() }
        File(root, name).outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
