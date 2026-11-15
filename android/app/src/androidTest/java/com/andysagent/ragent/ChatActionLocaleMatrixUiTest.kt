package com.andysagent.ragent

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.AgentMessageActionBar
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import java.io.File
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ChatActionLocaleMatrixUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun actionsRemainReachableInSevenLocalesAt320dpAndLargeText() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val locales = listOf(Locale.ENGLISH, Locale.SIMPLIFIED_CHINESE, Locale.TRADITIONAL_CHINESE,
            Locale.FRENCH, Locale("es"), Locale.JAPANESE, Locale.KOREAN)
        var locale by mutableStateOf(locales.first())
        rule.setContent {
            val current = LocalContext.current
            val localized = remember(locale, current) {
                current.createConfigurationContext(Configuration(current.resources.configuration).apply { setLocale(locale) })
            }
            val density = LocalDensity.current
            CompositionLocalProvider(LocalContext provides localized, LocalDensity provides Density(density.density, 1.3f)) {
                RagentTheme {
                    Box(Modifier.width(320.dp).height(96.dp).background(LocalRagentColors.current.canvas).testTag("action-matrix")) {
                        AgentMessageActionBar("Sample", true, {}, {}, onReport = {})
                    }
                }
            }
        }
        val folder = File(target.getExternalFilesDir(null), "action-locale-matrix").apply { mkdirs() }
        locales.forEach { selected ->
            rule.runOnIdle { locale = selected }
            val localized = target.createConfigurationContext(Configuration(target.resources.configuration).apply { setLocale(selected) })
            val res = localized.resources
            val expectedReport = mapOf("en" to "Report", "zh-CN" to "举报", "zh-TW" to "檢舉",
                "fr" to "Signaler", "es" to "Denunciar", "ja" to "報告", "ko" to "신고")
            assertEquals(expectedReport[selected.toLanguageTag()], res.getString(com.andysagent.ragent.core.agentui.R.string.agentui_report_content))
            listOf(com.andysagent.ragent.core.agentui.R.string.agentui_copy_message,
                com.andysagent.ragent.core.agentui.R.string.agentui_branch_from_message,
                com.andysagent.ragent.core.agentui.R.string.agentui_report_content,
                com.andysagent.ragent.core.agentui.R.string.agentui_regenerate).forEach { id ->
                rule.onNodeWithContentDescription(res.getString(id)).assertIsDisplayed().assertHasClickAction()
            }
            rule.onNodeWithTag("action-matrix").captureToImage().asAndroidBitmap().let { bitmap ->
                File(folder, "${selected.toLanguageTag()}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            }
        }
    }
}
