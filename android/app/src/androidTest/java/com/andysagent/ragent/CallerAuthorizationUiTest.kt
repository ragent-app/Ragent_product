package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.appapi.*
import org.junit.*
import org.junit.Assert.*

class CallerAuthorizationUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val identity = InstalledCallerIdentity("example.assistant", 10011, 1, setOf("a".repeat(64)))
    private val request = CallerConsentRequest(setOf(CapabilityRegistry.TARGETS_LIST), setOf("pc"))
    private val review = CallerConsentReview(identity, "Assistant", request, mapOf("pc" to "Office"), CallerGrantContext("local", setOf("pc")), 1)
    private fun text(id: Int) = compose.activity.getString(id)
    @Test fun emptyChoicesCannotApproveAndIdentityIsVisible() {
        val events = mutableListOf<CallerConsentEvent>()
        compose.setContent { RagentTheme { CallerConsentScreen(CallerConsentUiState(loading = false, review = review, durationMs = 3600000), events::add, {}) } }
        compose.onNodeWithText(identity.packageName).assertIsDisplayed()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_access_allow)).performScrollTo().assertIsNotEnabled()
        compose.onNodeWithContentDescription(text(com.andysagent.ragent.feature.appapi.R.string.api_access_cap_targets)).performScrollTo().assertIsOff().performClick()
        compose.runOnIdle { assertEquals(listOf(CallerConsentEvent.Capability(CapabilityRegistry.TARGETS_LIST, true)), events) }
    }
    @Test fun savingDisablesSelectionAndDenialAndCorruptManagementDoesNotShowEmptySuccess() {
        compose.setContent { RagentTheme(darkTheme = true) { CallerConsentScreen(CallerConsentUiState(loading = false, review = review,
            durationMs = 3600000, saving = true), {}, {}) } }
        compose.onNodeWithContentDescription(text(com.andysagent.ragent.feature.appapi.R.string.api_access_cap_targets)).assertIsNotEnabled()
        compose.onNodeWithContentDescription(text(com.andysagent.ragent.feature.appapi.R.string.api_close)).assertIsNotEnabled()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_access_deny)).performScrollTo().assertIsNotEnabled()
    }
    @Test fun corruptManagementIsVisibleAndNeverOffersDeleteOrHealthyEmptyMessage() {
        compose.setContent { RagentTheme { CallerGrantsScreen(CallerGrantsUiState(loading = false, error = ApiErrorCode.PERMISSION_DENIED), {}, {}) } }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_access_empty)).assertDoesNotExist()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_access_clear_history)).assertDoesNotExist()
        compose.onNodeWithText("PERMISSION_DENIED", substring = true).assertIsDisplayed()
    }
}
