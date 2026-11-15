package com.andysagent.ragent.core.datastore

import kotlin.test.*

class ShareRuntimePreferencesTest {
    @Test fun selectionsRoundTripIndependentlyByComputer() {
        val values = mapOf("a" to ShareRuntimeSelection("codex", "local-a", "model-a"),
            "b" to ShareRuntimeSelection("other", model = "model-b"))
        assertEquals(values, ShareRuntimeCodec.decode(ShareRuntimeCodec.encode(values)))
        assertEquals(emptyMap(), ShareRuntimeCodec.decode(null))
    }

    @Test fun malformedFutureAndIncompletePreferencesAreNotRestored() {
        for (raw in listOf("{", "{\"version\":2}", "{\"byTarget\":{\"a\":{\"tool\":\"tool\"}}}",
            "{\"byTarget\":{\"a\":{\"tool\":\"tool\",\"model\":\"\"}}}", "x".repeat(256_001))) {
            assertTrue(ShareRuntimeCodec.decode(raw).isEmpty())
        }
        assertFailsWith<IllegalArgumentException> { ShareRuntimeCodec.encode(mapOf("a" to ShareRuntimeSelection("tool", model = "\n"))) }
    }

    @Test fun newOptionalFieldsDoNotBreakExistingSelection() {
        val raw = """{"version":1,"byTarget":{"a":{"tool":"tool","model":"model","future":true}},"future":true}"""
        assertEquals(mapOf("a" to ShareRuntimeSelection("tool", model = "model")), ShareRuntimeCodec.decode(raw))
    }
}
