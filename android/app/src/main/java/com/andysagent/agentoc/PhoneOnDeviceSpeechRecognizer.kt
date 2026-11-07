package com.andysagent.agentoc

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.util.Locale

/** Uses only Android's on-device recognizer API. It never falls back to the network recognizer. */
internal class PhoneOnDeviceSpeechRecognizer(context: Context) {
    private val appContext = context.applicationContext
    private var recognizer: SpeechRecognizer? = null

    fun isAvailable(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext)

    fun start(onResult: (String) -> Unit, onError: (String) -> Unit) {
        if (!isAvailable()) {
            onError("On-device speech recognition is unavailable on this phone")
            return
        }
        stop(destroy = true, cancel = true)
        val localRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext)
        recognizer = localRecognizer
        localRecognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
            override fun onPartialResults(partialResults: Bundle?) = Unit

            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()?.trim().orEmpty()
                if (text.isBlank()) onError("No speech was recognized") else onResult(text)
                stop(destroy = true)
            }

            override fun onError(error: Int) {
                onError(errorMessage(error))
                stop(destroy = true)
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        }
        try {
            localRecognizer.startListening(intent)
        } catch (error: RuntimeException) {
            stop(destroy = true, cancel = true)
            onError(error.message ?: "Could not start on-device speech recognition")
        }
    }

    fun stop(destroy: Boolean = false, cancel: Boolean = false) {
        val localRecognizer = recognizer ?: return
        recognizer = null
        if (cancel) runCatching { localRecognizer.cancel() } else runCatching { localRecognizer.stopListening() }
        if (destroy) runCatching { localRecognizer.destroy() }
    }

    private fun errorMessage(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "Phone microphone could not be read"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is required"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "On-device recognition provider reported a network error"
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech was recognized"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Phone speech recognizer is busy"
        else -> "On-device speech recognition failed ($error)"
    }
}
