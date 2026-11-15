package com.andysagent.ragent.feature.workbench

import android.content.res.Configuration
import android.graphics.Bitmap
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import com.andysagent.ragent.core.designsystem.AgentoAlertDialog
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.AttentionItem
import com.andysagent.ragent.core.model.AttentionKind
import com.andysagent.ragent.core.model.AttentionUiState
import java.io.File
import java.io.FileOutputStream
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Static UI evidence only: this fixture never signs in, pairs, or starts a transport. */
@RunWith(AndroidJUnit4::class)
class PairingOnboardingDeviceUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private fun show(state: PairingOnboardingUiState, onEvent: (PairingOnboardingEvent) -> Unit = {}) {
        val configuration = Configuration(rule.activity.resources.configuration).apply {
            setLocale(Locale.SIMPLIFIED_CHINESE)
        }
        val chineseContext = rule.activity.createConfigurationContext(configuration)
        rule.setContent {
            CompositionLocalProvider(LocalContext provides chineseContext) {
                RagentTheme(darkTheme = false) {
                    PairingOnboardingDialog(state, onEvent, {}, {}, {})
                }
            }
        }
    }

    private fun capture(name: String) {
        rule.waitForIdle()
        // UiAutomation captures the physical display; Compose idleness can precede the
        // platform sheet's entrance animation, leaving a washed-out transition frame.
        Thread.sleep(900)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = checkNotNull(instrumentation.targetContext.getExternalFilesDir("pairing-ui"))
        val file = File(directory, name)
        val screenshot = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        FileOutputStream(file).use { output ->
            check(screenshot.compress(Bitmap.CompressFormat.PNG, 100, output))
        }
        screenshot.recycle()
        assertTrue("Screenshot is empty: ${file.absolutePath}", file.length() > 0)
        Log.i("PairingOnboardingDeviceUiTest", "Saved ${file.absolutePath}")
    }

    @Test fun waitingIsReadableAndStopWaitingHasAnAccessibleAction() {
        var event: PairingOnboardingEvent? = null
        show(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Verifying)) {
            event = it
        }

        rule.onNodeWithText("正在验证 Google 帐号、关联授权和此设备。").assertIsDisplayed()
        val stopWaiting = rule.onNodeWithText("停止等待").assertIsDisplayed().assertHasClickAction()
        val minimumTouchHeight = 48f * rule.activity.resources.displayMetrics.density
        assertTrue(stopWaiting.fetchSemanticsNode().boundsInRoot.height >= minimumTouchHeight)
        capture("waiting-zh-CN.png")
        rule.onNodeWithText("停止等待").performClick()
        assertEquals(PairingOnboardingEvent.StopWaiting, event)
    }

    @Test fun linkedStateUsesChineseCopy() {
        var event: PairingOnboardingEvent? = null
        show(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Bound)) {
            event = it
        }
        rule.onNodeWithText("已连接").assertIsDisplayed()
        rule.onNodeWithText("这台电脑已关联到 Google 帐号。以后连接时无需再扫码。")
            .assertIsDisplayed()
        rule.onNodeWithText("关闭").assertIsDisplayed().assertHasClickAction()
        rule.onNodeWithText("取消").assertDoesNotExist()
        capture("linked-zh-CN.png")
        rule.onNodeWithText("关闭").performClick()
        assertEquals(PairingOnboardingEvent.Dismiss, event)
    }

    @Test fun rejectedCodeShowsNewCodeAction() {
        show(PairingOnboardingUiState(
            open = true,
            step = PairingOnboardingStep.Error,
            errorMessage = "The computer could not accept this account-link request.",
            errorMessageRes = R.string.pairing_error_request_conflict,
            requiresNewCode = true,
        ))
        rule.onNodeWithText("重新开始").assertIsDisplayed().assertHasClickAction()
        rule.onNodeWithText("此配对码不能重复使用。请从电脑获取新码并重新开始。")
            .assertIsDisplayed()
        rule.onNodeWithText("The computer could not accept this account-link request.")
            .assertDoesNotExist()
        capture("rejected-code-zh-CN.png")
    }

    @Test fun actionRowRemainsVisibleWithKeyboardOpen() {
        show(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.ComputerAliasRequired))
        rule.onNode(hasSetTextAction()).performClick()
        rule.waitUntil(5_000) {
            ViewCompat.getRootWindowInsets(rule.activity.window.decorView)
                ?.isVisible(WindowInsetsCompat.Type.ime()) == true
        }
        rule.onNodeWithText("取消").assertIsDisplayed().assertHasClickAction()
        rule.onNodeWithText("关联电脑").assertIsDisplayed().assertHasClickAction()
        capture("keyboard-zh-CN.png")
    }

    @Test fun scanGuideExplainsDesktopSetupAndOpensScanner() {
        var scanned = false
        var locale by mutableStateOf(Locale.SIMPLIFIED_CHINESE)
        rule.activityRule.scenario.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        rule.setContent {
            key(locale) {
                val configuration = Configuration(rule.activity.resources.configuration).apply { setLocale(locale) }
                val localized = rule.activity.createConfigurationContext(configuration)
                CompositionLocalProvider(LocalContext provides localized, LocalConfiguration provides configuration) {
                    RagentTheme {
                        Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFFB9D5FF), Color(0xFFFFD7BC)))))
                        PairingScanGuideDialog(onScan = { scanned = true }, onDismiss = {})
                    }
                }
            }
        }
        val languages = listOf(Locale.ENGLISH, Locale.SIMPLIFIED_CHINESE, Locale.TRADITIONAL_CHINESE,
            Locale.JAPANESE, Locale.KOREAN, Locale.FRENCH, Locale("es"))
        for (language in languages) {
            rule.runOnIdle { locale = language }
            val configuration = Configuration(rule.activity.resources.configuration).apply { setLocale(language) }
            val resources = rule.activity.createConfigurationContext(configuration).resources
            rule.onNodeWithText(resources.getString(R.string.pairing_setup_guide_title)).assertIsDisplayed()
            rule.onNodeWithText(resources.getString(R.string.pairing_setup_guide_install)).assertIsDisplayed()
            rule.onNodeWithText("https://www.agentoncloud.com/download.html").assertIsDisplayed()
            rule.onNodeWithContentDescription(resources.getString(R.string.pairing_setup_guide_copy)).assertIsDisplayed().assertHasClickAction()
            rule.onNodeWithText(resources.getString(R.string.pairing_setup_guide_scan)).assertIsDisplayed().assertHasClickAction()
            capture("scan-guide-${language.toLanguageTag()}-top.png")
            rule.onNodeWithText(resources.getString(R.string.pairing_setup_guide_desktop)).performScrollTo().assertIsDisplayed()
            rule.onNodeWithText(resources.getString(R.string.pairing_setup_guide_scan_help)).performScrollTo().assertIsDisplayed()
            capture("scan-guide-${language.toLanguageTag()}-bottom.png")
        }
        val spanish = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale("es")) }).resources
        rule.onNodeWithText(spanish.getString(R.string.pairing_setup_guide_scan)).performClick()
        assertTrue(scanned)
    }

    @Test fun sharedAlertUsesReadableGlassInBothThemes() {
        var dark by mutableStateOf(false)
        var confirmed = false
        rule.activityRule.scenario.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        rule.setContent {
            RagentTheme(darkTheme = dark) {
                Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFFB9D5FF), Color(0xFFFFD7BC))))) {
                    Text("Background remains sharp", Modifier.padding(start = 24.dp, top = 90.dp), color = Color.Black)
                }
                AgentoAlertDialog(onDismissRequest = {}, title = { Text("Glass dialog") },
                    text = { Text("Readable content") }, confirmButton = { TextButton(onClick = { confirmed = true }) { Text("Confirm") } })
            }
        }
        for (mode in listOf(false, true)) {
            rule.runOnIdle { dark = mode }
            rule.onNodeWithText("Glass dialog").assertIsDisplayed()
            rule.onNodeWithText("Readable content").assertIsDisplayed()
            rule.onNodeWithText("Confirm").assertIsDisplayed().assertHasClickAction()
            capture(if (mode) "glass-alert-dark.png" else "glass-alert-light.png")
        }
        rule.onNodeWithText("Confirm").performClick()
        assertTrue(confirmed)
    }
    @Test fun topNotificationLeavesBackgroundUnmaskedAndInteractive() {
        var clicked = false
        rule.activityRule.scenario.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        rule.setContent {
            RagentTheme {
                Box(Modifier.fillMaxSize().background(Color(0xFFB9D5FF))) {
                    Text("Background action", Modifier.padding(start = 24.dp, top = 320.dp).clickable { clicked = true }, color = Color.Black)
                    AttentionSurface(
                        state = AttentionUiState(items = listOf(AttentionItem(id = "done", sessionId = "s", sessionTitle = "Test session", kind = AttentionKind.Completion, title = "Test session", summary = "Task complete")), activeItemId = "done"),
                        onEvent = {}, onOpenSession = {},
                    )
                }
            }
        }
        capture("top-notification-no-mask.png")
        rule.onNodeWithText("Test session").assertIsDisplayed()
        rule.onNodeWithText("Background action").performClick()
        assertTrue(clicked)
    }

}
