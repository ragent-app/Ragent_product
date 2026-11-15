package com.andysagent.ragent.core.agentui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import com.andysagent.ragent.core.designsystem.RagentTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class DynamicEffortSliderTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun fiveServerLevelsRemainASliderAndSelectTheLastLevel() {
        var effort by mutableFloatStateOf(0f)
        rule.setContent {
            RagentTheme {
                EffortSliderPopover(effort = effort, onEffortChange = { effort = it }, onDismiss = {},
                    effortLevels = listOf("minimal", "low", "medium", "high", "max"))
            }
        }
        val slider = rule.onNodeWithContentDescription(rule.activity.getString(R.string.agentui_thinking_effort_slider))
        slider.assertIsDisplayed()
        slider.performSemanticsAction(SemanticsActions.SetProgress) { it(1f) }
        rule.runOnIdle { assertEquals(1f, effort, 0f) }
    }
}
