package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.runtime.getValue
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.printToString
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentComposer
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.agentui.ApprovalActionUiState
import com.andysagent.ragent.core.agentui.PermissionRequestUiState
import com.andysagent.ragent.core.agentui.R as AgentUiR
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.LocalRagentExtendedColors
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.domain.AccountsRepository
import com.andysagent.ragent.core.domain.GoogleAccountProfile
import com.andysagent.ragent.core.domain.GoogleAccountStatusResult
import com.andysagent.ragent.core.domain.GoogleTokenSubmitResult
import com.andysagent.ragent.core.domain.RuntimeSelection
import com.andysagent.ragent.core.model.AppLanguage
import com.andysagent.ragent.core.model.AppTheme
import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.AttentionItem
import com.andysagent.ragent.core.model.AttentionKind
import com.andysagent.ragent.core.model.AttentionReducer
import com.andysagent.ragent.core.model.AttentionUiState
import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.RemoteTarget
import com.andysagent.ragent.core.model.RuntimeCatalog
import com.andysagent.ragent.core.model.RuntimeModelOption
import com.andysagent.ragent.core.model.RuntimeProviderOption
import com.andysagent.ragent.core.model.RuntimeToolOption
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import com.andysagent.ragent.core.navigation.R as NavigationR
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineOperationKind
import com.andysagent.ragent.core.timeline.TimelineOperationStatus
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.core.timeline.RunActionUiState
import com.andysagent.ragent.feature.workbench.AgentsAppsPage
import com.andysagent.ragent.feature.workbench.AttentionEvent
import com.andysagent.ragent.feature.workbench.AttentionSurface
import com.andysagent.ragent.feature.workbench.HomeSurface
import com.andysagent.ragent.feature.workbench.PendingTurnState
import com.andysagent.ragent.feature.workbench.PendingTurnUiState
import com.andysagent.ragent.feature.workbench.WorkbenchEvent
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.feature.workbench.ProjectsReferenceFixtures
import com.andysagent.ragent.feature.workbench.SettingsPage
import com.andysagent.ragent.feature.workbench.StructuredApprovalCard
import com.andysagent.ragent.feature.workbench.WebAgent
import com.andysagent.ragent.feature.workbench.WebParityEvent
import com.andysagent.ragent.feature.workbench.WebParityUiState
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import com.andysagent.ragent.feature.workbench.accounts.AccountsEvent
import com.andysagent.ragent.feature.workbench.accounts.AccountsViewModel
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.util.Locale

/**
 * Instrumented Compose UI tests for the Workbench surface.
 *
 * Covers the key session states: idle (empty), streaming/completed/user
 * messages, error + retry recovery, three-destination navigation, full-screen
 * chat, and the Sessions catalog. Runs on an emulator via connectedDebugAndroidTest.
 */
class WorkbenchScreenUiTest {

    private fun pickerTranscript() = (1..24).map { index ->
        TimelineItem.Message(
            id = "picker-message-$index", seq = index.toLong(),
            role = if (index % 3 == 0) TimelineRole.User else TimelineRole.Agent,
            text = if (index % 3 == 0) "Compare the options for step $index."
            else "### Review $index\n\nThe configuration panel should remain readable over a long conversation. " +
                "Background text must soften into quiet colour, with no recognisable letter shapes.\n\n" +
                "- Keep the chosen model visible\n- Adjust thinking effort without losing context\n- Return to the conversation when finished",
            completed = true,
        )
    }

    private fun capturePickerScreen(name: String) {
        composeRule.waitForIdle()
        // Popup is a separate Android window; Compose idle can precede its
        // first SurfaceFlinger frame. Capture the presented frame, not only semantics.
        android.os.SystemClock.sleep(350)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val automation = instrumentation.uiAutomation
        val bitmap = checkNotNull(automation.takeScreenshot())
        val output = File(instrumentation.targetContext.getExternalFilesDir(null), "$name.png")
        FileOutputStream(output).use { check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)) }
        automation.executeShellCommand("mkdir -p /sdcard/Download/ragent-screenshots").use {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(it).use { stream -> stream.readBytes() }
        }
        automation.executeShellCommand("cp ${output.absolutePath} /sdcard/Download/ragent-screenshots/$name.png").use {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(it).use { stream -> stream.readBytes() }
        }
    }

    private fun retainReadingFailure(name: String, assertion: () -> Unit) {
        try {
            assertion()
        } catch (failure: AssertionError) {
            // Diagnostic evidence must not replace the original failure.
            runCatching {
                capturePickerScreen(name)
                composeRule.onAllNodes(hasSetTextAction(), useUnmergedTree = true)
                    .fetchSemanticsNodes().forEach { println("READING_EDITOR $name: ${it.config}") }
                println("READING_FAILURE $name\n" + composeRule.onRoot(useUnmergedTree = true).printToString())
            }.onFailure { println("READING_CAPTURE_FAILED $name: $it") }
            throw failure
        }
    }

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun agentUiText(resId: Int, vararg formatArgs: Any): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resId, *formatArgs)

    private fun navigationText(resId: Int): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resId)

    private fun workbenchText(resId: Int): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resId)

    private fun contextForLanguage(languageTag: String) =
        InstrumentationRegistry.getInstrumentation().targetContext.let { base ->
            base.createConfigurationContext(Configuration(base.resources.configuration).apply {
                setLocale(Locale.forLanguageTag(languageTag))
            })
        }

    @Test
    fun structuredApprovalCardExposesActionSelectionAndKeepsInFlightActionsReadOnly() {
        val selections = mutableListOf<Pair<String, Boolean>>()
        var approved = 0
        composeRule.setContent {
            RagentTheme {
                StructuredApprovalCard(
                    state = PermissionRequestUiState(
                        id = "batch-1",
                        title = "Review actions",
                        reason = "Choose which actions may continue.",
                        actions = listOf(
                            ApprovalActionUiState(
                                id = "action-1",
                                description = "Update report",
                                state = "waiting_user",
                            ),
                            ApprovalActionUiState(
                                id = "action-2",
                                description = "Restart service",
                                state = "executing",
                            ),
                        ),
                    ),
                    onActionSelected = { id, selected -> selections += id to selected },
                    onApprove = { approved += 1 },
                    onDeny = {},
                )
            }
        }

        composeRule.onNodeWithContentDescription("Update report, waiting user").performClick()
        composeRule.onNodeWithContentDescription("Restart service, executing").assertIsDisplayed()
        composeRule.onNodeWithText("Approve").assertIsDisplayed()
        assertTrue(selections == listOf("action-1" to false))
        assertTrue(approved == 0)
    }

    @Test
    fun settingsOverviewUsesCompactIdentityAndListRhythm() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings))
            }
        }

        // The page heading and the always-labelled navigation tab are both visible.
        composeRule.onAllNodesWithText("Settings").assertCountEquals(2)
        composeRule.onAllNodesWithText("Settings")[0].assertIsDisplayed()
        composeRule.onAllNodesWithText("Settings")[1].assertIsDisplayed()
        composeRule.onNodeWithTag("settings-list").assertIsDisplayed()
        composeRule.onNodeWithTag("settings-manage-devices").performScrollTo().assertIsDisplayed()

        val screenshot = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val output = File(
            InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
            "settings-telegram-density.png",
        )
        FileOutputStream(output).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
    }

    @Test
    fun projectsOverviewPreviewsRecentSessionsWithQuietStatus() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    WorkbenchUiState(
                        destination = AgentoDestination.Sessions,
                        computers = ProjectsReferenceFixtures.computers,
                        projects = ProjectsReferenceFixtures.projects,
                        sessions = ProjectsReferenceFixtures.sessions,
                    ),
                )
            }
        }

        composeRule.onNodeWithText("Operations").assertIsDisplayed()
        composeRule.onNodeWithText("Clean up weekly exports").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Running").assertIsDisplayed()
        composeRule.onNodeWithText("Archive completed files").assertDoesNotExist()

        val screenshot = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val output = File(
            InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
            "projects-compact.png",
        )
        FileOutputStream(output).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
    }

    @Test
    fun primaryNavigationKeepsHomeBetweenChatAndSettings() {
        composeRule.setContent { RagentTheme { WorkbenchScreen(WorkbenchUiState()) } }

        val projects = navigationText(NavigationR.string.navigation_chat)
        val home = navigationText(NavigationR.string.navigation_home)
        val settings = navigationText(NavigationR.string.navigation_settings)
        composeRule.onNodeWithContentDescription(projects).assertIsDisplayed()
        composeRule.onNodeWithContentDescription(home).assertIsDisplayed()
        composeRule.onNodeWithContentDescription(settings).assertIsDisplayed()
        composeRule.onNodeWithContentDescription(projects).assertHeightIsAtLeast(48.dp)

        val projectsLeft = composeRule.onNodeWithContentDescription(projects)
            .fetchSemanticsNode().boundsInRoot.left
        val homeLeft = composeRule.onNodeWithContentDescription(home)
            .fetchSemanticsNode().boundsInRoot.left
        assertTrue("Chat must be to the left of Home", projectsLeft < homeLeft)
    }

    @Test
    fun streamingCompletedAndUserMessagesRender() {
        val state = WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-streaming",
            runStatus = AgentRunStatus.Working,
            timelineItems = listOf(
                TimelineItem.Message(id = "s", seq = 1, role = TimelineRole.Agent, text = "Analyzing the repo", completed = false),
                TimelineItem.Message(id = "c", seq = 2, role = TimelineRole.Agent, text = "Analysis complete", completed = true),
                TimelineItem.Message(
                    id = "u",
                    seq = 3,
                    role = TimelineRole.User,
                    text = "check tests\n**then verify** ~~the old path~~ `healthz`",
                    completed = true,
                ),
            ),
        )
        composeRule.setContent { RagentTheme { WorkbenchScreen(state) } }

        retainReadingFailure("workbench-streaming-failure") {
            composeRule.onNodeWithText("Analyzing the repo").assertIsDisplayed()
        }
        composeRule.onNodeWithText("Analysis complete").assertIsDisplayed()
        composeRule.onNodeWithText("check tests\nthen verify the old path healthz").assertIsDisplayed()
        composeRule.onAllNodesWithText("**then verify** ~~the old path~~ `healthz`").assertCountEquals(0)
        capturePickerScreen("workbench-distinct-stream-and-final.png")
    }

    @Test
    fun sessionHistoryRestoreHidesThePreviousTimelineBehindAStableLoadingOverlay() {
        val state = WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-new",
            timelineSessionId = "session-old",
            historyLoading = true,
            timelineItems = listOf(
                TimelineItem.Message(
                    id = "old-message",
                    seq = 1,
                    role = TimelineRole.Agent,
                    text = "Previous session content",
                    completed = true,
                ),
            ),
        )
        composeRule.setContent { RagentTheme { WorkbenchScreen(state) } }

        // Do not flash another session's transcript while the selected
        // session history is loading.
        composeRule.onNodeWithText("Previous session content").assertDoesNotExist()
        composeRule.mainClock.advanceTimeBy(300L)
        composeRule.onNodeWithContentDescription(workbenchText(WorkbenchR.string.chat_history_loading)).assertExists()
    }

    @Test
    fun userMessageRendersMarkdownFormattingWithoutRawSyntax() {
        val source = "**Done** ~~obsolete~~ [logs](https://example.com) with `healthz`"
        val state = WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-user-markdown",
            timelineItems = listOf(
                TimelineItem.Message(
                    id = "user-markdown",
                    seq = 1,
                    role = TimelineRole.User,
                    text = source,
                    completed = true,
                ),
            ),
        )
        composeRule.setContent { RagentTheme { WorkbenchScreen(state) } }

        composeRule.onNodeWithText("Done obsolete logs with healthz").assertIsDisplayed()
        composeRule.onAllNodesWithText(source).assertCountEquals(0)
    }

    @Test
    fun toolCallRendersAsQuietFlatRowWithoutCardChrome() {
        val state = WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-tools",
            runStatus = AgentRunStatus.Working,
            timelineItems = listOf(
                TimelineItem.Operation(
                    id = "op1",
                    seq = 1,
                    kind = TimelineOperationKind.FileEdit,
                    title = "Read 6 invoice files",
                    detail = "stdout",
                    status = TimelineOperationStatus.InProgress,
                ),
            ),
        )
        composeRule.setContent { RagentTheme { WorkbenchScreen(state) } }

        retainReadingFailure("workbench-tool-failure") {
            composeRule.onNodeWithText("Read 6 invoice files").assertIsDisplayed()
        }
        composeRule.onNodeWithText("Working").assertIsDisplayed()
    }

    @Test
    fun agentMarkdownRendersFormattingBlocksWithoutRawSyntax() {
        val state = WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-markdown",
            timelineItems = listOf(
                TimelineItem.Message(
                    id = "markdown",
                    seq = 1,
                    role = TimelineRole.Agent,
                    text = "# Result\n\n**Done**\n\n- first item\n- second item\n\n```kotlin\nval answer = 42\n```",
                    completed = true,
                ),
            ),
        )
        composeRule.setContent { RagentTheme { WorkbenchScreen(state) } }

        composeRule.onNodeWithText("Result").assertIsDisplayed()
        composeRule.onNodeWithText("Done").assertIsDisplayed()
        composeRule.onNodeWithText("first item").assertIsDisplayed()
        composeRule.onNodeWithText("val answer = 42").assertIsDisplayed()
        composeRule.onAllNodesWithText("**Done**").assertCountEquals(0)
    }

    @Test
    fun composerRendersMarkdownWithoutASecondPreviewOrRawDelimiters() {
        val state = WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-composer-markdown",
            composerText = "## Delivery plan\n\n**Important**: verify `healthz` first.\n\n" +
                List(18) { "- checklist item ${it + 1}" }.joinToString("\n"),
        )
        composeRule.setContent { RagentTheme { WorkbenchScreen(state) } }

        val composer = composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer))
        composer.assertIsDisplayed()
        // The long draft stays inside the composer instead of consuming the
        // screen. Format content itself is covered by the Compose Rich Editor adapter tests;
        // BasicTextField only exposes the raw editable value to semantics.
        val editor = composeRule.onNode(hasSetTextAction())
        assertTrue(
            "Long draft expanded beyond the capped editor: ${editor.fetchSemanticsNode().boundsInRoot.height}px",
            editor.fetchSemanticsNode().boundsInRoot.height < 500f,
        )
        composeRule.onAllNodesWithText("**Important**").assertCountEquals(0)
        composeRule.onAllNodesWithText("## Delivery plan").assertCountEquals(0)
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    fun composerKeepsMidTextTypingNewlinesAndPunctuationInOneStableDocument() {
        var state by mutableStateOf(
            WorkbenchUiState(
                chatOpen = true,
                sessionId = "session-composer-wysiwyg-editing",
            ),
        )
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        if (event is WorkbenchEvent.ComposerChanged) {
                            state = state.copy(composerText = event.text)
                        }
                    },
                )
            }
        }

        val editor = composeRule.onNode(hasSetTextAction())
        editor.performTextInput("Start **bold**")
        composeRule.waitForIdle()
        editor.assertTextEquals("Start bold")
        assertTrue(state.composerText == "Start **bold**")

        editor.performTextInputSelection(TextRange("Start b".length))
        editor.performTextInput("X")
        editor.performTextInput("\nNext line，")
        composeRule.waitForIdle()

        val layouts = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        editor.performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult) { it(layouts) }
        // RichEditor rc10 represents paragraph separators as spaces in
        // EditableText. Verify actual painted lines and serialized Markdown,
        // not a literal newline that is absent from its semantics contract.
        editor.assertTextEquals("Start bX Next line，old")
        val layout = layouts.single()
        assertTrue(layout.getLineForOffset(9) > layout.getLineForOffset(7))
        assertTrue(state.composerText == "Start **bX**\n**Next line，old**")
        capturePickerScreen("workbench-mid-document-newline")
    }

    @Test
    fun errorStateShowsRetryCardAndInvokesCallback() {
        var retried = false
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-error",
                        error = "Connect a computer before sending a message.",
                    ),
                    onEvent = { if (it is WorkbenchEvent.Retry) retried = true },
                )
            }
        }

        composeRule.onNodeWithText("Action needs attention").assertIsDisplayed()
        composeRule.onNodeWithText("Connect a computer before sending a message.").assertIsDisplayed()
        composeRule.onNodeWithText("Retry").performClick()
        assertTrue("Retry callback should fire", retried)
    }

    @Test
    fun transportFailureUsesCompactLocalizedReconnectPrompt() {
        var retried = false
        val rawTransportDetail = "No verified TURN/P2P carrier is available"
        val title = agentUiText(WorkbenchR.string.workbench_connection_unavailable_title)
        val detail = agentUiText(WorkbenchR.string.workbench_connection_unavailable_detail)
        val reconnect = agentUiText(WorkbenchR.string.workbench_reconnect)

        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-transport-error",
                        error = "Session could not be refreshed: $rawTransportDetail",
                        timelineItems = listOf(
                            TimelineItem.Message(
                                id = "transport-context",
                                seq = 1,
                                role = TimelineRole.User,
                                text = "Continue the task.",
                                completed = true,
                            ),
                        ),
                    ),
                    onEvent = { if (it is WorkbenchEvent.Retry) retried = true },
                )
            }
        }

        composeRule.onNodeWithText(title).assertIsDisplayed()
        composeRule.onNodeWithText(detail).assertIsDisplayed()
        composeRule.onNodeWithText(reconnect).performClick()
        composeRule.onAllNodesWithText(rawTransportDetail).assertCountEquals(0)
        assertTrue("Reconnect prompt should preserve the retry action", retried)
    }

    @Test
    fun emptyConversationDefersTransportRecoveryToDeviceGuidance() {
        val rawTransportDetail = "No verified TURN/P2P carrier is available"
        val reconnectTitle = agentUiText(WorkbenchR.string.workbench_connection_unavailable_title)
        val connectDeviceTitle = agentUiText(WorkbenchR.string.workbench_connect_device_title)

        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-empty-transport-error",
                        error = "Session could not be refreshed: $rawTransportDetail",
                    ),
                )
            }
        }

        composeRule.onNodeWithText(connectDeviceTitle).assertIsDisplayed()
        composeRule.onAllNodesWithText(reconnectTitle).assertCountEquals(0)
        composeRule.onAllNodesWithText(rawTransportDetail).assertCountEquals(0)
    }

    @Test
    fun emptyConversationOffersDeviceSetupAction() {
        var pairingOpened = false
        val setupAction = agentUiText(WorkbenchR.string.workbench_connect_device_action)

        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(chatOpen = true, sessionId = "session-device-setup"),
                    onEvent = { event ->
                        if (event is WorkbenchEvent.OpenPairing) {
                            pairingOpened = true
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithText(setupAction).assertIsDisplayed().performClick()
        assertTrue("Device setup should open pairing instead of leaving the conversation", pairingOpened)
    }

    @Test
    fun emptyConversationWithSelectedComputerDoesNotAskForSetupDuringReconnect() {
        val setupAction = agentUiText(WorkbenchR.string.workbench_connect_device_action)
        val connection = mutableStateOf(AgentConnectionStatus.Reconnecting)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-reconnect",
                        activeRemoteTargetId = "paired-computer",
                        connection = connection.value,
                        composerText = "Preserved draft",
                    ),
                    onEvent = {},
                )
            }
        }
        composeRule.onAllNodesWithText(setupAction).assertCountEquals(0)
        composeRule.onNodeWithText("Preserved draft").assertIsDisplayed()
        composeRule.runOnIdle { connection.value = AgentConnectionStatus.Disconnected }
        composeRule.onAllNodesWithText(setupAction).assertCountEquals(0)
        composeRule.onNodeWithText("Preserved draft").assertIsDisplayed()
    }

    @Test
    fun errorCardCanBeDismissedWithRightSwipe() {
        var dismissed = false
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-error-swipe",
                        error = "Connect a computer before sending a message.",
                    ),
                    onEvent = { if (it is WorkbenchEvent.DismissError) dismissed = true },
                )
            }
        }

        composeRule.onNodeWithText("Connect a computer before sending a message.")
            .performTouchInput { swipeRight() }
        composeRule.waitForIdle()
        assertTrue("Right swipe should dismiss the error card", dismissed)
    }

    @Test
    fun attentionNotificationCanBeDismissedWithRightSwipe() {
        var dismissed = false
        val item = AttentionItem(
            id = AttentionReducer.sessionItemId("session-attention-swipe", "completion"),
            sessionId = "session-attention-swipe",
            sessionTitle = "检查报告",
            kind = AttentionKind.Completion,
            title = "检查报告",
            summary = "任务已完成",
        )
        composeRule.setContent {
            RagentTheme {
                AttentionSurface(
                    state = AttentionUiState(items = listOf(item), activeItemId = item.id),
                    onEvent = { event ->
                        if (event is AttentionEvent.Dismiss) dismissed = true
                    },
                    onOpenSession = {},
                )
            }
        }

        composeRule.onNodeWithContentDescription("已完成，检查报告，任务已完成，向右滑动关闭通知")
            .performTouchInput { swipeRight() }
        composeRule.waitForIdle()
        assertTrue("Right swipe should dismiss the attention notification", dismissed)
    }

    @Test
    fun attentionNotificationKeepsContentDuringEntryAndDismissalTransition() {
        val item = AttentionItem(
            id = AttentionReducer.sessionItemId("session-attention-motion", "completion"),
            sessionId = "session-attention-motion",
            sessionTitle = "检查报告",
            kind = AttentionKind.Completion,
            title = "检查报告",
            summary = "任务已完成",
        )
        val description = "已完成，检查报告，任务已完成，向右滑动关闭通知"
        var attentionState by mutableStateOf(AttentionUiState())
        val dispatchEvent: (AttentionEvent) -> Unit = { event ->
            if (event is AttentionEvent.Dismiss) {
                attentionState = AttentionUiState()
            }
        }

        composeRule.mainClock.autoAdvance = false
        try {
            composeRule.setContent {
                RagentTheme(motionPreference = MotionPreference.Full) {
                    AttentionSurface(
                        state = attentionState,
                        onEvent = dispatchEvent,
                        onOpenSession = {},
                    )
                }
            }
            composeRule.waitForIdle()

            composeRule.runOnIdle {
                attentionState = AttentionUiState(items = listOf(item), activeItemId = item.id)
            }
            composeRule.waitForIdle()
            composeRule.mainClock.advanceTimeByFrame()
            // Semantics bounds describe layout, not AnimatedContent's render
            // offset; node retention verifies that the transition is active.
            composeRule.onNodeWithContentDescription(description)
                .fetchSemanticsNode()

            composeRule.mainClock.advanceTimeBy(1_000L)
            composeRule.waitForIdle()
            composeRule.onNodeWithContentDescription(description)
                .fetchSemanticsNode()

            composeRule.runOnIdle {
                dispatchEvent(AttentionEvent.Dismiss(item.id))
            }
            composeRule.waitForIdle()
            composeRule.mainClock.advanceTimeByFrame()
            // Exit still paints the card, but it no longer exposes stale
            // actions/announcements. Check retained surface, not live semantics.
            composeRule.onNodeWithTag("attention-retained-surface", useUnmergedTree = true)
                .fetchSemanticsNode()

            composeRule.mainClock.advanceTimeBy(120L)
            composeRule.onNodeWithTag("attention-retained-surface", useUnmergedTree = true)
                .fetchSemanticsNode()

            composeRule.mainClock.advanceTimeBy(1_000L)
            composeRule.waitForIdle()
            composeRule.onNodeWithContentDescription(description).assertDoesNotExist()
        } finally {
            composeRule.mainClock.autoAdvance = true
        }
    }

    @Test
    fun approvalAttentionShowsSummaryAndDecisionActionsOpenSessionDetails() {
        var approved = false
        var denied = false
        var openedSession: String? = null
        var attentionState by mutableStateOf(AttentionUiState())
        val item = AttentionItem(
            id = AttentionReducer.approvalItemId("session-approval-notification", "approval-1"),
            sessionId = "session-approval-notification",
            sessionTitle = "发布周报",
            kind = AttentionKind.Approval,
            title = "执行请求",
            summary = "将运行导出脚本并上传周报",
            approval = Approval(
                id = "approval-1",
                sessionId = "session-approval-notification",
                title = "执行请求",
                reason = "将运行导出脚本并上传周报",
                passkeyRequired = false,
            ),
        )
        attentionState = AttentionUiState(items = listOf(item), activeItemId = item.id)
        composeRule.setContent {
            RagentTheme {
                AttentionSurface(
                    state = attentionState,
                    onEvent = { event ->
                        when (event) {
                            is AttentionEvent.SetExpanded -> {
                                attentionState = attentionState.copy(expanded = event.expanded)
                            }
                            is AttentionEvent.ResolveApproval -> {
                                if (event.approve) approved = true else denied = true
                            }
                            else -> Unit
                        }
                    },
                    onOpenSession = { openedSession = it },
                )
            }
        }

        composeRule.onNodeWithText("Approval required").assertIsDisplayed()
        composeRule.onNodeWithText("将运行导出脚本并上传周报").assertIsDisplayed()
        composeRule.onAllNodesWithText("Technical details").assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Expand approval details").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Technical details").assertIsDisplayed()
        composeRule.onNodeWithText("Operation: 执行请求").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Collapse approval details").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription("Expand approval details").assertIsDisplayed()
        composeRule.onNodeWithText("Approve").performClick()
        composeRule.onNodeWithText("Deny").performClick()
        composeRule.onNodeWithText("Details").performClick()

        assertTrue("Approval action should be emitted", approved)
        assertTrue("Deny action should be emitted", denied)
        assertTrue("Details should open the approval's session", openedSession == "session-approval-notification")
    }

    @Test
    fun multiQuestionAttentionCollapsesAndSendsAllAnswersFromFooter() {
        var sentChoices: List<Int>? = null
        var sentCustomAnswer: String? = null
        var denied = false
        var attentionState by mutableStateOf(AttentionUiState())
        val item = AttentionItem(
            id = AttentionReducer.approvalItemId("session-multi-question-notification", "question-1"),
            sessionId = "session-multi-question-notification",
            sessionTitle = "发布配置",
            kind = AttentionKind.Question,
            title = "AskUserQuestion",
            summary = "请完成发布配置后继续",
            approval = Approval(
                id = "question-1",
                sessionId = "session-multi-question-notification",
                title = "发布配置",
                kind = "question",
                runId = "run-question-1",
                questions = listOf(
                    com.andysagent.ragent.core.model.ApprovalQuestion(
                        question = "发布到哪里？",
                        options = listOf(
                            com.andysagent.ragent.core.model.ApprovalOption("预发布"),
                            com.andysagent.ragent.core.model.ApprovalOption("生产环境"),
                        ),
                    ),
                    com.andysagent.ragent.core.model.ApprovalQuestion(
                        question = "何时发布？",
                        options = listOf(
                            com.andysagent.ragent.core.model.ApprovalOption("现在"),
                            com.andysagent.ragent.core.model.ApprovalOption("今晚"),
                        ),
                    ),
                ),
            ),
        )
        attentionState = AttentionUiState(items = listOf(item), activeItemId = item.id)

        composeRule.setContent {
            RagentTheme {
                AttentionSurface(
                    state = attentionState,
                    onEvent = { event ->
                        when (event) {
                            is AttentionEvent.SetExpanded -> {
                                attentionState = attentionState.copy(expanded = event.expanded)
                            }
                            is AttentionEvent.ResolveQuestions -> {
                                sentChoices = event.choices
                                sentCustomAnswer = event.customAnswer
                            }
                            is AttentionEvent.ResolveApproval -> {
                                if (!event.approve) denied = true
                            }
                            else -> Unit
                        }
                    },
                    onOpenSession = {},
                )
            }
        }

        composeRule.onNodeWithContentDescription("展开问题详情").assertIsDisplayed().performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription("收起问题详情").assertIsDisplayed()
        composeRule.onAllNodesWithText("没有合适的选项时输入回复…").assertCountEquals(2)
        composeRule.onNodeWithText("发送").assertIsNotEnabled()

        composeRule.onAllNodes(hasSetTextAction(), useUnmergedTree = true)[0]
            .performTextInput("自定义预发布环境")
        assertTrue("Typing a multi-question reply must not submit", sentChoices == null)
        composeRule.onNodeWithContentDescription("以此选项回答：预发布").performClick()
        composeRule.onNodeWithText("发送").assertIsNotEnabled()
        composeRule.onNodeWithContentDescription("以此选项回答：今晚").performClick()
        composeRule.onNodeWithText("发送").assertIsEnabled().performClick()
        composeRule.onNodeWithText("拒绝").assertIsDisplayed().performClick()

        assertTrue("All question choices should be sent together", sentChoices == listOf(0, 1))
        assertTrue("Option-only submission should not carry a custom answer", sentCustomAnswer.orEmpty().isEmpty())
        assertTrue("Multi-question attention should keep a deny action", denied)
    }

    @Test
    fun singleQuestionAttentionUsesHeaderChevronAndKeepsDenyAtFooter() {
        var denied = false
        var attentionState by mutableStateOf(AttentionUiState())
        val item = AttentionItem(
            id = AttentionReducer.approvalItemId("session-single-question-notification", "question-1"),
            sessionId = "session-single-question-notification",
            sessionTitle = "发布配置",
            kind = AttentionKind.Question,
            title = "AskUserQuestion",
            summary = "请完成发布配置后继续",
            approval = Approval(
                id = "question-1",
                sessionId = "session-single-question-notification",
                title = "发布配置",
                kind = "question",
                questions = listOf(
                    com.andysagent.ragent.core.model.ApprovalQuestion(
                        question = "发布到哪里？",
                        options = listOf(
                            com.andysagent.ragent.core.model.ApprovalOption("预发布"),
                            com.andysagent.ragent.core.model.ApprovalOption("生产环境"),
                        ),
                    ),
                ),
            ),
        )
        attentionState = AttentionUiState(items = listOf(item), activeItemId = item.id)

        composeRule.setContent {
            RagentTheme {
                AttentionSurface(
                    state = attentionState,
                    onEvent = { event ->
                        when (event) {
                            is AttentionEvent.SetExpanded -> {
                                attentionState = attentionState.copy(expanded = event.expanded)
                            }
                            is AttentionEvent.ResolveApproval -> {
                                if (!event.approve) denied = true
                            }
                            else -> Unit
                        }
                    },
                    onOpenSession = {},
                )
            }
        }

        composeRule.onNodeWithContentDescription("展开问题详情").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("关闭提醒，不改变审批状态").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("展开全部选项").assertDoesNotExist()
        composeRule.onNodeWithText("拒绝").assertIsDisplayed().performClick()
        assertTrue("Single-question attention should keep a deny action", denied)

        composeRule.onNodeWithContentDescription("展开问题详情").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription("收起问题详情").assertIsDisplayed()
        composeRule.onNodeWithText("生产环境").assertIsDisplayed()
    }

    @Test
    fun navigatesToNotificationDrivenHomeSurface() {
        var state by mutableStateOf(WorkbenchUiState())
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        if (event is WorkbenchEvent.SelectDestination) state = state.copy(destination = event.destination)
                    },
                )
            }
        }

        composeRule.onNodeWithContentDescription("Home").performClick()
        composeRule.onNodeWithText("Ragent").assertIsDisplayed()
        composeRule.onNodeWithText("Nothing needs your attention").assertDoesNotExist()
        composeRule.onNodeWithText("You’re offline").assertIsDisplayed()
        composeRule.onNodeWithText("Cross-device workspace").assertDoesNotExist()
    }

    @Test
    fun homeKeepsConnectionStatusQuietWhenConnected() {
        composeRule.setContent {
            RagentTheme {
                HomeSurface(
                    state = WorkbenchUiState(
                        destination = AgentoDestination.Home,
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                    ),
                    onEvent = {},
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                )
            }
        }

        composeRule.onNodeWithText("You’re offline").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("Reconnect").assertDoesNotExist()
    }

    @Test
    fun homeSurfacesAttentionInsteadOfDeviceInventory() {
        val sessions = listOf(
            Session("focus-waiting", "Review export", status = SessionStatus.WaitingApproval, latestSeq = 9),
            Session("focus-failed", "Retry upload", status = SessionStatus.Failed, latestSeq = 8),
        )
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        destination = AgentoDestination.Home,
                        sessions = sessions,
                    ),
                )
            }
        }

        composeRule.onNodeWithText("Needs attention").assertIsDisplayed()
        composeRule.onNodeWithText("Review export").assertIsDisplayed()
        composeRule.onNodeWithText("Retry upload").assertIsDisplayed()
        composeRule.onNodeWithText("Cross-device workspace").assertDoesNotExist()
    }

    @Test
    fun homeDoesNotOfferDeviceManagement() {
        composeRule.setContent {
            RagentTheme {
                HomeSurface(
                    state = WorkbenchUiState(destination = AgentoDestination.Home),
                    onEvent = {},
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                )
            }
        }

        composeRule.onNodeWithText("Cross-device workspace").assertDoesNotExist()
        composeRule.onNodeWithText("连接电脑").assertDoesNotExist()
    }

    @Test
    fun homeShowsProjectNamesInsteadOfPathsAndOpensOtherDeviceProject() {
        var opened: WorkbenchEvent.OpenOtherDeviceProject? = null
        composeRule.setContent {
            RagentTheme {
                HomeSurface(
                    state = WorkbenchUiState(
                        destination = AgentoDestination.Home,
                        projects = listOf(Project("local", "Local project", "C:/Users/ragent/private")),
                        sessions = listOf(Session("local-session", "Local work", projectId = "local", updatedAt = 10L)),
                        otherDeviceProjects = listOf(
                            com.andysagent.ragent.core.model.OtherDeviceProject(
                                targetId = "office",
                                targetLabel = "Office PC",
                                targetLastSeenAt = 20L,
                                projectId = "remote",
                                projectName = "Remote project",
                                updatedAt = 9L,
                            ),
                        ),
                    ),
                    onEvent = { event -> if (event is WorkbenchEvent.OpenOtherDeviceProject) opened = event },
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                )
            }
        }

        composeRule.onNodeWithText("Recent projects").assertIsDisplayed()
        composeRule.onNodeWithText("Projects on other devices").assertIsDisplayed()
        composeRule.onNodeWithText("Local project").assertIsDisplayed()
        composeRule.onNodeWithText("1 session").assertIsDisplayed()
        composeRule.onNodeWithText("Remote project").performClick()
        composeRule.onNodeWithText("C:/Users/ragent/private").assertDoesNotExist()
        assertEquals("office", opened?.targetId)
        assertEquals("remote", opened?.projectId)
    }

    @Test
    fun homePreviewsFourRecentProjectsAndRoutesToTheProjectCatalog() {
        var selectedDestination: AgentoDestination? = null
        val projects = (1..5).map { index ->
            Project("project-$index", "Project $index", "C:/private/project-$index")
        }
        val sessions = (1..5).map { index ->
            Session(
                id = "session-$index",
                title = "Session $index",
                projectId = "project-$index",
                updatedAt = index.toLong(),
            )
        }

        composeRule.setContent {
            RagentTheme {
                HomeSurface(
                    state = WorkbenchUiState(
                        destination = AgentoDestination.Home,
                        projects = projects,
                        sessions = sessions,
                    ),
                    onEvent = { event ->
                        if (event is WorkbenchEvent.SelectDestination) {
                            selectedDestination = event.destination
                        }
                    },
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                )
            }
        }

        composeRule.onNodeWithText("Project 5").assertIsDisplayed()
        composeRule.onNodeWithText("Project 2").assertIsDisplayed()
        composeRule.onNodeWithText("Project 1").assertDoesNotExist()
        composeRule.onNodeWithText("View all").assertIsDisplayed().performClick()
        assertEquals(AgentoDestination.Sessions, selectedDestination)
    }

    @Test
    fun homeNavigationEmitsHomeDestination() {
        var selected: AgentoDestination? = null
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(destination = AgentoDestination.Home),
                    onEvent = { event ->
                        if (event is WorkbenchEvent.SelectDestination) selected = event.destination
                    },
                )
            }
        }

        composeRule.onAllNodesWithContentDescription("Home").get(0).performClick()
        assertTrue("Home navigation should emit Home destination", selected == AgentoDestination.Home)
    }

    @Test
    fun systemBackOnSecondaryDestinationPopsToPreviousPrimary() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Sessions))
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        if (event is WorkbenchEvent.SelectDestination) state = state.copy(destination = event.destination)
                    },
                )
            }
        }

        composeRule.onNodeWithContentDescription(navigationText(NavigationR.string.navigation_settings)).performClick()
        composeRule.onNode(hasScrollToNodeAction()).performScrollToIndex(1)
        composeRule.onNodeWithTag("settings-list").performScrollTo().assertIsDisplayed()
        composeRule.runOnIdle {
            composeRule.activity.onBackPressedDispatcher.onBackPressed()
        }
        composeRule.waitForIdle()
        // Back pops to the previous primary destination (Sessions). It must not
        // be re-pushed by a stale selected-destination sync, which would cancel
        // the system Back and keep Settings visible.
        assertTrue("External destination should track the popped route", state.destination == AgentoDestination.Sessions)
        composeRule.onNodeWithText(agentUiText(WorkbenchR.string.home_create_project)).assertIsDisplayed()
        composeRule.onNodeWithTag("settings-list").assertDoesNotExist()
    }

    @Test
    fun emptyProjectUsesConversationEmptyState() {
        val project = Project("project-finance", "finance")
        val noChats = agentUiText(WorkbenchR.string.projects_no_sessions)

        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        destination = AgentoDestination.Sessions,
                        projects = listOf(project),
                        projectSessionsOpen = true,
                        browsingProjectId = project.id,
                    ),
                )
            }
        }

        composeRule.onNodeWithText(noChats).assertIsDisplayed()
        composeRule.onNodeWithText("No projects yet").assertDoesNotExist()
    }

    @Test
    fun primaryBackReturnsToTheActualPreviousDestination() {
        var state by mutableStateOf(WorkbenchUiState())
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        if (event is WorkbenchEvent.SelectDestination) {
                            state = state.copy(destination = event.destination)
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithContentDescription(navigationText(NavigationR.string.navigation_settings)).performClick()
        composeRule.onNodeWithContentDescription(navigationText(NavigationR.string.navigation_home)).performClick()
        composeRule.runOnIdle { composeRule.activity.onBackPressedDispatcher.onBackPressed() }
        composeRule.waitForIdle()

        assertTrue("Back should return to the page that opened Home", state.destination == AgentoDestination.Settings)
        composeRule.onNode(hasScrollToNodeAction()).performScrollToIndex(1)
        composeRule.onNodeWithTag("settings-list").performScrollTo().assertIsDisplayed()
        composeRule.runOnIdle { composeRule.activity.onBackPressedDispatcher.onBackPressed() }
        composeRule.waitForIdle()
        assertTrue("A second Back should reach the original Home visit", state.destination == AgentoDestination.Home)
    }

    @Test
    fun settingsLanguageAndThemeOpenDedicatedPagesAndBack() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings))
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            is WorkbenchEvent.OpenSettingsPage -> state = state.copy(settingsPage = event.page)
                            WorkbenchEvent.CloseSettingsPage -> state = state.copy(settingsPage = SettingsPage.Overview)
                            is WorkbenchEvent.SelectLanguage -> state = state.copy(appLanguage = event.language)
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithTag("settings-language").performClick()
        composeRule.onNodeWithTag("settings-language-system").assertIsDisplayed()
        composeRule.onNodeWithTag("settings-language-english").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithTag("settings-language-simplifiedchinese").performScrollTo().performClick()
        composeRule.onNodeWithContentDescription("Active").assertIsDisplayed()
        composeRule.onAllNodesWithContentDescription("Active").assertCountEquals(1)
        composeRule.runOnIdle { check(state.appLanguage == AppLanguage.SimplifiedChinese) }
        composeRule.onNodeWithTag("settings-back").performClick()
        composeRule.onNodeWithTag("settings-list").assertIsDisplayed()
        composeRule.onNodeWithTag("settings-theme").performClick()
        composeRule.onNodeWithTag("settings-theme-system").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun settingsManageDevicesHidesNormalSecurityDiagnosticsAndKeepsVersionPage() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings))
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            is WorkbenchEvent.OpenSettingsPage -> state = state.copy(settingsPage = event.page)
                            WorkbenchEvent.CloseSettingsPage -> state = state.copy(settingsPage = SettingsPage.Overview)
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onAllNodesWithText("App security").assertCountEquals(0)
        composeRule.onNodeWithTag("settings-manage-devices").performClick()
        composeRule.onNodeWithTag("settings-add-computer").assertIsDisplayed()
        composeRule.onAllNodesWithTag("settings-device-security").assertCountEquals(0)
        composeRule.onAllNodesWithText("Access & security").assertCountEquals(0)
        composeRule.onAllNodesWithText("Computer connection").assertCountEquals(0)
        composeRule.onAllNodesWithText("Account session").assertCountEquals(0)
        composeRule.onAllNodesWithText("This phone").assertCountEquals(0)
        composeRule.onNodeWithTag("settings-back").performClick()

        composeRule.onNodeWithTag("settings-version").performClick()
        composeRule.onNodeWithTag("settings-version-summary").assertIsDisplayed()
        composeRule.onNodeWithText("App version").assertIsDisplayed()
    }

    @Test
    fun settingsManageDevicesShowsRecentComputerAndStatusActions() {
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Settings,
                remoteTargets = listOf(
                    RemoteTarget(
                        instanceId = "office",
                        label = "Office PC",
                        endpoint = "https://office.example.test",
                        platform = "Windows",
                        lastSelectedAt = 20L,
                    ),
                ),
                accountComputers = listOf(
                    RemoteTarget(
                        instanceId = "office",
                        label = "Office PC",
                        endpoint = "https://office.example.test",
                        platform = "Windows",
                        lastSelectedAt = 20L,
                    ),
                    RemoteTarget(
                        instanceId = "home",
                        label = "Home PC",
                        endpoint = "https://home.example.test",
                        platform = "Windows",
                        linkedToPhone = false,
                    ),
                    RemoteTarget(
                        instanceId = "phone",
                        label = "Pixel phone",
                        endpoint = "",
                        platform = "android",
                    ),
                ),
                activeRemoteTargetId = "office",
                connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
            ),
        )
        var action: WorkbenchEvent? = null
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        action = event
                        when (event) {
                            is WorkbenchEvent.OpenSettingsPage -> state = state.copy(settingsPage = event.page)
                            is WorkbenchEvent.DisconnectRemoteTarget,
                            is WorkbenchEvent.ConnectRemoteTarget -> Unit
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithTag("settings-manage-devices").performScrollTo().performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("settings-back").assertIsDisplayed()
        composeRule.onNodeWithTag("settings-device-office").assertIsDisplayed()
        composeRule.onNodeWithTag("settings-device-home").assertIsDisplayed()
        composeRule.onNodeWithTag("settings-add-computer").assertIsDisplayed()
        composeRule.onAllNodesWithText("Pixel phone").assertCountEquals(0)
        val screenshot = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val output = File(
            InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
            "settings-manage-devices.png",
        )
        FileOutputStream(output).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
        composeRule.onNodeWithTag("settings-device-action-office").performClick()
        composeRule.runOnIdle {
            assertTrue("Connected computer should expose disconnect", action == WorkbenchEvent.DisconnectRemoteTarget("office"))
        }
        composeRule.onNodeWithTag("settings-device-action-home").performClick()
        composeRule.runOnIdle {
            assertTrue("Unlinked computer should expose connect", action == WorkbenchEvent.ConnectRemoteTarget("home"))
        }
        composeRule.onNodeWithTag("settings-add-computer").performClick()
        composeRule.runOnIdle {
            assertTrue("Manage devices should expose computer pairing", action == WorkbenchEvent.OpenPairing)
        }
    }

    @Test
    fun settingsManageDevicesKeepsThePendingTargetInConnectingState() {
        var state by mutableStateOf(WorkbenchUiState(
            destination = AgentoDestination.Settings,
            accountComputers = listOf(
                RemoteTarget(
                    instanceId = "home",
                    label = "Home PC",
                    endpoint = "",
                    platform = "Windows",
                ),
            ),
        ))

        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    connectingTargetId = "home",
                    onEvent = { event ->
                        if (event is WorkbenchEvent.OpenSettingsPage) {
                            state = state.copy(settingsPage = event.page)
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithTag("settings-manage-devices").performScrollTo().performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag("settings-device-action-home")
            .performScrollTo()
            .assertIsDisplayed()
            .assertIsNotEnabled()
        composeRule.onNodeWithText(agentUiText(WorkbenchR.string.settings_connecting)).assertIsDisplayed()
    }

    @Test
    fun settingsStartsWithGoogleAccountHeaderAndOmitsPhoneDeviceSection() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings))
        var signInRequested = false
        val accountRepository = object : AccountsRepository {
            var signedIn = false

            override suspend fun getGoogleAccountStatus() = GoogleAccountStatusResult(
                enabled = true,
                bound = signedIn,
                mode = "accounts",
                accountProfile = if (signedIn) {
                    GoogleAccountProfile(
                        displayName = "Mina Example",
                        email = "mina@example.test",
                    )
                } else {
                    null
                },
            )

            override suspend fun submitGoogleIdToken(idToken: String, alias: String?) =
                GoogleTokenSubmitResult(bound = true, mode = "accounts")
        }
        val accountViewModel = AccountsViewModel(accountRepository)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    accountsViewModel = accountViewModel,
                    onRequestGoogleSignIn = { signInRequested = true },
                    onEvent = { event ->
                        when (event) {
                            is WorkbenchEvent.OpenSettingsPage -> state = state.copy(settingsPage = event.page)
                            WorkbenchEvent.CloseSettingsPage -> state = state.copy(settingsPage = SettingsPage.Overview)
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onAllNodesWithText("Not signed in").assertCountEquals(0)
        composeRule.onAllNodesWithText("Ragent account").assertCountEquals(0)
        composeRule.onAllNodesWithText("G").assertCountEquals(0)
        composeRule.onNodeWithText("Sign in").performClick()
        composeRule.runOnIdle { assertTrue("Settings should expose Google sign-in", signInRequested) }
        composeRule.onAllNodesWithText("App & account").assertCountEquals(0)
        composeRule.onNode(hasScrollToNodeAction()).performScrollToIndex(1)
        composeRule.onNodeWithTag("settings-list").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithTag("settings-manage-devices").performScrollTo().assertIsDisplayed()
        composeRule.onAllNodesWithText("This phone").assertCountEquals(0)

        accountRepository.signedIn = true
        accountViewModel.onEvent(AccountsEvent.Refresh)
        composeRule.waitUntil(timeoutMillis = 5_000) {
            accountViewModel.state.value.accountProfile?.email == "mina@example.test"
        }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Mina Example").assertIsDisplayed()
        composeRule.onNodeWithText("mina@example.test").assertIsDisplayed()
        composeRule.onAllNodesWithText("Signed in").assertCountEquals(0)
        val signedInScreenshot = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val signedInOutput = File(
            InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
            "settings-signed-in-account.png",
        )
        FileOutputStream(signedInOutput).use { stream ->
            check(signedInScreenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
        composeRule.onNodeWithText("Mina Example").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Sign out on this phone").assertIsDisplayed()
    }

    @Test
    fun monetThemeRoutesSelectionAndMapsBrandRoleWithoutChangingWorkflowSemantics() {
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Settings,
                settingsPage = SettingsPage.Theme,
                appTheme = AppTheme.System,
            ),
        )
        var materialPrimary = Color.Unspecified
        var appPrimary = Color.Unspecified
        var running = Color.Unspecified

        composeRule.setContent {
            RagentTheme(themeVariant = AppTheme.Monet.value) {
                val currentMaterialPrimary = MaterialTheme.colorScheme.primary
                val currentAppPrimary = LocalRagentColors.current.actionPrimary
                val currentRunning = LocalRagentExtendedColors.current.running
                SideEffect {
                    materialPrimary = currentMaterialPrimary
                    appPrimary = currentAppPrimary
                    running = currentRunning
                }
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        if (event is WorkbenchEvent.SelectTheme) {
                            state = state.copy(appTheme = event.theme)
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithTag("settings-theme-monet").performScrollTo().performClick()
        composeRule.runOnIdle {
            assertTrue("Monet should use the active Material primary role", materialPrimary == appPrimary)
            assertTrue("Monet should keep a stable running semantic role", running != Color.Unspecified)
            assertTrue("The theme row should emit the selected mode", state.appTheme == AppTheme.Monet)
        }
    }

    @Test
    fun chatBackActionReturnsToHome() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Home, chatOpen = true))
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            WorkbenchEvent.CloseChat -> state = state.copy(chatOpen = false)
                            is WorkbenchEvent.SelectDestination -> state = state.copy(destination = event.destination, chatOpen = false)
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithContentDescription("Back to home").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("What matters now").assertIsDisplayed()
        assertTrue("Destination should remain the source tab", state.destination == AgentoDestination.Home)
    }

    @Test
    fun chatBackArrowReturnsToOriginatingHomeSurface() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Home, chatOpen = true))
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        if (event == WorkbenchEvent.CloseChat) state = state.copy(chatOpen = false)
                    },
                )
            }
        }

        composeRule.onNodeWithContentDescription("Back to home").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("What matters now").assertIsDisplayed()
        assertTrue("Back arrow should close chat without changing its source", state.destination == AgentoDestination.Home)
    }

    @Test
    fun projectsSurfacePreviewsTopTwoSessionsAndOpensProjectL2() {
        var selectedSession: String? = null
        var newSessionProject: String? = null
        var state by mutableStateOf(WorkbenchUiState(
            destination = AgentoDestination.Sessions,
            computers = listOf(com.andysagent.ragent.core.model.Computer("computer-1", "Office PC", "Windows", connected = true)),
            projects = listOf(Project("project-1", "Operations", "/work/operations")),
            sessions = listOf(
                Session("session-1", "Prepare weekly report", "project-1", SessionStatus.Working, latestSeq = 4),
                Session("session-2", "Review export", "project-1", SessionStatus.WaitingApproval, latestSeq = 2),
            ),
        ))
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            is WorkbenchEvent.OpenProjectSessions -> state = state.copy(
                                projectSessionsOpen = true,
                                browsingProjectId = event.projectId,
                            )
                            WorkbenchEvent.OpenAgents -> state = state.copy(agentOpen = true)
                            WorkbenchEvent.CloseProjectSessions -> state = state.copy(
                                projectSessionsOpen = false,
                                browsingProjectId = null,
                            )
                            is WorkbenchEvent.SelectSession -> selectedSession = event.sessionId
                            is WorkbenchEvent.OpenNewSession -> newSessionProject = event.projectId
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithText("Operations").assertIsDisplayed()
        composeRule.onNodeWithTag("projects-index-list").assertIsDisplayed()
        composeRule.onNodeWithText("Prepare weekly report").assertIsDisplayed()
        composeRule.onNodeWithText("Review export").assertIsDisplayed()
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.projects_needs_approval)).assertIsDisplayed()
        composeRule.onAllNodesWithContentDescription("More project actions").assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Open project: Operations").performClick()
        composeRule.onNodeWithContentDescription("Back to projects").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Open agents and apps").assertIsDisplayed()
        composeRule.onNodeWithText("Prepare weekly report").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Running").assertIsDisplayed()
        composeRule.onNodeWithContentDescription(workbenchText(WorkbenchR.string.projects_needs_action)).assertIsDisplayed()
        composeRule.onNodeWithText("Review export").performClick()
        assertTrue("Session row should emit selection", selectedSession == "session-2")
        composeRule.onNodeWithContentDescription("Back to projects").performClick()
        composeRule.onNodeWithText("Operations").assertIsDisplayed()

        composeRule.onNodeWithContentDescription("Open project: Operations").performClick()
        composeRule.onNodeWithContentDescription("Open agents and apps").performClick()
        composeRule.onNodeWithText("Agents & apps").assertIsDisplayed()
        composeRule.onNodeWithText("Create Agent").assertIsDisplayed()
    }

    @Test
    fun agentsAppsOpenSessionCarriesTheCurrentProject() {
        var event: WebParityEvent? = null
        composeRule.setContent {
            RagentTheme {
                AgentsAppsPage(
                    state = WebParityUiState(
                        agents = listOf(WebAgent("agent-1", "Report helper", "codex", false, "")),
                    ),
                    onEvent = { event = it },
                    projectId = "project-1",
                )
            }
        }

        composeRule.onNodeWithText("Open session").performClick()
        assertTrue(
            "Agent session should carry the current L2 project",
            event == WebParityEvent.StartAgent("agent-1", "project-1"),
        )
    }

    @Test
    fun settingsDoesNotExposeAgentsAndApps() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings))
            }
        }

        composeRule.onAllNodesWithText("Agents & apps").assertCountEquals(0)
    }

    @Test
    fun expandedProjectsSurfaceKeepsTheMobileProjectHierarchy() {
        val state = WorkbenchUiState(
            destination = AgentoDestination.Sessions,
            projects = listOf(Project("project-1", "Operations", "/work/operations")),
            sessions = listOf(Session("session-1", "Prepare weekly report", "project-1", SessionStatus.Completed, latestSeq = 4)),
            selectedProjectId = "project-1",
        )
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(state = state, windowSizeClass = AgentoWindowSizeClass.Expanded)
            }
        }

        composeRule.onAllNodesWithText("Operations").assertCountEquals(1)
        composeRule.onNodeWithText("Prepare weekly report").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Completed").assertIsDisplayed()
    }

    @Test
    fun expandedSessionsLeavesDetailEmptyUntilProjectOrSessionIsOpened() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        destination = AgentoDestination.Sessions,
                        projects = listOf(Project("project-1", "Operations")),
                    ),
                    windowSizeClass = AgentoWindowSizeClass.Expanded,
                )
            }
        }

        // This test intentionally drives Expanded on the phone test device to
        // exercise the branch. The right pane is clipped by that synthetic
        // width, so assert its composition rather than viewport visibility.
        composeRule.onAllNodesWithText("选择一个项目或会话").assertCountEquals(1)
        composeRule.onAllNodesWithText("从左侧开始查看项目和会话。").assertCountEquals(1)
        composeRule.onNodeWithContentDescription(navigationText(NavigationR.string.navigation_home)).assertIsDisplayed()
        composeRule.onNodeWithContentDescription(navigationText(NavigationR.string.navigation_settings)).assertIsDisplayed()
    }

    @Test
    fun expandedProjectOpensL2InDetailAndSelectingSessionMovesL2BesideChat() {
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Sessions,
                projects = listOf(Project("project-1", "Operations")),
                sessions = listOf(
                    Session("session-1", "Prepare weekly report", "project-1", SessionStatus.Working, latestSeq = 4),
                    Session("session-2", "Review export", "project-1", SessionStatus.Completed, latestSeq = 2),
                    Session("session-3", "Archive old exports", "project-1", SessionStatus.Completed, latestSeq = 1),
                ),
            ),
        )
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    windowSizeClass = AgentoWindowSizeClass.Expanded,
                    onEvent = { event ->
                        when (event) {
                            is WorkbenchEvent.OpenProjectSessions -> state = state.copy(
                                projectSessionsOpen = true,
                                browsingProjectId = event.projectId,
                            )
                            is WorkbenchEvent.SelectSession -> state = state.copy(
                                chatOpen = true,
                                sessionId = event.sessionId,
                            )
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithText("Operations").performClick()
        composeRule.onAllNodesWithText("Running").assertCountEquals(1)
        composeRule.onAllNodesWithText("Recent").assertCountEquals(1)
        // The detail pane is intentionally too narrow on this phone-sized
        // test root to perform a meaningful tap. Model the same emitted event
        // and verify the resulting shell + Chat arrangement below; the actual
        // wide-window tap is covered by the tablet screenshot pass.
        composeRule.runOnIdle {
            state = state.copy(chatOpen = true, sessionId = "session-3")
        }
        // On the phone-sized test root Chat is full-screen, so the underlying
        // L2 back affordance is intentionally covered by the Chat surface.
        composeRule.onNodeWithContentDescription("Back to projects").assertDoesNotExist()
        composeRule.onNodeWithContentDescription("Back to chat").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Home").assertDoesNotExist()
    }

    @Test
    fun expandedSessionsSearchWithoutMatchesShowsEmptyState() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        destination = AgentoDestination.Sessions,
                        sessionSearchQuery = "does-not-exist",
                        projects = listOf(Project("project-1", "Operations")),
                        sessions = listOf(Session("session-1", "Prepare weekly report", "project-1")),
                    ),
                    windowSizeClass = AgentoWindowSizeClass.Expanded,
                )
            }
        }

        composeRule.onAllNodesWithText("No sessions found").assertCountEquals(1)
    }

    @Test
    fun approvalStateDisablesComposerAndKeepsDecisionTargetsLarge() {
        val approval = com.andysagent.ragent.core.agentui.PermissionRequestUiState(
            id = "approval-1",
            title = "Approve upload",
            reason = "The agent needs permission to upload the report.",
        )
        composeRule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                WorkbenchScreen(
                    WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-approval",
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                        runStatus = AgentRunStatus.WaitingApproval,
                        approval = approval,
                    ),
                )
            }
        }

        composeRule.onNodeWithText("Approve").assertIsDisplayed().assertHeightIsAtLeast(52.dp)
        composeRule.onNodeWithText("Deny").assertIsDisplayed().assertHeightIsAtLeast(52.dp)
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer))
            .assertIsDisplayed().assertIsNotEnabled()
        composeRule.onNodeWithText(agentUiText(AgentUiR.string.agentui_resolve_approval)).assertIsDisplayed()
    }

    @Test
    fun fullScreenChatShowsTopCapsuleAndFloatingBackAction() {
        var closed = false
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(chatOpen = true, sessionId = "session-1", sessionTitle = "Weekly report"),
                    onEvent = { event -> if (event == WorkbenchEvent.CloseChat) closed = true },
                )
            }
        }

        composeRule.onNodeWithText("Weekly report").assertIsDisplayed()
        composeRule.onAllNodesWithText("Home").assertCountEquals(0)
        composeRule.onAllNodesWithText("设置").assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Back to chat").performClick()
        assertTrue("Chat toolbar back should close chat", closed)
    }

    @Test
    fun composerUsesFloatingWebAlignedWorkArea() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-1",
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                    ),
                )
            }
        }

        composeRule.waitForIdle()
        // Collapsed capsule state
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer))
            .assertIsDisplayed()
            .assert(hasClickAction())
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_add_attachment)).assertIsDisplayed()
        assertTrue(
            "Composer prompt should be visible in the text or editor semantics",
            composeRule
                .onAllNodesWithText(agentUiText(AgentUiR.string.agentui_composer_prompt))
                .fetchSemanticsNodes()
                .isNotEmpty(),
        )
        // Keep the send target in the collapsed rail, but an empty draft must
        // not be sendable or expand the composer when that target is tapped.
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_send_message))
            .assertIsDisplayed().assertIsNotEnabled()
        val collapsedComposerWidth = composeRule
            .onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer))
            .fetchSemanticsNode()
            .boundsInRoot
            .width

        // One tap expands the composer and keeps it expanded after focus changes.
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(
            agentUiText(AgentUiR.string.agentui_session_configuration, "Codex"),
        ).assertIsDisplayed()
        val expandedComposerWidth = composeRule
            .onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer))
            .fetchSemanticsNode()
            .boundsInRoot
            .width
        assertTrue(
            "Collapsed composer should be slightly narrower than expanded",
            collapsedComposerWidth < expandedComposerWidth,
        )

        // A tap outside the composer collapses it again.
        composeRule.onRoot().performTouchInput {
            click(Offset(24f, 240f))
        }
        composeRule.waitForIdle()
        composeRule.onAllNodesWithContentDescription(
            agentUiText(AgentUiR.string.agentui_session_configuration, "Codex"),
        ).assertCountEquals(0)
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).assertIsDisplayed()
    }

    @Test
    fun composerExpansionKeepsTranscriptVisibleThroughoutTheTransition() {
        val request = "Keep the transcript visible"
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-composer-stability",
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                        timelineItems = listOf(
                            TimelineItem.Message(
                                id = "request",
                                seq = 1,
                                role = TimelineRole.User,
                                text = request,
                                completed = true,
                            ),
                            TimelineItem.Message(
                                id = "response",
                                seq = 2,
                                role = TimelineRole.Agent,
                                text = "The transcript stays in place while the composer opens.",
                                completed = true,
                            ),
                        ),
                    ),
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithText(request).assertIsDisplayed()
        composeRule.mainClock.autoAdvance = false
        try {
            composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).performClick()
            repeat(24) {
                composeRule.mainClock.advanceTimeBy(16L)
                composeRule.onNodeWithText(request).assertIsDisplayed()
            }
        } finally {
            composeRule.mainClock.autoAdvance = true
        }
    }

    @Test
    fun composerTextsResolveForEverySupportedLanguage() {
        val expectedPrompts = mapOf(
            "en" to "What should we work on?",
            "zh-CN" to "想做点什么？",
            "zh-TW" to "想做些什麼？",
            "ja" to "何に取り組みますか？",
            "ko" to "무엇을 함께 할까요?",
            "fr" to "Sur quoi souhaitez-vous travailler ?",
            "es" to "¿En qué trabajamos?",
        )

        expectedPrompts.forEach { (languageTag, expectedPrompt) ->
            val context = contextForLanguage(languageTag)
            assertEquals(
                "Composer prompt should resolve for $languageTag",
                expectedPrompt,
                context.getString(AgentUiR.string.agentui_composer_prompt),
            )
            assertTrue(
                "Composer accessibility label should resolve for $languageTag",
                context.getString(AgentUiR.string.agentui_message_composer).isNotBlank(),
            )
            assertTrue(
                "Session configuration label should resolve for $languageTag",
                context.getString(AgentUiR.string.agentui_session_configuration, "Codex").isNotBlank(),
            )
        }
    }

    @Test
    fun emptyConversationUsesTheSameLocalizedQuestionAsTheComposer() {
        val prompt = agentUiText(AgentUiR.string.agentui_composer_prompt)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "empty-localized-prompt",
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                    ),
                )
            }
        }

        // The same localized wording is intentionally visible in both the
        // empty-state question and the composer placeholder.
        composeRule.onAllNodesWithText(prompt).assertCountEquals(2)
        listOf(
            WorkbenchR.string.workbench_suggestion_organize_project,
            WorkbenchR.string.workbench_suggestion_explain_file,
            WorkbenchR.string.workbench_suggestion_create_plan,
        ).forEach { suggestion ->
            composeRule.onNodeWithText(agentUiText(suggestion))
                .assertIsDisplayed()
                .assertHeightIsAtLeast(52.dp)
        }
    }

    @Test
    fun draftHidesEmptyConversationSuggestions() {
        val draft = "Outline the next release"
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "draft-hides-suggestions",
                        composerText = draft,
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                    ),
                )
            }
        }

        composeRule.onNodeWithText(draft).assertIsDisplayed()
        listOf(
            WorkbenchR.string.workbench_suggestion_organize_project,
            WorkbenchR.string.workbench_suggestion_explain_file,
            WorkbenchR.string.workbench_suggestion_create_plan,
        ).forEach { suggestion ->
            composeRule.onNodeWithText(agentUiText(suggestion)).assertDoesNotExist()
        }
    }

    @Test
    fun connectionRecoveryCopyResolvesForEverySupportedLanguage() {
        val expectedTitles = mapOf(
            "en" to "Connection unavailable",
            "zh-CN" to "无法连接",
            "zh-TW" to "無法連線",
            "ja" to "接続できません",
            "ko" to "연결할 수 없음",
            "fr" to "Connexion indisponible",
            "es" to "Conexión no disponible",
        )
        val expectedNewChatTitles = mapOf(
            "en" to "New chat",
            "zh-CN" to "新会话",
            "zh-TW" to "新對話",
            "ja" to "新しいチャット",
            "ko" to "새 대화",
            "fr" to "Nouvelle discussion",
            "es" to "Nuevo chat",
        )

        expectedTitles.forEach { (languageTag, expectedTitle) ->
            val context = contextForLanguage(languageTag)
            assertEquals(
                "Connection recovery title should resolve for $languageTag",
                expectedTitle,
                context.getString(WorkbenchR.string.workbench_connection_unavailable_title),
            )
            assertTrue(
                "Connection recovery detail should resolve for $languageTag",
                context.getString(WorkbenchR.string.workbench_connection_unavailable_detail).isNotBlank(),
            )
            assertTrue(
                "Reconnect action should resolve for $languageTag",
                context.getString(WorkbenchR.string.workbench_reconnect).isNotBlank(),
            )
            assertEquals(
                "New chat title should resolve for $languageTag",
                expectedNewChatTitles.getValue(languageTag),
                context.getString(AgentUiR.string.agentui_new_conversation),
            )
            assertTrue(
                "Device connection empty state should resolve for $languageTag",
                context.getString(WorkbenchR.string.workbench_connect_device_title).isNotBlank(),
            )
            assertTrue(
                "Device setup action should resolve for $languageTag",
                context.getString(WorkbenchR.string.workbench_connect_device_action).isNotBlank(),
            )
            assertTrue(
                "Conversation suggestions should resolve for $languageTag",
                listOf(
                    WorkbenchR.string.workbench_suggestion_organize_project,
                    WorkbenchR.string.workbench_suggestion_explain_file,
                    WorkbenchR.string.workbench_suggestion_create_plan,
                ).all { context.getString(it).isNotBlank() },
            )
        }
    }

    @Test
    fun chatHeaderOmitsTechnicalProjectMetadata() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-header-metadata",
                        sessionTitle = "Session",
                        selectedProjectId = "project-e2e",
                        projects = listOf(
                            Project("project-e2e", ".ragent-e2e-validation · Windows", "C:/ragent"),
                        ),
                    ),
                )
            }
        }

        composeRule.onNodeWithText(agentUiText(AgentUiR.string.agentui_new_conversation)).assertIsDisplayed()
        composeRule.onAllNodesWithText(".ragent-e2e-validation · Windows").assertCountEquals(0)
    }

    @Test
    fun completedAgentMessageHidesSessionLabelsProtocol() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-protocol-labels",
                        timelineItems = listOf(
                            TimelineItem.Message(
                                id = "agent-response",
                                seq = 1,
                                role = TimelineRole.Agent,
                                text = "任务已完成。\n<ragent-session-labels>{\"title\":\"内部索引\"}</ragent-session-labels>",
                                completed = true,
                            ),
                        ),
                    ),
                )
            }
        }

        composeRule.onNodeWithText("任务已完成。").assertIsDisplayed()
        composeRule.onAllNodesWithText("ragent-session-labels", substring = true).assertCountEquals(0)
        composeRule.onAllNodesWithText("内部索引").assertCountEquals(0)
    }

    @Test
    fun onlyLatestCompletedAgentMessageKeepsActionBar() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-message-actions",
                        timelineItems = listOf(
                            TimelineItem.Message(
                                id = "agent-earlier",
                                seq = 1,
                                role = TimelineRole.Agent,
                                text = "Earlier response",
                                completed = true,
                            ),
                            TimelineItem.Message(
                                id = "agent-latest",
                                seq = 2,
                                role = TimelineRole.Agent,
                                text = "Latest response",
                                completed = true,
                            ),
                        ),
                    ),
                )
            }
        }

        composeRule.onNodeWithText("Earlier response").assertIsDisplayed()
        composeRule.onNodeWithText("Latest response").assertIsDisplayed()
        composeRule.onAllNodesWithContentDescription(
            agentUiText(AgentUiR.string.agentui_copy_message),
        ).assertCountEquals(1)
        capturePickerScreen("workbench-distinct-completed-replies.png")
    }

    @Test fun streamFinalizationKeepsEarlierReplyWithoutDuplicatingItsOwnEntity() {
        val earlier = TimelineItem.Message("earlier", 1, TimelineRole.Agent, "Earlier response", true)
        val live = TimelineItem.Message("latest", 2, TimelineRole.Agent, "Live reply", false)
        var state by mutableStateOf(WorkbenchUiState(chatOpen = true,
            sessionId = "multi-reply-update", timelineItems = listOf(earlier, live)))
        composeRule.setContent { RagentTheme { WorkbenchScreen(state) } }
        composeRule.onNodeWithText("Earlier response").assertIsDisplayed()
        composeRule.onNodeWithText("Live reply").assertIsDisplayed()
        composeRule.runOnIdle {
            state = state.copy(timelineItems = listOf(earlier,
                live.copy(seq = 3, text = "Final reply", completed = true)))
        }
        composeRule.onNodeWithText("Earlier response").assertIsDisplayed()
        composeRule.onAllNodesWithText("Final reply").assertCountEquals(1)
        composeRule.onNodeWithText("Final reply").assertIsDisplayed()
        composeRule.onNodeWithText("Live reply").assertDoesNotExist()
        composeRule.onAllNodesWithContentDescription(agentUiText(AgentUiR.string.agentui_copy_message)).assertCountEquals(1)
        capturePickerScreen("workbench-same-entity-finalized.png")
    }

    @Test
    fun emptyComposerKeepsOneLineEditorInCollapsedAndExpandedStates() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-composer-empty-line",
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                    ),
                )
            }
        }

        composeRule.waitForIdle()
        val editor = composeRule.onNode(hasSetTextAction())
        val oneLineMin = 20f
        val oneLineMax = 52f
        val collapsedHeight = editor.fetchSemanticsNode().boundsInRoot.height
        assertTrue(
            "Collapsed empty editor should reserve one line: ${collapsedHeight}px",
            collapsedHeight in oneLineMin..oneLineMax,
        )

        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).performClick()
        composeRule.waitForIdle()
        val expandedHeight = composeRule.onNode(hasSetTextAction()).fetchSemanticsNode().boundsInRoot.height
        assertTrue(
            "Expanded empty editor should reserve one line: ${expandedHeight}px",
            expandedHeight in oneLineMin..oneLineMax,
        )
    }

    @Test
    @OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
    fun composerBottomActionStaysAnchoredDuringExpandAndCollapse() {
        composeRule.setContent {
            RagentTheme {
                // This test isolates the capsule morph in a fixed viewport.
                // A real IME legitimately lifts the whole dock; its opening,
                // focus, and fullscreen continuity have separate device tests.
                // Keep the original 1px geometry assertion, not an IME-sized tolerance.
                androidx.compose.ui.platform.InterceptPlatformTextInput({ _, _ ->
                    kotlinx.coroutines.awaitCancellation()
                }) {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-composer-anchor",
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                    ),
                )
                }
            }
        }

        val addAttachment = composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_add_attachment))
        composeRule.waitForIdle()
        addAttachment.assertHeightIsAtLeast(48.dp)
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_send_message))
            .assertHeightIsAtLeast(48.dp)
        val collapsedBottom = addAttachment.fetchSemanticsNode().boundsInRoot.bottom

        composeRule.mainClock.autoAdvance = false
        try {
            composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).performClick()
            val expandSamples = buildList {
                repeat(12) {
                    composeRule.mainClock.advanceTimeBy(16L)
                    add(addAttachment.fetchSemanticsNode().boundsInRoot.bottom)
                }
            }
            val expandDrift = expandSamples.maxOf { kotlin.math.abs(it - collapsedBottom) }
            assertTrue("Composer bottom moved while expanding: $expandDrift px", expandDrift <= 1f)

            repeat(60) { composeRule.mainClock.advanceTimeBy(16L) }
            val expandedBottom = addAttachment.fetchSemanticsNode().boundsInRoot.bottom

            composeRule.onRoot().performTouchInput {
                click(Offset(24f, 240f))
            }
            val collapseSamples = buildList {
                repeat(12) {
                    composeRule.mainClock.advanceTimeBy(16L)
                    add(addAttachment.fetchSemanticsNode().boundsInRoot.bottom)
                }
            }
            val collapseDrift = collapseSamples.maxOf { kotlin.math.abs(it - expandedBottom) }
            assertTrue("Composer bottom moved while collapsing: $collapseDrift px", collapseDrift <= 1f)
        } finally {
            composeRule.mainClock.autoAdvance = true
        }
    }

    @Test
    fun composerFullscreenEditorRendersMarkdownWithoutRawSyntax() {
        var state by mutableStateOf(
            WorkbenchUiState(
                chatOpen = true,
                sessionId = "session-composer-fullscreen",
                composerText = "第一行\n第二行\n第三行\n第四行\n第五行\n**Important**: verify `healthz`",
            ),
        )
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        if (event is WorkbenchEvent.ComposerChanged) {
                            state = state.copy(composerText = event.text)
                        }
                    },
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).assertIsDisplayed()
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_fullscreen_edit))
            .assertIsDisplayed()
            .performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithText(agentUiText(AgentUiR.string.agentui_edit_message)).assertIsDisplayed()
        assertTrue(
            "Formatted fullscreen content is missing",
            composeRule.onAllNodesWithText("Important", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty(),
        )
        retainReadingFailure("workbench-fullscreen-failure") {
            assertTrue(
                "Formatted fullscreen code content is missing",
                composeRule.onAllNodesWithText("healthz", substring = true)
                    .fetchSemanticsNodes()
                    .isNotEmpty(),
            )
        }
        composeRule.onAllNodesWithText("**Important**").assertCountEquals(0)
        composeRule.onAllNodesWithText("`healthz`").assertCountEquals(0)
        composeRule.onNodeWithText(agentUiText(AgentUiR.string.agentui_done)).assertIsDisplayed()
    }

    @Test
    fun composerAmbientShadowIsVisibleOnLightCanvas() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-composer-shadow",
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                    ),
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).assertIsDisplayed()

        val screenshot = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val dir = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)
        val output = File(dir, "composer-shadow-screen.png")
        FileOutputStream(output).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val publishedDir = "/sdcard/Download/ragent-screenshots"
        automation.executeShellCommand("mkdir -p $publishedDir").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
        automation.executeShellCommand("cp ${output.absolutePath} $publishedDir/composer-shadow-screen.png").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
    }

    @Test
    fun composerExpandedShadowIsVisibleOnLightCanvas() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-composer-shadow-expanded",
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                        composerText = "Here is an expanded multi-line draft plan for Ragent execution",
                    ),
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).assertIsDisplayed()

        val screenshot = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val dir = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)
        val output = File(dir, "composer-expanded-shadow-screen.png")
        FileOutputStream(output).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val publishedDir = "/sdcard/Download/ragent-screenshots"
        automation.executeShellCommand("mkdir -p $publishedDir").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
        automation.executeShellCommand("cp ${output.absolutePath} $publishedDir/composer-expanded-shadow-screen.png").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
    }

    @Test
    fun primaryNavigationAmbientShadowIsVisibleOnLightCanvas() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(WorkbenchUiState())
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(navigationText(NavigationR.string.navigation_chat)).assertIsDisplayed()

        val screenshot = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val dir = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)
        val output = File(dir, "navigation-shadow-screen.png")
        FileOutputStream(output).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val publishedDir = "/sdcard/Download/ragent-screenshots"
        automation.executeShellCommand("mkdir -p $publishedDir").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
        automation.executeShellCommand("cp ${output.absolutePath} $publishedDir/navigation-shadow-screen.png").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
    }

    @Test
    fun sessionsNavigationWithActionDockShadowIsVisibleOnLightCanvas() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    WorkbenchUiState(
                        destination = AgentoDestination.Sessions,
                        computers = ProjectsReferenceFixtures.computers,
                        projects = ProjectsReferenceFixtures.projects,
                        sessions = ProjectsReferenceFixtures.sessions,
                    ),
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(navigationText(NavigationR.string.navigation_new_project)).assertIsDisplayed()

        val screenshot = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val dir = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)
        val output = File(dir, "sessions-dock-shadow-screen.png")
        FileOutputStream(output).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val publishedDir = "/sdcard/Download/ragent-screenshots"
        automation.executeShellCommand("mkdir -p $publishedDir").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
        automation.executeShellCommand("cp ${output.absolutePath} $publishedDir/sessions-dock-shadow-screen.png").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
    }

    @Test
    fun composerShadowIsVisibleOnDarkCanvas() {
        composeRule.setContent {
            RagentTheme(darkTheme = true) {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-composer-shadow-dark",
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                    ),
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).assertIsDisplayed()

        val screenshot = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val dir = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)
        val output = File(dir, "composer-shadow-dark-screen.png")
        FileOutputStream(output).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val publishedDir = "/sdcard/Download/ragent-screenshots"
        automation.executeShellCommand("mkdir -p $publishedDir").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
        automation.executeShellCommand("cp ${output.absolutePath} $publishedDir/composer-shadow-dark-screen.png").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
    }

    @Test
    fun navigationShadowIsVisibleOnDarkCanvas() {
        composeRule.setContent {
            RagentTheme(darkTheme = true) {
                WorkbenchScreen(WorkbenchUiState())
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(navigationText(NavigationR.string.navigation_chat)).assertIsDisplayed()

        val screenshot = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val dir = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)
        val output = File(dir, "navigation-shadow-dark-screen.png")
        FileOutputStream(output).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val publishedDir = "/sdcard/Download/ragent-screenshots"
        automation.executeShellCommand("mkdir -p $publishedDir").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
        automation.executeShellCommand("cp ${output.absolutePath} $publishedDir/navigation-shadow-dark-screen.png").use { command -> android.os.ParcelFileDescriptor.AutoCloseInputStream(command).use { it.readBytes() } }
    }

    @Test
    fun runtimeButtonOpensAndClosesRuntimePage() {
        var state by mutableStateOf(
            WorkbenchUiState(
                chatOpen = true,
                sessionId = "session-runtime",
                timelineItems = pickerTranscript(),
                connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                runtimeCatalog = RuntimeCatalog(
                    tools = listOf(RuntimeToolOption(id = "codex", label = "Codex")),
                ),
            ),
        )
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            WorkbenchEvent.OpenEffortPicker -> state = state.copy(effortPickerOpen = true)
                            WorkbenchEvent.CloseEffortPicker -> state = state.copy(effortPickerOpen = false)
                            WorkbenchEvent.OpenRuntimePicker -> state = state.copy(runtimePickerOpen = true)
                            WorkbenchEvent.CloseRuntimePicker -> state = state.copy(runtimePickerOpen = false)
                            is WorkbenchEvent.SelectRuntime -> state = state.copy(runtimeTool = event.tool, runtimePickerOpen = false)
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).performClick()
        composeRule.onNodeWithTag("composer-effort-action").performClick()
        composeRule.onNodeWithTag("composer-model-action", useUnmergedTree = true).performClick()
        composeRule.onNodeWithTag("composer-runtime-picker").assertIsDisplayed()
        capturePickerScreen("composer-runtime-screen")
        val screenshot = composeRule.onNodeWithTag("composer-runtime-picker").captureToImage().asAndroidBitmap()
        FileOutputStream(
            File(
                InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
                "composer-runtime-picker.png",
            ),
        ).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
        composeRule.onNodeWithContentDescription("Codex").performClick()
        composeRule.onNodeWithTag("composer-runtime-picker").assertDoesNotExist()
    }

    @Test
    fun runtimePickerNavigatesFromHarnessToProviderToModel() {
        var state by mutableStateOf(
            WorkbenchUiState(
                chatOpen = true,
                sessionId = "session-runtime-provider",
                timelineItems = pickerTranscript(),
                connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                runtimeCatalog = RuntimeCatalog(
                    tools = listOf(
                        RuntimeToolOption(
                            id = "copilot",
                            label = "Copilot",
                            providers = listOf(
                                RuntimeProviderOption(id = "provider-a", label = "Provider A"),
                                RuntimeProviderOption(id = "provider-b", label = "Provider B"),
                            ),
                            models = listOf(
                                RuntimeModelOption("model-a@provider-a", "Model A", "provider-a"),
                                RuntimeModelOption("model-b@provider-b", "Model B", "provider-b"),
                            ),
                        ),
                    ),
                ),
            ),
        )
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            WorkbenchEvent.OpenEffortPicker -> state = state.copy(effortPickerOpen = true)
                            WorkbenchEvent.CloseEffortPicker -> state = state.copy(effortPickerOpen = false)
                            WorkbenchEvent.OpenRuntimePicker -> state = state.copy(runtimePickerOpen = true)
                            WorkbenchEvent.CloseRuntimePicker -> state = state.copy(runtimePickerOpen = false)
                            is WorkbenchEvent.SelectRuntime -> state = state.copy(
                                runtimeTool = event.tool,
                                runtimeProvider = null,
                                runtimeModel = null,
                                runtimePickerOpen = true,
                            )
                            is WorkbenchEvent.SelectProvider -> state = state.copy(
                                runtimeProvider = event.provider,
                                runtimeModel = null,
                            )
                            is WorkbenchEvent.SelectModel -> state = state.copy(
                                runtimeModel = event.model,
                                runtimePickerOpen = false,
                            )
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).performClick()
        composeRule.onNodeWithTag("composer-effort-action").performClick()
        composeRule.onNodeWithTag("composer-model-action", useUnmergedTree = true).performClick()
        composeRule.onNodeWithTag("composer-runtime-picker").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Copilot").assertIsNotSelected().performClick()
        composeRule.onNodeWithText("Model A").assertDoesNotExist()
        capturePickerScreen("composer-provider-screen")
        composeRule.onNodeWithContentDescription("Provider A").assertIsNotSelected().performClick()
        composeRule.onNodeWithText("Model B").assertDoesNotExist()
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_return_to_provider)).performClick()
        composeRule.onNodeWithText("Provider B").assertIsDisplayed()
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_return_to_runtime)).performClick()
        composeRule.onNodeWithContentDescription("Copilot").assertIsNotSelected().performClick()
        composeRule.onNodeWithText("Provider A").performClick()
        capturePickerScreen("composer-model-screen")
        composeRule.onNodeWithContentDescription("Model A").assertIsDisplayed().assertIsNotSelected().performClick()
        composeRule.onNodeWithTag("composer-runtime-picker").assertDoesNotExist()
        composeRule.onNodeWithTag("composer-effort-action").performClick()
        composeRule.onNodeWithTag("composer-model-label", useUnmergedTree = true).assertTextEquals("Model A")

        val screenshot = composeRule.onNodeWithTag("agent-composer").captureToImage().asAndroidBitmap()
        FileOutputStream(
            File(
                InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
                "composer-runtime-controls.png",
            ),
        ).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
    }

    @Test
    fun chatComposerSendActionEmitsEvent() {
        var send = false
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-send",
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                        composerText = "Prepare the report",
                    ),
                    onEvent = { if (it == WorkbenchEvent.SendMessage) send = true },
                )
            }
        }
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_send_message)).performClick()
        assertTrue("Send control should emit SendMessage", send)
    }

    @Test
    fun chatComposerSendClearsControlledMarkdownEditor() {
        var state by mutableStateOf(
            WorkbenchUiState(
                chatOpen = true,
                sessionId = "session-send-clears-editor",
                connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                composerText = "Send **this**",
            ),
        )
        var sendCount = 0
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            WorkbenchEvent.SendMessage -> {
                                sendCount += 1
                                state = state.copy(composerText = "")
                            }
                            is WorkbenchEvent.ComposerChanged -> {
                                state = state.copy(composerText = event.text)
                            }
                            else -> Unit
                        }
                    },
                )
            }
        }

        val editor = composeRule.onNode(hasSetTextAction())
        composeRule.waitForIdle()
        editor.assertTextEquals("Send this")

        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_send_message)).performClick()
        composeRule.waitForIdle()

        assertTrue("Send control should emit exactly one SendMessage", sendCount == 1)
        editor.assertTextEquals("")
        assertTrue("Controlled composer state should be empty after send", state.composerText.isEmpty())
    }

    @Test
    fun chatComposerStopActionEmitsEvent() {
        var stop = false
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "session-stop",
                        connection = AgentConnectionStatus.Connected,
                        runStatus = AgentRunStatus.Working,
                        composerText = "",
                        pendingTurn = sendingPendingTurn(),
                    ),
                    onEvent = { if (it == WorkbenchEvent.CancelRun) stop = true },
                )
            }
        }
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_stop_generating)).performClick()
        assertTrue("Stop control should emit CancelRun", stop)
    }

    @Test
    fun reconnectDisablesSendAndStopWithoutDisablingTheDraft() {
        var state by mutableStateOf(WorkbenchUiState(
            chatOpen = true, sessionId = "reconnect-composer", runStatus = AgentRunStatus.Working,
            connection = AgentConnectionStatus.Connected,
        ))
        var sends = 0
        var stops = 0
        composeRule.setContent { RagentTheme {
            WorkbenchScreen(state = state, onEvent = { event ->
                when (event) {
                    is WorkbenchEvent.ComposerChanged -> state = state.copy(composerText = event.text)
                    WorkbenchEvent.SendMessage -> sends++
                    WorkbenchEvent.CancelRun -> stops++
                    else -> Unit
                }
            })
        } }
        val stop = agentUiText(AgentUiR.string.agentui_stop_generating)
        val send = agentUiText(AgentUiR.string.agentui_send_message)
        composeRule.onNodeWithContentDescription(stop).assertIsEnabled()
        composeRule.runOnIdle { state = state.copy(connection = AgentConnectionStatus.Reconnecting) }
        composeRule.onNodeWithContentDescription(stop).assertIsNotEnabled()
        composeRule.onNode(hasSetTextAction()).performTextInput("Keep editing")
        composeRule.onNodeWithContentDescription(send).assertIsNotEnabled()
        composeRule.runOnIdle {
            assertTrue(state.composerText.contains("Keep editing"))
            assertTrue(sends == 0 && stops == 0)
            state = state.copy(connection = AgentConnectionStatus.Connected)
        }
        composeRule.onNodeWithContentDescription(send).assertIsEnabled().performClick()
        assertTrue(sends == 1 && stops == 0)
    }

    @Test
    fun workingComposerRemainsEditableAndSwitchesFromStopToSend() {
        var sendCount = 0
        var state by mutableStateOf(
            WorkbenchUiState(
                chatOpen = true,
                sessionId = "session-working-compose",
                connection = AgentConnectionStatus.Connected,
                runStatus = AgentRunStatus.Working,
                pendingTurn = sendingPendingTurn(),
                isLoading = true,
            ),
        )
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            is WorkbenchEvent.ComposerChanged -> {
                                state = state.copy(composerText = event.text)
                            }
                            WorkbenchEvent.SendMessage -> sendCount += 1
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_stop_generating)).assertIsDisplayed()
        composeRule.onNode(hasSetTextAction()).performTextInput("继续处理这个任务")
        composeRule.waitForIdle()

        composeRule.onAllNodesWithContentDescription(agentUiText(AgentUiR.string.agentui_stop_generating)).assertCountEquals(0)
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_send_message)).assertIsDisplayed().assertIsEnabled().performClick()
        assertTrue("A working composer follow-up must dispatch SendMessage", sendCount == 1)
    }

    @Test
    fun workingComposerWithAttachmentUsesSendWhilePreviousTurnIsPending() {
        var sends = 0
        composeRule.setContent {
            RagentTheme {
                AgentComposer(
                    value = "",
                    onValueChange = {},
                    onSend = { sends += 1 },
                    onStop = {},
                    working = true,
                    enabled = true,
                    attachmentsEnabled = true,
                    onAddAttachment = {},
                    hasAttachments = true,
                    pendingSend = true,
                )
            }
        }

        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_stop_generating)).assertDoesNotExist()
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_send_message)).performClick()
        assertTrue("An attachment should turn Stop into Send", sends == 1)
    }

    @Test
    fun projectCreationUsesDecisionSizedActions() {
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(
                        destination = AgentoDestination.Sessions,
                        projectDialogOpen = true,
                        projectName = "Customer exports",
                        projectRootPath = "C:/Work/customer-exports",
                        projects = listOf(Project("archive", "Archive", "C:/Work/archive")),
                    ),
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.project_create_title)).assertIsDisplayed()
        composeRule.onNodeWithText("Customer exports").assertIsDisplayed()
        composeRule.onNodeWithText("customer-exports").assertIsDisplayed()
        composeRule.onNodeWithText("C:/Work/customer-exports").assertDoesNotExist()
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.project_create)).assertIsDisplayed().assertHeightIsAtLeast(52.dp)
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.project_cancel)).assertIsDisplayed().assertHeightIsAtLeast(52.dp)

        composeRule.onNodeWithText("customer-exports").performClick()
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.project_location_title)).assertIsDisplayed()
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.project_recent_locations)).assertIsDisplayed()
        composeRule.onNodeWithText("archive").assertIsDisplayed()
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.project_choose_another_location)).assertIsDisplayed()
    }

    @Test
    fun systemBackClosesFullScreenChat() {
        var closed = false
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(chatOpen = true, sessionId = "session-1", sessionTitle = "Weekly report"),
                    onEvent = { event -> if (event == WorkbenchEvent.CloseChat) closed = true },
                )
            }
        }

        composeRule.runOnIdle {
            composeRule.activity.onBackPressedDispatcher.onBackPressed()
        }
        composeRule.runOnIdle {
            assertTrue("Android Back should emit CloseChat", closed)
        }
    }

    @Test
    fun enteringLongSessionStartsAtLatestTimelineItem() {
        val messages = (1..40).map { index ->
            TimelineItem.Message(
                id = "message-$index",
                seq = index.toLong(),
                role = TimelineRole.Agent,
                text = if (index == 40) "Latest timeline item" else "Earlier item $index",
                completed = true,
            )
        }
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    WorkbenchUiState(
                        chatOpen = true,
                        sessionId = "long-session",
                        connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
                        timelineItems = messages,
                    ),
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithText("Latest timeline item").assertIsDisplayed()
    }

    @Test
    fun projectListPreviewsTwoSessionsAndOpensProjectDetail() {
        var openedProjectId: String? = null
        val state = WorkbenchUiState(
            destination = AgentoDestination.Sessions,
            computers = ProjectsReferenceFixtures.computers,
            projects = ProjectsReferenceFixtures.projects,
            sessions = ProjectsReferenceFixtures.sessions,
            sessionId = "session-cleanup",
        )
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            is WorkbenchEvent.OpenProjectSessions -> openedProjectId = event.projectId
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithText("Operations").assertIsDisplayed()
        composeRule.onNodeWithText("Quarterly reports").assertIsDisplayed()
        composeRule.onNodeWithText("Clean up weekly exports").assertIsDisplayed()
        composeRule.onNodeWithText("Review the monthly export").assertIsDisplayed()
        composeRule.onNodeWithText("Archive completed files").assertDoesNotExist()
        composeRule.onNodeWithText("Prepare the quarterly report").assertIsDisplayed()

        composeRule.onNodeWithContentDescription("Open project: Operations").performClick()
        assertTrue("Opening project should emit OpenProjectSessions", openedProjectId == "project-operations")
    }

    @Test
    fun projectListRemainsCalmInDarkTheme() {
        val state = WorkbenchUiState(
            destination = AgentoDestination.Sessions,
            computers = ProjectsReferenceFixtures.computers,
            projects = ProjectsReferenceFixtures.projects,
            sessions = ProjectsReferenceFixtures.sessions,
            sessionId = "session-cleanup",
        )
        composeRule.setContent {
            RagentTheme(darkTheme = true) {
                WorkbenchScreen(state = state)
            }
        }

        composeRule.onNodeWithText("Operations").assertIsDisplayed()
        composeRule.onNodeWithText("Clean up weekly exports").assertIsDisplayed()
    }

    @Test
    fun verifySpeedometerEffortPickerAndGoalModeInChat() {
        var goalToggled: Boolean? = null
        val state = WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-test",
            composerText = "Draft",
            thinkingEffort = 0.6f,
            goalMode = true,
            goalText = "Build feature",
        )
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            is WorkbenchEvent.ToggleGoalMode -> goalToggled = event.enabled
                            WorkbenchEvent.OpenGoalDialog -> goalToggled = false
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithContentDescription("Goal: Build feature").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Goal: Build feature").performClick()
        assertTrue("Goal click should toggle goal mode", goalToggled == false)

        // A non-empty draft expands the composer, where its effort control is
        // available. 0.6 belongs to High under the shared server/UI effort
        // thresholds, not Standard (<= 0.55).
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).performClick()
        composeRule.onNodeWithContentDescription(
            agentUiText(AgentUiR.string.agentui_thinking_effort_control, agentUiText(AgentUiR.string.agentui_effort_high)),
        ).assertIsDisplayed()
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_send_message)).assertIsDisplayed()
    }

    @Test
    fun effortMenuCanSwitchFastResponseMode() {
        var selectedTier = "standard"
        var state by mutableStateOf(
            WorkbenchUiState(
                chatOpen = true,
                sessionId = "session-speed-toggle",
                runtimeTool = "codex",
                runtimeModel = "speed-model",
                runtimeCatalog = RuntimeCatalog(
                    tools = listOf(
                        RuntimeToolOption(
                            id = "codex",
                            label = "Codex",
                            models = listOf(
                                RuntimeModelOption(
                                    id = "speed-model",
                                    label = "Speed model",
                                    supportsFast = true,
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            WorkbenchEvent.OpenEffortPicker -> state = state.copy(effortPickerOpen = true)
                            WorkbenchEvent.CloseEffortPicker -> state = state.copy(effortPickerOpen = false)
                            is WorkbenchEvent.SelectServiceTier -> {
                                selectedTier = event.tier
                                state = state.copy(serviceTier = event.tier)
                            }
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).performClick()
        composeRule.onNodeWithContentDescription(
            agentUiText(AgentUiR.string.agentui_thinking_effort_control, agentUiText(AgentUiR.string.agentui_effort_standard)),
        ).performClick()
        composeRule.onNodeWithContentDescription(
            agentUiText(AgentUiR.string.agentui_response_speed, agentUiText(AgentUiR.string.agentui_speed_standard)),
        ).assertExists()
            .performClick()
        assertTrue("speed toggle should switch to fast mode", selectedTier == "fast")
        composeRule.onNodeWithContentDescription(
            agentUiText(AgentUiR.string.agentui_response_speed, agentUiText(AgentUiR.string.agentui_speed_fast)),
        ).assertIsDisplayed()
    }

    @Test
    fun verifyHomeKeepsDeviceManagementOutOfThePrimarySurface() {
        val state = WorkbenchUiState(destination = AgentoDestination.Home)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                )
            }
        }

        composeRule.onNodeWithContentDescription("Home").assertIsDisplayed()
        composeRule.onNodeWithText("Ragent").assertIsDisplayed()
        composeRule.onNodeWithText("Cross-device workspace").assertDoesNotExist()
        composeRule.onNodeWithText("连接电脑").assertDoesNotExist()
    }

    @Test
    fun verifyUserMessageAdaptiveWidthAndCollapsibleExpandableContent() {
        val longMessage = "This is a very long user prompt describing a complex multi-step refactoring task.\nLine 2 with extensive requirements.\nLine 3 describing architecture.\nLine 4 listing edge cases.\nLine 5 verifying error boundaries.\nLine 6 concluding with acceptance criteria."
        val state = WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-chat-expand",
            timelineItems = listOf(
                TimelineItem.Message(
                    id = "msg-short",
                    seq = 1,
                    role = TimelineRole.User,
                    text = "Short prompt",
                    completed = true,
                ),
                TimelineItem.Message(
                    id = "msg-long",
                    seq = 2,
                    role = TimelineRole.User,
                    text = longMessage,
                    completed = true,
                ),
            ),
        )
        composeRule.setContent { RagentTheme { WorkbenchScreen(state) } }

        composeRule.onNodeWithText("Short prompt").assertIsDisplayed()
        composeRule.onNodeWithText("展开").assertIsDisplayed()
        composeRule.onNodeWithText("展开").performClick()
        composeRule.onNodeWithText("收起").assertIsDisplayed()
    }

    @Test
    fun completedActivityCollapsesIntoLocalizedSummary() {
        val state = WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-activity-summary",
            timelineItems = listOf(
                TimelineItem.Message(
                    id = "request",
                    seq = 1,
                    role = TimelineRole.User,
                    text = "整理发票",
                    completed = true,
                ),
                TimelineItem.Operation(
                    id = "check",
                    seq = 2,
                    kind = TimelineOperationKind.Tool,
                    title = "检查发票文件",
                    detail = "找到 48 个文件",
                    status = TimelineOperationStatus.Completed,
                ),
                TimelineItem.Operation(
                    id = "sort",
                    seq = 3,
                    kind = TimelineOperationKind.FileEdit,
                    title = "按月份整理发票",
                    detail = "finance/archive/2026",
                    status = TimelineOperationStatus.Completed,
                ),
                TimelineItem.Operation(
                    id = "index",
                    seq = 4,
                    kind = TimelineOperationKind.Command,
                    title = "更新对账索引",
                    detail = "79 条记录已写入索引",
                    status = TimelineOperationStatus.Completed,
                ),
            ),
        )

        composeRule.setContent { RagentTheme { WorkbenchScreen(state) } }

        composeRule.onNodeWithText("更新对账索引").assertIsDisplayed()
        composeRule.onAllNodesWithText("检查发票文件").assertCountEquals(0)
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_expand)).assertIsDisplayed()
    }

    @Test
    fun activeRunKeepsStatusLocalizedInsteadOfShowingServerActionText() {
        val serverAction = "Using restructure plan"
        val state = WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-localized-status",
            runStatus = AgentRunStatus.Working,
            currentAction = RunActionUiState(kind = "tool", sentence = serverAction),
        )

        composeRule.setContent { RagentTheme { WorkbenchScreen(state) } }

        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.workbench_status_processing)).assertIsDisplayed()
        composeRule.onAllNodesWithText(serverAction).assertCountEquals(0)
    }

    @Test
    fun emptyComposerDoesNotExpandWhenItsDisabledSendAreaIsTapped() {
        val state = WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-compact-composer",
        )

        composeRule.setContent { RagentTheme { WorkbenchScreen(state) } }

        val composer = composeRule.onNodeWithTag("agent-composer")
        val composerBounds = composer.fetchSemanticsNode().boundsInRoot
        composeRule.onRoot().performTouchInput {
            click(
                Offset(
                    x = composerBounds.right - 24f,
                    y = (composerBounds.top + composerBounds.bottom) / 2f,
                ),
            )
        }
        composeRule.waitForIdle()
        val compactHeight = composer.fetchSemanticsNode().boundsInRoot.height
        assertTrue(
            "Disabled send tap expanded an empty composer: ${compactHeight}px",
            compactHeight <= 180f,
        )
    }

    @Test
    fun verifyEffortPickerSliderInteraction() {
        var effortChangedValue: Float? = null
        var effortClosed = false
        var state by mutableStateOf(WorkbenchUiState(
            chatOpen = true,
            sessionId = "session-effort",
            connection = com.andysagent.ragent.core.agentui.AgentConnectionStatus.Connected,
            timelineItems = pickerTranscript(),
            effortPickerOpen = true,
            thinkingEffort = 0.5f,
        ))
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = state,
                    onEvent = { event ->
                        when (event) {
                            is WorkbenchEvent.EffortChanged -> {
                                effortChangedValue = event.effort
                                state = state.copy(thinkingEffort = event.effort)
                            }
                            WorkbenchEvent.CloseEffortPicker -> {
                                effortClosed = true
                                state = state.copy(effortPickerOpen = false)
                            }
                            else -> Unit
                        }
                    },
                )
            }
        }

        composeRule.onNodeWithText(agentUiText(AgentUiR.string.agentui_thinking_effort)).assertIsDisplayed()
        // The redesigned popover surfaces the active level in its header and
        // again on the four-step scale, so both semantic text nodes must be
        // present rather than treating the duplicated label as ambiguity.
        composeRule.onAllNodesWithText(agentUiText(AgentUiR.string.agentui_effort_standard)).assertCountEquals(2)
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_thinking_effort_slider)).assertIsDisplayed()
        capturePickerScreen("composer-effort-screen")
        val effortBounds = composeRule.onNodeWithTag("composer-effort-picker").getUnclippedBoundsInRoot()
        // Includes the popup's 16dp outer margin above and below the surface.
        assertTrue(effortBounds.bottom - effortBounds.top <= 160.dp)
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_thinking_effort_slider))
            .performTouchInput {
                swipe(Offset(width / 3f, centerY), Offset(width * 0.95f, centerY), durationMillis = 600)
            }
        capturePickerScreen("composer-effort-after-swipe")
        composeRule.runOnIdle { assertTrue("Slider should reach Maximum; actual=$effortChangedValue", (effortChangedValue ?: 0f) > 0.85f) }

        val screenshot = composeRule.onNodeWithTag("composer-effort-picker").captureToImage().asAndroidBitmap()
        val output = File(
            InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
            "composer-effort-picker.png",
        )
        FileOutputStream(output).use { stream ->
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream))
        }
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("input keyevent 4").use {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(it).use { stream -> stream.readBytes() }
        }
        composeRule.waitUntil(5_000) { effortClosed }
        composeRule.onNodeWithTag("composer-effort-picker").assertDoesNotExist()
    }

    @Test
    fun effortLargeTextUsesReadableSingleChoiceRows() {
        var selected: Float? = null
        composeRule.setContent {
            val density = androidx.compose.ui.platform.LocalDensity.current
            androidx.compose.runtime.CompositionLocalProvider(
                androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(density.density, 1.6f),
            ) {
                RagentTheme {
                    WorkbenchScreen(
                        state = WorkbenchUiState(chatOpen = true, sessionId = "large-text", effortPickerOpen = true),
                        onEvent = { if (it is WorkbenchEvent.EffortChanged) selected = it.effort },
                    )
                }
            }
        }
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_thinking_effort_slider)).assertDoesNotExist()
        composeRule.onNodeWithText(agentUiText(AgentUiR.string.agentui_effort_maximum))
            .performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        composeRule.runOnIdle { assertEquals(1f, selected) }
        capturePickerScreen("effort-large-text")
    }

    @Test
    fun systemBackCollapsesRunCapsuleBeforeLeavingChat() = verifyCapsuleBack(MotionPreference.Full)

    @Test
    fun runCapsuleSupportsDisabledMotion() = verifyCapsuleBack(MotionPreference.None)

    @Test
    fun runCapsuleSupportsReducedMotion() = verifyCapsuleBack(MotionPreference.Reduced)

    @Test
    fun runCapsuleCollapseHasIntermediateBoundsAndFinishesWithItsForeground() {
        composeRule.setContent {
            RagentTheme(motionPreference = MotionPreference.Full) {
                WorkbenchScreen(
                    state = WorkbenchUiState(chatOpen = true, sessionId = "morph", sessionTitle = "Morph test"),
                    onEvent = {},
                )
            }
        }
        fun shellBounds() = composeRule.onNodeWithTag("run-island-shell").getUnclippedBoundsInRoot().let {
            (it.right - it.left) to (it.bottom - it.top)
        }
        val collapsed = shellBounds()
        composeRule.onNodeWithText("Morph test").performClick()
        composeRule.onNodeWithContentDescription(workbenchText(WorkbenchR.string.workbench_session_run_details)).performClick()
        val expanded = shellBounds()
        assertTrue(expanded.second > collapsed.second)
        composeRule.mainClock.autoAdvance = false
        composeRule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        composeRule.mainClock.advanceTimeByFrame()
        composeRule.mainClock.advanceTimeBy(80)
        val early = shellBounds()
        composeRule.mainClock.advanceTimeBy(80)
        val middle = shellBounds()
        assertTrue("Collapse must contain actual intermediate geometry", early.second < expanded.second && early.second > collapsed.second)
        assertTrue("Bounds must continue shrinking", middle.second < early.second && middle.second > collapsed.second)
        composeRule.mainClock.advanceTimeBy(200)
        val finished = shellBounds()
        assertTrue("No spring tail after the foreground hand-off", kotlin.math.abs(finished.second.value - collapsed.second.value) < 1f)
        assertTrue(kotlin.math.abs(finished.first.value - collapsed.first.value) < 1f)
        composeRule.mainClock.autoAdvance = true
        composeRule.onNodeWithText("Morph test").assertIsDisplayed()
        // Reverse an in-flight collapse, not just two settled endpoints.
        composeRule.onNodeWithText("Morph test").performClick()
        composeRule.mainClock.autoAdvance = false
        composeRule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        composeRule.mainClock.advanceTimeBy(80)
        composeRule.onNodeWithText("Morph test").performClick()
        composeRule.mainClock.advanceTimeBy(400)
        composeRule.mainClock.autoAdvance = true
        composeRule.onNodeWithContentDescription(workbenchText(WorkbenchR.string.workbench_session_run_details)).assertIsDisplayed()
    }

    @Test
    fun collapsingRunIslandDoesNotLeakTouchesToStopAction() {
        var cancelled = 0
        composeRule.setContent {
            RagentTheme(motionPreference = MotionPreference.Full) {
                WorkbenchScreen(
                    state = WorkbenchUiState(chatOpen = true, sessionId = "barrier",
                        sessionTitle = "Barrier test", runStatus = AgentRunStatus.Working,
                        connection = AgentConnectionStatus.Connected),
                    onEvent = { if (it == WorkbenchEvent.CancelRun) cancelled++ },
                )
            }
        }
        val stop = composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_stop_generating))
        val stopCenter = stop.fetchSemanticsNode().boundsInRoot.center
        composeRule.onNodeWithText("Barrier test").performClick()
        composeRule.onRoot().performTouchInput { click(stopCenter) }
        composeRule.runOnIdle { assertEquals("Expanded island leaked a Stop action", 0, cancelled) }
        composeRule.onNodeWithText("Barrier test").performClick()
        composeRule.mainClock.autoAdvance = false
        composeRule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        composeRule.mainClock.advanceTimeBy(80)
        // Real pointer dispatch through the still-closing overlay, not a
        // semantics onClick that intentionally bypasses hit testing.
        composeRule.onRoot().performTouchInput { click(stopCenter) }
        composeRule.runOnIdle { assertEquals("Closing island leaked a Stop action", 0, cancelled) }
        composeRule.mainClock.advanceTimeBy(400)
        composeRule.mainClock.autoAdvance = true
        stop.performTouchInput { click() }
        composeRule.runOnIdle { assertEquals("Barrier must release after close", 1, cancelled) }
    }

    private fun verifyCapsuleBack(motion: MotionPreference) {
        var closedChat = false
        composeRule.setContent {
            RagentTheme(motionPreference = motion) {
                WorkbenchScreen(
                    state = WorkbenchUiState(chatOpen = true, sessionId = "capsule", sessionTitle = "Capsule test"),
                    onEvent = { if (it == WorkbenchEvent.CloseChat) closedChat = true },
                )
            }
        }
        composeRule.onNodeWithText("Capsule test").performClick()
        composeRule.onNodeWithContentDescription(workbenchText(WorkbenchR.string.workbench_session_run_details)).assertIsDisplayed()
        composeRule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(workbenchText(WorkbenchR.string.workbench_session_run_details)).assertDoesNotExist()
        composeRule.onNodeWithText("Capsule test").assertIsDisplayed()
        composeRule.runOnIdle { assertTrue(!closedChat) }
    }

    private fun sendingPendingTurn() = PendingTurnUiState(
        requestId = "pending-turn",
        text = "Prepare the report",
        attachments = emptyList(),
        selection = RuntimeSelection(tool = "codex"),
        agentId = null,
        state = PendingTurnState.Sending,
    )
}
