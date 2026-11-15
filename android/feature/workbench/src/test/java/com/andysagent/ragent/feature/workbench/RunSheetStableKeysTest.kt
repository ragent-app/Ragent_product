package com.andysagent.ragent.feature.workbench

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class RunSheetStableKeysTest {
    @Test fun `repeated paths and step labels have unique keys`() {
        val values = listOf("Editing file", "Editing file", "1:tool", "1:tool", "1:tool:0", "")
        val keys = runSheetOccurrenceKeys(values) { it }
        assertEquals(values.size, keys.toSet().size)
        assertNotEquals(keys[0], keys[1])
        assertNotEquals(keys[2], keys[3])
    }

    @Test fun `appending repeated entries preserves existing keys`() {
        val before = listOf("a", "b", "a")
        val after = before + listOf("a", "b")
        assertEquals(runSheetOccurrenceKeys(before) { it }, runSheetOccurrenceKeys(after) { it }.take(before.size))
    }
}
