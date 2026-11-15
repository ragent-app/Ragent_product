package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.appapi.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ResultOutputsUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val row = SavedResultRow("file", "text", "revision", 3, "Report.txt", "text/plain", 100, 100, ResultOutputState.READY)
    private fun snapshot(file: SavedResultRow = row) = ResultOutputsSnapshot(
        ResultTaskInfo("operation", "Original PC", "session", "Task", OperationStage.ACCEPTED, null), listOf(file), emptyList())
    @Test fun readyFileHasSeparateExplicitShareSaveAndDeleteActions() {
        val events = mutableListOf<ResultOutputsEvent>()
        compose.setContent { RagentTheme { ResultOutputsScreen(ResultOutputsUiState(loading = false, snapshot = snapshot()), events::add, {}) } }
        compose.onNodeWithTag("outputs-share-file").performScrollTo().performClick()
        compose.onNodeWithTag("outputs-save-file").performScrollTo().performClick()
        compose.onNodeWithTag("outputs-delete-file").performScrollTo().performClick()
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_confirm)).performClick()
        compose.runOnIdle { assertEquals(listOf(ResultOutputsEvent.Deliver("file", ResultDeliveryAction.SHARE),
            ResultOutputsEvent.Deliver("file", ResultDeliveryAction.SAVE), ResultOutputsEvent.Delete("file")), events) }
    }
    @Test fun partialFileExposesResumeButNotSystemExport() {
        val events = mutableListOf<ResultOutputsEvent>()
        compose.setContent { RagentTheme { ResultOutputsScreen(ResultOutputsUiState(loading = false,
            snapshot = snapshot(row.copy(state = ResultOutputState.PARTIAL, receivedBytes = 20))), events::add, {}) } }
        compose.onNodeWithTag("outputs-share-file").assertDoesNotExist()
        compose.onNodeWithTag("outputs-save-file").assertDoesNotExist()
        compose.onNodeWithTag("outputs-resume-file").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(ResultOutputsEvent.Resume("file")), events) }
    }
    @Test fun busyPageDisablesMutationsAndStopIsLocalEvent() {
        val events = mutableListOf<ResultOutputsEvent>()
        compose.setContent { RagentTheme { ResultOutputsScreen(ResultOutputsUiState(loading = false, snapshot = snapshot(), busy = true), events::add, {}) } }
        compose.onNodeWithTag("outputs-share-file").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("outputs-delete-file").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("outputs-stop").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(ResultOutputsEvent.Stop), events) }
    }
    @Test fun lostAuthorizationHasNoStaleFilesOrExportControls() {
        compose.setContent { RagentTheme { ResultOutputsScreen(ResultOutputsUiState(loading = false, error = ApiErrorCode.PERMISSION_DENIED), {}, {}) } }
        compose.onNodeWithTag("outputs-file-file").assertDoesNotExist()
        compose.onNodeWithTag("outputs-share-file").assertDoesNotExist()
        compose.onNodeWithTag("outputs-refresh").performScrollTo().assertIsEnabled()
    }
    @Test fun liveProcessTextInvocationDoesNotNavigateToOutputPage() {
        val operation = TaskOperation("operation", "owner", "hash", "preparation", "pc",
            TaskRequest("operation", "Analyze", TaskRuntime("tool")), "creation", "request", 0, 10,
            stage = OperationStage.ACCEPTED, sessionId = "session")
        val draft = CaptureDraft("draft", "owner", 0, input = CaptureInput("Selected material"), instruction = "Analyze", operationId = "operation", targetInstanceId = "pc")
        compose.setContent { RagentTheme { CaptureScreen(CaptureUiState(loading = false, draft = draft,
            operation = operation, selectionMode = CaptureSelectionMode.READ_ONLY), {}) } }
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_outputs_title)).assertDoesNotExist()
    }
    @Test fun interruptedDocumentHistoryExplainsPartialWriteAndClearIsExplicit() {
        val events = mutableListOf<ResultOutputsEvent>()
        val saved = DocumentSaveRef("ticket", row.name, row.sizeBytes, DocumentSaveState.INTERRUPTED, 1, true, ApiErrorCode.RESULT_UNKNOWN)
        compose.setContent { RagentTheme { ResultOutputsScreen(ResultOutputsUiState(loading = false,
            snapshot = snapshot().copy(documentSaves = listOf(saved))), events::add, {}) } }
        compose.onNodeWithTag("outputs-document-ticket").performScrollTo().assertExists()
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_outputs_save_partial_history)).assertExists()
        compose.onNodeWithTag("outputs-clear-document-history").performScrollTo().performClick()
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_confirm)).performClick()
        compose.runOnIdle { assertEquals(listOf(ResultOutputsEvent.ClearDocumentHistory), events) }
    }
    @Test fun deleteConfirmationRejectsChangedFileAndCancelDoesNothing() {
        val current = mutableStateOf(ResultOutputsUiState(loading = false, snapshot = snapshot()))
        val events = mutableListOf<ResultOutputsEvent>()
        compose.setContent { RagentTheme { ResultOutputsScreen(current.value, events::add, {}) } }
        compose.onNodeWithTag("outputs-delete-file").performScrollTo().performClick()
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_cancel)).performClick()
        compose.runOnIdle { assertTrue(events.isEmpty()) }
        compose.onNodeWithTag("outputs-delete-file").performScrollTo().performClick()
        compose.runOnIdle { current.value = current.value.copy(snapshot = snapshot(row.copy(revision = 4))) }
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_confirm)).performClick()
        compose.runOnIdle { assertTrue(events.isEmpty()) }
    }
    @Test fun revokeRequiresConfirmation() {
        val ref = ResultDeliveryRef("ticket", "Report.txt", "text/plain", 100, 2000000000000)
        val events = mutableListOf<ResultOutputsEvent>()
        compose.setContent { RagentTheme { ResultOutputsScreen(ResultOutputsUiState(loading = false,
            snapshot = snapshot().copy(deliveries = listOf(ref))), events::add, {}) } }
        compose.onNodeWithTag("outputs-revoke-ticket").performScrollTo().performClick()
        compose.runOnIdle { assertTrue(events.isEmpty()) }
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_confirm)).performClick()
        compose.runOnIdle { assertEquals(listOf(ResultOutputsEvent.Revoke("ticket")), events) }
    }
    @Test fun expiredOutputGuidanceNeverSuggestsResubmittingPcTask() {
        compose.setContent { RagentTheme { ResultOutputsScreen(ResultOutputsUiState(loading = false,
            snapshot = snapshot(), error = ApiErrorCode.REQUEST_EXPIRED), {}, {}) } }
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_outputs_error_expired)).assertExists()
        compose.onNodeWithText(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_capture_expired)).assertDoesNotExist()
    }
}
