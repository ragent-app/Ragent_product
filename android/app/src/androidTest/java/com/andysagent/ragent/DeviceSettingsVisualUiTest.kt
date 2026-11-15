package com.andysagent.ragent

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import java.util.Locale
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.*
import java.io.File
import org.junit.Rule
import org.junit.Test

class DeviceSettingsVisualUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    @Test fun light() = capture(false, "devices-light")
    @Test fun dark() = capture(true, "devices-dark")
    @Test fun menuMotion() {
        val devices = listOf(WebDevice("fixture", "computer-a", "Example computer", "windows", "active", true, accountOwned = true))
        rule.setContent { RagentTheme { WebParitySurface(page = WebParityPage.Devices,
            state = WebParityUiState(page = WebParityPage.Devices, devices = devices),
            onEvent = {}, onBack = {}, onAddComputer = {}, onConnectComputer = {}, onDisconnectComputer = {}) } }
        rule.waitForIdle()
        android.os.SystemClock.sleep(1500)
        rule.onNodeWithTag("settings-device-menu-fixture").performClick()
        rule.onNodeWithTag("settings-device-rename-fixture").assertIsDisplayed()
        android.os.SystemClock.sleep(1800)
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            val out = File(rule.activity.getExternalFilesDir(null), "device-settings/devices-menu.png")
            out.parentFile?.mkdirs()
            out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
        androidx.test.uiautomator.UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressBack()
        rule.onNodeWithTag("settings-device-rename-fixture").assertDoesNotExist()
        rule.onNodeWithTag("settings-device-computer-a").assertIsDisplayed()
        android.os.SystemClock.sleep(1400)
    }
    @Test fun spanishNarrow() = capture(false, "devices-spanish-narrow", narrow = true, locale = "es")
    @Test fun japaneseNarrow() = capture(false, "devices-japanese-narrow", narrow = true, locale = "ja")
    @Test fun narrowLargeFont() = capture(false, "devices-narrow-large", narrow = true)
    private fun capture(dark: Boolean, name: String, narrow: Boolean = false, locale: String? = null) {
        val devices = listOf(WebDevice("fixture", "computer-a", if (narrow) "A very long example computer name" else "Example computer", "windows", "active", true, accountOwned = true))
        rule.setContent {
            val density = LocalDensity.current
            val base = LocalContext.current
            val config = android.content.res.Configuration(base.resources.configuration).apply { if (locale != null) setLocale(Locale.forLanguageTag(locale)) }
            val localized = androidx.compose.runtime.remember(locale) { base.createConfigurationContext(config) }
            CompositionLocalProvider(LocalContext provides localized, LocalConfiguration provides config,
                LocalDensity provides Density(density.density, if (narrow) 1.6f else density.fontScale)) {
            RagentTheme(darkTheme = dark) {
            Box(if (narrow) Modifier.width(320.dp) else Modifier) { WebParitySurface(page = WebParityPage.Devices, state = WebParityUiState(page = WebParityPage.Devices, devices = devices),
                onEvent = {}, onBack = {}, onAddComputer = {}, onConnectComputer = {}, onDisconnectComputer = {}) }
        } } }
        rule.onNodeWithTag("settings-device-computer-a").assertIsDisplayed()
        rule.onNodeWithTag("settings-device-action-computer-a").assertIsDisplayed()
        rule.waitForIdle()
        android.os.SystemClock.sleep(500)
        val file = File(rule.activity.getExternalFilesDir(null), "device-settings/$name.png")
        file.parentFile?.mkdirs()
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
}
