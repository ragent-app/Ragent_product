package com.andysagent.ragent

import android.content.ComponentName
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.graphics.asAndroidBitmap
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.appapi.*
import org.junit.*
import org.junit.Assert.*
import java.io.File

class AssistantDelegationUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private fun text(id: Int) = compose.activity.getString(id)
    private fun state() = AssistantDelegationUiState(loading = false, review = AssistantDelegationReview(
        CallerGrantContext("synthetic-account", setOf("pc-b")), mapOf("pc-b" to "Synthetic home PC"), emptyList(), 0))
    @Test fun initialUiHasNoGrantAndExplainsWholeCallerGroup() {
        val events = mutableListOf<AssistantDelegationEvent>()
        compose.setContent { RagentTheme { AssistantDelegationScreen(state(), events::add, {}) } }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_assistant_description)).assertExists()
        screenshot("assistant-delegation-empty.png")
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_assistant_approve))
            .performScrollTo().assertIsNotEnabled()
        assertTrue(events.isEmpty())
    }
    @Test fun selectionIsRequiredAndEnabledApproveEmitsOnlyExplicitAction() {
        val value = mutableStateOf(state())
        val events = mutableListOf<AssistantDelegationEvent>()
        compose.setContent { RagentTheme { AssistantDelegationScreen(value.value, events::add, {}) } }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_assistant_approve))
            .performScrollTo().assertIsNotEnabled()
        compose.runOnIdle { value.value = value.value.copy(capabilities = setOf(CapabilityRegistry.TASKS_PREPARE), targets = setOf("pc-b"), acknowledgedGroup = true) }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_assistant_approve)).performScrollTo().assertIsEnabled().performClick()
        screenshot("assistant-delegation-reviewed.png")
        assertEquals(listOf(AssistantDelegationEvent.Approve), events)
    }
    @Test fun managementActivityIsNotExported() {
        val info = compose.activity.packageManager.getActivityInfo(ComponentName(compose.activity, AssistantDelegationActivity::class.java), 0)
        assertFalse(info.exported)
    }
    private fun screenshot(name: String) {
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        File(compose.activity.cacheDir, name).outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    }
}
