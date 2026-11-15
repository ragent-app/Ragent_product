package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.feature.workbench.*
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.Locale
import kotlin.math.abs

/** Normal-size hierarchy/entry contracts, not a full visual or motion pass. */
class IndexHierarchyUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private lateinit var state: MutableState<WorkbenchUiState>
    private val events = mutableListOf<WorkbenchEvent>()
    private var signIn: GoogleSignInRequest? = null

    private fun show(destination: AgentoDestination, dark: Boolean = false, motion: MotionPreference = MotionPreference.None, perProject: Int = 3) {
        val context = rule.activity.createConfigurationContext(
            Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.ENGLISH) })
        state = mutableStateOf(WorkbenchUiState(
            destination = destination, connection = AgentConnectionStatus.Connected,
            projects = (1..6).map { Project("p$it", "Project $it") },
            sessions = (1..6 * perProject).map {
                Session("s$it", "Conversation $it", "p${(it - 1) / perProject + 1}", SessionStatus.Completed,
                    updatedAt = 1_700_000_000_000L - it * 60_000)
            },
        ))
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalContext provides context, LocalDensity provides Density(density.density, 1f)) {
                RagentTheme(darkTheme = dark, motionPreference = motion) {
                    WorkbenchScreen(state.value, onRequestGoogleSignIn = { signIn = it }, onEvent = { event ->
                        events += event
                        state.value = when (event) {
                            is WorkbenchEvent.OpenProjectSessions -> state.value.copy(projectSessionsOpen = true, browsingProjectId = event.projectId)
                            WorkbenchEvent.CloseProjectSessions -> state.value.copy(projectSessionsOpen = false, browsingProjectId = null)
                            is WorkbenchEvent.SelectDestination -> state.value.copy(destination = event.destination)
                            is WorkbenchEvent.SessionSearchChanged -> state.value.copy(sessionSearchQuery = event.value)
                            else -> state.value
                        }
                    })
                }
            }
        }
        rule.waitForIdle()
    }

    private fun checkHome(dark: Boolean) {
        show(AgentoDestination.Home, dark)
        val title = rule.onNodeWithText("Recent projects", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val action = rule.onNodeWithText("View all", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertTrue("Section and action are on different vertical centers: $title / $action",
            abs(((title.top + title.bottom - action.top - action.bottom) / 2).value) <= 1f)
        assertEquals(28f, title.left.value, 1f)
        assertEquals(60f, rule.onNodeWithText("Project 1", useUnmergedTree = true).getUnclippedBoundsInRoot().left.value, 1f)
        rule.onNodeWithText("View all").performClick()
        rule.runOnIdle { assertTrue(events.contains(WorkbenchEvent.SelectDestination(AgentoDestination.Sessions))) }
    }
    @Test fun homeSectionAndActionShareOneRowLight() = checkHome(false)
    @Test fun homeSectionAndActionShareOneRowDark() = checkHome(true)

    private fun checkProject(dark: Boolean) {
        show(AgentoDestination.Sessions, dark)
        val title = rule.onNodeWithText("Project 1", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val preview = rule.onNodeWithText("Conversation 1", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertEquals("Preview should align with its parent title", title.left.value, preview.left.value, 1f)
        rule.onAllNodesWithText("3 sessions", useUnmergedTree = true).onFirst().assertIsDisplayed()
        rule.onNodeWithText("Conversation 3").assertDoesNotExist()
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.onNodeWithText("Conversation 3").assertIsDisplayed()
        rule.runOnIdle { assertTrue(events.contains(WorkbenchEvent.OpenProjectSessions("p1"))) }
        rule.onNodeWithContentDescription("Back to projects").performClick()
        rule.onNodeWithContentDescription("Open project: Project 1").assertIsDisplayed()
    }
    @Test fun projectPreviewsAlignAndFullCountOpensCompleteListLight() = checkProject(false)
    @Test fun projectPreviewsAlignAndFullCountOpensCompleteListDark() = checkProject(true)

    private fun checkPreviewHierarchy(dark: Boolean) {
        show(AgentoDestination.Sessions, dark)
        rule.runOnIdle {
            state.value = state.value.copy(sessionId = "s2", sessions = state.value.sessions.map {
                when (it.id) {
                    "s1" -> it.copy(title = "Check every source in the weekly report, confirm outstanding items and preserve reviewed files",
                        status = SessionStatus.WaitingApproval, waitingAction = "approval")
                    "s2" -> it.copy(updatedAt = 1_700_000_000_001L, latestSeq = 1)
                    "s3" -> it.copy(latestSeq = 900)
                    else -> it
                }
            })
        }
        val title = rule.onNodeWithTag("project-preview-title-s1", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val meta = rule.onNodeWithTag("project-preview-meta-s1", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertEquals("Keep the project and nested conversation title aligned", 60f, title.left.value, 1f)
        assertTrue("Time and state must not consume title width", (title.right - title.left).value > 295f)
        assertTrue("Long preview gets two lines", (title.bottom - title.top).value > 30f)
        assertTrue("Metadata has its own line", meta.top.value >= title.bottom.value + 5f)
        rule.onNodeWithTag("project-preview-s1").assertIsNotSelected().assertHeightIsAtLeast(72.dp)
        rule.onNodeWithTag("project-preview-s2").assertIsSelected().performClick()
        rule.runOnIdle {
            assertEquals(WorkbenchEvent.SelectSession("s2"), events.last())
            assertFalse("Clicking a conversation must not open the project", state.value.projectSessionsOpen)
        }
        rule.onNodeWithTag("project-preview-s3").assertDoesNotExist()
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.onNodeWithTag("project-conversation-s3").assertIsDisplayed()
        rule.onNodeWithContentDescription("Back to projects").performClick()
        rule.onNodeWithTag("project-preview-s2").assertIsSelected()
    }
    @Test fun previewTitleAndStateAreLayeredWithoutChangingEntryRolesLight() = checkPreviewHierarchy(false)
    @Test fun previewTitleAndStateAreLayeredWithoutChangingEntryRolesDark() = checkPreviewHierarchy(true)

    private fun checkOutgoingProject(dark: Boolean) {
        show(AgentoDestination.Sessions, dark, MotionPreference.Full)
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { state.value = state.value.copy(projectSessionsOpen = false, browsingProjectId = null) }
        repeat(8) {
            rule.mainClock.advanceTimeByFrame()
            // The outgoing row may move off-screen, but must not be destroyed
            // while its shell is still sliding. Data state really is cleared.
            rule.onNodeWithText("Conversation 3", useUnmergedTree = true).assertExists()
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithText("Conversation 3").assertDoesNotExist()
        rule.runOnIdle { assertNull(state.value.browsingProjectId) }
    }
    @Test fun closingProjectKeepsOutgoingContentUntilItsSlideEndsLight() = checkOutgoingProject(false)
    @Test fun closingProjectKeepsOutgoingContentUntilItsSlideEndsDark() = checkOutgoingProject(true)

    private fun checkDetailHeader(dark: Boolean) {
        show(AgentoDestination.Sessions, dark, MotionPreference.Full)
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.waitForIdle()
        val title = rule.onNodeWithTag("project-detail-title").getUnclippedBoundsInRoot()
        assertEquals(28f, title.left.value, 1f)
        assertTrue("Project context should not be squeezed between tools", (title.right - title.left).value >= 320f)
        rule.onNodeWithContentDescription("Search sessions").performClick()
        rule.onNodeWithTag("project-detail-search").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        rule.onNodeWithContentDescription("Search sessions").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("project-detail-search").assertHeightIsEqualTo(0.dp)
        rule.onAllNodes(hasSetTextAction()).assertCountEquals(0)
        rule.onNodeWithText("Conversation 3").assertIsDisplayed()
    }
    @Test fun detailTitleHasItsOwnWidthAndSearchKeepsTheListLight() = checkDetailHeader(false)
    @Test fun detailTitleHasItsOwnWidthAndSearchKeepsTheListDark() = checkDetailHeader(true)

    private fun checkSearchMotion(dark: Boolean) {
        show(AgentoDestination.Sessions, dark, MotionPreference.Full)
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.waitForIdle()
        val title = rule.onNodeWithTag("project-detail-title").getUnclippedBoundsInRoot()
        val rowStart = rule.onNodeWithText("Conversation 3", useUnmergedTree = true).getUnclippedBoundsInRoot().top
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Search sessions").performClick()
        var height = 0f
        repeat(18) {
            rule.mainClock.advanceTimeByFrame()
            val next = rule.onNodeWithTag("project-detail-search").getUnclippedBoundsInRoot()
            val nextHeight = (next.bottom - next.top).value
            assertTrue("Reveal height must be monotonic: $height -> $next", nextHeight + .5f >= height)
            assertEquals("Search moves the entire reader by its measured height", title.top.value + nextHeight,
                rule.onNodeWithTag("project-detail-title").getUnclippedBoundsInRoot().top.value, .5f)
            if (nextHeight < 55f) rule.onAllNodes(hasSetTextAction()).assertCountEquals(0)
            height = nextHeight
        }
        assertEquals(56f, height, .5f)
        val rowOpen = rule.onNodeWithText("Conversation 3", useUnmergedTree = true).getUnclippedBoundsInRoot().top
        assertEquals("Only the measured search plus its gap may move the list", 56f, (rowOpen - rowStart).value, .5f)
        rule.onNodeWithContentDescription("Search sessions").performClick()
        repeat(18) {
            rule.mainClock.advanceTimeByFrame()
            val bounds = rule.onNodeWithTag("project-detail-search").getUnclippedBoundsInRoot()
            val next = (bounds.bottom - bounds.top).value
            assertTrue("Hide height must be monotonic: $height -> $next", next <= height + .5f)
            height = next
        }
        assertEquals(0f, height, .5f)
        assertEquals("No trailing gap jump", rowStart.value,
            rule.onNodeWithText("Conversation 3", useUnmergedTree = true).getUnclippedBoundsInRoot().top.value, .5f)
        rule.mainClock.autoAdvance = true
    }
    @Test fun searchKeepsMeasuredGeometryAndHasNoLastFrameGapLight() = checkSearchMotion(false)
    @Test fun searchKeepsMeasuredGeometryAndHasNoLastFrameGapDark() = checkSearchMotion(true)

    @Test fun noSearchResultsStayInProjectAndCanBeCleared() {
        show(AgentoDestination.Sessions)
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.onNodeWithContentDescription("Search sessions").performClick()
        rule.onNode(hasSetTextAction()).performTextReplacement("NoSuchConversation")
        rule.onNodeWithTag("project-detail-title").assertIsDisplayed()
        rule.onNodeWithContentDescription("Back to projects").assertIsDisplayed()
        rule.onNodeWithText("Conversation 3").assertDoesNotExist()
        rule.runOnIdle { assertTrue(state.value.projectSessionsOpen); assertEquals("p1", state.value.browsingProjectId) }
        rule.onNode(hasSetTextAction()).performTextClearance()
        rule.onNodeWithText("Conversation 3").assertIsDisplayed()
    }

    @Test fun emptySearchPreservesLongProjectScrollAnchor() {
        show(AgentoDestination.Sessions, perProject = 30)
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.onNodeWithContentDescription("Search sessions").performClick()
        rule.onNodeWithTag("project-conversations-list").performScrollToNode(hasText("Conversation 12"))
        val anchor = rule.onNodeWithText("Conversation 12", useUnmergedTree = true).getUnclippedBoundsInRoot()
        rule.onNode(hasSetTextAction()).performTextReplacement("NoSuchConversation")
        rule.onNodeWithTag("project-detail-title").assertIsDisplayed()
        rule.onNode(hasSetTextAction()).performTextClearance()
        rule.onNodeWithText("Conversation 12").assertIsDisplayed()
        assertEquals(anchor.top.value,
            rule.onNodeWithText("Conversation 12", useUnmergedTree = true).getUnclippedBoundsInRoot().top.value, .5f)
    }

    private fun checkScrollingTitle(dark: Boolean) {
        show(AgentoDestination.Sessions, dark, perProject = 30)
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.onNodeWithTag("project-detail-title").assertIsDisplayed()
        rule.onNodeWithTag("project-detail-compact-title").assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Text))
        val before = rule.onNodeWithTag("project-conversation-title-s1", useUnmergedTree = true).getUnclippedBoundsInRoot().top
        // A small actual scroll must move the reader by that distance, not
        // cause a header resize followed by a second list-anchor correction.
        rule.onNodeWithTag("project-conversations-list").performTouchInput {
            swipe(start = center, end = center.copy(y = center.y - 40.dp.toPx()), durationMillis = 1000)
        }
        val after = rule.onNodeWithTag("project-conversation-title-s1", useUnmergedTree = true).getUnclippedBoundsInRoot().top
        assertTrue("The large title should travel with the reader", after.value < before.value - 15f)
        rule.onNodeWithTag("project-conversations-list").performScrollToNode(hasText("Conversation 20"))
        rule.onNodeWithTag("project-detail-title").assertDoesNotExist()
        rule.onNodeWithTag("project-detail-compact-title").assertIsDisplayed().assertTextEquals("Project 1")
        val compact = rule.onNodeWithTag("project-detail-compact-title").getUnclippedBoundsInRoot()
        val tools = rule.onNodeWithContentDescription("Search sessions").getUnclippedBoundsInRoot()
        assertTrue("Compact title must not paint under tools", compact.right <= tools.left)
        rule.onNodeWithContentDescription("Search sessions").performClick()
        // Focus first: the real IME further reduces the reader after search
        // disclosure. Establish the anchor only in that actual viewport.
        val unfocusedBottom = rule.onNodeWithTag("project-conversations-list").getUnclippedBoundsInRoot().bottom.value
        rule.onNode(hasSetTextAction()).performClick()
        rule.waitUntil(timeoutMillis = 5000) {
            rule.onNodeWithTag("project-conversations-list").getUnclippedBoundsInRoot().bottom.value < unfocusedBottom - 100f
        }
        rule.onNodeWithTag("project-conversations-list").performScrollToIndex(20)
        val searchAnchor = rule.onNodeWithTag("project-conversation-s20").getUnclippedBoundsInRoot().top
        rule.onNode(hasSetTextAction()).performTextReplacement("NoSuchConversation")
        rule.onNodeWithTag("project-detail-title").assertIsDisplayed()
        rule.onNode(hasSetTextAction()).performTextClearance()
        val restoredAnchor = rule.onNodeWithTag("project-conversation-s20").getUnclippedBoundsInRoot()
        val restoredViewport = rule.onNodeWithTag("project-conversations-list").getUnclippedBoundsInRoot()
        assertTrue("Restored conversation must remain in reader: before=$searchAnchor after=$restoredAnchor viewport=$restoredViewport",
            restoredAnchor.top < restoredViewport.bottom && restoredAnchor.bottom > restoredViewport.top)
        assertEquals("Empty results must restore the actual searched viewport", searchAnchor.value,
            rule.onNodeWithTag("project-conversation-s20").getUnclippedBoundsInRoot().top.value, .5f)
        rule.onNodeWithTag("project-detail-compact-title").assertTextEquals("Project 1")
        rule.onNodeWithTag("project-conversations-list").performScrollToIndex(0)
        rule.onNodeWithTag("project-detail-title").assertIsDisplayed()
        rule.onNodeWithTag("project-detail-compact-title").assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Text))
    }
    @Test fun projectTitleHandsContextToToolbarAndRestoresWithoutResizingReaderLight() = checkScrollingTitle(false)
    @Test fun projectTitleHandsContextToToolbarAndRestoresWithoutResizingReaderDark() = checkScrollingTitle(true)

    @Test fun conversationsAreLazyAndKeepIdentityWhenNewActivityArrives() {
        show(AgentoDestination.Sessions, perProject = 60)
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.onNodeWithText("Conversation 60", useUnmergedTree = true).assertDoesNotExist()
        rule.onNodeWithTag("project-conversations-list").performScrollToNode(hasText("Conversation 30"))
        val before = rule.onNodeWithTag("project-conversation-s30").getUnclippedBoundsInRoot()
        rule.runOnIdle {
            state.value = state.value.copy(sessions = listOf(
                Session("new", "New conversation", "p1", SessionStatus.Completed, updatedAt = Long.MAX_VALUE)
            ) + state.value.sessions)
        }
        rule.onNodeWithTag("project-conversation-s30").assertIsDisplayed()
        assertEquals("Prepending must preserve the visible conversation, not its old index", before.top.value,
            rule.onNodeWithTag("project-conversation-s30").getUnclippedBoundsInRoot().top.value, .5f)
        rule.onNodeWithTag("project-conversations-list").performScrollToNode(hasText("Conversation 60"))
        rule.onNodeWithText("Conversation 60").assertIsDisplayed().performClick()
        rule.runOnIdle { assertTrue(events.contains(WorkbenchEvent.SelectSession("s60"))) }
    }

    @Test fun conversationTitleHasFullWidthAndMetadataItsOwnLine() {
        show(AgentoDestination.Sessions)
        rule.runOnIdle {
            state.value = state.value.copy(sessionId = "s2", sessions = state.value.sessions.map {
                if (it.id == "s1") it.copy(title = "Review the weekly report, check every source and prepare a complete handover for the team",
                    status = SessionStatus.WaitingApproval, waitingAction = "approval") else it
            })
        }
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        val title = rule.onNodeWithTag("project-conversation-title-s1", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val meta = rule.onNodeWithTag("project-conversation-meta-s1", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertEquals(28f, title.left.value, 1f)
        assertTrue("Title gets the row width instead of competing with its time", (title.right - title.left).value > 320f)
        assertTrue("Long title should use two lines", (title.bottom - title.top).value > 30f)
        assertTrue("Metadata must not intersect the title", meta.top.value >= title.bottom.value + 5f)
        rule.onNodeWithTag("project-conversation-s2").assertIsSelected()
        rule.onNodeWithTag("project-conversation-s1").assertIsNotSelected().performTouchInput { longClick() }
        rule.onNodeWithTag("session-list-menu").assertIsDisplayed()
        rule.runOnIdle { assertFalse(events.contains(WorkbenchEvent.SelectSession("s1"))) }
        rule.onNodeWithTag("session-list-delete").performClick()
        rule.onNodeWithTag("session-list-delete-confirmation").assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(com.andysagent.ragent.feature.workbench.R.string.session_list_delete_confirm), substring = false).performClick()
        rule.runOnIdle { assertTrue(events.contains(WorkbenchEvent.DeleteListedSession(null, "s1"))) }
    }

    @Test fun firstLevelLongPressOpensMenuWithoutOpeningSession() {
        show(AgentoDestination.Sessions)
        rule.onNodeWithTag("project-preview-s1").performTouchInput { longClick() }
        rule.onNodeWithTag("session-list-menu").assertIsDisplayed()
        rule.runOnIdle { assertFalse(events.contains(WorkbenchEvent.SelectSession("s1"))) }
        rule.onNodeWithTag("session-list-rename").performClick()
        rule.onNodeWithTag("session-list-name").assertIsDisplayed()
    }

    @Test fun projectActionWaitsForItsPageAndKeepsBusinessRole() {
        show(AgentoDestination.Sessions, motion = MotionPreference.Full)
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.mainClock.advanceTimeBy(80)
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertHasNoClickAction()
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithContentDescription("New chat").assertIsDisplayed()
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertHasClickAction().performClick()
        rule.runOnIdle { assertTrue(events.contains(WorkbenchEvent.OpenNewSession("p1"))) }
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Back to projects").performClick()
        rule.mainClock.advanceTimeByFrame()
        rule.onNodeWithText("Conversation 3", useUnmergedTree = true).assertExists()
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertHasNoClickAction()
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithContentDescription("New project").assertIsDisplayed()
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertHasClickAction().performClick()
        rule.runOnIdle { assertTrue(events.contains(WorkbenchEvent.OpenProjectDialog)) }
    }

    @Test fun reversingProjectExitKeepsPositionAndRestoresItsAction() {
        show(AgentoDestination.Sessions, motion = MotionPreference.Full)
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Back to projects").performClick()
        rule.mainClock.advanceTimeBy(80)
        val before = rule.onNodeWithTag("project-detail-title").getUnclippedBoundsInRoot()
        assertTrue("Detail should still be in flight", before.left.value > 28f)
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertHasNoClickAction()
        rule.runOnIdle { state.value = state.value.copy(projectSessionsOpen = true, browsingProjectId = "p1") }
        assertEquals("Retarget must not replace the page at its endpoint", before.left.value,
            rule.onNodeWithTag("project-detail-title").getUnclippedBoundsInRoot().left.value, .5f)
        val positions = mutableListOf<Float>()
        repeat(8) {
            rule.mainClock.advanceTimeByFrame()
            positions += rule.onNodeWithTag("project-detail-title").getUnclippedBoundsInRoot().left.value
        }
        val viewport = rule.onNodeWithTag("primary-page-sessions").getUnclippedBoundsInRoot()
        val maximumStep = (viewport.right - viewport.left).value * .16f
        // Preserve velocity, not an arbitrary 80ms distance. The captured
        // spring first brakes its outgoing momentum, then turns around.
        (listOf(before.left.value) + positions).zipWithNext().forEach { (a, b) ->
            assertTrue("Retarget jumped $a -> $b; frames=$positions", abs(b - a) <= maximumStep)
        }
        assertTrue("Momentum must turn within four frames: $positions", positions[3] < positions[2])
        assertTrue("The page must return past the retarget location within eight frames: $positions", positions.last() < before.left.value)
        android.util.Log.i("IndexHierarchyMotion", "Reverse before=${before.left.value}, frames=$positions")
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertHasClickAction().performClick()
        rule.runOnIdle { assertTrue(events.contains(WorkbenchEvent.OpenNewSession("p1"))) }
    }

    @Test fun departingProjectEdgeShadowReleasesWithItsPage() {
        show(AgentoDestination.Sessions, motion = MotionPreference.Full, perProject = 1)
        rule.runOnIdle {
            state.value = state.value.copy(projects = state.value.projects.take(1), sessions = state.value.sessions.take(1))
        }
        rule.onNodeWithContentDescription("Open project: Project 1").performClick()
        rule.waitForIdle()
        val restTitle = rule.onNodeWithTag("project-detail-title").getUnclippedBoundsInRoot()
        val viewport = rule.onNodeWithTag("primary-page-sessions").getUnclippedBoundsInRoot()
        val widthDp = (viewport.right - viewport.left).value
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Back to projects").performClick()
        rule.mainClock.advanceTimeBy(224)
        val title = rule.onNodeWithTag("project-detail-title").getUnclippedBoundsInRoot()
        val offsetDp = (title.left - restTitle.left).value
        val remaining = 1f - offsetDp / widthDp
        assertTrue("Sample must be a late but still visible page: $remaining", remaining in .015f.. .25f)
        val pixels = rule.onRoot().captureToImage().toPixelMap()
        val scale = pixels.width / widthDp
        val edgeX = ((offsetDp - 2f) * scale).toInt()
        val referenceX = ((offsetDp - 24f) * scale).toInt()
        val y = (pixels.height * .60f).toInt()
        // Both samples are on the empty parent canvas; only one is beneath the
        // child's edge shadow. Its full-strength dark rail must not linger as
        // the page itself becomes a sliver at the viewport edge.
        val contrast = pixels[referenceX, y].red - pixels[edgeX, y].red
        assertTrue("Detached dark edge: contrast=$contrast remaining=$remaining", contrast <= .025f)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithContentDescription("Open project: Project 1").assertIsDisplayed()
    }

    private fun checkSettings(dark: Boolean) {
        show(AgentoDestination.Settings, dark)
        rule.onNodeWithTag("settings-sign-in-entry").assertHeightIsAtLeast(64.dp)
            .assertWidthIsAtLeast(300.dp).performClick()
        rule.runOnIdle { assertEquals(GoogleSignInRequest.Account, signIn) }
        rule.onNodeWithTag("settings-manage-devices").assertIsDisplayed()
        rule.onNodeWithText("Language").assertIsDisplayed()
    }
    @Test fun settingsUsesAnAccountEntryAndKeepsSignInLight() = checkSettings(false)
    @Test fun settingsUsesAnAccountEntryAndKeepsSignInDark() = checkSettings(true)
}
