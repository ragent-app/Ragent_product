package com.andysagent.ragent

import android.graphics.Bitmap
import android.os.SystemClock
import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import org.junit.Assert.assertTrue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.workbench.ComposerAttachment
import com.andysagent.ragent.feature.workbench.TurnUserPrompt
import com.andysagent.ragent.feature.workbench.UserPromptBlock
import java.io.File
import java.util.Locale
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertEquals

/** Physical-display reference for the existing user prompt, attachments and menu. */
class ChatBubbleVisualBaselineTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private fun capture(name: String) {
        rule.waitForIdle()
        rule.waitUntil(5_000) { rule.activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }
        SystemClock.sleep(400)
        val file = File(rule.activity.getExternalFilesDir(null), "chat-bubble-baseline/$name.png")
        file.parentFile?.mkdirs()
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        check(rule.activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
    }

    private fun render(dark: Boolean, prompt: TurnUserPrompt, name: String, menu: Boolean = false) {
        rule.setContent { RagentTheme(darkTheme = dark) {
            Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(20.dp)) {
                UserPromptBlock(prompt, onBranch = {}, onEditResend = {}, onRetry = {})
            }
        } }
        capture(name)
        if (menu) {
            rule.onNodeWithText(prompt.text).performTouchInput { longClick() }
            capture("$name-menu")
        }
    }

    @Test fun bubbleWidthAdaptsToText() {
        rule.setContent { RagentTheme {
            Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(20.dp)) {
                UserPromptBlock(TurnUserPrompt("tiny-width", "Hi"), {}, {}, {})
                UserPromptBlock(TurnUserPrompt("long-width", "A longer message with multiple words that should wrap within the available width. ".repeat(4)), {}, {}, {})
            }
        } }
        val shortBounds = rule.onNodeWithTag("user-message-bubble-tiny-width").getUnclippedBoundsInRoot()
        val longBounds = rule.onNodeWithTag("user-message-bubble-long-width").getUnclippedBoundsInRoot()
        val shortWidth = shortBounds.right - shortBounds.left
        val longWidth = longBounds.right - longBounds.left
        assertTrue("Short bubble should be substantially narrower than long bubble: $shortWidth vs $longWidth", shortWidth < longWidth * 0.6f)
        capture("adaptive-width")
    }

    @Test fun shortLightMenu() = render(false, TurnUserPrompt("short", "Please check the project."), "short-light", true)
    @Test fun shortDark() = render(true, TurnUserPrompt("short-dark", "请检查这个项目。"), "short-dark")
    @Test fun attachmentAndLongMessage() {
        render(false, TurnUserPrompt("long", "Please inspect these files and explain the changes. ".repeat(8),
            attachments = listOf(ComposerAttachment(name = "project-notes.md", mimeType = "text/markdown"),
                ComposerAttachment(name = "screen.png", mimeType = "image/png"))), "long-attachments")
        rule.onNodeWithText(rule.activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_expand)).assertIsDisplayed().performClick()
        rule.onNodeWithText(rule.activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_collapse)).assertIsDisplayed()
        capture("long-expanded")
    }
    @Test fun failed() = render(false, TurnUserPrompt("failed", "Try this task again", pendingFailed = true), "failed-light")

    @Test fun retryAndMultipleAttachmentsRemainAccessible() {
        var retries = 0
        val prompt = TurnUserPrompt("retry", "Try this task again", pendingFailed = true,
            attachments = listOf(ComposerAttachment(name = "first-document.md", mimeType = "text/markdown"),
                ComposerAttachment(name = "second-document.md", mimeType = "text/markdown"),
                ComposerAttachment(name = "third-document.md", mimeType = "text/markdown")))
        rule.setContent { RagentTheme {
            Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(20.dp)) {
                UserPromptBlock(prompt, onBranch = {}, onEditResend = {}, onRetry = { retries++ })
            }
        } }
        listOf("first-document.md", "second-document.md", "third-document.md").forEach {
            rule.onNodeWithText(it).assertIsDisplayed()
        }
        rule.onNodeWithText(rule.activity.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_retry)).performClick()
        rule.runOnIdle { assertEquals(1, retries) }
        capture("multiple-attachments")
    }

    private fun localizedFailure(locale: Locale, name: String) {
        val context = rule.activity.createConfigurationContext(Configuration(rule.activity.resources.configuration).apply { setLocale(locale) })
        rule.setContent { CompositionLocalProvider(LocalContext provides context) { RagentTheme {
            Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(20.dp)) {
                UserPromptBlock(TurnUserPrompt("localized", "Example", pendingFailed = true), {}, {}, {})
            }
        } } }
        rule.onNodeWithText(context.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_send_failed)).assertIsDisplayed()
        rule.onNodeWithText(context.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_retry)).assertIsDisplayed()
        capture("failure-$name")
    }
    @Test fun failureEnglish() = localizedFailure(Locale.ENGLISH, "en")
    @Test fun failureChinese() = localizedFailure(Locale.SIMPLIFIED_CHINESE, "zh-cn")
    @Test fun failureTraditionalChinese() = localizedFailure(Locale.TRADITIONAL_CHINESE, "zh-tw")
    @Test fun failureJapanese() = localizedFailure(Locale.JAPANESE, "ja")
    @Test fun failureKorean() = localizedFailure(Locale.KOREAN, "ko")
    @Test fun failureFrench() = localizedFailure(Locale.FRENCH, "fr")
    @Test fun failureSpanish() = localizedFailure(Locale("es"), "es")

    @Test fun wideShortEnoughToFit() {
        val message = "A short phrase with clear words. ".repeat(7)
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density * 0.48f, 1f)) {
                RagentTheme {
                    Column(Modifier.width(840.dp).fillMaxHeight().background(LocalRagentColors.current.canvas).padding(20.dp)) {
                        UserPromptBlock(TurnUserPrompt("wide-fit", message), {}, {}, {})
                    }
                }
            }
        }
        rule.onNodeWithText(rule.activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_expand)).assertDoesNotExist()
        capture("wide-fit")
    }
}
