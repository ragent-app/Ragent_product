package com.andysagent.ragent

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.datastore.*
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.*
import com.andysagent.ragent.feature.appapi.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.Locale

/** Pure UI fixtures: no account access, network dispatch, pairing changes or remote work. */
class CaptureRedesignUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val models = listOf(RuntimeModelOption("m", "GPT-5"))
    private val draft = CaptureDraft("redesign", "owner", 0,
        input = CaptureInput("https://example.com/research\n关于移动端 AI 工作流的研究与设计笔记。", title = "移动端 AI 工作流研究"),
        instruction = "总结关键结论，整理成一份可执行的行动清单。", targetInstanceId = "mac", runtime = TaskRuntime("codex", model = "m"))
    private fun ready() = CaptureUiState(loading = false, draft = draft,
        directory = ComputerDirectory(listOf(LinkedComputer("mac", "", "MacBook Pro"), LinkedComputer("pc", "", "Windows PC"))),
        catalog = RuntimeCatalog(listOf(RuntimeToolOption("codex", "Codex", models = models))), models = models)

    @Test fun compactLightAndDarkLayoutsKeepSendReachableWithoutScrolling() {
        var dark by mutableStateOf(false)
        val events = mutableListOf<CaptureEvent>()
        compose.setContent { Chinese { RagentTheme(darkTheme = dark) { CaptureScreen(ready(), events::add) } } }
        compose.onNodeWithTag("capture-submit").assertIsDisplayed().assertIsEnabled().assertHeightIsAtLeast(48.dp)
        capture("share-redesign-light.png")
        compose.runOnIdle { dark = true }
        compose.onNodeWithTag("capture-submit").assertIsDisplayed()
        capture("share-redesign-dark.png")
        compose.runOnIdle { assertTrue(events.isEmpty()) }
    }

    @Test fun largeTextAndLongMaterialDoNotPushTheSendActionOffscreen() {
        val longState = ready().copy(draft = draft.copy(input = draft.input.copy(sharedText = "A long reference line. ".repeat(900))))
        compose.setContent { CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 1.8f)) {
            RagentTheme(darkTheme = false) { CaptureScreen(longState, {}) }
        } }
        compose.onNodeWithTag("capture-submit").assertIsDisplayed()
        compose.onNodeWithTag("capture-computer").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("capture-submit").assertIsDisplayed()
        capture("share-redesign-large-text.png")
    }

    @Test fun suggestionsOnlyEditInstructionAndDoNotSubmit() {
        val events = mutableListOf<CaptureEvent>()
        var state by mutableStateOf(ready().copy(draft = draft.copy(instruction = "")))
        compose.setContent { RagentTheme { CaptureScreen(state, onEvent = { event ->
            events += event
            if (event is CaptureEvent.Instruction) state = state.copy(draft = state.draft!!.copy(instruction = event.value))
        }) } }
        compose.onNodeWithTag("capture-submit").assertIsNotEnabled()
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.share_suggest_summary)).performScrollTo().performClick()
        compose.onNodeWithTag("capture-submit").assertIsEnabled()
        compose.runOnIdle { assertEquals(1, events.size); assertTrue(events.single() is CaptureEvent.Instruction) }
    }

    @Test fun sheetsPreserveDraftAndExposeSelectionWithoutSending() {
        val events = mutableListOf<CaptureEvent>()
        compose.setContent { Chinese { RagentTheme { CaptureScreen(ready(), events::add) } } }
        compose.onNodeWithTag("capture-computer").performScrollTo().performClick()
        compose.onNode(hasText("MacBook Pro") and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.RadioButton)).assertIsSelected()
        compose.onNodeWithTag("capture-sheet-done").assertTextEquals("完成")
        capture("share-redesign-computers.png")
        compose.onNodeWithTag("capture-sheet-done").performClick()
        compose.onNodeWithTag("capture-runtime").performScrollTo().performClick()
        compose.onNode(hasText("GPT-5") and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.RadioButton)).assertIsSelected()
        compose.onNodeWithTag("capture-sheet-done").assertTextEquals("完成")
        capture("share-redesign-models.png")
        compose.onNodeWithTag("capture-sheet-done").performClick()
        compose.runOnIdle { assertTrue(events.isEmpty()) }
    }

    @Test fun computerPickerShowsIndependentPastConnectionChecksAndChecksChosenTargetExplicitly() {
        val events = mutableListOf<CaptureEvent>()
        val state = ready().copy(connectionObservations = mapOf(
            "mac" to CaptureConnectionObservation("mac", CaptureConnectionStatus.AVAILABLE, 1_700_000_000_000),
            "pc" to CaptureConnectionObservation("pc", CaptureConnectionStatus.UNREACHABLE, 1_700_000_000_100)),
            staleConnectionTargets = setOf("pc"))
        compose.setContent { Chinese { RagentTheme { CaptureScreen(state, events::add) } } }
        compose.onNodeWithTag("capture-computer").performScrollTo().performClick()
        compose.onNodeWithTag("capture-connection-check-mac").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithTag("capture-connection-check-pc").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("上次检查时连接可用").assertIsDisplayed()
        compose.onNodeWithText("检查记录已过期，请重新检查").assertIsDisplayed()
        compose.onNodeWithTag("capture-connection-check-pc").performClick()
        compose.runOnIdle {
            assertEquals(listOf(CaptureEvent.CheckTargetConnection("pc")), events)
        }
        compose.onNodeWithTag("capture-submit").assertIsDisplayed()
    }

    @Test fun backgroundDeliveryIsASeparateExplicitActionAndUnavailableToSelectionReturnFlow() {
        val events = mutableListOf<CaptureEvent>()
        var state by mutableStateOf(ready().copy(supportsBackgroundDelivery = true))
        compose.setContent { Chinese { RagentTheme { CaptureScreen(state, events::add) } } }
        compose.onNodeWithTag("capture-submit").assertIsEnabled()
        compose.onNodeWithTag("capture-submit-background").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithTag("capture-submit-background").performClick()
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.SubmitInBackground), events) }

        compose.runOnIdle {
            events.clear()
            state = state.copy(selectionMode = CaptureSelectionMode.REPLACEABLE)
        }
        compose.onNodeWithTag("capture-submit-background").assertDoesNotExist()
        compose.runOnIdle { assertTrue(events.isEmpty()) }
    }

    @Test fun keyboardKeepsSendVisibleAndDoesNotSendOnTextEntry() {
        val events = mutableListOf<CaptureEvent>()
        compose.activityRule.scenario.onActivity { it.window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE) }
        var state by mutableStateOf(ready())
        compose.setContent { RagentTheme { CaptureScreen(state, { event ->
            events += event
            if (event is CaptureEvent.Instruction) state = state.copy(draft = state.draft!!.copy(instruction = event.value))
        }) } }
        compose.onNodeWithTag("capture-instruction").performScrollTo().performClick().performTextInput(" More detail")
        compose.waitUntil(5_000) {
            // IME visibility may precede Compose's resized layout during the system animation.
            androidx.core.view.ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
                ?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()) == true &&
                runCatching { compose.onNodeWithTag("capture-submit").assertIsDisplayed() }.isSuccess
        }
        compose.onNodeWithTag("capture-submit").assertIsDisplayed()
        capture("share-redesign-keyboard.png")
        val visibleWindow = android.graphics.Rect()
        val windowOrigin = IntArray(2)
        compose.activity.window.decorView.getWindowVisibleDisplayFrame(visibleWindow)
        compose.activity.window.decorView.getLocationOnScreen(windowOrigin)
        val sendBottom = compose.onNodeWithTag("capture-submit").fetchSemanticsNode().boundsInWindow.bottom + windowOrigin[1]
        assertTrue("Send action must sit above the visible keyboard: $sendBottom <= ${visibleWindow.bottom}", sendBottom <= visibleWindow.bottom + 1)
        compose.runOnIdle { assertTrue(events.none { it == CaptureEvent.Submit }) }
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        compose.onNodeWithTag("capture-instruction").assertTextContains("More detail", substring = true)
        compose.onNodeWithTag("capture-computer").performScrollTo().assertIsDisplayed()
    }

    @Test fun unresolvedFileAndOfflineErrorHaveVisibleRecoveryWithoutSending() {
        val state = ready().copy(error = ApiErrorCode.TARGET_OFFLINE, draft = draft.copy(input = draft.input.copy(
            resources = listOf(CaptureResourceRef("report", 1, "季度分析.pdf", "application/pdf", 235_000, "a".repeat(64))),
            imports = listOf(CaptureImportSlot("failed", name = "预算.xlsx", error = ApiErrorCode.PERMISSION_DENIED)))))
        compose.setContent { Chinese { RagentTheme { CaptureScreen(state, {}) } } }
        compose.onNodeWithTag("capture-submit").assertIsNotEnabled().assertIsDisplayed()
        capture("share-redesign-import-error.png")
    }

    @Test fun localImportShowsMeasuredOrUnknownProgressAndKeepsSendUnavailable() {
        val events = mutableListOf<CaptureEvent>()
        var progress by mutableStateOf(CaptureImportProgress("current", "Report.pdf", 1_000_000, 2_000_000))
        val state = ready().copy(busy = true, draft = draft.copy(input = CaptureInput(
            imports = listOf(CaptureImportSlot("current"), CaptureImportSlot("next", name = "Notes.txt")))))
        compose.setContent { Chinese { RagentTheme { CaptureScreen(state.copy(importProgress = progress), events::add) } } }
        compose.onNodeWithText("正在将材料复制到此手机，尚未发送到电脑。").assertIsDisplayed()
        compose.onNodeWithText("Report.pdf").assertIsDisplayed()
        compose.onNodeWithText("等待复制到手机").assertIsDisplayed()
        compose.onNodeWithTag("capture-material-edit").assertDoesNotExist()
        val half = SemanticsMatcher.expectValue(SemanticsProperties.ProgressBarRangeInfo, ProgressBarRangeInfo(0.5f, 0f..1f))
        compose.onNode(half).assertIsDisplayed()
        compose.onNodeWithTag("capture-submit").assertDoesNotExist()
        capture("share-import-measured.png")
        compose.runOnIdle { progress = progress.copy(totalBytes = null) }
        compose.onNodeWithText("总大小未知", substring = true).assertIsDisplayed()
        compose.onNode(half).assertDoesNotExist()
        capture("share-import-unknown.png")
        compose.runOnIdle { progress = progress.copy(phase = CaptureImportPhase.SAVING) }
        compose.onNodeWithText("正在完成本机保存", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("capture-submit").assertDoesNotExist()
        compose.runOnIdle { assertTrue(events.isEmpty()) }
    }

    @Test fun uploadShowsVerifiedTotalsAndNeverEquatesWrittenBytesWithTaskAcceptance() {
        val file = CaptureResourceRef("upload-one", 1, "Report.pdf", "application/pdf", 2_000_000, "a".repeat(64))
        val frozen = draft.copy(operationId = "upload-op", input = CaptureInput(resources = listOf(file)))
        var progress by mutableStateOf(TaskUploadProgress("upload-op", "mac", file.resourceId, file.originalName,
            0, 1, 0, file.sizeBytes, TaskUploadPhase.TRANSFERRING, file.sizeBytes, 1_000_000))
        val events = mutableListOf<CaptureEvent>()
        compose.setContent { Chinese { RagentTheme { CaptureScreen(ready().copy(draft = frozen,
            busy = true, uploadProgress = progress), events::add) } } }
        compose.onNodeWithText("电脑已确认：0 / 1 个文件", substring = true).assertIsDisplayed()
        compose.onAllNodesWithText("正在传输任务材料…").assertCountEquals(2)
        compose.onNodeWithText("请继续原提交以恢复", substring = true).assertDoesNotExist()
        val half = SemanticsMatcher.expectValue(SemanticsProperties.ProgressBarRangeInfo, ProgressBarRangeInfo(0.5f, 0f..1f))
        compose.onNode(half).assertIsDisplayed()
        compose.onNodeWithText("文件传输完成不代表任务已接受或执行完成。").assertIsDisplayed()
        capture("share-upload-measured.png")
        compose.runOnIdle { progress = progress.copy(writtenBytes = null) }
        compose.onNode(half).assertDoesNotExist()
        compose.onNodeWithText("已写入本机连接", substring = true).assertDoesNotExist()
        capture("share-upload-unmeasured.png")
        compose.runOnIdle { progress = progress.copy(phase = TaskUploadPhase.VERIFYING) }
        compose.onNodeWithText("正在等待电脑校验此文件…").assertIsDisplayed()
        compose.runOnIdle { progress = progress.copy(phase = TaskUploadPhase.CONFIRMED, confirmedFiles = 1, confirmedBytes = file.sizeBytes) }
        compose.onAllNodesWithText("附件已确认，正在提交任务…").assertCountEquals(2)
        compose.onNodeWithText("电脑已确认：1 / 1 个文件", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("capture-submit").assertDoesNotExist()
        compose.runOnIdle { assertTrue(events.isEmpty()) }
    }

    @Test fun connectionCheckShowsPastObservationAndExpiryWithoutImplyingLivePresence() {
        val events = mutableListOf<CaptureEvent>()
        var state by mutableStateOf(ready())
        compose.setContent { Chinese { RagentTheme { CaptureScreen(state, events::add) } } }
        compose.onNodeWithTag("capture-connection-check").performScrollTo().assertIsEnabled().assertHeightIsAtLeast(48.dp)
        compose.onNodeWithText("已配对，尚未检查连接").assertIsDisplayed()
        compose.onNodeWithTag("capture-connection-check").performClick()
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.CheckConnection), events); state = state.copy(checkingConnection = true) }
        compose.onNodeWithTag("capture-connection-check").assertIsNotEnabled()
        compose.onNodeWithText("正在检查配对连接…").assertIsDisplayed()
        compose.runOnIdle { state = state.copy(checkingConnection = false,
            connectionObservation = CaptureConnectionObservation("mac", CaptureConnectionStatus.AVAILABLE, 1_700_000_000_000)) }
        // The completed observation adds a timestamp below the previously visible button.
        compose.onNodeWithTag("capture-connection-status").performScrollTo()
        compose.onNodeWithText("上次检查时连接可用").assertIsDisplayed()
        compose.onNodeWithText("检查时间：", substring = true).assertIsDisplayed()
        capture("share-connection-observed.png")
        compose.runOnIdle { state = state.copy(connectionObservationStale = true) }
        compose.onNodeWithText("检查记录已过期，请重新检查").assertIsDisplayed()
        compose.onNodeWithText("上次检查时连接可用").assertDoesNotExist()
        capture("share-connection-expired.png")
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.CheckConnection), events) }
    }

    @Test fun restoredRuntimeIsExplainedWhileSendingStillRequiresAnExplicitAction() {
        val events = mutableListOf<CaptureEvent>()
        compose.setContent { Chinese { RagentTheme { CaptureScreen(ready().copy(runtimeRestored = true), events::add) } } }
        compose.onNodeWithText("已恢复这台电脑上次选择的 Agent 与模型。").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("capture-submit").assertIsDisplayed().assertIsEnabled()
        capture("share-runtime-restored.png")
        compose.runOnIdle { assertTrue(events.isEmpty()) }
    }

    @Composable private fun Chinese(content: @Composable () -> Unit) {
        val base = LocalContext.current
        val configuration = remember { Configuration(base.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) } }
        val context = remember { base.createConfigurationContext(configuration) }
        CompositionLocalProvider(LocalContext provides context, LocalConfiguration provides configuration, content = content)
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        // Platform dialog/IME surface animations run outside the Compose test clock.
        android.os.SystemClock.sleep(400)
        val bitmap = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        File(compose.activity.cacheDir, name).outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    }
}
