package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/** Opt-in real two-computer test. Separate phases permit a real process kill between them. */
class AccountMultiTargetLiveTest {
    private fun fingerprint(value: String) = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

    @Test fun retireLegacyReviewerFromAccount(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("retireLegacyReviewer") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use { scenario ->
            scenario.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            val runtime = app.runtime
            val computers = runtime.listAccountDirectoryDevices().filter { it.deviceKind.equals("computer", true) && it.unboundAt.isNullOrBlank() }
            val legacy = computers.single { it.alias == "Ragent Demo · Codex Luna" }
            check(computers.any { it.alias == "Ragent Review Full" })
            check(computers.any { it.alias == "Ragent Review Full 2" })
            check(runtime.configStore.directory.first().activeTarget?.instanceId != legacy.instanceId)
            assertTrue(runtime.revokeAccountDevice(legacy.instanceId))
            assertFalse(runtime.listAccountDirectoryDevices().any { it.instanceId == legacy.instanceId && it.unboundAt.isNullOrBlank() })
            assertFalse(runtime.configStore.directory.first().computers.any { it.instanceId == legacy.instanceId })
        }
    }

    @Test fun switchBetweenFullReviewers(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveDualFullSwitch") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use { scenario ->
            scenario.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            val runtime = app.runtime
            val directory = runtime.configStore.directory.first()
            val original = requireNotNull(directory.activeTarget).instanceId
            val targets = listOf("Ragent Review Full", "Ragent Review Full 2").map { name ->
                directory.computers.single { it.label == name }.instanceId
            }
            require(original in targets)
            withTimeout(150_000) { runtime.targetConnectionStates.first { s -> targets.all { s[it] == RuntimeConnectionState.Connected } } }
            var dropped = false
            val states = mutableListOf<String>()
            val observer = launch(start = CoroutineStart.UNDISPATCHED) {
                runtime.targetConnectionStates.collect { s ->
                    states.add(targets.joinToString(":") { s[it]?.name ?: "absent" })
                    if (targets.any { s[it] != RuntimeConnectionState.Connected }) dropped = true
                }
            }
            try {
                for (target in listOf(targets.first { it != original }, original)) {
                    runtime.selectTarget(target)
                    runtime.awaitLifecycleUpdate()
                    assertEquals(target, runtime.configStore.directory.first().activeTarget?.instanceId)
                    for (id in targets) assertEquals(200, runtime.executeOnTarget(id, ApiRequest("GET", "/api/projects")).statusCode)
                }
                instrumentation.sendStatus(2, Bundle().apply { putBoolean("carrierDroppedDuringSwitch", dropped); putString("states", states.joinToString(",")) })
                assertFalse("A carrier disconnected during target switching", dropped)
            } finally {
                observer.cancel()
                runtime.selectTarget(original)
                runtime.awaitLifecycleUpdate()
            }
        }
    }

    @Test fun reconnectExistingBackgroundWithoutDroppingPrimary(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveMultiTargetConnectTransition") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use { scenario ->
            scenario.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            val runtime = app.runtime
            val before = runtime.configStore.directory.first()
            val primary = requireNotNull(before.activeTarget).instanceId
            val background = before.computers.single { it.instanceId != primary && it.label == "Ragent Demo · Codex Luna" }
            check(background.autoConnect) { "Probe only operates on a previously connected background" }
            try {
                instrumentation.sendStatus(2, Bundle().apply { putString("transitionPhase", "awaiting-baseline") })
                withTimeout(150_000) { runtime.targetConnectionStates.onEach { states ->
                    instrumentation.sendStatus(2, Bundle().apply {
                        putString("transitionBaseline", "${states[primary]?.name}:${states[background.instanceId]?.name}")
                    })
                }.first { states ->
                    states[primary] == RuntimeConnectionState.Connected && states[background.instanceId] == RuntimeConnectionState.Connected
                } }
            } catch (error: Throwable) {
                instrumentation.sendStatus(2, Bundle().apply { putString("transitionFailurePhase", "baseline") })
                throw error
            }
            val started = SystemClock.elapsedRealtime()
            var primaryDropped = false
            val transitions = mutableListOf<String>()
            val observer = launch(start = CoroutineStart.UNDISPATCHED) {
                runtime.targetConnectionStates.collect { states ->
                    val p = states[primary]; val b = states[background.instanceId]
                    transitions.add("${SystemClock.elapsedRealtime()-started}:${p?.name}:${b?.name}")
                    if (p != RuntimeConnectionState.Connected) primaryDropped = true
                }
            }
            try {
                instrumentation.sendStatus(2, Bundle().apply { putString("transitionPhase", "pause-background") })
                runtime.configStore.upsertComputer(background.copy(autoConnect = false), select = false)
                runtime.awaitLifecycleUpdate()
                withTimeout(30_000) { runtime.targetConnectionStates.first { it[background.instanceId] != RuntimeConnectionState.Connected } }
                val connectAt = SystemClock.elapsedRealtime()
                instrumentation.sendStatus(2, Bundle().apply { putString("transitionPhase", "connect-background") })
                runtime.connectAccountComputerInBackground(background.instanceId, runtime.accountDeviceAlias)
                withTimeout(150_000) { runtime.targetConnectionStates.first { it[background.instanceId] == RuntimeConnectionState.Connected } }
                assertEquals(200, runtime.executeOnTarget(primary, ApiRequest("GET", "/api/projects")).statusCode)
                assertEquals(200, runtime.executeOnTarget(background.instanceId, ApiRequest("GET", "/api/projects")).statusCode)
                instrumentation.sendStatus(2, Bundle().apply {
                    putLong("connectSecondMs", SystemClock.elapsedRealtime() - connectAt)
                    putBoolean("primaryDropped", primaryDropped)
                    putString("transitions", transitions.joinToString(","))
                })
                assertFalse("Connecting a background computer interrupted the connected primary", primaryDropped)
            } finally {
                instrumentation.sendStatus(2, Bundle().apply { putString("transitionsAtFinish", transitions.joinToString(",")) })
                observer.cancel()
                val current = runtime.configStore.directory.first().computers.single { it.instanceId == background.instanceId }
                runtime.configStore.upsertComputer(current.copy(autoConnect = background.autoConnect), select = false)
                runtime.awaitLifecycleUpdate()
            }
        }
    }

    @Test fun runsRequestedPhase(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        assumeTrue(arguments.getString("liveMultiTargetProbe") == "true")
        val phase = requireNotNull(arguments.getString("multiTargetPhase"))
        require(phase in setOf("prepare", "restore", "cleanup"))
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val journalFile = File(app.noBackupFilesDir, "qa-account-multi-target-20261025.json")
        val started = SystemClock.elapsedRealtime()
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val account = runtime.ensureAccountSession()
            val directory = withTimeout(30_000) { runtime.configStore.directory.first { it.activeTarget != null } }
            val primary = requireNotNull(directory.activeTarget)
            val journal: JSONObject
            if (phase == "prepare") {
                check(!journalFile.exists()) { "Finish or clean up the prior multi-target QA first" }
                val alias = requireNotNull(arguments.getString("backgroundComputerAlias"))
                val target = runtime.listAccountDirectoryDevices().single { device ->
                    device.alias == alias && device.deviceKind.equals("computer", true) && device.unboundAt.isNullOrBlank()
                }
                require(target.instanceId != primary.instanceId)
                val previous = directory.computers.firstOrNull { it.instanceId == target.instanceId }
                journal = JSONObject().put("primaryId", primary.instanceId).put("backgroundId", target.instanceId)
                    .put("accountFingerprint", fingerprint(account.accountId))
                    .put("backgroundWasLinked", previous != null)
                    .put("backgroundAutoConnect", previous?.autoConnect ?: false)
                    .put("createdAt", System.currentTimeMillis())
                journalFile.writeText(journal.toString())
                withTimeout(150_000) { runtime.connectAccountComputerInBackground(target.instanceId, runtime.accountDeviceAlias) }
            } else {
                check(journalFile.isFile) { "No owned multi-target QA journal exists" }
                journal = JSONObject(journalFile.readText())
            }
            assertEquals(fingerprint(account.accountId), journal.getString("accountFingerprint"))
            val primaryId = journal.getString("primaryId")
            val backgroundId = journal.getString("backgroundId")
            assertEquals(primaryId, runtime.configStore.directory.first().activeTarget?.instanceId)
            if (phase == "cleanup") {
                if (!journal.getBoolean("backgroundWasLinked")) runtime.disconnectTarget(backgroundId)
                else {
                    val current = runtime.configStore.directory.first().computers.single { computer -> computer.instanceId == backgroundId }
                    runtime.configStore.upsertComputer(current.copy(autoConnect = journal.getBoolean("backgroundAutoConnect")), select = false)
                    runtime.awaitLifecycleUpdate()
                }
                assertEquals(primaryId, runtime.configStore.directory.first().activeTarget?.instanceId)
                assertEquals(journal.getBoolean("backgroundWasLinked"), runtime.configStore.directory.first().computers.any { computer -> computer.instanceId == backgroundId })
                check(journalFile.delete())
            } else {
                assertTrue(runtime.configStore.directory.first().computers.single { computer -> computer.instanceId == backgroundId }.autoConnect)
                // Observe automatic recovery BEFORE taking an explicit API lease;
                // a test-induced connection cannot turn an automatic failure green.
                withTimeout(150_000) { runtime.targetConnectionStates.onEach { states ->
                    instrumentation.sendStatus(1, Bundle().apply {
                        putString("multiTargetPrimaryState", states[primaryId]?.name ?: "absent")
                        putString("multiTargetBackgroundState", states[backgroundId]?.name ?: "absent")
                    })
                }.first { states ->
                    states[primaryId] == RuntimeConnectionState.Connected && states[backgroundId] == RuntimeConnectionState.Connected
                } }
                for (targetId in listOf(primaryId, backgroundId)) {
                    assertEquals(200, runtime.executeOnTarget(targetId, ApiRequest("GET", "/api/auth/me")).statusCode)
                    assertEquals(200, runtime.executeOnTarget(targetId, ApiRequest("GET", "/api/projects")).statusCode)
                }
                assertEquals(primaryId, runtime.configStore.directory.first().activeTarget?.instanceId)
            }
            instrumentation.sendStatus(1, Bundle().apply {
                putString("multiTargetPhase", phase)
                putString("primaryFingerprint", fingerprint(primaryId))
                putString("backgroundFingerprint", fingerprint(backgroundId))
                putLong("elapsedMs", SystemClock.elapsedRealtime() - started)
                putString("result", if (phase == "cleanup") "original-background-role-restored" else "two-automatic-carriers-and-protected-reads")
            })
        }
    }
}
