package com.andysagent.agentoc

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.*
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.andysagent.agentoc.core.agentui.AgentComposer
import com.andysagent.agentoc.core.agentui.ComposerSelectedCapability
import com.andysagent.agentoc.core.agentui.ComposerSlashSuggestion
import com.andysagent.agentoc.core.agentui.clearComposerSlashToken
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import java.io.FileOutputStream
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ComposerSlashPaletteUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun trailingSlashQueryShowsAndSelectsHarnessSkill() {
        val suggestion = ComposerSlashSuggestion(
            id = "codex:skill:review",
            kind = "skill",
            source = "codex",
            title = "review",
            description = "Review the current changes.",
            invocationText = "\$review ",
        )
        var selected: ComposerSlashSuggestion? = null
        var draft by mutableStateOf("Inspect this")
        compose.setContent {
            val density = LocalDensity.current
            AgentocTheme(darkTheme = false) {
                Box(Modifier.fillMaxSize()) {
                    AgentComposer(
                        value = draft,
                        onValueChange = { draft = it },
                        onSend = {},
                        onStop = {},
                        working = false,
                        onAddAttachment = {},
                        expanded = true,
                        runtimeTool = "codex",
                        slashSuggestions = listOf(suggestion),
                        onSelectSlashSuggestion = { selected = it },
                        backdropOrigin = IntOffset(0, with(density) { 700.dp.roundToPx() }),
                    )
                }
            }
        }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(instrumentation)
        compose.runOnIdle { draft = "Inspect this /rev" }
        compose.waitForIdle()
        device.waitForIdle()

        // Popup content is hosted in a separate Android window. UiAutomator
        // verifies the real device accessibility surface and click path rather
        // than relying on the Compose test root registry for that window.
        val candidate = device.wait(Until.findObject(By.text("review")), 5_000)
        if (candidate == null) {
            val nodes = StringBuilder()
            fun appendNode(node: android.view.accessibility.AccessibilityNodeInfo, depth: Int) {
                nodes.append("  ".repeat(depth)).append(node.className).append(" text=")
                    .append(node.text).append(" desc=").append(node.contentDescription).append('\n')
                for (index in 0 until node.childCount) node.getChild(index)?.let { appendNode(it, depth + 1) }
            }
            instrumentation.uiAutomation.rootInActiveWindow?.let { appendNode(it, 0) }
            println("SLASH_UI_HIERARCHY_BEGIN\n$nodes\nSLASH_UI_HIERARCHY_END")
            instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
                val screenshot = File(instrumentation.context.cacheDir, "slash-palette-evidence/agentoc-slash-palette-ui.png")
                screenshot.parentFile?.mkdirs()
                FileOutputStream(screenshot).use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                println("SLASH_UI_SCREENSHOT=${screenshot.absolutePath}")
            }
        }
        assertNotNull("The slash palette did not expose the matching skill", candidate)
        assertNotNull(
            "The slash palette did not show the skill's content hint",
            device.wait(Until.findObject(By.text(suggestion.description)), 5_000),
        )
        candidate.click()
        device.waitForIdle()
        instrumentation.runOnMainSync { assertEquals(suggestion, selected) }
    }

    @Test
    fun selectingMcpAddsRemovableCapabilityChip() {
        val suggestion = ComposerSlashSuggestion(
            id = "agentoc:mcp:agentoc",
            kind = "mcp",
            source = "agentoc",
            title = "agentoc",
            description = "AgentoC MCP server",
            enabled = true,
            selectionMode = "attach",
        )
        var draft by mutableStateOf("")
        var selected by mutableStateOf(emptyList<ComposerSelectedCapability>())
        compose.setContent {
            val density = LocalDensity.current
            AgentocTheme(darkTheme = false) {
                Box(Modifier.fillMaxSize()) {
                    AgentComposer(
                        value = draft,
                        onValueChange = { draft = it },
                        onSend = {},
                        onStop = {},
                        working = false,
                        onAddAttachment = {},
                        expanded = true,
                        runtimeTool = "codex",
                        slashSuggestions = listOf(suggestion),
                        onSelectSlashSuggestion = { item ->
                            selected = selected + ComposerSelectedCapability(item.id, item.kind, item.source, item.title)
                            draft = clearComposerSlashToken(draft).orEmpty()
                        },
                        selectedCapabilities = selected,
                        onRemoveSelectedCapability = { id -> selected = selected.filterNot { it.id == id } },
                        backdropOrigin = IntOffset(0, with(density) { 700.dp.roundToPx() }),
                    )
                }
            }
        }
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        compose.runOnIdle { draft = "/agentoc" }
        compose.waitForIdle()
        val candidate = device.wait(Until.findObject(By.text("agentoc")), 5_000)
        assertNotNull("The MCP candidate was not visible on the device", candidate)
        candidate.click()
        device.waitForIdle()

        val chipTag = "composer-selected-capability-${suggestion.id.hashCode().toUInt().toString(16)}"
        val removeTag = "composer-selected-capability-remove-${suggestion.id.hashCode().toUInt().toString(16)}"
        compose.onNodeWithTag(chipTag).assertExists()
        compose.onNodeWithTag(removeTag).assertExists().performClick()
        compose.onNodeWithTag(chipTag).assertDoesNotExist()
    }
}
