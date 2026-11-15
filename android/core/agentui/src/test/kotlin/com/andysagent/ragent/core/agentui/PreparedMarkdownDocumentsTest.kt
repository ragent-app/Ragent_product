package com.andysagent.ragent.core.agentui

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PreparedMarkdownDocumentsTest {
    @Test fun `entry preparation preserves the complete grammar and deduplicates only identical bodies`() = runBlocking {
        val body = "## Outcome\n\nReviewed **all sources**.\n\n```kotlin\nprintln(1)\n```\n\n- Keep originals\n- Check output"
        val documents = prepareMarkdownDocuments(listOf(body, body, "A different reply", ""))
        assertEquals(3, documents.size)
        assertEquals(parseBlocksFast(body), documents[body])
        assertTrue(documents.getValue(body).any { it is MarkdownBlock.Heading })
        assertTrue(documents.getValue(body).any { it is MarkdownBlock.Code })
        assertEquals(emptyList(), documents[""])
    }
}
