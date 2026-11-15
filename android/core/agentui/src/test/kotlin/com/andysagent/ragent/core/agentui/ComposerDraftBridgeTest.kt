package com.andysagent.ragent.core.agentui

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ComposerDraftBridgeTest {
    @Test fun parserWhitespaceCleanupIsNotMarkup() {
        assertFalse(hasComposerMarkupTransformation("word ", "word"))
        assertFalse(hasComposerMarkupTransformation("  first\n\nlast  ", "first\nlast"))
        assertFalse(hasComposerMarkupTransformation("\u3000中文\u3000", "中文"))
        assertTrue(hasComposerMarkupTransformation("**bold**", "bold"))
        assertTrue(hasComposerMarkupTransformation("`code`", "code"))
        assertTrue(hasComposerMarkupTransformation("## Heading", "Heading"))
    }

    @Test fun delayedAndCoalescedEchoesAreAcknowledgedInOrder() {
        val echoes = ComposerDraftEchoes()
        echoes.record("A")
        echoes.record("AB")
        echoes.record("ABC")
        assertTrue(echoes.acknowledge("A"))
        assertTrue(echoes.acknowledge("ABC"))
        assertFalse(echoes.acknowledge("AB"))
    }

    @Test fun unknownExternalChangesAndClearStayAuthoritative() {
        val echoes = ComposerDraftEchoes()
        echoes.record("draft")
        assertFalse(echoes.acknowledge(""))
        assertFalse(echoes.acknowledge("another draft"))
        echoes.clear()
        assertFalse(echoes.acknowledge("draft"))
    }

    @Test fun ownersThatDoNotEchoCannotRetainAnUnboundedHistory() {
        val echoes = ComposerDraftEchoes()
        repeat(100) { echoes.record("draft $it") }
        assertFalse(echoes.acknowledge("draft 0"))
        assertTrue(echoes.acknowledge("draft 68"))
        assertTrue(echoes.acknowledge("draft 99"))
    }
}
