package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.feature.workbench.RunMetricsUiState
import com.andysagent.ragent.core.agentui.AgentRunStatus
import java.util.Locale
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import com.andysagent.ragent.feature.workbench.R as WorkbenchR

class RunIslandLayoutUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private var detailsLabel = ""
    private var collapseLabel = ""
    private var noContextLabel = ""
    private var idleSummary = ""
    private var metricLabels = emptyList<String>()

    @Test fun lightReadingLayerKeepsVisibleEndpointAndExportsFrozenCloseFrames() = captureReadingFrames(false)
    @Test fun darkReadingLayerKeepsVisibleEndpointAndExportsFrozenCloseFrames() = captureReadingFrames(true)

    private fun captureReadingFrames(dark: Boolean) {
        show(large = false, motion = MotionPreference.Full, status = AgentRunStatus.Completed, dark = dark)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.waitForIdle()
        val summary = rule.onNodeWithTag("run-island-summary", true).fetchSemanticsNode().boundsInRoot
        val folder = java.io.File(rule.activity.getExternalFilesDir(null), "island-reading-frames").apply { mkdirs() }
        fun capture(frame: Int) {
            repeat(2) { rule.onRoot().captureToImage() }
            val image = rule.onRoot().captureToImage()
            java.io.File(folder, "${if (dark) "dark" else "light"}-$frame.png").outputStream().use {
                image.asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
            if (frame == 0) {
                val pixels = image.toPixelMap()
                var edges = 0
                for (y in summary.top.toInt() until summary.bottom.toInt()) {
                    for (x in summary.left.toInt() until summary.right.toInt() - 1) {
                        if (kotlin.math.abs(pixels[x, y].red - pixels[x + 1, y].red) > .10f) edges++
                    }
                }
                assertTrue("Stable summary was hidden: $edges text edges", edges > 1000)
            }
        }
        rule.mainClock.autoAdvance = false
        try {
            capture(0)
            rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            repeat(24) { index ->
                rule.mainClock.advanceTimeByFrame()
                if (index + 1 in listOf(2, 4, 6, 8, 12, 24)) capture(index + 1)
            }
        } finally { rule.mainClock.autoAdvance = true }
    }

    @Test fun wholeCloseWithdrawsSummaryBeforeTheShellCutsItsLetters() {
        show(large = false, motion = MotionPreference.Full, status = AgentRunStatus.Completed)
        // Cover both side and bottom intersections with the normal-size
        // summary, including a two-line summary during whole-card close.
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.waitForIdle()
        val summary = rule.onNodeWithTag("run-island-summary", true).fetchSemanticsNode().boundsInRoot
        val shell = rule.onNodeWithTag("run-island-shell")
        rule.mainClock.autoAdvance = false
        try {
            rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            var readableFrames = 0
            var intersectingFrames = 0
            repeat(24) {
                rule.mainClock.advanceTimeByFrame()
                val bounds = shell.fetchSemanticsNode().boundsInRoot
                val overlap = with(rule.density) { 4.dp.toPx() }
                val readingClearance = with(rule.density) { 24.dp.toPx() }
                val summaryStillFits = bounds.left <= summary.left + overlap &&
                    bounds.right >= summary.right - overlap && bounds.bottom >= summary.bottom + readingClearance
                val summaryIntersects = bounds.right > summary.left + overlap &&
                    bounds.left < summary.right - overlap && bounds.bottom > summary.top + overlap &&
                    (bounds.left > summary.left + overlap || bounds.right < summary.right - overlap ||
                        bounds.bottom < summary.bottom)
                if (summaryStillFits || summaryIntersects) {
                    repeat(2) { rule.onRoot().captureToImage() }
                    val image = rule.onRoot().captureToImage()
                    java.io.File(rule.activity.getExternalFilesDir(null),
                        if (summaryIntersects) "island-summary-clipping.png" else "island-summary-readable.png").outputStream().use {
                        image.asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                    }
                    val pixels = image.toPixelMap()
                    var edges = 0
                    val startY = maxOf(summary.top.toInt(), bounds.top.toInt() + 1)
                    val endY = minOf(summary.bottom.toInt(), bounds.bottom.toInt() - 1)
                    for (y in startY until endY) {
                        val start = maxOf(summary.left.toInt(), bounds.left.toInt() + 1)
                        val end = minOf(summary.right.toInt(), bounds.right.toInt() - 1)
                        for (x in start until end) {
                            if (kotlin.math.abs(pixels[x, y].red - pixels[x + 1, y].red) > .10f) edges++
                        }
                    }
                    if (summaryIntersects) {
                        intersectingFrames++
                        assertTrue("Partially clipped summary still drawn: $edges text edges; shell=$bounds summary=$summary", edges < 10)
                    } else {
                        readableFrames++
                        assertTrue("Readable geometry became an empty glass chamber: $edges text edges; shell=$bounds summary=$summary",
                            edges > 100)
                    }
                }
            }
            assertTrue("No readable intermediate summary frames sampled", readableFrames >= 2)
            assertTrue("No shell/summary intersection sampled", intersectingFrames >= 1)
        } finally { rule.mainClock.autoAdvance = true }
    }

    // Compose 1.7.6 getUnclippedBoundsInRoot uses position + untransformed
    // layout size. Map actual local corners through the drawing transform,
    // without letting a growing viewport clip masquerade as content scaling.
    private fun drawnBounds(node: SemanticsNodeInteraction): DpRect {
        val info = node.fetchSemanticsNode().layoutInfo
        val coordinates = info.coordinates
        val topLeft = coordinates.localToRoot(Offset.Zero)
        val bottomRight = coordinates.localToRoot(Offset(
            coordinates.size.width.toFloat(), coordinates.size.height.toFloat(),
        ))
        return with(info.density) {
            DpRect(topLeft.x.toDp(), topLeft.y.toDp(), bottomRight.x.toDp(), bottomRight.y.toDp())
        }
    }

    private fun show(large: Boolean, motion: MotionPreference = MotionPreference.None,
        status: AgentRunStatus = AgentRunStatus.Idle, open: Boolean = true,
        metrics: RunMetricsUiState? = null, dark: Boolean = true) {
        // Preserve the real Activity in the context chain: Workbench owns
        // activity-result launchers and back dispatch, unlike a plain Text.
        val context = android.view.ContextThemeWrapper(rule.activity, 0).apply {
            applyOverrideConfiguration(Configuration(rule.activity.resources.configuration).apply {
                setLocale(if (large) Locale.FRENCH else Locale.ENGLISH)
            })
        }
        detailsLabel = context.getString(WorkbenchR.string.workbench_session_run_details)
        // Query the same override locale the fixture renders, not the phone's
        // Activity/system locale (e.g. Chinese HONOR with English fixture).
        collapseLabel = context.getString(com.andysagent.ragent.core.agentui.R.string.agentui_collapse)
        noContextLabel = context.getString(WorkbenchR.string.run_details_no_context)
        idleSummary = context.getString(WorkbenchR.string.run_summary_idle_detail)
        metricLabels = listOf(WorkbenchR.string.run_metric_time, WorkbenchR.string.run_metric_tools,
            WorkbenchR.string.run_metric_files, WorkbenchR.string.run_metric_tokens).map(context::getString)
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalContext provides context,
                LocalDensity provides Density(density.density, if (large) 2f else 1f)) {
                RagentTheme(darkTheme = dark, motionPreference = motion) {
                    Box(Modifier.width(if (large) 320.dp else 411.dp)) {
                        WorkbenchScreen(WorkbenchUiState(chatOpen = true, sessionId = "island-layout",
                            sessionTitle = "Island layout", runStatus = status,
                            runMetrics = metrics ?: RunMetricsUiState(status = status)), onEvent = {})
                    }
                }
            }
        }
        if (open) rule.onNodeWithText("Island layout").performClick()
        rule.waitForIdle()
    }

    @Test fun normalDetailsDoNotLeaveAnEmptyTailBeforeDisclosure() {
        show(large = false)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.onNodeWithText(noContextLabel).assertDoesNotExist()
        rule.onNodeWithTag("run-context").assertDoesNotExist()
        val lastText = rule.onNodeWithTag("run-metrics-group")
            .getUnclippedBoundsInRoot()
        val footer = rule.onNodeWithContentDescription(collapseLabel).getUnclippedBoundsInRoot()
        val gap = footer.top - lastText.bottom
        assertTrue("Details tail gap is $gap", gap >= 0.dp && gap <= 32.dp)
    }

    @Test fun actualRunContextRemainsVisibleWithoutAnEmptyPlaceholderCard() {
        show(large = false, metrics = RunMetricsUiState(runId = "run-42", phase = "executing",
            provider = "Local provider", model = "Local model", runtimeFamily = "Local runtime"))
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.onNodeWithTag("run-context").assertIsDisplayed()
        listOf("run-42", "executing", "Local provider", "Local model", "Local runtime").forEach {
            rule.onNodeWithText(it, substring = true).assertIsDisplayed()
        }
        val primary = rule.onNodeWithTag("run-context-primary").getUnclippedBoundsInRoot()
        val supporting = rule.onNodeWithTag("run-context-supporting").getUnclippedBoundsInRoot()
        val metadata = rule.onNodeWithTag("run-context-metadata").getUnclippedBoundsInRoot()
        assertTrue(primary.bottom <= supporting.top && supporting.bottom <= metadata.top)
        rule.onNodeWithTag("run-context-primary").assertTextEquals("Local model")
        rule.onNodeWithText(noContextLabel).assertDoesNotExist()
    }

    @Test fun tabSelectionMovesContinuouslyAndReversesWithoutReplacingTheIndicator() {
        show(large = false, motion = MotionPreference.Full)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.waitForIdle()
        val indicator = rule.onNodeWithTag("run-details-selection", useUnmergedTree = true)
        val identity = indicator.fetchSemanticsNode().id
        fun left() = indicator.getUnclippedBoundsInRoot().left.value
        val shell = rule.onNodeWithTag("run-island-shell")
        fun height() = shell.getUnclippedBoundsInRoot().let { (it.bottom - it.top).value }
        val start = left()
        val fullHeight = height()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithTag("run-details-tab-Trace").performClick()
        val forward = mutableListOf<Float>()
        repeat(8) {
            rule.mainClock.advanceTimeByFrame()
            forward += left()
            assertEquals(identity, indicator.fetchSemanticsNode().id)
        }
        assertTrue("Indicator did not move through intermediate positions: $forward", forward.distinct().size > 3)
        assertTrue(forward.zipWithNext().all { (a, b) -> b >= a - 1 })
        val interruptedHeight = height()
        assertTrue("No size intermediate before reversing", interruptedHeight < fullHeight - 2)
        rule.onNodeWithTag("run-details-tab-Metrics").performClick()
        // Semantics input drains a pending composition/measure before this
        // paused clock starts the new segment. Compare both sides of dispatch,
        // not the next frame with an older pre-input measurement.
        val dispatchLeft = left()
        val dispatchHeight = height()
        val reverse = mutableListOf<Float>()
        val reverseHeights = mutableListOf<Float>()
        repeat(24) {
            rule.mainClock.advanceTimeByFrame()
            reverse += left()
            reverseHeights += height()
            assertEquals(identity, indicator.fetchSemanticsNode().id)
        }
        println("Tab reversal forward=$forward dispatch=$dispatchLeft reverse=$reverse heights=$interruptedHeight/$dispatchHeight/$reverseHeights")
        val forwardStep = forward.zipWithNext().maxOf { (a, b) -> kotlin.math.abs(b - a) } + 1
        assertTrue("Dispatch skipped more than a frame: $forward -> $dispatchLeft",
            kotlin.math.abs(dispatchLeft - forward.last()) <= forwardStep)
        assertTrue("Reversal jumped rather than retaining position: $dispatchLeft -> $reverse",
            kotlin.math.abs(reverse.first() - dispatchLeft) <= forwardStep)
        assertTrue(reverse.zipWithNext().all { (a, b) -> b <= a + 1 })
        // performClick drains one still-pending *forward* placement. The
        // recorded HONOR trace goes 368.31 -> 347.08 dp before the callback;
        // the old implementation then jumps another 34 dp on retarget. Permit
        // that single forward frame, but no extra endpoint jump.
        assertTrue("Size reversal jumped to an endpoint: $interruptedHeight -> $reverseHeights",
            kotlin.math.abs(dispatchHeight - interruptedHeight) < 24f &&
                kotlin.math.abs(reverseHeights.first() - dispatchHeight) < 16f)
        assertTrue("Size reversal exceeded its endpoint: $reverseHeights", reverseHeights.all { it <= fullHeight + 1 })
        assertEquals(fullHeight, height(), 1f)
        assertEquals(start, left(), 1f)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithTag("run-metrics-group").assertIsDisplayed()
    }

    @Test fun workingTitleIndicatorHidesWithoutReplacingOrMovingTitle() {
        show(large = false, motion = MotionPreference.Full, status = AgentRunStatus.Working, open = false)
        val title = rule.onNodeWithTag("run-island-persistent-title", useUnmergedTree = true)
        val identity = title.fetchSemanticsNode().id
        val anchor = title.getUnclippedBoundsInRoot()
        val indicator = rule.onNodeWithTag("conversation-status-indicator", useUnmergedTree = true)
        indicator.assertExists()
        rule.onNodeWithText("Island layout").performClick()
        rule.waitForIdle()
        indicator.assertDoesNotExist()
        assertEquals(identity, title.fetchSemanticsNode().id)
        assertEquals(anchor.left.value, title.getUnclippedBoundsInRoot().left.value, 1f)
        assertEquals(anchor.right.value, title.getUnclippedBoundsInRoot().right.value, 1f)
        rule.mainClock.autoAdvance = false
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        repeat(6) {
            rule.mainClock.advanceTimeByFrame()
            indicator.assertDoesNotExist()
            assertEquals(identity, title.fetchSemanticsNode().id)
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        indicator.assertExists()
        assertEquals(identity, title.fetchSemanticsNode().id)
        assertEquals(anchor.left.value, title.getUnclippedBoundsInRoot().left.value, 1f)
        assertEquals(anchor.right.value, title.getUnclippedBoundsInRoot().right.value, 1f)
    }

    private fun layout(node: SemanticsNodeInteraction): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        return layouts.single().also {
            println("Island text '${it.layoutInput.text}': size=${it.size}, paragraph=${it.multiParagraph.width}x${it.multiParagraph.height}, lines=${it.lineCount}, overflowW=${it.didOverflowWidth}, overflowH=${it.didOverflowHeight}")
        }
    }

    private fun assertTextFits(result: TextLayoutResult) {
        // GetTextLayoutResult can report the paragraph's offered width rather
        // than its tight Text node width (in a scroll row it can be infinite).
        // Test the actual laid-out lines, not that unrelated available width.
        for (line in 0 until result.lineCount) {
            assertFalse("Ellipsized text: ${result.layoutInput.text}", result.isLineEllipsized(line))
            assertTrue("Text extends left of its node", result.getLineLeft(line) >= -1f)
            assertTrue("Text extends right of its node", result.getLineRight(line) <= result.size.width + 1f)
            assertTrue("Text extends below its node", result.getLineBottom(line) <= result.size.height + 1f)
        }
        assertEquals("Text lost its final characters", result.layoutInput.text.length,
            result.getLineEnd(result.lineCount - 1))
    }

    @Test fun frenchLargeTypeKeepsWholeWordsAndReachableTabs() {
        show(large = true)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        // Full details retain the decision-first summary above their tabs.
        val summary = rule.onNodeWithText(idleSummary)
        summary.assertIsDisplayed()
        assertTextFits(layout(summary))
        assertTrue(summary.getUnclippedBoundsInRoot().bottom <=
            rule.onNodeWithTag("run-details-tab-Metrics").getUnclippedBoundsInRoot().top)
        // Inline details reuse the persistent session title and status, rather
        // than adding a second heading/subtitle above the tabs.
        rule.onNodeWithTag("run-details-heading", useUnmergedTree = true).assertDoesNotExist()
        val title = rule.onNodeWithTag("run-island-persistent-title", useUnmergedTree = true)
        title.assertIsDisplayed()
        // The fixed capsule may ellipsize the session title, but must expose
        // its complete name. The full-width status and tab labels must not.
        rule.onNodeWithContentDescription("Island layout", substring = true, useUnmergedTree = true).assertExists()
        val titleLayout = layout(rule.onNodeWithTag("run-island-status-label", useUnmergedTree = true))
        assertTextFits(titleLayout)
        for (line in 0 until titleLayout.lineCount - 1) {
            val end = titleLayout.getLineEnd(line)
            val text = titleLayout.layoutInput.text.text
            assertFalse("Heading split a word at $end: $text",
                end > 0 && end < text.length && text[end - 1].isLetter() && text[end].isLetter())
        }
        for (tab in listOf("Metrics", "Files", "Trace")) {
            val target = rule.onNodeWithTag("run-details-tab-$tab")
            target.performScrollTo().assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick().assertIsSelected()
            val label = layout(rule.onNodeWithTag("run-details-tab-label-$tab", useUnmergedTree = true))
            assertEquals("Tab label must stay on one line", 1, label.lineCount)
            assertTextFits(label)
        }
    }

    @Test fun largeMetricsRemainReachableWithoutNarrowColumns() {
        show(large = true)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        metricLabels.forEach { label ->
            rule.onNodeWithText(label).performScrollTo().assertIsDisplayed()
            val result = layout(rule.onNodeWithText(label))
            assertTextFits(result)
            assertTrue("Metric still squeezed into multiple lines: $label", result.lineCount <= 2)
        }
    }

    @Test fun ordinaryLayoutRetainsThreeVisibleTabs() {
        show(large = false)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        listOf("Metrics", "Files", "Trace").forEach {
            rule.onNodeWithTag("run-details-tab-$it").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
            assertEquals(1, layout(rule.onNodeWithTag("run-details-tab-label-$it", useUnmergedTree = true)).lineCount)
        }
        // The one disclosure belongs to the bottom of the card, not between
        // summary and details. It stays reachable when the body scrolls.
        val handle = rule.onNodeWithContentDescription(collapseLabel)
        handle.assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        val handleBounds = handle.getUnclippedBoundsInRoot()
        val tabs = rule.onNodeWithTag("run-details-tab-Metrics").getUnclippedBoundsInRoot()
        val shell = rule.onNodeWithTag("run-island-shell").getUnclippedBoundsInRoot()
        assertTrue(handleBounds.top >= tabs.bottom)
        assertTrue(handleBounds.bottom <= shell.bottom)
    }

    @Test fun summaryBodyIsInertAndDisclosureAloneOpensDetails() {
        show(large = false)
        rule.onNodeWithText(idleSummary).performTouchInput { click() }
        rule.onNodeWithTag("run-details-tab-Metrics").assertDoesNotExist()
        rule.onNodeWithContentDescription(detailsLabel).assertIsDisplayed().performTouchInput { click() }
        rule.onNodeWithTag("run-details-tab-Metrics").assertIsDisplayed()
    }

    @Test fun realVerticalSwipeReachesTheLastMetric() {
        show(large = true)
        rule.onNodeWithContentDescription(detailsLabel).performTouchInput { click() }
        val body = rule.onNode(SemanticsMatcher.keyIsDefined(
            androidx.compose.ui.semantics.SemanticsProperties.VerticalScrollAxisRange)
            and hasAnyDescendant(hasTestTag("run-details-tab-Metrics")))
        val before = rule.onNodeWithTag("run-details-tab-Metrics").getUnclippedBoundsInRoot()
        val rangeBefore = body.fetchSemanticsNode().config[
            androidx.compose.ui.semantics.SemanticsProperties.VerticalScrollAxisRange]
        val start = rangeBefore.value()
        val maximum = rangeBefore.maxValue()
        val density = body.fetchSemanticsNode().layoutInfo.density.density
        println("Pointer scroll before=$start/$maximum tab=$before density=$density")
        assertTrue("Fixture must require real scrolling", maximum > 20f)
        assertEquals("Fixture did not start at its top", 0f, start, 1f)
        repeat(3) { body.performTouchInput { swipeUp(durationMillis = 600) } }
        val after = rule.onNodeWithTag("run-details-tab-Metrics").getUnclippedBoundsInRoot()
        val rangeAfter = body.fetchSemanticsNode().config[
            androidx.compose.ui.semantics.SemanticsProperties.VerticalScrollAxisRange]
        println("Pointer scroll after=${rangeAfter.value()}/${rangeAfter.maxValue()} tab=$after")
        assertEquals("A real pointer swipe did not reach the actual end",
            maximum, rangeAfter.value(), 2f)
        assertEquals("Pointer scroll changed its content range", maximum, rangeAfter.maxValue(), 2f)
        assertEquals("Tab movement did not follow the actual scroll distance",
            (rangeAfter.value() - start) / density, (before.top - after.top).value, 1f)
        rule.onNodeWithText(metricLabels.last()).assertIsDisplayed()
        rule.onNodeWithTag("run-island-persistent-title", useUnmergedTree = true).assertIsDisplayed()
    }

    @Test fun realHorizontalSwipeReachesAndSelectsSteps() {
        show(large = true)
        rule.onNodeWithContentDescription(detailsLabel).performTouchInput { click() }
        val tabs = rule.onNode(SemanticsMatcher.keyIsDefined(
            androidx.compose.ui.semantics.SemanticsProperties.HorizontalScrollAxisRange)
            and hasAnyDescendant(hasTestTag("run-details-tab-Metrics")))
        tabs.performScrollTo().performTouchInput { swipeLeft(durationMillis = 600) }
        rule.onNodeWithTag("run-details-tab-Trace").assertIsDisplayed()
            .performTouchInput { click() }.assertIsSelected()
    }

    @Test fun oneTitleSurvivesEveryMorphFrameAndReversal() {
        show(large = true, motion = MotionPreference.Full)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.waitForIdle()
        val title = rule.onNodeWithTag("run-island-persistent-title", useUnmergedTree = true)
        val identity = title.fetchSemanticsNode().id
        val anchor = title.getUnclippedBoundsInRoot()
        fun assertAnchor() {
            rule.onAllNodesWithText("Island layout", useUnmergedTree = true).assertCountEquals(1)
            assertEquals("Title node was replaced during morph", identity, title.fetchSemanticsNode().id)
            title.assertIsDisplayed()
            val bounds = title.getUnclippedBoundsInRoot()
            assertEquals(anchor.top.value, bounds.top.value, 1f)
            assertEquals(anchor.bottom.value, bounds.bottom.value, 1f)
            assertEquals((anchor.left.value + anchor.right.value) / 2f,
                (bounds.left.value + bounds.right.value) / 2f, 1f)
        }
        rule.mainClock.autoAdvance = false
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        repeat(6) { rule.mainClock.advanceTimeByFrame(); assertAnchor() }
        // Reverse while closing through the real title's ancestor action.
        rule.onNodeWithText("Island layout").performClick()
        repeat(22) { rule.mainClock.advanceTimeByFrame(); assertAnchor() }
        rule.mainClock.autoAdvance = true
        rule.onNodeWithTag("run-details-tab-Metrics").performScrollTo().assertIsDisplayed()
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        assertAnchor()
        rule.onNodeWithContentDescription(detailsLabel).assertDoesNotExist()
    }

    @Test fun frenchLargeEmptyTabsKeepFullCopyAndReachableDisclosure() {
        show(large = true, status = AgentRunStatus.Cancelled)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        val context = android.view.ContextThemeWrapper(rule.activity, 0).apply {
            applyOverrideConfiguration(Configuration(rule.activity.resources.configuration).apply {
                setLocale(Locale.FRENCH)
            })
        }
        for ((tab, copy) in listOf("Files" to WorkbenchR.string.run_details_no_files,
            "Trace" to WorkbenchR.string.run_details_no_trace)) {
            rule.onNodeWithTag("run-details-tab-$tab").performScrollTo().performClick().assertIsSelected()
            val text = rule.onNodeWithText(context.getString(copy)).performScrollTo().assertIsDisplayed()
            assertTextFits(layout(text))
            rule.onNodeWithTag("run-island-persistent-title", useUnmergedTree = true).assertIsDisplayed()
            rule.onNodeWithContentDescription(context.getString(
                com.andysagent.ragent.core.agentui.R.string.agentui_collapse))
                .assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        }
    }

    @Test fun normalDetailsInterpolateAndReverseInsideTheSameShell() {
        show(large = false, motion = MotionPreference.Full)
        val shell = rule.onNodeWithTag("run-island-shell")
        val title = rule.onNodeWithTag("run-island-persistent-title", useUnmergedTree = true)
        val identity = title.fetchSemanticsNode().id
        val summary = rule.onNodeWithText(idleSummary)
        val summaryIdentity = summary.fetchSemanticsNode().id
        val summaryBounds = summary.getUnclippedBoundsInRoot()
        fun height() = shell.getUnclippedBoundsInRoot().let { it.bottom.value - it.top.value }
        val compactHeight = height()
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.waitForIdle()
        val fullHeight = height()
        rule.onNodeWithContentDescription(collapseLabel).performClick()
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        val opening = mutableListOf<Float>()
        repeat(4) {
            rule.mainClock.advanceTimeBy(32)
            opening += height()
            assertEquals(identity, title.fetchSemanticsNode().id)
            summary.assertIsDisplayed()
            assertEquals(summaryIdentity, summary.fetchSemanticsNode().id)
            assertEquals(summaryBounds.top.value, summary.getUnclippedBoundsInRoot().top.value, 1f)
        }
        assertTrue("Details must contain intermediate geometry", opening.any { it > compactHeight + 2 && it < fullHeight - 2 })
        assertTrue("Opening reversed", opening.zipWithNext().all { (a, b) -> b >= a - 1 })
        rule.onNodeWithContentDescription(collapseLabel).performClick()
        val closing = mutableListOf<Float>()
        repeat(40) {
            rule.mainClock.advanceTimeByFrame()
            closing += height()
            assertEquals(identity, title.fetchSemanticsNode().id)
            summary.assertIsDisplayed()
            assertEquals(summaryIdentity, summary.fetchSemanticsNode().id)
            assertEquals(summaryBounds.top.value, summary.getUnclippedBoundsInRoot().top.value, 1f)
        }
        // A velocity-preserving spring brakes before reversing. It must not
        // jump to a new start or expand again after that one initial braking arc.
        val peak = closing.indices.maxBy { closing[it] }
        assertTrue("Reversal failed to brake promptly: $closing", peak <= 4)
        assertTrue("Reversal overshot full details", closing.all { it <= fullHeight + 1f })
        assertTrue("Reversal grew a second time: $closing", closing.drop(peak).zipWithNext().all { (a, b) -> b <= a + 1 })
        assertEquals(compactHeight, closing.last(), 1f)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
    }

    @Test fun detailsForegroundKeepsNormalSizeThroughoutDisclosureAndReversal() {
        show(large = false, motion = MotionPreference.Full)
        val shell = rule.onNodeWithTag("run-island-shell")
        val details = rule.onNodeWithTag("run-island-details-body", useUnmergedTree = true)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.waitForIdle()
        val endpoint = drawnBounds(details)
        val identity = details.fetchSemanticsNode().id
        val fullHeight = shell.getUnclippedBoundsInRoot().height.value
        rule.onNodeWithContentDescription(collapseLabel).performClick()
        rule.waitForIdle()
        val compactHeight = shell.getUnclippedBoundsInRoot().height.value
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        var intermediateFrames = 0
        fun assertNormalSize() {
            val bounds = drawnBounds(details)
            assertEquals("Details narrowed into a miniature panel", endpoint.width.value, bounds.width.value, 1f)
            assertEquals("Details glyph/content scale changed", endpoint.height.value, bounds.height.value, 1f)
            assertEquals(identity, details.fetchSemanticsNode().id)
            val height = shell.getUnclippedBoundsInRoot().height.value
            if (height > compactHeight + 2f && height < fullHeight - 2f) intermediateFrames++
        }
        repeat(8) { rule.mainClock.advanceTimeByFrame(); assertNormalSize() }
        rule.onNodeWithContentDescription(collapseLabel).performClick()
        repeat(24) { rule.mainClock.advanceTimeByFrame(); assertNormalSize() }
        assertTrue("No actual intermediate disclosure frames checked", intermediateFrames >= 6)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(compactHeight, shell.getUnclippedBoundsInRoot().height.value, 1f)
    }

    @Test fun sideControlsFollowActualTitleSpaceWithoutAnIndependentHandoff() {
        show(large = false, motion = MotionPreference.Full, open = false)
        val shell = rule.onNodeWithTag("run-island-shell")
        val back = rule.onNodeWithTag("conversation-back-shell", useUnmergedTree = true)
        val more = rule.onNodeWithTag("conversation-more-shell", useUnmergedTree = true)
        val restingBack = drawnBounds(back)
        val restingMore = drawnBounds(more)
        rule.onNodeWithText("Island layout").performClick()
        rule.waitForIdle()
        val expandedWidth = shell.getUnclippedBoundsInRoot().width.value
        assertEquals(0f, drawnBounds(back).width.value, 1f)
        assertEquals(0f, drawnBounds(more).width.value, 1f)
        rule.mainClock.autoAdvance = false
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        var intermediateFrames = 0
        fun assertSideSpace() {
            val width = shell.getUnclippedBoundsInRoot().width.value
            val free = ((expandedWidth - width) / 2f).coerceAtLeast(0f)
            val left = drawnBounds(back)
            val right = drawnBounds(more)
            val expected = minOf(restingBack.width.value, free)
            assertEquals("Back did not follow actual shell space", expected, left.width.value, 1f)
            assertEquals("More did not follow actual shell space", expected, right.width.value, 1f)
            assertEquals("Back outer anchor moved", restingBack.left.value, left.left.value, 1f)
            assertEquals("More outer anchor moved", restingMore.right.value, right.right.value, 1f)
            if (left.width.value > 1f && left.width.value < restingBack.width.value - 1f) intermediateFrames++
        }
        repeat(19) { rule.mainClock.advanceTimeByFrame(); assertSideSpace() }
        // Reverse through the real retained title, not an exported fake phase.
        rule.onNodeWithText("Island layout").performClick()
        repeat(24) { rule.mainClock.advanceTimeByFrame(); assertSideSpace() }
        assertTrue("No intermediate side-control geometry checked", intermediateFrames >= 2)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
    }

    @Test fun normalDetailsKeepTheChosenTabAcrossCompactRoundTrip() {
        show(large = false)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.onNodeWithTag("run-details-tab-Files").performClick().assertIsSelected()
        rule.onNodeWithContentDescription(collapseLabel).performClick()
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.onNodeWithTag("run-details-tab-Files").assertIsSelected()
    }

    @Test fun switchingToEmptyFilesInterpolatesTheShellHeight() {
        show(large = false, motion = MotionPreference.Full, status = AgentRunStatus.Cancelled)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.waitForIdle()
        val shell = rule.onNodeWithTag("run-island-shell")
        fun height() = shell.getUnclippedBoundsInRoot().let { it.bottom - it.top }
        val expandedHeight = height()
        val metricsBounds = rule.onNodeWithTag("run-tab-page-Metrics").getUnclippedBoundsInRoot()
        val metricsHeight = metricsBounds.bottom - metricsBounds.top
        rule.mainClock.autoAdvance = false
        rule.onNodeWithTag("run-details-tab-Files").performClick()
        val samples = mutableListOf<Float>()
        repeat(8) {
            rule.mainClock.advanceTimeByFrame()
            samples += height().value
        }
        rule.mainClock.advanceTimeBy(400)
        val compactHeight = height()
        val filesBounds = rule.onNodeWithTag("run-tab-page-Files").getUnclippedBoundsInRoot()
        val filesHeight = filesBounds.bottom - filesBounds.top
        println("Empty tab morph: from=$expandedHeight, to=$compactHeight, frames=$samples")
        // The flat metrics layout no longer has the old nested-card padding.
        // Prove the shell follows the actual page-height difference instead of
        // requiring that decorative padding to manufacture a 48dp movement.
        assertTrue("Fixture does not provide distinct page heights", metricsHeight > filesHeight + 2.dp)
        assertEquals("Shell did not follow the actual content-height change",
            (metricsHeight - filesHeight).value, (expandedHeight - compactHeight).value, 2f)
        assertTrue("Shell switched directly instead of interpolating", samples.any {
            it > compactHeight.value + 2f && it < expandedHeight.value - 2f
        })
        assertTrue("Shell height reversed unexpectedly", samples.zipWithNext().all { (a, b) -> b <= a + 1f })
        assertTrue("Empty shell must stay compact", compactHeight < 280.dp)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
    }

    @Test fun normalWholeCloseKeepsOneContinuousShellAndCanReverse() {
        show(large = false, motion = MotionPreference.Full)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.waitForIdle()
        val title = rule.onNodeWithTag("run-island-persistent-title", useUnmergedTree = true)
        val identity = title.fetchSemanticsNode().id
        val shell = rule.onNodeWithTag("run-island-shell")
        fun width() = shell.getUnclippedBoundsInRoot().let { (it.right - it.left).value }
        fun height() = shell.getUnclippedBoundsInRoot().let { (it.bottom - it.top).value }
        val fullWidth = width()
        val fullHeight = height()
        rule.mainClock.autoAdvance = false
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        val earlyWidths = mutableListOf<Float>()
        val earlyHeights = mutableListOf<Float>()
        // Capture the dispatch/start frames as well as the first motion
        // frames. A paused Compose clock needs composition/measure startup;
        // these samples are not an input-latency or wall-clock assertion.
        repeat(6) {
            rule.mainClock.advanceTimeByFrame()
            earlyWidths += width()
            earlyHeights += height()
            assertEquals(identity, title.fetchSemanticsNode().id)
            rule.onNodeWithText(idleSummary).assertDoesNotExist()
        }
        println("Whole close start widths=$earlyWidths heights=$earlyHeights full=$fullWidth/$fullHeight")
        // One shell contracts both axes from the first motion segment.
        // The body still keeps its endpoint layout instead of scaling glyphs.
        assertTrue("Width still waits for a separate title contraction", earlyWidths.last() < fullWidth - 2f)
        assertTrue("Closing still waits on a full-height empty shell", earlyHeights.last() < fullHeight - 1f)
        val widths = mutableListOf<Float>()
        val heights = mutableListOf<Float>()
        repeat(6) { rule.mainClock.advanceTimeByFrame(); widths += width(); heights += height() }
        assertTrue("Whole close has no body withdrawal intermediates: $heights", heights.distinct().size > 2)
        assertTrue("Close width reversed: $widths", widths.zipWithNext().all { (a, b) -> b <= a + 1 })
        assertTrue("Close height grew beyond its starting shell: $heights", heights.all { it <= fullHeight + 1 })
        assertTrue("Close height reversed: $heights", heights.zipWithNext().all { (a, b) -> b <= a + 1 })
        rule.onNodeWithText("Island layout").performClick()
        repeat(24) { rule.mainClock.advanceTimeByFrame(); assertEquals(identity, title.fetchSemanticsNode().id) }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(fullWidth, width(), 1f)
        rule.onNodeWithTag("run-details-tab-Metrics").assertIsDisplayed()
        rule.onNodeWithText(idleSummary).assertIsDisplayed()
        // Cover the entire closing tail, not only the first 144ms before reversal.
        rule.mainClock.autoAdvance = false
        val settledHeight = height()
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        val completeClose = mutableListOf<Float>()
        val completeWidths = mutableListOf<Float>()
        repeat(24) { rule.mainClock.advanceTimeByFrame(); completeClose += height(); completeWidths += width() }
        assertTrue("Complete close exceeded its starting height: $completeClose", completeClose.all { it <= settledHeight + 1 })
        assertTrue("Complete close height reversed: $completeClose", completeClose.zipWithNext().all { (a, b) -> b <= a + 1 })
        assertTrue("Title contraction has no intermediate width: $completeWidths", completeWidths.distinct().size > 3)
        assertTrue("Title contraction reversed: $completeWidths", completeWidths.zipWithNext().all { (a, b) -> b <= a + 1 })
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
    }

    @Test fun wholeClosingKeepsNormalSizeForegroundWhileBothAxesContract() {
        show(large = false, motion = MotionPreference.Full)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.waitForIdle()
        val shell = rule.onNodeWithTag("run-island-shell")
        val title = rule.onNodeWithTag("run-island-persistent-title", useUnmergedTree = true)
        val body = rule.onNodeWithTag("run-island-body", useUnmergedTree = true)
        val endpoint = shell.getUnclippedBoundsInRoot()
        val bodyWidth = drawnBounds(body).width.value
        val titleWidth = title.getUnclippedBoundsInRoot().width.value
        val titleHeight = title.getUnclippedBoundsInRoot().height.value
        rule.mainClock.autoAdvance = false
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        var bodyFrames = 0
        var narrowTitleFrames = 0
        var coupledFrames = 0
        repeat(24) {
            rule.mainClock.advanceTimeByFrame()
            val actual = shell.getUnclippedBoundsInRoot()
            assertEquals("Foreground was scaled into a miniature card", bodyWidth,
                drawnBounds(body).width.value, 1f)
            if (actual.height.value > titleHeight + 1f) {
                bodyFrames++
            }
            if (actual.width.value < endpoint.width.value - 1f) {
                narrowTitleFrames++
                if (actual.height.value > titleHeight + 2f) {
                    coupledFrames++
                    val widthPhase = (actual.width.value - titleWidth) / (endpoint.width.value - titleWidth)
                    val heightPhase = (actual.height.value - titleHeight) / (endpoint.height.value - titleHeight)
                    val p = kotlin.math.sqrt(heightPhase.coerceIn(0f, 1f))
                    val remaining = 1f - p
                    val remainingCubed = remaining * remaining * remaining
                    val expectedWidth = 1f - remainingCubed * (.15f + .85f * remainingCubed)
                    assertEquals("Width lost the shared reading-space trajectory", expectedWidth, widthPhase, .02f)
                }
            }
        }
        assertTrue("No actual body withdrawal checked", bodyFrames >= 8)
        assertTrue("No actual title contraction checked", narrowTitleFrames >= 4)
        assertTrue("Both axes lack shared intermediate shapes", coupledFrames >= 8)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
    }

    @Test fun normalWholeCloseRetainsDisclosureAndChosenTabOnReopen() {
        show(large = false, motion = MotionPreference.Full)
        rule.onNodeWithContentDescription(detailsLabel).performClick()
        rule.onNodeWithTag("run-details-tab-Files").performClick().assertIsSelected()
        val shell = rule.onNodeWithTag("run-island-shell")
        val endpoint = shell.getUnclippedBoundsInRoot()
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        rule.onNodeWithTag("run-details-tab-Files").assertDoesNotExist()
        rule.onNodeWithText("Island layout").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("run-details-tab-Files").assertIsDisplayed().assertIsSelected()
        val reopened = shell.getUnclippedBoundsInRoot()
        assertEquals((endpoint.right - endpoint.left).value, (reopened.right - reopened.left).value, 1f)
        assertEquals((endpoint.bottom - endpoint.top).value, (reopened.bottom - reopened.top).value, 1f)
    }
}
