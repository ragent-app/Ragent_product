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
import java.security.MessageDigest
import java.io.File

/** Opt-in actual account/installed-PC checks. No credential or account id is printed. */
@RunWith(AndroidJUnit4::class)
class AccountConnectionLiveProbeTest {
    @Test fun repeatsAccountQrWithoutChangingThePrimaryOrBackgroundRole(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveRepeatAccountQr") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val staged = File(app.noBackupFilesDir, "qa-repeat-account-qr-20261025.txt")
        check(staged.isFile)
        try {
            ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
                val runtime = app.runtime
                val before = runtime.configStore.directory.first()
                val primary = requireNotNull(before.activeTarget)
                val account = runtime.ensureAccountSession().accountId
                withTimeout(150_000) { runtime.targetConnectionStates.first { states -> states[primary.instanceId] == RuntimeConnectionState.Connected } }
                val result = withTimeout(150_000) { runtime.pairFromInvitation(staged.readText().trim(), runtime.accountDeviceAlias) }
                assertEquals(primary.instanceId, result.instanceId)
                val after = runtime.configStore.directory.first()
                assertEquals(primary.instanceId, after.activeTarget?.instanceId)
                assertEquals(before.computers.map { target -> target.instanceId to target.autoConnect }, after.computers.map { target -> target.instanceId to target.autoConnect })
                assertEquals(account, runtime.ensureAccountSession().accountId)
                withTimeout(150_000) { runtime.targetConnectionStates.first { states -> states[primary.instanceId] == RuntimeConnectionState.Connected } }
                assertEquals(200, runtime.transport.execute(ApiRequest("GET", "/api/auth/me")).statusCode)
                assertEquals(200, runtime.transport.execute(ApiRequest("GET", "/api/projects")).statusCode)
                instrumentation.sendStatus(1, Bundle().apply { putString("repeatAccountQr", "same-account-primary-background-roles-and-protected-reads") })
            }
        } finally { check(staged.delete()) }
    }

    @Test fun restoresPrimaryAndReadsProtectedState(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveConnectionProbe") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val started = SystemClock.elapsedRealtime()
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val directory = app.runtime.configStore.directory.first()
            val selected = requireNotNull(directory.activeTarget)
            withTimeout(150_000) { app.runtime.transport.connectionState.first { state -> state == RuntimeConnectionState.Connected } }
            val auth = app.runtime.transport.execute(ApiRequest("GET", "/api/auth/me"))
            assertEquals(200, auth.statusCode)
            assertEquals(200, app.runtime.transport.execute(ApiRequest("GET", "/api/projects")).statusCode)
            assertEquals(selected.instanceId, app.runtime.configStore.directory.first().activeTarget?.instanceId)
            val hash = MessageDigest.getInstance("SHA-256").digest(selected.instanceId.toByteArray())
                .joinToString("") { byte -> "%02x".format(byte) }
            instrumentation.sendStatus(1, Bundle().apply {
                putString("primaryTargetFingerprint", hash)
                putLong("protectedReadElapsedMs", SystemClock.elapsedRealtime() - started)
                putString("connectionState", "connected-and-authenticated")
                putInt("persistedAutoConnectTargets", directory.computers.count { target -> target.autoConnect })
                putBoolean("persistedPrimaryAutoConnectFlag", selected.autoConnect)
            })
        }
    }

    @Test fun queriesLiveUsageAndRestoresComputerName(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveAccountManagementProbe") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val session = app.runtime.ensureAccountSession()
        val usage = app.runtime.accountSessions.getAccountUsage()
        assertTrue(usage.turn.limits.computers > 0)
        val selected = requireNotNull(app.runtime.configStore.directory.first().activeTarget)
        val before = app.runtime.listAccountDirectoryDevices().single { it.instanceId == selected.instanceId }
        assertTrue(before.unboundAt.isNullOrBlank())
        val marker = "Phone device QA ${SystemClock.elapsedRealtime()}"
        try {
            assertTrue(app.runtime.renameAccountDevice(selected.instanceId, marker))
            assertEquals(marker, app.runtime.listAccountDirectoryDevices().single { it.instanceId == selected.instanceId }.alias)
            assertEquals(marker, app.runtime.configStore.directory.first().computers.single { it.instanceId == selected.instanceId }.label)
            assertEquals(session.accountId, app.runtime.ensureAccountSession().accountId)
        } finally {
            assertTrue(app.runtime.renameAccountDevice(selected.instanceId, before.alias))
            assertEquals(before.alias, app.runtime.listAccountDirectoryDevices().single { it.instanceId == selected.instanceId }.alias)
        }
        instrumentation.sendStatus(1, Bundle().apply {
            putString("effectivePlan", usage.subscription.plan)
            putInt("usedPhones", usage.turn.used.phones)
            putInt("usedComputers", usage.turn.used.computers)
            putInt("activeLeases", usage.turn.connections.active)
            putString("renameRoundTrip", "persisted-and-restored")
        })
    }
}
