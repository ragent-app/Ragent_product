package com.andysagent.ragent.feature.workbench

import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.timeline.RunActionUiState
import com.andysagent.ragent.core.timeline.RunActionFormatter
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
@Config(sdk = [35], qualifiers = "zh-rCN-w320dp-h720dp")
class RunActionLocalizationTest {
    @get:Rule val rule = createComposeRule()

    @Test fun generatedTemplateIsLocalizedAndProviderProseIsPreserved() {
        val generated = RunActionUiState("read", "Reading README.md", presentationVerb = "read", presentationSubject = "README.md")
        val provider = RunActionUiState("execute", "Checking how reconnect restores the clock")
        rule.setContent { RagentTheme { androidx.compose.foundation.layout.Column {
            Text(presentRunAction(generated))
            Text(presentRunAction(provider))
        } } }
        rule.onNodeWithText("正在读取 README.md").assertIsDisplayed()
        rule.onNodeWithText(provider.sentence).assertIsDisplayed()
    }

    @Test fun genericServerAndHistoricalLabelsAreLocalized() {
        val running = RunActionFormatter.fromServer(Json.parseToJsonElement(
            """{"state":"working","kind":"execute","labelKind":"execute","subject":"execute","detail":"Bash"}""",
        ) as JsonObject)!!
        val finished = RunActionFormatter.forOperation(TimelineItem.Operation(
            "op", 1, TimelineOperationKind.Command, "Running command", "Bash", TimelineOperationStatus.Completed,
        ))
        rule.setContent { RagentTheme { androidx.compose.foundation.layout.Column {
            Text(presentRunAction(running))
            Text(presentCompletedAction(finished))
        } } }
        rule.onNodeWithText("正在运行 命令").assertIsDisplayed()
        rule.onNodeWithText("运行了 命令").assertIsDisplayed()
    }

    @Test fun questionAndRecoveredFileUseReadableLabels() {
        val question = RunActionFormatter.fromServer(Json.parseToJsonElement(
            """{"state":"working","labelKind":"question","subject":"question"}""",
        ) as JsonObject)!!
        val read = RunActionFormatter.forOperation(TimelineItem.Operation(
            "read", 1, TimelineOperationKind.Tool, "Reading file", "G:\\qa\\acceptance.txt",
            TimelineOperationStatus.Completed, toolName = "read",
        ))
        val location = RunActionFormatter.forOperation(TimelineItem.Operation(
            "pwd", 2, TimelineOperationKind.Command, "Running command", "pwd", TimelineOperationStatus.Completed,
        ))
        rule.setContent { RagentTheme { androidx.compose.foundation.layout.Column {
            Text(presentRunAction(question))
            Text(presentCompletedAction(read))
            Text(presentCompletedAction(location))
        } } }
        rule.onNodeWithText("正在提出问题").assertIsDisplayed()
        rule.onNodeWithText("读取了 acceptance.txt").assertIsDisplayed()
        rule.onNodeWithText("检查了 当前位置").assertIsDisplayed()
    }

    @Test fun groupedExploringCountIsLocalized() {
        val exploring = RunActionFormatter.fromServer(Json.parseToJsonElement(
            """{"state":"working","kind":"read","group":{"kind":"exploring","count":3}}""",
        ) as JsonObject)!!
        rule.setContent { RagentTheme { Text(presentRunAction(exploring)) } }
        rule.onNodeWithText("正在探索 3 项").assertIsDisplayed()
    }
}
