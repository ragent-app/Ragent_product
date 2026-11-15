package com.andysagent.ragent

import android.content.Intent
import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.lifecycle.ViewModelProvider
import com.andysagent.ragent.feature.workbench.ChatViewModel
import com.andysagent.ragent.feature.workbench.AppShellViewModel
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue

/** Real platform clock, real model, real UI; no Compose test frame clock. */
class HonorPlatformStreamingAcceptanceTest {
    @org.junit.After fun retainPlatformState() {
        runCatching {
            val inst = InstrumentationRegistry.getInstrumentation()
            val folder = File(inst.targetContext.cacheDir, "platform-stream").apply { mkdirs() }
            val device = UiDevice.getInstance(inst)
            inst.uiAutomation.takeScreenshot()?.let { bitmap -> File(folder, "navigation-final.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
            device.dumpWindowHierarchy(File(folder, "window.xml"))
        }
    }

    @Test fun realReplyHasProgressivePlatformFrames() {
        val inst = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveHonorPlatformStream") == "ADNQ6R5716008635")
        val app = inst.targetContext.applicationContext as RagentApplication
        val graph = app.runtime
        val device = UiDevice.getInstance(inst)
        fun report(key: String, value: String) = inst.sendStatus(2, Bundle().apply { putString(key, value) })
        assertEquals("full", runBlocking { graph.ensureAccountSession() }.demoAccessMode)
        inst.startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        device.waitForIdle()
        val connectingTitles = listOf(
            com.andysagent.ragent.feature.workbench.R.string.demo_connection_finding,
            com.andysagent.ragent.feature.workbench.R.string.demo_connection_connecting,
            com.andysagent.ragent.feature.workbench.R.string.demo_connection_reconnecting,
        ).map { app.getString(it) }
        val connectionDeadline = android.os.SystemClock.elapsedRealtime()+45_000
        while (connectingTitles.any { device.hasObject(By.text(it)) } && android.os.SystemClock.elapsedRealtime()<connectionDeadline) android.os.SystemClock.sleep(100)
        assertFalse("Connection overlay still visible", connectingTitles.any { device.hasObject(By.text(it)) })
        // A prior native run can restore the chat page. Navigate out through
        // the visible localized Back control instead of clicking its backdrop.
        val backLabels = listOf("en", "zh-CN", "zh-TW", "ko", "ja", "es", "fr").map { language ->
            app.createConfigurationContext(android.content.res.Configuration(app.resources.configuration).apply {
                setLocale(java.util.Locale.forLanguageTag(language))
            }).getString(com.andysagent.ragent.feature.workbench.R.string.project_back)
        }.distinct()
        repeat(3) {
            val back = backLabels.firstNotNullOfOrNull { label -> device.findObject(By.desc(label)) }
            if (back != null && back.visibleBounds.centerY() < device.displayHeight / 4) {
                back.click(); device.waitForIdle()
            }
        }
        val newChatLabels = listOf("en", "zh-CN", "zh-TW", "ko", "ja", "es", "fr").map { language ->
            app.createConfigurationContext(android.content.res.Configuration(app.resources.configuration).apply {
                setLocale(java.util.Locale.forLanguageTag(language))
            }).getString(com.andysagent.ragent.core.navigation.R.string.navigation_new_session)
        }.distinct()
        fun findNewChat() = newChatLabels.firstNotNullOfOrNull { device.findObject(By.desc(it)) }
        if (findNewChat() == null) {
            val projectLabels = listOf("en", "zh-CN", "zh-TW", "ko", "ja", "es", "fr").map { language ->
                app.createConfigurationContext(android.content.res.Configuration(app.resources.configuration).apply {
                    setLocale(java.util.Locale.forLanguageTag(language))
                }).getString(com.andysagent.ragent.feature.workbench.R.string.projects_open_project, "review-samples")
            }.distinct()
            val projectDeadline = android.os.SystemClock.elapsedRealtime() + 45_000
            var project = projectLabels.firstNotNullOfOrNull { device.findObject(By.desc(it)) }
            if (project == null) {
                val chatLabels = listOf("en", "zh-CN", "zh-TW", "ko", "ja", "es", "fr").map { language ->
                    app.createConfigurationContext(android.content.res.Configuration(app.resources.configuration).apply {
                        setLocale(java.util.Locale.forLanguageTag(language))
                    }).getString(com.andysagent.ragent.core.navigation.R.string.navigation_chat)
                }.distinct()
                chatLabels.firstNotNullOfOrNull { device.findObject(By.desc(it)) }?.click()
            }
            while (project == null && android.os.SystemClock.elapsedRealtime() < projectDeadline) {
                android.os.SystemClock.sleep(100)
                project = projectLabels.firstNotNullOfOrNull { device.findObject(By.desc(it)) }
            }
            (project ?: error("Project navigation row not visible")).click()
            device.waitForIdle()
            // A home shortcut can first show the project overview. Only open
            // the row again if the shell confirms the project is not already
            // open; a second click during the transition can close it.
            var projectOpen = false
            val shellDeadline = android.os.SystemClock.elapsedRealtime() + 3_000
            while (!projectOpen && findNewChat() == null && android.os.SystemClock.elapsedRealtime() < shellDeadline) {
                inst.runOnMainSync {
                    val activity = ActivityLifecycleMonitorRegistry.getInstance()
                        .getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().single()
                    val shell = ViewModelProvider(activity)[AppShellViewModel::class.java].state.value
                    projectOpen = shell.destination == com.andysagent.ragent.core.navigation.AgentoDestination.Sessions &&
                        shell.projectSessionsOpen && shell.browsingProjectId != null
                }
                if (!projectOpen) android.os.SystemClock.sleep(100)
            }
            if (!projectOpen && findNewChat() == null) {
                projectLabels.firstNotNullOfOrNull { device.findObject(By.desc(it)) }?.click()
                device.waitForIdle()
            }
            val deadline = android.os.SystemClock.elapsedRealtime() + 20_000
            while (findNewChat() == null && android.os.SystemClock.elapsedRealtime() < deadline) android.os.SystemClock.sleep(100)
        }
        inst.runOnMainSync {
            val activity = ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().single()
            val shell = ViewModelProvider(activity)[AppShellViewModel::class.java].state.value
            report("navigationState", "destination=${shell.destination}, projectOpen=${shell.projectSessionsOpen}, projectIdPresent=${shell.browsingProjectId != null}, chatOpen=${shell.chatOpen}")
        }
        // Establish an authoritative baseline before creating the owned session;
        // a stale Room list can otherwise misidentify a prior session as new.
        runBlocking {
            withTimeout(45_000) {
                while (true) {
                    try { graph.sessions.refreshSessions(); break }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { delay(500) }
                }
            }
        }
        val owningTarget = requireNotNull(runBlocking { graph.configStore.directory.first().activeTargetId })
        val before = runBlocking { graph.sessions.observeSessions().first().map { it.id }.toSet() }
        (findNewChat() ?: error("New chat missing after project navigation")).click()
        // Read the selected UI session, not the first new repository row: another
        // phone can create a session concurrently on this same account.
        var chat: ChatViewModel? = null
        inst.runOnMainSync {
            val activity = ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().single()
            chat = ViewModelProvider(activity)[ChatViewModel::class.java]
        }
        val sid = runBlocking { withTimeout(30_000) {
            requireNotNull(chat).state.first { state -> state.sessionId != null && state.sessionId !in before }.sessionId!!
        } }
        require(sid.matches(Regex("[0-9a-f]{32}")))
        report("ownedPlatformStreamSession", sid)
        try {
        // A repository row may arrive before navigation renders the new chat.
        // Do not type into the previous conversation while that transition is pending.
        val suggestions = listOf("en", "zh-CN", "zh-TW", "ko", "ja", "es", "fr").map { language ->
            app.createConfigurationContext(android.content.res.Configuration(app.resources.configuration).apply {
                setLocale(java.util.Locale.forLanguageTag(language))
            }).getString(com.andysagent.ragent.feature.workbench.R.string.workbench_suggestion_organize_project)
        }.distinct()
        val readyDeadline = android.os.SystemClock.elapsedRealtime() + 20_000
        while (suggestions.none { device.hasObject(By.text(it)) } && android.os.SystemClock.elapsedRealtime() < readyDeadline) android.os.SystemClock.sleep(50)
        val uiState = requireNotNull(chat).state.value
        report("selectedSessionState", "id=${uiState.sessionId}, timelineId=${uiState.timelineSessionId}, historyLoading=${uiState.historyLoading}, items=${uiState.timelineItems.size}, status=${uiState.runStatus}, error=${uiState.error != null}")
        assertEquals("Selected session changed before entering the chat", sid, uiState.sessionId)
        assertTrue("New empty chat did not become visible", suggestions.any { device.hasObject(By.text(it)) })
        device.waitForIdle()
        fun controlBounds(composer: Boolean): Rect {
            fun walk(node: AccessibilityNodeInfo?): Rect? {
                if (node == null) return null
                val bounds = Rect();node.getBoundsInScreen(bounds)
                val inApp = node.packageName?.toString() == app.packageName
                val described = !node.contentDescription.isNullOrBlank()
                val matches = if (composer) bounds.centerY() > device.displayHeight * 0.7 && bounds.width() > device.displayWidth * 0.3
                    else bounds.centerY() > device.displayHeight * 0.45 && bounds.centerX() > device.displayWidth * 0.75
                if (inApp && described && node.isEnabled && matches && (!composer || node.isClickable)) return bounds
                for (index in 0 until node.childCount) walk(node.getChild(index))?.let { return it }
                return null
            }
            val deadline = android.os.SystemClock.elapsedRealtime()+20_000
            while (android.os.SystemClock.elapsedRealtime()<deadline) {
                walk(inst.uiAutomation.rootInActiveWindow)?.let { return it }
                android.os.SystemClock.sleep(50)
            }
            error("Native chat control not available")
        }
        // The owned phone's app-local locale may differ from Application resources.
        // Locate its described bottom controls from their actual native bounds.
        val composerBounds = controlBounds(composer = true)
        device.executeShellCommand("input tap ${composerBounds.centerX()} ${composerBounds.centerY()}")
        val inputMethod = app.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
        val inputDeadline = android.os.SystemClock.elapsedRealtime()+10_000
        while (!inputMethod.isAcceptingText && android.os.SystemClock.elapsedRealtime()<inputDeadline) android.os.SystemClock.sleep(50)
        assertTrue("Canvas InputConnection did not become active", inputMethod.isAcceptingText)
        val toolProbe = InstrumentationRegistry.getArguments().getString("toolProbe") == "1"
        val prompt = if (toolProbe) "List the project files and read README.md using tools. Summarize the results."
            else "Count from 1 to 1000. One number per line. Do not use tools."
        // The canvas editor uses an InputConnection, not an Android EditText.
        require(prompt.matches(Regex("^[A-Za-z0-9 ._]+$")))
        // Clear a restored draft through the native focused editor before typing.
        device.executeShellCommand("input keycombination 113 29")
        device.executeShellCommand("input keyevent 67")
        device.executeShellCommand("input text ${prompt.replace(" ", "%s")}")
        assertTrue("Composer text did not persist", device.wait(Until.hasObject(By.text(prompt)), 5_000))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val incoming = ConcurrentLinkedQueue<String>()
        val operations = ConcurrentLinkedQueue<String>()
        val operationKeys = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
        val activityKinds = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
        val started = android.os.SystemClock.elapsedRealtime()
        var lastIncoming = -1
        val trace = scope.launch {
            graph.sessions.observeTimeline(sid).collect { items ->
                items.filterIsInstance<TimelineItem.Operation>().forEach { operation ->
                    val key = "${operation.id}:${operation.status}"
                    if (operationKeys.add(key)) operations.add("${operation.status}:${operation.title.take(120)}")
                }
                val length = items.filterIsInstance<TimelineItem.Message>().filter { it.role == TimelineRole.Agent && !it.completed }.maxOfOrNull { it.text.length }
                if (length != null && length != lastIncoming) {
                    lastIncoming = length
                    incoming.add("${android.os.SystemClock.elapsedRealtime()-started}:$length")
                }
            }
        }
        val activityTrace = scope.launch {
            graph.sessions.observeRunActivity(sid).collect { activity ->
                val kind = ((activity?.get("labelKind") ?: activity?.get("kind")) as? kotlinx.serialization.json.JsonPrimitive)?.content
                if (kind != null) activityKinds.add(kind)
            }
        }
        val visible = linkedMapOf<String, Long>()
        fun visit(node: AccessibilityNodeInfo?) {
            if (node == null) return
            val text = node.text?.toString().orEmpty()
            // Tail-follow can virtualize the paragraph starting at 1. Accept
            // any numeric-only reply node, never the prompt or toolbar labels.
            if (Regex("^[0-9]+(?:\\s+[0-9]+){2,}\\s*$").matches(text.trim())) {
                val tail = Regex("[0-9]+").findAll(text).last().value
                visible.putIfAbsent("${text.length}:$tail", android.os.SystemClock.elapsedRealtime()-started)
            }
            for (index in 0 until node.childCount) visit(node.getChild(index))
        }
        var completed = false
        var toolFrameCaptured = false
        try {
            val sendBounds = controlBounds(composer = false)
            device.executeShellCommand("input tap ${sendBounds.centerX()} ${sendBounds.centerY()}")
            runBlocking { withTimeout(20_000) {
                graph.sessions.observeMessages(sid).first { rows -> rows.any { it.role == "user" && it.content == prompt } }
            } }
            val deadline = android.os.SystemClock.elapsedRealtime()+100_000
            while (android.os.SystemClock.elapsedRealtime()<deadline) {
                visit(inst.uiAutomation.rootInActiveWindow)
                val rows = runBlocking { graph.sessions.observeMessages(sid).first() }
                val status = runBlocking { graph.sessions.observeSessions().first().firstOrNull { it.id == sid }?.status }
                val terminal = status != null && status !in setOf(
                    com.andysagent.ragent.core.model.SessionStatus.Working,
                    com.andysagent.ragent.core.model.SessionStatus.WaitingApproval,
                )
                completed = rows.any { it.role == "assistant" && it.completed && (if (toolProbe) it.content.isNotBlank() else it.content.contains("1000")) } &&
                    terminal && (!toolProbe || operations.isNotEmpty())
                if (toolProbe && operations.isNotEmpty() && !toolFrameCaptured) {
                    val folder = File(app.cacheDir, "platform-stream").apply { mkdirs() }
                    device.takeScreenshot(File(folder, "tool-in-progress.png"))
                    toolFrameCaptured = true
                }
                if (completed) break
                android.os.SystemClock.sleep(40)
            }
            assertTrue("Real reply did not finish", completed)
            if (toolProbe) {
                device.findObject(By.descContains(app.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_details_show)))?.click()
                device.waitForIdle()
                val folder = File(app.cacheDir, "platform-stream").apply { mkdirs() }
                inst.uiAutomation.takeScreenshot()?.let { bitmap -> File(folder, "tool-expanded.png").outputStream().use {
                    bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                }; bitmap.recycle() }
                assertTrue("No real tool operation reached the native timeline", operations.isNotEmpty())
                assertTrue("No canonical tool action reached the app", activityKinds.any { it !in setOf("idle", "working", "thinking", "responding") })
            } else {
                assertTrue("Expected multiple live receiver updates", incoming.size >= 5)
                assertTrue("Expected at least ten real platform render states", visible.size >= 10)
            }
        } finally {
            trace.cancel();activityTrace.cancel();scope.cancel()
            val evidence = File(app.cacheDir,"platform-stream").apply { mkdirs() }
            device.takeScreenshot(File(evidence,"final.png"))
            File(evidence,"timings.txt").writeText("incoming="+incoming.joinToString(",")+"\nvisible="+visible.entries.joinToString(",") { "${it.value}:${it.key}" })
            report("platformIncomingTimings",incoming.joinToString(","))
            report("platformVisibleTimings",visible.entries.joinToString(",") { "${it.value}:${it.key}" })
            report("platformStreamCompleted", completed.toString())
            report("platformOperations", operations.joinToString(" | "))
            report("platformActivityKinds", activityKinds.joinToString(","))
        }
        } finally {
            runBlocking {
                check(graph.configStore.directory.first().activeTargetId == owningTarget) {
                    "Target changed; refusing to delete the test session from another instance"
                }
                withTimeout(30_000) { graph.sessions.deleteSession(sid) }
                check(graph.sessions.observeSessions().first().none { it.id == sid }) {
                    "The test session remains in the refreshed session list"
                }
            }
            report("platformSessionCleanup", "test-session-deleted-and-list-refreshed")
        }
    }

    @Test fun existingToolSessionReloadShowsOperations() = runBlocking {
        val inst = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("liveHonorPlatformStream") == "ADNQ6R5716008635")
        val sid = args.getString("ownedSession").orEmpty()
        require(sid.matches(Regex("[0-9a-f]{32}")))
        val app = inst.targetContext.applicationContext as RagentApplication
        val graph = app.runtime
        assertEquals("full", graph.ensureAccountSession().demoAccessMode)
        inst.startActivitySync(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        var lastReported = ""
        withTimeout(45_000) {
            while (true) {
                try { graph.sessions.refreshTimeline(sid); break }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    val description = "${error.javaClass.simpleName}: ${error.message?.take(300)}"
                    if (description != lastReported) {
                        lastReported = description
                        inst.sendStatus(2, Bundle().apply { putString("timelineReloadFailure", description) })
                    }
                    delay(500)
                }
            }
        }
        val items = withTimeout(5_000) { graph.sessions.observeTimeline(sid).first { rows -> rows.any { it is TimelineItem.Operation } } }
        inst.sendStatus(2, Bundle().apply { putInt("reloadedToolOperations", items.filterIsInstance<TimelineItem.Operation>().size) })
    }
}
