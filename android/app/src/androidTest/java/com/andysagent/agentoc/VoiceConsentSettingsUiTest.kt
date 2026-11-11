package com.andysagent.agentoc

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertDoesNotExist
import androidx.compose.ui.test.assertExists
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.navigation.AgentoDestination
import com.andysagent.agentoc.feature.workbench.SettingsPage
import com.andysagent.agentoc.feature.workbench.VoiceUiState
import com.andysagent.agentoc.feature.workbench.WorkbenchEvent
import com.andysagent.agentoc.feature.workbench.WorkbenchScreen
import com.andysagent.agentoc.feature.workbench.WorkbenchUiState
import org.junit.Rule
import org.junit.Test

class VoiceConsentSettingsUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun voiceSettingsCanGrantAndRevokeConsentWithoutAComputer() {
        var state by mutableStateOf(WorkbenchUiState(
            destination = AgentoDestination.Settings,
            settingsPage = SettingsPage.Voice,
            voice = VoiceUiState(cloudAvailable = true, cloudConsentKnown = true),
        ))
        rule.setContent {
            AgentocTheme {
                WorkbenchScreen(state = state, onEvent = { event ->
                    when (event) {
                        WorkbenchEvent.AcceptCloudVoiceConsent -> state = state.copy(voice = state.voice.copy(cloudConsentGranted = true))
                        WorkbenchEvent.RevokeCloudVoiceConsent -> state = state.copy(voice = state.voice.copy(cloudConsentGranted = false))
                        else -> Unit
                    }
                })
            }
        }
        rule.onNodeWithTag("voice-consent-grant").assertExists().performScrollTo().performClick()
        rule.onNodeWithTag("voice-consent-grant").assertDoesNotExist()
        rule.onNodeWithTag("voice-consent-revoke").assertExists().performScrollTo().performClick()
        rule.onNodeWithTag("voice-consent-grant").assertExists()
    }
}
