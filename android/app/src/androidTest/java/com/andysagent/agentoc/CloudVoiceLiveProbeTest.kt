package com.andysagent.agentoc

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Explicitly opted-in live account probe. Never grants consent or prints credentials. */
@RunWith(AndroidJUnit4::class)
class CloudVoiceLiveProbeTest {
    @Test fun checksAccountAndOptionallyTranscribesSyntheticAudio(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("liveCloudVoiceProbe") == "true")
        val app = instrumentation.targetContext.applicationContext as AgentoCApplication
        val runtime = app.runtime
        runtime.ensureAccountSession()
        val usage = runtime.accountSessions.getAccountAsrUsage()
        instrumentation.sendStatus(1, Bundle().apply {
            putBoolean("cloudAvailable", usage.available)
            putBoolean("consentGranted", usage.consent.granted)
            putLong("remainingMs", usage.remainingMs)
        })
        assertTrue("Cloud speech service is unavailable", usage.available)
        if (args.getString("liveCloudVoiceTranscribe") != "true") return@runBlocking
        assumeTrue("The account holder must grant cloud speech consent in the app first", usage.consent.granted)
        assertTrue("No cloud speech allowance remains", usage.remainingMs > 0)
        val audio = File(app.cacheDir, "qa-cloud-voice-synthetic.wav")
        try {
            assertTrue("Synthetic test audio has not been staged", audio.isFile)
            val transcript = runtime.accountSessions.transcribeAccountAudio(audio.readBytes(), UUID.randomUUID().toString()).text
            assertTrue("Synthetic English speech was not recognized", transcript.lowercase().contains("speech recognition test"))
            instrumentation.sendStatus(1, Bundle().apply { putBoolean("transcriptionVerified", true) })
        } finally {
            audio.delete()
        }
    }
}
