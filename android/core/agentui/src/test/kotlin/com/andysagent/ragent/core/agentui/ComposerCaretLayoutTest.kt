package com.andysagent.ragent.core.agentui

import androidx.compose.ui.geometry.Rect
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ComposerCaretLayoutTest {
    @Test fun shrinkingViewportKeepsTheLastLineVisible() {
        val cursor = Rect(0f, 400f, 2f, 440f)
        var scroll = 0
        for (height in 500 downTo 80) {
            scroll = composerCaretScrollTarget(cursor, 6, height, scroll, 446 - height.coerceAtMost(446))
            assertTrue(cursor.bottom + 6 - scroll <= height)
        }
    }

    @Test fun shortViewportDoesNotOscillateBetweenImpossibleMargins() {
        val cursor = Rect(0f, 400f, 2f, 440f)
        val first = composerCaretScrollTarget(cursor, 6, 50, 0, 400)
        assertEquals(first, composerCaretScrollTarget(cursor, 6, 50, first, 400))
        assertTrue(cursor.top + 6 - first >= 0)
        assertTrue(cursor.bottom + 6 - first <= 50)
    }

    @Test fun cursorInsideViewportDoesNotMoveTheDocument() {
        assertEquals(100, composerCaretScrollTarget(Rect(0f, 160f, 2f, 190f), 6, 180, 100, 500))
    }

    @Test fun movingSelectionToTheStartReturnsToZero() {
        assertEquals(0, composerCaretScrollTarget(Rect(0f, 0f, 2f, 40f), 6, 120, 400, 500))
    }
}
