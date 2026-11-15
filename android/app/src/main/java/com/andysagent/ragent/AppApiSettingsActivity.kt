package com.andysagent.ragent

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.ragent.core.datastore.ClientConfigStore
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.AppLanguage
import com.andysagent.ragent.core.model.AppTheme
import com.andysagent.ragent.feature.appapi.RoutingSettingsScreen
import com.andysagent.ragent.feature.appapi.RoutingSettingsViewModel
import com.andysagent.ragent.feature.appapi.StoredRoutingSettings
import java.util.Locale

/** Internal owner settings; exported callers cannot use this screen as a permission grant. */
class AppApiSettingsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val config = (application as RagentApplication).runtime.configStore
        val factory = object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                require(modelClass == RoutingSettingsViewModel::class.java)
                @Suppress("UNCHECKED_CAST")
                return RoutingSettingsViewModel(StoredRoutingSettings(config)) as T
            }
        }
        setContent {
            AppApiSurfaceTheme(config) {
                val model: RoutingSettingsViewModel = viewModel(factory = factory)
                val state by model.state.collectAsStateWithLifecycle()
                RoutingSettingsScreen(state, model::onEvent, ::finish,
                    onOpenDrafts = { startActivity(android.content.Intent(this, DraftInboxActivity::class.java)) },
                    onOpenGrants = { startActivity(android.content.Intent(this, CallerGrantsActivity::class.java)) },
                    onOpenAssistantDelegation = { startActivity(android.content.Intent(this, AssistantDelegationActivity::class.java)) })
            }
        }
    }
}

/** Cold system entry points also honor the persisted language and palette. */
@Composable
internal fun AppApiSurfaceTheme(config: ClientConfigStore, content: @Composable () -> Unit) {
    val storedTheme by config.appTheme.collectAsStateWithLifecycle(initialValue = null)
    val storedLanguage by config.appLanguage.collectAsStateWithLifecycle(initialValue = null)
    // Do not briefly render in another language while DataStore initializes.
    val theme = storedTheme
    val language = storedLanguage
    if (theme == null || language == null) {
        RagentTheme(darkTheme = isSystemInDarkTheme()) {
            Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                Box(
                    modifier = Modifier.fillMaxSize().safeDrawingPadding(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }
        }
        return
    }
    val base = LocalContext.current
    val currentConfiguration = LocalConfiguration.current
    val localized = remember(base, language, currentConfiguration) {
        if (language == AppLanguage.System || language.tag.isBlank()) base
        else base.createConfigurationContext(Configuration(currentConfiguration).apply {
            setLocale(Locale.forLanguageTag(language.tag))
        })
    }
    val dark = when (theme) {
        AppTheme.Dark, AppTheme.Oled, AppTheme.Amber -> true
        AppTheme.Light -> false
        AppTheme.System, AppTheme.Monet -> isSystemInDarkTheme()
    }
    val activity = base as? ComponentActivity
    SideEffect {
        val bars = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark }
        activity?.enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
    }
    RagentTheme(darkTheme = dark, themeVariant = theme.value) {
        CompositionLocalProvider(LocalContext provides localized, LocalConfiguration provides localized.resources.configuration) { content() }
    }
}
