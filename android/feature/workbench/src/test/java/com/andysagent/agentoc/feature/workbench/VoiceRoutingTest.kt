package com.andysagent.agentoc.feature.workbench

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

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
    fun automaticPrefersTheSessionComputerThenFallsBackToEnabledPhone() {
        assertEquals(
            VoiceDestination.Computer("pc-a"),
            resolveVoiceDestination("auto", "pc-a", true, true, listOf(readyComputer)),
        )
        assertEquals(
            VoiceDestination.Phone,
            resolveVoiceDestination("auto", "pc-b", true, true, listOf(readyComputer)),
        )
    }

    @Test
    fun automaticKeepsAnEnabledSessionComputerSelectedWhileWhisperStarts() {
        val startingComputer = readyComputer.copy(running = false, ready = false)
        assertEquals(
            VoiceDestination.Computer("pc-a"),
            resolveVoiceDestination("auto", "pc-a", true, true, listOf(startingComputer)),
        )
    }

    @Test
    fun automaticNeverSelectsAnUnrelatedComputerWithoutAnExplicitChoice() {
        val result = resolveVoiceDestination("auto", "pc-b", false, false, listOf(readyComputer))
        assertIs<VoiceDestination.Unavailable>(result)
    }

    @Test
    fun automaticFallsBackToTheSessionComputerWhenPhoneLanguageIsUnavailable() {
        assertEquals(
            VoiceDestination.Computer("pc-a"),
            resolveVoiceDestination("auto", "pc-a", true, false, listOf(readyComputer)),
        )
    }

    @Test
    fun installedPhoneWhisperCanRouteEvenWhenTheSystemRecognizerCannotHandleItsLocale() {
        assertEquals(
            VoiceDestination.Phone,
            resolveVoiceDestination("phone", "pc-a", true, true, emptyList()),
        )
    }

    @Test
    fun manualComputerFailureDoesNotSilentlySwitchToThePhone() {
        val result = resolveVoiceDestination("computer:pc-a", "pc-a", true, true, emptyList())
        assertIs<VoiceDestination.Unavailable>(result)
    }

    @Test
    fun disabledPhoneCannotBeSelected() {
        val result = resolveVoiceDestination("phone", "pc-a", false, true, listOf(readyComputer))
        assertIs<VoiceDestination.Unavailable>(result)
    }
}
