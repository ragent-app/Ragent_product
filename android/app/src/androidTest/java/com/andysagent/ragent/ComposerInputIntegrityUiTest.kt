package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.PlatformTextInputInterceptor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextLayoutResult
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import kotlinx.coroutines.awaitCancellation
import com.andysagent.ragent.core.agentui.MarkdownComposerEditor
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The production editor bridge must not rewrite an unfinished draft. */
@OptIn(ExperimentalComposeUiApi::class)
class ComposerInputIntegrityUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private var controlledIme = false
    private var inputConnection: InputConnection? = null
    private var editorLayout: TextLayoutResult? = null

    @Test fun restoredMultilineMarkupKeepsEveryCharacterAndLine() {
        val source = "第一行\n第二行\n第三行\n第四行\n第五行\n**Important**: verify `healthz`"
        val rendered = "第一行\n第二行\n第三行\n第四行\n第五行\nImportant: verify healthz"
        val draft = mutableStateOf(source)
        render(draft)
        val editor = compose.onNode(hasSetTextAction())
        assertFormattedLines(rendered.lines())
        compose.runOnIdle { assertEquals(source, draft.value) }
        editor.performTextInput(" next")
        assertFormattedLines("$rendered next".lines())
        compose.runOnIdle {
            // Restoring an existing code run leaves the caret in that run;
            // unlike typing a closing delimiter, it does not clear its style.
            assertEquals(source.replace("`healthz`", "`healthz next`").lines(),
                draft.value.lines().filter(String::isNotBlank))
        }
        compose.runOnIdle { draft.value = "**Replacement**\nwith `complete-code`" }
        assertFormattedLines(listOf("Replacement", "with complete-code"))
        editor.performTextInput(" tail")
        assertFormattedLines(listOf("Replacement", "with complete-code tail"))
        compose.runOnIdle {
            assertEquals(listOf("**Replacement**", "with `complete-code tail`"), draft.value.lines().filter(String::isNotBlank))
        }
    }

    private fun assertFormattedLines(lines: List<String>) {
        // rc10 uses a space separator plus ParagraphStyle boundaries for a
        // parsed multi-paragraph document. Assert every character and painted
        // line; the serialized Markdown assertions separately check newlines.
        compose.onNode(hasSetTextAction()).assertTextEquals(lines.joinToString(" "))
        compose.runOnIdle {
            val layout = requireNotNull(editorLayout)
            var offset = 0
            var previousLineEnd = -1
            lines.forEach { line ->
                val firstLine = layout.getLineForOffset(offset)
                assertTrue("paragraph must start below the preceding paragraph", firstLine > previousLineEnd)
                previousLineEnd = layout.getLineForOffset(offset + line.length - 1)
                offset += line.length + 1
            }
        }
    }

    @Test fun typingWordsPreservesSeparatingAndTrailingSpaces() {
        val draft = mutableStateOf("")
        render(draft)
        val editor = compose.onNode(hasSetTextAction())
        editor.performTextInput("Visual")
        editor.performTextInput(" ")
        editor.assertTextEquals("Visual ")
        editor.performTextInput("check")
        editor.performTextInput(" ")
        editor.performTextInput("only")
        editor.assertTextEquals("Visual check only")
        compose.runOnIdle { assertEquals("Visual check only", draft.value) }
    }

    @Test fun singleCommitSentenceIsNotAnAdequateSubstituteForTypingWords() {
        val draft = mutableStateOf("")
        render(draft)
        compose.onNode(hasSetTextAction()).performTextInput("ABC DEF GHI")
        compose.onNode(hasSetTextAction()).assertTextEquals("ABC DEF GHI")
        compose.runOnIdle { assertEquals("ABC DEF GHI", draft.value) }
    }

    @Test fun delayedParentEchoDoesNotRollBackNewerLocalText() {
        val draft = mutableStateOf("")
        val emitted = mutableListOf<String>()
        render(draft) { emitted += it }
        val editor = compose.onNode(hasSetTextAction())
        editor.performTextInput("Alpha")
        compose.runOnIdle { assertEquals("Alpha", emitted.last()) }
        editor.performTextInput("Beta")
        compose.runOnIdle { assertEquals("AlphaBeta", emitted.last()); draft.value = "Alpha" }
        editor.assertTextEquals("AlphaBeta")
        compose.runOnIdle { draft.value = "AlphaBeta" }
        editor.assertTextEquals("AlphaBeta")
    }

    @Test fun externalClearAndReplacementRemainAuthoritative() {
        val draft = mutableStateOf("Restored draft")
        render(draft)
        val editor = compose.onNode(hasSetTextAction())
        editor.assertTextEquals("Restored draft")
        editor.performTextInput(" plus text")
        compose.runOnIdle { draft.value = "" }
        editor.assertTextEquals("")
        editor.performTextInput("New draft")
        compose.runOnIdle { assertEquals("New draft", draft.value); draft.value = "Another session" }
        editor.assertTextEquals("Another session")
    }

    @Test fun formattedRunCanBeFollowedByASpaceAndAnotherWord() {
        val draft = mutableStateOf("")
        render(draft)
        val editor = compose.onNode(hasSetTextAction())
        editor.performTextInput("**bold**")
        editor.assertTextEquals("bold")
        editor.performTextInput(" ")
        editor.performTextInput("next")
        editor.assertTextEquals("bold next")
        compose.runOnIdle { assertEquals("**bold** next", draft.value) }
    }

    @Test fun blankPrefixAndPlainDraftWhitespaceSurviveEditingAndRestore() {
        val draft = mutableStateOf("")
        render(draft)
        val editor = compose.onNode(hasSetTextAction())
        editor.performTextInput("  ")
        editor.assertTextEquals("  ")
        compose.runOnIdle { assertEquals("  ", draft.value) }
        editor.performTextInput("line one\n\nline two  ")
        editor.assertTextEquals("  line one\n\nline two  ")
        compose.runOnIdle {
            assertEquals("  line one\n\nline two  ", draft.value)
            draft.value = "  restored\nlast line  "
        }
        editor.assertTextEquals("  restored\nlast line  ")
        editor.performTextInput("tail")
        editor.assertTextEquals("  restored\nlast line  tail")
    }

    @OptIn(ExperimentalTestApi::class)
    @Test fun insertingSpaceInTheMiddleKeepsCaretAndSurroundingText() {
        val draft = mutableStateOf("AlphaBeta")
        render(draft)
        val editor = compose.onNode(hasSetTextAction())
        editor.performTextInputSelection(TextRange(5))
        editor.performTextInput(" ")
        editor.performTextInput("new ")
        editor.assertTextEquals("Alpha new Beta")
        compose.runOnIdle { assertEquals("Alpha new Beta", draft.value) }
    }

    @Test fun imeCompositionIsNotReparsedUntilCommitted() {
        val draft = mutableStateOf("")
        controlledIme = true
        render(draft)
        val editor = compose.onNode(hasSetTextAction())
        editor.performClick()
        compose.waitUntil(5_000) { inputConnection != null }
        val connection = inputConnection
        assertNotNull("focused production editor must expose an input connection", connection)
        compose.runOnIdle { connection!!.setComposingText("**中文**", 1) }
        editor.assertTextEquals("**中文**")
        compose.runOnIdle { connection!!.finishComposingText() }
        editor.assertTextEquals("中文")
        editor.performTextInput(" 后续")
        editor.assertTextEquals("中文 后续")
        compose.runOnIdle { assertEquals("**中文** 后续", draft.value) }
    }

    @Test fun replacingParsedParagraphsKeepsTheNewDocumentEditable() {
        val draft = mutableStateOf("First\n**Bold**\n`code`")
        render(draft)
        val editor = compose.onNode(hasSetTextAction())
        editor.performTextReplacement("Short")
        editor.assertTextEquals("Short")
        compose.runOnIdle { assertEquals("Short", draft.value) }
        editor.performTextClearance()
        editor.assertTextEquals("")
        editor.performTextInput("New draft")
        editor.assertTextEquals("New draft")
        compose.runOnIdle { assertEquals("New draft", draft.value) }
    }

    @Test fun externalPlainReplacementOfMarkupKeepsWhitespaceAndNewlines() {
        val draft = mutableStateOf("First\n**Bold**\n`code`")
        render(draft)
        compose.runOnIdle { draft.value = "  new\n\nlast  " }
        val editor = compose.onNode(hasSetTextAction())
        editor.assertTextEquals("  new\n\nlast  ")
        editor.performTextInput("tail")
        editor.assertTextEquals("  new\n\nlast  tail")
        compose.runOnIdle { assertEquals("  new\n\nlast  tail", draft.value) }
    }

    @Test fun fastCommitDuringMarkupModeSwitchDoesNotLoseTheNewerText() {
        val draft = mutableStateOf("")
        controlledIme = true
        render(draft)
        val editor = compose.onNode(hasSetTextAction())
        editor.performClick()
        compose.waitUntil(5_000) { inputConnection != null }
        compose.mainClock.autoAdvance = false
        try {
            compose.runOnIdle { inputConnection!!.commitText("**bold**", 1) }
            compose.mainClock.advanceTimeByFrame()
            compose.runOnIdle { inputConnection!!.commitText(" next", 1) }
        } finally {
            compose.mainClock.autoAdvance = true
        }
        editor.assertTextEquals("bold next")
        compose.runOnIdle { assertEquals("**bold** next", draft.value) }
    }

    private fun render(draft: MutableState<String>, onChange: (String) -> Unit = { draft.value = it }) {
        compose.setContent {
            RagentTheme(darkTheme = false, motionPreference = MotionPreference.None) {
                Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Text("Local editor integrity check", style = MaterialTheme.typography.titleMedium)
                        InterceptPlatformTextInput(remember {
                            PlatformTextInputInterceptor { request, next ->
                                if (!controlledIme) next.startInputMethod(request)
                                // Own one real editor connection instead of opening a second
                                // connection while the system keyboard is already using one.
                                val connection = request.createInputConnection(EditorInfo())
                                inputConnection = connection
                                try {
                                    awaitCancellation()
                                } finally {
                                    connection.closeConnection()
                                    inputConnection = null
                                }
                            }
                        }) {
                            MarkdownComposerEditor(
                                value = draft.value,
                                onValueChange = onChange,
                                modifier = Modifier.fillMaxWidth().height(160.dp).testTag("draft-editor"),
                                textStyle = MaterialTheme.typography.bodyLarge,
                                isDark = false,
                                onTextLayout = { editorLayout = it },
                            )
                        }
                        Text(draft.value, Modifier.testTag("serialized-draft"))
                    }
                }
            }
        }
        compose.waitForIdle()
    }
}
