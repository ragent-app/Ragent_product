package com.andysagent.ragent

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.input.key.Key
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.R as AgentUiR
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToLog
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream

@RunWith(AndroidJUnit4::class)
class ClipboardImagePasteUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun agentUiText(resId: Int, vararg formatArgs: Any): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resId, *formatArgs)

    @Test
    @OptIn(ExperimentalTestApi::class)
    fun pastingClipboardImageCreatesAnAttachmentInsteadOfText() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val source = File(context.cacheDir, "shared/test-clipboard-image.png").apply {
            parentFile?.mkdirs()
        }
        try {
            FileOutputStream(source).use { output ->
                val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
                bitmap.recycle()
            }
            val sourceUri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.files",
                source,
            )
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(
                ClipData(
                    ClipDescription("Clipboard image", arrayOf("image/png")),
                    ClipData.Item(sourceUri),
                ),
            )

            composeRule.setContent {
                RagentTheme {
                    WorkbenchScreen(
                        WorkbenchUiState(
                            chatOpen = true,
                            sessionId = "clipboard-image-test",
                            connection = AgentConnectionStatus.Connected,
                        ),
                    )
                }
            }

            composeRule.onNodeWithContentDescription(agentUiText(AgentUiR.string.agentui_message_composer)).performClick()
            composeRule.waitForIdle()
            val editor = composeRule.onNode(hasSetTextAction())
            editor.performSemanticsAction(SemanticsActions.RequestFocus)
            editor.assertIsFocused()
            composeRule.runOnIdle {
                assertTrue("Activity must own window focus before pasting", composeRule.activity.hasWindowFocus())
                val clip = clipboard.primaryClip
                val types = clip?.description?.let { description ->
                    (0 until description.mimeTypeCount).map(description::getMimeType)
                }
                assertTrue("Image MIME type must survive editor setup; types=$types, expectedUri=${clip?.getItemAt(0)?.uri == sourceUri}", clipboard.primaryClipDescription?.hasMimeType("image/*") == true)
                assertEquals("Image URI must survive editor setup", sourceUri, clipboard.primaryClip?.getItemAt(0)?.uri)
            }
            editor.performKeyInput {
                pressKey(Key.Paste)
            }

            composeRule.waitUntil(5_000) {
                composeRule.onAllNodesWithText("pasted-image.png").fetchSemanticsNodes().isNotEmpty()
            }
            assertTrue(
                "The clipboard image should appear as an attachment",
                composeRule.onAllNodesWithText("pasted-image.png").fetchSemanticsNodes().isNotEmpty(),
            )
        } catch (failure: Throwable) {
            composeRule.onRoot(useUnmergedTree = true).printToLog("ClipboardImagePasteFailure")
            val screenshot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            screenshot?.let { bitmap ->
                val evidence = File(context.getExternalFilesDir(null), "clipboard-image-failure.png")
                evidence.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
            throw failure
        } finally {
            source.delete()
        }
    }
}
