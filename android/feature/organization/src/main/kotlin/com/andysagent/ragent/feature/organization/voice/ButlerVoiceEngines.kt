package com.andysagent.ragent.feature.organization.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.core.content.ContextCompat
import com.andysagent.ragent.feature.organization.data.VoiceTtsChunkDto
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume

sealed interface AsrCaptureOutcome {
    data class Success(
        val transcript: String,
        val confidence: Double,
        val language: String?,
        val engineId: String,
        val mode: String,
        val audioBase64: String? = null,
        val mimeType: String? = null,
    ) : AsrCaptureOutcome

    data class Failed(
        val status: String,
        val errorCode: String,
        val errorMessage: String,
        val engineId: String,
        val mode: String,
        val retryPrompt: String,
    ) : AsrCaptureOutcome

    data object Cancelled : AsrCaptureOutcome
}

interface ButlerAsrAdapter {
    val isListening: StateFlow<Boolean>
    val rmsLevel: StateFlow<Float>
    fun isAvailable(): Boolean
    fun hasAudioPermission(): Boolean
    suspend fun captureOnce(engineId: String?, language: String?): AsrCaptureOutcome
    fun stopListening()
    fun cancel()
    fun shutdown()
}

interface ButlerTtsAdapter {
    val ready: StateFlow<Boolean>
    val isSpeaking: StateFlow<Boolean>
    val activeGeneration: StateFlow<Long>
    val currentChunkIndex: StateFlow<Int>
    fun speakChunks(
        generation: Long,
        chunks: List<VoiceTtsChunkDto>,
        fallbackText: String,
        onFinished: (Long) -> Unit,
        onInterrupted: (Long, Int) -> Unit,
    )
    fun stopImmediately(reason: String = "barge_in"): Pair<Long, Int>
    fun shutdown()
}

data class ButlerDeviceIdentity(
    val deviceId: String,
    val deviceType: String = "android",
    val deviceLabel: String,
)

fun resolveButlerDeviceIdentity(context: Context): ButlerDeviceIdentity {
    val prefs = context.applicationContext.getSharedPreferences("ragent_voice_butler_device", Context.MODE_PRIVATE)
    val existing = prefs.getString("device_id", null)?.trim()?.takeIf { it.isNotEmpty() }
    val resolvedId = existing ?: run {
        val androidId = runCatching {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        }.getOrNull()?.trim()?.takeIf { it.isNotEmpty() }
        val generated = androidId?.let { "android-$it" } ?: "android-${UUID.randomUUID()}"
        prefs.edit().putString("device_id", generated).apply()
        generated
    }
    val modelLabel = listOf(Build.MANUFACTURER, Build.MODEL)
        .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
        .distinct()
        .joinToString(" ")
        .ifBlank { "Android device" }
    return ButlerDeviceIdentity(
        deviceId = resolvedId,
        deviceType = "android",
        deviceLabel = modelLabel,
    )
}

class AndroidSpeechRecognizerAsrAdapter(
    context: Context,
) : ButlerAsrAdapter {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _isListening = MutableStateFlow(false)
    override val isListening: StateFlow<Boolean> = _isListening.asStateFlow()

    private val _rmsLevel = MutableStateFlow(0f)
    override val rmsLevel: StateFlow<Float> = _rmsLevel.asStateFlow()

    private var recognizer: SpeechRecognizer? = null
    private var activeContinuation: CancellableContinuation<AsrCaptureOutcome>? = null
    private var currentEngineId: String = "local"

    override fun isAvailable(): Boolean = runCatching {
        SpeechRecognizer.isRecognitionAvailable(appContext)
    }.getOrDefault(false)

    override fun hasAudioPermission(): Boolean =
        ContextCompat.checkSelfPermission(appContext, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    override suspend fun captureOnce(engineId: String?, language: String?): AsrCaptureOutcome {
        val resolvedEngine = engineId?.takeIf { it.isNotBlank() } ?: "local"
        currentEngineId = resolvedEngine
        if (!hasAudioPermission()) {
            return AsrCaptureOutcome.Failed(
                status = "error",
                errorCode = "asr_permission_denied",
                errorMessage = "Microphone permission is required for voice butler.",
                engineId = resolvedEngine,
                mode = "local",
                retryPrompt = "Allow microphone access, then tap the microphone to retry.",
            )
        }
        if (!isAvailable()) {
            return AsrCaptureOutcome.Failed(
                status = "error",
                errorCode = "asr_service_unavailable",
                errorMessage = "System speech recognition is unavailable on this device.",
                engineId = resolvedEngine,
                mode = "local",
                retryPrompt = "Speech recognition is unavailable; use text input or check device voice settings.",
            )
        }
        return withContext(Dispatchers.Main.immediate) {
            suspendCancellableCoroutine { cont ->
                destroyRecognizerLocked()
                activeContinuation = cont
                val sr = runCatching { SpeechRecognizer.createSpeechRecognizer(appContext) }.getOrNull()
                if (sr == null) {
                    activeContinuation = null
                    _isListening.value = false
                    cont.resume(
                        AsrCaptureOutcome.Failed(
                            status = "error",
                            errorCode = "asr_init_failed",
                            errorMessage = "Unable to start speech recognizer.",
                            engineId = resolvedEngine,
                            mode = "local",
                            retryPrompt = "Could not start voice capture. Tap to retry.",
                        ),
                    )
                    return@suspendCancellableCoroutine
                }
                recognizer = sr
                val langTag = language?.takeIf { it.isNotBlank() } ?: Locale.getDefault().toLanguageTag()
                sr.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {
                        _isListening.value = true
                    }

                    override fun onBeginningOfSpeech() {
                        _isListening.value = true
                    }

                    override fun onRmsChanged(rmsdB: Float) {
                        val normalized = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
                        _rmsLevel.value = normalized
                    }

                    override fun onBufferReceived(buffer: ByteArray?) = Unit

                    override fun onEndOfSpeech() {
                        _isListening.value = false
                        _rmsLevel.value = 0f
                    }

                    override fun onError(error: Int) {
                        _isListening.value = false
                        _rmsLevel.value = 0f
                        val pending = activeContinuation ?: return
                        activeContinuation = null
                        destroyRecognizerLocked()
                        val (code, status, message, retry) = mapSpeechError(error)
                        if (pending.isActive) {
                            pending.resume(
                                AsrCaptureOutcome.Failed(
                                    status = status,
                                    errorCode = code,
                                    errorMessage = message,
                                    engineId = resolvedEngine,
                                    mode = "local",
                                    retryPrompt = retry,
                                ),
                            )
                        }
                    }

                    override fun onResults(results: Bundle?) {
                        _isListening.value = false
                        _rmsLevel.value = 0f
                        val pending = activeContinuation ?: return
                        activeContinuation = null
                        destroyRecognizerLocked()
                        val texts = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
                        val scores = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
                        val transcript = texts.firstOrNull { !it.isNullOrBlank() }?.trim().orEmpty()
                        if (transcript.isBlank()) {
                            if (pending.isActive) {
                                pending.resume(
                                    AsrCaptureOutcome.Failed(
                                        status = "empty",
                                        errorCode = "asr_empty_transcript",
                                        errorMessage = "No speech was recognized.",
                                        engineId = resolvedEngine,
                                        mode = "local",
                                        retryPrompt = "Didn't catch that. Tap to speak again — no actions were taken.",
                                    ),
                                )
                            }
                            return
                        }
                        val rawConfidence = scores?.firstOrNull()?.takeIf { it.isFinite() && it >= 0f && it <= 1f }
                        val confidence = rawConfidence?.toDouble() ?: 0.72
                        if (pending.isActive) {
                            pending.resume(
                                AsrCaptureOutcome.Success(
                                    transcript = transcript,
                                    confidence = confidence,
                                    language = langTag,
                                    engineId = resolvedEngine,
                                    mode = "local",
                                ),
                            )
                        }
                    }

                    override fun onPartialResults(partialResults: Bundle?) = Unit
                    override fun onEvent(eventType: Int, params: Bundle?) = Unit
                })

                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, langTag)
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                }
                _isListening.value = true
                runCatching { sr.startListening(intent) }.onFailure { err ->
                    _isListening.value = false
                    activeContinuation = null
                    destroyRecognizerLocked()
                    if (cont.isActive) {
                        cont.resume(
                            AsrCaptureOutcome.Failed(
                                status = "error",
                                errorCode = "asr_start_failed",
                                errorMessage = err.message ?: "Failed to start recognition.",
                                engineId = resolvedEngine,
                                mode = "local",
                                retryPrompt = "Could not start listening. Tap to retry.",
                            ),
                        )
                    }
                }
                cont.invokeOnCancellation {
                    scope.launch {
                        _isListening.value = false
                        _rmsLevel.value = 0f
                        activeContinuation = null
                        runCatching { recognizer?.cancel() }
                        destroyRecognizerLocked()
                    }
                }
            }
        }
    }

    override fun stopListening() {
        scope.launch {
            runCatching { recognizer?.stopListening() }
            _isListening.value = false
            _rmsLevel.value = 0f
        }
    }

    override fun cancel() {
        scope.launch {
            _isListening.value = false
            _rmsLevel.value = 0f
            val pending = activeContinuation
            activeContinuation = null
            runCatching { recognizer?.cancel() }
            destroyRecognizerLocked()
            if (pending != null && pending.isActive) {
                pending.resume(AsrCaptureOutcome.Cancelled)
            }
        }
    }

    override fun shutdown() {
        cancel()
    }

    private fun destroyRecognizerLocked() {
        runCatching { recognizer?.destroy() }
        recognizer = null
    }

    private data class SpeechErrorInfo(
        val code: String,
        val status: String,
        val message: String,
        val retryPrompt: String,
    )

    private fun mapSpeechError(error: Int): SpeechErrorInfo = when (error) {
        SpeechRecognizer.ERROR_NO_MATCH -> SpeechErrorInfo(
            "asr_no_match",
            "empty",
            "Speech could not be matched cleanly.",
            "Didn't catch that clearly. Tap to retry — no action was taken.",
        )
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> SpeechErrorInfo(
            "asr_speech_timeout",
            "empty",
            "No speech detected before timeout.",
            "No speech detected. Tap the microphone when ready.",
        )
        SpeechRecognizer.ERROR_AUDIO -> SpeechErrorInfo(
            "asr_audio_error",
            "error",
            "Audio capture error.",
            "Microphone audio failed. Check audio input and retry.",
        )
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> SpeechErrorInfo(
            "asr_permission_denied",
            "error",
            "Microphone permission denied.",
            "Microphone permission is required. Grant access and retry.",
        )
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> SpeechErrorInfo(
            "asr_network_error",
            "error",
            "Speech recognizer network error.",
            "Speech recognition lost connection. Tap to retry.",
        )
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> SpeechErrorInfo(
            "asr_busy",
            "error",
            "Speech recognizer is currently busy.",
            "Voice recognizer is busy. Wait a moment and tap to retry.",
        )
        else -> SpeechErrorInfo(
            "asr_error_$error",
            "error",
            "Speech recognition error ($error).",
            "Voice recognition failed. Tap to retry — no action was taken.",
        )
    }
}

class AndroidTextToSpeechAdapter(
    context: Context,
) : ButlerTtsAdapter {
    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val _ready = MutableStateFlow(false)
    override val ready: StateFlow<Boolean> = _ready.asStateFlow()

    private val _isSpeaking = MutableStateFlow(false)
    override val isSpeaking: StateFlow<Boolean> = _isSpeaking.asStateFlow()

    private val _activeGeneration = MutableStateFlow(0L)
    override val activeGeneration: StateFlow<Long> = _activeGeneration.asStateFlow()

    private val _currentChunkIndex = MutableStateFlow(0)
    override val currentChunkIndex: StateFlow<Int> = _currentChunkIndex.asStateFlow()

    private val lock = Any()
    private val cancelledGenerations = mutableSetOf<Long>()
    private var lastChunkIndexForActiveGen = -1
    private var finishCallback: ((Long) -> Unit)? = null
    private var interruptCallback: ((Long, Int) -> Unit)? = null

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change <= 0) {
            stopImmediately("audio_focus_lost")
        }
    }

    private val focusRequest: AudioFocusRequest = AudioFocusRequest.Builder(
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK,
    ).setAudioAttributes(
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
    ).setOnAudioFocusChangeListener(focusListener).build()

    private var tts: TextToSpeech? = TextToSpeech(appContext) { status ->
        _ready.value = (status == TextToSpeech.SUCCESS)
    }.apply {
        setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                val (gen, idx) = parseUtteranceId(utteranceId) ?: return
                synchronized(lock) {
                    if (gen != _activeGeneration.value || gen in cancelledGenerations) return
                    _currentChunkIndex.value = idx
                    _isSpeaking.value = true
                }
            }

            override fun onDone(utteranceId: String?) {
                val (gen, idx) = parseUtteranceId(utteranceId) ?: return
                var callbackToFire: ((Long) -> Unit)? = null
                synchronized(lock) {
                    if (gen != _activeGeneration.value || gen in cancelledGenerations) return
                    if (idx >= lastChunkIndexForActiveGen) {
                        _isSpeaking.value = false
                        callbackToFire = finishCallback
                        finishCallback = null
                        interruptCallback = null
                    }
                }
                if (callbackToFire != null) {
                    runCatching { audioManager.abandonAudioFocusRequest(focusRequest) }
                    callbackToFire?.invoke(gen)
                }
            }

            override fun onStop(utteranceId: String?, interrupted: Boolean) {
                val (gen, idx) = parseUtteranceId(utteranceId) ?: return
                var cb: ((Long, Int) -> Unit)? = null
                synchronized(lock) {
                    if (gen != _activeGeneration.value) return
                    val alreadyCancelled = gen in cancelledGenerations
                    if (!alreadyCancelled) {
                        cancelledGenerations += gen
                        _isSpeaking.value = false
                        cb = interruptCallback
                        finishCallback = null
                        interruptCallback = null
                    }
                }
                if (cb != null) {
                    runCatching { audioManager.abandonAudioFocusRequest(focusRequest) }
                    cb?.invoke(gen, idx)
                }
            }

            @Suppress("OVERRIDE_DEPRECATION")
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                onError(utteranceId, -1)
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
                val (gen, _) = parseUtteranceId(utteranceId) ?: return
                var callbackToFire: ((Long) -> Unit)? = null
                synchronized(lock) {
                    if (gen != _activeGeneration.value || gen in cancelledGenerations) return
                    _isSpeaking.value = false
                    callbackToFire = finishCallback
                    finishCallback = null
                    interruptCallback = null
                }
                if (callbackToFire != null) {
                    runCatching { audioManager.abandonAudioFocusRequest(focusRequest) }
                    callbackToFire?.invoke(gen)
                }
            }
        })
    }

    override fun speakChunks(
        generation: Long,
        chunks: List<VoiceTtsChunkDto>,
        fallbackText: String,
        onFinished: (Long) -> Unit,
        onInterrupted: (Long, Int) -> Unit,
    ) {
        val speakable = chunks.filter { it.text.isNotBlank() }.ifEmpty {
            if (fallbackText.isNotBlank()) listOf(VoiceTtsChunkDto(chunkIndex = 0, text = fallbackText, isFinal = true))
            else emptyList()
        }
        if (speakable.isEmpty() || !_ready.value || tts == null) {
            onFinished(generation)
            return
        }
        val focusGranted = runCatching {
            audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }.getOrDefault(false)
        if (!focusGranted) {
            onFinished(generation)
            return
        }
        synchronized(lock) {
            val prevGen = _activeGeneration.value
            if (prevGen > 0L && prevGen != generation) {
                cancelledGenerations += prevGen
            }
            cancelledGenerations.remove(generation)
            _activeGeneration.value = generation
            _currentChunkIndex.value = speakable.first().chunkIndex
            lastChunkIndexForActiveGen = speakable.last().chunkIndex
            finishCallback = onFinished
            interruptCallback = onInterrupted
            _isSpeaking.value = true
        }
        speakable.forEachIndexed { index, chunk ->
            val mode = if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            val utteranceId = "butler:$generation:${chunk.chunkIndex}"
            tts?.speak(chunk.text, mode, null, utteranceId)
        }
    }

    override fun stopImmediately(reason: String): Pair<Long, Int> {
        val prevGen: Long
        val prevChunk: Int
        var cb: ((Long, Int) -> Unit)? = null
        synchronized(lock) {
            prevGen = _activeGeneration.value
            prevChunk = _currentChunkIndex.value
            if (prevGen > 0L) {
                cancelledGenerations += prevGen
            }
            if (_isSpeaking.value) {
                cb = interruptCallback
            }
            _isSpeaking.value = false
            finishCallback = null
            interruptCallback = null
        }
        runCatching { tts?.stop() }
        runCatching { audioManager.abandonAudioFocusRequest(focusRequest) }
        cb?.invoke(prevGen, prevChunk)
        return prevGen to prevChunk
    }

    override fun shutdown() {
        stopImmediately("shutdown")
        runCatching { tts?.shutdown() }
        tts = null
        _ready.value = false
    }

    private fun parseUtteranceId(id: String?): Pair<Long, Int>? {
        if (id == null || !id.startsWith("butler:")) return null
        val parts = id.split(':')
        if (parts.size != 3) return null
        val gen = parts[1].toLongOrNull() ?: return null
        val idx = parts[2].toIntOrNull() ?: return null
        return gen to idx
    }
}
