package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.ComposerAttachment
import com.andysagent.ragent.feature.workbench.EditTurnBanner
import com.andysagent.ragent.feature.workbench.QueuedMessageRail
import com.andysagent.ragent.feature.workbench.QueuedMessageUiState
import java.util.Locale
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ComposerSupportRailUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val events = mutableListOf<String>()
    private val queue = mutableStateOf(listOf(
        QueuedMessageUiState(id = "first", text = "First pending message"),
        QueuedMessageUiState(id = "second", text = "Second pending message"),
    ))

    private fun show(locale: String = "en", fontScale: Float = 1f, editing: Boolean = false) {
        val base = compose.activity
        val context = base.createConfigurationContext(Configuration(base.resources.configuration).apply {
            setLocale(Locale.forLanguageTag(locale))
        })
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalContext provides context,
                LocalDensity provides Density(density.density, fontScale)) {
                RagentTheme(darkTheme = false) {
                    Column(Modifier.width(320.dp).padding(16.dp).testTag("rail-container")) {
                        if (editing) EditTurnBanner("Original message", onCancel = { events += "cancel" })
                        else QueuedMessageRail(queue.value,
                            onSteer = { events += "steer:${it.id}" },
                            onRemove = { message ->
                                events += "remove:${message.id}"
                                queue.value = queue.value.filterNot { it.id == message.id }
                            })
                    }
                }
            }
        }
    }

    @Test fun steerTargetsTheVisibleHeadNotAnotherQueuedMessage() {
        show()
        compose.onNodeWithText("2 messages queued").assertIsDisplayed()
        compose.onNodeWithText("First pending message").assertIsDisplayed()
        compose.onNodeWithText("Steer").assertHeightIsAtLeast(48.dp).performClick()
        compose.runOnIdle { assertEquals(listOf("steer:first"), events) }
    }

    @Test fun removingTheHeadRevealsTheNextMessageAndUpdatesTheCount() {
        show()
        compose.onNodeWithContentDescription("Remove queued message").assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithText("1 message queued").assertIsDisplayed()
        compose.onNodeWithText("Second pending message").assertIsDisplayed()
        compose.onNodeWithText("First pending message").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("remove:first"), events) }
    }

    @Test fun emptyQueueHasNoActions() {
        queue.value = emptyList()
        show()
        compose.onNodeWithText("Steer").assertDoesNotExist()
        compose.onNodeWithContentDescription("Remove queued message").assertDoesNotExist()
    }

    @Test fun attachmentOnlyMessageHasAnHonestPreview() {
        queue.value = listOf(QueuedMessageUiState(id = "attachments", text = "",
            attachments = listOf(ComposerAttachment(name = "a.png"), ComposerAttachment(name = "b.png"))))
        show()
        compose.onNodeWithText("2 attachments").assertIsDisplayed()
    }

    @Test fun cancelEditingIsNamedAndDoesNotSubmitAnything() {
        show(editing = true)
        compose.onNodeWithText("Cancel edit").assertIsDisplayed().assertHeightIsAtLeast(32.dp).performClick()
        compose.runOnIdle { assertEquals(listOf("cancel"), events) }
    }

    @Test fun frenchLargeTextActionsStayInsideTheNarrowRailWithoutOverlap() {
        show(locale = "fr", fontScale = 2f)
        compose.onNodeWithText("2 messages en attente").assertIsDisplayed()
        val steer = compose.onNodeWithText("Réorienter").assertIsDisplayed().getUnclippedBoundsInRoot()
        val remove = compose.onNodeWithContentDescription("Retirer le message en attente")
            .assertIsDisplayed().getUnclippedBoundsInRoot()
        val rail = compose.onNodeWithTag("rail-container").getUnclippedBoundsInRoot()
        assertTrue("Actions overlap", steer.right <= remove.left)
        assertTrue("Action overflows rail", remove.right <= rail.right && steer.left >= rail.left)
    }
}
