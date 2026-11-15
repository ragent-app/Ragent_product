package com.andysagent.ragent.core.agentui

import androidx.activity.ComponentActivity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.mohamedrejeb.richeditor.model.RichTextState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Retained CoreTextField callbacks must keep their document, including styles. */
class RichTextTransformationSnapshotTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Suppress("INVISIBLE_MEMBER", "INVISIBLE_REFERENCE")
    private fun transformation(state: RichTextState): VisualTransformation = state.visualTransformation

    @Test fun retainedTransformDoesNotReadANewerTypedDocument() = verify(false)
    @Test fun retainedTransformDoesNotReadANewerRestoredDocument() = verify(true)

    private fun verify(restore: Boolean) {
        val state = RichTextState()
        rule.setContent {
            snapshotRichTextTransformation(state)
        }
        rule.waitForIdle()
        repeat(12) { index ->
            // Read the actual field callback. The adapter can recompose without
            // its parent, so a parent SideEffect is not a publication observer.
            val oldTransform = transformation(state)
            val oldDocument = state.annotatedString
            val next = if (index % 3 == 0) "" else if (restore) "**Bold $index**\n`code`" else "Draft $index 中文"
            rule.runOnIdle {
                if (restore) state.setMarkdown(next) else state.setText(next)
                // CoreTextField may evaluate its retained value before the
                // wrapper recomposes. Invoke precisely in that window.
                val retained = oldTransform.filter(AnnotatedString(oldDocument.text))
                assertEquals("Retained transform changed document before recomposition", oldDocument, retained.text)
                assertEquals(oldDocument.length, retained.offsetMapping.transformedToOriginal(oldDocument.length))
            }
            rule.waitForIdle()
            val current = transformation(state).filter(AnnotatedString(state.annotatedString.text))
            assertEquals("Current transform lost rich annotations", state.annotatedString, current.text)
        }
    }
}
