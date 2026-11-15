package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/** Explicit opt-in, metadata-only journal; restore always performs a NEW authorized join. */
class AccountDisconnectLiveTest {
    private fun fingerprint(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
        .joinToString("") { "%02x".format(it) }

    @Test fun runsRequestedPhase(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("liveDisconnectProbe") == "true")
        val phase = requireNotNull(args.getString("disconnectPhase"))
        require(phase in setOf("remove", "observe", "restore"))
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val journalFile = File(app.noBackupFilesDir, "qa-account-disconnect-20261025.json")
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val account = runtime.ensureAccountSession()
            val journal = if (phase == "remove") {
                check(!journalFile.exists()) { "Finish the prior disconnect QA first" }
                val directory = runtime.configStore.directory.first()
                check(directory.computers.size == 1) { "This probe owns only a sole-primary disconnect" }
                val primary = requireNotNull(directory.activeTarget)
                JSONObject().put("primaryId", primary.instanceId).put("autoConnect", primary.autoConnect)
                    .put("accountFingerprint", fingerprint(account.accountId)).also { metadata -> journalFile.writeText(metadata.toString()) }
            } else JSONObject(journalFile.readText())
            val targetId = journal.getString("primaryId")
            assertEquals(journal.getString("accountFingerprint"), fingerprint(account.accountId))
            if (phase == "remove") runtime.disconnectTarget(targetId)
            if (phase == "restore") {
                // Never restore an old bearer, encrypted preference or database.
                val result = withTimeout(150_000) { runtime.pairFromAccountComputer(targetId, runtime.accountDeviceAlias) }
                assertEquals(targetId, result.instanceId)
                val current = runtime.configStore.directory.first().computers.single { computer -> computer.instanceId == targetId }
                runtime.configStore.upsertComputer(current.copy(autoConnect = journal.getBoolean("autoConnect")), select = true)
                runtime.awaitLifecycleUpdate()
                withTimeout(150_000) { runtime.targetConnectionStates.first { states -> states[targetId] == RuntimeConnectionState.Connected } }
                assertEquals(200, runtime.transport.execute(ApiRequest("GET", "/api/auth/me")).statusCode)
                assertEquals(200, runtime.transport.execute(ApiRequest("GET", "/api/projects")).statusCode)
                assertEquals(targetId, runtime.configStore.directory.first().activeTarget?.instanceId)
                assertEquals(journal.getBoolean("autoConnect"), runtime.configStore.directory.first().activeTarget?.autoConnect)
                assertEquals(journal.getString("accountFingerprint"), fingerprint(runtime.ensureAccountSession().accountId))
                check(journalFile.delete())
            } else {
                if (phase == "observe") {
                    // Prove Accounts is reachable and still lists this bound PC;
                    // absence cannot pass merely because discovery was offline.
                    assertTrue(runtime.listAccountDirectoryDevices().any { device -> device.instanceId == targetId && device.unboundAt.isNullOrBlank() })
                    val restoreJob = AndroidRuntimeGraph::class.java.getDeclaredField("accountRestoreJob").apply { isAccessible = true }.get(runtime) as? Job
                    assertNotNull("Actual foreground account discovery must have been scheduled", restoreJob)
                    withTimeout(60_000) { restoreJob!!.join() }
                }
                assertTrue(runtime.configStore.directory.first().computers.isEmpty())
                assertFalse(runtime.configStore.directory.first().automaticAccountRestoreAllowed)
                assertTrue(runtime.targetConnectionStates.value.isEmpty())
                assertTrue("Removed target must retain no local bearer", runtime.credentialStore.readToken(targetId).isNullOrBlank())
            }
            instrumentation.sendStatus(1, Bundle().apply {
                putString("disconnectPhase", phase)
                putString("primaryFingerprint", fingerprint(targetId))
                putString("result", if (phase == "restore") "fresh-authorized-join-and-protected-reads" else "removed-without-automatic-resurrection")
            })
        }
    }
}
