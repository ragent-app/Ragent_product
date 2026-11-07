package com.andysagent.agentoc

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal suspend fun recordVoiceWav(stopRequested: AtomicBoolean, maxSeconds: Int = 20): ByteArray =
    withContext(Dispatchers.IO) {
        require(maxSeconds in 1..20)
        val sampleRate = 16_000
        val minimumBuffer = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        check(minimumBuffer > 0) { "Phone microphone is unavailable" }
        val bufferSize = maxOf(minimumBuffer, 4_096)
        val recorder = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferSize,
        )
        check(recorder.state == AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            "Phone microphone could not be initialized"
        }
        val pcm = ByteArrayOutputStream(sampleRate * 2 * maxSeconds)
        val buffer = ByteArray(bufferSize)
        try {
            recorder.startRecording()
            check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Phone microphone did not start" }
            val deadline = System.nanoTime() + maxSeconds * 1_000_000_000L
            while (!stopRequested.get() && System.nanoTime() < deadline) {
                val read = recorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                if (read < 0) error("Phone microphone read failed ($read)")
                if (read > 0) pcm.write(buffer, 0, read)
            }
        } finally {
            runCatching { recorder.stop() }
            recorder.release()
        }
        val data = pcm.toByteArray()
        check(data.size >= sampleRate / 2) { "Recording was too short" }
        encodePcm16Wav(data, sampleRate)
    }

internal fun encodePcm16Wav(pcm: ByteArray, sampleRate: Int): ByteArray {
    require(sampleRate > 0 && pcm.size % 2 == 0)
    val output = ByteArray(44 + pcm.size)
    fun putAscii(offset: Int, value: String) = value.forEachIndexed { index, char -> output[offset + index] = char.code.toByte() }
    fun putInt(offset: Int, value: Int) = repeat(4) { index -> output[offset + index] = (value ushr (8 * index)).toByte() }
    fun putShort(offset: Int, value: Int) = repeat(2) { index -> output[offset + index] = (value ushr (8 * index)).toByte() }
    putAscii(0, "RIFF")
    putInt(4, 36 + pcm.size)
    putAscii(8, "WAVE")
    putAscii(12, "fmt ")
    putInt(16, 16)
    putShort(20, 1)
    putShort(22, 1)
    putInt(24, sampleRate)
    putInt(28, sampleRate * 2)
    putShort(32, 2)
    putShort(34, 16)
    putAscii(36, "data")
    putInt(40, pcm.size)
    pcm.copyInto(output, 44)
    return output
}
