package com.andysagent.ragent

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.domain.*
import com.andysagent.ragent.core.model.*
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.feature.workbench.*
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.feature.workbench.accounts.*
import java.io.File
import java.util.Locale
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Current production settings on the Honor device, with isolated account/computer fixtures. */
class SettingsRefinementUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val dark get() = InstrumentationRegistry.getArguments().getString("dark") == "true"
    private val computer = RemoteTarget("office", "办公室电脑", "", platform = "windows")

    private fun accounts(failSave: Boolean = false): AccountsViewModel {
        val vm = AccountsViewModel(object : AccountsRepository {
            override suspend fun getGoogleAccountStatus() = GoogleAccountStatusResult(enabled = true, bound = true, mode = "accounts")
            override suspend fun submitGoogleIdToken(idToken: String, alias: String?) = GoogleTokenSubmitResult(bound = true, mode = "accounts")
            override suspend fun getAccountPermissionPolicy() = AccountPermissionPolicy(permissionPolicy = "approval")
            override suspend fun setAccountPermissionPolicy(permissionPolicy: String, idempotencyKey: String): AccountPermissionPolicy {
                if (failSave) error("fixture save failure")
                return AccountPermissionPolicy(permissionPolicy = permissionPolicy)
            }
        })
        vm.onEvent(AccountsEvent.AccountSessionEstablished(GoogleAccountProfile(displayName = "Ragent 用户", email = "hello@example.test")))
        vm.onEvent(AccountsEvent.ConnectionChanged(RuntimeConnectionState.Connected, targetSelected = true))
        return vm
    }

    private fun show(content: @Composable () -> Unit) {
        val context = instrumentation.targetContext
        val config = Configuration(context.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) }
        val localized = context.createConfigurationContext(config)
        rule.setContent { CompositionLocalProvider(LocalContext provides localized, LocalConfiguration provides config) {
            RagentTheme(darkTheme = dark) { content() }
        } }
    }

    private fun capture(name: String) {
        rule.waitForIdle()
        android.os.SystemClock.sleep(400)
        val file = File(instrumentation.targetContext.getExternalFilesDir(null), "settings-refinement/$name-$dark.png")
        file.parentFile?.mkdirs()
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }

    // Lazy items may not exist yet, and nested semantic scrolls can leave a
    // row behind the floating navigation. Exercise a real user's gestures.
    private fun reveal(tag: String): SemanticsNodeInteraction {
        repeat(12) {
            val node = rule.onNodeWithTag(tag)
            val rootHeight = rule.onRoot().fetchSemanticsNode().boundsInRoot.height
            val center = if (node.isDisplayed()) node.fetchSemanticsNode().boundsInRoot.center.y else null
            if (center != null && center in rootHeight * 0.18f..rootHeight * 0.86f) return node
            rule.onRoot().performTouchInput {
                if (center != null && center < rootHeight * 0.18f)
                    swipeDown(startY = height * 0.32f, endY = height * 0.62f)
                else swipeUp(startY = height * 0.72f, endY = height * 0.42f)
            }
        }
        throw AssertionError("Could not reveal $tag clear of the navigation")
    }

    @Test fun overviewKeepsScopesClearAndPreferencesReachable() {
        val vm = accounts()
        val events = mutableListOf<WorkbenchEvent>()
        show { WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings,
            connection = AgentConnectionStatus.Connected, activeRemoteTargetId = computer.instanceId,
            remoteTargets = listOf(computer), appVersion = "0.3.12"), accountsViewModel = vm, onEvent = events::add) }
        rule.onNodeWithTag("settings-permission-mode").assertIsEnabled()
        capture("overview-top")
        rule.onNodeWithTag("settings-computer-configuration").performScrollTo().performClick()
        rule.runOnIdle { assertEquals(WorkbenchEvent.OpenSettingsPage(SettingsPage.ComputerConfiguration), events.last()) }
        reveal("settings-model-providers").assertIsDisplayed().performClick()
        rule.runOnIdle { assertEquals(WorkbenchEvent.OpenSettingsPage(SettingsPage.ModelProviders), events.last()) }
        reveal("settings-harnesses").assertIsDisplayed().performClick()
        rule.runOnIdle { assertEquals(WorkbenchEvent.OpenSettingsPage(SettingsPage.Harnesses), events.last()) }
        capture("models-runtime-overview")
        rule.onNodeWithTag("settings-language").performScrollTo().assertIsDisplayed()
        rule.onNodeWithTag("settings-theme").performScrollTo().assertIsDisplayed()
        reveal("settings-version").assertIsDisplayed()
        capture("overview-bottom")
        rule.onNodeWithTag("settings-version").assertIsDisplayed().performClick()
        rule.runOnIdle { assertEquals(WorkbenchEvent.OpenSettingsPage(SettingsPage.Version), events.last()) }
    }

    @Test fun noComputerOffersGuidanceAndMultipleComputersOfferSelection() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings))
        var event: WorkbenchEvent? = null
        show { WorkbenchScreen(state, onEvent = { event = it }) }
        reveal("settings-model-providers").assertIsDisplayed().performClick()
        rule.runOnIdle { assertEquals(WorkbenchEvent.OpenSettingsPage(SettingsPage.ModelProviders), event) }
        reveal("settings-harnesses").assertIsDisplayed().performClick()
        rule.runOnIdle { assertEquals(WorkbenchEvent.OpenSettingsPage(SettingsPage.Harnesses), event) }
        rule.onNodeWithTag("settings-computer-configuration").performScrollTo().performClick()
        rule.runOnIdle {
            assertEquals(WorkbenchEvent.OpenComputerSetup, event)
            state = state.copy(remoteTargets = listOf(computer, computer.copy(instanceId = "studio", label = "工作室电脑")))
        }
        rule.onNodeWithTag("settings-computer-configuration").performScrollTo().performClick()
        rule.runOnIdle { assertEquals(WorkbenchEvent.OpenSettingsPage(SettingsPage.ComputerManagement), event) }
        capture("choose-computer")
    }

    @Test fun computerConfigurationFollowsTargetAndExplainsDisconnection() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings,
            settingsPage = SettingsPage.ComputerConfiguration, activeRemoteTargetId = computer.instanceId,
            remoteTargets = listOf(computer, computer.copy(instanceId = "studio", label = "工作室电脑"))))
        val events = mutableListOf<WorkbenchEvent>()
        show { WorkbenchScreen(state, onEvent = events::add) }
        rule.onNodeWithTag("settings-offline-explanation").assertIsDisplayed()
        rule.onNodeWithText("连接电脑").performClick()
        rule.runOnIdle { assertEquals(WorkbenchEvent.ConnectRemoteTarget("office"), events.last()) }
        capture("computer-offline")
        rule.runOnIdle { state = state.copy(activeRemoteTargetId = "studio", connection = AgentConnectionStatus.Connected) }
        rule.onNodeWithText("工作室电脑 · 已连接").assertIsDisplayed()
        rule.onNodeWithTag("settings-offline-explanation").assertDoesNotExist()
        rule.onNodeWithText("模型提供商").assertDoesNotExist()
        rule.onNodeWithText("应用与工具连接").performClick()
        rule.runOnIdle { assertEquals(WorkbenchEvent.OpenSettingsPage(SettingsPage.Connectors), events.last()) }
        capture("computer-online")
        rule.runOnIdle { state = state.copy(remoteTargets = emptyList()) }
        rule.onNodeWithText("模型提供商").assertDoesNotExist()
        capture("computer-removed")
    }

    @Test fun appearanceSelectionAndAccountDetails() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings, settingsPage = SettingsPage.Theme))
        val vm = accounts()
        show { WorkbenchScreen(state, accountsViewModel = vm, onEvent = { event ->
            if (event is WorkbenchEvent.SelectTheme) state = state.copy(appTheme = event.theme)
        }) }
        rule.onNodeWithTag("settings-theme-dark").performScrollTo().performClick().assertIsSelected()
        rule.onNodeWithTag("settings-theme-system").assertIsNotSelected()
        capture("appearance")
        rule.runOnIdle { state = state.copy(settingsPage = SettingsPage.Account) }
        capture("account")
        rule.onNodeWithText("hello@example.test").assertIsDisplayed()
    }

    @Test fun failedPermissionSavePreservesSelectionAndCanRetry() {
        val vm = accounts(failSave = true)
        show { WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings,
            settingsPage = SettingsPage.PermissionMode, connection = AgentConnectionStatus.Connected), accountsViewModel = vm) }
        rule.waitUntil(5000) { vm.state.value.accountPermissionPolicy?.permissionPolicy == "approval" }
        rule.onNodeWithTag("account-permission-policy-full-auto").performScrollTo().performClick()
        rule.waitUntil(5000) { vm.state.value.errorMessage != null }
        rule.runOnIdle { assertEquals("approval", vm.state.value.accountPermissionPolicy?.permissionPolicy) }
        rule.onNodeWithTag("account-permission-policy-approval").performScrollTo().assertIsEnabled()
        capture("permission-save-error")
    }

    @Test fun cachedComputerConfigurationRemainsReadableButCannotBeChangedOffline() {
        var connected by mutableStateOf(false)
        show { WebParitySurface(page = WebParityPage.ModelProviders,
            state = WebParityUiState(providers = listOf(WebProvider("provider", "示例模型服务", "https://example.test", true))),
            onEvent = {}, onBack = {}, connectionAvailable = connected) }
        rule.onNodeWithTag("provider-card-provider").assertIsDisplayed()
        val add = instrumentation.targetContext.createConfigurationContext(Configuration().apply { setLocale(Locale.SIMPLIFIED_CHINESE) })
            .getString(com.andysagent.ragent.feature.workbench.R.string.sp_add_provider)
        rule.onNodeWithText(add).assertIsNotEnabled()
        capture("provider-offline")
        rule.runOnIdle { connected = true }
        rule.onNodeWithText(add).assertIsEnabled()
    }

    @Test fun harnessTargetsRemainIndependentOfTheOfflineActiveComputer() {
        val events = mutableListOf<WebParityEvent>()
        var parity by mutableStateOf(WebParityUiState(page = WebParityPage.Harnesses,
            harnesses = listOf(WebHarness("runtime", "Codex", supportedOnPlatform = false)),
            harnessTargets = listOf(
                WebHarnessTarget("office", "办公室电脑", available = false),
                WebHarnessTarget("unsupported", "另一台电脑", supportedHarnessIds = emptySet()),
                WebHarnessTarget("studio", "工作室电脑", supportedHarnessIds = setOf("runtime")))))
        show { WebParitySurface(page = WebParityPage.Harnesses, state = parity, onEvent = events::add,
            onBack = {}, targetId = "office", targetLabel = "办公室电脑", connectionAvailable = false) }
        rule.onNodeWithText("账号下的电脑").assertIsDisplayed()
        rule.onNodeWithTag("harness-target-runtime-office").assertTextContains("状态待确认", substring = true)
        rule.onNodeWithTag("harness-install-runtime").performScrollTo().assertIsEnabled()
        capture("harness-cross-device")
        rule.onNodeWithTag("harness-install-runtime").performClick()
        rule.onNodeWithTag("harness-select-office").assertIsNotEnabled().assertIsOff()
        rule.onNodeWithTag("harness-select-unsupported").assertIsNotEnabled().assertIsOff()
        rule.onNodeWithTag("harness-select-studio").assertIsEnabled().assertIsOn()
        capture("harness-target-selection")
        rule.onNodeWithTag("harness-operation-confirm").performClick()
        rule.runOnIdle {
            assertEquals(WebParityEvent.InstallHarness("runtime", listOf("studio")), events.last())
            parity = parity.copy(harnessTargets = parity.harnessTargets.map { it.copy(available = false) })
        }
        rule.onNodeWithTag("harness-install-runtime").performScrollTo().assertIsNotEnabled()
    }

    @Test fun providerScopeAndManagementComputerAreExplicit() {
        val providers = listOf(WebProvider("shared", "团队 API", "Codex · API key", true),
            WebProvider("local", "Codex 登录", "Codex · OAuth", true, authType = "oauth"))
        val events = mutableListOf<WebParityEvent>()
        show { WebParitySurface(page = WebParityPage.ModelProviders,
            state = WebParityUiState(page = WebParityPage.ModelProviders, providerHarnessesLoaded = true,
                harnesses = listOf(WebHarness("codex", "Codex", globallyInstalled = true)),
                providers = providers, providerCrossInstance = true, providerTargetId = "studio",
                providerInstances = listOf(ProviderInstanceSnapshot(ProviderInstance("studio", "工作室电脑"),
                    loading = false, available = true))),
            onEvent = events::add, onBack = {}, targetLabel = "主工作电脑", connectionAvailable = false) }
        rule.onNodeWithTag("provider-instance-selector").assertIsDisplayed()
        rule.onNodeWithTag("provider-choose-computer").assertDoesNotExist()
        reveal("provider-scope-shared").assertTextEquals("可在账号内同步")
        capture("provider-shared-scope")
        reveal("provider-scope-local").assertTextEquals("仅限 工作室电脑")
        capture("provider-local-scope")
        rule.onNodeWithTag("provider-instance-selector").performClick()
        rule.onNodeWithTag("provider-instance-all").performClick()
        rule.runOnIdle { assertEquals(WebParityEvent.SelectProviderInstance(null), events.last()) }
    }
}
