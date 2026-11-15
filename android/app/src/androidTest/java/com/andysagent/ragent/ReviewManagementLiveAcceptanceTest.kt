package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Read-only management UI acceptance against the isolated reviewer instance. */
class ReviewManagementLiveAcceptanceTest {
    @get:Rule val rule = createEmptyComposeRule()
    @Test fun fullReviewerCanOpenProviderAndHarnessManagement() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveHonorManagement") == "ADNQ6R5716008635")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        try {
        assertEquals("full", runBlocking { app.runtime.ensureAccountSession() }.demoAccessMode)
        instrumentation.runOnMainSync { app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        val settings = app.getString(com.andysagent.ragent.feature.workbench.R.string.settings_title)
        rule.waitUntil(30_000) { rule.onAllNodesWithText(settings).fetchSemanticsNodes().isNotEmpty() }
        rule.onAllNodesWithText(settings).onLast().performClick()
        rule.waitUntil(15_000) { rule.onAllNodesWithTag("settings-list").fetchSemanticsNodes().isNotEmpty() }
        val tools = app.getString(com.andysagent.ragent.feature.workbench.R.string.settings_workspace_tools)
        rule.waitUntil(30_000) { rule.onAllNodesWithText(tools).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText(tools).performScrollTo().performClick()
        val providers = app.getString(com.andysagent.ragent.feature.workbench.R.string.settings_model_providers)
        val harnesses = app.getString(com.andysagent.ragent.feature.workbench.R.string.settings_harnesses)
        rule.onNodeWithText(providers).performScrollTo().assertIsDisplayed().performClick()
        rule.waitUntil(30_000) { rule.onAllNodesWithText("Review Codex Luna", substring = true).fetchSemanticsNodes().isNotEmpty() }
        val addProvider = app.getString(com.andysagent.ragent.feature.workbench.R.string.sp_add_provider)
        val addModelProvider = app.getString(com.andysagent.ragent.feature.workbench.R.string.sp_add_model_provider)
        rule.onNodeWithText(addProvider).performScrollTo().assertIsEnabled().performClick()
        rule.onNodeWithText(addModelProvider).assertIsDisplayed()
        instrumentation.sendStatus(2, Bundle().apply { putString("managementStage", "supplied-provider-visible-and-add-dialog-open") })
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        rule.waitForIdle()
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        rule.waitUntil(15_000) { rule.onAllNodesWithTag("settings-list").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText(harnesses).performScrollTo().performClick()
        rule.waitUntil(30_000) { rule.onAllNodesWithText("Codex", substring = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("harness-catalog").performScrollToNode(hasText("Claude Code"))
        rule.onNodeWithText("Claude Code").assertIsDisplayed()
        rule.onNodeWithTag("harness-catalog").performScrollToNode(hasText("Kilo Code"))
        rule.onNodeWithText("Kilo Code").assertIsDisplayed()
        rule.waitUntil(10_000) { rule.onAllNodesWithText("Session could not be refreshed", substring = true).fetchSemanticsNodes().isEmpty() }
        instrumentation.sendStatus(2, Bundle().apply { putString("managementStage", "harness-catalog-through-kilo-visible-without-stale-carrier-error") })
        } finally {
            runBlocking {
                try {
                    val devices = app.runtime.listAccountDirectoryDevices()
                    instrumentation.sendStatus(2, Bundle().apply { putString("centralDirectory", devices.joinToString(";") { "${it.deviceKind}:${it.instanceId}:${it.unboundAt != null}" }) })
                } catch (error: Exception) {
                    val code = when (error) {
                        is com.andysagent.ragent.core.domain.AccountsRepositoryException -> "${error.statusCode}:${error.code}"
                        is com.andysagent.ragent.core.auth.AccountSessionException -> "${error.statusCode}:${error.code}"
                        else -> error.javaClass.simpleName
                    }
                    instrumentation.sendStatus(2, Bundle().apply { putString("centralDirectoryError", code) })
                }
            }
            val directory = runBlocking { app.runtime.configStore.directory.first() }
            instrumentation.sendStatus(2, Bundle().apply { putString("managementDirectory", "count=${directory.computers.size};active=${directory.activeTargetId};carrier=${app.runtime.transport.connectionState.value}") })
            val root = java.io.File(app.cacheDir, "review-management").apply { mkdirs() }
            runCatching { java.io.File(root, "semantics.txt").writeText(rule.onRoot(useUnmergedTree = true).printToString()) }
            instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
                java.io.File(root, "final.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
        }
    }
}
