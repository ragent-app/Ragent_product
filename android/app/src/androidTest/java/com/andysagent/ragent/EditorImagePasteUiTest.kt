package com.andysagent.ragent

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.MarkdownComposerEditor
import com.andysagent.ragent.core.designsystem.RagentTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Isolate the real editor's keyboard paste path from attachment import/rendering. */
@OptIn(ExperimentalTestApi::class)
class EditorImagePasteUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun pasteKeyDeliversTheImageUriWithoutInsertingText() = verifyPaste(false)
    @Test fun controlVDeliversTheImageUriWithoutInsertingText() = verifyPaste(true)

    @Test fun imageClipSurvivesWithoutAnyEditor() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val source = File(context.cacheDir, "shared/editor-paste-control.png")
        source.parentFile!!.mkdirs()
        val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
        source.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        bitmap.recycle()
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", source)
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        try {
            compose.setContent { Surface(Modifier.fillMaxSize()) {} }
            compose.runOnIdle {
                clipboard.setPrimaryClip(ClipData(ClipDescription("Image control", arrayOf("image/png")), ClipData.Item(uri)))
                assertImageClip(clipboard, uri)
            }
            // Observe asynchronously after system clipboard listeners have run.
            android.os.SystemClock.sleep(350)
            compose.runOnIdle { assertImageClip(clipboard, uri) }
        } finally {
            source.delete()
        }
    }

    private fun verifyPaste(controlV: Boolean) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val source = File(context.cacheDir, "shared/editor-paste-probe.png")
        source.parentFile!!.mkdirs()
        val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
        source.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        bitmap.recycle()
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", source)
        val pasted = mutableListOf<Uri>()
        val draft = mutableStateOf("")
        try {
            compose.setContent {
                RagentTheme {
                    Surface(Modifier.fillMaxSize().safeDrawingPadding()) {
                        Box(Modifier.padding(20.dp)) {
                            MarkdownComposerEditor(
                                value = draft.value,
                                onValueChange = { draft.value = it },
                                onPasteImage = { pasted += it },
                                modifier = Modifier.fillMaxWidth().height(160.dp),
                                textStyle = MaterialTheme.typography.bodyLarge,
                                isDark = false,
                            )
                        }
                    }
                }
            }
            val editor = compose.onNode(hasSetTextAction())
            editor.performSemanticsAction(SemanticsActions.RequestFocus)
            editor.assertIsFocused()
            compose.runOnIdle {
                val clipboard = context.getSystemService(ClipboardManager::class.java)
                clipboard.setPrimaryClip(ClipData(ClipDescription("Image probe", arrayOf("image/png")), ClipData.Item(uri)))
                assertImageClip(clipboard, uri)
            }
            compose.runOnIdle { assertImageClip(context.getSystemService(ClipboardManager::class.java), uri) }
            editor.performKeyInput {
                if (controlV) {
                    keyDown(Key.CtrlLeft)
                    pressKey(Key.V)
                    keyUp(Key.CtrlLeft)
                } else {
                    pressKey(Key.Paste)
                }
            }
            compose.runOnIdle {
                assertEquals(listOf(uri), pasted)
                assertEquals("", draft.value)
            }
            editor.assertTextEquals("")
        } finally {
            source.delete()
        }
    }

    private fun assertImageClip(clipboard: ClipboardManager, expected: Uri) {
        val clip = clipboard.primaryClip
        val types = clip?.description?.let { description ->
            (0 until description.mimeTypeCount).map(description::getMimeType)
        }
        assertTrue("Expected image clipboard; types=$types, expectedUri=${clip?.getItemAt(0)?.uri == expected}",
            clip?.description?.hasMimeType("image/*") == true)
        assertEquals(expected, clip?.getItemAt(0)?.uri)
    }
}
