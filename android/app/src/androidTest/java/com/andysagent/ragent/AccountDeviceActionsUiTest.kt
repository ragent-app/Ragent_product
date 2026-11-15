package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.feature.workbench.WebDevice
import com.andysagent.ragent.feature.workbench.WebParityEvent
import com.andysagent.ragent.feature.workbench.WebParityPage
import com.andysagent.ragent.feature.workbench.WebParitySurface
import com.andysagent.ragent.feature.workbench.WebParityUiState
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Actual Compose menu on the phone; account/PC are isolated presentation fixtures. */
class AccountDeviceActionsUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun backgroundCarrierHasItsOwnDisconnectActionWithoutChangingThePrimary() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val disconnected = mutableListOf<String>()
        val connected = mutableListOf<String>()
        compose.setContent {
            RagentTheme {
                WebParitySurface(page = WebParityPage.Devices,
                    state = WebParityUiState(page = WebParityPage.Devices, devices =
                        listOf("primary", "background", "reconnecting", "offline").map {
                            WebDevice(id = it, instanceId = it, name = it, platform = "computer",
                                status = "Trusted", revocable = false)
                        }),
                    // A stale aggregate primary value must not override a
                    // fixed target's actual disconnected carrier state.
                    connectedTargetId = "offline",
                    targetConnectionStates = mapOf("primary" to RuntimeConnectionState.Connected,
                        "background" to RuntimeConnectionState.Connected,
                        "reconnecting" to RuntimeConnectionState.Reconnecting,
                        "offline" to RuntimeConnectionState.Disconnected),
                    onConnectComputer = { connected += it }, onDisconnectComputer = { disconnected += it },
                    onEvent = {}, onBack = {})
            }
        }
        val disconnectText = context.getString(WorkbenchR.string.settings_disconnect)
        compose.onNodeWithTag("settings-device-action-primary").assert(hasText(disconnectText))
        compose.onNodeWithTag("settings-device-action-background").assert(hasText(disconnectText)).performClick()
        compose.onNodeWithTag("settings-device-action-reconnecting").assertIsNotEnabled()
        compose.onNodeWithTag("settings-device-action-offline")
            .assert(hasText(context.getString(WorkbenchR.string.settings_connect))).performClick()
        compose.runOnIdle {
            assertEquals(listOf("background"), disconnected)
            assertEquals(listOf("offline"), connected)
        }
    }

    @Test fun accountComputerMenuShowsRenameAndDispatchesOnlyTheChosenAction() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val rename = context.getString(WorkbenchR.string.settings_rename)
        val unbind = context.getString(WorkbenchR.string.settings_unbind)
        val save = context.getString(WorkbenchR.string.settings_save)
        val events = mutableListOf<WebParityEvent>()
        compose.setContent {
            RagentTheme {
                WebParitySurface(page = WebParityPage.Devices,
                    state = WebParityUiState(page = WebParityPage.Devices, devices = listOf(
                        WebDevice(id = "inst_menu_test", instanceId = "inst_menu_test", name = "QA computer",
                            platform = "computer", status = "Trusted", accountOwned = true, revocable = true))),
                    onEvent = { events += it }, onBack = {})
            }
        }
        compose.onNodeWithTag("settings-device-menu-inst_menu_test").performClick()
        compose.onNodeWithText(rename).assertIsDisplayed()
        compose.onNodeWithText(unbind).assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(WebParityEvent.OpenPage(WebParityPage.Devices)), events) }
        compose.onNodeWithTag("settings-device-rename-inst_menu_test").performClick()
        compose.onNode(hasSetTextAction()).performTextReplacement("Renamed QA computer")
        compose.onNodeWithText(save).performClick()
        compose.runOnIdle {
            assertEquals(WebParityEvent.RenameDevice("inst_menu_test", "Renamed QA computer"), events.last())
        }
        compose.onNodeWithTag("settings-device-menu-inst_menu_test").performClick()
        compose.onNodeWithTag("settings-device-unbind-inst_menu_test").performClick()
        compose.onNodeWithText(context.getString(WorkbenchR.string.sp_confirm_remove_device, "QA computer")).assertIsDisplayed()
        compose.runOnIdle { assertEquals(WebParityEvent.RenameDevice("inst_menu_test", "Renamed QA computer"), events.last()) }
        compose.onNode(hasText(unbind) and hasClickAction()).performClick()
        compose.runOnIdle { assertEquals(WebParityEvent.RevokeDevice("inst_menu_test"), events.last()) }
    }
}
