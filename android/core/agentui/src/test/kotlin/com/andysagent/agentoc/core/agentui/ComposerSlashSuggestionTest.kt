package com.andysagent.agentoc.core.agentui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ComposerSlashSuggestionTest {
    @Test
    fun slashQueryTracksOnlyTheTrailingToken() {
        assertEquals("", composerSlashQuery("/"))
        assertEquals("claude:review", composerSlashQuery("Please check /claude:review"))
        assertNull(composerSlashQuery("/review with spaces"))
        assertNull(composerSlashQuery("ordinary draft"))
    }

    @Test
    fun selectingSuggestionReplacesOnlyTheTrailingSlashToken() {
        assertEquals("Keep this /review ", replaceComposerSlashToken("Keep this /rev", "/review "))
        assertNull(replaceComposerSlashToken("Keep this review", "/review "))
    }

    @Test
    fun attachingCapabilityRemovesOnlyTheTrailingSlashToken() {
        assertEquals("Keep this", clearComposerSlashToken("Keep this /mcp"))
        assertEquals("", clearComposerSlashToken("/agentoc"))
        assertNull(clearComposerSlashToken("Keep this /mcp name"))
    }
}
