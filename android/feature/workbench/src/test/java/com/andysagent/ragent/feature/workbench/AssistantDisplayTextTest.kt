package com.andysagent.ragent.feature.workbench

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AssistantDisplayTextTest {
    @Test fun metadataIsHiddenAtEveryTokenBoundaryAndVisibleReplyIsPreserved() {
        for (tag in listOf("session-labels", "organization-proposal", "collaboration-plan", "result-packet")) {
            val block = "<ragent-$tag>{\"title\":\"Internal\"}</ragent-$tag>"
            for (length in 0..block.length) {
                assertEquals("Hello", displayAgentMessageText("Hello\n" + block.take(length)))
            }
            assertEquals("Hello\n\nMore", displayAgentMessageText("Hello\n$block\nMore"))
        }
    }

    @Test fun malformedMultipleAndCaseInsensitiveEnvelopesStayInternal() {
        assertEquals("Reply", displayAgentMessageText("Reply<RAGENT-SESSION-LABELS>{\"partial\":"))
        assertEquals("Reply", displayAgentMessageText("Reply<ragent-session-labels>{}</ragent-session-labels><ragent-result-packet>{}</ragent-result-packet>"))
        assertFalse(displayAgentMessageText("<ragent-session-labels>{}</ragent-session-labels>").isNotBlank())
    }

    @Test fun normalMarkdownAndMathArePreserved() {
        val normal = "**Hello**\n\n```kotlin\nif (x < 3) println(x)\n```"
        assertEquals(normal, displayAgentMessageText(normal))
    }
}
