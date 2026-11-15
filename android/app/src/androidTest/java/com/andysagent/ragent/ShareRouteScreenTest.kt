package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.appapi.ShareRoutePreview
import com.andysagent.ragent.feature.appapi.ShareRouteScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShareRouteScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun eachRouteRequiresAnExplicitSelection() {
        val selections = mutableListOf<String>()
        compose.setContent {
            RagentTheme {
                ShareRouteScreen(
                    onSaveToTask = { selections += "task" },
                    onSendToTemporaryComputer = { selections += "temporary" },
                    onClose = {},
                )
            }
        }

        compose.onNodeWithTag("share-route-task").assertIsDisplayed().performClick()
        compose.onNodeWithTag("share-route-temporary").assertIsDisplayed().performClick()
        assertEquals(listOf("task", "temporary"), selections)
    }

    @Test
    fun showsTextAndAttachmentSummaryBeforeTheDestinationChoice() {
        compose.setContent {
            RagentTheme {
                ShareRouteScreen(
                    onSaveToTask = {},
                    onSendToTemporaryComputer = {},
                    onClose = {},
                    preview = ShareRoutePreview(
                        title = "Incident notes",
                        text = "Review the reported crash and propose a fix.",
                        attachmentCount = 2,
                    ),
                )
            }
        }

        compose.onNodeWithTag("share-route-preview").assertIsDisplayed()
        compose.onNodeWithText("Incident notes").assertIsDisplayed()
        compose.onNodeWithText("Review the reported crash and propose a fix.").assertIsDisplayed()
        compose.onNodeWithTag("share-route-preview-attachments").assertIsDisplayed()
            .assertTextEquals("2 files")
        compose.onNodeWithTag("share-route-task").assertIsDisplayed()
        compose.onNodeWithTag("share-route-temporary").assertIsDisplayed()
    }
}
