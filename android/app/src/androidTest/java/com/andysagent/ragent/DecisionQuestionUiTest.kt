package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.feature.workbench.DecisionQuestionCard
import com.andysagent.ragent.feature.workbench.DecisionQuestionUiState
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class DecisionQuestionUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val initial = DecisionQuestionUiState("server-question", "Which report do you need?", listOf("Summary", "Complete details"))

    @Test fun singleChoiceUsesOneEventAndDoesNotPreselectOrInventRecommendation() {
        val state = mutableStateOf(initial)
        var selections = 0
        var submissions = 0
        compose.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                DecisionQuestionCard(state.value, { selections++; state.value = state.value.copy(selectedIndices = setOf(it)) }, {}, { submissions++ })
            }
        }
        compose.onNodeWithTag("decision-option-0").assertIsNotSelected()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)).assertHeightIsAtLeast(56.dp)
        compose.onNodeWithText("Recommended").assertDoesNotExist()
        compose.onNodeWithTag("decision-submit").assertIsNotEnabled()
        compose.onNodeWithTag("decision-option-0").performTouchInput { click() }
        compose.onNodeWithTag("decision-option-0").assertIsSelected()
        compose.onNodeWithTag("decision-submit").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(1, selections); assertEquals(1, submissions) }
        compose.runOnIdle { state.value = state.value.copy(isSubmitting = true) }
        compose.onNodeWithTag("decision-option-1").assertIsNotEnabled().performTouchInput { click() }
        compose.runOnIdle { assertEquals(1, selections) }
    }

    @Test fun multiChoiceExposesCheckedStateAndTogglesOnce() {
        val state = mutableStateOf(initial.copy(isMultiSelect = true, recommendedIndex = 0))
        var selections = 0
        compose.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                DecisionQuestionCard(state.value, { index ->
                    selections++
                    state.value = state.value.copy(selectedIndices = if (index in state.value.selectedIndices) state.value.selectedIndices - index else state.value.selectedIndices + index)
                }, {}, {})
            }
        }
        compose.onNodeWithTag("decision-option-0").assertIsOff()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Checkbox)).performTouchInput { click() }
        compose.onNodeWithTag("decision-option-0").assertIsOn()
        compose.onNodeWithTag("decision-option-1").performTouchInput { click() }
        compose.onNodeWithTag("decision-option-1").assertIsOn()
        compose.onNodeWithTag("decision-option-0").performTouchInput { click() }
        compose.onNodeWithTag("decision-option-0").assertIsOff()
        compose.runOnIdle { assertEquals(3, selections); assertEquals(setOf(1), state.value.selectedIndices) }
    }

    @Test fun freeTextCanSubmitButWhitespaceCannotAndSendingLocksInputs() {
        val state = mutableStateOf(initial)
        compose.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                DecisionQuestionCard(state.value, {}, { state.value = state.value.copy(writeInText = it) }, {})
            }
        }
        compose.onNodeWithTag("decision-write-in").assertHeightIsAtLeast(48.dp).performTextInput("  ")
        compose.onNodeWithTag("decision-submit").assertIsNotEnabled()
        compose.onNodeWithTag("decision-write-in").performTextReplacement("A custom answer\nwith details")
        compose.onNodeWithTag("decision-submit").assertIsEnabled()
        compose.runOnIdle { state.value = state.value.copy(isSubmitting = true) }
        compose.onNodeWithTag("decision-option-0").assertIsNotEnabled()
        compose.onNodeWithTag("decision-write-in").assertIsNotEnabled()
        compose.onNodeWithTag("decision-submit").assertIsNotEnabled()
        compose.runOnIdle { state.value = state.value.copy(isSubmitting = false, isSubmitted = true) }
        compose.onNodeWithTag("decision-submit").assertDoesNotExist()
        compose.onNodeWithTag("decision-write-in").assertDoesNotExist()
    }

    @Test fun frenchNarrowLargeTextRemainsScrollableAndReadable() = verifyLargeText("fr", false, LayoutDirection.Ltr)
    @Test fun chineseDarkLargeTextRemainsScrollableAndReadable() = verifyLargeText("zh-CN", true, LayoutDirection.Ltr)
    @Test fun rtlLayoutKeepsChoiceAndActionReachable() = verifyLargeText("en", false, LayoutDirection.Rtl)

    private fun verifyLargeText(locale: String, dark: Boolean, direction: LayoutDirection) {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val config = android.content.res.Configuration(base.resources.configuration).apply { setLocale(java.util.Locale.forLanguageTag(locale)) }
        val context = base.createConfigurationContext(config)
        val state = initial.copy(question = "Long question · 请核对每周报告的内容与输出范围", options = listOf(
            "A complete report with a summary, detailed records and follow-up actions", "Summary only"), recommendedIndex = 0)
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalContext provides context, LocalConfiguration provides config, LocalDensity provides Density(density.density, 2f), LocalLayoutDirection provides direction) {
                RagentTheme(darkTheme = dark, motionPreference = MotionPreference.None) {
                    Surface(Modifier.fillMaxSize(), color = LocalRagentColors.current.canvas) {
                        Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                            Column(Modifier.width(320.dp).height(500.dp).testTag("decision-test-viewport").verticalScroll(rememberScrollState())) {
                                DecisionQuestionCard(state, {}, {}, {})
                            }
                        }
                    }
                }
            }
        }
        compose.onNodeWithTag("decision-test-viewport").assertWidthIsEqualTo(320.dp)
        val initialOffset = compose.onNodeWithTag("decision-test-viewport").fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
        compose.onNodeWithTag("decision-option-0").performScrollTo().assertIsDisplayed().assertHeightIsAtLeast(56.dp)
        capture("decision-$locale-$dark-$direction-options")
        compose.onNodeWithTag("decision-submit").performScrollTo().assertIsDisplayed().assertHeightIsAtLeast(52.dp)
        val finalOffset = compose.onNodeWithTag("decision-test-viewport").fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
        org.junit.Assert.assertTrue("The constrained viewport must actually scroll", finalOffset > initialOffset)
        capture("decision-$locale-$dark-$direction-submit")
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            val committed = java.util.concurrent.CountDownLatch(1)
            compose.activityRule.scenario.onActivity { activity ->
                val view = activity.window.decorView
                view.viewTreeObserver.registerFrameCommitCallback { committed.countDown() }
                view.invalidate()
            }
            check(committed.await(5, java.util.concurrent.TimeUnit.SECONDS)) { "No committed frame for $name" }
        }
        android.os.SystemClock.sleep(350)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        // Compose semantics can be ready before SurfaceFlinger presents the
        // first frame. Never accept an empty window as visual QA evidence.
        repeat(15) { attempt ->
            val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            var darkest = 255
            var lightest = 0
            for (y in bitmap.height / 8 until bitmap.height * 2 / 3 step 16) {
                for (x in bitmap.width / 4 until bitmap.width * 3 / 4 step 16) {
                    val pixel = bitmap.getPixel(x, y)
                    val value = (android.graphics.Color.red(pixel) + android.graphics.Color.green(pixel) + android.graphics.Color.blue(pixel)) / 3
                    darkest = minOf(darkest, value)
                    lightest = maxOf(lightest, value)
                }
            }
            val presented = lightest - darkest > 80
            if (presented || attempt == 0) {
                val suffix = if (presented) "" else "-unpresented"
                File(instrumentation.targetContext.getExternalFilesDir(null), "$name$suffix.png").outputStream().use {
                    check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it))
                }
            }
            bitmap.recycle()
            if (presented) return
            android.os.SystemClock.sleep(200)
        }
        error("No rendered question content in screenshot: $name")
    }
}
