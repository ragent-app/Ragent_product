package com.andysagent.ragent.feature.workbench

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.Lifecycle
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.RemoteTarget
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import org.junit.Rule
import org.junit.Test
import org.junit.Before
import java.io.File
import java.util.Locale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

/** Repeatable real-device evidence using isolated, non-account fixture data. */
class SettingsVisualEvidenceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Before fun hideTestHostChrome() {
        rule.runOnUiThread { rule.activity.actionBar?.hide() }
    }

    private fun capture(name: String) {
        rule.waitForIdle()
        rule.waitUntil(5_000) { rule.activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }
        val out = File(rule.activity.getExternalFilesDir(null), "settings-visual/$name.png")
        out.parentFile?.mkdirs()
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        check(rule.activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) { "Test activity was not foreground: $name" }
    }

    private fun workbench(page: SettingsPage, locale: Locale, dark: Boolean, name: String) {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(locale) })
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context) {
                RagentTheme(darkTheme = dark) {
                    WorkbenchScreen(state = WorkbenchUiState(destination = AgentoDestination.Settings, settingsPage = page))
                }
            }
        }
        capture(name)
    }

    @Test fun overviewChineseLight() = workbench(SettingsPage.Overview, Locale.SIMPLIFIED_CHINESE, false, "overview-zh-light")
    @Test fun overviewEnglishDark() = workbench(SettingsPage.Overview, Locale.ENGLISH, true, "overview-en-dark")
    @Test fun languageChineseLight() = workbench(SettingsPage.Language, Locale.SIMPLIFIED_CHINESE, false, "language-zh-light")
    @Test fun themeEnglishDark() = workbench(SettingsPage.Theme, Locale.ENGLISH, true, "theme-en-dark")
    @Test fun accountChineseLight() = workbench(SettingsPage.Account, Locale.SIMPLIFIED_CHINESE, false, "account-zh-light")
    @Test fun permissionEnglishDark() = workbench(SettingsPage.PermissionMode, Locale.ENGLISH, true, "permission-en-dark")
    @Test fun versionChineseLight() = workbench(SettingsPage.Version, Locale.SIMPLIFIED_CHINESE, false, "version-zh-light")
    @Test fun languageChineseDark() = workbench(SettingsPage.Language, Locale.SIMPLIFIED_CHINESE, true, "language-zh-dark")
    @Test fun themeChineseLight() = workbench(SettingsPage.Theme, Locale.SIMPLIFIED_CHINESE, false, "theme-zh-light")
    @Test fun accountChineseDark() = workbench(SettingsPage.Account, Locale.SIMPLIFIED_CHINESE, true, "account-zh-dark")
    @Test fun permissionChineseLight() = workbench(SettingsPage.PermissionMode, Locale.SIMPLIFIED_CHINESE, false, "permission-zh-light")
    @Test fun versionChineseDark() = workbench(SettingsPage.Version, Locale.SIMPLIFIED_CHINESE, true, "version-zh-dark")

    private fun parity(page: WebParityPage, dark: Boolean, name: String) {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) })
        val fixture = WebParityUiState(
            page = page,
            connectors = listOf(WebConnector("connector", "Example connector", "Ready", true)),
            providers = listOf(WebProvider("provider", "Example provider", "https://example.invalid/v1", true, quota = "42")),
            devices = listOf(WebDevice("device", "device", "Example computer", "windows", "active", true, accountOwned = true)),
            harnesses = listOf(WebHarness("harness", "Example runtime", version = "1.0", installed = true)),
            harnessTargets = listOf(WebHarnessTarget("computer", "Example computer", installedHarnessIds = setOf("harness"))),
            files = listOf(WebFile("example.md", false, "2 KB")),
            openSessionId = "session",
            triggers = listOf(WebTrigger("trigger", "Example scheduled task", "Example message", "2026-10-29 12:30", "pending", true, sessionId = "session")),
            usage = Json.parseToJsonElement("""{"window":{"days":7},"totals":{"runCount":2,"totalTokens":1234},"byDay":[{"day":"2026-10-29","runCount":2,"totalTokens":1234}]}""").jsonObject,
        )
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context) {
                RagentTheme(darkTheme = dark) { WebParitySurface(page = page, state = fixture, onEvent = {}, onBack = {}) }
            }
        }
        capture(name)
    }
    @Test fun connectorsChineseLight() = parity(WebParityPage.Connectors, false, "connectors-zh-light")
    @Test fun harnessChineseLight() = parity(WebParityPage.Harnesses, false, "harness-zh-light")
    @Test fun filesChineseLight() = parity(WebParityPage.Files, false, "files-zh-light")
    @Test fun triggersChineseLight() = parity(WebParityPage.Triggers, false, "triggers-zh-light")
    @Test fun usageChineseLight() = parity(WebParityPage.Usage, false, "usage-zh-light")
    @Test fun connectorsChineseDark() = parity(WebParityPage.Connectors, true, "connectors-zh-dark")
    @Test fun harnessChineseDark() = parity(WebParityPage.Harnesses, true, "harness-zh-dark")
    @Test fun filesChineseDark() = parity(WebParityPage.Files, true, "files-zh-dark")
    @Test fun triggersChineseDark() = parity(WebParityPage.Triggers, true, "triggers-zh-dark")
    @Test fun usageChineseDark() = parity(WebParityPage.Usage, true, "usage-zh-dark")
    @Test fun providersChineseDark() = parity(WebParityPage.ModelProviders, true, "providers-zh-dark")
    @Test fun devicesChineseDark() = parity(WebParityPage.Devices, true, "devices-zh-dark")
    @Test fun triggersEmptyChineseLight() {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) })
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context) {
                RagentTheme(darkTheme = false) { WebParitySurface(page = WebParityPage.Triggers, state = WebParityUiState(page = WebParityPage.Triggers), onEvent = {}, onBack = {}) }
            }
        }
        capture("triggers-empty-zh-light")
    }
    @Test fun chatChineseLight() {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) })
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context) {
                RagentTheme(darkTheme = false) {
                    WorkbenchScreen(state = WorkbenchUiState(
                        destination = AgentoDestination.Sessions,
                        remoteTargets = listOf(RemoteTarget("fixture", "Example computer", "example.invalid")),
                        activeRemoteTargetId = "fixture",
                        projects = listOf(Project("project", "Example project")),
                        sessions = listOf(Session("session", "Example conversation", projectId = "project")),
                    ))
                }
            }
        }
        capture("chat-zh-light")
    }
    @Test fun conversationChineseLight() {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) })
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context, LocalActivityResultRegistryOwner provides rule.activity) {
                RagentTheme(darkTheme = false) {
                    WorkbenchScreen(state = WorkbenchUiState(
                        destination = AgentoDestination.Sessions, chatOpen = true,
                        sessionTitle = "Example conversation",
                        timelineItems = listOf(
                            TimelineItem.Message("user", 1, TimelineRole.User, "Example question", true),
                            TimelineItem.Message("agent", 2, TimelineRole.Agent, "Example response for comparing the current chat surface.", true),
                        ),
                    ))
                }
            }
        }
        rule.waitUntil(timeoutMillis = 15_000) { rule.onAllNodesWithText("Example question").fetchSemanticsNodes().isNotEmpty() }
        capture("conversation-zh-light")
    }
    @Test fun devicesChineseLight() {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) })
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context) {
                RagentTheme(darkTheme = false) {
                    WebParitySurface(page = WebParityPage.Devices, state = WebParityUiState(page = WebParityPage.Devices, devices = listOf(WebDevice(id = "device", instanceId = "device", name = "Example computer", platform = "windows", status = "active", revocable = true, accountOwned = true))), onEvent = {}, onBack = {}, onAddComputer = {}, onConnectComputer = {})
                }
            }
        }
        capture("devices-zh-light")
    }
    @Test fun providerChineseLight() {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) })
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context) {
                RagentTheme(darkTheme = false) {
                    WebParitySurface(page = WebParityPage.ModelProviders, state = WebParityUiState(page = WebParityPage.ModelProviders, providers = listOf(WebProvider("fixture", "Example Provider", "https://example.invalid/v1", true, quota = "42"))), onEvent = {}, onBack = {})
                }
            }
        }
        capture("provider-zh-light")
    }

    @Test fun providerAllLanguagesWithLargeText() {
        var locale by mutableStateOf(Locale.ENGLISH)
        val locales = listOf(
            "en" to Locale.ENGLISH, "zh-cn" to Locale.SIMPLIFIED_CHINESE,
            "zh-tw" to Locale.TRADITIONAL_CHINESE, "ja" to Locale.JAPANESE,
            "ko" to Locale.KOREAN, "fr" to Locale.FRENCH, "es" to Locale("es"),
        )
        rule.setContent {
            val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(locale) })
            CompositionLocalProvider(LocalContext provides context, LocalDensity provides Density(rule.activity.resources.displayMetrics.density, 1.3f)) {
                RagentTheme(darkTheme = false) {
                    WebParitySurface(page = WebParityPage.ModelProviders,
                        state = WebParityUiState(page = WebParityPage.ModelProviders, providers = listOf(
                            WebProvider("long", "A provider with a longer name", "https://example.invalid/a/long/path", true, quota = "123456"),
                        )), onEvent = {}, onBack = {})
                }
            }
        }
        locales.forEach { (label, value) ->
            rule.runOnIdle { locale = value }
            rule.onNodeWithTag("provider-card-long").assertIsDisplayed()
            capture("provider-$label-large")
        }
    }

    @Test fun providerNarrowFrenchLargeText() {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.FRENCH) })
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context, LocalDensity provides Density(rule.activity.resources.displayMetrics.density, 1.3f)) {
                RagentTheme(darkTheme = false) {
                    Box(Modifier.width(320.dp)) {
                        WebParitySurface(page = WebParityPage.ModelProviders,
                            state = WebParityUiState(page = WebParityPage.ModelProviders, providers = listOf(
                                WebProvider("narrow", "Example provider with a long name", "https://example.invalid/a/long/path", true, quota = "123456"),
                            )), onEvent = {}, onBack = {})
                    }
                }
            }
        }
        rule.onNodeWithTag("provider-card-narrow").assertIsDisplayed()
        val info = rule.onNodeWithTag("provider-info-narrow").fetchSemanticsNode().boundsInRoot
        val actions = rule.onNodeWithTag("provider-actions-narrow").fetchSemanticsNode().boundsInRoot
        org.junit.Assert.assertTrue("Provider actions overlap the information at narrow width", actions.top >= info.bottom)
        capture("provider-fr-narrow-large")
    }

    @Test fun providerDeleteDialogChineseDark() {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) })
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context) {
                RagentTheme(darkTheme = true) {
                    WebParitySurface(page = WebParityPage.ModelProviders,
                        state = WebParityUiState(page = WebParityPage.ModelProviders, providers = listOf(WebProvider("provider", "Example provider", "example.invalid", true))),
                        onEvent = {}, onBack = {})
                }
            }
        }
        rule.onNodeWithText(context.getString(R.string.sp_delete)).performClick()
        rule.onNodeWithText(context.getString(R.string.sp_delete_provider_title)).assertIsDisplayed()
        android.os.SystemClock.sleep(800) // Let the separate Dialog window finish its platform animation before capture.
        capture("provider-delete-zh-dark")
    }

    @Test fun providerRefreshAndErrorChineseLight() {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) })
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context) {
                RagentTheme(darkTheme = false) {
                    WebParitySurface(page = WebParityPage.ModelProviders,
                        state = WebParityUiState(page = WebParityPage.ModelProviders, refreshing = true, error = "Action failed", providers = listOf(WebProvider("provider", "Example provider", "example.invalid", true))),
                        onEvent = {}, onBack = {})
                }
            }
        }
        rule.onNodeWithText(context.getString(R.string.sp_error_action)).assertIsDisplayed()
        rule.onNodeWithTag("provider-card-provider").assertIsDisplayed()
        capture("provider-refresh-error-zh-light")
    }

    @Test fun providerWideLayoutIsCenteredAndBounded() {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.ENGLISH) })
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context, LocalDensity provides Density(1f, 1f)) {
                RagentTheme {
                    WebParitySurface(page = WebParityPage.ModelProviders,
                        state = WebParityUiState(page = WebParityPage.ModelProviders, providers = listOf(WebProvider("wide", "Example provider", "example.invalid", true))),
                        onEvent = {}, onBack = {})
                }
            }
        }
        val card = rule.onNodeWithTag("provider-card-wide").fetchSemanticsNode().boundsInRoot
        val screenWidth = rule.activity.resources.displayMetrics.widthPixels.toFloat()
        org.junit.Assert.assertTrue("Wide card exceeds the settings maximum width", card.width <= 600f)
        org.junit.Assert.assertTrue("Wide card is not centered", kotlin.math.abs(card.center.x - screenWidth / 2f) < 3f)
        val back = rule.onNodeWithTag("settings-back").fetchSemanticsNode().boundsInRoot
        org.junit.Assert.assertTrue("Wide header is detached from the content", kotlin.math.abs(back.left - card.left) < 24f)
        capture("provider-en-wide")
    }
}
