package com.andysagent.agentoc

import android.os.Bundle
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in, device-only Korean speech QA; run with the voice-QA instrumentation argument enabled. */
@RunWith(AndroidJUnit4::class)
class VoiceWhisperAcceptanceQaTest {
    @Test
    fun synthesizesAKoreanFixtureForThePhoneWhisperEngine() {
        val arguments = InstrumentationRegistry.getArguments()
        assumeTrue("Set agentocVoiceWhisperQa=true to run the device-only voice QA", arguments.getString("agentocVoiceWhisperQa") == "true")

        runBlocking {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val engine = PhoneWhisperEngine(context)
            assumeTrue("Honor does not expose a supported Whisper native ABI", engine.isSupported)

            val modelWasInstalled = engine.isInstalled
            val external = checkNotNull(context.getExternalFilesDir(null))
            val model = File(File(context.filesDir, "voice-models"), "ggml-tiny-q5_1.bin")
            val modelCopy = File(external, "ggml-tiny-q5_1.bin")
            val output = File(external, "voice-qa-ko-KR.wav")
            var tts: TextToSpeech? = null
            try {
                if (!modelWasInstalled) {
                    engine.download { percent ->
                        if (percent == 0 || percent == 25 || percent == 50 || percent == 75 || percent == 100) {
                            android.util.Log.i("RagentVoiceQA", "PHONE_WHISPER_DOWNLOAD_PERCENT=$percent")
                        }
                    }
                }
                assertTrue("The model download did not produce a valid phone model", engine.isInstalled)
                model.copyTo(modelCopy, overwrite = true)

                val initialized = CompletableFuture<Int>()
                tts = TextToSpeech(context) { initialized.complete(it) }
                assertEquals(TextToSpeech.SUCCESS, initialized.get(30, TimeUnit.SECONDS))
                assumeTrue("Honor has no installed Korean offline TTS voice", tts.setLanguage(Locale.KOREA) >= TextToSpeech.LANG_AVAILABLE)

                val utteranceId = UUID.randomUUID().toString()
                val completed = CompletableFuture<Boolean>()
                tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) = Unit
                    override fun onDone(id: String?) { if (id == utteranceId) completed.complete(true) }
                    override fun onError(id: String?) { if (id == utteranceId) completed.complete(false) }
                })
                assertEquals(
                    TextToSpeech.SUCCESS,
                    tts.synthesizeToFile("안녕하세요. 휴대폰에서 한국어 음성 인식을 시험합니다.", Bundle(), output, utteranceId),
                )
                assertTrue("Korean TTS did not finish", completed.get(45, TimeUnit.SECONDS))
                assertTrue("Korean TTS produced an empty audio file", output.isFile && output.length() > 44)
                assertEquals("RIFF", output.inputStream().use { ByteArray(4).also { bytes -> it.read(bytes) }.decodeToString() })
                android.util.Log.i("RagentVoiceQA", "KOREAN_TTS_FIXTURE_BYTES=${output.length()}")
            } finally {
                tts?.shutdown()
                modelCopy.delete()
                output.delete()
                // Never remove a model that was present before this opt-in QA.
                if (!modelWasInstalled) engine.remove()
            }
        }
    }
}
