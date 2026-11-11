package com.andysagent.agentoc

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device E2E through the same account rendezvous used by the app. Use an
 * isolated contributor build and an authorized test account/host. A v3 QR
 * requires an existing account session; a v4 QR can claim the desktop account.
 *
 * Usage:
 *   adb shell am instrument -w -e class com.andysagent.agentoc.PairingE2ETest \
 *     -e pairingUri "agentoc://pair?..." \
 *     com.agentoncloud.android.opensource.test/androidx.test.runner.AndroidJUnitRunner
 */
@RunWith(AndroidJUnit4::class)
class PairingE2ETest {

    @Test
    fun realHostPairingRedeemsDevice() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val uri = InstrumentationRegistry.getArguments().getString("pairingUri")
        assumeTrue("Pairing E2E requires -e pairingUri <agentoc://pair...>", !uri.isNullOrBlank())
        val pairingUri = uri ?: return@runBlocking

        assumeTrue("Pairing E2E must use the isolated contributor application", context.packageName.endsWith(".opensource"))
        val runtime = (context.applicationContext as AgentoCApplication).runtime
        val result = runtime.pairFromInvitation(pairingUri, "E2E Device")

        assertTrue("computer should be saved in the account directory",
            runtime.configStore.directory.first().computers.any { it.instanceId == result.instanceId })
        assertTrue("credential should be stored", runtime.credentialStore.read(result.instanceId) != null)
        assertTrue("device identity should be assigned", result.deviceId.isNotBlank())
        println("PAIRING_E2E_OK")
    }
}
