package com.andysagent.agentoc

import android.Manifest
import android.content.pm.PackageManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit device-only microphone test; audio stays in memory and is not sent. */
@RunWith(AndroidJUnit4::class)
class VoiceCaptureBoundaryTest {
    @Test fun automaticStopStaysWithinServerDurationLimit() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("voiceCaptureBoundary") == "true")
        assumeTrue(instrumentation.targetContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        val wav = recordVoiceWav(AtomicBoolean(false), maxSeconds = 20)
        val header = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        val pcmBytes = header.getInt(40)
        assertEquals(wav.size - 44, pcmBytes)
        assertTrue("Recording must satisfy the server minimum", pcmBytes >= 16_000)
        assertTrue("Recording must not exceed the server 20-second limit", pcmBytes <= 640_000)
        assertEquals(0, pcmBytes % 2)
    }
}
