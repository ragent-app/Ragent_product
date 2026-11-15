package com.andysagent.ragent

import androidx.activity.ComponentActivity
import android.view.KeyEvent
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.composerRuntimeIdentity
import com.andysagent.ragent.core.agentui.R as AgentUiR
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.model.RuntimeCatalog
import com.andysagent.ragent.core.model.RuntimeModelOption
import com.andysagent.ragent.core.model.RuntimeProviderOption
import com.andysagent.ragent.core.model.RuntimeToolOption
import com.andysagent.ragent.feature.workbench.WorkbenchEvent
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Normal-size product navigation, not an accessibility-only geometry fixture. */
class ComposerPickerMotionUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private var state by mutableStateOf(WorkbenchUiState())
    private var confirmedModels = 0
    private val catalog = RuntimeCatalog(listOf(
        RuntimeToolOption("codex", "Codex", providers = listOf(RuntimeProviderOption("a", "Account A"), RuntimeProviderOption("b", "Account B")),
            models = listOf(RuntimeModelOption("a1", "Model A1", "a"), RuntimeModelOption("a2", "Model A2", "a"), RuntimeModelOption("b1", "Model B1", "b"))),
        RuntimeToolOption("direct", "Direct", models = listOf(RuntimeModelOption("direct-model", "Direct model"))),
    ))
    private fun label(id: Int) = rule.activity.getString(id)
    private fun positionNativeChoiceWindow() {
        // The paused Compose clock cannot stand in for the native window's
        // first draw. Capture its fixed, nonzero viewport before timing motion.
        rule.mainClock.advanceTimeByFrame()
        rule.onNodeWithTag("composer-picker-window").captureToImage()
        rule.mainClock.advanceTimeByFrame()
    }
    private fun show(dark: Boolean = false) {
        confirmedModels = 0
        state = WorkbenchUiState(chatOpen = true, sessionId = "picker-motion-local", connection = AgentConnectionStatus.Connected,
            runtimeTool = "codex", runtimeProvider = "b", runtimeModel = "b1", runtimeCatalog = catalog,
            composerText = "Local preview", runtimePickerOpen = true,
            runtimeSelectionDisplay = composerRuntimeIdentity(catalog, "codex", "b", "b1"))
        rule.setContent {
            RagentTheme(darkTheme = dark, motionPreference = MotionPreference.Full) {
                WorkbenchScreen(state, onEvent = { event ->
                    state = when (event) {
                        WorkbenchEvent.CloseRuntimePicker -> state.copy(runtimePickerOpen = false, runtimeTool = "codex", runtimeProvider = "b", runtimeModel = "b1")
                        is WorkbenchEvent.SelectRuntime -> state.copy(runtimeTool = event.tool, runtimeProvider = null, runtimeModel = null)
                        is WorkbenchEvent.SelectProvider -> state.copy(runtimeProvider = event.provider, runtimeModel = null)
                        is WorkbenchEvent.SelectModel -> { confirmedModels++; state.copy(runtimeModel = event.model, runtimePickerOpen = false,
                            runtimeSelectionDisplay = composerRuntimeIdentity(state.runtimeCatalog, state.runtimeTool, state.runtimeProvider, event.model)) }
                        WorkbenchEvent.CloseEffortPicker -> state.copy(effortPickerOpen = false)
                        WorkbenchEvent.OpenRuntimePicker -> state.copy(runtimePickerOpen = true, effortPickerOpen = false,
                            runtimeSelectionDisplay = composerRuntimeIdentity(state.runtimeCatalog, state.runtimeTool, state.runtimeProvider, state.runtimeModel, state.runtimeSelectionDisplay))
                        WorkbenchEvent.OpenEffortPicker -> state.copy(effortPickerOpen = true, runtimePickerOpen = false)
                        WorkbenchEvent.CloseChat -> state.copy(chatOpen = false)
                        is WorkbenchEvent.EffortChanged -> state.copy(thinkingEffort = event.effort)
                        else -> state
                    }
                })
            }
        }
        rule.waitForIdle()
    }

    @Test fun browsingKeepsCommittedComposerIdentityAndGeometry() {
        show()
        val tags = listOf("composer-model-action", "composer-effort-action")
        val before = tags.associateWith { rule.onNodeWithTag(it, true).fetchSemanticsNode().boundsInRoot }
        fun assertStable() {
            rule.onNodeWithTag("composer-model-label", true).assertTextEquals("Model B1")
            tags.forEach { assertEquals("Browsing moved $it", before[it], rule.onNodeWithTag(it, true).fetchSemanticsNode().boundsInRoot) }
        }
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Codex").performClick()
        repeat(10) { rule.mainClock.advanceTimeBy(32); assertStable() }
        rule.onNodeWithContentDescription("Account A").performClick()
        repeat(10) { rule.mainClock.advanceTimeBy(32); assertStable() }
        // Loading another provider can replace the source list completely.
        rule.runOnIdle { state = state.copy(runtimeCatalog = catalog.copy(tools = catalog.tools.map {
            it.copy(models = it.models.filter { model -> model.provider == "a" })
        })) }
        rule.mainClock.advanceTimeBy(32)
        assertStable()
        rule.mainClock.autoAdvance = true
        assertEquals(0, confirmedModels)
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        rule.waitForIdle()
        assertStable()
    }

    @Test fun threeLayersKeepParentsUnselectedAndOnlyLeafCommits() {
        show()
        rule.onNodeWithContentDescription("Codex").assertIsNotSelected().performClick()
        rule.onNodeWithContentDescription("Account A").assertIsNotSelected().performClick()
        assertEquals(0, confirmedModels)
        rule.onNodeWithContentDescription("Model B1").assertDoesNotExist()
        rule.onNodeWithText("Codex · Account A").assertIsDisplayed()
        rule.onNodeWithContentDescription(label(AgentUiR.string.agentui_return_to_provider)).performClick()
        rule.onNodeWithContentDescription("Account B").assertIsNotSelected().performClick()
        rule.onNodeWithText("Model A1").assertDoesNotExist()
        // Returning to the original path shows the committed leaf, not a draft.
        rule.onNodeWithContentDescription("Model B1").assertIsSelected().performClick()
        assertEquals(1, confirmedModels)
        assertEquals("b1", state.runtimeModel)
        rule.onNodeWithTag("composer-runtime-picker").assertDoesNotExist()
    }

    @Test fun pageMovesThroughIntermediatePositionsAndReversesWithoutCommitting() {
        show(dark = true)
        rule.onNodeWithContentDescription("Codex").performClick()
        val settled = rule.onNodeWithTag("composer-picker-active-page").getUnclippedBoundsInRoot()
        val width = settled.right.value - settled.left.value
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Account A").performClick()
        val positions = mutableListOf<Float>()
        repeat(5) {
            rule.mainClock.advanceTimeBy(32)
            positions += rule.onNodeWithTag("composer-picker-active-page").getUnclippedBoundsInRoot().left.value
        }
        assertTrue("Incoming model page skipped intermediate positions: $positions", positions.any { it > settled.left.value + 2 && it < settled.left.value + width - 2 })
        assertTrue("Incoming page changed direction", positions.zipWithNext().all { (a, b) -> b <= a + 1 })
        rule.onNodeWithContentDescription(label(AgentUiR.string.agentui_return_to_provider)).performClick()
        rule.mainClock.advanceTimeBy(400)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Account B").assertIsDisplayed().assertIsNotSelected()
        rule.onNodeWithText("Model A1").assertDoesNotExist()
        assertEquals(0, confirmedModels)
        assertNull(state.runtimeModel)
    }

    @Test fun shorterModelPageHasContinuousShellHeight() {
        show()
        rule.onNodeWithContentDescription("Codex").performClick()
        fun height() = rule.onNodeWithTag("composer-runtime-picker").getUnclippedBoundsInRoot().let { it.bottom.value - it.top.value }
        val before = height()
        val bottom = rule.onNodeWithTag("composer-runtime-picker").getUnclippedBoundsInRoot().bottom.value
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Account B").performClick()
        val samples = mutableListOf<Float>()
        repeat(8) {
            rule.mainClock.advanceTimeByFrame()
            samples += height()
            assertEquals("The glass bottom moved inside its anchored window", bottom,
                rule.onNodeWithTag("composer-runtime-picker").getUnclippedBoundsInRoot().bottom.value, 1f)
        }
        rule.mainClock.advanceTimeBy(400)
        val after = height()
        assertTrue("A shorter layer must shrink", after < before - 20)
        assertTrue("Shell jumped directly: $samples", samples.any { it > after + 2 && it < before - 2 })
        assertTrue("Shell height reversed", samples.zipWithNext().all { (a, b) -> b <= a + 1 })
        rule.mainClock.autoAdvance = true
    }

    @Test fun cancellationAfterPreviewRestoresExistingConfiguration() {
        show(dark = true)
        rule.onNodeWithContentDescription("Codex").performClick()
        rule.onNodeWithContentDescription("Account A").performClick()
        // Send Back to the focused Popup window, not the underlying Activity.
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        rule.waitForIdle()
        rule.onNodeWithTag("composer-runtime-picker").assertDoesNotExist()
        assertEquals("codex", state.runtimeTool)
        assertEquals("b", state.runtimeProvider)
        assertEquals("b1", state.runtimeModel)
        assertEquals(0, confirmedModels)
    }

    @Test fun loadingRefreshKeepsTheCurrentPageAndUpdatesItsBody() {
        show()
        rule.onNodeWithContentDescription("Codex").performClick()
        rule.runOnIdle { state = state.copy(runtimeModelsLoading = true) }
        rule.onNodeWithContentDescription("Account A").performClick()
        rule.onNodeWithText(label(AgentUiR.string.agentui_loading_models)).assertIsDisplayed()
        val identity = rule.onNodeWithTag("composer-picker-active-page").fetchSemanticsNode().id
        rule.runOnIdle { state = state.copy(runtimeModelsLoading = false) }
        rule.waitForIdle()
        assertEquals(identity, rule.onNodeWithTag("composer-picker-active-page").fetchSemanticsNode().id)
        rule.onNodeWithContentDescription("Model A1").assertIsDisplayed()
        rule.onNodeWithContentDescription("Model B1").assertDoesNotExist()
        assertEquals(0, confirmedModels)
    }

    @Test fun glassHeaderIsInertButReservedBlankAreaCancels() {
        show()
        rule.onNodeWithContentDescription("Codex").performClick()
        rule.onNodeWithTag("composer-runtime-picker").performTouchInput { click(Offset(width / 2f, 36.dp.toPx())) }
        rule.onNodeWithContentDescription("Account A").assertIsDisplayed()
        rule.onNodeWithTag("composer-picker-window").performTouchInput { click(Offset(width / 2f, 8.dp.toPx())) }
        rule.onNodeWithTag("composer-runtime-picker").assertDoesNotExist()
        assertEquals("b1", state.runtimeModel)
        assertEquals(0, confirmedModels)
    }

    @Test fun dismissalRetainsTheDepartingPageAndReopeningStartsAtRuntime() {
        show()
        rule.onNodeWithContentDescription("Codex").performClick()
        rule.onNodeWithContentDescription("Account A").performClick()
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Model A1").assertIsDisplayed()
        rule.mainClock.autoAdvance = false
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        rule.mainClock.advanceTimeByFrame()
        rule.onNodeWithTag("composer-runtime-picker").assertDoesNotExist()
        rule.onNodeWithTag("composer-runtime-picker-exit").assertExists()
            .assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription,
                "${label(AgentUiR.string.agentui_choose_model)} · Codex · Account A"))
        val widths = mutableListOf<Float>()
        val heights = mutableListOf<Float>()
        // The readable page withdraws vertically before its width contracts.
        // Sample both phases, while the same retained popup is still exiting.
        repeat(8) {
            rule.mainClock.advanceTimeBy(32)
            val bounds = rule.onNodeWithTag("composer-runtime-picker-exit").fetchSemanticsNode().boundsInRoot
            widths += bounds.width
            heights += bounds.height
        }
        assertTrue("The full-width page was stationary before its tail: $heights",
            heights.take(4).zipWithNext().all { (a, b) -> b < a - 1f })
        assertTrue("Exit skipped geometric intermediate frames: $widths", widths.distinct().size > 2)
        assertTrue("Exit width reversed: $widths", widths.zipWithNext().all { (a, b) -> b <= a + 1 })
        rule.runOnIdle { state = state.copy(runtimePickerOpen = true) }
        rule.mainClock.advanceTimeBy(400)
        rule.mainClock.autoAdvance = true
        rule.onNodeWithText(label(AgentUiR.string.agentui_choose_runtime)).assertIsDisplayed()
        rule.onNodeWithText("Codex · Account A").assertDoesNotExist()
        assertEquals("b1", state.runtimeModel)
        assertEquals(0, confirmedModels)
    }

    @Test fun confirmedLeafWithdrawsWithoutAcceptingAnotherChoice() {
        show(dark = true)
        rule.onNodeWithContentDescription("Codex").performClick()
        rule.onNodeWithContentDescription("Account A").performClick()
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Model A1").assertIsDisplayed()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Model A1").performClick()
        rule.mainClock.advanceTimeBy(48)
        rule.onNodeWithContentDescription("Model A2").assertDoesNotExist()
        rule.onNodeWithTag("composer-runtime-picker-exit").performTouchInput { click(center) }
        rule.mainClock.advanceTimeBy(48)
        assertEquals(1, confirmedModels)
        assertEquals("a1", state.runtimeModel)
        rule.mainClock.advanceTimeBy(400)
        rule.mainClock.autoAdvance = true
        rule.onNodeWithTag("composer-runtime-picker-exit").assertDoesNotExist()
        rule.onNodeWithTag("composer-picker-window").assertDoesNotExist()
    }

    @Test fun effortUsesContinuousPresenceAndFreezesItsClosingValue() {
        show()
        rule.runOnIdle { state = state.copy(runtimePickerOpen = false) }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { state = state.copy(effortPickerOpen = true, thinkingEffort = .75f) }
        positionNativeChoiceWindow()
        val widths = mutableListOf<Float>()
        repeat(5) {
            rule.mainClock.advanceTimeByFrame()
            widths += rule.onNodeWithTag("composer-effort-picker").fetchSemanticsNode().boundsInRoot.width
        }
        assertTrue("Effort appeared without geometric intermediates: $widths", widths.distinct().size > 2)
        rule.mainClock.advanceTimeBy(400)
        rule.runOnIdle { state = state.copy(effortPickerOpen = false, thinkingEffort = 0f) }
        rule.mainClock.advanceTimeBy(48)
        rule.onNodeWithTag("composer-effort-picker-exit").assertExists()
            .assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.StateDescription,
                "${label(AgentUiR.string.agentui_thinking_effort)} · ${label(AgentUiR.string.agentui_effort_high)}"))
        rule.onNodeWithContentDescription(label(AgentUiR.string.agentui_thinking_effort_slider)).assertDoesNotExist()
        rule.mainClock.advanceTimeBy(400)
        rule.mainClock.autoAdvance = true
        rule.onNodeWithTag("composer-effort-picker-exit").assertDoesNotExist()
    }

    @Test fun effortShellChangesActualHeightWithoutMovingItsBottomAnchor() {
        show(dark = true)
        rule.runOnIdle { state = state.copy(runtimePickerOpen = false, effortPickerOpen = true) }
        rule.waitForIdle()
        val full = rule.onNodeWithTag("composer-effort-picker").getUnclippedBoundsInRoot()
        val fullHeight = full.bottom.value - full.top.value
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { state = state.copy(effortPickerOpen = false) }
        val heights = mutableListOf<Float>()
        repeat(6) {
            rule.mainClock.advanceTimeBy(32)
            val shell = rule.onNodeWithTag("composer-effort-picker-exit").getUnclippedBoundsInRoot()
            heights += shell.bottom.value - shell.top.value
            assertEquals("Presence moved its reserved-window anchor", full.bottom.value, shell.bottom.value, 1f)
        }
        assertTrue("Only text/scale changed; actual shell height did not: $heights",
            heights.any { it > 49f && it < fullHeight - 3f })
        assertTrue(heights.zipWithNext().all { (a, b) -> b <= a + 1f })
        rule.runOnIdle { state = state.copy(effortPickerOpen = true) }
        rule.mainClock.advanceTimeBy(400)
        rule.mainClock.autoAdvance = true
        rule.onNodeWithTag("composer-effort-picker").assertIsDisplayed()
        val reopened = rule.onNodeWithTag("composer-effort-picker").getUnclippedBoundsInRoot()
        assertEquals(fullHeight, reopened.bottom.value - reopened.top.value, 1f)
        assertEquals(.5f, state.thinkingEffort, 0f)
    }

    @Test fun modelOpeningSettlesWidthWhileTheNormalSizePageAndHeightContinueTogether() {
        show()
        rule.runOnIdle { state = state.copy(runtimePickerOpen = false) }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { state = state.copy(runtimePickerOpen = true) }
        positionNativeChoiceWindow()
        val widths = mutableListOf<Float>()
        val heights = mutableListOf<Float>()
        val pageWidths = mutableListOf<Float>()
        repeat(10) {
            rule.mainClock.advanceTimeByFrame()
            val shell = rule.onNodeWithTag("composer-runtime-picker").getUnclippedBoundsInRoot()
            widths += shell.right.value - shell.left.value
            heights += shell.bottom.value - shell.top.value
            val page = rule.onNodeWithTag("composer-picker-foreground").getUnclippedBoundsInRoot()
            pageWidths += page.right.value - page.left.value
        }
        assertTrue("The page rewrapped/scaled with the shell: $pageWidths", pageWidths.max() - pageWidths.min() < 1f)
        assertTrue("Width did not settle ahead of height: $widths / $heights",
            widths.zipWithNext().indices.any { index ->
                kotlin.math.abs(widths[index + 1] - widths[index]) < 1f && heights[index + 1] > heights[index] + 1f
            })
        assertTrue("Height skipped growing positions: $heights", heights.distinct().size >= 8)
        rule.mainClock.advanceTimeBy(800)
        rule.mainClock.autoAdvance = true
        rule.onNodeWithContentDescription("Codex").assertIsDisplayed().assertIsNotSelected()
        assertEquals(0, confirmedModels)
    }

    @Test fun movingShellActuallyDrawsItsHeadingRatherThanOnlyInvisibleSemantics() {
        show()
        val fullHeight = rule.onNodeWithTag("composer-runtime-picker").fetchSemanticsNode().boundsInRoot.height
        fun headingInk(tag: String, probe: String): Int {
            val image = rule.onNodeWithTag(tag).captureToImage()
            java.io.File(rule.activity.getExternalFilesDir(null), "picker-ink-$probe.png").outputStream().use {
                image.asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
            if (probe != "opening") {
                val screen = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
                java.io.File(rule.activity.getExternalFilesDir(null), "picker-ink-$probe-screen.png").outputStream().use {
                    screen.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                }
                java.io.File(rule.activity.getExternalFilesDir(null), "picker-ink-$probe-bounds.txt").writeText(
                    rule.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot.toString())
            }
            val pixels = image.toPixelMap()
            // Inside the rounded glass, away from its corners and source chat.
            val top = with(rule.density) { 8.dp.roundToPx() }
            val bottom = minOf(pixels.height, with(rule.density) { 34.dp.roundToPx() })
            val inset = with(rule.density) { 20.dp.roundToPx() }
            var ink = 0
            for (y in top until bottom) for (x in inset until pixels.width - inset) {
                val color = pixels[x, y]
                if (color.red < .4f && color.green < .4f && color.blue < .4f) ink++
            }
            return ink
        }
        val fullInk = headingInk("composer-runtime-picker", "settled")
        assertTrue("Settled heading probe did not find ink: $fullInk", fullInk > 100)
        rule.runOnIdle { state = state.copy(runtimePickerOpen = false) }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { state = state.copy(runtimePickerOpen = true) }
        positionNativeChoiceWindow()
        rule.mainClock.advanceTimeBy(128)
        val opening = rule.onNodeWithTag("composer-runtime-picker").fetchSemanticsNode().boundsInRoot
        assertTrue("Opening already reached full height instead of a reading intermediate", opening.height < fullHeight - 10)
        headingInk("composer-runtime-picker", "opening-first")
        // Android draws independently of the paused Compose clock. Wait for
        // the same intermediate frame, never advance it to a settled panel.
        val openingTime = rule.mainClock.currentTime
        rule.waitUntil(5_000) { headingInk("composer-runtime-picker", "opening") > 100 }
        assertEquals("Pixel wait advanced the animation", openingTime, rule.mainClock.currentTime)
        val openingInk = headingInk("composer-runtime-picker", "opening")
        assertTrue("Growing shell was empty despite heading semantics: ink=$openingInk, settledInk=$fullInk, height=${opening.height}/$fullHeight", openingInk > 100)
        rule.mainClock.advanceTimeBy(800)
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        rule.mainClock.advanceTimeBy(80)
        val exitTime = rule.mainClock.currentTime
        rule.waitUntil(5_000) { headingInk("composer-runtime-picker-exit", "exit") > 100 }
        assertEquals("Exit pixel wait advanced the animation", exitTime, rule.mainClock.currentTime)
        assertTrue("Retracting shell dropped all heading ink", headingInk("composer-runtime-picker-exit", "exit") > 100)
        rule.mainClock.advanceTimeBy(800)
        rule.mainClock.autoAdvance = true
        assertEquals(0, confirmedModels)
    }

    @Test fun modelHeadingStaysReadableWhileItsWholeRowStillFitsOnExit() = checkLateHeading(effort = false)

    @Test fun effortHeadingStaysReadableWhileItsWholeRowStillFitsOnExit() = checkLateHeading(effort = true)

    private fun checkLateHeading(effort: Boolean) {
        show()
        if (effort) {
            rule.runOnIdle { state = state.copy(runtimePickerOpen = false, effortPickerOpen = true) }
            rule.waitForIdle()
        }
        val tag = if (effort) "composer-effort-picker" else "composer-runtime-picker"
        fun ink(probe: String): Int {
            val image = rule.onNodeWithTag(if (probe == "settled") tag else "$tag-exit").captureToImage()
            java.io.File(rule.activity.getExternalFilesDir(null), "picker-late-$effort-$probe.png").outputStream().use {
                image.asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
            val pixels = image.toPixelMap()
            val inset = with(rule.density) { 20.dp.roundToPx() }
            val top = with(rule.density) { 8.dp.roundToPx() }
            val bottom = minOf(pixels.height, with(rule.density) { 30.dp.roundToPx() })
            var count = 0
            for (y in top until bottom) for (x in inset until pixels.width - inset) {
                val color = pixels[x, y]
                if (maxOf(color.red, color.green, color.blue) < .3f) count++
            }
            return count
        }
        val fullInk = ink("settled")
        assertTrue("Heading probe must cover actual text: $fullInk", fullInk > 100)
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { state = state.copy(runtimePickerOpen = false, effortPickerOpen = false) }
        val headerHeight = if (effort) 36f else 56f
        var sampleHeight = Float.NaN
        for (frame in 0 until 40) {
            rule.mainClock.advanceTimeByFrame()
            val bounds = rule.onNodeWithTag("$tag-exit").getUnclippedBoundsInRoot()
            val height = (bounds.bottom - bounds.top).value
            if (height in (headerHeight + 8f)..(headerHeight + 28f)) {
                sampleHeight = height
                break
            }
        }
        assertTrue("No late viewport with a whole heading row", sampleHeight.isFinite())
        val sampledTime = rule.mainClock.currentTime
        repeat(3) { ink("draw-$it"); rule.waitForIdle() }
        val lateInk = ink("late")
        assertEquals("Pixel checks must not advance to a different animation phase", sampledTime, rule.mainClock.currentTime)
        assertTrue("Whole heading faded too early: height=$sampleHeight ink=$lateInk/$fullInk", lateInk >= fullInk * .6f)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
    }

    @Test fun modelEmptyExitTailLosesVisualWeight() = verifyEmptyTail(false)
    @Test fun effortEmptyExitTailLosesVisualWeight() = verifyEmptyTail(true)

    @Test fun fadingEmptyShellKeepsItsDiffuseHaloOutsideTheShape() {
        show()
        rule.mainClock.autoAdvance = false
        try {
            rule.runOnIdle { state = state.copy(runtimePickerOpen = false) }
            var sampled = false
            for (frame in 0 until 45) {
                rule.mainClock.advanceTimeByFrame()
                val shell = rule.onNodeWithTag("composer-runtime-picker-exit").fetchSemanticsNode().boundsInRoot
                val height = with(rule.density) { shell.height.toDp().value }
                if (height in 25f..31f) {
                    val window = rule.onNodeWithTag("composer-picker-window")
                    val origin = window.fetchSemanticsNode().boundsInRoot.topLeft
                    // Force native paint at this paused Compose phase before sampling.
                    repeat(2) { window.captureToImage(); rule.waitForIdle() }
                    val image = window.captureToImage()
                    java.io.File(rule.activity.getExternalFilesDir(null), "picker-empty-halo.png").outputStream().use {
                        image.asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                    }
                    val pixels = image.toPixelMap()
                    val x = (shell.center.x - origin.x).toInt()
                    fun darkness(offset: Int): Double {
                        val y = (shell.bottom - origin.y + with(rule.density) { offset.dp.toPx() }).toInt()
                        return (-3..3).map { pixels[x + it, y].let { color -> (1f - color.red) * color.alpha }.toDouble() }.average()
                    }
                    val near = darkness(4)
                    val far = darkness(12)
                    assertTrue("Fading clipped the diffuse shadow: near=$near far=$far", near > far + .0008)
                    sampled = true
                    break
                }
            }
            assertTrue("No partially faded shell sampled", sampled)
        } finally { rule.mainClock.autoAdvance = true }
    }

    private fun verifyEmptyTail(effort: Boolean) {
        show(dark = true)
        if (effort) {
            rule.runOnIdle { state = state.copy(runtimePickerOpen = false, effortPickerOpen = true) }
            rule.waitForIdle()
        }
        val tag = if (effort) "composer-effort-picker" else "composer-runtime-picker"
        fun coverage(shell: String, probe: String): Float {
            val image = rule.onNodeWithTag(shell).captureToImage()
            java.io.File(rule.activity.getExternalFilesDir(null), "picker-empty-$effort-$probe.png").outputStream().use {
                image.asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
            val pixels = image.toPixelMap()
            // Empty black conversation, dark glass. Avoid heading/option ink and
            // rounded corners; premultiply in case the native window retains alpha.
            val x = pixels.width * 3 / 4
            val y = if (probe == "settled") with(rule.density) { 4.dp.roundToPx() } else pixels.height / 2
            return (-2..2).map { pixels[x + it, y].let { color -> color.red * color.alpha } }.average().toFloat()
        }
        val full = coverage(tag, "settled")
        assertTrue("Fixture needs a visible dark glass plane: $full", full > .015f)
        rule.mainClock.autoAdvance = false
        try {
            rule.runOnIdle { state = state.copy(runtimePickerOpen = false, effortPickerOpen = false) }
            val headerHeight = if (effort) 36f else 56f
            var sampled = false
            for (frame in 0 until 45) {
                rule.mainClock.advanceTimeByFrame()
                val bounds = rule.onNodeWithTag("$tag-exit").getUnclippedBoundsInRoot()
                val height = (bounds.bottom - bounds.top).value
                if (height in headerHeight * .18f..headerHeight * .30f) {
                    val clock = rule.mainClock.currentTime
                    repeat(2) { coverage("$tag-exit", "draw-$it"); rule.waitForIdle() }
                    val tail = coverage("$tag-exit", "tail")
                    assertEquals(clock, rule.mainClock.currentTime)
                    assertTrue("Empty glass still has full visual weight: height=$height tail=$tail full=$full",
                        tail < full * .35f)
                    sampled = true
                    break
                }
            }
            assertTrue("No actual small exit shell sampled", sampled)
        } finally { rule.mainClock.autoAdvance = true }
    }

    @Test fun activityBackBeforeChoiceRecompositionClosesOnlyTheChoice() {
        show()
        rule.runOnIdle { state = state.copy(runtimePickerOpen = false) }
        rule.waitForIdle()
        listOf(true, false).forEach { runtime ->
            rule.mainClock.autoAdvance = false
            val description = if (runtime) label(AgentUiR.string.agentui_session_configuration).substringBefore('%')
                else label(AgentUiR.string.agentui_thinking_effort)
            rule.onNode(hasContentDescription(description, substring = true)).performClick()
            assertTrue("Fixture never requested a choice", state.runtimePickerOpen || state.effortPickerOpen)
            // No frame advance: exercise the earlier input -> composition gap.
            rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
            rule.mainClock.advanceTimeBy(800)
            rule.mainClock.autoAdvance = true
            rule.waitForIdle()
            assertTrue("Immediate Back navigated chat before choice recomposition", state.chatOpen)
            assertFalse(state.runtimePickerOpen)
            assertFalse(state.effortPickerOpen)
            assertEquals("b1", state.runtimeModel)
            assertEquals(0, confirmedModels)
        }
    }

    @Test fun activityBackDuringNativeChoiceHandoffClosesOnlyTheChoice() {
        show()
        rule.runOnIdle { state = state.copy(runtimePickerOpen = false) }
        rule.waitForIdle()
        listOf(true, false).forEach { runtime ->
            rule.mainClock.autoAdvance = false
            rule.runOnIdle { state = state.copy(runtimePickerOpen = runtime, effortPickerOpen = !runtime) }
            rule.mainClock.advanceTimeByFrame()
            // Explicitly exercise Activity fallback, before native window focus
            // can route this to Popup's own Back handler.
            rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
            rule.mainClock.advanceTimeBy(800)
            rule.mainClock.autoAdvance = true
            rule.waitForIdle()
            assertTrue("Back navigated chat during native choice handoff", state.chatOpen)
            assertFalse(state.runtimePickerOpen)
            assertFalse(state.effortPickerOpen)
            assertEquals("b1", state.runtimeModel)
            assertEquals(0, confirmedModels)
            rule.onNodeWithTag("composer-picker-window").assertDoesNotExist()
        }
    }

    @Test fun nativeBackClosesBothChoicePanelsWithoutDroppingTheComposerKeyboard() {
        rule.runOnUiThread {
            rule.activity.window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        show()
        rule.runOnIdle { state = state.copy(runtimePickerOpen = false) }
        rule.waitForIdle()
        val editor = rule.onNodeWithTag("inline-composer-editor")
        editor.performClick()
        fun imeVisible() = androidx.core.view.ViewCompat.getRootWindowInsets(rule.activity.window.decorView)
            ?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()) == true
        rule.waitUntil(10_000) { imeVisible() }
        val editorId = editor.fetchSemanticsNode().id
        listOf(false, true).forEach { runtime ->
            val panelTag = if (runtime) "composer-runtime-picker" else "composer-effort-picker"
            rule.runOnIdle { state = state.copy(runtimePickerOpen = runtime, effortPickerOpen = !runtime) }
            rule.onNodeWithTag(panelTag).assertIsDisplayed()
            assertTrue("Opening $panelTag replaced the editor IME target", imeVisible())
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            rule.waitForIdle()
            rule.onNodeWithTag(panelTag).assertDoesNotExist()
            assertTrue("Native Back hid IME before closing $panelTag", imeVisible())
            editor.assertIsFocused()
            assertEquals(editorId, editor.fetchSemanticsNode().id)
            assertEquals("Local preview", state.composerText)
            assertEquals(0, confirmedModels)
        }
    }
}
