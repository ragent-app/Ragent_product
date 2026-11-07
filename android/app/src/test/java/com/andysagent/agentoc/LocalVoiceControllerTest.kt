package com.andysagent.agentoc

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class LocalVoiceControllerTest {
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
