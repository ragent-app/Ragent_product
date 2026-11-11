package com.andysagent.agentoc

import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class VoiceCaptureBoundaryUnitTest {
    @Test fun recordingStopsAtTwentySecondsEvenWhenBufferDoesNotDivideLimit() {
        val lengths = mutableListOf<Int>()
        val pcm = collectVoicePcm(AtomicBoolean(false), 20, 4_096, nowNanos = { 0L }) { _, length ->
            lengths += length
            length
        }
        assertEquals(640_000, pcm.size)
        assertEquals(1_024, lengths.last())
        val wav = encodePcm16Wav(pcm, 16_000)
        assertEquals(640_044, wav.size)
    }

    @Test fun minimumLengthMatchesHalfSecondServerRequirement() {
        fun captureSingleRead(bytes: Int): ByteArray {
            val stop = AtomicBoolean(false)
            return collectVoicePcm(stop, 20, bytes, nowNanos = { 0L }) { _, length ->
                stop.set(true)
                length
            }
        }
        assertFailsWith<VoiceRecordingTooShortException> { captureSingleRead(15_998) }
        assertEquals(16_000, captureSingleRead(16_000).size)
    }
}
