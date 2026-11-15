package com.andysagent.ragent

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewConfiguration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.*
import com.andysagent.ragent.core.navigation.*
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.feature.workbench.*
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class NavigationDockDragUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private var selected by mutableStateOf(AgentoDestination.Home)
    private val selections = mutableListOf<AgentoDestination>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val dark get() = InstrumentationRegistry.getArguments().getString("dark") == "true"
    private fun show(direction: LayoutDirection = LayoutDirection.Ltr, policy: MotionPreference = MotionPreference.Full,
        actualPages: Boolean = false) {
        rule.setContent { CompositionLocalProvider(LocalLayoutDirection provides direction) {
            RagentTheme(darkTheme = dark, motionPreference = policy) {
                if (actualPages) WorkbenchScreen(WorkbenchUiState(destination = selected,
                    connection = AgentConnectionStatus.Connected,
                    projects = listOf(Project("p", "产品设计")),
                    sessions = listOf(Session("s", "检查移动端体验", "p"))), onEvent = {
                    if (it is WorkbenchEvent.SelectDestination) { selections += it.destination; selected = it.destination }
                }) else AgentoSurface(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = androidx.compose.ui.Alignment.BottomCenter) {
                        AgentoBottomNavigation(selected, { selections += it; selected = it }, onCreateProject = {})
                    }
                }
            }
        } }
        rule.waitForIdle()
        selections.clear()
    }
    private fun shell() = rule.onNodeWithTag("bottom-navigation-shell")
    private fun capture(name: String) {
        rule.waitForIdle()
        val file = File(instrumentation.targetContext.getExternalFilesDir(null), "navigation-drag/$name-$dark.png")
        file.parentFile?.mkdirs()
        rule.onRoot().captureToImage().asAndroidBitmap().let { bitmap ->
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    private fun assertCentered(destination: AgentoDestination, rtl: Boolean = false) {
        val bounds = shell().fetchSemanticsNode().boundsInRoot
        val lens = rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot
        val slot = if (rtl) 2 - destination.ordinal else destination.ordinal
        assertEquals(bounds.left + bounds.width * (slot + .5f) / 3f, lens.center.x, 2f)
    }

    @Test fun holdingAnotherTabKeepsOneCapsuleUntilRelease() {
        show(policy = MotionPreference.None)
        val tab = rule.onNodeWithTag("bottom-navigation-tab-settings")
        val before = tab.captureToImage().toPixelMap()
        val initialCenter = rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot.center.x
        tab.performTouchInput { down(center); advanceEventTime(500) }
        rule.waitForIdle()
        val held = tab.captureToImage().toPixelMap()
        var difference = 0f
        for (y in 0 until before.height) for (x in 0 until before.width)
            difference += kotlin.math.abs(before[x, y].red - held[x, y].red)
        assertTrue("Holding an unselected tab must not draw a second capsule: $difference", difference < 3f)
        assertEquals(initialCenter, rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot.center.x, 1f)
        rule.runOnIdle { assertEquals(AgentoDestination.Home, selected); assertTrue(selections.isEmpty()) }
        tab.performTouchInput { up() }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(listOf(AgentoDestination.Settings), selections) }
        assertCentered(AgentoDestination.Settings)
    }

    @Test fun draggingFromAnUnselectedTabDoesNotTeleportTheCapsule() {
        show(policy = MotionPreference.None)
        val tab = rule.onNodeWithTag("bottom-navigation-tab-settings")
        val initialCenter = rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot.center.x
        tab.performTouchInput { down(center); moveTo(center + Offset(-30f, 0f), 100) }
        assertEquals(initialCenter, rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot.center.x, 1f)
        tab.performTouchInput { up() }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(AgentoDestination.Home, selected); assertTrue(selections.isEmpty()) }
        assertCentered(AgentoDestination.Home)
    }
    @Test fun draggingOutsideTheSelectedCapsuleDoesNotMoveIt() {
        show(policy = MotionPreference.None)
        val bounds = shell().fetchSemanticsNode().boundsInRoot
        val lens = rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot
        val start = Offset(lens.center.x - bounds.left, 1f)
        shell().performTouchInput { down(start); moveTo(start + Offset(45f, 0f), 120) }
        assertEquals(lens.center.x, rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot.center.x, 1f)
        shell().performTouchInput { up() }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(AgentoDestination.Home, selected); assertTrue(selections.isEmpty()) }
    }
    @Test fun draggingFollowsFingerAndCommitsOnlyOnReleaseInRealPages() {
        show(actualPages = true)
        capture("resting")
        shell().performTouchInput { down(center) }
        capture("pressed")
        shell().performTouchInput { moveTo(Offset(width * .70f, centerY), 160) }
        rule.runOnIdle { assertEquals(AgentoDestination.Home, selected); assertTrue(selections.isEmpty()) }
        val bounds = shell().fetchSemanticsNode().boundsInRoot
        val lens = rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot
        assertEquals(bounds.left + bounds.width * .70f, lens.center.x, 2f)
        capture("dragging")
        shell().performTouchInput { moveTo(Offset(width * 5f / 6f, centerY), 100); up() }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(AgentoDestination.Settings, selected); assertEquals(1, selections.count { it == AgentoDestination.Settings }) }
        assertCentered(AgentoDestination.Settings)
        capture("released")
        rule.onNodeWithTag("bottom-navigation-tab-home").performClick()
        rule.waitForIdle()
        assertCentered(AgentoDestination.Home)
    }

    @Test fun rigidContactTiltsAtTouchLocationWithoutChangingHitArea() {
        show(actualPages = true)
        val lens = rule.onNodeWithTag("bottom-navigation-selection")
        val original = lens.fetchSemanticsNode().boundsInRoot
        val shellBounds = shell().fetchSemanticsNode().boundsInRoot
        fun press(fraction: Float) {
            shell().performTouchInput {
                down(Offset(original.left - shellBounds.left + original.width * fraction,
                    original.top - shellBounds.top + original.height * .18f))
            }
            rule.waitForIdle()
        }
        press(.22f)
        capture("contact-left")
        val left = shell().captureToImage().toPixelMap()
        assertEquals(original, lens.fetchSemanticsNode().boundsInRoot)
        shell().performTouchInput { cancel() }
        rule.waitForIdle()
        press(.78f)
        capture("contact-right")
        val right = shell().captureToImage().toPixelMap()
        assertEquals(original, lens.fetchSemanticsNode().boundsInRoot)
        // Both presses have identical tone and scale; their rigid-plane
        // perspective must differ with the contact position.
        var leftDifference = 0f
        var rightDifference = 0f
        for (y in 0 until left.height) {
            for (x in (left.width * .33f).toInt() until (left.width * .50f).toInt())
                leftDifference += kotlin.math.abs(left[x, y].red - right[x, y].red)
            for (x in (left.width * .50f).toInt() until (left.width * .67f).toInt())
                rightDifference += kotlin.math.abs(left[x, y].red - right[x, y].red)
        }
        assertTrue("Left edge should respond to contact location: $leftDifference", leftDifference > 2f)
        assertTrue("Right edge should respond to contact location: $rightDifference", rightDifference > 2f)
        fun upperEdge(pixels: androidx.compose.ui.graphics.PixelMap, fraction: Float): Int {
            val x = (pixels.width * fraction).toInt()
            val background = pixels[x, 0].red
            return (0 until pixels.height / 3).first { kotlin.math.abs(pixels[x, it].red - background) > .045f }
        }
        for (pixels in listOf(left, right)) {
            val middle = upperEdge(pixels, .50f)
            val line = (upperEdge(pixels, .45f) + upperEdge(pixels, .55f)) / 2f
            assertEquals("The rigid capsule's straight edge must not bend under contact", line, middle.toFloat(), 2f)
        }
        shell().performTouchInput { cancel() }
        rule.waitForIdle()
        rule.runOnIdle { assertTrue(selections.isEmpty()) }
        assertCentered(AgentoDestination.Home)
        capture("contact-restored")
    }

    @Test fun draggingOutOfDockCancelsWithoutNavigation() {
        show()
        shell().performTouchInput {
            down(center); moveTo(Offset(width * .8f, centerY), 120)
            moveTo(Offset(width * .8f, -height * 2f), 120); up()
        }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(AgentoDestination.Home, selected); assertTrue(selections.isEmpty()) }
        assertCentered(AgentoDestination.Home)
    }

    @Test fun offCenterGripStaysUnderTheFingerDuringDrag() {
        show(actualPages = true)
        val bounds = shell().fetchSemanticsNode().boundsInRoot
        val lens = rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot
        val start = Offset(lens.left - bounds.left + lens.width * .22f, bounds.height * .25f)
        shell().performTouchInput { down(start); moveTo(start + Offset(width * .12f, 0f), 160) }
        rule.waitForIdle()
        val moved = rule.onNodeWithTag("bottom-navigation-selection").fetchSemanticsNode().boundsInRoot
        assertEquals("Dragging must retain the original grip, not recenter under the finger",
            lens.center.x + bounds.width * .12f, moved.center.x, 2f)
        capture("rigid-drag-off-center")
        rule.runOnIdle { assertTrue(selections.isEmpty()) }
        shell().performTouchInput { cancel() }
        rule.waitForIdle()
        assertCentered(AgentoDestination.Home)
    }

    @Test fun enteringDragDoesNotJumpAtTheTouchSlopBoundary() {
        show(policy = MotionPreference.None)
        val lens = rule.onNodeWithTag("bottom-navigation-selection")
        val bounds = shell().fetchSemanticsNode().boundsInRoot
        val start = Offset(bounds.width * .5f, bounds.height * .5f)
        val initial = lens.fetchSemanticsNode().boundsInRoot.center.x
        val slop = ViewConfiguration.get(rule.activity).scaledTouchSlop
        shell().performTouchInput { down(start) }
        var previous = initial
        var largestStep = 0f
        for (distance in 1..(slop + 8)) {
            shell().performTouchInput { moveTo(start + Offset(distance.toFloat(), 0f), 16) }
            val current = lens.fetchSemanticsNode().boundsInRoot.center.x
            largestStep = maxOf(largestStep, kotlin.math.abs(current - previous))
            previous = current
        }
        assertTrue("The selection jumped $largestStep px when dragging began (slop $slop px)", largestStep <= 3f)
        for (distance in (slop + 7) downTo -(slop + 8)) {
            shell().performTouchInput { moveTo(start + Offset(distance.toFloat(), 0f), 16) }
            val current = lens.fetchSemanticsNode().boundsInRoot.center.x
            largestStep = maxOf(largestStep, kotlin.math.abs(current - previous))
            previous = current
        }
        assertTrue("Reversing through the original touch point must stay smooth: $largestStep px", largestStep <= 3f)
        shell().performTouchInput { moveTo(start + Offset(bounds.width * .2f, 0f), 100) }
        val dragged = lens.fetchSemanticsNode().boundsInRoot.center.x
        assertEquals("The selection must catch up and track the finger after the transition",
            initial + bounds.width * .2f, dragged, 2f)
        shell().performTouchInput { cancel() }
    }

    @Test fun contactRespondsAcrossNinePositionsAndSmallVerticalMovement() {
        show(actualPages = true)
        val lens = rule.onNodeWithTag("bottom-navigation-selection")
        val original = lens.fetchSemanticsNode().boundsInRoot
        val bounds = shell().fetchSemanticsNode().boundsInRoot
        val images = mutableListOf<androidx.compose.ui.graphics.PixelMap>()
        for (row in 0..2) for (column in 0..2) {
            shell().performTouchInput {
                down(Offset(original.left - bounds.left + original.width * (.22f + .28f * column),
                    original.top - bounds.top + original.height * (.18f + .32f * row)))
            }
            capture("contact-grid-$row-$column")
            images += shell().captureToImage().toPixelMap()
            assertEquals(original, lens.fetchSemanticsNode().boundsInRoot)
            shell().performTouchInput { cancel() }
            rule.waitForIdle()
        }
        fun difference(a: androidx.compose.ui.graphics.PixelMap, b: androidx.compose.ui.graphics.PixelMap): Float {
            var total = 0f
            for (y in 0 until a.height) for (x in 0 until a.width)
                total += kotlin.math.abs(a[x, y].red - b[x, y].red)
            return total
        }
        for (column in 0..2) {
            assertTrue("Upper/central pressure must differ", difference(images[column], images[column + 3]) > 8f)
            assertTrue("Central/lower pressure must differ", difference(images[column + 3], images[column + 6]) > 8f)
        }
        // Stay within one tab and move only a small distance in Y, without
        // entering horizontal drag. Feedback must still follow the new point.
        shell().performTouchInput { down(Offset(centerX, height * .33f)) }
        rule.waitForIdle()
        val before = shell().captureToImage().toPixelMap()
        shell().performTouchInput { moveTo(Offset(centerX, height * .41f), 100) }
        rule.waitForIdle()
        val after = shell().captureToImage().toPixelMap()
        assertTrue("Small vertical movement must update contact", difference(before, after) > 3f)
        shell().performTouchInput { cancel() }
        rule.waitForIdle()
        rule.runOnIdle { assertTrue(selections.isEmpty()) }
        assertEquals(original, lens.fetchSemanticsNode().boundsInRoot)
    }

    @Test fun rigidTiltStaysStableWhileHeldAndReturnsToRest() {
        show(actualPages = true)
        rule.mainClock.autoAdvance = false
        try {
            shell().performTouchInput { down(Offset(centerX, height * .35f)) }
            rule.mainClock.advanceTimeBy(400)
            rule.waitForIdle()
            shell().performTouchInput { moveTo(Offset(centerX, height * .55f), 48) }
            rule.mainClock.advanceTimeBy(400)
            rule.waitForIdle()
            val moving = rule.onNodeWithTag("bottom-navigation-selection").captureToImage().toPixelMap()
            capture("rigid-contact-held")
            rule.mainClock.advanceTimeBy(500)
            rule.waitForIdle()
            val held = rule.onNodeWithTag("bottom-navigation-selection").captureToImage().toPixelMap()
            capture("rigid-contact-held-later")
            var difference = 0f
            for (y in 0 until moving.height) for (x in 0 until moving.width)
                difference += kotlin.math.abs(moving[x, y].red - held[x, y].red)
            assertTrue("A held rigid button must stay stable: $difference", difference < 3f)
            shell().performTouchInput { cancel() }
            rule.mainClock.advanceTimeBy(500)
            rule.waitForIdle()
            rule.runOnIdle { assertTrue(selections.isEmpty()) }
        } finally { rule.mainClock.autoAdvance = true }
    }

    @Test fun pressureChangesContactBothWhileHeldAndDuringDrag() {
        show(actualPages = true)
        val bounds = shell().fetchSemanticsNode().boundsInWindow
        val downTime = SystemClock.uptimeMillis()
        fun touch(action: Int, x: Float, pressure: Float) {
            val properties = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
            val coordinates = MotionEvent.PointerCoords().apply {
                this.x = bounds.left + bounds.width * x
                y = bounds.top + bounds.height * .35f
                this.pressure = pressure
                size = .1f
            }
            val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, 1,
                arrayOf(properties), arrayOf(coordinates), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
            try { rule.runOnUiThread { rule.activity.window.callback.dispatchTouchEvent(event) } } finally { event.recycle() }
            rule.waitForIdle()
        }
        fun pixels() = rule.onNodeWithTag("bottom-navigation-selection").captureToImage().toPixelMap()
        fun visibleWidth(): Int {
            val pixels = shell().captureToImage().toPixelMap()
            val y = pixels.height / 2
            val background = pixels[(pixels.width * .25f).toInt(), y].red
            val occupied = ((pixels.width * .28f).toInt()..(pixels.width * .72f).toInt()).filter {
                kotlin.math.abs(pixels[it, y].red - background) > .065f
            }
            return occupied.last() - occupied.first()
        }
        fun assertDifferent(a: androidx.compose.ui.graphics.PixelMap, b: androidx.compose.ui.graphics.PixelMap) {
            var difference = 0f
            for (y in 0 until a.height) for (x in 0 until a.width)
                difference += kotlin.math.abs(a[x, y].red - b[x, y].red)
            assertTrue("Pressure must visibly change the held surface: $difference", difference > 20f)
        }
        try {
            val restingWidth = visibleWidth()
            touch(MotionEvent.ACTION_DOWN, .5f, .08f)
            val light = pixels()
            val lightWidth = visibleWidth()
            assertTrue("Pressing should enlarge the rigid capsule", lightWidth > restingWidth)
            capture("pressure-held-light")
            touch(MotionEvent.ACTION_MOVE, .5f, 1.4f)
            assertDifferent(light, pixels())
            assertTrue("Firmer pressure should enlarge it further", visibleWidth() > lightWidth + 2)
            capture("pressure-held-firm")
            touch(MotionEvent.ACTION_MOVE, .70f, 1.4f)
            touch(MotionEvent.ACTION_MOVE, .72f, 1.4f)
            val draggingFirm = pixels()
            capture("pressure-drag-firm")
            touch(MotionEvent.ACTION_MOVE, .72f, .08f)
            assertDifferent(draggingFirm, pixels())
            capture("pressure-drag-light")
            rule.runOnIdle { assertTrue(selections.isEmpty()) }
            touch(MotionEvent.ACTION_UP, .72f, 0f)
            rule.runOnIdle { assertEquals(listOf(AgentoDestination.Settings), selections) }
            assertCentered(AgentoDestination.Settings)
        } finally { touch(MotionEvent.ACTION_CANCEL, .72f, 0f) }
    }

    @Test fun cancelledPointerAndReturningToStartDoNotSwitch() {
        show()
        shell().performTouchInput { down(center); moveTo(Offset(width * .8f, centerY), 120); cancel() }
        rule.waitForIdle()
        assertCentered(AgentoDestination.Home)
        shell().performTouchInput {
            down(center); moveTo(Offset(width * .8f, centerY), 100); moveTo(center, 100); up()
        }
        rule.waitForIdle()
        rule.runOnIdle { assertTrue(selections.isEmpty()) }
        assertCentered(AgentoDestination.Home)
    }

    @Test fun rtlDragAndNoAnimationPreserveLogicalTabOrder() {
        selected = AgentoDestination.Sessions
        show(direction = LayoutDirection.Rtl, policy = MotionPreference.None)
        shell().performTouchInput {
            down(Offset(width * 5f / 6f, centerY)); moveTo(Offset(width / 6f, centerY), 250); up()
        }
        rule.waitForIdle()
        rule.runOnIdle { assertEquals(listOf(AgentoDestination.Settings), selections) }
        assertCentered(AgentoDestination.Settings, rtl = true)
    }

    @Test fun reducedMotionStillSupportsDragAndAccessibleClick() {
        show(policy = MotionPreference.Reduced)
        shell().performTouchInput { down(center); moveTo(Offset(width / 6f, centerY), 160); up() }
        rule.waitForIdle()
        assertCentered(AgentoDestination.Sessions)
        rule.onNodeWithTag("bottom-navigation-tab-settings").assertHasClickAction().performClick().assertIsSelected()
    }
}
