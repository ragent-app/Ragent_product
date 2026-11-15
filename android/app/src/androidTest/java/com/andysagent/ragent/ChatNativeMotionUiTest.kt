package com.andysagent.ragent

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineOperationKind
import com.andysagent.ragent.core.timeline.TimelineOperationStatus
import com.andysagent.ragent.feature.workbench.OperationGroup
import com.andysagent.ragent.feature.workbench.TurnOperationSummary
import org.junit.Assert.assertNotNull
import org.junit.Test

/** Runs without a Compose test clock; external screen recording captures real device frames. */
class ChatNativeMotionUiTest {
    @Test fun nativeTouchExpansionAndCollapse() {
        val item = TimelineItem.Operation("native-motion", 1, TimelineOperationKind.Command,
            "Run checks", "Checking", TimelineOperationStatus.Completed, inputJson = "npm test", outputJson = "OK", exitCode = 0)
        val summary = TurnOperationSummary(1, 0, 0, false, item.title, listOf(item))
        val inst = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(inst)
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            var showLabel = ""
            var hideLabel = ""
            scenario.onActivity { activity ->
                showLabel = activity.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_details_show)
                hideLabel = activity.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_details_hide)
                activity.setContent { RagentTheme {
                    Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(20.dp)) {
                        OperationGroup(summary, onOpenFileDiff = {})
                    }
                } }
            }
            val show = device.wait(Until.findObject(By.descContains(showLabel)), 5_000)
            assertNotNull(show)
            SystemClock.sleep(1000)
            show.click()
            val hide = device.wait(Until.findObject(By.descContains(hideLabel)), 5_000)
            assertNotNull(hide)
            SystemClock.sleep(1200)
            hide.click()
            assertNotNull(device.wait(Until.findObject(By.descContains(showLabel)), 5_000))
            SystemClock.sleep(1000)
        }
    }
}
