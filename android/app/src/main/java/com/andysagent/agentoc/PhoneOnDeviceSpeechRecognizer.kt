package com.andysagent.agentoc

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import java.util.Locale
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/** Uses only Android's on-device recognizer API. It never falls back to the network recognizer. */
internal class PhoneOnDeviceSpeechRecognizer(context: Context) {
    private val appContext = context.applicationContext
    private var recognizer: SpeechRecognizer? = null

    fun isAvailable(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext)

    /** Returns whether the current phone provider has the requested locale installed, or null when unknown. */
    suspend fun hasInstalledLanguage(locale: Locale): Boolean? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !isAvailable()) return null
        return suspendCancellableCoroutine { continuation ->
            val request = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale.toLanguageTag())
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            }
            val query = Runnable {
                val localRecognizer = runCatching { SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext) }
                    .getOrNull()
                if (localRecognizer == null) {
                    if (continuation.isActive) continuation.resume(null)
                    return@Runnable
                }
                continuation.invokeOnCancellation { runCatching { localRecognizer.cancel() }; runCatching { localRecognizer.destroy() } }
                try {
                    localRecognizer.checkRecognitionSupport(
                        request,
                        ContextCompat.getMainExecutor(appContext),
                        object : RecognitionSupportCallback {
                            override fun onSupportResult(recognitionSupport: RecognitionSupport) {
                                val installed = recognitionSupport.installedOnDeviceLanguages
                                if (continuation.isActive) continuation.resume(
                                    installed.any { supported -> matchesLanguage(supported, locale.toLanguageTag()) },
                                )
                                runCatching { localRecognizer.destroy() }
                            }

                            override fun onError(error: Int) {
                                if (continuation.isActive) continuation.resume(null)
                                runCatching { localRecognizer.destroy() }
                            }
                        },
                    )
                } catch (_: RuntimeException) {
                    if (continuation.isActive) continuation.resume(null)
                    runCatching { localRecognizer.destroy() }
                }
            }
            if (Looper.myLooper() == Looper.getMainLooper()) query.run()
            else Handler(Looper.getMainLooper()).post(query)
        }
    }

    fun start(languageTag: String? = null, onResult: (String) -> Unit, onError: (Int) -> Unit, onLevel: (Float) -> Unit = {}) {
        if (!isAvailable()) {
            onError(SpeechRecognizer.ERROR_CLIENT)
            return
        }
        stop(destroy = true, cancel = true)
        val localRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext)
        recognizer = localRecognizer
        localRecognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) {
                onLevel(((rmsdB + 2f) / 14f).coerceIn(0f, 1f))
            }
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
            override fun onPartialResults(partialResults: Bundle?) = Unit

            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()?.trim().orEmpty()
                if (text.isBlank()) onError(SpeechRecognizer.ERROR_NO_MATCH) else onResult(text)
                stop(destroy = true)
            }

            override fun onError(error: Int) {
                onError(error)
                stop(destroy = true)
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag?.takeIf { it != "auto" } ?: Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        }
        try {
            localRecognizer.startListening(intent)
        } catch (error: RuntimeException) {
            stop(destroy = true, cancel = true)
            onError(SpeechRecognizer.ERROR_CLIENT)
        }
    }

    fun stop(destroy: Boolean = false, cancel: Boolean = false) {
        val localRecognizer = recognizer ?: return
        if (cancel || destroy) recognizer = null
        if (cancel) runCatching { localRecognizer.cancel() } else runCatching { localRecognizer.stopListening() }
        if (destroy) runCatching { localRecognizer.destroy() }
    }

    private fun matchesLanguage(supportedTag: String, requestedTag: String): Boolean {
        val supported = Locale.forLanguageTag(supportedTag)
        val requested = Locale.forLanguageTag(requestedTag)
        return supported.language.equals(requested.language, ignoreCase = true)
    }
}
