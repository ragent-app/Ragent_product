package com.andysagent.agentoc

import android.speech.SpeechRecognizer
import com.andysagent.agentoc.feature.workbench.R
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class LocalVoiceControllerTest {
    @Test
    fun unsupportedSystemRecognizerCheckSuggestsTheOfflineMultilingualModel() {
        assertEquals(
            R.string.voice_error_support_check_failed,
            phoneRecognitionErrorStringResource(SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT),
        )
    }

    @Test
    fun missingMicrophonePermissionGetsAnActionableMessage() {
        assertEquals(
            R.string.voice_error_microphone_permission,
            phoneRecognitionErrorStringResource(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS),
        )
    }

    @Test
    fun stoppingComputerCaptureFinalizesRecordingInsteadOfCancellingRecognition() {
        assertEquals(
            VoiceStopAction.FinishComputerRecording,
            voiceStopAction(recording = true, processing = false, computerRoute = true),
        )
    }

    @Test
    fun stoppingPhoneCaptureStopsTheOnDeviceRecognizer() {
        assertEquals(
            VoiceStopAction.StopPhoneRecording,
            voiceStopAction(recording = true, processing = false, computerRoute = false),
        )
    }

    @Test
    fun stoppingDuringTranscriptionCancelsTheActiveRequest() {
        assertEquals(
            VoiceStopAction.CancelProcessing,
            voiceStopAction(recording = false, processing = true, computerRoute = true),
        )
    }

    @Test
    fun stopWhileIdleDoesNothing() {
        assertEquals(
            VoiceStopAction.NoOp,
            voiceStopAction(recording = false, processing = false, computerRoute = false),
        )
    }

    @Test
    fun emptyAndWhisperSilenceMarkersDoNotBecomeDraftText() {
        assertNull(usableComputerVoiceTranscript(null))
        assertNull(usableComputerVoiceTranscript("  "))
        assertNull(usableComputerVoiceTranscript("[BLANK_AUDIO]"))
        assertNull(usableComputerVoiceTranscript("[ Silence ]"))
    }

    @Test
    fun recognizedComputerSpeechIsTrimmedAndPreserved() {
        assertEquals("Ragent voice test", usableComputerVoiceTranscript("  Ragent voice test  "))
    }
}
