package com.andysagent.ragent.core.agentui

import org.junit.Assert.*
import org.junit.Test

class RetainedPickerContentTest {
    @Test fun `closing ignores rolled back selection and keeps the last visible page`() {
        val retained = RetainedPickerContent("runtime")
        retained.frame(true, "model A")
        assertEquals("model A", retained.frame(false, "runtime B"))
        assertEquals("model A", retained.frame(false, "runtime C"))
    }

    @Test fun `reopening starts one fresh host even during exit`() {
        val retained = RetainedPickerContent("runtime")
        retained.frame(true, "provider A")
        assertEquals(1, retained.generation)
        retained.frame(true, "model A")
        assertEquals(1, retained.generation)
        retained.frame(false, "runtime")
        assertEquals("runtime", retained.frame(true, "runtime"))
        assertEquals(2, retained.generation)
        retained.frame(true, "provider B")
        assertEquals(2, retained.generation)
    }

    @Test fun `live updates are visible only while open`() {
        val retained = RetainedPickerContent("loading")
        retained.frame(true, "loading")
        assertEquals("models", retained.frame(true, "models"))
        assertEquals("models", retained.frame(false, "loading"))
    }
}
