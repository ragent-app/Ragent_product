package com.andysagent.ragent

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.*
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.feature.workbench.*
import org.junit.Assert.assertNotNull
import org.junit.Test

class SettingsNativeMotionUiTest {
    @Test fun scrollAndNavigatePreferenceCards() {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            var language = ""
            var theme = ""
            scenario.onActivity { activity ->
                language = activity.getString(com.andysagent.ragent.feature.workbench.R.string.settings_language)
                theme = activity.getString(com.andysagent.ragent.feature.workbench.R.string.settings_theme)
                var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings))
                activity.setContent { RagentTheme {
                    WorkbenchScreen(state = state, onEvent = { event -> when (event) {
                        is WorkbenchEvent.OpenSettingsPage -> state = state.copy(settingsPage = event.page)
                        WorkbenchEvent.CloseSettingsPage -> state = state.copy(settingsPage = SettingsPage.Overview)
                        is WorkbenchEvent.SelectLanguage -> state = state.copy(appLanguage = event.language)
                        else -> Unit
                    } })
                } }
            }
            val languageCard = device.wait(Until.findObject(By.text(language)), 8_000)
            assertNotNull(languageCard)
            SystemClock.sleep(1200)
            languageCard.click()
            SystemClock.sleep(1000)
            val english = device.wait(Until.findObject(By.text("English")), 5_000)
            assertNotNull(english)
            english.click()
            SystemClock.sleep(1000)
            device.pressBack()
            assertNotNull(device.wait(Until.findObject(By.text(theme)), 5_000))
            SystemClock.sleep(900)
            val cx = device.displayWidth / 2
            device.swipe(cx, device.displayHeight * 3 / 4, cx, device.displayHeight / 3, 35)
            SystemClock.sleep(800)
            device.swipe(cx, device.displayHeight / 3, cx, device.displayHeight * 3 / 4, 35)
            SystemClock.sleep(900)
        }
    }
}
