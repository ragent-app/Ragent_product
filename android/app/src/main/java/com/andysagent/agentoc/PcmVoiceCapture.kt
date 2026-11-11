package com.andysagent.agentoc

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal class VoiceRecordingTooShortException : IllegalStateException("Recording was too short")

internal suspend fun recordVoiceWav(
    stopRequested: AtomicBoolean,
    maxSeconds: Int = 20,
    onLevel: (Float) -> Unit = {},
): ByteArray =
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
        val data = try {
            recorder.startRecording()
            check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Phone microphone did not start" }
            collectVoicePcm(stopRequested, maxSeconds, bufferSize, onLevel = onLevel) { buffer, length ->
                recorder.read(buffer, 0, length, AudioRecord.READ_BLOCKING)
            }
        } finally {
            runCatching { recorder.stop() }
            recorder.release()
        }
        encodePcm16Wav(data, sampleRate)
    }

/** Capture bounded PCM without depending on the recorder's buffer size. */
internal fun collectVoicePcm(
    stopRequested: AtomicBoolean,
    maxSeconds: Int,
    bufferSize: Int,
    onLevel: (Float) -> Unit = {},
    nowNanos: () -> Long = System::nanoTime,
    read: (ByteArray, Int) -> Int,
): ByteArray {
    require(maxSeconds in 1..20 && bufferSize > 0)
    val sampleRate = 16_000
    val maxPcmBytes = sampleRate * 2 * maxSeconds
    val pcm = ByteArrayOutputStream(maxPcmBytes)
    val buffer = ByteArray(bufferSize)
    val deadline = nowNanos() + maxSeconds * 1_000_000_000L
    while (!stopRequested.get() && nowNanos() < deadline && pcm.size() < maxPcmBytes) {
        val readCount = read(buffer, minOf(buffer.size, maxPcmBytes - pcm.size()))
        if (readCount < 0) error("Phone microphone read failed ($readCount)")
        if (readCount > 0) {
            pcm.write(buffer, 0, readCount)
            onLevel(pcmLevel(buffer, readCount))
        }
    }
    val data = pcm.toByteArray()
    if (data.size < sampleRate) throw VoiceRecordingTooShortException()
    return data
}

private fun pcmLevel(buffer: ByteArray, length: Int): Float {
    val samples = length / 2
    if (samples == 0) return 0f
    var squared = 0.0
    var offset = 0
    repeat(samples) {
        val sample = ((buffer[offset + 1].toInt() shl 8) or (buffer[offset].toInt() and 0xff)).toShort().toInt()
        squared += sample.toDouble() * sample
        offset += 2
    }
    val rms = kotlin.math.sqrt(squared / samples) / Short.MAX_VALUE
    return ((rms * 4.5).coerceIn(0.0, 1.0)).toFloat()
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
