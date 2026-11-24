package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.timeline.RunActionFormatter
import com.andysagent.ragent.core.timeline.RunActionUiState
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineOperationKind
import com.andysagent.ragent.core.timeline.TimelineOperationStatus
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "ko-w320dp-h720dp")
class RunActionKoreanLocalizationTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun activeAndGroupedExploringActionsAreLocalizedInKorean() {
        val reading = RunActionUiState(
            kind = "read",
            sentence = "Reading README.md",
            presentationVerb = "read",
            presentationSubject = "README.md",
        )
        val exploring = RunActionFormatter.fromServer(Json.parseToJsonElement(
            """{"state":"working","kind":"read","group":{"kind":"exploring","count":3}}""",
        ) as JsonObject)!!
        val provider = RunActionUiState("execute", "Checking how reconnect restores the clock")
        val executed = RunActionFormatter.forOperation(TimelineItem.Operation(
            "op", 1, TimelineOperationKind.Command, "Running command", "Bash", TimelineOperationStatus.Completed,
        ))
        rule.setContent {
            RagentTheme {
                Column {
                    Text(presentRunAction(reading))
                    Text(presentRunAction(exploring))
                    Text(presentRunAction(provider))
                    Text(presentCompletedAction(executed))
                }
            }
        }
        rule.onNodeWithText("README.md 읽는 중").assertIsDisplayed()
        rule.onNodeWithText("3개 항목 탐색 중").assertIsDisplayed()
        rule.onNodeWithText(provider.sentence).assertIsDisplayed()
        rule.onNodeWithText("명령 실행 완료").assertIsDisplayed()
    }

    @Test
    fun durationAndTimelineProcessLabelsAreLocalizedInKorean() {
        rule.setContent {
            RagentTheme {
                Column {
                    Text(
                        stringResource(
                            R.string.workbench_run_elapsed,
                            stringResource(R.string.workbench_duration_seconds, 4L),
                        ),
                    )
                    Text(
                        stringResource(
                            R.string.workbench_run_finished,
                            stringResource(R.string.workbench_duration_minutes_seconds, 1L, 5L),
                        ),
                    )
                    Text(stringResource(R.string.timeline_process))
                }
            }
        }
        rule.onNodeWithText("4초 동안 처리 중").assertIsDisplayed()
        rule.onNodeWithText("1분 5초 소요").assertIsDisplayed()
        rule.onNodeWithText("활동").assertIsDisplayed()
    }
}
