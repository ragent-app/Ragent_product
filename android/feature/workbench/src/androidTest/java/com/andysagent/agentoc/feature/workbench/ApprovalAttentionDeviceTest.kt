package com.andysagent.agentoc.feature.workbench

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.core.view.WindowInsetsCompat
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalAction
import com.andysagent.agentoc.core.model.ApprovalExplanation
import com.andysagent.agentoc.core.model.ApprovalOption
import com.andysagent.agentoc.core.model.ApprovalQuestion
import com.andysagent.agentoc.core.model.AttentionReducer
import com.andysagent.agentoc.core.model.AttentionUiState
import com.andysagent.agentoc.core.model.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ApprovalAttentionDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun ordinaryApprovalOffersBothDecisions() {
        val approval = Approval(id = "a", sessionId = "s", runId = "r", title = "Run command", command = "echo test",
            permissionsJson = """{"network":{"enabled":true}}""")
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        val approve = rule.activity.getString(R.string.attention_approve)
        val deny = rule.activity.getString(R.string.attention_deny)
        rule.onNodeWithText(rule.activity.getString(R.string.attention_command, "echo test")).assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(R.string.approval_scope_network)).assertIsDisplayed()
        rule.onNodeWithText(approve).assertIsDisplayed().performClick()
        rule.onNodeWithText(deny).assertIsDisplayed().performClick()
        rule.runOnIdle {
            val id = requireNotNull(state.activeItemId)
            assertEquals(listOf(AttentionEvent.ResolveApproval(id, true), AttentionEvent.ResolveApproval(id, false)), events)
        }
    }

    @Test fun explanationAppearsAlongsideApprovalControls() {
        val approval = Approval(id = "a", sessionId = "s", runId = "r", title = "Bash", command = "rm example",
            explanation = ApprovalExplanation("Removes example", "Deletion is permanent", "Review first"))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        rule.setContent { AgentocTheme { AttentionSurface(state, onEvent = {}, onOpenSession = {}) } }
        rule.onNodeWithTag("attention-headline").assertIsDisplayed()
        rule.onNodeWithText("Review first").assertExists()
        rule.onNodeWithText(rule.activity.getString(R.string.attention_command, "rm example")).assertExists()
        rule.onNodeWithText(rule.activity.getString(R.string.attention_approve)).assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(R.string.attention_deny)).assertIsDisplayed()
    }

    @Test fun structuredExplanationIsLocalizedAndNotRepeated() {
        val approval = Approval(id = "a", sessionId = "s", runId = "r", title = "Bash", command = "if true; then rm example; fi",
            reason = "Read example", explanation = ApprovalExplanation(summary = "旧摘要", reason = "旧原因", operation = "delete",
                targets = listOf("example"), conditional = true, partial = true, riskCode = "composite_unanalyzed", providerConflict = true))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        rule.setContent { AgentocTheme { AttentionSurface(state, onEvent = {}, onOpenSession = {}) } }
        val action = rule.activity.getString(R.string.approval_operation_delete)
        val summary = rule.activity.getString(R.string.approval_operation_may, if (rule.activity.resources.configuration.locales[0]?.language == "en") action.replaceFirstChar { it.lowercase() } else action) + ": example"
        rule.onAllNodesWithText(summary).assertCountEquals(1)
        assertTrue(rule.onAllNodesWithText(rule.activity.getString(R.string.approval_provider_conflict), substring = true).fetchSemanticsNodes().isNotEmpty())
        rule.onNodeWithText(rule.activity.getString(R.string.approval_provider_description, "Read example")).assertExists()
        rule.onNodeWithText(rule.activity.getString(R.string.attention_approve)).assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(R.string.attention_deny)).assertIsDisplayed()
    }

    @Test fun structuredOperationWithoutRiskCodeStillShowsTargetInHeadline() {
        val approval = Approval(id = "no-code", sessionId = "s", runId = "r", title = "Bash",
            command = "if true; then rm example; fi", explanation = ApprovalExplanation(
                operation = "delete", targets = listOf("example"), conditional = true))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        rule.setContent { AgentocTheme { AttentionSurface(state, onEvent = {}, onOpenSession = {}) } }
        rule.onNodeWithTag("attention-headline").assert(androidx.compose.ui.test.hasText("example", substring = true))
    }

    @Test fun legacyProviderHeadlineDoesNotRepeatInExpandedDetails() {
        val approval = Approval(id = "legacy", sessionId = "s", runId = "r", title = "Bash", reason = "Remove example",
            command = "if true; then rm example; fi", explanation = ApprovalExplanation(
                reason = "命令串联了多个步骤，部分行为无法静态确认", saferAlternative = "拆成单条命令逐步确认后再执行"))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        rule.setContent { AgentocTheme { AttentionSurface(state, onEvent = {}, onOpenSession = {}) } }
        rule.onAllNodesWithText("Remove example").assertCountEquals(1)
        rule.onAllNodesWithText(rule.activity.getString(R.string.approval_operation_run)).assertCountEquals(0)
    }

    @Test fun batchShowsEachActionsExplanation() {
        val approval = Approval(id = "batch", sessionId = "s", runId = "r", batchId = "batch", title = "Batch", kind = "privileged_batch_request",
            actions = listOf(
                ApprovalAction("one", description = "First", category = "privileged_other", command = "rm example",
                    explanation = ApprovalExplanation(operation = "delete", targets = listOf("example"), riskCode = "delete_unresolvable")),
                ApprovalAction("two", description = "Second", category = "privileged_other", command = "rm other",
                    explanation = ApprovalExplanation(operation = "delete", targets = listOf("other"), riskCode = "delete_unresolvable")),
            ))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        rule.setContent { AgentocTheme { AttentionSurface(state, onEvent = {}, onOpenSession = {}) } }
        val action = rule.activity.getString(R.string.approval_operation_delete)
        rule.onNodeWithText("$action: example").assertExists()
        rule.onNodeWithText("$action: other").assertExists()
    }

    @Test fun firstQuestionOptionExpandsBeforeItAnswers() {
        val approval = Approval(id = "q", sessionId = "s", runId = "r", title = "Choose",
            questions = listOf(ApprovalQuestion(question = "Choose a release", options = listOf(ApprovalOption("Canary"), ApprovalOption("Full")))))
        var state by mutableStateOf(AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))))
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, onEvent = { event ->
            events.add(event)
            if (event is AttentionEvent.SetExpanded) state = state.copy(expanded = event.expanded)
        }, onOpenSession = {}) } }
        rule.onNodeWithText("Canary").assertIsDisplayed().performClick()
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(listOf(AttentionEvent.SetExpanded(requireNotNull(state.activeItemId), true)), events) }
        rule.onNodeWithText("Canary").performClick()
        rule.runOnIdle { assertEquals(AttentionEvent.ResolveQuestion(requireNotNull(state.activeItemId), 0, 0), events.last()) }
    }

    @Test fun multipleQuestionsAcceptDistinctCustomAnswers() {
        val approval = Approval(id = "multi", sessionId = "s", runId = "r", title = "Questions",
            questions = listOf(ApprovalQuestion(question = "First question"), ApprovalQuestion(question = "Second question")))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        rule.onNode(hasSetTextAction() and hasAnyAncestor(hasContentDescription("问题 1 的自定义回复")), useUnmergedTree = true).performTextInput("alpha")
        rule.onNode(hasSetTextAction() and hasAnyAncestor(hasContentDescription("问题 2 的自定义回复")), useUnmergedTree = true).performTextInput("beta")
        rule.onNodeWithText("发送").performClick()
        rule.runOnIdle {
            val answer = events.filterIsInstance<AttentionEvent.ResolveQuestions>().single()
            assertEquals(listOf(-1, -1), answer.choices)
            assertEquals(listOf("alpha", "beta"), answer.customAnswers)
        }
    }

    @Test fun singleQuestionCustomAnswerHasVisibleSendButton() {
        val approval = Approval(id = "custom", sessionId = "s", runId = "r", title = "Choose",
            questions = listOf(ApprovalQuestion(question = "Choose a shape", options = listOf(ApprovalOption("Circle")))))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        rule.onNode(hasSetTextAction(), useUnmergedTree = true).performTextInput("triangle")
        rule.onNodeWithText("发送").assertIsDisplayed().performClick()
        rule.runOnIdle {
            assertEquals(AttentionEvent.ResolveQuestion(requireNotNull(state.activeItemId), 0, null, "triangle"),
                events.filterIsInstance<AttentionEvent.ResolveQuestion>().single())
        }
    }

    @Test fun multiSelectQuestionSendsAllSelectedOptionsAndCustomText() {
        val approval = Approval(id = "q", sessionId = "s", runId = "r", title = "Choose",
            questions = listOf(ApprovalQuestion(question = "Choose features", isMultiSelect = true,
                options = listOf(ApprovalOption("Feature A"), ApprovalOption("Feature B")))))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        rule.onNodeWithText("Feature A").performClick()
        rule.onNodeWithContentDescription("以此选项回答：Feature A").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "已选择"))
        rule.onNodeWithText("Feature B").performClick()
        rule.onNodeWithContentDescription("以此选项回答：Feature B").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "已选择"))
        rule.onNode(hasSetTextAction() and hasAnyAncestor(hasContentDescription("问题 1 的自定义回复")), useUnmergedTree = true).performTextInput("extra")
        val submitBounds = rule.onNodeWithText("发送").assertIsEnabled().fetchSemanticsNode().boundsInWindow
        var layoutDiagnostic = ""
        rule.runOnIdle {
            val decor = rule.activity.window.decorView
            val insets = decor.rootWindowInsets?.let { WindowInsetsCompat.toWindowInsetsCompat(it, decor) }
            val imeBottom = insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
            layoutDiagnostic = "submit bottom=${submitBounds.bottom}, windowHeight=${decor.height}, imeBottom=$imeBottom"
            if (imeBottom > 0) assertTrue(layoutDiagnostic, submitBounds.bottom <= decor.height - imeBottom)
        }
        rule.onNodeWithText("发送").performClick()
        rule.runOnIdle {
            assertEquals("Events: $events; $layoutDiagnostic", 1, events.filterIsInstance<AttentionEvent.ResolveMultiChoices>().size)
            val answer = events.filterIsInstance<AttentionEvent.ResolveMultiChoices>().single()
            assertEquals(listOf(listOf(0, 1)), answer.selections)
            assertEquals(listOf("extra"), answer.customAnswers)
        }
    }

    @Test fun closingNoticeDoesNotMakeAnApprovalDecision() {
        val approval = Approval(id = "a", sessionId = "s", runId = "r", title = "Run command")
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval)))
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        rule.onNodeWithContentDescription(rule.activity.getString(R.string.approval_notice_close)).performClick()
        rule.runOnIdle { assertEquals(listOf(AttentionEvent.Dismiss(requireNotNull(state.activeItemId))), events) }
    }

    @Test fun pendingApprovalRemainsVisibleUntilDismissedOrResolved() {
        val approval = Approval(id = "a", sessionId = "s", runId = "r", title = "Run command")
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval)))
        val events = mutableListOf<AttentionEvent>()
        rule.mainClock.autoAdvance = false
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        rule.mainClock.advanceTimeBy(12_500)
        rule.runOnIdle { assertTrue(events.none { it is AttentionEvent.Dismiss }) }
        rule.mainClock.autoAdvance = true
    }

    @Test fun conversationShowsAndSubmitsAllQuestionAnswers() {
        var state by mutableStateOf(DecisionQuestionUiState(id = "q", question = "First", options = emptyList(),
            questionGroups = listOf(ApprovalQuestion(question = "First"), ApprovalQuestion(question = "Second"))))
        var submitted: Map<Int, String>? = null
        rule.setContent { AgentocTheme { DecisionQuestionCard(
            state = state, onOptionSelected = {}, onWriteInChanged = {}, onSubmit = { submitted = state.customByQuestion },
            onMultiWriteInChanged = { index, text -> state = state.copy(customByQuestion = state.customByQuestion + (index to text)) },
        ) } }
        rule.onNodeWithTag("decision-0-write-in").performTextInput("alpha")
        rule.onNodeWithTag("decision-1-write-in").performTextInput("beta")
        rule.onNodeWithTag("decision-submit").performClick()
        rule.runOnIdle { assertEquals(mapOf(0 to "alpha", 1 to "beta"), submitted) }
    }

    @Test fun conversationMultiSelectKeepsBothOptionsAndExtraText() {
        val question = ApprovalQuestion(question = "Features", isMultiSelect = true,
            options = listOf(ApprovalOption("Feature A"), ApprovalOption("Feature B")))
        var state by mutableStateOf(DecisionQuestionUiState(id = "q", question = "Features", options = listOf("Feature A", "Feature B"),
            questionGroups = listOf(question)))
        var submitted: DecisionQuestionUiState? = null
        rule.setContent { AgentocTheme { DecisionQuestionCard(state = state, onOptionSelected = {}, onWriteInChanged = {},
            onSubmit = { submitted = state }, onMultiOptionSelected = { index, option ->
                state = state.copy(multiSelectedByQuestion = state.multiSelectedByQuestion + (index to (state.multiSelectedByQuestion[index].orEmpty() + option)))
            }, onMultiWriteInChanged = { index, text -> state = state.copy(customByQuestion = state.customByQuestion + (index to text)) }) } }
        rule.onNodeWithTag("decision-0-option-0").performClick()
        rule.onNodeWithTag("decision-0-option-1").performClick()
        rule.onNodeWithTag("decision-0-write-in").performTextInput("extra")
        rule.runOnIdle {
            assertEquals(setOf(0, 1), state.multiSelectedByQuestion[0])
            assertEquals("extra", state.customByQuestion[0])
        }
        rule.onNodeWithTag("decision-submit").assertIsEnabled().performClick()
        rule.runOnIdle {
            assertEquals(setOf(0, 1), submitted?.multiSelectedByQuestion?.get(0))
            assertEquals("extra", submitted?.customByQuestion?.get(0))
        }
    }

    @Test fun privilegedCategoriesKeepDeleteOptInAndUseSeparateActions() {
        val approval = Approval(id = "b", sessionId = "s", runId = "r", batchId = "b", title = "Batch",
            kind = "privileged_batch_request", passkeyRequired = true, actions = listOf(
                ApprovalAction(id = "o", description = "Restart", category = "privileged_other"),
                ApprovalAction(id = "d", description = "Delete", category = "destructive_delete"),
            ))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        val approve = rule.onAllNodesWithText(rule.activity.getString(R.string.attention_approve_selected))
        approve[0].assertIsEnabled().performClick()
        approve[1].assertIsNotEnabled()
        val deny = rule.onAllNodesWithText(rule.activity.getString(R.string.attention_deny))
        deny[1].performClick()
        rule.runOnIdle {
            val id = requireNotNull(state.activeItemId)
            assertEquals(listOf(AttentionEvent.ResolvePrivilegedCategory(id, "privileged_other", setOf("o")),
                AttentionEvent.ResolvePrivilegedCategory(id, "destructive_delete", emptySet())), events)
        }
    }

    @Test fun passkeyActionBatchCanBeApprovedFromNotification() {
        val approval = Approval(id = "b", sessionId = "s", runId = "r", batchId = "b", title = "Batch",
            kind = "approved_action_batch_request", actions = listOf(ApprovalAction(id = "a", description = "Restart", needsPasskey = true)))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        rule.onNodeWithText(rule.activity.getString(R.string.attention_approve_selected)).assertIsEnabled().performClick()
        rule.runOnIdle { assertEquals(listOf(AttentionEvent.ResolveActionBatch(requireNotNull(state.activeItemId), setOf("a"))), events) }
    }

    @Test fun privilegedCategoriesHonorServerDefaultSelection() {
        val approval = Approval(id = "b", sessionId = "s", runId = "r", batchId = "b", title = "Batch",
            kind = "privileged_batch_request", passkeyRequired = true, actions = listOf(
                ApprovalAction(id = "o", description = "Restart", category = "privileged_other"),
                ApprovalAction(id = "d", description = "Delete", category = "destructive_delete"),
            ), defaultSelectedByCategory = mapOf("privileged_other" to emptySet(), "destructive_delete" to setOf("d")))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(listOf(Session("s", "Other session")), listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { AgentocTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        val approve = rule.onAllNodesWithText(rule.activity.getString(R.string.attention_approve_selected))
        approve[0].assertIsNotEnabled()
        approve[1].assertIsEnabled().performClick()
        rule.runOnIdle {
            assertEquals(listOf(AttentionEvent.ResolvePrivilegedCategory(requireNotNull(state.activeItemId), "destructive_delete", setOf("d"))), events)
        }
    }
}
