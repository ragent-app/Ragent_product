package com.andysagent.ragent

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.*
import java.io.File
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Exercises the production state sheet and recovery callbacks on a real device. */
class PostLoginPolishUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val dark get() = InstrumentationRegistry.getArguments().getString("dark") == "true"

    private fun show(content: @Composable () -> Unit) {
        val localized = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
            setLocale(Locale.SIMPLIFIED_CHINESE)
        })
        compose.setContent { CompositionLocalProvider(LocalContext provides localized) {
            RagentTheme(darkTheme = dark) { content() }
        } }
    }

    private fun sheet(state: PairingOnboardingUiState,
        onEvent: (PairingOnboardingEvent) -> Unit = {}, onScan: () -> Unit = {}) {
        show { WorkbenchScreen(state = WorkbenchUiState(), pairingOnboardingState = state,
            onPairingOnboardingEvent = onEvent, onScanPairing = onScan,
            onScanPairingFromWelcome = onScan) }
    }

    @Test fun waitingKeepsStopAvailableWithoutDisabledPrimaryAction() {
        var event: PairingOnboardingEvent? = null
        sheet(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Verifying,
            computerAlias = "我的电脑"), onEvent = { event = it })
        compose.onNodeWithText("正在连接 我的电脑").assertIsDisplayed()
        compose.onNodeWithText("停止等待").assertIsDisplayed()
        capture("connecting")
        compose.onNodeWithText("停止等待").performClick()
        compose.runOnIdle { assertEquals(PairingOnboardingEvent.StopWaiting, event) }
    }

    @Test fun connectedOffersOneCompletionAction() {
        var event: PairingOnboardingEvent? = null
        sheet(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Bound,
            computerAlias = "我的电脑"), onEvent = { event = it })
        compose.onNodeWithText("已连接到 我的电脑").assertIsDisplayed()
        compose.onNodeWithText("关闭").assertDoesNotExist()
        compose.onNodeWithText("取消").assertDoesNotExist()
        compose.onNodeWithText("开始使用").assertIsDisplayed()
        capture("connected")
        compose.onNodeWithText("开始使用").performClick()
        compose.runOnIdle { assertEquals(PairingOnboardingEvent.Dismiss, event) }
    }

    @Test fun unusableCodeClearsOldAttemptBeforeOpeningScanner() {
        val actions = mutableListOf<String>()
        sheet(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Error,
            requiresNewCode = true,
            errorMessageRes = com.andysagent.ragent.feature.workbench.R.string.pairing_error_request_conflict),
            onEvent = { if (it == PairingOnboardingEvent.Retry) actions += "clear" },
            onScan = { actions += "scan" })
        compose.onNodeWithText("请获取新的配对码").assertIsDisplayed()
        compose.onNodeWithText("扫描二维码").assertIsDisplayed()
        capture("new-code")
        compose.onNodeWithText("扫描二维码").performClick()
        compose.runOnIdle { assertEquals(listOf("clear", "scan"), actions) }
    }

    @Test fun technicalDetailsAreOptionalAndRetryRemainsReachable() {
        val diagnostic = "transport handshake failed: QA diagnostic"
        var event: PairingOnboardingEvent? = null
        sheet(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Error,
            errorMessage = diagnostic), onEvent = { event = it })
        compose.onNodeWithText(diagnostic).assertDoesNotExist()
        capture("error")
        compose.onNodeWithText("技术详情").performScrollTo().performClick()
        compose.onNodeWithText(diagnostic).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("重试").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(PairingOnboardingEvent.Retry, event) }
    }

    @Test fun lookupFailureCanRetry() {
        var retries = 0
        show { AccountComputerLookupScreen(AccountComputerLookup.Failed, { retries++ }) }
        compose.onNodeWithTag("retry-account-computers").assertIsDisplayed()
        capture("lookup-failed")
        compose.onNodeWithTag("retry-account-computers").performClick()
        compose.runOnIdle { assertEquals(1, retries) }
    }

    @Test fun cameraFailureReopensScannerInsteadOfRetryingAccountBinding() {
        var scans = 0
        val events = mutableListOf<PairingOnboardingEvent>()
        sheet(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Error,
            scannerUnavailable = true), onEvent = events::add, onScan = { scans++ })
        compose.onNodeWithText("无法使用相机").assertIsDisplayed()
        val scan = context.getString(com.andysagent.ragent.feature.workbench.R.string.welcome_scan)
        compose.onNodeWithText(scan).assertIsDisplayed()
        capture("camera")
        compose.onNodeWithText(scan).performClick()
        compose.runOnIdle { assertEquals(1, scans); assertEquals(emptyList<PairingOnboardingEvent>(), events) }
    }

    @Test fun lookupShowsProgress() {
        show { AccountComputerLookupScreen(AccountComputerLookup.Loading, {}) }
        compose.onNodeWithTag("account-computer-lookup").assertIsDisplayed()
        capture("lookup")
    }

    @Test fun temporaryAccessKeepsScanReachable() {
        var scans = 0
        show { ConnectionMethodsScreen(onBack = {}, onScanTemporary = { scans++ }) }
        compose.onNodeWithTag("temporary-scan").performScrollTo().assertIsDisplayed()
        capture("temporary")
        compose.onNodeWithTag("temporary-scan").performClick()
        compose.runOnIdle { assertEquals(1, scans) }
    }

    @Test fun successfulLoginShowsIdentityAndReachableAction() {
        show { GoogleSignInSuccessScreen(GoogleSignInSuccessAction.ConnectComputer, {},
            accountLabel = "test@example.com") }
        compose.onNodeWithText("登录成功").assertExists()
        compose.onNodeWithText("test@example.com").assertExists()
        compose.onNodeWithTag("sign-in-success-action").performScrollTo().assertIsDisplayed()
        capture("signed-in")
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        android.os.SystemClock.sleep(600)
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        val config = context.resources.configuration
        val directory = File(context.getExternalFilesDir(null), "post-login-evidence").apply { mkdirs() }
        File(directory, "$name-$dark-${config.fontScale}-${config.screenWidthDp}dp.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }
}
