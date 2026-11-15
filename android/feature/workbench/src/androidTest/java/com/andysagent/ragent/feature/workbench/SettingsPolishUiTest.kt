package com.andysagent.ragent.feature.workbench

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.model.AppLanguage
import com.andysagent.ragent.core.model.AppTheme
import com.andysagent.ragent.core.navigation.AgentoDestination
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.util.Locale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

class SettingsPolishUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun providerQuotaShowsRemainingInsteadOfJson() {
        val quota = Json.parseToJsonElement("""{"status":"ok","windows":[{"id":"five_hour","remainingPercent":75}]}""").jsonObject
        rule.setContent {
            RagentTheme {
                WebParitySurface(page = WebParityPage.ModelProviders,
                    state = WebParityUiState(page = WebParityPage.ModelProviders, providers = listOf(
                        WebProvider("provider", "Example", "", true, quotaSnapshot = quota),
                    )), onEvent = {}, onBack = {})
            }
        }
        rule.onNodeWithTag("provider-quota").assertIsDisplayed()
        rule.onNodeWithText("75", substring = true).assertIsDisplayed()
        rule.onNodeWithText("remainingPercent", substring = true).assertDoesNotExist()
    }

    @Test fun providerCardHasSeparatedContentAndLocalizedActions() {
        val events = mutableListOf<WebParityEvent>()
        val chinese = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply {
            setLocale(Locale.SIMPLIFIED_CHINESE)
        })
        rule.setContent {
            val localized = remember { chinese }
            CompositionLocalProvider(LocalContext provides localized) {
                RagentTheme {
                    WebParitySurface(
                        page = WebParityPage.ModelProviders,
                        state = WebParityUiState(page = WebParityPage.ModelProviders, providers = listOf(
                            WebProvider("provider", "Example", "https://example.invalid", true, quota = "42"),
                        )),
                        onEvent = { events += it }, onBack = {},
                    )
                }
            }
        }
        rule.onNodeWithText(chinese.getString(R.string.settings_model_providers)).assertIsDisplayed()
        rule.onNodeWithText(chinese.getString(R.string.sp_add_provider)).assertIsDisplayed()
        val info = rule.onNodeWithTag("provider-info-provider").fetchSemanticsNode().boundsInRoot
        val actions = rule.onNodeWithTag("provider-actions-provider").fetchSemanticsNode().boundsInRoot
        assertTrue("Provider actions must be below provider details", actions.top >= info.bottom)
        rule.onNodeWithText(chinese.getString(R.string.sp_delete)).performClick()
        rule.onNodeWithText(chinese.getString(R.string.sp_delete_provider_title)).assertIsDisplayed()
        rule.runOnIdle { assertTrue(events.none { it is WebParityEvent.DeleteProvider }) }
    }

    @Test fun removingDeviceRequiresConfirmation() {
        val events = mutableListOf<WebParityEvent>()
        rule.setContent {
            RagentTheme {
                WebParitySurface(
                    page = WebParityPage.Devices,
                    state = WebParityUiState(page = WebParityPage.Devices, devices = listOf(
                        WebDevice("device", "device", "Example computer", "windows", "active", true, accountOwned = true),
                    )),
                    onEvent = { events += it }, onBack = {},
                )
            }
        }
        rule.onNodeWithTag("settings-device-menu-device").performClick()
        rule.onNodeWithTag("settings-device-unbind-device").performClick()
        rule.onNodeWithText(rule.activity.getString(R.string.sp_confirm_remove_device, "Example computer")).assertIsDisplayed()
        rule.runOnIdle { assertTrue(events.none { it is WebParityEvent.RevokeDevice }) }
        rule.onNode(hasText(rule.activity.getString(R.string.settings_unbind)) and hasClickAction()).performClick()
        rule.runOnIdle { assertTrue(events.any { it == WebParityEvent.RevokeDevice("device") }) }
    }

    @Test fun deletingScheduledTaskRequiresConfirmation() {
        val events = mutableListOf<WebParityEvent>()
        rule.setContent {
            RagentTheme {
                WebParitySurface(page = WebParityPage.Triggers,
                    state = WebParityUiState(page = WebParityPage.Triggers, openSessionId = "session", triggers = listOf(
                        WebTrigger("task", "Example task", "Message", "2026-10-29", "pending", true, sessionId = "session"),
                    )), onEvent = { events += it }, onBack = {})
            }
        }
        rule.onNodeWithText(rule.activity.getString(R.string.sp_delete)).performClick()
        rule.onNodeWithText(rule.activity.getString(R.string.sp_delete_scheduled_body, "Example task")).assertIsDisplayed()
        rule.runOnIdle { assertTrue(events.none { it is WebParityEvent.DeleteTrigger }) }
        rule.onNodeWithTag("scheduled-delete-confirm").performClick()
        rule.runOnIdle { assertTrue(events.any { it == WebParityEvent.DeleteTrigger("task") }) }
    }

    @Test fun languageAndThemeSelectionsSurviveNavigation() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings))
        rule.setContent {
            RagentTheme(darkTheme = state.appTheme == AppTheme.Dark) {
                WorkbenchScreen(state = state, onEvent = { event ->
                    when (event) {
                        is WorkbenchEvent.OpenSettingsPage -> state = state.copy(settingsPage = event.page)
                        WorkbenchEvent.CloseSettingsPage -> state = state.copy(settingsPage = SettingsPage.Overview)
                        is WorkbenchEvent.SelectLanguage -> state = state.copy(appLanguage = event.language)
                        is WorkbenchEvent.SelectTheme -> state = state.copy(appTheme = event.theme)
                        else -> Unit
                    }
                })
            }
        }
        rule.onNodeWithTag("settings-language").performClick()
        rule.onNodeWithTag("settings-language-system").assertIsDisplayed()
        rule.onNodeWithTag("settings-language-english").performScrollTo().performClick()
        rule.runOnIdle { assertTrue(state.appLanguage == AppLanguage.English) }
        rule.onNodeWithTag("settings-back").performClick()
        rule.onNodeWithTag("settings-theme").performScrollTo().performClick()
        rule.onNodeWithTag("settings-theme-dark").performClick()
        rule.runOnIdle { assertTrue(state.appTheme == AppTheme.Dark) }
        rule.onNodeWithTag("settings-back").performClick()
        rule.onNodeWithTag("settings-language").performScrollTo().performClick()
        rule.runOnIdle { assertTrue(state.appLanguage == AppLanguage.English && state.appTheme == AppTheme.Dark) }
    }

    @Test fun refreshingKeepsExistingProviderVisible() {
        var state by mutableStateOf(WebParityUiState(page = WebParityPage.ModelProviders, providers = listOf(
            WebProvider("provider", "Example provider", "example.invalid", true),
        )))
        rule.setContent {
            RagentTheme {
                WebParitySurface(page = WebParityPage.ModelProviders, state = state,
                    onEvent = { if (it == WebParityEvent.Refresh) state = state.copy(refreshing = true) }, onBack = {})
            }
        }
        rule.onNodeWithTag("provider-card-provider").assertIsDisplayed()
        val description = rule.activity.getString(R.string.settings_refresh_page, rule.activity.getString(R.string.settings_model_providers))
        rule.onNodeWithContentDescription(description).performClick()
        rule.runOnIdle { assertTrue(state.refreshing) }
        rule.onNodeWithTag("provider-card-provider").assertIsDisplayed()
    }

    @Test fun mcpDeleteRequiresConfirmation() {
        val events = mutableListOf<WebParityEvent>()
        rule.setContent {
            RagentTheme {
                WebParitySurface(page = WebParityPage.Connectors,
                    state = WebParityUiState(page = WebParityPage.Connectors, mcpServers = listOf(WebMcpServer("codex", "Example MCP", "example"))),
                    onEvent = { events += it }, onBack = {})
            }
        }
        rule.onNodeWithText(rule.activity.getString(R.string.sp_delete)).performScrollTo().performClick()
        rule.onNodeWithText(rule.activity.getString(R.string.sp_delete_mcp_body, "Example MCP")).assertIsDisplayed()
        rule.runOnIdle { assertTrue(events.none { it is WebParityEvent.DeleteMcpServer }) }
        rule.onNodeWithTag("mcp-delete-confirm").performClick()
        rule.runOnIdle { assertTrue(events.any { it == WebParityEvent.DeleteMcpServer("codex", "Example MCP") }) }
    }

    @Test fun singleComputerUninstallRequiresConfirmation() {
        val events = mutableListOf<WebParityEvent>()
        rule.setContent {
            RagentTheme {
                WebParitySurface(page = WebParityPage.Harnesses, state = WebParityUiState(page = WebParityPage.Harnesses,
                    harnesses = listOf(WebHarness("runtime", "Example runtime", installed = true)),
                    harnessTargets = listOf(WebHarnessTarget("computer", "Example computer", installedHarnessIds = setOf("runtime")))),
                    onEvent = { events += it }, onBack = {}, targetId = "computer")
            }
        }
        rule.onNodeWithTag("harness-uninstall-runtime").performClick()
        rule.onNodeWithTag("harness-operation-confirm").assertIsDisplayed()
        rule.runOnIdle { assertTrue(events.none { it is WebParityEvent.UninstallHarness }) }
        rule.onNodeWithTag("harness-operation-confirm").performClick()
        rule.runOnIdle { assertTrue(events.any { it == WebParityEvent.UninstallHarness("runtime", listOf("computer")) }) }
    }

    @Test fun appOwnedErrorsAreLocalizedAndServerDiagnosticsArePreserved() {
        val chinese = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply {
            setLocale(Locale.SIMPLIFIED_CHINESE)
        })
        var state by mutableStateOf(WebParityUiState(page = WebParityPage.ModelProviders, error = "Action failed"))
        rule.setContent {
            CompositionLocalProvider(LocalContext provides chinese) {
                RagentTheme { WebParitySurface(page = WebParityPage.ModelProviders, state = state, onEvent = {}, onBack = {}) }
            }
        }
        rule.onNodeWithText(chinese.getString(R.string.sp_error_action)).assertIsDisplayed()
        rule.runOnIdle { state = state.copy(error = "server diagnostic 503") }
        rule.onNodeWithText("server diagnostic 503").assertIsDisplayed()
    }

    @Test fun settingsNavigationWorksWithoutMotionAndHasAccessibleActions() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings))
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                WorkbenchScreen(state = state, onEvent = { event ->
                    when (event) {
                        is WorkbenchEvent.OpenSettingsPage -> state = state.copy(settingsPage = event.page)
                        WorkbenchEvent.CloseSettingsPage -> state = state.copy(settingsPage = SettingsPage.Overview)
                        else -> Unit
                    }
                })
            }
        }
        rule.onNodeWithTag("settings-language").performClick()
        rule.onNodeWithContentDescription(rule.activity.getString(R.string.settings_back)).assertIsDisplayed().performClick()
        rule.onNodeWithTag("settings-list").assertIsDisplayed()
    }
}
