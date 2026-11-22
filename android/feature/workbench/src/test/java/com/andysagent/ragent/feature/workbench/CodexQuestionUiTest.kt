package com.andysagent.ragent.feature.workbench

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.ApprovalOption
import com.andysagent.ragent.core.model.ApprovalQuestion
import com.andysagent.ragent.core.model.AsyncQuestion
import com.andysagent.ragent.core.model.AsyncQuestionReply
import com.andysagent.ragent.core.model.AttentionReducer
import com.andysagent.ragent.core.model.AttentionUiState
import com.andysagent.ragent.core.model.ElicitationPayload
import com.andysagent.ragent.core.model.ElicitationSchemaProperty
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w360dp-h800dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CodexQuestionUiTest {
    @get:Rule val rule = createComposeRule()

    private fun str(resId: Int): String = ApplicationProvider.getApplicationContext<Context>().getString(resId)

    @Test
    fun decisionQuestionCard_respectsHeaderDescriptionsIsOtherIsSecretAndSkip() {
        var skipped = false
        val state = DecisionQuestionUiState(
            id = "q-single",
            question = "Provide API token",
            options = listOf("Use vault"),
            header = "Credentials",
            questionOptions = listOf(ApprovalOption("Use vault", "vault", "Reads secret from vault")),
            isOther = true,
            isSecret = true,
            isBlocking = false,
        )
        rule.setContent {
            RagentTheme {
                DecisionQuestionCard(
                    state = state,
                    onOptionSelected = {},
                    onWriteInChanged = {},
                    onSubmit = {},
                    onSkip = { skipped = true },
                )
            }
        }
        rule.onNodeWithText("Credentials").assertIsDisplayed()
        rule.onNodeWithText(str(R.string.decision_optional_nonblocking)).assertIsDisplayed()
        rule.onNodeWithText("Reads secret from vault").assertIsDisplayed()
        rule.onNodeWithTag("decision-write-in").assertIsDisplayed()
        rule.onNodeWithTag("decision-write-in-secret-toggle").assertIsDisplayed().performClick()
        rule.onNodeWithTag("decision-skip").assertIsDisplayed().performClick()
        rule.runOnIdle { assertTrue(skipped) }
    }

    @Test
    fun decisionQuestionCard_hidesWriteInWhenNotIsOtherAndMultiCardCollapsesWhenSubmitted() {
        val singleNoOther = DecisionQuestionUiState(
            id = "q-no-other",
            question = "Pick tier",
            options = listOf("Fast", "Accurate"),
            questionOptions = listOf(ApprovalOption("Fast"), ApprovalOption("Accurate")),
            isOther = false,
        )
        rule.setContent {
            RagentTheme {
                DecisionQuestionCard(
                    state = singleNoOther,
                    onOptionSelected = {},
                    onWriteInChanged = {},
                    onSubmit = {},
                )
            }
        }
        rule.onNodeWithTag("decision-write-in").assertDoesNotExist()
    }

    @Test
    fun multiDecisionQuestionCard_collapsesToRedactedSubmittedConfirmation() {
        val multiSubmitted = DecisionQuestionUiState(
            id = "q-multi",
            question = "Multi",
            options = emptyList(),
            isSubmitted = true,
            isSecret = true,
            questionGroups = listOf(
                ApprovalQuestion(id = "a", question = "First?", options = listOf(ApprovalOption("A"))),
                ApprovalQuestion(id = "b", question = "Second secret?", isSecret = true),
            ),
        )
        rule.setContent {
            RagentTheme {
                DecisionQuestionCard(
                    state = multiSubmitted,
                    onOptionSelected = {},
                    onWriteInChanged = {},
                    onSubmit = {},
                )
            }
        }
        rule.onNodeWithText(str(R.string.decision_submitted_redacted)).assertIsDisplayed()
        rule.onNodeWithText("First?").assertDoesNotExist()
        rule.onNodeWithTag("decision-submit").assertDoesNotExist()
    }

    @Test
    fun attentionSurface_doesNotAutoSubmitSingleIsOtherAndRendersSkipAndSecretInput() {
        val approval = Approval(
            id = "q-attn",
            sessionId = "s-attn",
            title = "Deploy Check",
            status = "pending",
            kind = "question",
            runId = "r-1",
            isBlocking = false,
            questions = listOf(
                ApprovalQuestion(
                    id = "qi-1",
                    header = "Environment",
                    question = "Which target?",
                    options = listOf(ApprovalOption("Staging"), ApprovalOption("Prod")),
                    isOther = true,
                    isSecret = true,
                ),
            ),
        )
        val state = AttentionReducer.reduce(
            AttentionUiState(),
            AttentionReducer.project(listOf(Session("s-attn", "Deploy", status = SessionStatus.Working)), listOf(approval)),
        ).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { RagentTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }

        rule.onNodeWithText("Environment").assertIsDisplayed()
        rule.onNodeWithTag("attention-question-0-secret-input").assertIsDisplayed()
        // Tapping option 1 keeps selection local instead of immediately firing ResolveQuestion.
        rule.onNodeWithText("Staging").performClick()
        rule.runOnIdle { assertTrue(events.none { it is AttentionEvent.ResolveQuestion }) }
        rule.onNodeWithText("发送").performClick()
        rule.runOnIdle {
            assertEquals(AttentionEvent.ResolveQuestion(state.activeItemId!!, 0, 0, ""), events.single())
        }
        rule.onNodeWithTag("attention-skip").assertIsDisplayed().performClick()
        rule.runOnIdle {
            assertEquals(AttentionEvent.SkipQuestion(state.activeItemId!!), events.last())
        }
    }

    @Test
    fun asyncQuestionsCard_submitsRepliesAndRedactsAnsweredSecrets() {
        var submittedReplies: List<AsyncQuestionReply> = emptyList()
        val pending = listOf(
            AsyncQuestion(
                id = "aq-1",
                index = 0,
                title = "Region",
                question = "Target region?",
                options = listOf(ApprovalOption("us-east-1", "us-east-1")),
                isSecret = false,
            ),
        )
        rule.setContent {
            RagentTheme {
                AsyncQuestionsCardContent(
                    questions = pending,
                    submittingIds = emptySet(),
                    onSubmitReplies = { replies, _ -> submittedReplies = replies },
                )
            }
        }
        rule.onNodeWithTag("async-questions-send").assertIsNotEnabled()
        rule.onNodeWithTag("async-q-0-opt-0").performClick()
        rule.onNodeWithTag("async-questions-send").assertIsEnabled().performClick()
        rule.runOnIdle {
            assertEquals("aq-1", submittedReplies.single().questionItemId)
            assertEquals("us-east-1", submittedReplies.single().answer)
        }
    }

    @Test
    fun asyncQuestionsCard_answeredSecretRedactsPlaintextAndCollapses() {
        val answered = listOf(
            AsyncQuestion(
                id = "aq-sec",
                index = 0,
                title = "Token",
                question = "API Key?",
                status = "answered",
                answeredText = "super-secret-value",
                isSecret = true,
            ),
        )
        rule.setContent {
            RagentTheme {
                AsyncQuestionsCardContent(
                    questions = answered,
                    submittingIds = emptySet(),
                    onSubmitReplies = { _, _ -> },
                )
            }
        }
        rule.onNodeWithTag("async-question-answered-chip").assertIsDisplayed()
        rule.onNodeWithText("super-secret-value", substring = true).assertDoesNotExist()
        rule.onNodeWithText("••••••", substring = true).assertIsDisplayed()
    }

    @Test
    fun elicitationUi_validatesDynamicFormEnforcesSafeUrlAndDisablesAcceptWhenUnsupported() {
        val formPayload = ElicitationPayload(
            mode = "form",
            serverName = "github",
            message = "Enter credentials",
            schemaProperties = listOf(
                ElicitationSchemaProperty(name = "apiKey", title = "API Key", format = "password", minLength = 4, required = true),
            ),
        )
        var submittedAction: Pair<String, String?>? = null
        rule.setContent {
            RagentTheme {
                Column {
                    val formState = rememberElicitationFormState(formPayload)
                    ElicitationContent(formPayload, formState, resolving = false)
                    ElicitationActionBar(
                        elicitation = formPayload,
                        formState = formState,
                        resolving = false,
                        onSubmitAction = { action, content ->
                            submittedAction = action to content
                        },
                    )
                }
            }
        }
        rule.onNodeWithTag("elicitation-accept").assertIsNotEnabled()
        rule.onNodeWithTag("elicitation-field-apiKey").performTextInput("tok-999")
        rule.onNodeWithTag("elicitation-accept").assertIsEnabled().performClick()
        rule.runOnIdle {
            assertEquals("accept", submittedAction?.first)
            assertEquals("""{"apiKey":"tok-999"}""", submittedAction?.second)
        }
    }

    @Test
    fun elicitationUi_unsafeJavascriptUrlAndUnsupportedModeBlockAccept() {
        val badUrlPayload = ElicitationPayload(mode = "url", url = "javascript:alert(1)", message = "Bad link")
        rule.setContent {
            RagentTheme {
                Column {
                    val formState = rememberElicitationFormState(badUrlPayload)
                    ElicitationContent(badUrlPayload, formState, resolving = false)
                    ElicitationActionBar(
                        elicitation = badUrlPayload,
                        formState = formState,
                        resolving = false,
                        onSubmitAction = { _, _ -> },
                    )
                }
            }
        }
        rule.onNodeWithTag("elicitation-open-link").assertDoesNotExist()
        rule.onNodeWithTag("elicitation-accept").assertIsNotEnabled()
    }

    @Test
    fun elicitationUi_unsupportedModeHidesAcceptAndAllowsCancel() {
        val unsupported = ElicitationPayload(mode = "openai/userVerification", message = "Verify on desktop")
        var canceled: String? = null
        rule.setContent {
            RagentTheme {
                Column {
                    val formState = rememberElicitationFormState(unsupported)
                    ElicitationContent(unsupported, formState, resolving = false)
                    ElicitationActionBar(
                        elicitation = unsupported,
                        formState = formState,
                        resolving = false,
                        onSubmitAction = { action, _ ->
                            canceled = action
                        },
                    )
                }
            }
        }
        rule.onNodeWithTag("elicitation-unsupported-banner").assertIsDisplayed()
        rule.onNodeWithTag("elicitation-accept").assertDoesNotExist()
        rule.onNodeWithTag("elicitation-decline").assertIsDisplayed()
        rule.onNodeWithTag("elicitation-cancel").assertIsDisplayed().performClick()
        rule.runOnIdle { assertEquals("cancel", canceled) }
    }
}
