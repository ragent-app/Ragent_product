package com.andysagent.agentoc.feature.workbench

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

class VoiceRoutingTest {

    @Test
    fun missingComputerVoiceEndpointDetectsHttpAndTransport404() {
        assertTrue(isMissingComputerVoiceEndpoint(404, null))
        assertTrue(isMissingComputerVoiceEndpoint(null, "Agentoc request failed (404)"))
        assertFalse(isMissingComputerVoiceEndpoint(500, "Agentoc request failed (500)"))
    }

    private val readyComputer = VoiceComputerState(
        targetId = "pc-a",
        label = "Office PC",
        connected = true,
        installed = true,
        enabled = true,
        running = true,
        ready = true,
    )

    @Test
    fun automaticPrefersTheSessionComputerThenFallsBackToPhone() {
        assertEquals(
            VoiceDestination.Computer("pc-a"),
            resolveVoiceDestination("auto", "pc-a", true, listOf(readyComputer)),
        )
        assertEquals(
            VoiceDestination.Phone,
            resolveVoiceDestination("auto", "pc-b", true, listOf(readyComputer)),
        )
    }

    @Test
    fun automaticKeepsAnEnabledSessionComputerSelectedWhileWhisperStarts() {
        val startingComputer = readyComputer.copy(running = false, ready = false)
        assertEquals(
            VoiceDestination.Computer("pc-a"),
            resolveVoiceDestination("auto", "pc-a", true, listOf(startingComputer)),
        )
    }

    @Test
    fun automaticNeverSelectsAnUnrelatedComputerWithoutAnExplicitChoice() {
        val result = resolveVoiceDestination("auto", "pc-b", false, listOf(readyComputer))
        assertIs<VoiceDestination.Unavailable>(result)
    }

    @Test
    fun automaticPrefersSessionComputerWhenPhoneRecognitionIsUnavailable() {
        assertEquals(
            VoiceDestination.Computer("pc-a"),
            resolveVoiceDestination("auto", "pc-a", false, listOf(readyComputer)),
        )
    }

    @Test
    fun manualComputerFailureDoesNotSilentlySwitchToThePhone() {
        val result = resolveVoiceDestination("computer:pc-a", "pc-a", true, emptyList())
        assertIs<VoiceDestination.Unavailable>(result)
    }

    @Test
    fun phoneCannotBeSelectedWhenSystemRecognitionIsUnavailable() {
        val result = resolveVoiceDestination("phone", "pc-a", false, listOf(readyComputer))
        assertIs<VoiceDestination.Unavailable>(result)
    }

    @Test
    fun cloudRecognitionIsOnlySelectedExplicitlyAndRequiresAvailability() {
        assertEquals(
            VoiceDestination.Cloud,
            resolveVoiceDestination("cloud", "pc-a", true, listOf(readyComputer), cloudAvailable = true),
        )
        assertIs<VoiceDestination.Unavailable>(
            resolveVoiceDestination("cloud", "pc-a", true, listOf(readyComputer), cloudAvailable = false),
        )
        assertEquals(
            VoiceDestination.Computer("pc-a"),
            resolveVoiceDestination("auto", "pc-a", false, listOf(readyComputer), cloudAvailable = true),
            "Automatic mode must not upload audio to cloud recognition without an explicit choice",
        )
    }

    @Test
    fun recordingOrUploadDoesNotStartWhenFreshConsentOrAvailabilityIsMissing() = runBlocking {
        var actionsStarted = 0
        listOf(
            CloudVoiceAccess.ConsentRequired,
            CloudVoiceAccess.QuotaExceeded,
            CloudVoiceAccess.Unavailable,
        ).forEach { access ->
            val result = runCloudVoiceActionIfAuthorized(
                readCurrentAccess = { access },
                action = { actionsStarted += 1 },
            )
            assertEquals(CloudVoiceActionResult.Denied(access), result)
        }
        assertEquals(0, actionsStarted)
    }

    @Test
    fun cloudActionStartsOnlyAfterFreshConsentAndQuotaCheckPasses() = runBlocking {
        var actionsStarted = 0
        val result = runCloudVoiceActionIfAuthorized(
            readCurrentAccess = { CloudVoiceAccess.Allowed },
            action = { actionsStarted += 1; "started" },
        )
        assertEquals(CloudVoiceActionResult.Allowed("started"), result)
        assertEquals(1, actionsStarted)
    }

    @Test
    fun consentRevokedDuringRecordingPreventsCloudUpload() = runBlocking {
        var access = CloudVoiceAccess.Allowed
        var recordingStarted = false
        var uploadsStarted = 0

        val beforeRecording = runCloudVoiceActionIfAuthorized(
            readCurrentAccess = { access },
            action = { recordingStarted = true },
        )
        assertIs<CloudVoiceActionResult.Allowed<Unit>>(beforeRecording)
        assertTrue(recordingStarted)

        access = CloudVoiceAccess.ConsentRequired
        val beforeUpload = runCloudVoiceActionIfAuthorized(
            readCurrentAccess = { access },
            action = { uploadsStarted += 1 },
        )
        assertEquals(CloudVoiceActionResult.Denied(CloudVoiceAccess.ConsentRequired), beforeUpload)
        assertEquals(0, uploadsStarted)
    }
}
