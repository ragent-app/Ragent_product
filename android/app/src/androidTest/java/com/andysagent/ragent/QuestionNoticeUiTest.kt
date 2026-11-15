package com.andysagent.ragent

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.*
import com.andysagent.ragent.feature.workbench.*
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class QuestionNoticeUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val dark get() = InstrumentationRegistry.getArguments().getString("dark") == "true"
    private fun capture(name: String) {
        rule.waitForIdle()
        val file = File(instrumentation.targetContext.getExternalFilesDir(null), "question-notice/$name-$dark.png")
        file.parentFile?.mkdirs()
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }

    @Test fun singleChoiceDropsBoilerplateAndOnlyAnswersAfterExpansion() {
        val approval = Approval(id = "q", sessionId = "s", runId = "r", title = "发布方式",
            questions = listOf(ApprovalQuestion(question = "这次采用哪种发布方式？", options = listOf(
                ApprovalOption("分批发布", description = "Choose 分批发布 as the answer."),
                ApprovalOption("全部发布", description = "立即向所有用户开放")))))
        var state by mutableStateOf(AttentionReducer.reduce(AttentionUiState(),
            AttentionReducer.project(listOf(Session("s", "网站更新")), listOf(approval))))
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { RagentTheme(darkTheme = dark) { AttentionSurface(state, onEvent = {
            events += it
            if (it is AttentionEvent.SetExpanded) state = state.copy(expanded = it.expanded)
        }, onOpenSession = {}) } }
        rule.onNodeWithText("Choose 分批发布 as the answer.").assertDoesNotExist()
        capture("collapsed")
        rule.onNodeWithText("分批发布").performClick()
        rule.runOnIdle { assertTrue(events.single() is AttentionEvent.SetExpanded) }
        capture("expanded")
        rule.onNodeWithText("立即向所有用户开放").assertIsDisplayed()
        rule.onNodeWithText("全部发布").performClick()
        rule.runOnIdle { assertEquals(AttentionEvent.ResolveQuestion(requireNotNull(state.activeItemId), 0, 1), events.last()) }
    }

    @Test fun multiSelectRetainsSelectionAndCloseDoesNotSubmit() {
        val approval = Approval(id = "multi", sessionId = "s", runId = "r", title = "验证范围",
            questions = listOf(ApprovalQuestion(question = "需要验证哪些功能？", isMultiSelect = true,
                options = listOf(ApprovalOption("账号登录"), ApprovalOption("跨实例管理")))))
        val state = AttentionReducer.reduce(AttentionUiState(), AttentionReducer.project(
            listOf(Session("s", "应用验证")), listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { RagentTheme(darkTheme = dark) { AttentionSurface(state, events::add, onOpenSession = {}) } }
        rule.onNodeWithText("账号登录").performClick()
        rule.onNodeWithText("跨实例管理").performClick()
        rule.runOnIdle { assertTrue(events.isEmpty()) }
        capture("multi-selected")
        rule.onNodeWithText("发送").performScrollTo().performClick()
        rule.runOnIdle {
            val answer = events.filterIsInstance<AttentionEvent.ResolveMultiChoices>().single()
            assertEquals(listOf(listOf(0, 1)), answer.selections)
        }
        events.clear()
        rule.onNodeWithContentDescription(rule.activity.getString(com.andysagent.ragent.feature.workbench.R.string.approval_notice_close)).performClick()
        rule.runOnIdle { assertTrue(events.single() is AttentionEvent.Dismiss) }
    }
}
