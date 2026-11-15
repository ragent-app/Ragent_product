package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.feature.workbench.ComposerActionSheet
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.Locale

/** A genuinely constrained sheet viewport, with the user's font size unchanged. */
class ComposerActionsLayoutUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val events = mutableListOf<String>()
    private lateinit var labels: List<String>
    private fun show(language: String, scale: Float, width: Int = 320) {
        val context = rule.activity.createConfigurationContext(
            Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.forLanguageTag(language)) },
        )
        labels = listOf(WorkbenchR.string.composer_actions_title, WorkbenchR.string.composer_action_images,
            WorkbenchR.string.composer_action_files, WorkbenchR.string.composer_action_plan,
            WorkbenchR.string.composer_action_goal, WorkbenchR.string.composer_action_agents,
            WorkbenchR.string.composer_action_connectors).map(context::getString)
        rule.setContent {
            val density = LocalDensity.current
            var visible by remember { mutableStateOf(true) }
            var plan by remember { mutableStateOf(false) }
            CompositionLocalProvider(LocalContext provides context, LocalDensity provides Density(density.density, scale)) {
                RagentTheme(darkTheme = scale >= 1.6f, motionPreference = MotionPreference.None) {
                    Box(Modifier.width(width.dp).height(420.dp)) {
                        if (visible) ComposerActionSheet(
                            onDismiss = { events += "close"; visible = false },
                            onPickImage = { events += "images" }, onPickDocument = { events += "files" },
                            planMode = plan, onTogglePlanMode = { plan = it; events += "plan:$it" },
                            onInsertSlashCommand = { events += it },
                        )
                    }
                }
            }
        }
        rule.waitForIdle()
    }

    private fun fullLabel(text: String) {
        val node = rule.onNodeWithText(text, useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        val layouts = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertTrue("Missing real text layout for $text", layouts.isNotEmpty())
        val layout = layouts.single()
        // FlowRow can reuse a paragraph measured with the whole row width while
        // shrinking the Text node to its intrinsic width. Empty paragraph space
        // is not clipped text; inspect every rendered line rather than that width.
        assertFalse("Text height was clipped: $text; size=${layout.size}", layout.didOverflowHeight)
        for (line in 0 until layout.lineCount) {
            assertFalse("Ellipsized line $line: $text", layout.isLineEllipsized(line))
            assertTrue("Text line $line escaped its left edge: $text", layout.getLineLeft(line) >= -1f)
            assertTrue("Text line $line escaped its right edge: $text; " +
                "right=${layout.getLineRight(line)}, width=${layout.size.width}",
                layout.getLineRight(line) <= layout.size.width + 1f)
            if (line > 0) {
                val start = layout.getLineStart(line)
                fun latinLetter(character: Char) = character.isLetter() &&
                    Character.UnicodeScript.of(character.code) == Character.UnicodeScript.LATIN
                assertFalse("Latin word split across lines: $text",
                    start > 0 && start < text.length && latinLetter(text[start - 1]) && latinLetter(text[start]))
            }
        }
        if (text.startsWith('/')) assertEquals("Command must remain a single readable token: $text", 1, layout.lineCount)
    }

    private fun verifyLarge(language: String) {
        show(language, 2f)
        rule.onNodeWithTag("composer-actions-close").assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        labels.forEach(::fullLabel)
        // No horizontal detour should be needed for any large-type command.
        listOf("/goal", "/plan", "/schedule", "/grill-me", "/learn").forEach(::fullLabel)
        rule.onNodeWithText("/learn").performTouchInput { click() }
        rule.waitForIdle()
        assertEquals(1, events.count { it == "/learn" })
        assertEquals(1, events.count { it == "close" })
    }

    @Test fun englishLargeTypeKeepsAllActionsReadable() = verifyLarge("en")
    @Test fun frenchLargeTypeKeepsAllActionsReadable() = verifyLarge("fr")
    @Test fun spanishLargeTypeKeepsAllActionsReadable() = verifyLarge("es")
    @Test fun simplifiedChineseLargeTypeKeepsAllActionsReadable() = verifyLarge("zh-CN")
    @Test fun traditionalChineseLargeTypeKeepsAllActionsReadable() = verifyLarge("zh-TW")
    @Test fun japaneseLargeTypeKeepsAllActionsReadable() = verifyLarge("ja")
    @Test fun koreanLargeTypeKeepsAllActionsReadable() = verifyLarge("ko")

    @Test fun ordinaryEnglishUsesCalmGroupedRowsAndKeepsCloseTarget() {
        show("en", 1f, 411)
        val images = rule.onNodeWithText(labels[1]).getUnclippedBoundsInRoot()
        val files = rule.onNodeWithText(labels[2]).getUnclippedBoundsInRoot()
        assertEquals(images.left.value, files.left.value, 1f)
        assertTrue("Grouped actions should read top-to-bottom", files.top > images.bottom)
        rule.onNodeWithTag("composer-actions-close").assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
            .performTouchInput { click() }
        rule.waitForIdle()
        assertEquals(listOf("close"), events)
    }

    @Test fun modeSwitchEmitsOneEventWithoutDismissingTheSheet() {
        show("en", 1f)
        rule.onAllNodes(isToggleable(), useUnmergedTree = true)[0].performTouchInput { click() }.assertIsOn()
        assertEquals(listOf("plan:true"), events)
        rule.onNodeWithTag("composer-actions-title").assertIsDisplayed()
    }
}
