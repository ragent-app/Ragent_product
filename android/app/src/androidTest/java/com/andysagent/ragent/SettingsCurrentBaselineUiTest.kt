package com.andysagent.ragent

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.feature.workbench.SettingsPage
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.Locale

class SettingsCurrentBaselineUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    @Test fun overviewLight() = capture(SettingsPage.Overview, false, "overview-light")
    @Test fun overviewDark() = capture(SettingsPage.Overview, true, "overview-dark")
    @Test fun languageLight() = capture(SettingsPage.Language, false, "language-light")
    @Test fun themeDark() = capture(SettingsPage.Theme, true, "theme-dark")
    @Test fun overviewEnglishNarrowLarge() = captureNarrow(1.3f, "overview-en-320-large")
    @Test fun overviewEnglishNarrowExtraLarge() = captureNarrow(1.6f, "overview-en-320-extra-large")
    private fun captureNarrow(fontScale: Float, name: String) {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.ENGLISH) })
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalContext provides context, LocalDensity provides Density(density.density, fontScale)) {
                RagentTheme { Box(Modifier.width(320.dp)) {
                    WorkbenchScreen(state = WorkbenchUiState(destination = AgentoDestination.Settings))
                } }
            }
        }
        rule.onNodeWithTag("settings-language").performScrollTo().assertIsDisplayed()
        rule.onNodeWithTag("settings-theme").performScrollTo().assertIsDisplayed()
        rule.waitForIdle()
        val output = File(rule.activity.getExternalFilesDir(null), "settings-current/$name.png")
        output.parentFile?.mkdirs()
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }

    private fun capture(page: SettingsPage, dark: Boolean, name: String) {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) })
        rule.setContent { CompositionLocalProvider(LocalContext provides context) {
            RagentTheme(darkTheme = dark) { WorkbenchScreen(state = WorkbenchUiState(destination = AgentoDestination.Settings, settingsPage = page)) }
        } }
        rule.waitForIdle()
        android.os.SystemClock.sleep(500)
        val output = File(rule.activity.getExternalFilesDir(null), "settings-current/$name.png")
        output.parentFile?.mkdirs()
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }
}
