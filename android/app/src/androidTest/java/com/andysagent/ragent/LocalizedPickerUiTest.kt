package com.andysagent.ragent

import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test

/** Exercise the localized fixture with real Activity owners, not just Resources. */
class LocalizedPickerUiTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun frenchRuntimePickerStartsWithWorkingActivityOwners() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "fr").putExtra("panel", "runtime")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use {
            compose.onNodeWithText("Choisir un environnement").assertIsDisplayed()
        }
    }

    @Test fun chineseEffortPickerStartsInDarkTheme() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "zh-CN").putExtra("panel", "effort").putExtra("dark", true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use {
            compose.onNodeWithText("思考强度").assertIsDisplayed()
            compose.onNodeWithText("快速响应").assertIsDisplayed()
        }
    }
}
