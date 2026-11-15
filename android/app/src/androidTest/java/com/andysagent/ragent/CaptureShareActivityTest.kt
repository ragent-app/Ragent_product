package com.andysagent.ragent

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.andysagent.ragent.core.appapi.ApiErrorCode
import com.andysagent.ragent.core.appapi.AppApiException
import com.andysagent.ragent.core.appapi.CaptureDraft
import com.andysagent.ragent.core.model.AppLanguage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import java.io.File
import java.util.UUID

class CaptureShareActivityTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun coldShareIgnoresForgedDraftAndAutosubmitThenRotationAndInboxRestoreSavedEdits() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<RagentApplication>()
        val graph = app.runtime
        val language = graph.configStore.appLanguage.first()
        val source = "Shared reference ${UUID.randomUUID()}"
        var saved: CaptureDraft? = null
        try {
            graph.configStore.setAppLanguage(AppLanguage.SimplifiedChinese)
            val intent = Intent(app, ShareReceiverActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, source).putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, "forged")
                .putExtra("callerBinding", "forged").putExtra("autoStart", true).putExtra("confirmed", true)
            ActivityScenario.launch<ShareReceiverActivity>(intent).use { scenario ->
                compose.onNodeWithText("发送任务到电脑").assertIsDisplayed()
                compose.onNodeWithContentDescription("希望 Agent 做什么？").performTextReplacement("仅保存这项分析要求")
                compose.waitUntil(5_000) { runBlocking { graph.captureDrafts.observe(graph.appApiOwner).first().any { it.input.sharedText == source && it.instruction == "仅保存这项分析要求" } } }
                saved = graph.captureDrafts.observe(graph.appApiOwner).first().single { it.input.sharedText == source }
                assertNotEquals("forged", saved!!.draftId); assertEquals(graph.appApiOwner.binding, saved!!.callerBinding)
                assertNull(saved!!.operationId)
                androidx.test.espresso.Espresso.closeSoftKeyboard()
                compose.onNodeWithText("发送任务到电脑").assertIsDisplayed()
                val image = compose.onRoot().captureToImage().asAndroidBitmap()
                File(app.cacheDir, "appapi-capture-cold-zh.png").outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
                scenario.recreate()
                compose.onNodeWithContentDescription("希望 Agent 做什么？").assertTextContains("仅保存这项分析要求")
                val restored = graph.captureDrafts.observe(graph.appApiOwner).first().filter { it.input.sharedText == source }
                assertEquals(1, restored.size); assertEquals(saved!!.draftId, restored.single().draftId)
                compose.onNodeWithContentDescription("关闭").performClick()
                compose.waitUntil(5_000) { scenario.state == androidx.lifecycle.Lifecycle.State.DESTROYED }
            }
            ActivityScenario.launch<ShareDraftActivity>(Intent(app, ShareDraftActivity::class.java).putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, saved!!.draftId)).use {
                compose.onNodeWithText(source).assertIsDisplayed()
                compose.onNodeWithContentDescription("希望 Agent 做什么？").assertTextContains("仅保存这项分析要求")
                assertNull(graph.captureDrafts.get(saved!!.draftId, graph.appApiOwner)!!.operationId)
            }
        } finally {
            saved?.let { graph.captureDrafts.get(it.draftId, graph.appApiOwner)?.let { latest -> graph.captureDrafts.delete(latest.draftId, graph.appApiOwner, latest.revision) } }
            graph.configStore.setAppLanguage(language)
        }
    }
}
