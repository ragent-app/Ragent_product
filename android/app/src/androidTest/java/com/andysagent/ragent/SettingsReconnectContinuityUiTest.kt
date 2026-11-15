package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.domain.AccountsRepository
import com.andysagent.ragent.core.domain.AccountPermissionPolicy
import com.andysagent.ragent.core.domain.GoogleAccountProfile
import com.andysagent.ragent.core.domain.GoogleAccountStatusResult
import com.andysagent.ragent.core.domain.GoogleTokenSubmitResult
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.feature.workbench.SettingsPage
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.feature.workbench.accounts.AccountsEvent
import com.andysagent.ragent.feature.workbench.accounts.AccountsViewModel
import org.junit.Rule
import org.junit.Test

class SettingsReconnectContinuityUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun permissionEntryStaysVisibleWhileConnectionRecovers() {
        val accounts = AccountsViewModel(object : AccountsRepository {
            override suspend fun getGoogleAccountStatus() = GoogleAccountStatusResult(enabled = true, bound = true, mode = "accounts")
            override suspend fun submitGoogleIdToken(idToken: String, alias: String?) =
                GoogleTokenSubmitResult(bound = true, mode = "accounts")
        })
        accounts.onEvent(AccountsEvent.AccountSessionEstablished(GoogleAccountProfile(displayName = "Test", email = "test@example.test")))
        val state = mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings, connection = AgentConnectionStatus.Connected))
        rule.setContent { RagentTheme { WorkbenchScreen(state = state.value, accountsViewModel = accounts, onEvent = {}) } }
        rule.onNodeWithTag("settings-permission-mode").performScrollTo().assertIsDisplayed().assertIsEnabled()
        rule.runOnIdle { state.value = state.value.copy(connection = AgentConnectionStatus.Reconnecting) }
        rule.onNodeWithTag("settings-permission-mode").assertIsDisplayed().assertIsEnabled()
        rule.runOnIdle { state.value = state.value.copy(connection = AgentConnectionStatus.Connected) }
        rule.onNodeWithTag("settings-permission-mode").assertIsDisplayed().assertIsEnabled()
    }

    @Test fun openPermissionPageKeepsItsSelectionWhileReconnectDisablesWrites() {
        val accounts = AccountsViewModel(object : AccountsRepository {
            override suspend fun getGoogleAccountStatus() = GoogleAccountStatusResult(enabled = true, bound = true, mode = "accounts")
            override suspend fun submitGoogleIdToken(idToken: String, alias: String?) =
                GoogleTokenSubmitResult(bound = true, mode = "accounts")
            override suspend fun getAccountPermissionPolicy() = AccountPermissionPolicy(permissionPolicy = "approval")
        })
        accounts.onEvent(AccountsEvent.AccountSessionEstablished(GoogleAccountProfile(displayName = "Test", email = "test@example.test")))
        accounts.onEvent(AccountsEvent.ConnectionChanged(RuntimeConnectionState.Connected, targetSelected = true))
        val state = mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings,
            settingsPage = SettingsPage.PermissionMode, connection = AgentConnectionStatus.Connected))
        rule.setContent { RagentTheme { WorkbenchScreen(state = state.value, accountsViewModel = accounts, onEvent = {}) } }
        rule.waitUntil(5_000) { accounts.state.value.accountPermissionPolicy?.permissionPolicy == "approval" }
        val approval = "account-permission-policy-approval"
        rule.onNodeWithTag(approval).performScrollTo().assertIsDisplayed().assertIsEnabled()
        rule.runOnIdle { state.value = state.value.copy(connection = AgentConnectionStatus.Reconnecting) }
        rule.onNodeWithTag(approval).assertIsDisplayed().assertIsNotEnabled()
        rule.runOnIdle {
            check(accounts.state.value.accountPermissionPolicy?.permissionPolicy == "approval")
            state.value = state.value.copy(connection = AgentConnectionStatus.Connected)
        }
        rule.onNodeWithTag(approval).assertIsDisplayed().assertIsEnabled()
    }
}
