package com.andysagent.ragent

import android.graphics.Bitmap
import android.os.SystemClock
import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertContentDescriptionContains
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineOperationKind
import com.andysagent.ragent.core.timeline.TimelineOperationStatus
import com.andysagent.ragent.feature.workbench.OperationGroup
import com.andysagent.ragent.feature.workbench.TurnOperationSummary
import java.io.File
import java.util.Locale
import org.junit.Rule
import org.junit.Test

/** Synthetic operation states used to compare before/after on the physical display. */
class ChatOperationVisualBaselineTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private fun capture(name: String) {
        rule.waitForIdle()
        rule.waitUntil(5_000) { rule.activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }
        SystemClock.sleep(350)
        val out = File(rule.activity.getExternalFilesDir(null), "chat-operation-baseline/$name.png")
        out.parentFile?.mkdirs()
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        check(rule.activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
    }

    private fun render(dark: Boolean, status: TimelineOperationStatus, name: String) {
        val item = TimelineItem.Operation("fixture-operation", 1, TimelineOperationKind.Command,
            "Run project checks", "Checking the project", status,
            inputJson = "git status --short\nnpm test", outputJson = "Tests passed\nAll checks completed",
            exitCode = when (status) { TimelineOperationStatus.InProgress -> null; TimelineOperationStatus.Failed -> 1; else -> 0 })
        val summary = TurnOperationSummary(1, if (status == TimelineOperationStatus.InProgress) 1 else 0,
            if (status == TimelineOperationStatus.Failed) 1 else 0, status == TimelineOperationStatus.InProgress,
            item.title, listOf(item))
        rule.setContent { RagentTheme(darkTheme = dark) { Sample(summary) } }
        capture("$name-collapsed")
        SystemClock.sleep(700)
        rule.onNodeWithTag("operation-toggle").performClick()
        capture("$name-expanded")
        SystemClock.sleep(700)
    }

    @Composable private fun Sample(summary: TurnOperationSummary) {
        Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(20.dp)) {
            OperationGroup(summary, onOpenFileDiff = {})
        }
    }

    @Test fun completedLight() = render(false, TimelineOperationStatus.Completed, "completed-light")
    @Test fun completedDark() = render(true, TimelineOperationStatus.Completed, "completed-dark")
    @Test fun runningLight() = render(false, TimelineOperationStatus.InProgress, "running-light")
    @Test fun failedDark() = render(true, TimelineOperationStatus.Failed, "failed-dark")

    private fun localized(locale: Locale, name: String) {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(locale) })
        val item = TimelineItem.Operation("localized-operation", 1, TimelineOperationKind.Command,
            "Run checks", "Checking", TimelineOperationStatus.Completed, inputJson = "npm test", outputJson = "OK", exitCode = 0)
        val summary = TurnOperationSummary(1, 0, 0, false, item.title, listOf(item))
        rule.setContent { CompositionLocalProvider(LocalContext provides context) { RagentTheme { Sample(summary) } } }
        rule.onNodeWithTag("operation-toggle").assertHasClickAction().assertContentDescriptionContains(
            context.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_details_show), substring = true)
        rule.onNodeWithTag("operation-toggle").performClick()
        rule.onNodeWithTag("operation-toggle").assertContentDescriptionContains(
            context.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_details_hide), substring = true)
        rule.onNodeWithText(context.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_input)).assertIsDisplayed()
        rule.onNodeWithText(context.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_output)).assertIsDisplayed()
        rule.onNodeWithText(context.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_done)).assertIsDisplayed()
        capture("localized-$name")
    }
    @Test fun localeEnglish() = localized(Locale.ENGLISH, "en")
    @Test fun localeChinese() = localized(Locale.SIMPLIFIED_CHINESE, "zh-cn")
    @Test fun localeTraditionalChinese() = localized(Locale.TRADITIONAL_CHINESE, "zh-tw")
    @Test fun localeJapanese() = localized(Locale.JAPANESE, "ja")
    @Test fun localeKorean() = localized(Locale.KOREAN, "ko")
    @Test fun localeFrench() = localized(Locale.FRENCH, "fr")
    @Test fun localeSpanish() = localized(Locale("es"), "es")

    @Test fun narrowLargeTextLongOutput() {
        val input = "git log --format=oneline --all --decorate --no-abbrev-commit --max-count=25"
        val item = TimelineItem.Operation("long-operation", 1, TimelineOperationKind.Command,
            "Inspect a project with a long descriptive name", "Checking", TimelineOperationStatus.Failed,
            inputJson = input, outputJson = "Permission denied for the selected project", exitCode = 1)
        val summary = TurnOperationSummary(1, 0, 1, false, item.title, listOf(item))
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 1.3f)) {
                RagentTheme { Box(Modifier.width(320.dp).fillMaxHeight().background(LocalRagentColors.current.canvas).padding(16.dp)) {
                    OperationGroup(summary, onOpenFileDiff = {})
                } }
            }
        }
        rule.onNodeWithTag("operation-toggle").performClick()
        rule.onNodeWithText(input).assertIsDisplayed()
        rule.onNodeWithText("Permission denied for the selected project").assertIsDisplayed()
        capture("failed-narrow-large")
    }

    @Test fun controlledExpansionFrames() {
        val item = TimelineItem.Operation("motion-operation", 1, TimelineOperationKind.Command,
            "Run checks", "Checking", TimelineOperationStatus.Completed, inputJson = "npm test", outputJson = "OK", exitCode = 0)
        val summary = TurnOperationSummary(1, 0, 0, false, item.title, listOf(item))
        rule.setContent { RagentTheme { Sample(summary) } }
        rule.mainClock.autoAdvance = false
        try {
            capture("motion-closed")
            rule.onNodeWithTag("operation-toggle").performClick()
            rule.mainClock.advanceTimeBy(64)
            capture("motion-064ms")
            rule.mainClock.advanceTimeBy(80)
            capture("motion-144ms")
            rule.mainClock.advanceTimeBy(600)
            capture("motion-settled")
            rule.onNodeWithTag("operation-toggle").performClick()
            rule.mainClock.advanceTimeBy(64)
            capture("motion-close-064ms")
            rule.mainClock.advanceTimeBy(600)
            capture("motion-close-settled")
        } finally {
            rule.mainClock.autoAdvance = true
        }
    }

}
