package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.AppLanguage
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.feature.workbench.*
import java.util.Locale
import org.junit.Rule
import org.junit.Test

class SettingsChoiceAccessibilityUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun languageSelectionHasOneSelectedChoiceAcrossLocales() {
        val locales = listOf(Locale.ENGLISH, Locale.SIMPLIFIED_CHINESE, Locale.TRADITIONAL_CHINESE,
            Locale.JAPANESE, Locale.KOREAN, Locale.FRENCH, Locale("es"))
        var locale by mutableStateOf(locales.first())
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings, settingsPage = SettingsPage.Language))
        rule.setContent {
            val base = LocalContext.current
            val localized = remember(locale, base) {
                base.createConfigurationContext(Configuration(base.resources.configuration).apply { setLocale(locale) })
            }
            CompositionLocalProvider(LocalContext provides localized) {
                RagentTheme { WorkbenchScreen(state = state, onEvent = { event ->
                    if (event is WorkbenchEvent.SelectLanguage) state = state.copy(appLanguage = event.language)
                }) }
            }
        }
        locales.forEach { selectedLocale ->
            rule.runOnIdle { locale = selectedLocale; state = state.copy(appLanguage = AppLanguage.System) }
            rule.onNodeWithTag("settings-language-system").assertIsSelected()
            rule.onNodeWithTag("settings-language-english").assertIsNotSelected().performScrollTo().performClick()
            rule.onNodeWithTag("settings-language-english").assertIsSelected()
            rule.onNodeWithTag("settings-language-system").assertIsNotSelected()
            rule.runOnIdle { check(state.appLanguage == AppLanguage.English) }
        }
    }
}
