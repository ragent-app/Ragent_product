package com.andysagent.ragent

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.andysagent.ragent.core.agentui.AgentMessageActionBar
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Test

class ChatActionBarNativeVisualTest {
    @Test fun lightBaseline() = capture(false)
    @Test fun darkBaseline() = capture(true)

    @Test fun nativeActionsHaveAccessibleTargetsAndInvokeCallbacks() {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val branches = AtomicInteger()
        val reports = AtomicInteger()
        val restarts = AtomicInteger()
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            var labels = emptyList<String>()
            var copied = ""
            var minPixels = 0f
            scenario.onActivity { activity ->
                labels = listOf(activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_copy_message), activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_branch_from_message),
                    activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_report_content), activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_regenerate))
                copied = activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_copied)
                minPixels = 48 * activity.resources.displayMetrics.density
                activity.setContent { RagentTheme {
                    Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(20.dp)) {
                        Text("The changes are ready for review.", color = LocalRagentColors.current.primaryContent)
                        AgentMessageActionBar("The changes are ready for review.", true,
                            { branches.incrementAndGet() }, { restarts.incrementAndGet() }, onReport = { reports.incrementAndGet() })
                    }
                } }
            }
            labels.forEach { label ->
                val button = device.wait(Until.findObject(By.desc(label)), 5_000)
                assertNotNull("Missing accessible action $label", button)
                val bounds = button.visibleBounds
                assertTrue("$label target width: $bounds", bounds.width() >= minPixels - 1)
                assertTrue("$label target height: $bounds", bounds.height() >= minPixels - 1)
                button.click()
                SystemClock.sleep(300)
                if (label == labels.first()) assertNotNull(device.wait(Until.findObject(By.desc(copied)), 2_000))
            }
            assertEquals(1, branches.get())
            assertEquals(1, reports.get())
            assertEquals(1, restarts.get())
            SystemClock.sleep(700)
        }
    }

    private fun capture(dark: Boolean) {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            var copyLabel = ""
            scenario.onActivity { activity ->
                copyLabel = activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_copy_message)
                activity.setContent { RagentTheme(darkTheme = dark) {
                    Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(20.dp)) {
                        Text("The changes are ready for review.", color = LocalRagentColors.current.primaryContent)
                        AgentMessageActionBar(text = "The changes are ready for review.", isLastMessage = true,
                            onBranch = {}, onRestart = {}, onReport = {})
                    }
                } }
            }
            assertNotNull(device.wait(Until.findObject(By.desc(copyLabel)), 5_000))
            SystemClock.sleep(3500)
        }
    }
}
