package com.andysagent.ragent.core.domain

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull

class RuntimeProviderFamilyTest {
    @Test fun nativeAliasesMatchTheWebProviderRegistry() {
        assertEquals("codex", runtimeProviderFamily("codex-cli"))
        assertEquals("claude", runtimeProviderFamily("claude-bidi"))
        assertEquals("agy", runtimeProviderFamily("agy"))
        assertEquals("codex", runtimeProviderFamily("custom", "codex-app-server"))
        assertNull(runtimeProviderFamily("direct-runtime"))
    }
}
