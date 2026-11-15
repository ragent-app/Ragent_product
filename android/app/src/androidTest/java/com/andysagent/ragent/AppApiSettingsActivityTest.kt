package com.andysagent.ragent

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.andysagent.ragent.core.model.AppLanguage
import com.andysagent.ragent.core.model.AppTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

class AppApiSettingsActivityTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun coldInternalEntryHonorsStoredChinesePaletteAndCanClose() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<RagentApplication>()
        val config = app.runtime.configStore
        val language = config.appLanguage.first()
        val theme = config.appTheme.first()
        try {
            config.setAppLanguage(AppLanguage.SimplifiedChinese)
            config.setAppTheme(AppTheme.Dark)
            ActivityScenario.launch(AppApiSettingsActivity::class.java).use { scenario ->
                compose.onNodeWithText("分享与智能助手").assertIsDisplayed()
                compose.onNodeWithContentDescription("关闭").assertHasClickAction()
                val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
                File(app.cacheDir, "appapi-routing-cold-zh-dark.png").outputStream().use {
                    assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
                }
                compose.onNodeWithContentDescription("关闭").performClick()
                compose.waitUntil(5_000) { scenario.state == androidx.lifecycle.Lifecycle.State.DESTROYED }
            }
        } finally {
            config.setAppLanguage(language)
            config.setAppTheme(theme)
        }
    }
}
