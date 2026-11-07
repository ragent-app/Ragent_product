package com.andysagent.agentoc

import kotlin.test.Test
import kotlin.test.assertEquals

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
}
