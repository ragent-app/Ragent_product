package com.andysagent.ragent

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.agentui.PermissionRequestCard
import com.andysagent.ragent.core.agentui.PermissionRequestUiState
import com.andysagent.ragent.core.agentui.R as AgentUiR
import com.andysagent.ragent.core.designsystem.RagentSpacing
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import com.andysagent.ragent.core.model.AppLanguage
import com.andysagent.ragent.core.model.AppTheme
import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.ApprovalOption
import com.andysagent.ragent.core.model.ApprovalQuestion
import com.andysagent.ragent.core.model.AttentionItem
import com.andysagent.ragent.core.model.AttentionKind
import com.andysagent.ragent.core.model.AttentionReducer
import com.andysagent.ragent.core.model.AttentionUiState
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.model.OtherDeviceProject
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineOperationKind
import com.andysagent.ragent.core.timeline.TimelineOperationStatus
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.workbench.SettingsPage
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.feature.workbench.PairingOnboardingStep
import com.andysagent.ragent.feature.workbench.PairingOnboardingUiState
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Establishes the Compose screenshot golden baselines for the Workbench surface.
 *
 * Renders each key state on-device (one fresh Activity per test) and saves a PNG
 * into the app's external files dir (`/sdcard/Android/data/com.agentoncloud.android/
 * files/screenshots/`), pulled with `adb pull` and committed under `app/screenshots/`
 * as the first baseline.
 *
 * Run:  ./gradlew :app:connectedDebugAndroidTest \
 *          -Pandroid.testInstrumentationRunnerArguments.class=com.andysagent.ragent.WorkbenchScreenshotBaselineTest
 * Pull: adb pull /sdcard/Android/data/com.agentoncloud.android/files/screenshots
 *
 * These are deterministic states (no infinite animations, no time/random inputs),
 * so re-running on the same AVD produces a stable baseline for later diffing.
 */
@RunWith(AndroidJUnit4::class)
class WorkbenchScreenshotBaselineTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun agentUiText(resId: Int, vararg formatArgs: Any): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resId, *formatArgs)

    private val outputDir: File
        get() = File(
            InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null),
            "screenshots",
        )

    @org.junit.Before
    fun setUp() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.executeShellCommand("cmd statusbar collapse").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        automation.executeShellCommand("input keyevent KEYCODE_WAKEUP").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        automation.executeShellCommand("wm dismiss-keyguard").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        automation.executeShellCommand("settings put global sysui_demo_allowed 1").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        automation.executeShellCommand("am broadcast -a com.android.systemui.demo -e command clock -e hhmm 1200").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        automation.executeShellCommand("am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        automation.executeShellCommand("am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        automation.executeShellCommand("am broadcast -a com.android.systemui.demo -e command notifications -e visible false").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        SystemClock.sleep(300)
    }

    private fun capture(
        name: String,
        dark: Boolean = false,
        themeVariant: String = "system",
        fontScale: Float = 1f,
        content: @Composable () -> Unit,
    ) {
        composeRule.setContent {
            RagentTheme(darkTheme = dark, themeVariant = themeVariant) {
                val density = LocalDensity.current
                CompositionLocalProvider(
                    LocalDensity provides Density(density.density, fontScale),
                ) {
                    content()
                }
            }
        }
        composeRule.waitForIdle()
        SystemClock.sleep(400)
        val bitmap = takeNonBlankScreenshot()
        outputDir.mkdirs()
        val output = File(outputDir, "$name.png")
        FileOutputStream(output).use { stream ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        }
        val publishedDir = "/sdcard/Download/ragent-screenshots"
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.executeShellCommand("mkdir -p $publishedDir")
            .use { command -> FileInputStream(command.fileDescriptor).use { it.readBytes() } }
        automation.executeShellCommand("cp ${output.absolutePath} $publishedDir/${output.name}")
            .use { command -> FileInputStream(command.fileDescriptor).use { it.readBytes() } }
        android.util.Log.i("GoldenBaseline", "captured $name.png (${bitmap.width}x${bitmap.height})")
    }

    private fun takeNonBlankScreenshot(): Bitmap {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        repeat(10) { attempt ->
            val bitmap = automation.takeScreenshot()
            if (hasVisibleContent(bitmap)) return bitmap
            bitmap.recycle()
            android.util.Log.w("GoldenBaseline", "blank frame ${attempt + 1}; retrying")
            SystemClock.sleep(250)
        }
        error("Screenshot remained blank after 10 attempts")
    }

    private fun hasVisibleContent(bitmap: Bitmap): Boolean {
        var nonWhiteSamples = 0
        val startY = bitmap.height / 10
        val endY = bitmap.height * 9 / 10
        for (y in startY until endY step 8) {
            for (x in 0 until bitmap.width step 8) {
                val pixel = bitmap.getPixel(x, y)
                if (
                    android.graphics.Color.red(pixel) < 244 ||
                    android.graphics.Color.green(pixel) < 244 ||
                    android.graphics.Color.blue(pixel) < 244
                ) {
                    nonWhiteSamples += 1
                    if (nonWhiteSamples >= 80) return true
                }
            }
        }
        return false
    }

    @Test
    fun captureSessionIdle() = capture("session-idle") {
        WorkbenchScreen(WorkbenchUiState(chatOpen = true, sessionId = "session-idle"))
    }

    @Test
    fun captureSessionConnectedIdle() = capture("session-connected-idle") {
        WorkbenchScreen(
            WorkbenchUiState(
                chatOpen = true,
                sessionId = "session-connected-idle",
                connection = AgentConnectionStatus.Connected,
            ),
        )
    }

    @Test
    fun captureSessionConnectedIdleFontScale130() = capture(
        "session-connected-idle-font-130",
        fontScale = 1.3f,
    ) {
        WorkbenchScreen(
            WorkbenchUiState(
                chatOpen = true,
                sessionId = "session-connected-idle",
                connection = AgentConnectionStatus.Connected,
            ),
        )
    }

    @Test
    fun captureSessionIdleDark() = capture("session-idle-dark", dark = true) {
        WorkbenchScreen(WorkbenchUiState(chatOpen = true, sessionId = "session-idle"))
    }

    @Test
    fun captureSessionFocusedExpanded() {
        composeRule.setContent {
            RagentTheme(darkTheme = false) {
                WorkbenchScreen(WorkbenchUiState(chatOpen = true, sessionId = "session-expanded"))
            }
        }
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).performClick()
        composeRule.waitForIdle()
        SystemClock.sleep(400)
        val bitmap = takeNonBlankScreenshot()
        outputDir.mkdirs()
        val output = File(outputDir, "session-focused-expanded.png")
        FileOutputStream(output).use { stream ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        }
        val publishedDir = "/sdcard/Download/ragent-screenshots"
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.executeShellCommand("mkdir -p $publishedDir")
            .use { command -> FileInputStream(command.fileDescriptor).use { it.readBytes() } }
        automation.executeShellCommand("cp ${output.absolutePath} $publishedDir/${output.name}")
            .use { command -> FileInputStream(command.fileDescriptor).use { it.readBytes() } }
    }

    @Test
    fun captureSessionFocusedExpandedDark() {
        composeRule.setContent {
            RagentTheme(darkTheme = true) {
                WorkbenchScreen(WorkbenchUiState(chatOpen = true, sessionId = "session-expanded"))
            }
        }
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).performClick()
        composeRule.waitForIdle()
        SystemClock.sleep(400)
        val bitmap = takeNonBlankScreenshot()
        outputDir.mkdirs()
        val output = File(outputDir, "session-focused-expanded-dark.png")
        FileOutputStream(output).use { stream ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        }
        val publishedDir = "/sdcard/Download/ragent-screenshots"
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.executeShellCommand("mkdir -p $publishedDir")
            .use { command -> FileInputStream(command.fileDescriptor).use { it.readBytes() } }
        automation.executeShellCommand("cp ${output.absolutePath} $publishedDir/${output.name}")
            .use { command -> FileInputStream(command.fileDescriptor).use { it.readBytes() } }
    }

    @Test
    fun captureSessionRunning() = capture("session-running") { WorkbenchScreen(runningState()) }

    @Test
    fun captureSessionRunningDark() = capture("session-running-dark", dark = true) { WorkbenchScreen(runningState()) }

    @Test
    fun captureSessionError() = capture("session-error") {
        WorkbenchScreen(
            WorkbenchUiState(
                chatOpen = true,
                sessionId = "session-error",
                error = "Connect a computer before sending a message.",
            ),
        )
    }

    @Test
    fun captureSessionApproval() = capture("session-approval") {
        WorkbenchScreen(approvalState())
    }

    @Test
    fun captureSessionCompleted() = capture("session-completed") {
        WorkbenchScreen(completedState())
    }

    @Test
    fun captureSessionCompletedDark() = capture("session-completed-dark", dark = true) {
        WorkbenchScreen(completedState())
    }

    private fun attentionApprovalState(
        expanded: Boolean = false,
        queued: Int = 0,
    ): AttentionUiState {
        val approvalItem = AttentionItem(
            id = AttentionReducer.approvalItemId("session-approval", "approval-1"),
            sessionId = "session-approval",
            sessionTitle = "Publish weekly report",
            kind = AttentionKind.Approval,
            title = "Approve command",
            summary = "git push origin main — 需要你的确认",
            reason = "The agent wants to run `git push origin main` on your computer.",
            priority = AttentionItem.PRIORITY_NORMAL,
            approval = Approval(
                id = "approval-1",
                sessionId = "session-approval",
                title = "Approve command",
                reason = "The agent wants to run `git push origin main` on your computer.",
                passkeyRequired = false,
            ),
        )
        val items = listOf(approvalItem) + (0 until queued).map { index ->
            AttentionItem(
                id = "waiting:session-queued-$index",
                sessionId = "session-queued-$index",
                sessionTitle = "Follow-up task $index",
                kind = AttentionKind.Question,
                title = "Follow-up task $index",
                summary = "有一个问题等待你的回答",
                updatedAt = 100L + index,
            )
        }
        return AttentionUiState(
            items = items,
            activeItemId = items.first().id,
            expanded = expanded,
        )
    }

    @Test
    fun captureAttentionBrief() = capture("attention-brief") {
        WorkbenchScreen(
            WorkbenchUiState(destination = AgentoDestination.Home),
            attentionState = attentionApprovalState(),
        )
    }

    @Test
    fun captureAttentionBriefDark() = capture("attention-brief-dark", dark = true) {
        WorkbenchScreen(
            WorkbenchUiState(destination = AgentoDestination.Home),
            attentionState = attentionApprovalState(),
        )
    }

    @Test
    fun captureAttentionError() = capture("attention-error") {
        WorkbenchScreen(
            WorkbenchUiState(
                destination = AgentoDestination.Home,
                error = "Connect a computer before sending a message.",
            ),
        )
    }

    @Test
    fun captureAttentionExpanded() = capture("attention-expanded") {
        WorkbenchScreen(
            WorkbenchUiState(destination = AgentoDestination.Home),
            attentionState = attentionApprovalState(expanded = true),
        )
    }

    @Test
    fun captureAttentionQueued() = capture("attention-queued") {
        WorkbenchScreen(
            WorkbenchUiState(destination = AgentoDestination.Home),
            attentionState = attentionApprovalState(queued = 2),
        )
    }

    @Test
    fun captureAttentionQuestion() = capture("attention-question") {
        val item = AttentionItem(
            id = AttentionReducer.approvalItemId("session-question", "approval-question-1"),
            sessionId = "session-question",
            sessionTitle = "Publish weekly report",
            kind = AttentionKind.Question,
            title = "Release choice",
            summary = "Which release mode should be used?",
            priority = AttentionItem.PRIORITY_NORMAL,
            approval = Approval(
                id = "approval-question-1",
                sessionId = "session-question",
                title = "Release choice",
                kind = "approval_request",
                runId = "run-question-1",
                questions = listOf(
                    ApprovalQuestion(
                        id = "release-mode",
                        header = "Release mode",
                        question = "Which release mode should be used?",
                        options = listOf(
                            ApprovalOption("Canary", description = "Start with 10%"),
                            ApprovalOption("Full"),
                        ),
                    ),
                ),
            ),
        )
        WorkbenchScreen(
            WorkbenchUiState(destination = AgentoDestination.Home),
            attentionState = AttentionUiState(
                items = listOf(item),
                activeItemId = item.id,
                expanded = true,
            ),
        )
    }

    @Test
    fun captureAttentionMultipleQuestions() = capture("attention-multiple-questions") {
        val item = AttentionItem(
            id = AttentionReducer.approvalItemId("session-multiple-question", "approval-multiple-1"),
            sessionId = "session-multiple-question",
            sessionTitle = "Publish weekly report",
            kind = AttentionKind.Question,
            title = "Release setup",
            summary = "Choose the release target and schedule.",
            priority = AttentionItem.PRIORITY_NORMAL,
            approval = Approval(
                id = "approval-multiple-1",
                sessionId = "session-multiple-question",
                title = "Release setup",
                kind = "approval_request",
                runId = "run-multiple-question-1",
                questions = listOf(
                    ApprovalQuestion(
                        id = "release-target",
                        header = "Release target",
                        question = "Where should the report be published?",
                        options = listOf(
                            ApprovalOption("Staging"),
                            ApprovalOption("Production"),
                        ),
                    ),
                    ApprovalQuestion(
                        id = "release-time",
                        header = "Release time",
                        question = "When should the publication run?",
                        options = listOf(
                            ApprovalOption("Now"),
                            ApprovalOption("Tonight"),
                        ),
                    ),
                ),
            ),
        )
        WorkbenchScreen(
            WorkbenchUiState(destination = AgentoDestination.Home),
            attentionState = AttentionUiState(
                items = listOf(item),
                activeItemId = item.id,
                expanded = true,
            ),
        )
    }

    @Test
    fun captureSessionMarkdownStress() = capture("session-markdown-stress") {
        WorkbenchScreen(markdownStressState())
    }

    @Test
    fun captureSessionMarkdownStressDark() = capture("session-markdown-stress-dark", dark = true) {
        WorkbenchScreen(markdownStressState())
    }

    @Test
    fun captureSessionInlineCodeWrap() = capture("session-inline-code-wrap") {
        WorkbenchScreen(inlineCodeWrapState())
    }

    @Test
    fun captureSessionInlineCodeWrapDark() = capture("session-inline-code-wrap-dark", dark = true) {
        WorkbenchScreen(inlineCodeWrapState())
    }

    @Test
    fun captureSessionMarkdownStreaming() = capture("session-markdown-streaming") {
        WorkbenchScreen(markdownStreamingState())
    }

    @Test
    fun captureSettingsOverview() = capture("settings-overview") {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings))
    }

    @Test
    fun captureSettingsOverviewFontScale130() = capture(
        "settings-overview-font-130",
        fontScale = 1.3f,
    ) {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings))
    }

    @Test
    fun captureSettingsOverviewDark() = capture("settings-overview-dark", dark = true) {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings, appTheme = AppTheme.Dark))
    }

    @Test
    fun captureSettingsThemeDetail() = capture("settings-theme-detail") {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings, settingsPage = SettingsPage.Theme, appTheme = AppTheme.System))
    }

    @Test
    fun captureSettingsThemeDetailDark() = capture("settings-theme-detail-dark", dark = true) {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings, settingsPage = SettingsPage.Theme, appTheme = AppTheme.Dark))
    }

    @Test
    fun captureSettingsThemeDetailOled() = capture("settings-theme-detail-oled", dark = true) {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings, settingsPage = SettingsPage.Theme, appTheme = AppTheme.Oled))
    }

    @Test
    fun captureSettingsThemeDetailAmber() = capture("settings-theme-detail-amber", dark = true) {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings, settingsPage = SettingsPage.Theme, appTheme = AppTheme.Amber))
    }

    @Test
    fun captureSettingsThemeDetailMonet() = capture(
        name = "settings-theme-detail-monet",
        themeVariant = AppTheme.Monet.value,
    ) {
        WorkbenchScreen(
            WorkbenchUiState(
                destination = AgentoDestination.Settings,
                settingsPage = SettingsPage.Theme,
                appTheme = AppTheme.Monet,
            ),
        )
    }

    @Test
    fun captureSettingsLanguageDetail() = capture("settings-language-detail") {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings, settingsPage = SettingsPage.Language, appLanguage = AppLanguage.System))
    }

    @Test
    fun captureSettingsLanguageDetailDark() = capture("settings-language-detail-dark", dark = true) {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings, settingsPage = SettingsPage.Language, appLanguage = AppLanguage.SimplifiedChinese))
    }

    @Test
    fun captureSessionMarkdownStressTable() = capture("session-markdown-stress-table") {
        androidx.compose.material3.Surface(
            color = LocalRagentColors.current.canvas,
            modifier = Modifier.fillMaxSize().padding(16.dp),
        ) {
            com.andysagent.ragent.core.agentui.AgentMarkdown(
                markdown = """
                    ### 4. 窄屏表格数据展示

                    | 模块组件 | 目标字号 / 行高 | 描边策略 | 空间优化特性 |
                    | :--- | :---: | :---: | :--- |
                    | **Inline Code** | `14sp` / `22sp` | **Zero-Outline** | 锁定 CJK 基线，无垂直抖动 |
                    | **Code Block** | `13.5sp` / `20.5sp` | **Zero-Outline** | 独立横向滑动容器，带语言栏与复制 |
                    | **Nested List** | `16sp` / `24.5sp` | 无边框 | 14dp 紧凑嵌套缩进，拒绝挤压空间 |

                    这是一个用于验证超长段落阅读体验的测试结尾。在 390dp 移动端屏幕上，连续多行的文本应该呈现出均匀、平稳、无视觉噪声的阅读流，段落之间有清晰的 12dp 呼吸间距，使开发者与用户在长时间监控 Agent 执行长篇任务时保持舒适与专注。
                """.trimIndent(),
            )
        }
    }

    @Test
    fun captureSessionMarkdownStressTableDark() = capture("session-markdown-stress-table-dark", dark = true) {
        androidx.compose.material3.Surface(
            color = LocalRagentColors.current.canvas,
            modifier = Modifier.fillMaxSize().padding(16.dp),
        ) {
            com.andysagent.ragent.core.agentui.AgentMarkdown(
                markdown = """
                    ### 4. 窄屏表格数据展示

                    | 模块组件 | 目标字号 / 行高 | 描边策略 | 空间优化特性 |
                    | :--- | :---: | :---: | :--- |
                    | **Inline Code** | `14sp` / `22sp` | **Zero-Outline** | 锁定 CJK 基线，无垂直抖动 |
                    | **Code Block** | `13.5sp` / `20.5sp` | **Zero-Outline** | 独立横向滑动容器，带语言栏与复制 |
                    | **Nested List** | `16sp` / `24.5sp` | 无边框 | 14dp 紧凑嵌套缩进，拒绝挤压空间 |

                    这是一个用于验证超长段落阅读体验的测试结尾。在 390dp 移动端屏幕上，连续多行的文本应该呈现出均匀、平稳、无视觉噪声的阅读流，段落之间有清晰的 12dp 呼吸间距，使开发者与用户在长时间监控 Agent 执行长篇任务时保持舒适与专注。
                """.trimIndent(),
            )
        }
    }

    @Test
    fun captureSessionCodeHighlight() = capture("session-code-highlight") {
        androidx.compose.material3.Surface(
            color = LocalRagentColors.current.canvas,
            modifier = Modifier.fillMaxSize().padding(16.dp),
        ) {
            com.andysagent.ragent.core.agentui.AgentMarkdown(
                markdown = """
                    ### 语法高亮验证 (Syntax Highlighting)

                    ```kotlin
                    // AgentoMarkdownPipeline.kt
                    class AgentoMarkdownPipeline(
                        private val dispatcher: CoroutineDispatcher = Dispatchers.Default
                    ) {
                        fun parseStreamIncremental(rawText: String): Flow<MarkdownBlockAst> = flow {
                            val stableBlocks = splitCompletedBlocks(rawText)
                            emit(stableBlocks)
                        }.flowOn(dispatcher)
                    }
                    ```

                    ```python
                    # Python 多语言与 JSON 属性高亮
                    def calculate_stream_rhythm(tokens: list[str], max_line_width_dp: float = 390.0) -> dict:
                        return {"status": "success", "baseline_locked": True, "token_count": len(tokens)}
                    ```
                """.trimIndent(),
            )
        }
    }

    @Test
    fun captureSessionCodeHighlightDark() = capture("session-code-highlight-dark", dark = true) {
        androidx.compose.material3.Surface(
            color = LocalRagentColors.current.canvas,
            modifier = Modifier.fillMaxSize().padding(16.dp),
        ) {
            com.andysagent.ragent.core.agentui.AgentMarkdown(
                markdown = """
                    ### 语法高亮验证 (Syntax Highlighting)

                    ```kotlin
                    // AgentoMarkdownPipeline.kt
                    class AgentoMarkdownPipeline(
                        private val dispatcher: CoroutineDispatcher = Dispatchers.Default
                    ) {
                        fun parseStreamIncremental(rawText: String): Flow<MarkdownBlockAst> = flow {
                            val stableBlocks = splitCompletedBlocks(rawText)
                            emit(stableBlocks)
                        }.flowOn(dispatcher)
                    }
                    ```

                    ```python
                    # Python 多语言与 JSON 属性高亮
                    def calculate_stream_rhythm(tokens: list[str], max_line_width_dp: float = 390.0) -> dict:
                        return {"status": "success", "baseline_locked": True, "token_count": len(tokens)}
                    ```
                """.trimIndent(),
            )
        }
    }

    @Test
    fun captureSessionGoalMode() = capture("session-goal-mode") {
        WorkbenchScreen(completedState().copy(goalMode = true, goalText = "Deploy v2"))
    }

    @Test
    fun captureSessionEffortPicker() = capture("session-effort-picker") {
        WorkbenchScreen(completedState().copy(effortPickerOpen = true, thinkingEffort = 0.8f))
    }

    @Test
    fun captureSessionEffortPickerDark() = capture("session-effort-picker-dark", dark = true) {
        WorkbenchScreen(completedState().copy(effortPickerOpen = true, thinkingEffort = 0.8f))
    }

    @Test
    fun captureSessionUserMessageLong() = capture("session-user-message-long") {
        val longText = "Please refactor the network layer to use WebSockets with automatic reconnection, heartbeat pings every 15 seconds, and exponential backoff retry. Ensure data payload compression is enabled and verify all tests pass."
        WorkbenchScreen(
            completedState().copy(
                timelineItems = listOf(
                    TimelineItem.Message(id = "u1", seq = 1, role = TimelineRole.User, text = "Hi", completed = true),
                    TimelineItem.Message(id = "u2", seq = 2, role = TimelineRole.User, text = longText, completed = true),
                    TimelineItem.Message(id = "c1", seq = 3, role = TimelineRole.Agent, text = "I'm starting the refactor as requested.", completed = true),
                )
            )
        )
    }

    @Test
    fun captureSessionUserMessageLongDark() = capture("session-user-message-long-dark", dark = true) {
        val longText = "Please refactor the network layer to use WebSockets with automatic reconnection, heartbeat pings every 15 seconds, and exponential backoff retry. Ensure data payload compression is enabled and verify all tests pass."
        WorkbenchScreen(
            completedState().copy(
                timelineItems = listOf(
                    TimelineItem.Message(id = "u1", seq = 1, role = TimelineRole.User, text = "Hi", completed = true),
                    TimelineItem.Message(id = "u2", seq = 2, role = TimelineRole.User, text = longText, completed = true),
                    TimelineItem.Message(id = "c1", seq = 3, role = TimelineRole.Agent, text = "I'm starting the refactor as requested.", completed = true),
                )
            )
        )
    }

    @Test
    fun captureSessionUserMessageMarkdown() = capture("session-user-message-markdown") {
        WorkbenchScreen(userMarkdownMessageState())
    }

    @Test
    fun captureSessionUserMessageMarkdownDark() = capture("session-user-message-markdown-dark", dark = true) {
        WorkbenchScreen(userMarkdownMessageState())
    }

    @Test
    fun captureApprovalDialog() = capture("approval-dialog") {
        Box(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(RagentSpacing.Gutter)) {
            PermissionRequestCard(
                state = PermissionRequestUiState(
                    id = "approval-1",
                    title = "Approve command",
                    reason = "The agent wants to run `git push origin main` on your computer.",
                    saferAlternative = "You can review the exact diff before approving.",
                ),
                onApprove = {},
                onDeny = {},
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }

    @Test
    fun captureHome() = capture("home") {
        WorkbenchScreen(homeState())
    }

    @Test
    fun captureHomeDark() = capture("home-dark", dark = true) {
        WorkbenchScreen(homeState())
    }

    @Test
    fun captureHomeProjectContinuity() = capture("home-project-continuity") {
        WorkbenchScreen(
            homeState().copy(
                sessions = listOf(
                    Session(
                        id = "session-design-system",
                        title = "Polish navigation materials",
                        projectId = "project-design-system",
                        status = SessionStatus.Completed,
                        latestSeq = 12,
                        updatedAt = 3_000L,
                    ),
                    Session(
                        id = "session-api-client",
                        title = "Stabilize streaming replies",
                        projectId = "project-api-client",
                        status = SessionStatus.Completed,
                        latestSeq = 11,
                        updatedAt = 2_000L,
                    ),
                ),
                projects = listOf(
                    Project("project-api-client", "API client", "G:\\Workspace\\api-client"),
                    Project("project-design-system", "Design system", "G:\\Workspace\\design-system"),
                ),
                otherDeviceProjects = listOf(
                    OtherDeviceProject(
                        targetId = "office-pc",
                        targetLabel = "Office PC",
                        targetLastSeenAt = 4_000L,
                        projectId = "project-mobile-release",
                        projectName = "Mobile release",
                        updatedAt = 4_000L,
                    ),
                    OtherDeviceProject(
                        targetId = "studio-mac",
                        targetLabel = "Studio Mac",
                        targetLastSeenAt = 3_500L,
                        projectId = "project-product-site",
                        projectName = "Product site",
                        updatedAt = 3_500L,
                    ),
                ),
            ),
        )
    }

    @Test
    fun captureSettings() = capture("settings") {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings))
    }


    @Test
    fun captureSessions() = capture("sessions") {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Sessions))
    }

    @Test
    fun captureProjectsSessionsReference() = capture("projects-sessions-reference") {
        WorkbenchScreen(
            state = tabletProjectsReferenceState(),
            windowSizeClass = AgentoWindowSizeClass.Expanded,
        )
    }

    @Test
    fun captureProjectsSessionsReferenceExpandedEmpty() = capture("projects-sessions-reference-expanded-empty") {
        WorkbenchScreen(
            state = projectsReferenceState(),
            windowSizeClass = AgentoWindowSizeClass.Expanded,
        )
    }

    @Test
    fun captureProjectsSessionsReferenceExpandedL2() = capture("projects-sessions-reference-expanded-l2") {
        WorkbenchScreen(
            state = projectsReferenceState().copy(
                projectSessionsOpen = true,
                browsingProjectId = "project-operations",
            ),
            windowSizeClass = AgentoWindowSizeClass.Expanded,
        )
    }

    @Test
    fun captureProjectsSessionsReferenceCompact() = capture("projects-sessions-reference-compact") {
        WorkbenchScreen(state = projectsReferenceState(), windowSizeClass = AgentoWindowSizeClass.Compact)
    }

    @Test
    fun captureProjectsSessionsReferenceCompactDark() = capture("projects-sessions-reference-compact-dark", dark = true) {
        WorkbenchScreen(state = projectsReferenceState(), windowSizeClass = AgentoWindowSizeClass.Compact)
    }

    @Test
    fun captureProjectSessionsReferenceCompactL2() = capture("projects-sessions-reference-l2-compact") {
        WorkbenchScreen(
            state = projectsReferenceState().copy(
                projectSessionsOpen = true,
                browsingProjectId = "project-operations",
            ),
            windowSizeClass = AgentoWindowSizeClass.Compact,
        )
    }

    @Test
    fun captureProjectDialog() = capture("project-dialog") {
        WorkbenchScreen(
            state = projectsReferenceState().copy(
                projectDialogOpen = true,
                projectName = "Customer exports",
                projectRootPath = "C:/Work/customer-exports",
            ),
        )
    }

    @Test
    fun capturePairingScan() = capture("pairing-scan") {
        WorkbenchScreen(
            state = WorkbenchUiState(destination = AgentoDestination.Settings),
            pairingOnboardingState = PairingOnboardingUiState(
                open = true,
                step = PairingOnboardingStep.AccountClaimRequired,
            ),
        )
    }

    @Test
    fun capturePairingErrorDark() = capture("pairing-error-dark", dark = true) {
        WorkbenchScreen(
            state = WorkbenchUiState(destination = AgentoDestination.Settings),
            pairingOnboardingState = PairingOnboardingUiState(
                open = true,
                step = PairingOnboardingStep.Error,
                errorMessage = "This pairing code expired. Show a new code on the computer and scan again.",
            ),
        )
    }

    @Test
    fun capturePairingScannerUnavailable() = capture("pairing-scanner-unavailable") {
        WorkbenchScreen(
            state = WorkbenchUiState(destination = AgentoDestination.Settings),
            pairingOnboardingState = PairingOnboardingUiState(
                open = true,
                step = PairingOnboardingStep.Error,
                scannerUnavailable = true,
                scannerFailureReturnsToWelcome = true,
            ),
        )
    }

    private fun projectsReferenceState(): WorkbenchUiState {
        // Keep the visual fixture stable while ensuring the compact metadata
        // rail renders time, running, unread, and approval states.
        val fixtureNow = 1_787_630_400_000L
        return WorkbenchUiState(
            destination = AgentoDestination.Sessions,
            computers = listOf(
                Computer("computer-windows", "Office PC", "Windows", connected = true),
                Computer("computer-linux", "Build machine", "Linux", connected = false),
            ),
            projects = listOf(
                Project("project-operations", "Operations", "C:/Work/operations"),
                Project("project-reports", "Quarterly reports", "C:/Work/reports"),
                Project("project-inbox", "Unsorted work", "C:/Work/inbox"),
            ),
            sessions = listOf(
                Session(
                    "session-cleanup",
                    "Clean up weekly exports",
                    "project-operations",
                    SessionStatus.Working,
                    latestSeq = 12,
                    updatedAt = fixtureNow,
                ),
                Session(
                    "session-approval",
                    "Review the monthly export",
                    "project-operations",
                    SessionStatus.WaitingApproval,
                    latestSeq = 10,
                    updatedAt = fixtureNow - 2 * 60_000L,
                    lastAssistantMessageAt = fixtureNow - 2 * 60_000L,
                    lastReviewedAt = fixtureNow - 10 * 60_000L,
                    waitingAction = "approval",
                ),
                Session(
                    "session-archive",
                    "Archive completed files",
                    "project-operations",
                    SessionStatus.Completed,
                    latestSeq = 6,
                    updatedAt = fixtureNow - 60 * 60_000L,
                    lastAssistantMessageAt = fixtureNow - 60 * 60_000L,
                    lastReviewedAt = fixtureNow - 2 * 60 * 60_000L,
                ),
                Session(
                    "session-quarterly",
                    "Prepare the quarterly report",
                    "project-reports",
                    SessionStatus.Completed,
                    latestSeq = 8,
                    updatedAt = fixtureNow - 24 * 60 * 60_000L,
                    lastAssistantMessageAt = fixtureNow - 24 * 60 * 60_000L,
                    lastReviewedAt = fixtureNow - 24 * 60 * 60_000L,
                ),
                Session(
                    "session-inbox",
                    "Rename incoming documents",
                    "project-inbox",
                    SessionStatus.Idle,
                    latestSeq = 2,
                    updatedAt = fixtureNow - 2 * 24 * 60 * 60_000L,
                ),
            ),
            selectedProjectId = "project-operations",
        )
    }

    private fun tabletProjectsReferenceState() = projectsReferenceState().copy(
        chatOpen = true,
        sessionId = "session-cleanup",
        sessionTitle = "Clean up weekly exports",
        connection = AgentConnectionStatus.Connected,
        runStatus = AgentRunStatus.Working,
        timelineItems = listOf(
            TimelineItem.Message(
                id = "tablet-message",
                seq = 1,
                role = TimelineRole.Agent,
                text = "I am checking the latest export files.",
                completed = false,
            ),
        ),
    )

    private fun runningState(): WorkbenchUiState = WorkbenchUiState(
        chatOpen = true,
        sessionId = "session-running",
        connection = AgentConnectionStatus.Connected,
        runStatus = AgentRunStatus.Working,
        sessionTitle = "Refactor network layer",
        timelineItems = listOf(
            TimelineItem.Operation(
                id = "op1",
                seq = 1,
                kind = TimelineOperationKind.Command,
                title = "npm test",
                detail = "npx vitest run",
                status = TimelineOperationStatus.InProgress,
            ),
            TimelineItem.Message(id = "s", seq = 2, role = TimelineRole.Agent, text = "Running the test suite…", completed = false),
            TimelineItem.Message(id = "u", seq = 3, role = TimelineRole.User, text = "check tests", completed = true),
            TimelineItem.Message(id = "c", seq = 4, role = TimelineRole.Agent, text = "All 42 tests passed.", completed = true),
        ),
    )

    private fun approvalState(): WorkbenchUiState = runningState().copy(
        runStatus = AgentRunStatus.WaitingApproval,
        sessionTitle = "Publish weekly report",
        approval = PermissionRequestUiState(
            id = "approval-1",
            title = "Approve file upload",
            reason = "Ragent is ready to upload the final report to the shared workspace.",
            saferAlternative = "Review the generated report before allowing the upload.",
        ),
    )

    private fun completedState(): WorkbenchUiState = runningState().copy(
        sessionId = "session-completed",
        runStatus = AgentRunStatus.Completed,
        sessionTitle = "Refactor Markdown Theme",
        timelineItems = listOf(
            TimelineItem.Message(
                id = "u2",
                seq = 1,
                role = TimelineRole.User,
                text = "请重构 Markdown 消息流排版，接入 Typora / GitHub 风格的行内代码与层级节律，并执行真机回归。",
                completed = true,
            ),
            TimelineItem.Operation(
                id = "op2",
                seq = 2,
                kind = TimelineOperationKind.FileEdit,
                title = "AgentMarkdown.kt",
                detail = "core/agentui/src/main/kotlin/com/andysagent/ragent/core/agentui/AgentMarkdown.kt",
                status = TimelineOperationStatus.Completed,
            ),
            TimelineItem.Message(
                id = "c2",
                seq = 3,
                role = TimelineRole.Agent,
                text = """
                    ## 重构完成：Typora GitHub 风格排版

                    已全面重构 **AgentoMarkdownTheme v1** 的行内代码与会话流间距系统：

                    * **行内代码胶囊**：采用 `0.85em`（13.5sp）等宽字体混排，设置 `4.5dp` 平滑圆角与 `rgba(175, 184, 193, 0.2)` 中性底色，通过 `2.5sp` 垂直边距消除高度拉伸与毛坯补丁感。
                    * **语义紧密吸附**：标题到下文收紧至 `7dp`，段落间保留 `12dp` 黄金呼吸节奏。
                    * **流式增量支持**：在 `StreamingAccumulator.consume()` 解析过程中，AST 节点平滑挂载。

                    ```kotlin
                    // AgentoMarkdownTokens.kt - Typora GitHub 风格
                    val InlineCodeRadius = 4.5.dp
                    val InlineCodeBgLight = Color(0xFFEFF1F4)
                    val InlineCodeTextLight = Color(0xFF1F2328)
                    ```

                    所有单元测试与真机截屏测试已全部通过，可随时交付体验。
                """.trimIndent(),
                completed = true,
            ),
        ),
    )

    private fun userMarkdownMessageState(): WorkbenchUiState = completedState().copy(
        sessionId = "session-user-markdown",
        sessionTitle = "Verify Markdown input",
        timelineItems = listOf(
            TimelineItem.Message(
                id = "u-markdown",
                seq = 1,
                role = TimelineRole.User,
                text = "先检查 `healthz`\n**再运行测试**\n~~不要折叠单回车~~",
                completed = true,
            ),
            TimelineItem.Message(
                id = "c-markdown",
                seq = 2,
                role = TimelineRole.Agent,
                text = "已收到，正在验证。",
                completed = true,
            ),
        ),
    )

    private fun markdownStressState(): WorkbenchUiState = runningState().copy(
        sessionId = "session-markdown-stress",
        runStatus = AgentRunStatus.Completed,
        sessionTitle = "Markdown Theme Verification",
        timelineItems = listOf(
            TimelineItem.Message(id = "u-stress", seq = 1, role = TimelineRole.User, text = "请执行 AgentoMarkdownTheme v1 全要素视觉回归测试", completed = true),
            TimelineItem.Message(id = "c-stress", seq = 2, role = TimelineRole.Agent, text = com.andysagent.ragent.core.agentui.STRESS_TEST_MARKDOWN, completed = true),
        ),
    )

    private fun inlineCodeWrapState(): WorkbenchUiState = runningState().copy(
        sessionId = "session-inline-code-wrap",
        runStatus = AgentRunStatus.Completed,
        sessionTitle = "Inline Code Wrap Verification",
        timelineItems = listOf(
            TimelineItem.Message(id = "u-wrap", seq = 1, role = TimelineRole.User, text = "验证跨行 inline code 背景的分段绘制", completed = true),
            TimelineItem.Message(id = "c-wrap", seq = 2, role = TimelineRole.Agent, text = com.andysagent.ragent.core.agentui.INLINE_CODE_WRAP_MARKDOWN, completed = true),
        ),
    )

    private fun markdownStreamingState(): WorkbenchUiState = runningState().copy(
        sessionId = "session-markdown-streaming",
        runStatus = AgentRunStatus.Working,
        sessionTitle = "Markdown Stream",
        timelineItems = listOf(
            TimelineItem.Message(id = "u-stream", seq = 1, role = TimelineRole.User, text = "实时流式输出测试", completed = true),
            TimelineItem.Message(id = "c-stream", seq = 2, role = TimelineRole.Agent, text = "### 实时解析流\n\n正在调用 `StreamingAccumulator.consume()` 解析增量 AST 节点并锁定基线…", completed = false),
        ),
    )

    private fun homeState(): WorkbenchUiState = WorkbenchUiState(
        destination = AgentoDestination.Home,
        connection = AgentConnectionStatus.Connected,
        computers = listOf(Computer("computer-windows", "Office PC", "Windows", connected = true)),
        sessions = listOf(
            Session("session-waiting", "Review the monthly export", status = SessionStatus.WaitingApproval, latestSeq = 10),
            Session("session-running", "Clean up weekly exports", status = SessionStatus.Working, latestSeq = 9),
            Session("session-complete", "Prepare the quarterly report", status = SessionStatus.Completed, latestSeq = 8),
        ),
    )
}
