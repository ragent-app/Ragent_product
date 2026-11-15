package com.andysagent.ragent

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.compose.ui.semantics.SemanticsProperties
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Whole offline chat, including the measured queue/composer dock. */
class QueuedChatViewportUiTest {
    @get:Rule val compose = createEmptyComposeRule()

    private fun revealJump() {
        compose.onNodeWithTag("chat-timeline").performTouchInput {
            swipeDown(startY = height * 0.40f, endY = height * 0.60f, durationMillis = 500)
        }
        compose.waitUntil(3_000) {
            compose.onAllNodesWithContentDescription("Scroll to bottom").fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun verifyCenteredReturn(theme: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        for (queued in listOf(false, true)) {
            val intent = Intent(context, ComposerPickerQaActivity::class.java)
                .putExtra("theme", theme).putExtra("locale", if (queued) "ar" else "en")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (queued) intent.putExtra("panel", "queue")
            ActivityScenario.launch<ComposerPickerQaActivity>(intent).use {
                revealJump()
                val jump = compose.onNodeWithContentDescription("Scroll to bottom").assertIsDisplayed()
                val jumpBounds = jump.fetchSemanticsNode().boundsInRoot
                val timelineBounds = compose.onNodeWithTag("chat-timeline").fetchSemanticsNode().boundsInRoot
                assertTrue("Return arrow is not centered: theme=$theme, queued=$queued",
                    kotlin.math.abs(jumpBounds.center.x - timelineBounds.center.x) <= 1f)
                val dock = compose.onNodeWithTag(if (queued) "composer-queue-rail" else "agent-composer")
                    .fetchSemanticsNode().boundsInRoot
                assertTrue("Centered return arrow overlaps the dock", jumpBounds.bottom <= dock.top)
                jump.performClick()
                compose.onNodeWithText("检查第 36 段的布局和背景采样，继续上下滚动。").assertIsDisplayed()
                compose.onNodeWithContentDescription("Scroll to bottom").assertDoesNotExist()
            }
        }
    }

    @Test fun lightReturnArrowIsCenteredWithAndWithoutQueue() = verifyCenteredReturn("light")
    @Test fun darkReturnArrowIsCenteredWithAndWithoutQueue() = verifyCenteredReturn("dark")

    @Test fun returnAnimationDoesNotFlashEarlierHistory() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "fr").putExtra("panel", "queue").putExtra("font_scale", 2f)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use {
            revealJump()
            val timeline = compose.onNodeWithTag("chat-timeline")
            fun position() = timeline.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
            val startingItem = position().toInt()
            assertTrue("Fixture must start near the final reply", startingItem > 0)
            compose.mainClock.autoAdvance = false
            try {
                compose.onNodeWithContentDescription("Scroll to bottom").performClick()
                repeat(80) {
                    compose.mainClock.advanceTimeByFrame()
                    assertTrue("Return animation jumped into earlier history at frame $it",
                        position() >= startingItem)
                }
            } finally {
                compose.mainClock.autoAdvance = true
            }
            compose.onNodeWithText("检查第 36 段的布局和背景采样，继续上下滚动。").assertIsDisplayed()
        }
    }

    @Test fun jumpIncludesTheQuestionAfterTheLastMessage() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "en").putExtra("panel", "question")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use {
            revealJump()
            compose.onNodeWithContentDescription("Scroll to bottom").assertIsDisplayed().performClick()
            val question = compose.onNodeWithTag("active-decision-card").assertIsDisplayed()
            val composer = compose.onNodeWithTag("agent-composer")
            assertTrue("Question footer is hidden behind composer",
                question.getUnclippedBoundsInRoot().bottom <= composer.getUnclippedBoundsInRoot().top)
            compose.onNodeWithContentDescription("Scroll to bottom").assertDoesNotExist()
        }
    }

    @Test fun returnedTailClearsQueueAfterRealKeyboardSettles() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "en").putExtra("panel", "queue")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use { scenario ->
            revealJump()
            compose.onNodeWithContentDescription("Scroll to bottom").performClick()
            compose.onNodeWithContentDescription("Message composer").performClick()
            compose.waitUntil(10_000) {
                var visible = false
                scenario.onActivity {
                    visible = ViewCompat.getRootWindowInsets(it.window.decorView)
                        ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                }
                visible
            }
            // IME isVisible becomes true at the start of the platform insets
            // animation. Compose idle alone does not wait for those frames.
            // Require the actual terminal geometry, not merely that flag.
            compose.waitUntil(5_000) {
                val tail = compose.onNodeWithText("检查第 36 段的布局和背景采样，继续上下滚动。")
                    .getUnclippedBoundsInRoot()
                val queue = compose.onNodeWithTag("composer-queue-rail").getUnclippedBoundsInRoot()
                tail.bottom <= queue.top
            }
            compose.waitForIdle()
            val tail = compose.onNodeWithText("检查第 36 段的布局和背景采样，继续上下滚动。")
                .assertIsDisplayed().getUnclippedBoundsInRoot()
            val queue = compose.onNodeWithTag("composer-queue-rail").getUnclippedBoundsInRoot()
            assertTrue("Keyboard resize obscures the tail", tail.bottom <= queue.top)
        }
    }

    @Test fun largeFontQueueOffersTransientJumpAboveTheDock() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "en").putExtra("panel", "queue").putExtra("font_scale", 2f)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use {
            // Target the scroll container itself, not a merged reading child.
            val timeline = compose.onNodeWithTag("chat-timeline", useUnmergedTree = true)
            // Scroll to the long penultimate reply: its index alone must not
            // hide the affordance while the final user message remains below it.
            timeline.performScrollToNode(hasText("第 35 段：阅读与配置"))
            revealJump()
            val jump = compose.onNodeWithContentDescription("Scroll to bottom").assertIsDisplayed()
            val queue = compose.onNodeWithTag("composer-queue-rail")
            assertTrue("Jump overlaps the queue",
                jump.getUnclippedBoundsInRoot().bottom <= queue.getUnclippedBoundsInRoot().top)
            jump.performClick()
            val last = compose.onNodeWithText("检查第 36 段的布局和背景采样，继续上下滚动。")
                .assertIsDisplayed()
            assertTrue("Final message is still behind the queue",
                last.getUnclippedBoundsInRoot().bottom <= queue.getUnclippedBoundsInRoot().top)
            compose.onNodeWithContentDescription("Scroll to bottom").assertDoesNotExist()
        }
    }

    @Test fun localizedRtlFixtureActuallyMirrorsQueueActions() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "ar").putExtra("panel", "queue")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use {
            compose.onNodeWithTag("queue-island-pill").performClick()
            val remove = compose.onNodeWithContentDescription("Remove queued message 1")
                .assertIsDisplayed().getUnclippedBoundsInRoot()
            val steer = compose.onAllNodesWithText("Steer")[0]
                .assertIsDisplayed().getUnclippedBoundsInRoot()
            assertTrue("RTL queue actions still use LTR order", remove.right <= steer.left)
        }
    }

    @Test fun returnToBottomIsAvailableWithoutApprovalAndClearsTheQueueDock() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "en").putExtra("panel", "queue")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use {
            val queue = compose.onNodeWithTag("composer-queue-rail").assertIsDisplayed()
            revealJump()
            val jump = compose.onNodeWithContentDescription("Scroll to bottom").assertIsDisplayed()
            assertTrue("Jump overlaps the queue",
                jump.getUnclippedBoundsInRoot().bottom <= queue.getUnclippedBoundsInRoot().top)
            jump.performClick()
            val last = compose.onNodeWithText("检查第 36 段的布局和背景采样，继续上下滚动。")
                .assertIsDisplayed()
            assertTrue("Last message is covered by the queue",
                last.getUnclippedBoundsInRoot().bottom <= queue.getUnclippedBoundsInRoot().top)
            compose.onNodeWithTag("queue-island-pill").performClick()
            compose.onNodeWithContentDescription("Remove queued message 1").performClick()
            compose.onNodeWithText("1 message queued").assertIsDisplayed()
            compose.onNodeWithText("Local preview · Keep the original files unchanged.").assertIsDisplayed()
        }
    }
}
