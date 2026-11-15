package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.datastore.ComputerDirectory
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.appapi.CaptureScreen
import com.andysagent.ragent.feature.appapi.CaptureUiState
import org.junit.Rule
import org.junit.Test

class SmartIntakeUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun clarificationIsVisibleWithoutProjectPicker() {
        val draft = CaptureDraft("draft", "owner", 0, input = CaptureInput("Reference"),
            instruction = "Help with this", targetInstanceId = "pc-fixed", intakeId = "intake-draft",
            intakeDecision = IntakeDecision(1, "intake-draft", "decision", "a".repeat(64),
                "pc-fixed", "needs_clarification", question = "Is this a new product?",
                contextComplete = true, requiresClarification = true))
        compose.setContent { RagentTheme {
            CaptureScreen(CaptureUiState(loading = false, draft = draft, directory = ComputerDirectory()), {})
        } }
        compose.onNodeWithText("Is this a new product?").assertIsDisplayed()
    }
}
