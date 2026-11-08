package com.andysagent.agentoc

import android.os.Bundle
import android.util.Log
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import com.andysagent.agentoc.core.model.RemoteTarget
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Hardware smoke tests for local Whisper inference; external-microphone acceptance is opt-in. */
@RunWith(AndroidJUnit4::class)
class PhoneWhisperEngineDeviceTest {
    @Test
    fun nativeWhisperCatalogMatchesAllBundledLanguageChoices() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val catalog = context.assets.open("whisper-languages.json").bufferedReader().use { reader ->
            kotlinx.serialization.json.Json.parseToJsonElement(reader.readText()).jsonArray.map { entry ->
                entry.jsonObject.getValue("code").jsonPrimitive.content
            }
        }
        val nativeLanguages = NativeWhisper.supportedLanguageCodes().toList()
        assertEquals("The packaged catalog must match the pinned native Whisper runtime", catalog, nativeLanguages)
        assertTrue("The speech picker must include languages outside Ragent's seven UI locales", catalog.size >= 100)
        assertTrue(catalog.containsAll(listOf("de", "ru", "ar", "hi", "haw")))
        Log.i("RagentVoiceQA", "Pinned Whisper speech languages: ${catalog.size}")
    }

    @Test
    fun createsAppScopedDirectoryForImportedVoiceQaSamples() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = checkNotNull(context.getExternalFilesDir(null)) { "App-scoped external storage is unavailable" }
        check(directory.mkdirs() || directory.isDirectory) { "Could not create app-scoped voice QA directory" }
        Log.i("RagentVoiceQA", "App-scoped sample directory: ${directory.absolutePath}")
    }

    @Test
    fun reportsHonorPairedComputerVoiceReadinessWithoutExposingTargetIdentity(): Unit = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as AgentoCApplication
        val linkedComputers = withTimeout(15_000) { app.runtime.configStore.directory.first().computers }
        val targets = linkedComputers.map { computer ->
            RemoteTarget(
                instanceId = computer.instanceId,
                label = computer.label.ifBlank { "Computer" },
                endpoint = computer.endpoint,
                platform = computer.platform,
            )
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val controller = LocalVoiceController(app, context, scope)
        try {
            controller.refreshComputers(targets)
            val computers = withTimeout(30_000) {
                controller.state.first { it.computers.size == targets.size }.computers
            }
            val report = listOf(
                "paired=${targets.size}",
                "connected=${computers.count { it.connected }}",
                "installed=${computers.count { it.installed }}",
                "enabled=${computers.count { it.enabled }}",
                "ready=${computers.count { it.ready }}",
                "koreanSupported=${computers.count { "ko" in it.supportedLanguages }}",
                "errors=${computers.count { it.error != null }}",
            ).joinToString("\n", postfix = "\n")
            File(checkNotNull(context.getExternalFilesDir(null)), "voice-computer-status-qa.txt").writeText(report)
            Log.i("RagentVoiceQA", "HONOR_PAIRED_COMPUTER_VOICE_STATUS: ${report.replace('\n', ';')}")
            Unit
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun liveHonorMicrophoneRecordingReachesPhoneWhisperDraftCallback() = runBlocking {
        val expectedRegex = InstrumentationRegistry.getArguments()
            .getString("voiceMicExpectedRegex")
            ?.takeIf(String::isNotBlank)
        val playbackMode = InstrumentationRegistry.getArguments().getString("voiceMicPlayback") ?: "external"
        assumeTrue(
            "Pass -e voiceMicExpectedRegex <pattern> and optionally -e voiceMicPlayback phone-speaker",
            expectedRegex != null && playbackMode in setOf("external", "phone-speaker"),
        )
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as AgentoCApplication
        val sampleDirectory = checkNotNull(context.getExternalFilesDir(null))
        val modelSeed = File(sampleDirectory, "ggml-tiny-q5_1.bin")
        assumeTrue("Seed the verified phone model before this live microphone acceptance test", modelSeed.isFile)
        val engine = PhoneWhisperEngine(context)
        val modelFile = File(File(context.filesDir, "voice-models"), "ggml-tiny-q5_1.bin")
        check(modelFile.parentFile?.mkdirs() == true || modelFile.parentFile?.isDirectory == true)
        modelSeed.copyTo(modelFile, overwrite = true)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val controller = LocalVoiceController(app, context, scope)
        val transcript = CompletableFuture<String>()
        val peakInputLevel = AtomicReference(0f)
        val levelCollector = scope.launch {
            controller.state.collect { voiceState ->
                peakInputLevel.updateAndGet { maxOf(it, voiceState.waveformLevel) }
            }
        }
        try {
            app.runtime.configStore.setPhoneLocalVoiceEnabled(true)
            app.runtime.configStore.setVoiceRecognitionLanguage("ko")
            controller.loadSession(null)
            withTimeout(15_000) { controller.state.first { it.phoneEnabled && it.phoneWhisperInstalled } }
            controller.startVoiceInput(sessionTargetId = null, onText = transcript::complete)
            withTimeout(15_000) { controller.state.first { it.recording } }
            Log.i("RagentVoiceQA", "LIVE_MIC_RECORDING_STARTED")
            if (playbackMode == "phone-speaker") {
                val sample = File(sampleDirectory, "voice-qa-ko-KR.wav")
                assumeTrue("Seed the Korean sample before phone-speaker microphone acceptance", sample.isFile)
                delay(500)
                withContext(Dispatchers.IO) { playWavThroughPhoneSpeaker(context, sample) }
                delay(1_000)
            } else {
                // Leave enough capture time for the separately started speaker playback to begin.
                delay(20_000)
            }
            controller.stopVoiceInput()
            val recognized = withTimeout(5 * 60_000) { withContext(Dispatchers.IO) { transcript.get(5, TimeUnit.MINUTES) } }
            levelCollector.cancel()
            Log.i("RagentVoiceQA", "LIVE_MIC_PEAK_WAVEFORM_LEVEL: ${peakInputLevel.get()}")
            Log.i("RagentVoiceQA", "LIVE_MIC_TRANSCRIPT: $recognized")
            assertTrue(
                "The Honor microphone did not capture the supplied speech sample: $recognized (peak waveform level ${peakInputLevel.get()})",
                Regex(checkNotNull(expectedRegex)).containsMatchIn(recognized),
            )
        } finally {
            levelCollector.cancel()
            controller.cancelVoiceInput()
            scope.cancel()
            engine.remove()
            app.runtime.configStore.setPhoneLocalVoiceEnabled(false)
            app.runtime.configStore.setVoiceRecognitionLanguage("auto")
        }
    }

    @Test
    fun transcribesImportedRagentLanguageSamplesOnHonorWithAutomaticLanguageDetection() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val engine = PhoneWhisperEngine(context)
        val sampleDirectory = context.getExternalFilesDir(null)
        val modelSeed = sampleDirectory?.let { File(it, "ggml-tiny-q5_1.bin") }
        val samples = listOf(
            ImportedSample("voice-qa-en-US.wav", "en-US", Regex("(?i)speech|recognition")),
            ImportedSample("voice-qa-zh-CN.wav", "zh-CN", Regex("[\\u4e00-\\u9fff]")),
            ImportedSample("voice-qa-zh-TW.wav", "zh-TW", Regex("[\\u4e00-\\u9fff]")),
            ImportedSample("voice-qa-ja-JP.wav", "ja-JP", Regex("[\\u3040-\\u30ff]")),
            ImportedSample("voice-qa-ko-KR.wav", "ko-KR", Regex("[\\uac00-\\ud7af]")),
            ImportedSample("voice-qa-fr-FR.wav", "fr-FR", Regex("(?i)bonjour|reconnaissance|vocale")),
            ImportedSample("voice-qa-es-ES.wav", "es-AR", Regex("(?i)hace|grados|sol")),
        ).mapNotNull { sample ->
            sampleDirectory?.let { directory -> File(directory, sample.fileName).takeIf(File::isFile)?.let { sample to it } }
        }
        assumeTrue("This phone does not have the Whisper native runtime ABI", engine.isSupported)
        if (!engine.isInstalled && modelSeed?.isFile == true) {
            val internalModel = File(File(context.filesDir, "voice-models"), "ggml-tiny-q5_1.bin")
            check(internalModel.parentFile?.mkdirs() == true || internalModel.parentFile?.isDirectory == true)
            modelSeed.copyTo(internalModel, overwrite = true)
        }
        assumeTrue("Provide the model seed and language WAVs in this test app's external files directory", engine.isInstalled && samples.isNotEmpty())
        for ((sample, file) in samples) {
            val transcript = engine.transcribe(normalizeWav(file.readBytes())).trim()
            Log.i("RagentVoiceQA", "${sample.languageTag}: $transcript")
            assertTrue("Whisper returned no ${sample.languageTag} transcript", transcript.isNotBlank())
            assertTrue("Whisper did not recognize ${sample.languageTag}: $transcript", sample.expected.containsMatchIn(transcript))
        }
    }

    @Test
    fun transcribesKoreanSampleWhenRecognitionLanguageIsExplicitlySelected() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val engine = PhoneWhisperEngine(context)
        val directory = context.getExternalFilesDir(null)
        val sample = directory?.let { File(it, "voice-qa-ko-KR.wav") }
        assumeTrue("Install the optional multilingual model before this hardware test", engine.isInstalled)
        assumeTrue("Provide the Korean voice sample in the test app's external files directory", sample?.isFile == true)
        val transcript = engine.transcribe(normalizeWav(checkNotNull(sample).readBytes()), "ko").trim()
        Log.i("RagentVoiceQA", "ko (explicit): $transcript")
        assertTrue("Whisper returned no Korean transcript", transcript.isNotBlank())
        assertTrue("Whisper did not recognize Korean speech: $transcript", Regex("[\\uac00-\\ud7af]").containsMatchIn(transcript))
    }

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

    private data class ImportedSample(val fileName: String, val languageTag: String, val expected: Regex)

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

    private fun playWavThroughPhoneSpeaker(context: android.content.Context, sample: File) {
        val audioManager = context.getSystemService(AudioManager::class.java)
        val previousMusicVolume = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
        val testMusicVolume = (audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC) / 2).coerceAtLeast(1)
        val player = MediaPlayer()
        val completed = CountDownLatch(1)
        try {
            if (previousMusicVolume == 0) audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, testMusicVolume, 0)
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            player.setDataSource(sample.absolutePath)
            player.prepare()
            player.setOnCompletionListener { completed.countDown() }
            player.start()
            check(completed.await(30, TimeUnit.SECONDS)) { "Honor speaker playback did not finish" }
        } finally {
            runCatching { if (player.isPlaying) player.stop() }
            player.release()
            if (previousMusicVolume == 0) {
                audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, previousMusicVolume, 0)
            }
        }
    }
}
