package com.andysagent.agentoc

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import com.andysagent.agentoc.feature.workbench.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.feature.workbench.PairingScanGuideDialog
import com.andysagent.agentoc.feature.workbench.WelcomeScreen
import com.andysagent.agentoc.feature.workbench.R as WorkbenchR
import java.io.File
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** User-visible transitions, not a screenshot-only check of isolated components. */
class UserJourneyOnboardingUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun text(id: Int) = context.getString(id)

    @Test fun loginAndConnectionAreSeparatePages() {
        var signedIn by mutableStateOf(false)
        var lookup by mutableStateOf(AccountComputerLookup.Loading)
        var onboarding by mutableStateOf(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Welcome,
            mode = PairingOnboardingMode.ConnectComputerFromWelcome))
        var signIns = 0
        var setups = 0
        var retries = 0
        compose.setContent { AgentocTheme {
            WorkbenchScreen(state = WorkbenchUiState(), showWelcomeAtLaunch = true,
                welcomeSignedIn = signedIn, welcomeComputerLookup = lookup,
                pairingOnboardingState = onboarding,
                onPairingOnboardingEvent = { if (it == PairingOnboardingEvent.ContinueFromWelcome) {
                    onboarding = onboarding.copy(step = PairingOnboardingStep.GoogleRequired)
                } },
                onRequestGoogleSignIn = { signIns++ }, onSetUpComputer = { setups++ },
                onRequestComputerDiscovery = { retries++ })
        } }
        compose.onNodeWithTag("welcome-entry-page").assertExists()
        compose.onNodeWithTag("account-sign-in-page").assertDoesNotExist()
        compose.onNodeWithTag("connect-my-computer").assertDoesNotExist()
        compose.onNodeWithTag("welcome-sign-in").performScrollTo().performClick()
        compose.onNodeWithTag("welcome-entry-page").assertDoesNotExist()
        compose.onNodeWithTag("account-sign-in-page").assertExists()
        compose.onNodeWithTag("account-sign-in-primary").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals(1, signIns); signedIn = true
            onboarding = onboarding.copy(step = PairingOnboardingStep.Welcome)
        }
        compose.onNodeWithTag("account-computer-lookup").assertExists()
        compose.onNodeWithTag("connect-my-computer").assertDoesNotExist()
        compose.runOnIdle { lookup = AccountComputerLookup.Failed }
        compose.onNodeWithTag("retry-account-computers").performClick()
        compose.runOnIdle { assertEquals(1, retries); lookup = AccountComputerLookup.Empty }
        compose.onNodeWithTag("account-sign-in-page").assertDoesNotExist()
        compose.onNodeWithTag("connect-my-computer").performScrollTo().performClick()
        compose.onNodeWithText(text(WorkbenchR.string.welcome_scan_pairing_code)).assertDoesNotExist()
        compose.runOnIdle { assertEquals(1, setups) }
    }

    @Test fun loginKeepsReversePairingAndTemporaryAccessDistinct() {
        var reverse = 0; var temporary = 0; var demo = 0
        var onboarding by mutableStateOf(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Welcome))
        compose.setContent { AgentocTheme {
            WorkbenchScreen(state = WorkbenchUiState(), pairingOnboardingState = onboarding,
                onScanPairingFromWelcome = { reverse++ }, onRequestDemoSignIn = { demo++ },
                onPairingOnboardingEvent = { when (it) {
                    PairingOnboardingEvent.ContinueFromWelcome -> onboarding = onboarding.copy(step = PairingOnboardingStep.GoogleRequired)
                    PairingOnboardingEvent.BackToWelcome -> onboarding = onboarding.copy(step = PairingOnboardingStep.Welcome)
                    PairingOnboardingEvent.LearnConnectionMethods -> temporary++
                    else -> Unit
                } })
        } }
        compose.onNodeWithText(text(WorkbenchR.string.ragent_login_title)).assertDoesNotExist()
        compose.onNodeWithTag("sign-in-from-computer").performScrollTo().performClick()
        compose.onNodeWithTag("temporary-access-entry").performScrollTo().performClick()
        compose.onNodeWithTag("welcome-sign-in").performScrollTo().performClick()
        compose.onNodeWithTag("sign-in-from-computer").assertDoesNotExist()
        compose.onNodeWithTag("temporary-access-entry").assertDoesNotExist()
        compose.onNodeWithText(text(WorkbenchR.string.ragent_login_title)).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(1, reverse); assertEquals(1, temporary); assertEquals(1, demo) }
        compose.onNodeWithContentDescription(text(WorkbenchR.string.welcome_back_to_connection)).performClick()
        compose.onNodeWithTag("welcome-entry-page").assertExists()
        compose.onNodeWithText(text(WorkbenchR.string.ragent_login_title)).assertDoesNotExist()
    }

    @Test fun setupAdvancesAndReturnsWithoutLaunchingTheScannerEarly() {
        var scans = 0
        var dismissed = 0
        compose.setContent { AgentocTheme { PairingScanGuideDialog({ scans++ }, { dismissed++ }) } }
        compose.onNodeWithText(text(WorkbenchR.string.journey_install_step)).assertIsDisplayed()
        compose.onNodeWithTag("computer-setup-next").performClick()
        compose.onNodeWithText(text(WorkbenchR.string.onboarding_menu_path)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(text(WorkbenchR.string.journey_previous)).performClick()
        compose.onNodeWithText(text(WorkbenchR.string.journey_install_step)).assertIsDisplayed()
        compose.runOnIdle { assertEquals(0, scans); assertEquals(0, dismissed) }
        compose.onNodeWithTag("computer-setup-next").performClick()
        compose.onNodeWithTag("computer-setup-next").performClick()
        compose.runOnIdle { assertEquals(1, scans) }
    }

    @Test fun downloadLinkCopyHasFeedbackWithoutLaunchingScanner() {
        var scanned = false
        compose.setContent { AgentocTheme { PairingScanGuideDialog({ scanned = true }, {}) } }
        compose.onNodeWithText(text(WorkbenchR.string.pairing_setup_guide_copy)).performScrollTo().performClick()
        compose.onAllNodesWithText(text(WorkbenchR.string.journey_link_copied))[0].assertIsDisplayed()
        compose.runOnIdle { assertTrue(!scanned) }
    }

    @Test fun normalGuideDoesNotAskForConnectionType() {
        compose.setContent { AgentocTheme { PairingScanGuideDialog({}, {}) } }
        compose.onNodeWithTag("computer-setup-next").performClick()
        compose.onNodeWithTag("setup-long-term").assertDoesNotExist()
        compose.onNodeWithTag("setup-temporary").assertDoesNotExist()
        compose.onNodeWithText(text(WorkbenchR.string.onboarding_menu_path)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(text(WorkbenchR.string.onboarding_create_code)).performScrollTo()
            .performTouchInput { click() }
        compose.onNodeWithTag("computer-setup-guide").assertExists()
    }

    @Test fun setupProgressSurvivesStateRestoration() {
        val restoration = StateRestorationTester(compose)
        restoration.setContent { AgentocTheme { PairingScanGuideDialog({}, {}) } }
        compose.onNodeWithTag("computer-setup-next").performClick()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText(text(WorkbenchR.string.journey_code_step)).assertIsDisplayed()
        compose.onNodeWithText(text(WorkbenchR.string.onboarding_menu_path)).performScrollTo().assertIsDisplayed()
    }

    @Test fun closeOnSecondStepClosesTheGuideInsteadOfGoingBack() {
        var open by mutableStateOf(true)
        compose.setContent { AgentocTheme { if (open) PairingScanGuideDialog({}, { open = false }) } }
        compose.onNodeWithTag("computer-setup-next").performClick()
        compose.onNodeWithTag("computer-setup-close").performClick()
        compose.onNodeWithTag("computer-setup-guide").assertDoesNotExist()
    }

    @Test fun systemBackOnSecondStepClosesTheGuide() {
        var open by mutableStateOf(true)
        compose.setContent { AgentocTheme { if (open) PairingScanGuideDialog({}, { open = false }) } }
        compose.onNodeWithTag("computer-setup-next").performClick()
        androidx.test.espresso.Espresso.pressBack()
        compose.onNodeWithTag("computer-setup-guide").assertDoesNotExist()
    }

    @Test fun tappingOutsideOnSecondStepClosesTheGuide() {
        var open by mutableStateOf(true)
        compose.setContent { AgentocTheme { if (open) PairingScanGuideDialog({}, { open = false }) } }
        compose.onNodeWithTag("computer-setup-next").performClick()
        compose.onNodeWithTag("onboarding-scrim").performTouchInput { click(topLeft + androidx.compose.ui.geometry.Offset(2f, 2f)) }
        compose.onNodeWithTag("computer-setup-guide").assertDoesNotExist()
    }

    @Test fun captureWelcomePage() = captureEntry(false)
    @Test fun captureSeparateLoginPage() = captureEntry(false, accountLogin = true)
    @Test fun captureSeparateConnectionPage() = captureEntry(true)

    private fun captureEntry(signedIn: Boolean, accountLogin: Boolean = false) {
        val localized = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
            setLocale(Locale.forLanguageTag("zh-CN"))
        })
        compose.setContent { CompositionLocalProvider(LocalContext provides localized) { AgentocTheme {
            WorkbenchScreen(state = WorkbenchUiState(), showWelcomeAtLaunch = true,
                pairingOnboardingState = if (accountLogin) PairingOnboardingUiState(open = true,
                    step = PairingOnboardingStep.GoogleRequired) else null,
                welcomeSignedIn = signedIn, welcomeComputerLookup = AccountComputerLookup.Empty)
        } } }
        val tag = if (signedIn) "connect-my-computer" else if (accountLogin) "account-sign-in-primary" else "welcome-sign-in"
        compose.onNodeWithTag(tag).performScrollTo().assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        if (context.resources.configuration.fontScale <= 1f) {
            val bounds = compose.onNodeWithTag(tag).getUnclippedBoundsInRoot()
            assertTrue(bounds.right - bounds.left <= 280.dp)
        }
        capture(if (signedIn) "connection" else if (accountLogin) "login" else "welcome")
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        android.os.SystemClock.sleep(400)
        val bitmap = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
        val directory = File(context.getExternalFilesDir(null), "journey-evidence").apply { mkdirs() }
        val config = context.resources.configuration
        File(directory, "account-first-$name-${config.fontScale}-${config.screenWidthDp}dp.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    // Run this class both at native display settings and with the device set to
    // 320dp / font_scale 1.6. Dialog owns a window, so a LocalDensity override
    // outside it would not exercise real large-font or small-screen behavior.
    @Test fun chineseGuideKeepsEveryStepAndActionReachable() = captureGuide("zh-CN", false)
    @Test fun englishDarkGuideKeepsEveryStepAndActionReachable() = captureGuide("en", true)
    @Test fun frenchGuideKeepsEveryStepAndActionReachable() = captureGuide("fr", false)

    private fun captureGuide(locale: String, dark: Boolean) {
        val localized = context.createConfigurationContext(Configuration(context.resources.configuration).apply {
            setLocale(Locale.forLanguageTag(locale))
        })
        var scans = 0
        compose.setContent {
            CompositionLocalProvider(LocalContext provides localized) {
                AgentocTheme(darkTheme = dark) { PairingScanGuideDialog({ scans++ }, {}) }
            }
        }
        repeat(2) { step ->
            compose.onNodeWithTag("computer-setup-next").assertIsDisplayed().assertHasClickAction()
            val label = localized.getString(when (step) {
                0 -> WorkbenchR.string.onboarding_opened
                else -> WorkbenchR.string.pairing_setup_guide_scan
            })
            val layouts = mutableListOf<TextLayoutResult>()
            compose.onNodeWithText(label).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertTrue("Primary action must have a measured label", layouts.isNotEmpty())
            // Paragraph measurements use fractional pixels; Text's integer
            // size can round down by less than a pixel. Check the visible end
            // and actual line width instead of that rounding-only overflow.
            assertTrue("Primary action label must not be clipped: $label / ${layouts.map { it.size }}",
                layouts.all { it.getLineEnd(it.lineCount - 1, visibleEnd = true) == label.length &&
                    (0 until it.lineCount).all { line ->
                        it.getLineRight(line) - it.getLineLeft(line) <= it.size.width + 1f } })
            compose.waitForIdle()
            // Semantics can be ready before the separate Dialog window is
            // presented by SurfaceFlinger on Honor. Capture its settled frame.
            android.os.SystemClock.sleep(400)
            val bitmap = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
            val directory = File(context.getExternalFilesDir(null), "journey-evidence").apply { mkdirs() }
            val config = context.resources.configuration
            File(directory, "choice-$locale-$dark-${config.fontScale}-${config.screenWidthDp}dp-$step.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            bitmap.recycle()
            if (step == 1) {
                compose.onNodeWithTag("computer-setup-instructions").performScrollTo().assertIsDisplayed()
                compose.onNodeWithText(localized.getString(WorkbenchR.string.onboarding_scan_handoff))
                    .performScrollTo().assertIsDisplayed()
                compose.onNodeWithTag("computer-setup-next").assertIsDisplayed()
            }
            compose.onNodeWithTag("computer-setup-next").performClick()
        }
        compose.runOnIdle { assertEquals(1, scans) }
    }
}
