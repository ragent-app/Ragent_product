package com.andysagent.ragent

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.security.MessageDigest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in physical-device probe; never prints a session credential or account id. */
@RunWith(AndroidJUnit4::class)
class AccountSessionLiveProbeTest {
    @Test fun verifiesOrNormallyLogsOutTheCurrentPhoneSession() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("liveAccountSessionProbe") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val runtime = app.runtime
        withTimeout(120_000) {
            if (args.getString("phoneAccountAction") == "logout") {
                runtime.logoutAccountSession()
                assertNull(runtime.configStore.accountSession.first())
                instrumentation.sendStatus(1, Bundle().apply { putString("phoneAccountState", "signed-out") })
            } else {
                assertNotNull(runtime.configStore.accountSession.first())
                val credential = runtime.ensureAccountSession()
                val fingerprint = MessageDigest.getInstance("SHA-256")
                    .digest(credential.accountId.toByteArray(Charsets.UTF_8))
                    .joinToString("") { "%02x".format(it) }
                instrumentation.sendStatus(1, Bundle().apply {
                    putString("phoneAccountState", "verified")
                    putString("accountFingerprint", fingerprint)
                })
            }
        }
    }
}
