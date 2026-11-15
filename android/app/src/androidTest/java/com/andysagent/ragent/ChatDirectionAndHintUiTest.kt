package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.style.ResolvedTextDirection
import androidx.compose.ui.unit.*
import com.andysagent.ragent.core.agentui.AgentComposer
import com.andysagent.ragent.core.agentui.RagentodeBlock
import com.andysagent.ragent.core.agentui.AgentoMarkdownText
import com.andysagent.ragent.core.agentui.AgentMarkdown
import com.andysagent.ragent.core.designsystem.*
import java.util.Locale
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ChatDirectionAndHintUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun rtlChromeDoesNotSeparateLatinListMarkersFromTheirText() {
        compose.setContent {
            RagentTheme {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                    Column(Modifier.width(300.dp)) {
                        AgentMarkdown("1. English list item")
                        AgentMarkdown("1. مرحبا بالعالم")
                    }
                }
            }
        }
        val markers = compose.onAllNodesWithText("1.").fetchSemanticsNodes()
            .sortedBy { it.boundsInRoot.top }
        val english = compose.onNodeWithText("English list item").fetchSemanticsNode().boundsInRoot
        val arabic = compose.onNodeWithText("مرحبا بالعالم").fetchSemanticsNode().boundsInRoot
        assertEquals(2, markers.size)
        assertTrue("Latin marker is detached on the opposite side", markers[0].boundsInRoot.right <= english.left)
        assertTrue("Arabic list was forced LTR", markers[1].boundsInRoot.left >= arabic.right)
    }

    @Test fun navigationGlyphsMirrorButDisclosureDownDoesNot() {
        val glyphs = listOf(AgentoWebGlyph.Back, AgentoWebGlyph.ChevronRight, AgentoWebGlyph.ChevronDown)
        compose.setContent {
            Column(Modifier.background(Color.White)) {
                for (glyph in glyphs) Row {
                    for (direction in listOf(LayoutDirection.Ltr, LayoutDirection.Rtl)) {
                        CompositionLocalProvider(LocalLayoutDirection provides direction) {
                            AgentoWebIcon(glyph, null, Modifier.size(32.dp).testTag("$glyph-$direction"), Color.Black)
                        }
                    }
                }
            }
        }
        for (glyph in glyphs) {
            val ltr = compose.onNodeWithTag("$glyph-Ltr").captureToImage().toPixelMap()
            val rtl = compose.onNodeWithTag("$glyph-Rtl").captureToImage().toPixelMap()
            var mismatch = 0
            for (y in 0 until ltr.height) for (x in 0 until ltr.width) {
                val sourceX = if (glyph == AgentoWebGlyph.ChevronDown) x else ltr.width - 1 - x
                if (kotlin.math.abs(ltr[sourceX, y].red - rtl[x, y].red) > 0.12f) mismatch++
            }
            assertTrue("$glyph direction pixels differ: $mismatch", mismatch < ltr.width * ltr.height / 50)
        }
    }

    @Test fun rtlPageKeepsSourceLtrAndProseUsesItsContentDirection() {
        val source = "val x = 1\n    println(x)"
        compose.setContent {
            RagentTheme(darkTheme = false) {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                    Column(Modifier.width(300.dp)) {
                        RagentodeBlock(source, "kotlin")
                        for (text in listOf("中文内容。", "English content.", "مرحبا بالعالم")) {
                            AgentoMarkdownText(text, RagentonversationTypography.Body, Color.Black, Color.LightGray)
                        }
                    }
                }
            }
        }
        val code = textLayout(compose.onNodeWithText(source))
        assertEquals(ResolvedTextDirection.Ltr, code.getParagraphDirection(0))
        assertTrue("Source is not left aligned", code.getLineLeft(0) < 1f)
        assertTrue("Indentation lost", code.getBoundingBox(source.indexOf("println")).left > code.getBoundingBox(0).left)
        for ((text, direction) in listOf("中文内容。" to ResolvedTextDirection.Ltr,
            "English content." to ResolvedTextDirection.Ltr, "مرحبا بالعالم" to ResolvedTextDirection.Rtl)) {
            assertEquals(direction, textLayout(compose.onNodeWithText(text)).getParagraphDirection(0))
        }
    }

    @Test fun frenchLargeFontHintEllipsizesInsideTheCollapsedViewport() {
        val base = compose.activity
        val localized = base.createConfigurationContext(Configuration(base.resources.configuration).apply {
            setLocale(Locale.FRENCH)
        })
        compose.setContent {
            CompositionLocalProvider(LocalContext provides localized,
                LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                RagentTheme(darkTheme = false) {
                    Box(Modifier.width(288.dp)) {
                        AgentComposer(value = "", onValueChange = {}, onSend = {}, onStop = {},
                            working = false, onAddAttachment = {})
                    }
                }
            }
        }
        val hint = compose.onNodeWithTag("composer-collapsed-hint", useUnmergedTree = true)
        val result = textLayout(hint)
        assertTrue("Hint still hard-clips instead of ellipsizing", result.isLineEllipsized(0))
        assertTrue("Hint escaped composer", hint.getUnclippedBoundsInRoot().right <=
            compose.onNodeWithTag("agent-composer").getUnclippedBoundsInRoot().right)
    }

    private fun textLayout(node: SemanticsNodeInteraction): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(results) }
        return results.single()
    }
}
