package com.andysagent.ragent

import android.content.ComponentName
import android.content.pm.PackageManager
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.datastore.*
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.appapi.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class AppApiRoutingSettingsUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val computers = listOf(LinkedComputer("a", "", "Office"), LinkedComputer("b", "", "Home"))
    private fun state(routing: AppApiRoutingPreferences = AppApiRoutingPreferences(defaultShareTargetId = "b")) =
        RoutingSettingsUiState(loading = false, directory = ComputerDirectory(computers, "a", routing))
    private fun text(id: Int) = compose.activity.getString(id)

    @Test fun shareDefaultIsSelectedEvenWhenAnotherComputerIsOpen() {
        val events = mutableListOf<RoutingSettingsEvent>()
        var closed = false
        compose.setContent { RagentTheme { RoutingSettingsScreen(state(), events::add, { closed = true }) } }
        compose.onNodeWithText("Home").assertIsSelected().assertHasClickAction().performClick()
        compose.onNodeWithText("Office").assertIsNotSelected().performClick()
        compose.onNodeWithContentDescription(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_edit_aliases, "Home")).performClick()
        screenshot("appapi-routing-light.png")
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_no_default)).performClick()
        compose.onNodeWithContentDescription(text(com.andysagent.ragent.feature.appapi.R.string.api_close)).performClick()
        compose.runOnIdle {
            assertEquals(listOf(RoutingSettingsEvent.SelectDefault("b"), RoutingSettingsEvent.SelectDefault("a"), RoutingSettingsEvent.EditAliases("b"), RoutingSettingsEvent.SelectDefault(null)), events)
            assertTrue(closed)
        }
    }
    @Test fun waitingStateDisablesConsequentialControls() {
        val events = mutableListOf<RoutingSettingsEvent>()
        compose.setContent { RagentTheme { RoutingSettingsScreen(state().copy(saving = true), events::add, {}) } }
        compose.onNodeWithText("Home").assertIsNotEnabled().performTouchInput { click() }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_no_default)).assertIsNotEnabled()
        compose.onNodeWithContentDescription(compose.activity.getString(com.andysagent.ragent.feature.appapi.R.string.api_edit_aliases, "Home"))
            .assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertTrue(events.isEmpty()) }
    }
    @Test fun corruptRoutingRequiresExplicitResetAndAliasEditorKeepsInputSemantics() {
        val events = mutableListOf<RoutingSettingsEvent>()
        var current by mutableStateOf(state(AppApiRoutingPreferences(readable = false)).copy(editingTargetId = "b", aliasesText = "Existing alias"))
        compose.setContent { RagentTheme {
            RoutingSettingsScreen(current, { event ->
                events += event
                if (event is RoutingSettingsEvent.ChangeAliases) current = current.copy(aliasesText = event.text)
            }, {})
        } }
        compose.onNodeWithText("Home").assertDoesNotExist()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_reset_routing)).performClick()
        compose.onNodeWithContentDescription(text(com.andysagent.ragent.feature.appapi.R.string.api_alias_label))
            .performScrollTo().performTextReplacement("Home workstation")
        closeSoftKeyboard()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_save)).performScrollTo().assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_cancel)).performClick()
        compose.runOnIdle {
            assertEquals(listOf(RoutingSettingsEvent.Reset, RoutingSettingsEvent.ChangeAliases("Home workstation"), RoutingSettingsEvent.SaveAliases, RoutingSettingsEvent.CloseEditor), events)
        }
    }
    @Test fun missingDefaultRemainsVisibleAndSettingsActivityIsInternal() {
        compose.setContent { RagentTheme(darkTheme = true) { RoutingSettingsScreen(state(AppApiRoutingPreferences(defaultShareTargetId = "removed")), {}, {}) } }
        compose.onNodeWithText(text(com.andysagent.ragent.feature.appapi.R.string.api_default_missing)).assertIsDisplayed()
        compose.onNodeWithText("Home").assertIsNotSelected()
        compose.onNodeWithText("Office").assertIsNotSelected()
        screenshot("appapi-routing-dark.png")
        @Suppress("DEPRECATION")
        val info = compose.activity.packageManager.getActivityInfo(
            ComponentName(compose.activity.packageName, AppApiSettingsActivity::class.java.name), PackageManager.GET_META_DATA)
        assertFalse(info.exported)
    }
    private fun screenshot(name: String) {
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        File(compose.activity.cacheDir, name).outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    }
}
