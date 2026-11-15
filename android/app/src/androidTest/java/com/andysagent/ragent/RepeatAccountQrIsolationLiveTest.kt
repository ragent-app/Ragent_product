package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Opt-in live repeat-QR test; it does not exercise camera capture. */
class RepeatAccountQrIsolationLiveTest {
    @Test fun repeatingPrimaryQrKeepsBackgroundConnection(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveRepeatAccountQr") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val staged = File(app.noBackupFilesDir, "qa-repeat-account-qr-20261025.txt")
        check(staged.isFile)
        try {
            ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
                val runtime = app.runtime
                val before = runtime.configStore.directory.first()
                val primary = requireNotNull(before.activeTarget).instanceId
                val background = before.computers.first { it.autoConnect && it.instanceId != primary }.instanceId
                val account = runtime.ensureAccountSession().accountId
                withTimeout(150_000) { runtime.targetConnectionStates.first { states ->
                    states[primary] == RuntimeConnectionState.Connected && states[background] == RuntimeConnectionState.Connected
                } }
                val started = SystemClock.elapsedRealtime()
                val transitions = mutableListOf<String>()
                var backgroundDropped = false
                val observer = launch(start = CoroutineStart.UNDISPATCHED) {
                    runtime.targetConnectionStates.collect { states ->
                        val state = states[background]
                        transitions.add("${SystemClock.elapsedRealtime() - started}:${state?.name ?: "absent"}")
                        if (state != RuntimeConnectionState.Connected) backgroundDropped = true
                    }
                }
                try {
                    val result = withTimeout(150_000) { runtime.pairFromInvitation(staged.readText().trim(), runtime.accountDeviceAlias) }
                    assertEquals(primary, result.instanceId)
                    val after = runtime.configStore.directory.first()
                    assertEquals(primary, after.activeTarget?.instanceId)
                    assertEquals(before.computers.map { it.instanceId to it.autoConnect }, after.computers.map { it.instanceId to it.autoConnect })
                    assertEquals(account, runtime.ensureAccountSession().accountId)
                    withTimeout(150_000) { runtime.targetConnectionStates.first { states ->
                        states[primary] == RuntimeConnectionState.Connected && states[background] == RuntimeConnectionState.Connected
                    } }
                    assertEquals(200, runtime.executeOnTarget(primary, ApiRequest("GET", "/api/projects")).statusCode)
                    assertEquals(200, runtime.executeOnTarget(background, ApiRequest("GET", "/api/projects")).statusCode)
                    assertFalse("The background computer dropped during primary QR pairing", backgroundDropped)
                    instrumentation.sendStatus(1, Bundle().apply { putString("repeatQrIsolation", "both-protected-reads-background-stable") })
                } finally {
                    observer.cancel()
                    instrumentation.sendStatus(1, Bundle().apply {
                        putBoolean("backgroundDropped", backgroundDropped)
                        putString("backgroundTransitions", transitions.take(100).joinToString(","))
                    })
                }
            }
        } finally { assertTrue("Staged invitation must be removed", staged.delete()) }
    }
}
