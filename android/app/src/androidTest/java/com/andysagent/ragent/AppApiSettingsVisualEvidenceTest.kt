package com.andysagent.ragent

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.Lifecycle
import com.andysagent.ragent.core.datastore.*
import com.andysagent.ragent.core.appapi.ApiErrorCode
import com.andysagent.ragent.core.appapi.CaptureDraft
import com.andysagent.ragent.core.appapi.CaptureInput
import com.andysagent.ragent.core.appapi.OperationStage
import com.andysagent.ragent.core.appapi.ResultOutputState
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.appapi.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.Locale

/** Device screenshots use fixture state and do not access the user's accounts or pairings. */
class AppApiSettingsVisualEvidenceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    @Before fun hideChrome() { rule.runOnUiThread { rule.activity.actionBar?.hide() } }

    private fun render(locale: Locale, dark: Boolean, name: String, content: @Composable () -> Unit) {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(locale) })
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalContext provides context, LocalDensity provides Density(density.density, 1.3f)) {
                RagentTheme(darkTheme = dark) { content() }
            }
        }
        capture(name)
    }
    private fun capture(name: String) {
        rule.waitForIdle()
        rule.waitUntil(5_000) { rule.activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }
        val out = File(rule.activity.getExternalFilesDir(null), "settings-appapi-visual/$name.png")
        out.parentFile?.mkdirs()
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        check(rule.activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) { "Test activity was not foreground: $name" }
    }
    private fun routing(locale: Locale, dark: Boolean, name: String) {
        val ctx = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(locale) })
        val directory = ComputerDirectory(listOf(LinkedComputer("example", "", "Example computer")), "example", AppApiRoutingPreferences(defaultShareTargetId = "example"))
        render(locale, dark, name) {
            RoutingSettingsScreen(RoutingSettingsUiState(loading = false, directory = directory), {}, {}, {},
                onOpenGrants = {}, onOpenAssistantDelegation = {})
        }
        rule.onNodeWithText(ctx.getString(com.andysagent.ragent.feature.appapi.R.string.api_routing_title)).assertExists()
        rule.onNodeWithText("Example computer").assertIsSelected()
    }
    @Test fun english() = routing(Locale.ENGLISH, false, "routing-en")
    @Test fun simplifiedChinese() = routing(Locale.SIMPLIFIED_CHINESE, false, "routing-zh-cn")
    @Test fun traditionalChinese() = routing(Locale.TRADITIONAL_CHINESE, true, "routing-zh-tw")
    @Test fun japanese() = routing(Locale.JAPANESE, false, "routing-ja")
    @Test fun korean() = routing(Locale.KOREAN, true, "routing-ko")
    @Test fun french() = routing(Locale.FRENCH, false, "routing-fr")
    @Test fun spanish() = routing(Locale("es"), true, "routing-es")
    @Test fun draftInbox() = render(Locale.SIMPLIFIED_CHINESE, false, "drafts-zh") {
        DraftInboxScreen(DraftInboxUiState(loading = false), {}, {}, {}, {})
    }
    @Test fun draftInboxDark() = render(Locale.SIMPLIFIED_CHINESE, true, "drafts-zh-dark") {
        DraftInboxScreen(DraftInboxUiState(loading = false), {}, {}, {}, {})
    }
    @Test fun draftErrorDoesNotShowEmptyState() {
        render(Locale.ENGLISH, false, "drafts-error-en") {
            DraftInboxScreen(DraftInboxUiState(loading = false, error = ApiErrorCode.INTERNAL_ERROR), {}, {}, {}, {})
        }
        val ctx = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.ENGLISH) })
        rule.onNodeWithText(ctx.getString(com.andysagent.ragent.feature.appapi.R.string.api_capture_inbox_empty)).assertDoesNotExist()
    }
    @Test fun grants() = render(Locale.FRENCH, true, "grants-fr") {
        CallerGrantsScreen(CallerGrantsUiState(loading = false), {}, {})
    }
    @Test fun grantsLight() = render(Locale.SIMPLIFIED_CHINESE, false, "grants-zh-light") {
        CallerGrantsScreen(CallerGrantsUiState(loading = false), {}, {})
    }
    @Test fun assistant() = render(Locale.JAPANESE, false, "assistant-ja") {
        AssistantDelegationScreen(AssistantDelegationUiState(loading = false), {}, {})
    }
    @Test fun assistantDark() = render(Locale.SIMPLIFIED_CHINESE, true, "assistant-zh-dark") {
        AssistantDelegationScreen(AssistantDelegationUiState(loading = false), {}, {})
    }
    @Test fun draftEditorFrench() {
        render(Locale.FRENCH, false, "draft-editor-fr") {
            CaptureScreen(CaptureUiState(loading = false, draft = CaptureDraft("fixture", "owner", 0, input = CaptureInput("Example reference"))), {})
        }
        val ctx = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.FRENCH) })
        rule.onNodeWithText(ctx.getString(com.andysagent.ragent.feature.appapi.R.string.share_suggest_summary)).assertExists()
        rule.onNodeWithText(ctx.getString(com.andysagent.ragent.feature.appapi.R.string.share_edit_material)).assertExists()
    }
    @Test fun draftEditorJapaneseDark() = render(Locale.JAPANESE, true, "draft-editor-ja-dark") {
        CaptureScreen(CaptureUiState(loading = false, draft = CaptureDraft("fixture", "owner", 0, input = CaptureInput("Example reference"))), {})
    }
    @Test fun connectionFailureSpanish() {
        val locale = Locale("es")
        val ctx = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(locale) })
        val draft = CaptureDraft("fixture", "owner", 0, input = CaptureInput("Example"), targetInstanceId = "pc")
        val state = CaptureUiState(loading = false, draft = draft,
            directory = ComputerDirectory(listOf(LinkedComputer("pc", "", "Example computer"))),
            connectionObservation = CaptureConnectionObservation("pc", CaptureConnectionStatus.UNREACHABLE, 0))
        render(locale, true, "connection-es-before") { CaptureScreen(state, {}) }
        rule.onNodeWithTag("capture-connection-status").performScrollTo()
        rule.onNodeWithText(ctx.getString(com.andysagent.ragent.feature.appapi.R.string.share_connection_unreachable)).assertExists()
        capture("connection-es-dark")
    }
    @Test fun taskFilesFrench() {
        val locale = Locale.FRENCH
        val ctx = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(locale) })
        val file = SavedResultRow("file", "resource", "revision", 3, "Report.txt", "text/plain", 100, 100, ResultOutputState.READY)
        val snapshot = ResultOutputsSnapshot(ResultTaskInfo("operation", "PC", "session", "Example task", OperationStage.ACCEPTED, null), listOf(file), emptyList())
        render(locale, false, "task-files-fr-top") { ResultOutputsScreen(ResultOutputsUiState(loading = false, snapshot = snapshot), {}, {}) }
        rule.onNodeWithTag("outputs-file-file").performScrollTo()
        rule.onNodeWithText(ctx.getString(com.andysagent.ragent.feature.appapi.R.string.api_outputs_ready)).assertExists()
        capture("task-files-fr-ready")
        rule.onNodeWithTag("outputs-delete-file").performScrollTo().performClick()
        rule.onNodeWithText(ctx.getString(com.andysagent.ragent.feature.appapi.R.string.api_outputs_delete_confirm)).assertIsDisplayed()
        android.os.SystemClock.sleep(800)
        capture("task-files-fr-delete-confirm")
    }
    @Test fun taskFilesErrorJapaneseDark() = render(Locale.JAPANESE, true, "task-files-ja-error") {
        ResultOutputsScreen(ResultOutputsUiState(loading = false, error = ApiErrorCode.REQUEST_EXPIRED), {}, {})
    }
    @Test fun routingFrenchNarrow() = render(Locale.FRENCH, false, "routing-fr-narrow") {
        val directory = ComputerDirectory(listOf(LinkedComputer("example", "", "Example computer")), "example", AppApiRoutingPreferences(defaultShareTargetId = "example"))
        Box(Modifier.width(320.dp).fillMaxHeight()) {
            RoutingSettingsScreen(RoutingSettingsUiState(loading = false, directory = directory), {}, {}, {}, onOpenGrants = {}, onOpenAssistantDelegation = {})
        }
    }
    @Test fun taskFilesFrenchNarrow() {
        val file = SavedResultRow("file", "resource", "revision", 3, "Report.txt", "text/plain", 100, 100, ResultOutputState.READY)
        val snapshot = ResultOutputsSnapshot(ResultTaskInfo("operation", "PC", "session", "Example task", OperationStage.ACCEPTED, null), listOf(file), emptyList())
        render(Locale.FRENCH, true, "task-files-fr-narrow-top") {
            Box(Modifier.width(320.dp).fillMaxHeight()) { ResultOutputsScreen(ResultOutputsUiState(loading = false, snapshot = snapshot), {}, {}) }
        }
        rule.onNodeWithTag("outputs-file-file").performScrollTo()
        capture("task-files-fr-narrow-ready")
    }
}
