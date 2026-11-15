package com.andysagent.ragent

import android.os.Bundle
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import com.andysagent.ragent.core.model.RuntimeConnectionState
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Read-only opt-in probe; prints neither account identifiers nor credentials. */
class ReviewTargetStateProbeTest {
    @Test fun reportTargetConnectionSettings() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("reviewTargetStateProbe") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val runtime = app.runtime
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            delay(30_000)
            val directory = runtime.configStore.directory.first()
            val states = runtime.targetConnectionStates.value
            val report = listOf("Ragent Review Full", "Ragent Review Full 2").map { name ->
                val target = directory.computers.singleOrNull { it.label == name }
                if (target == null) "$name:missing" else
                    "$name:auto=${target.autoConnect},active=${directory.activeTarget?.instanceId == target.instanceId},state=${states[target.instanceId]?.name ?: "absent"}"
            }
            instrumentation.sendStatus(2, Bundle().apply { putString("reviewTargets", report.joinToString(";")) })
        }
    }

    /** Deletes only a specified session after confirming its exact test prompt. */
    @Test fun cleanupOwnedStreamSession() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("cleanupOwnedReviewSession") == "true")
        val sessionId = requireNotNull(args.getString("ownedSessionId"))
        require(sessionId.matches(Regex("^[a-f0-9]{32}$")))
        val expectedPrompt = when (args.getString("ownedPrompt")) {
            "tool" -> "List the project files and read README.md using tools. Summarize the results."
            "stream" -> "Count from 1 to 1000. One number per line. Do not use tools."
            else -> error("Unknown owned prompt")
        }
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val runtime = app.runtime
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            withTimeout(90_000) {
                check(runtime.ensureAccountSession().demoAccessMode == "full")
                val directory = runtime.configStore.directory.first()
                val active = requireNotNull(directory.activeTarget)
                check(directory.computers.single { it.instanceId == active.instanceId }.label == "Ragent Review Full")
                runtime.targetConnectionStates.first { it[active.instanceId] == RuntimeConnectionState.Connected }
                runtime.sessions.refreshEvents(sessionId)
                check(runtime.sessions.observeMessages(sessionId).first().any {
                    it.role == "user" && it.content == expectedPrompt
                }) { "Session does not contain the expected owned test prompt" }
                runtime.sessions.deleteSession(sessionId)
                check(runtime.sessions.observeSessions().first().none { it.id == sessionId })
            }
        }
        instrumentation.sendStatus(2, Bundle().apply { putString("ownedReviewCleanup", "deleted-and-refreshed") })
    }
}
