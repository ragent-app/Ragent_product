package com.andysagent.ragent

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.appapi.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.*
import java.io.File
import java.util.Locale

class AppApiRecordConfirmationUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val identity = InstalledCallerIdentity("example.assistant", 10011, 1, setOf("a".repeat(64)))
    private val row = PersistedCallerGrant("grant", identity, CallerGrant("caller", setOf(CapabilityRegistry.TARGETS_LIST), setOf("pc"), 2000000000000), "local", 1, 1)
    private fun text(id: Int) = rule.activity.getString(id)
    @Before fun hideChrome() { rule.runOnUiThread { rule.activity.actionBar?.hide() } }
    @Test fun callerRevokeNeedsConfirmationAndCancelDoesNotRevoke() {
        val events = mutableListOf<CallerGrantsEvent>()
        rule.setContent { RagentTheme { CallerGrantsScreen(CallerGrantsUiState(loading = false, grants = listOf(row)), events::add, {}) } }
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_access_revoke)).performScrollTo().performClick()
        rule.runOnIdle { assertTrue(events.isEmpty()) }
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_cancel)).performClick()
        rule.runOnIdle { assertTrue(events.isEmpty()) }
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_access_revoke)).performScrollTo().performClick()
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_confirm)).performClick()
        rule.runOnIdle { assertEquals(listOf(CallerGrantsEvent.Revoke("grant")), events) }
    }
    @Test fun staleCallerRecordCannotBeConfirmed() {
        val current = mutableStateOf(CallerGrantsUiState(loading = false, grants = listOf(row)))
        val events = mutableListOf<CallerGrantsEvent>()
        rule.setContent { RagentTheme { CallerGrantsScreen(current.value, events::add, {}) } }
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_access_revoke)).performScrollTo().performClick()
        rule.runOnIdle { current.value = current.value.copy(grants = listOf(row.copy(revision = row.revision + 1))) }
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_confirm)).performClick()
        rule.runOnIdle { assertTrue(events.isEmpty()) }
    }
    @Test fun assistantRemovalNeedsConfirmationAndHasLocalizedDialog() {
        val scope = AssistantDelegationScope(setOf(CapabilityRegistry.TARGETS_LIST), setOf("pc"), 2000000000000)
        val delegation = AssistantDelegation("fixture", scope, "local", 1, 1, revokedAt = 2)
        val review = AssistantDelegationReview(CallerGrantContext("local", setOf("pc")), mapOf("pc" to "Test PC"), listOf(delegation), 0)
        val events = mutableListOf<AssistantDelegationEvent>()
        val ctx = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) })
        rule.setContent { CompositionLocalProvider(LocalContext provides ctx) { RagentTheme(darkTheme = true) {
            AssistantDelegationScreen(AssistantDelegationUiState(loading = false, review = review), events::add, {})
        } } }
        rule.onNodeWithText(ctx.getString(com.andysagent.ragent.feature.appapi.R.string.api_assistant_delete)).performScrollTo().performClick()
        rule.runOnIdle { assertTrue(events.isEmpty()) }
        rule.onNodeWithText(ctx.getString(com.andysagent.ragent.feature.appapi.R.string.api_access_clear_confirm)).assertIsDisplayed()
        android.os.SystemClock.sleep(800)
        val out = File(rule.activity.getExternalFilesDir(null), "settings-appapi-visual/assistant-confirm-zh-dark.png")
        out.parentFile?.mkdirs()
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { image -> out.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }; image.recycle() }
        rule.onNodeWithText(ctx.getString(com.andysagent.ragent.feature.appapi.R.string.api_confirm)).performClick()
        rule.runOnIdle { assertEquals(listOf(AssistantDelegationEvent.DeleteRevoked("fixture")), events) }
    }
    @Test fun assistantRevokeShowsItsOwnWarning() {
        val scope = AssistantDelegationScope(setOf(CapabilityRegistry.TARGETS_LIST), setOf("pc"), 2000000000000)
        val delegation = AssistantDelegation("fixture", scope, "local", 1, 1)
        val review = AssistantDelegationReview(CallerGrantContext("local", setOf("pc")), mapOf("pc" to "Test PC"), listOf(delegation), 0)
        val events = mutableListOf<AssistantDelegationEvent>()
        rule.setContent { RagentTheme { AssistantDelegationScreen(AssistantDelegationUiState(loading = false, review = review), events::add, {}) } }
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_assistant_revoke)).performScrollTo().performClick()
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_assistant_revoke_confirm)).assertIsDisplayed()
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_confirm)).performClick()
        rule.runOnIdle { assertEquals(listOf(AssistantDelegationEvent.Revoke("fixture")), events) }
    }
    @Test fun draftDeletionRequiresConfirmationAndRejectsChangedDraft() {
        val draft = CaptureDraft("draft", "owner", 0, input = CaptureInput("shared text", title = "Example draft"))
        val current = mutableStateOf(DraftInboxUiState(loading = false, drafts = listOf(draft)))
        val deleted = mutableListOf<CaptureDraft>()
        rule.setContent { RagentTheme { DraftInboxScreen(current.value, {}, deleted::add, {}, {}) } }
        val label = rule.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_capture_delete, "Example draft")
        rule.onNodeWithText(label).performScrollTo().performClick()
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_capture_delete_confirm)).assertIsDisplayed()
        android.os.SystemClock.sleep(800)
        val out = File(rule.activity.getExternalFilesDir(null), "settings-appapi-visual/draft-confirm-en.png")
        out.parentFile?.mkdirs()
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { image -> out.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }; image.recycle() }
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_cancel)).performClick()
        rule.runOnIdle { assertTrue(deleted.isEmpty()) }
        rule.onNodeWithText(label).performScrollTo().performClick()
        rule.runOnIdle { current.value = current.value.copy(drafts = listOf(draft.copy(revision = 1))) }
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_confirm)).performClick()
        rule.runOnIdle { assertTrue(deleted.isEmpty()) }
        rule.onNodeWithText(label).performScrollTo().performClick()
        rule.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_confirm)).performClick()
        rule.runOnIdle { assertEquals(listOf(draft.copy(revision = 1)), deleted) }
    }
}
