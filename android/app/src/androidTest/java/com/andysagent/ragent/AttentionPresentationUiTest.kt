package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.model.*
import com.andysagent.ragent.feature.workbench.AttentionEvent
import com.andysagent.ragent.feature.workbench.AttentionSurface
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.feature.workbench.WorkbenchEvent
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.Locale

class AttentionPresentationUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val item = AttentionItem("i", "s", "Weekly report", AttentionKind.Approval,
        "Export report", "Export report", approval = Approval("a", "s", "Export report",
            reason = "Writes to the shared team folder", passkeyRequired = false, actions = listOf(
                ApprovalAction("one", description = "Export with source references", summary = "Export audited report", command = "export --sources", cwd = "C:/Reports"),
                ApprovalAction("two", description = "Copy the reviewed report", command = "copy report.pdf C:/Shared/report.pdf"))))
    private var state by mutableStateOf(AttentionUiState(items = listOf(item), activeItemId = item.id))
    private val events = mutableListOf<AttentionEvent>()
    private var opened: String? = null

    private fun show(motion: MotionPreference = MotionPreference.None, host: Boolean = false) {
        val context = android.view.ContextThemeWrapper(rule.activity, 0).apply {
            applyOverrideConfiguration(android.content.res.Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.ENGLISH) })
        }
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context) {
                RagentTheme(darkTheme = false, motionPreference = motion) {
                    Box(Modifier.fillMaxSize()) {
                    val dispatch: (AttentionEvent) -> Unit = { event ->
                        events += event
                        when (event) {
                            is AttentionEvent.SetExpanded -> state = state.copy(expanded = event.expanded)
                            is AttentionEvent.Dismiss -> state = AttentionUiState()
                            else -> Unit
                        }
                    }
                    if (host) {
                        WorkbenchScreen(WorkbenchUiState(chatOpen = true, sessionId = "reading-other-session"),
                            onEvent = {}, attentionState = state, onAttentionEvent = dispatch,
                            onAttentionOpenSession = { opened = it })
                    } else AttentionSurface(state, onEvent = dispatch, onOpenSession = { opened = it })
                    }
                }
            }
        }
        rule.waitForIdle()
    }

    @Test fun sourceHeadlineAndConsequenceStayOrderedAndActionListIsNotDuplicated() {
        show()
        val source = rule.onNodeWithTag("attention-source", true).getUnclippedBoundsInRoot()
        val headline = rule.onNodeWithTag("attention-headline", true).getUnclippedBoundsInRoot()
        val consequence = rule.onNodeWithTag("attention-consequence", true).getUnclippedBoundsInRoot()
        assertTrue(source.bottom <= headline.top && headline.bottom <= consequence.top)
        listOf("Approve selected", "Deny", "Details").forEach { label ->
            val layouts = mutableListOf<TextLayoutResult>()
            rule.onNodeWithText(label, useUnmergedTree = true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            layouts.single().let { println("Notification label=$label size=${it.size} constraints=${it.layoutInput.constraints} paragraph=${it.multiParagraph.width}x${it.multiParagraph.height} widthOverflow=${it.didOverflowWidth} heightOverflow=${it.didOverflowHeight} lines=${it.lineCount}") }
            val result = layouts.single()
            // Center alignment offsets lines inside the offered paragraph
            // (Deny: 310px paragraph, 98px tight node). Its absolute line-right
            // is not a tight-node coordinate. Inspect the occupied line span.
            for (line in 0 until result.lineCount) {
                println("Notification line=$label/$line left=${result.getLineLeft(line)} right=${result.getLineRight(line)} bottom=${result.getLineBottom(line)}")
                assertFalse("Decision label is ellipsized: $label", result.isLineEllipsized(line))
                assertTrue("Decision label is wider than its node: $label",
                    result.getLineRight(line) - result.getLineLeft(line) <= result.size.width + 1f)
                assertTrue("Decision label extends below: $label", result.getLineBottom(line) <= result.size.height + 1f)
            }
            assertEquals("Decision label lost characters: $label", label.length,
                result.getLineEnd(result.lineCount - 1))
        }
        rule.onNodeWithContentDescription("Expand approval details").performClick()
        rule.onAllNodesWithText("Export with source references").assertCountEquals(1)
        rule.onAllNodesWithText("export --sources").assertCountEquals(1)
        rule.onNodeWithText("Working directory: C:/Reports").assertIsDisplayed()
        rule.onNodeWithTag("attention-headline", true).assertTextEquals("Export audited report")
    }

    @Test fun disclosureMovesThroughIntermediateHeightAndReversesFromItsCurrentGeometry() {
        rule.mainClock.autoAdvance = false
        try {
            show(MotionPreference.Full)
            rule.mainClock.advanceTimeBy(1_000)
            val initial = rule.onNodeWithTag("attention-card-content", true).getUnclippedBoundsInRoot()
            rule.onNodeWithContentDescription("Expand approval details").performClick()
            rule.mainClock.advanceTimeBy(100)
            rule.waitForIdle()
            val mid = rule.onNodeWithTag("attention-card-content", true).getUnclippedBoundsInRoot()
            assertTrue("Reveal must grow: initial=$initial mid=$mid", mid.height > initial.height)
            // A withdrawing technical region has no usable child actions.
            rule.runOnIdle { state = state.copy(expanded = false) }
            rule.mainClock.advanceTimeByFrame()
            val reversed = rule.onNodeWithTag("attention-card-content", true).getUnclippedBoundsInRoot()
            assertTrue("No forward growth after reversal: initial=$initial mid=$mid reversed=$reversed",
                reversed.height >= initial.height && reversed.height <= mid.height)
            rule.onAllNodes(isToggleable()).assertCountEquals(0)
            rule.mainClock.advanceTimeBy(1_000)
            val closed = rule.onNodeWithTag("attention-card-content", true).getUnclippedBoundsInRoot()
            assertEquals(initial.height.value, closed.height.value, .5f)
        } finally { rule.mainClock.autoAdvance = true }
    }

    @Test fun batchSelectionSurvivesDisclosureAndTertiaryActionDoesNotResolveApproval() {
        show()
        rule.onNodeWithContentDescription("Expand approval details").performClick()
        rule.onNodeWithText("Export with source references").performClick()
        rule.onAllNodes(isToggleable() and isOff()).assertCountEquals(1)
        rule.onNodeWithContentDescription("Collapse approval details").performClick()
        rule.onNodeWithContentDescription("Expand approval details").performClick()
        rule.onAllNodes(isToggleable() and isOff()).assertCountEquals(1)
        rule.onNodeWithText("Approve selected").performClick()
        val decision = events.filterIsInstance<AttentionEvent.ResolveActionBatch>().single()
        assertEquals(setOf("two"), decision.selectedActionIds)
        rule.onNodeWithText("Details").performClick()
        assertEquals("s", opened)
        assertEquals(1, events.filterIsInstance<AttentionEvent.ResolveActionBatch>().size)
    }

    @Test fun resolvingDisablesEveryActionAndBackDismissIsNotDenial() {
        state = state.copy(resolvingItemId = item.id, error = "Could not complete the decision. Try again.")
        show()
        listOf("Approve selected", "Deny", "Details").forEach { rule.onNodeWithText(it).assertIsNotEnabled() }
        rule.onNodeWithContentDescription("Expand approval details").assertIsNotEnabled()
        rule.onNodeWithText("Could not complete the decision. Try again.").assertIsDisplayed()
        rule.runOnIdle { rule.activity.onBackPressedDispatcher.onBackPressed() }
        assertEquals(listOf(AttentionEvent.Dismiss(item.id)), events)
        rule.onNodeWithText("Approve selected").assertDoesNotExist()
    }

    @Test fun notificationDismissWinsOverUnderlyingChatBackNavigation() {
        var chatClosed = false
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                WorkbenchScreen(WorkbenchUiState(chatOpen = true, sessionId = "reading-other-session"),
                    onEvent = { if (it == WorkbenchEvent.CloseChat) chatClosed = true },
                    attentionState = state, onAttentionEvent = { event ->
                        events += event
                        if (event is AttentionEvent.Dismiss) state = AttentionUiState()
                    })
            }
        }
        rule.waitForIdle()
        rule.runOnIdle { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        assertFalse("Notification Back must not close the conversation", chatClosed)
        assertEquals(listOf(AttentionEvent.Dismiss(item.id)), events)
        rule.onNodeWithTag("attention-headline", true).assertDoesNotExist()
        rule.onNodeWithContentDescription("Message composer").assertIsDisplayed()
    }

    @Test fun submittingKeepsDecisionWidthsAndPlacesFeedbackBelowThem() {
        show()
        val approve = rule.onNodeWithText("Approve selected").getUnclippedBoundsInRoot()
        val deny = rule.onNodeWithText("Deny").getUnclippedBoundsInRoot()
        rule.runOnIdle { state = state.copy(resolvingItemId = item.id) }
        val pendingApprove = rule.onNodeWithText("Approve selected").getUnclippedBoundsInRoot()
        val pendingDeny = rule.onNodeWithText("Deny").getUnclippedBoundsInRoot()
        assertEquals(approve.width.value, pendingApprove.width.value, .5f)
        assertEquals(deny.width.value, pendingDeny.width.value, .5f)
        val feedback = rule.onNodeWithTag("attention-submitting", true).getUnclippedBoundsInRoot()
        assertTrue("Feedback must not consume a decision column", feedback.top >= pendingApprove.bottom)
        rule.onNodeWithText("Submitting…").assertExists()
        listOf("Approve selected", "Deny", "Details").forEach { rule.onNodeWithText(it).assertIsNotEnabled() }
    }

    @Test fun dismissedCardKeepsExitSurfaceButCannotMakeAStaleDecision() {
        rule.mainClock.autoAdvance = false
        try {
            show(MotionPreference.Full, host = true)
            rule.mainClock.advanceTimeBy(1000)
            rule.runOnIdle { state = AttentionUiState() }
            rule.mainClock.advanceTimeByFrame()
            rule.onNodeWithTag("attention-retained-surface", true).assertExists()
            rule.onNodeWithText("Approve selected").assertDoesNotExist()
            rule.onNodeWithText("Deny").assertDoesNotExist()
            rule.mainClock.advanceTimeBy(48)
            rule.waitForIdle()
            val pixels = rule.onRoot().captureToImage().toPixelMap()
            var paintedDecision = 0
            for (y in 0 until pixels.height) for (x in 0 until pixels.width) {
                val color = pixels[x, y]
                if (color.blue > color.red + .2f && color.green > color.red + .12f) paintedDecision++
            }
            assertTrue("Retained semantics alone are not evidence of a painted exit", paintedDecision > 20)
            rule.mainClock.advanceTimeBy(1000)
            rule.onNodeWithTag("attention-retained-surface", true).assertDoesNotExist()
            assertTrue(events.isEmpty())
        } finally { rule.mainClock.autoAdvance = true }
    }

    @Test fun disabledSecondaryLabelUsesDisabledInkInBothThemes() {
        var dark by mutableStateOf(false)
        var expected = Color.Unspecified
        var active = Color.Unspecified
        rule.setContent {
            RagentTheme(darkTheme = dark, motionPreference = MotionPreference.None) {
                expected = LocalRagentColors.current.disabledContent
                active = LocalRagentColors.current.primaryContent
                AgentoButton("Deny", {}, enabled = false, secondary = true)
            }
        }
        for (theme in listOf(false, true)) {
            rule.runOnIdle { dark = theme }
            rule.waitForIdle()
            val pixels = rule.onNodeWithText("Deny", true).captureToImage().toPixelMap()
            // Dark/OLED disabled tokens carry alpha; compare their composited
            // ink against the actual rendered control background, not white RGB.
            val disabledInk = expected.compositeOver(pixels[0, 0])
            fun matches(a: Color, b: Color) = kotlin.math.abs(a.red - b.red) < .025f &&
                kotlin.math.abs(a.green - b.green) < .025f && kotlin.math.abs(a.blue - b.blue) < .025f
            var disabledPixels = 0
            var activePixels = 0
            for (y in 0 until pixels.height) for (x in 0 until pixels.width) {
                if (matches(pixels[x, y], disabledInk)) disabledPixels++
                if (matches(pixels[x, y], active)) activePixels++
            }
            assertTrue("Missing disabled label ink in dark=$theme", disabledPixels > 20)
            assertEquals("Disabled action still uses active label ink in dark=$theme", 0, activePixels)
        }
    }
}
