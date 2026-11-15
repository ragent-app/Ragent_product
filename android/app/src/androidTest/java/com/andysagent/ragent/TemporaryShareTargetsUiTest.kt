package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.appapi.TemporaryShareScreen
import com.andysagent.ragent.feature.appapi.TemporaryShareTarget
import com.andysagent.ragent.feature.appapi.TemporaryShareRuntime
import com.andysagent.ragent.feature.appapi.TemporaryShareUiState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TemporaryShareTargetsUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun multipleComputersAndRuntimeReadinessRequireExplicitSelection() {
        var state by mutableStateOf(TemporaryShareUiState(
            targets = listOf(
                TemporaryShareTarget("pc-a", "Computer A", "10:30", ready = true),
                TemporaryShareTarget("pc-b", "Computer B", "10:31", ready = true),
            ),
            runtimes = listOf(
                TemporaryShareRuntime("codex", "CodeX", ready = false),
                TemporaryShareRuntime("claude-bidi", "Claude Code", ready = true),
            ),
            sharedText = "A shared note",
            instruction = "Summarize this",
        ))
        val selections = mutableListOf<String>()
        compose.setContent {
            RagentTheme {
                TemporaryShareScreen(state,
                    onInstruction = { state = state.copy(instruction = it) },
                    onSelectTarget = { id ->
                        selections += id
                        state = state.copy(selectedInstanceId = id, ready = true)
                    },
                    onSelectRuntime = { id -> state = state.copy(selectedRuntimeId = id) },
                    onSubmit = {}, onCheckResult = {}, onCancel = {}, onClose = {}, onOpenApp = {})
            }
        }

        compose.onNodeWithText("Computer A").assertIsDisplayed()
        compose.onNodeWithText("Computer B").assertIsDisplayed()
        compose.onNodeWithTag("temporary-share-submit").assertIsNotEnabled()
        compose.onNodeWithTag("temporary-target-pc-b").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(listOf("pc-b"), selections)
        compose.onNodeWithTag("temporary-share-submit").assertIsNotEnabled()
        compose.onNodeWithTag("temporary-runtime-codex").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("temporary-runtime-claude-bidi").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("temporary-share-submit").assertIsEnabled()
    }

    @Test fun attachmentProgressShowsBytePercentAndOffersCancellation() {
        var cancelled = false
        compose.setContent {
            RagentTheme {
                TemporaryShareScreen(TemporaryShareUiState(
                    targets = listOf(TemporaryShareTarget("pc-a", "Computer A", "10:30", ready = true)),
                    selectedInstanceId = "pc-a", sharedText = "A shared note", filesPresent = true,
                    instruction = "Review", ready = true, busy = true, cancellable = true,
                    transferFileName = "notes.txt", transferProgress = .5f),
                    onInstruction = {}, onSelectTarget = {}, onSubmit = {}, onCheckResult = {},
                    onSelectRuntime = {},
                    onCancel = { cancelled = true }, onClose = {}, onOpenApp = {})
            }
        }

        compose.onNodeWithTag("temporary-share-progress").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("temporary-share-progress-label")
            .assertTextContains("notes.txt", substring = true).assertTextContains("50%", substring = true)
        compose.onNode(SemanticsMatcher.expectValue(SemanticsProperties.ProgressBarRangeInfo,
            ProgressBarRangeInfo(.5f, 0f..1f))).assertIsDisplayed()
        compose.onNodeWithTag("temporary-share-cancel").performScrollTo().performClick()
        assertEquals(true, cancelled)
    }
}
