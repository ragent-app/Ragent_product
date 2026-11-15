package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.feature.workbench.WorkbenchEvent
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.Locale
import java.io.File

/** Actual root navigation contracts; visual quality still needs native frames. */
class PrimaryNavigationContinuityUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private lateinit var state: MutableState<WorkbenchUiState>

    private fun show(restoration: StateRestorationTester? = null) {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.ENGLISH) })
        state = mutableStateOf(WorkbenchUiState(
            destination = AgentoDestination.Home,
            connection = AgentConnectionStatus.Connected,
            projects = (1..12).map { Project("p$it", "Project $it") },
            sessions = (1..12).map { Session("s$it", "Conversation $it", "p$it", SessionStatus.Completed,
                updatedAt = 1_700_000_000_000L - it * 60_000) },
        ))
        val content: @Composable () -> Unit = {
            CompositionLocalProvider(LocalContext provides context) {
                RagentTheme(darkTheme = false, motionPreference = MotionPreference.Full) {
                    WorkbenchScreen(state.value, onEvent = { event ->
                        if (event is WorkbenchEvent.SelectDestination) state.value = state.value.copy(destination = event.destination)
                    })
                }
            }
        }
        if (restoration == null) rule.setContent(content) else restoration.setContent(content)
        rule.waitForIdle()
    }

    private fun dockSlot(): Float {
        val shell = rule.onNodeWithTag("bottom-navigation-shell").getUnclippedBoundsInRoot()
        val lens = rule.onNodeWithTag("bottom-navigation-selection").getUnclippedBoundsInRoot()
        return (lens.left - shell.left - 4.dp).value / ((shell.right - shell.left).value / 3f)
    }

    private fun assertPageDockPhase(target: AgentoDestination, startSlot: Float, frame: Int): Boolean {
        val pages = rule.onAllNodesWithTag("primary-page-${target.route}").fetchSemanticsNodes()
        if (pages.isEmpty()) {
            assertEquals("Dock advanced before $target acquired its actual page at frame $frame",
                startSlot, dockSlot(), .008f)
            return false
        }
        assertEquals("Multiple actual target visits", 1, pages.size)
        val page = rule.onNodeWithTag("primary-page-${target.route}").getUnclippedBoundsInRoot()
        val pagePhase = 1f - kotlin.math.abs(page.left.value) / (page.right - page.left).value
        val dockPhase = (dockSlot() - startSlot) / (target.ordinal.toFloat() - startSlot)
        assertEquals("Page/dock separated at $target frame $frame", pagePhase, dockPhase, .008f)
        return true
    }

    @Test fun actualPageAndDockFollowTheSamePhaseInBothDirectionsAndBack() {
        show()
        // Home -> Chat -> Settings -> Home are deliberately different widths
        // and action-presence endpoints. Compare actual page positions, not a
        // test-only exported progress or coincidentally equal durations.
        listOf(AgentoDestination.Sessions, AgentoDestination.Settings, AgentoDestination.Home).forEach { target ->
            val startSlot = dockSlot()
            rule.mainClock.autoAdvance = false
            rule.runOnUiThread { state.value = state.value.copy(destination = target) }
            var actualPageFrames = 0
            repeat(24) { index ->
                rule.mainClock.advanceTimeBy(16)
                if (assertPageDockPhase(target, startSlot, index)) actualPageFrames++
            }
            assertTrue("No actual page transition was checked", actualPageFrames >= 20)
            rule.mainClock.autoAdvance = true
            rule.waitForIdle()
        }
        val startSlot = dockSlot()
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        var actualBackFrames = 0
        repeat(24) { index ->
            rule.mainClock.advanceTimeBy(16)
            if (assertPageDockPhase(AgentoDestination.Settings, startSlot, index)) actualBackFrames++
        }
        assertTrue("No actual Back transition was checked", actualBackFrames >= 20)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(AgentoDestination.Settings, state.value.destination) }
    }

    @Test fun realTabClickMovesTheDockWithThePageBeforeAndAfterReversal() {
        assertClickedReturn(warmHistory = false)
    }

    @Test fun realTabClickAfterCompletedVisitsDoesNotReplayThePreviousDockPath() {
        assertClickedReturn(warmHistory = true)
    }

    @Test fun realTabClickImmediatelyReversingAfterCompletedVisitsKeepsTheLivePhase() {
        assertClickedReturn(warmHistory = true, forwardFrames = 4)
    }

    private fun assertClickedReturn(warmHistory: Boolean, forwardFrames: Int = 8) {
        show()
        if (warmHistory) {
            listOf("Chat", "Settings", "Home").forEach {
                rule.onNodeWithContentDescription(it).performTouchInput { click() }
                rule.waitForIdle()
            }
        }
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Chat").performTouchInput { click() }
        var actualFrames = 0
        repeat(forwardFrames) { index ->
            rule.mainClock.advanceTimeBy(16)
            if (assertPageDockPhase(AgentoDestination.Sessions, 1f, index)) actualFrames++
            assertRenderedReturnForeground("forward-$index")
        }
        assertTrue("The injected tap must produce actual page frames", actualFrames >= minOf(2, forwardFrames))
        rule.onNodeWithContentDescription("Home").performTouchInput { click() }
        val deviations = mutableListOf<String>()
        repeat(16) { index ->
            rule.mainClock.advanceTimeBy(16)
            val page = rule.onNodeWithTag("primary-page-home").getUnclippedBoundsInRoot()
            val homePhase = 1f - page.left.value / (page.right - page.left).value
            val slot = dockSlot()
            if (kotlin.math.abs(homePhase - slot) > .012f) deviations += "$index: page=$homePhase dock=$slot"
            assertRenderedReturnForeground("return-$index")
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertTrue("Clicked return separated dock from retained Home: $deviations", deviations.isEmpty())
    }

    private fun assertRenderedReturnForeground(frame: String) {
        val slot = dockSlot().coerceIn(0f, 1f)
        val root = rule.onRoot()
        val origin = root.fetchSemanticsNode().boundsInWindow.topLeft
        val image = root.captureToImage()
        val pixels = image.toPixelMap()
        if (frame in listOf("forward-7", "return-0", "return-3")) {
            val folder = InstrumentationRegistry.getInstrumentation().targetContext
                .getExternalFilesDir("primary-motion-qa")!!
            File(folder, "$frame.png").outputStream().use {
                image.asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        listOf(AgentoDestination.Sessions to (1f - slot), AgentoDestination.Home to slot).forEach { (target, emphasis) ->
            val bounds = rule.onNodeWithTag("bottom-navigation-foreground-${target.route}", true)
                .fetchSemanticsNode().boundsInWindow.translate(-origin)
            var actualBlueContrast = 0f
            for (y in bounds.top.toInt() until bounds.bottom.toInt()) {
                for (x in bounds.left.toInt() until bounds.right.toInt()) {
                    val pixel = pixels[x, y]
                    actualBlueContrast = maxOf(actualBlueContrast, pixel.blue - pixel.red)
                }
            }
            val tint = lerp(Color(0x993C3C43), AgentoFrostedTokens.AppleBlueLight, emphasis)
            assertEquals("Rendered foreground left the lens at $target $frame",
                (tint.blue - tint.red) * tint.alpha, actualBlueContrast, .06f)
        }
    }

    @Test fun thirdTargetKeepsPresentedDockAndOutgoingPagePositions() {
        show()
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { state.value = state.value.copy(destination = AgentoDestination.Sessions) }
        rule.mainClock.advanceTimeBy(96)
        val slotBefore = dockSlot()
        val pageBefore = rule.onNodeWithTag("primary-page-sessions").getUnclippedBoundsInRoot().left.value
        rule.runOnUiThread { state.value = state.value.copy(destination = AgentoDestination.Settings) }
        assertEquals("Dock replaced its presented geometry on a third target", slotBefore, dockSlot(), .008f)
        assertEquals("Outgoing page teleported on a third target", pageBefore,
            rule.onNodeWithTag("primary-page-sessions").getUnclippedBoundsInRoot().left.value, 1f)
        var actualPageFrames = 0
        var handoffSlot = slotBefore
        repeat(12) { index ->
            rule.mainClock.advanceTimeBy(16)
            if (rule.onAllNodesWithTag("primary-page-settings").fetchSemanticsNodes().isEmpty()) {
                // Until NavHost acquires the new visit, the old page still
                // travels. Require its live geometry, not a frozen request-time slot.
                assertPageDockPhase(AgentoDestination.Sessions, 1f, index)
                handoffSlot = dockSlot()
            } else if (assertPageDockPhase(AgentoDestination.Settings, handoffSlot, index)) actualPageFrames++
        }
        assertTrue("No actual retarget transition was checked", actualPageFrames >= 8)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Settings").assertIsSelected()
    }

    @Test fun destinationLinkHasIntermediatePageAndDockGeometry() {
        show()
        val dockBefore = rule.onNodeWithTag("bottom-navigation-shell").getUnclippedBoundsInRoot()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithText("View all").performClick()
        rule.mainClock.advanceTimeBy(80)
        rule.onNodeWithTag("primary-page-home").assertExists()
        val early = rule.onNodeWithTag("primary-page-sessions").getUnclippedBoundsInRoot()
        assertTrue("The incoming page should not snap to its resting position: $early", early.left.value < -1f)
        val outgoing = rule.onNodeWithTag("primary-page-home").getUnclippedBoundsInRoot()
        assertEquals("Peer pages must meet without a gap or overlap", early.right.value, outgoing.left.value, 1f)
        rule.mainClock.advanceTimeBy(80)
        val later = rule.onNodeWithTag("primary-page-sessions").getUnclippedBoundsInRoot()
        assertTrue("Incoming position should move toward rest", later.left > early.left)
        val dockMiddle = rule.onNodeWithTag("bottom-navigation-shell").getUnclippedBoundsInRoot()
        assertTrue("Dock should follow the route, not wait for the page to finish", dockMiddle.left != dockBefore.left)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithTag("primary-page-home").assertDoesNotExist()
        assertEquals(0f, rule.onNodeWithTag("primary-page-sessions").getUnclippedBoundsInRoot().left.value, 1f)
        rule.runOnIdle { assertEquals(AgentoDestination.Sessions, state.value.destination) }
    }

    @Test fun rapidRetargetSettlesOnTheLastRequestedPage() {
        show()
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { state.value = state.value.copy(destination = AgentoDestination.Settings) }
        rule.mainClock.advanceTimeBy(80)
        rule.runOnUiThread { state.value = state.value.copy(destination = AgentoDestination.Sessions) }
        rule.mainClock.advanceTimeBy(64)
        rule.runOnUiThread { state.value = state.value.copy(destination = AgentoDestination.Home) }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(AgentoDestination.Home, state.value.destination) }
        rule.onNodeWithTag("primary-page-home").assertIsDisplayed()
        rule.onNodeWithTag("primary-page-settings").assertDoesNotExist()
        rule.onNodeWithTag("primary-page-sessions").assertDoesNotExist()
        rule.onNodeWithContentDescription("Home").assertIsSelected()
    }

    @Test fun tappingTheOutgoingTabReversesItsVisitInsteadOfCreatingAnotherPage() {
        assertOutgoingVisitIsReused(detour = false)
    }

    @Test fun returningThroughAThirdTargetStillReusesTheVisibleOutgoingVisit() {
        assertOutgoingVisitIsReused(detour = true)
    }

    private fun assertOutgoingVisitIsReused(detour: Boolean) {
        show()
        rule.onNodeWithContentDescription("Settings").performClick()
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Home").performClick()
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Chat").performClick()
        rule.mainClock.advanceTimeBy(128)
        val homeBefore = rule.onNodeWithTag("primary-page-home").getUnclippedBoundsInRoot()
        assertTrue("The outgoing Home must already be moving", homeBefore.left.value > 1f)
        if (detour) {
            rule.onNodeWithContentDescription("Settings").performClick()
            rule.mainClock.advanceTimeBy(64)
        }
        rule.onNodeWithContentDescription("Home").performClick()
        rule.mainClock.advanceTimeBy(32)
        rule.onAllNodesWithTag("primary-page-home").assertCountEquals(1)
        val returning = rule.onNodeWithTag("primary-page-home").getUnclippedBoundsInRoot()
        assertTrue("Return must reuse the right-hand outgoing page, not spawn a left-hand copy", returning.left.value >= 0f)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Home").assertIsSelected()
        // Cancelling this unfinished visit must not insert Chat in completed history.
        rule.runOnIdle { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(AgentoDestination.Settings, state.value.destination) }
    }

    @Test fun backStillVisitsTheActualPreviousPages() {
        show()
        rule.onNodeWithContentDescription("Settings").performClick()
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Chat").performClick()
        rule.waitForIdle()
        rule.runOnIdle { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(AgentoDestination.Settings, state.value.destination) }
        rule.runOnIdle { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(AgentoDestination.Home, state.value.destination) }
    }

    @Test fun revisitingATabPreservesItsScrollPosition() {
        show()
        rule.onNodeWithContentDescription("Chat").performClick()
        rule.waitForIdle()
        rule.onNode(hasScrollToNodeAction()).performScrollToIndex(6)
        val before = rule.onNodeWithText("Project 7", useUnmergedTree = true).getUnclippedBoundsInRoot()
        rule.onNodeWithContentDescription("Settings").performClick()
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Chat").performClick()
        rule.waitForIdle()
        val after = rule.onNodeWithText("Project 7", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertEquals("Tab revisit must retain the list anchor", before.top.value, after.top.value, 1f)
    }

    @Test fun savedDestinationCacheRestoresItsInactiveListAnchor() {
        val restoration = StateRestorationTester(rule)
        show(restoration)
        rule.onNodeWithContentDescription("Chat").performClick()
        rule.waitForIdle()
        rule.onNode(hasScrollToNodeAction()).performScrollToIndex(6)
        val before = rule.onNodeWithText("Project 7", useUnmergedTree = true).getUnclippedBoundsInRoot()
        rule.onNodeWithContentDescription("Settings").performClick()
        rule.waitForIdle()
        restoration.emulateSavedInstanceStateRestore()
        rule.onNodeWithContentDescription("Chat").performClick()
        rule.waitForIdle()
        val after = rule.onNodeWithText("Project 7", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertEquals("Saved cache must restore an inactive tab's anchor", before.top.value, after.top.value, 1f)
    }

    @Test fun revisitingPreservesAnOpenSearchWithoutInventingAQuery() {
        show()
        rule.onNodeWithContentDescription("Chat").performClick()
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Search sessions").performClick()
        rule.onNode(hasSetTextAction()).assertExists()
        rule.onNodeWithContentDescription("Settings").performClick()
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Chat").performClick()
        rule.waitForIdle()
        rule.onNode(hasSetTextAction()).assertExists()
        rule.runOnIdle { assertEquals("", state.value.sessionSearchQuery) }
    }
}
