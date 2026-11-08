package com.andysagent.agentoc

import android.os.Bundle
import android.util.Log
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Hardware smoke test for local Whisper inference; skips unless a user-installed model is present. */
@RunWith(AndroidJUnit4::class)
class PhoneWhisperEngineDeviceTest {
    @Test
    fun transcribesEveryRagentLanguageAvailableInThePhoneTtsWithAutomaticLanguageDetection() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val engine = PhoneWhisperEngine(context)
        assumeTrue("This phone does not have the Whisper native runtime ABI", engine.isSupported)
        assumeTrue("Install the optional multilingual model before this hardware test", engine.isInstalled)

        val initialized = CompletableFuture<Int>()
        val tts = TextToSpeech(context) { initialized.complete(it) }
        val audioFile = File(context.cacheDir, "voice-whisper-device-test.wav")
        try {
            assumeTrue("The phone's TTS engine did not initialize", initialized.get(20, TimeUnit.SECONDS) == TextToSpeech.SUCCESS)
            val languageSamples = listOf(
                LanguageSample(Locale.US, "Speech recognition works on this phone.", Regex("(?i)speech|recogn")),
                LanguageSample(Locale.SIMPLIFIED_CHINESE, "你好，今天我们测试手机上的中文语音识别。", Regex("[\\u4e00-\\u9fff]")),
                LanguageSample(Locale.TRADITIONAL_CHINESE, "你好，今天我們測試手機上的中文語音辨識。", Regex("[\\u4e00-\\u9fff]")),
                LanguageSample(Locale.JAPAN, "こんにちは。日本語の音声認識を試します。", Regex("[\\u3040-\\u30ff]")),
                LanguageSample(Locale.KOREA, "안녕하세요. 휴대폰에서 한국어 음성 인식을 시험합니다.", Regex("[\\uac00-\\ud7af]")),
                LanguageSample(Locale.FRANCE, "Bonjour. Nous testons la reconnaissance vocale sur ce téléphone.", Regex("(?i)bonjour|reconnaissance|vocale")),
                LanguageSample(Locale("es", "ES"), "Hola. Probamos el reconocimiento de voz en este teléfono.", Regex("(?i)hola|reconocimiento|voz")),
            )
            val availableSamples = languageSamples.filter { tts.setLanguage(it.locale) >= TextToSpeech.LANG_AVAILABLE }
            assumeTrue("The phone has no offline TTS voices for Ragent's supported languages", availableSamples.isNotEmpty())

            tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit
                override fun onDone(id: String?) { completions[id]?.complete(true) }
                override fun onError(id: String?) { completions[id]?.complete(false) }
            })
            availableSamples.forEachIndexed { index, sample ->
                tts.setLanguage(sample.locale)
                val utteranceId = UUID.randomUUID().toString()
                val completed = CompletableFuture<Boolean>()
                completions[utteranceId] = completed
                audioFile.delete()
                val queued = tts.synthesizeToFile(sample.phrase, Bundle(), audioFile, utteranceId)
                assumeTrue("The phone TTS engine could not synthesize ${sample.locale}", queued == TextToSpeech.SUCCESS)
                assumeTrue("TTS did not finish the ${sample.locale} sample", completed.get(30, TimeUnit.SECONDS))
                completions.remove(utteranceId)
                assertTrue("TTS did not produce a ${sample.locale} audio file", audioFile.isFile && audioFile.length() > 44)

                val transcript = engine.transcribe(normalizeWav(audioFile.readBytes())).lowercase(Locale.ROOT)
                Log.i("RagentVoiceQA", "${sample.locale.toLanguageTag()}: $transcript")
                assertTrue("Whisper returned no ${sample.locale} transcript", transcript.isNotBlank())
                assertTrue("Whisper did not recognize ${sample.locale}: $transcript", sample.expected.containsMatchIn(transcript))
            }
        } finally {
            audioFile.delete()
            tts.shutdown()
        }
    }

    private val completions = java.util.concurrent.ConcurrentHashMap<String, CompletableFuture<Boolean>>()

    private data class LanguageSample(val locale: Locale, val phrase: String, val expected: Regex)

    private fun normalizeWav(input: ByteArray): ByteArray {
        require(input.size >= 44 && input.copyOfRange(0, 4).decodeToString() == "RIFF" &&
            input.copyOfRange(8, 12).decodeToString() == "WAVE") { "TTS did not produce a WAV file" }
        fun u16(offset: Int) = (input[offset].toInt() and 0xff) or ((input[offset + 1].toInt() and 0xff) shl 8)
        fun u32(offset: Int): Int = (0..3).sumOf { index -> (input[offset + index].toLong() and 0xffL) shl (index * 8) }.toInt()
        var format = 0
        var channels = 0
        var sampleRate = 0
        var bits = 0
        var dataOffset = -1
        var dataLength = 0
        var offset = 12
        while (offset + 8 <= input.size) {
            val size = u32(offset + 4).coerceAtLeast(0)
            val contents = offset + 8
            when (input.copyOfRange(offset, offset + 4).decodeToString()) {
                "fmt " -> if (size >= 16 && contents + 16 <= input.size) {
                    format = u16(contents)
                    channels = u16(contents + 2)
                    sampleRate = u32(contents + 4)
                    bits = u16(contents + 14)
                }
                "data" -> {
                    dataOffset = contents
                    dataLength = minOf(size, input.size - contents)
                    break
                }
            }
            offset = contents + size + (size and 1)
        }
        require(format == 1 && channels in 1..2 && bits == 16 && sampleRate > 0 && dataOffset >= 0) {
            "The phone TTS WAV format is not supported by the voice smoke test"
        }
        val sourceFrames = dataLength / (channels * 2)
        require(sourceFrames > 0) { "The TTS WAV contains no PCM samples" }
        val targetFrames = (sourceFrames.toDouble() * 16_000 / sampleRate).toInt().coerceAtLeast(1)
        val pcm = ByteArray(targetFrames * 2)
        fun monoFrame(frame: Int): Double {
            var total = 0.0
            repeat(channels) { channel ->
                val position = dataOffset + (frame * channels + channel) * 2
                total += (((input[position + 1].toInt() shl 8) or (input[position].toInt() and 0xff)).toShort()).toDouble()
            }
            return total / channels
        }
        for (frame in 0 until targetFrames) {
            val position = frame.toDouble() * sampleRate / 16_000
            val lower = position.toInt().coerceAtMost(sourceFrames - 1)
            val upper = (lower + 1).coerceAtMost(sourceFrames - 1)
            val fraction = position - lower
            val sample = (monoFrame(lower) * (1 - fraction) + monoFrame(upper) * fraction).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            pcm[frame * 2] = sample.toByte()
            pcm[frame * 2 + 1] = (sample shr 8).toByte()
        }
        return encodePcm16Wav(pcm, 16_000)
    }
}
