package com.andysagent.agentoc

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.andysagent.agentoc.core.agentui.AgentComposer
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import java.util.Locale
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Check real bounds, not only semantics' minimum expanded touch targets. */
class ComposerActionRailUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val events = mutableListOf<String>()

    private fun show(
        goal: Boolean = false,
        expanded: Boolean = true,
        largeText: Boolean = true,
        withVoice: Boolean = false,
    ) {
        val context = compose.activity.createConfigurationContext(
            Configuration(compose.activity.resources.configuration).apply { setLocale(Locale.FRENCH) },
        )
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalContext provides context,
                LocalDensity provides Density(density.density, if (largeText) 2f else 1f)) {
                AgentocTheme(darkTheme = largeText) {
                    Box(Modifier.width(320.dp).padding(horizontal = 16.dp)) {
                        AgentComposer(
                            value = if (expanded) "First line\nSecond line\n**Important**: verify `healthz`" else "",
                            onValueChange = {}, onSend = { events += "send" }, onStop = {}, working = false,
                            attachmentsEnabled = true, onAddAttachment = { events += "attachment" },
                            expanded = expanded, runtimeTool = "Un modèle au nom exceptionnellement long",
                            onOpenRuntimePicker = { events += "model" },
                            onOpenEffortPicker = { events += "effort" },
                            goalMode = goal, goalText = "Un objectif très détaillé",
                            onGoalClick = { events += "goal" },
                            onVoiceClick = if (withVoice) ({ events += "voice" }) else null,
                        )
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    private fun checkRail(goal: Boolean = false) {
        val rail = compose.onNodeWithTag("composer-action-rail").getUnclippedBoundsInRoot()
        val names = listOf("attachment") + (if (goal) listOf("goal") else emptyList()) + listOf("effort", "model", "send")
        val bounds = names.map { name ->
            compose.onNodeWithTag("composer-$name-action")
                .assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
                .getUnclippedBoundsInRoot().also {
                    assertTrue("$name escaped $rail: $it", it.left >= rail.left && it.right <= rail.right &&
                        it.top >= rail.top && it.bottom <= rail.bottom)
                }
        }
        bounds.zipWithNext().forEach { (left, right) -> assertTrue("Overlapping targets: $left / $right", left.right <= right.left) }
        compose.onNodeWithTag("composer-send-disc", useUnmergedTree = true)
            .assertWidthIsEqualTo(34.dp).assertHeightIsEqualTo(34.dp)
        // Dispatch through pointer hit testing, not semantic onClick shortcuts.
        names.forEach { compose.onNodeWithTag("composer-$it-action").performTouchInput { click() } }
        compose.runOnIdle { assertEquals(names, events) }
    }

    @Test fun frenchLargeTextRetainsCircularSendAndSeparateTargets() { show(); checkRail() }
    @Test fun goalModeDoesNotStealTheSendOrModelTarget() { show(goal = true); checkRail(goal = true) }
    @Test fun ordinaryTextRetainsTheSameActionGeometry() { show(largeText = false); checkRail() }
    @Test fun collapsedHintStaysClearOfTrailingMicrophoneWhenSendIsHidden() {
        show(expanded = false, withVoice = true)
        val voice = compose.onNodeWithTag("composer-voice-action").assertIsDisplayed().getUnclippedBoundsInRoot()
        val hint = compose.onNodeWithTag("composer-collapsed-hint", useUnmergedTree = true).getUnclippedBoundsInRoot()
        compose.onNodeWithTag("composer-send-action").assertDoesNotExist()
        assertTrue("Collapsed hint overlaps the microphone", hint.right <= voice.left)
    }
}
