package com.andysagent.agentoc.feature.workbench

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

class VoiceRoutingTest {
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
