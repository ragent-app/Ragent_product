package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentComposer
import com.andysagent.ragent.core.designsystem.RagentTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.Locale
import kotlin.math.abs

class ComposerTypeGeometryUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private lateinit var expanded: MutableState<Boolean>
    private val events = mutableListOf<String>()
    private fun show(scale: Float, language: String = "en", open: Boolean = false) {
        val context = rule.activity.createConfigurationContext(
            Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.forLanguageTag(language)) })
        expanded = mutableStateOf(open)
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalContext provides context,
                LocalDensity provides Density(density.density, scale)) {
                RagentTheme(darkTheme = language == "fr") {
                    Box(Modifier.width(320.dp).height(420.dp).padding(horizontal = 16.dp), contentAlignment = Alignment.BottomCenter) {
                        AgentComposer(value = if (expanded.value) "Draft" else "", onValueChange = {},
                            onSend = { events += "send" }, onStop = {}, working = false,
                            attachmentsEnabled = true, onAddAttachment = { events += "attachment" },
                            runtimeTool = "Preview", expanded = expanded.value, onExpandedChange = { expanded.value = it })
                    }
                }
            }
        }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(1500)
        rule.waitForIdle()
    }
    private fun verifyCollapsed(scale: Float, height: Int, language: String = "en") {
        show(scale, language)
        val rail = rule.onNodeWithTag("composer-action-rail").assertHeightIsEqualTo(height.dp).getUnclippedBoundsInRoot()
        rule.onNodeWithTag("agent-composer").assertHeightIsEqualTo(height.dp)
        val hint = rule.onNodeWithTag("composer-collapsed-hint", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertTrue("No upper breathing space: $hint in $rail", hint.top - rail.top >= 8.dp)
        assertTrue("No lower breathing space: $hint in $rail", rail.bottom - hint.bottom >= 8.dp)
        for (name in listOf("attachment", "send")) {
            val target = rule.onNodeWithTag("composer-$name-action")
                .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp).getUnclippedBoundsInRoot()
            assertEquals("$name should stay centered without scaling its glyph",
                ((rail.top + rail.bottom) / 2).value, ((target.top + target.bottom) / 2).value, 1f)
            assertTrue(target.top >= rail.top && target.bottom <= rail.bottom)
        }
        rule.onNodeWithTag("composer-send-disc", useUnmergedTree = true)
            .assertWidthIsEqualTo(30.dp).assertHeightIsEqualTo(30.dp)
    }
    @Test fun ordinaryTypeKeepsOriginalCompactShape() = verifyCollapsed(1f, 48)
    @Test fun typeOnePointThreeGainsBreathingSpace() = verifyCollapsed(1.3f, 52)
    @Test fun typeOnePointFiveGainsBreathingSpace() = verifyCollapsed(1.5f, 56)
    @Test fun typeOnePointSixGainsBreathingSpace() = verifyCollapsed(1.6f, 56)
    @Test fun doubleTypeGainsBreathingSpace() = verifyCollapsed(2f, 64)
    @Test fun frenchDoubleTypeGainsBreathingSpace() = verifyCollapsed(2f, 64, "fr")
    @Test fun chineseDoubleTypeGainsBreathingSpace() = verifyCollapsed(2f, 64, "zh-CN")
    @Test fun expandedDoubleTypeModelLabelHasRoomAndSendStaysCircular() {
        show(2f, "fr", open = true)
        rule.onNodeWithTag("composer-action-rail").assertHeightIsEqualTo(60.dp)
        val result = mutableListOf<TextLayoutResult>()
        rule.onNodeWithTag("composer-model-label", useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(result) }
        val layout = result.single()
        // A deliberately ellipsized, single-line model name reports
        // didOverflowHeight when its original paragraph exceeds maxLines.
        // Check the rendered line, not the hidden paragraph's line count.
        assertEquals(1, layout.lineCount)
        assertTrue("Visible model line was clipped: bottom=${layout.getLineBottom(0)}, size=${layout.size}",
            layout.getLineBottom(0) <= layout.size.height + 1f)
        val label = rule.onNodeWithTag("composer-model-label", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val rail = rule.onNodeWithTag("composer-action-rail").getUnclippedBoundsInRoot()
        assertTrue(label.top - rail.top >= 8.dp && rail.bottom - label.bottom >= 8.dp)
        rule.onNodeWithTag("composer-send-disc", useUnmergedTree = true)
            .assertWidthIsEqualTo(34.dp).assertHeightIsEqualTo(34.dp)
        rule.onNodeWithTag("composer-attachment-action").performTouchInput { click() }
        assertEquals(listOf("attachment"), events)
    }
    @Test fun largeTypeReverseMorphKeepsBottomAnchorAndASingleSurface() {
        show(2f)
        val anchor = rule.onNodeWithTag("agent-composer").getUnclippedBoundsInRoot().bottom
        rule.mainClock.autoAdvance = false
        var previous = rule.onNodeWithTag("agent-composer").getUnclippedBoundsInRoot()
        for (open in listOf(true, false, true, false)) {
            rule.runOnIdle { expanded.value = open }
            repeat(7) {
                rule.mainClock.advanceTimeBy(16)
                val current = rule.onNodeWithTag("agent-composer").getUnclippedBoundsInRoot()
                assertEquals(anchor.value, current.bottom.value, 1f)
                assertTrue("Shape collapsed into an empty sliver", current.bottom - current.top >= 48.dp)
                assertTrue("Size changed discontinuously: $previous -> $current",
                    abs((current.bottom - current.top).value - (previous.bottom - previous.top).value) < 30f)
                rule.onAllNodesWithTag("agent-composer").assertCountEquals(1)
                previous = current
            }
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithTag("agent-composer").assertHeightIsEqualTo(64.dp)
    }
}
