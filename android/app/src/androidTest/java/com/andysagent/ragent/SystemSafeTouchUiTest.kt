package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class SystemSafeTouchUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun aFullViewportClickTargetCannotReceiveTouchesInSystemBands() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        val clicks = mutableIntStateOf(0)
        rule.setContent {
            RagentTheme {
                Box(Modifier.fillMaxSize().clickable { clicks.intValue++ })
            }
        }
        rule.onRoot().performTouchInput { click(Offset(width / 4f, 2f)) }
        rule.runOnIdle { assertEquals("Top system band reached app callback", 0, clicks.intValue) }
        rule.onRoot().performTouchInput { click(Offset(width / 4f, height - 2f)) }
        rule.runOnIdle { assertEquals("Bottom system band reached app callback", 0, clicks.intValue) }
        rule.onNodeWithTag("app-system-safe-content").performTouchInput { click() }
        rule.runOnIdle { assertEquals("Safe viewport must remain interactive", 1, clicks.intValue) }
    }

    @Test fun overflowingChildrenCannotReceiveTouchesOutsideSafeViewport() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        val clicks = mutableIntStateOf(0)
        rule.setContent {
            RagentTheme {
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    Box(Modifier.align(Alignment.TopCenter).offset(y = (-80).dp)
                        .size(100.dp).clickable { clicks.intValue++ })
                    Box(Modifier.align(Alignment.TopCenter).offset(y = maxHeight - 12.dp)
                        .size(100.dp).testTag("overflowing-bottom-target")
                        .clickable { clicks.intValue++ })
                }
            }
        }
        val viewport = rule.onNodeWithTag("app-system-safe-content").getUnclippedBoundsInRoot()
        val density = rule.activity.resources.displayMetrics.density
        // These are real pointer events, not accessibility/semantic performClick actions.
        rule.onRoot().performTouchInput {
            click(Offset(width / 2f, viewport.top.value * density / 2f))
            click(Offset(width / 2f, height - 2f))
        }
        rule.runOnIdle { assertEquals("Overflow child reached system-band callback", 0, clicks.intValue) }
        rule.onNodeWithTag("overflowing-bottom-target").performTouchInput {
            click(Offset(width / 2f, 2f))
        }
        rule.runOnIdle { assertEquals("Visible part of overflow child must stay interactive", 1, clicks.intValue) }
    }
}
