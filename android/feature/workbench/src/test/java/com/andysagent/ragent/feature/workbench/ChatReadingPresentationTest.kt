package com.andysagent.ragent.feature.workbench

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChatReadingPresentationTest {
    @Test fun `island expansion only controls side button space`() {
        val geometry = ChatTopControlGeometry()
        assertEquals(1f, geometry.sideControlsSpace())
        listOf(-1f to 0f, .3f to .3f, .7f to .7f, 2f to 1f).forEach { (input, expected) ->
            geometry.measureSideControls(input)
            assertEquals(expected, geometry.sideControlsSpace())
        }
    }

    @Test fun `writing context exits before edit title and reverses on the same phase`() {
        assertEquals(1f, chatWritingContextAlpha(0f))
        assertEquals(.5f, chatWritingContextAlpha(.175f))
        assertEquals(0f, chatWritingContextAlpha(.35f))
        assertEquals(0f, chatWritingContextAlpha(1f))
        for (p in (0..100).map { it / 100f }) {
            assertTrue(chatWritingContextAlpha(p) in 0f..1f)
            if (p >= .35f) assertEquals(0f, chatWritingContextAlpha(p))
        }
    }

    @Test fun `loading and readable content share a non overlapping continuous handoff`() {
        (0..100).map { it / 100f }.forEach { progress ->
            val loading = chatPreparingAlpha(progress)
            val reading = chatReadingAlpha(progress)
            assertTrue(loading in 0f..1f && reading in 0f..1f)
            assertEquals(0f, loading * reading)
        }
        assertEquals(1f, chatPreparingAlpha(0f))
        assertEquals(0f, chatReadingAlpha(0f))
        assertEquals(0.5f, chatReadingAlpha(0.625f))
        assertEquals(1f, chatReadingAlpha(1f))
    }
}
