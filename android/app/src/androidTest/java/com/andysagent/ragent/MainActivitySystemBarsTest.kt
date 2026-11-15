package com.andysagent.ragent

import android.content.res.Configuration
import android.content.res.Resources
import android.os.SystemClock
import androidx.core.view.WindowCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.datastore.ClientConfigStore
import com.andysagent.ragent.core.model.AppTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.Assert.assertTrue

/** Real saved theme + real Activity; adb cold-start video separately covers OS splash frames. */
class MainActivitySystemBarsTest {
    private fun checkTheme(theme: AppTheme, dark: Boolean, recreate: Boolean = false) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val config = ClientConfigStore(context)
        val original = runBlocking { config.appTheme.first() }
        try {
            runBlocking { config.setAppTheme(theme) }
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                if (recreate) {
                    scenario.recreate()
                }
                // Use the real Choreographer: installing Compose's test clock here
                // can block ActivityScenario.launch while the first-draw gate awaits composition.
                // This is a settled-state check, not a startup latency assertion.
                val deadline = SystemClock.elapsedRealtime() + 5_000
                var matched = false
                while (!matched && SystemClock.elapsedRealtime() < deadline) {
                    scenario.onActivity { activity ->
                        val bars = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                        matched = bars.isAppearanceLightStatusBars == !dark &&
                            bars.isAppearanceLightNavigationBars == !dark
                    }
                    if (!matched) SystemClock.sleep(16)
                }
                assertTrue("System bar appearance never settled for $theme", matched)
                // Insets / platform splash animation are outside the Compose clock.
                SystemClock.sleep(750)
                scenario.onActivity { activity ->
                    val bars = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                    assertEquals("Status bar icons disagree with $theme", !dark, bars.isAppearanceLightStatusBars)
                    assertEquals("Navigation bar icons disagree with $theme", !dark, bars.isAppearanceLightNavigationBars)
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                        val resourceDark = activity.resources.configuration.uiMode and
                            Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
                        assertEquals("Platform resources disagree with $theme", dark, resourceDark)
                    }
                }
            }
        } finally {
            runBlocking { config.setAppTheme(original) }
        }
    }

    @Test fun darkThemeUsesLightIconsAfterEntry() = checkTheme(AppTheme.Dark, true)
    @Test fun lightThemeUsesDarkIconsAfterEntry() = checkTheme(AppTheme.Light, false)
    @Test fun oledUsesLightIconsAfterEntry() = checkTheme(AppTheme.Oled, true)
    @Test fun recreatedDarkActivityKeepsLightIcons() = checkTheme(AppTheme.Dark, true, recreate = true)
    @Test fun systemThemeMatchesCurrentSystemMode() {
        // The target context can still carry the previous application's override.
        val config = Resources.getSystem().configuration
        checkTheme(AppTheme.System, config.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
    }
}
