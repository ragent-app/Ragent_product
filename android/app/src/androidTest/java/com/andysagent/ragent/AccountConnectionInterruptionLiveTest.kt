package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The QA orchestrator interrupts the real network or installed PC after ready. */
@RunWith(AndroidJUnit4::class)
class AccountConnectionInterruptionLiveTest {
    @Test fun recoversOriginalPrimaryAfterExternalInterruption(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("liveConnectionInterruption") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val primary = requireNotNull(app.runtime.configStore.directory.first().activeTarget).instanceId
            val account = app.runtime.ensureAccountSession().accountId
            withTimeout(150_000) { app.runtime.transport.connectionState.first { state -> state == RuntimeConnectionState.Connected } }
            assertEquals(200, app.runtime.transport.execute(ApiRequest("GET", "/api/auth/me")).statusCode)
            val started = SystemClock.elapsedRealtime()
            instrumentation.sendStatus(1, Bundle().apply { putString("interruptionReady", "connected-and-authenticated") })
            withTimeout(90_000) { app.runtime.transport.connectionState.first { state -> state != RuntimeConnectionState.Connected } }
            val disconnected = SystemClock.elapsedRealtime()
            withTimeout(180_000) { app.runtime.transport.connectionState.first { state -> state == RuntimeConnectionState.Connected } }
            assertEquals(200, app.runtime.transport.execute(ApiRequest("GET", "/api/auth/me")).statusCode)
            assertEquals(200, app.runtime.transport.execute(ApiRequest("GET", "/api/projects")).statusCode)
            assertEquals(primary, app.runtime.configStore.directory.first().activeTarget?.instanceId)
            assertEquals(account, app.runtime.ensureAccountSession().accountId)
            instrumentation.sendStatus(1, Bundle().apply {
                putString("interruptionRecovered", args.getString("interruptionKind") ?: "external")
                putLong("interruptionDetectedMs", disconnected - started)
                putLong("recoveryAndProtectedReadMs", SystemClock.elapsedRealtime() - disconnected)
            })
        }
    }
}
