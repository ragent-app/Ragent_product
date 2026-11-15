package com.andysagent.ragent

import android.content.*
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.datastore.*
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.*
import com.andysagent.ragent.feature.appapi.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class CaptureShareUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private fun text(id: Int) = compose.activity.getString(id)
    private val draft = CaptureDraft("draft", "owner", 0, input = CaptureInput("Original source"), instruction = "Instruction", targetInstanceId = "b", runtime = TaskRuntime("tool", model = "model"))
    private fun state() = CaptureUiState(loading = false, draft = draft,
        directory = ComputerDirectory(listOf(LinkedComputer("a", "", "Office"), LinkedComputer("b", "", "Home"))),
        catalog = RuntimeCatalog(listOf(RuntimeToolOption("tool", "Execution tool", models = listOf(RuntimeModelOption("model", "Available model"))))), models = listOf(RuntimeModelOption("model", "Available model")))

    @Test fun editableSourceInstructionsAndChoicesEmitLabeledEvents() {
        val events = mutableListOf<CaptureEvent>()
        var current by mutableStateOf(state())
        compose.setContent { RagentTheme { CaptureScreen(current, { event ->
            events += event
            when (event) {
                is CaptureEvent.SourceText -> current = current.copy(draft = current.draft!!.copy(input = current.draft!!.input.copy(sharedText = event.value)))
                is CaptureEvent.Instruction -> current = current.copy(draft = current.draft!!.copy(instruction = event.value))
                is CaptureEvent.Target -> current = current.copy(draft = current.draft!!.copy(targetInstanceId = event.id))
                else -> Unit
            }
        }) } }
        compose.onNodeWithTag("capture-material-edit").performScrollTo().performClick()
        compose.onNodeWithContentDescription(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_source)).performTextReplacement("New reference")
        closeSoftKeyboard()
        compose.onNodeWithTag("capture-sheet-done").performClick()
        compose.onNodeWithContentDescription(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_instruction)).performTextReplacement("Analyze reference")
        closeSoftKeyboard()
        compose.onNodeWithTag("capture-computer").performScrollTo().performClick()
        compose.onNode(hasText("Home") and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.RadioButton)).assertIsSelected()
        compose.onNode(hasText("Office") and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.RadioButton)).assertIsNotSelected().performScrollTo().performClick().assertIsSelected()

        compose.onNode(hasText("Home") and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.RadioButton)).assertIsNotSelected()
        compose.onNodeWithTag("capture-sheet-done").performClick()
        compose.onNodeWithTag("capture-runtime").performScrollTo().performClick()
        compose.onNode(hasText("Available model") and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.RadioButton)).performScrollTo().assertIsSelected().performClick()
        compose.onNodeWithTag("capture-sheet-done").performClick()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_submit)).assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_title)).assertIsDisplayed()
        screenshot("appapi-capture-light.png")
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.SourceText("New reference"), CaptureEvent.Instruction("Analyze reference"), CaptureEvent.Target("a"), CaptureEvent.Model("model"), CaptureEvent.Submit), events) }
    }
    @Test fun pinRequestIsSeparateFromSubmitAndUnavailableShortcutKeepsChoiceVisible() {
        val events = mutableListOf<CaptureEvent>()
        var current by mutableStateOf(state())
        compose.setContent { RagentTheme { CaptureScreen(current, events::add) } }
        val pin = text(com.andysagent.ragent.feature.appapi.R.string.api_capture_pin)
        compose.onNodeWithTag("capture-computer").performScrollTo().performClick()
        compose.onNodeWithText(pin).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.PinTarget), events); current = current.copy(pinResult = CapturePinResult.REQUESTED) }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_pin_requested)).performScrollTo().assertIsDisplayed()
        screenshot("appapi-capture-pin-request.png")
        compose.runOnIdle { current = current.copy(draft = current.draft!!.copy(targetInstanceId = null, requireTargetSelection = true)) }
        compose.onNodeWithTag("capture-sheet-done").performClick()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_shortcut_unavailable)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(pin).assertDoesNotExist()
    }

    @Test fun busyStateDisablesTargetEditsAndAllowsOnlyStoppingLocalWait() {
        val events = mutableListOf<CaptureEvent>()
        compose.setContent { RagentTheme { CaptureScreen(state().copy(busy = true), events::add) } }
        compose.onNodeWithTag("capture-computer").performScrollTo().assertIsNotEnabled().performTouchInput { click() }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_submit)).assertDoesNotExist()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_stop_waiting)).assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.StopWaiting), events) }
    }
    @Test fun savedFileMetadataIsVisibleAndOnlyEditableDraftCanRemoveIt() {
        val events = mutableListOf<CaptureEvent>()
        val file = CaptureResourceRef("file-one", 1, "sample.csv", "text/csv", 1024, "a".repeat(64))
        var current by mutableStateOf(state().copy(draft = draft.copy(input = draft.input.copy(resources = listOf(file)))))
        compose.setContent { RagentTheme { CaptureScreen(current, events::add) } }
        val remove = compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_capture_remove_file, file.originalName)
        compose.onNodeWithText(file.originalName).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("${file.mimeType} · ${android.text.format.Formatter.formatShortFileSize(compose.activity, file.sizeBytes)}").assertIsDisplayed()
        compose.onNodeWithContentDescription(remove).performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        screenshot("appapi-capture-private-file.png")
        compose.runOnIdle { current = current.copy(busy = true) }
        compose.onNodeWithContentDescription(remove).performScrollTo().assertIsNotEnabled()
        compose.runOnIdle { current = current.copy(busy = false, draft = current.draft!!.copy(operationId = "capture_draft")) }
        compose.onNodeWithContentDescription(remove).assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.RemoveResource(file.resourceId)), events) }
    }
    @Test fun incompleteFileDisablesSubmitAndRequiresExplicitRemoval() {
        val events = mutableListOf<CaptureEvent>()
        val slot = CaptureImportSlot("failed", error = ApiErrorCode.PERMISSION_DENIED)
        compose.setContent { RagentTheme { CaptureScreen(state().copy(draft = draft.copy(input = draft.input.copy(imports = listOf(slot)))), events::add) } }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_submit)).assertIsNotEnabled()
        val label = compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_capture_skip_file,
            compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_capture_import_file, 1))
        compose.onNodeWithText(label).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.RemoveImport(slot.resourceId)), events) }
    }
    @Test fun unknownReceiptOffersReadOnlyCheckAndExplicitCopyWithoutResubmit() {
        val events = mutableListOf<CaptureEvent>()
        val request = draft.copy(operationId = "capture_draft").toTaskRequest()
        val operation = TaskOperation("capture_draft", "owner", "hash", "prep", "b", request, "create", "message", 0, 600_000, stage = OperationStage.SUBMITTING, sessionId = "session")
        compose.setContent { RagentTheme(darkTheme = true) { CaptureScreen(state().copy(draft = draft.copy(operationId = "capture_draft"), operation = operation), events::add) } }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_submit)).assertDoesNotExist()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_cancel_submission)).assertDoesNotExist()
        compose.onNode(hasText("Office") and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.RadioButton)).assertDoesNotExist()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_check_receipt)).performScrollTo().performClick()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_copy)).performScrollTo().performClick()
        screenshot("appapi-capture-unknown-dark.png")
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.CheckReceipt, CaptureEvent.CopyAsNew), events) }
    }
    @Test fun inboxOpensSavedIdentityAndFrozenEvidenceHasNoDeleteControl() {
        val opened = mutableListOf<String>(); val deleted = mutableListOf<CaptureDraft>()
        val editable = draft.copy(input = draft.input.copy(title = "Saved draft"))
        val frozen = draft.copy(draftId = "frozen", operationId = "capture_frozen", input = draft.input.copy(title = "Original submission"))
        compose.setContent { RagentTheme { DraftInboxScreen(DraftInboxUiState(loading = false, drafts = listOf(editable, frozen)), opened::add, deleted::add, {}, {}) } }
        compose.onNodeWithText("Saved draft").performClick()
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_capture_delete, "Saved draft")).performClick()
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_confirm)).performClick()
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_capture_delete, "Original submission")).assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("draft"), opened); assertEquals(listOf(editable), deleted) }
    }
    @Test fun unreadableRoutingOpensRepairAndOnlyPreMessageStageCanCancel() {
        val events = mutableListOf<CaptureEvent>()
        var current by mutableStateOf(state().copy(directory = state().directory.copy(appApiRouting = AppApiRoutingPreferences(readable = false))))
        compose.setContent { RagentTheme { CaptureScreen(current, events::add) } }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_submit)).assertIsNotEnabled()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_routing_title)).performScrollTo().performClick()
        val frozen = draft.copy(operationId = "capture_draft")
        compose.runOnIdle { current = state().copy(draft = frozen,
            operation = TaskOperation("capture_draft", "owner", "hash", "prep", "b", frozen.toTaskRequest(), "create", "message", 0, 600_000, stage = OperationStage.CONNECTING)) }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_cancel_submission)).performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.OpenRoutingSettings, CaptureEvent.CancelSubmission), events) }
    }
    @Test fun shareParserRetainsMixedResourcesAndIgnoresAuthorizationExtras() {
        val original = "Reference https://example.com/a and https://example.org/b"
        val intent = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, original)
            .putExtra("callerBinding", "owner").putExtra("confirmed", true).putExtra("autoStart", true)
            .putExtra("EXTRA_TARGET_DEVICE_ID", "attacker-target").putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, "forged")
        val input = readSharedCapture(intent).input!!
        assertEquals(original, input.sharedText); assertEquals(2, input.sourceUrls.size)
        val clipText = Intent(Intent.ACTION_SEND).setType("text/plain").apply { clipData = ClipData.newPlainText("text", "Clipboard reference") }
        assertEquals("Clipboard reference", readSharedCapture(clipText).input!!.sharedText)
        val htmlOnly = Intent(Intent.ACTION_SEND).setType("text/html")
            .putExtra(Intent.EXTRA_HTML_TEXT, "<p>Summarize <b>this</b> <a href=\"https://example.org/source\">source</a></p>")
        val htmlInput = readSharedCapture(htmlOnly).input!!
        assertEquals("Summarize this source\n\nhttps://example.org/source", htmlInput.sharedText)
        assertEquals(listOf("https://example.org/source"), htmlInput.sourceUrls)
        assertEquals("Plain fallback", readSharedCapture(Intent(htmlOnly)
            .putExtra(Intent.EXTRA_TEXT, "Plain fallback")).input!!.sharedText)
        assertEquals(ApiErrorCode.INVALID_ARGUMENT, failure(Intent(Intent.ACTION_SEND).setType("text/html")
            .putExtra(Intent.EXTRA_HTML_TEXT, "x".repeat(256 * 1024 + 1))))
        val mixed = Intent(intent).apply { clipData = ClipData.newUri(compose.activity.contentResolver, "file", Uri.parse("content://other/file")) }
        assertEquals(1, readSharedCapture(mixed).input!!.imports.size)
        assertEquals(1, readSharedCapture(Intent(intent).putExtra(Intent.EXTRA_STREAM, Uri.parse("content://other/file"))).content.size)
        assertEquals(ApiErrorCode.INVALID_ARGUMENT, failure(Intent(Intent.ACTION_SEND_MULTIPLE).setType("text/plain")))
        assertEquals(ApiErrorCode.INVALID_ARGUMENT, failure(Intent(intent).putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///private/file"))))
        assertEquals(ApiErrorCode.INVALID_ARGUMENT, failure(Intent(Intent.ACTION_SEND).setType("text/plain")))
        @Suppress("DEPRECATION")
        val router = compose.activity.packageManager.getActivityInfo(ComponentName(compose.activity, ShareRouterActivity::class.java), PackageManager.GET_META_DATA)
        assertTrue(router.exported)
        for (activity in listOf(ShareReceiverActivity::class.java, ShareDraftActivity::class.java, DraftInboxActivity::class.java)) {
            @Suppress("DEPRECATION") val info = compose.activity.packageManager.getActivityInfo(ComponentName(compose.activity, activity), 0)
            assertFalse(info.exported)
        }
    }
    @Test fun resultQueryShowsOnlyPublishedSnapshotAndMarksPreviewAndFiles() {
        val events = mutableListOf<CaptureEvent>()
        val result = TaskResultSnapshot("session", "request", "run", "run", TaskResultState.READY,
            "Synthetic exact final result", true, listOf(TaskResultArtifact("fasset_${"a".repeat(24)}", "report.txt", "text/plain", 42)),
            "2026-10-11T00:00:00Z", hasAttachments = true)
        val operation = TaskOperation("capture_draft", "owner", "hash", "prep", "b",
            TaskRequest("capture_draft", "Instruction", TaskRuntime("tool")), "create", "request", 0, 10,
            stage = OperationStage.ACCEPTED, sessionId = "session", runId = "run", result = result)
        compose.setContent { RagentTheme { CaptureScreen(state().copy(draft = draft.copy(operationId = "capture_draft"), operation = operation), events::add) } }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_check_result)).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.CheckResult), events) }
        compose.onNodeWithText("Synthetic exact final result").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_result_truncated)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_result_files)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("report.txt").performScrollTo().assertIsDisplayed()
        screenshot("appapi-capture-result.png")
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_submit)).assertDoesNotExist()
    }

    @Test fun selectedTextReturnAndViewSavedAreExplicitAndInvalidPreviewCannotReturn() {
        val events = mutableListOf<CaptureEvent>()
        val result = TaskResultSnapshot("session", "request", "run", "run", TaskResultState.READY,
            "Complete replacement", false, emptyList(), "2026-10-11T00:00:00Z")
        val operation = TaskOperation("capture_draft", "owner", "hash", "prep", "b",
            TaskRequest("capture_draft", "Instruction", TaskRuntime("tool")), "create", "request", 0, 10,
            stage = OperationStage.ACCEPTED, sessionId = "session", runId = "run", result = result)
        var current by mutableStateOf(state().copy(draft = draft.copy(operationId = "capture_draft"), operation = operation,
            selectionMode = CaptureSelectionMode.REPLACEABLE))
        compose.setContent { RagentTheme { CaptureScreen(current, events::add) } }
        val replace = text(com.andysagent.ragent.feature.appapi.R.string.api_selection_replace)
        compose.onNodeWithText(replace).assertIsDisplayed().performClick()
        screenshot("appapi-selection-ready.png")
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_selection_view_saved)).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(CaptureEvent.ReturnSelection, CaptureEvent.ViewSavedTask), events)
            current = current.copy(operation = operation.copy(result = result.copy(textTruncated = true))) }
        compose.onNodeWithText(replace).assertDoesNotExist()
        compose.runOnIdle { current = current.copy(operation = operation, selectionMode = CaptureSelectionMode.READ_ONLY) }
        compose.onNodeWithText(replace).assertDoesNotExist()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_selection_readonly)).performScrollTo().assertIsDisplayed()
        screenshot("appapi-selection-readonly.png")
    }

    private fun failure(intent: Intent): ApiErrorCode = try { readSharedCapture(intent); error("Expected rejection") } catch (failure: AppApiException) { failure.error.code }
    private fun screenshot(name: String) {
        // Platform dialog/IME surface animations run outside the Compose test clock.
        android.os.SystemClock.sleep(400)
        val bitmap = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        File(compose.activity.cacheDir, name).outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    }
}
