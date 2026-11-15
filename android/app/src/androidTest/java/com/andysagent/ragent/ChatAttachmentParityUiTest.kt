package com.andysagent.ragent

import android.graphics.Bitmap
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.core.content.FileProvider
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import org.junit.Assert.assertFalse
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.workbench.*
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ChatAttachmentParityUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun messageAndComposerUseRealThumbnailAndMatchingDocumentCards() = renderParity(false, false)
    @Test fun darkNarrowLargeTextAttachmentsRemainVisible() = renderParity(true, true)

    @Test fun contentUriLoadsSampledRealImage() {
        val folder = File(rule.activity.cacheDir, "shared").apply { mkdirs() }
        val file = File(folder, "uri-preview.png")
        Bitmap.createBitmap(800, 800, Bitmap.Config.ARGB_8888).also { bitmap ->
            bitmap.eraseColor(Color.rgb(20, 180, 40))
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        val uri = FileProvider.getUriForFile(rule.activity, "${rule.activity.packageName}.files", file)
        val attachment = ComposerAttachment(id = "content-real", name = "image.png", mimeType = "image/png", localPath = uri.toString())
        rule.setContent { RagentTheme { AttachmentThumbnailCard(attachment, null, modifier = Modifier.testTag("uri-image")) } }
        rule.waitUntil(8000) {
            val bitmap = rule.onNodeWithTag("uri-image").captureToImage().asAndroidBitmap()
            val c = bitmap.getPixel(bitmap.width / 2, bitmap.height / 2)
            Color.green(c) > 150 && Color.red(c) < 60 && Color.blue(c) < 80
        }
        val out = File(rule.activity.getExternalFilesDir(null), "chat-attachment-content-uri.png")
        rule.onNodeWithTag("uri-image").captureToImage().asAndroidBitmap().let { bitmap ->
            out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    @Test fun changingAttachmentNeverKeepsThePreviousThumbnail() {
        fun makeImage(name: String, color: Int): File {
            val file = File(rule.activity.cacheDir, name)
            Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).also { bitmap ->
                bitmap.eraseColor(color)
                file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
            return file
        }
        val red = ComposerAttachment(id = "swap-red", name = "red.png", mimeType = "image/png",
            localPath = makeImage("swap-red.png", Color.RED).absolutePath)
        val blue = ComposerAttachment(id = "swap-blue", name = "blue.png", mimeType = "image/png",
            localPath = makeImage("swap-blue.png", Color.BLUE).absolutePath)
        val missing = ComposerAttachment(id = "swap-missing", name = "missing.png", mimeType = "image/png")
        var current by mutableStateOf(red)
        rule.setContent { RagentTheme { AttachmentThumbnailCard(current, onRemove = null, modifier = Modifier.testTag("swap-image")) } }
        fun centerColor(): Int {
            val bitmap = rule.onNodeWithTag("swap-image").captureToImage().asAndroidBitmap()
            return bitmap.getPixel(bitmap.width / 2, bitmap.height / 2)
        }
        rule.waitUntil(8000) { val c = centerColor(); Color.red(c) > 220 && Color.blue(c) < 35 }
        rule.runOnIdle { current = blue }
        rule.waitUntil(8000) { val c = centerColor(); Color.blue(c) > 220 && Color.red(c) < 35 }
        rule.runOnIdle { current = missing }
        rule.waitForIdle()
        val fallback = centerColor()
        assertFalse("Missing image should not retain red or blue", Color.red(fallback) > 220 && Color.blue(fallback) < 35 || Color.blue(fallback) > 220 && Color.red(fallback) < 35)
        rule.onNodeWithContentDescription("missing.png").assertIsDisplayed()
        val out = File(rule.activity.getExternalFilesDir(null), "chat-attachment-swap-fallback.png")
        rule.onNodeWithTag("swap-image").captureToImage().asAndroidBitmap().let { bitmap ->
            out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    private fun renderParity(dark: Boolean, narrow: Boolean) {
        val imageFile = File(rule.activity.cacheDir, "attachment-parity-red.png")
        Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).also { bitmap ->
            bitmap.eraseColor(Color.rgb(225, 31, 35))
            imageFile.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        val image = ComposerAttachment(id = "real-image", name = "red.png", mimeType = "image/png", localPath = imageFile.absolutePath)
        val missing = ComposerAttachment(id = "missing-image", name = "missing.png", mimeType = "image/png")
        val document = ComposerAttachment(id = "real-document", name = "notes.pdf", mimeType = "application/pdf", sizeBytes = 2048)
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, if (narrow) 1.3f else density.fontScale)) {
            RagentTheme(darkTheme = dark) {
            Column(Modifier.then(if (narrow) Modifier.width(320.dp).fillMaxHeight() else Modifier.fillMaxSize())
                .background(LocalRagentColors.current.canvas).padding(20.dp)) {
                UserPromptBlock(TurnUserPrompt("attachments", "Review these files", listOf(image, document, missing)), {}, {}, {})
                Spacer(Modifier.height(24.dp))
                Row(Modifier.testTag("composer-reference"), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    AttachmentThumbnailCard(image, onRemove = {})
                    AttachmentThumbnailCard(document, onRemove = {})
                }
            }
        } } }
        rule.waitUntil(8000) {
            val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
            var red = 0
            for (y in 0 until bitmap.height step 6) for (x in 0 until bitmap.width step 6) {
                val pixel = bitmap.getPixel(x, y)
                if (Color.red(pixel) > 180 && Color.green(pixel) < 75 && Color.blue(pixel) < 75) red++
            }
            red > 100
        }
        rule.onAllNodesWithText("notes.pdf").assertCountEquals(2)
        rule.onAllNodesWithContentDescription("red.png").assertCountEquals(2)
        rule.onNodeWithContentDescription("missing.png").assertIsDisplayed()
        rule.onAllNodesWithContentDescription("Remove red.png").assertCountEquals(1)
        rule.onAllNodesWithContentDescription("Remove notes.pdf").assertCountEquals(1)
        val out = File(rule.activity.getExternalFilesDir(null), if (dark) "chat-attachment-parity-dark-narrow.png" else "chat-attachment-parity.png")
        rule.onRoot().captureToImage().asAndroidBitmap().let { bitmap ->
            out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        assertTrue(out.length() > 0)
    }
}
