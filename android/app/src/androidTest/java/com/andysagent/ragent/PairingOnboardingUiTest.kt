package com.andysagent.ragent

import androidx.activity.ComponentActivity
import android.content.res.Configuration
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.PairingOnboardingEvent
import com.andysagent.ragent.feature.workbench.PairingOnboardingStep
import com.andysagent.ragent.feature.workbench.PairingOnboardingMode
import com.andysagent.ragent.feature.workbench.PairingOnboardingUiState
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.util.Locale

class PairingOnboardingUiTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun workbenchText(resId: Int): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resId)

    private fun contextForLanguage(languageTag: String) =
        InstrumentationRegistry.getInstrumentation().targetContext.let { base ->
            base.createConfigurationContext(Configuration(base.resources.configuration).apply {
                setLocale(Locale.forLanguageTag(languageTag))
            })
        }

    @Test
    fun firstRunShowsLoginBeforeComputerConnection() {
        var event: PairingOnboardingEvent? = null
        composeRule.setContent { RagentTheme {
            WorkbenchScreen(state = WorkbenchUiState(),
                pairingOnboardingState = PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Welcome),
                onPairingOnboardingEvent = { event = it })
        } }
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.welcome_connect_title)).assertIsDisplayed()
        composeRule.onNodeWithTag("account-sign-in-page").assertDoesNotExist()
        composeRule.onNodeWithTag("connect-my-computer").assertDoesNotExist()
        composeRule.onNodeWithTag("sign-in-from-computer").assertIsDisplayed()
        composeRule.onNodeWithTag("welcome-sign-in").performScrollTo().performClick()
        composeRule.runOnIdle {
            assertEquals(PairingOnboardingEvent.ContinueFromWelcome, event)
        }
    }

    @Test
    fun unauthenticatedWelcomeUsesTheReturnToSignedInWelcomeFlow() {
        var request: com.andysagent.ragent.feature.workbench.GoogleSignInRequest? = null
        val continueWithGoogle = workbenchText(WorkbenchR.string.sign_in_guide_continue_with_google)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.GoogleRequired,
                        mode = PairingOnboardingMode.ConnectComputerFromWelcome,
                    ),
                    onRequestGoogleSignIn = { request = it },
                )
            }
        }

        composeRule.onNodeWithText(continueWithGoogle).performClick()
        composeRule.runOnIdle {
            assertTrue(
                "The unauthenticated Welcome flow should preserve its return route",
                request == com.andysagent.ragent.feature.workbench.GoogleSignInRequest.PairComputerFromWelcome,
            )
        }
    }

    @Test
    fun loginSuccessAutomaticallyChecksAccountComputers() {
        var action: com.andysagent.ragent.feature.workbench.GoogleSignInSuccessAction? = null
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    googleSignInSuccess = com.andysagent.ragent.feature.workbench.GoogleSignInRequest.PairComputerFromWelcome,
                    onGoogleSignInSuccessAction = { action = it },
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithTag("account-computer-lookup").assertIsDisplayed()
        composeRule.onNodeWithText("Continue to connect a computer").assertDoesNotExist()
        composeRule.runOnIdle {
            assertTrue(
                "Login success should automatically resolve the account destination",
                action == com.andysagent.ragent.feature.workbench.GoogleSignInSuccessAction.EnterApp,
            )
        }
    }

    @Test
    fun signedInWithoutComputerOffersOneGuidedConnectionEntry() {
        var setup = 0
        composeRule.setContent { RagentTheme {
            WorkbenchScreen(state = WorkbenchUiState(), showWelcomeAtLaunch = true, welcomeSignedIn = true,
                welcomeComputerLookup = com.andysagent.ragent.feature.workbench.AccountComputerLookup.Empty,
                onSetUpComputer = { setup++ })
        } }
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.journey_connect_title)).assertIsDisplayed()
        composeRule.onNodeWithTag("account-sign-in-page").assertDoesNotExist()
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.welcome_scan_pairing_code)).assertDoesNotExist()
        composeRule.onNodeWithTag("connect-my-computer").performScrollTo().performClick()
        composeRule.runOnIdle { assertEquals(1, setup) }
    }

    @Test
    fun temporaryAccessHasItsOwnScanEntry() {
        val events = mutableListOf<PairingOnboardingEvent>()
        var scanTemporary = false
        val directConnection = workbenchText(WorkbenchR.string.welcome_try_direct_connection)
        val temporaryScan = workbenchText(WorkbenchR.string.temporary_pairing_scan)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.ConnectionMethods,
                        mode = PairingOnboardingMode.ConnectComputer,
                    ),
                    onPairingOnboardingEvent = events::add,
                    onScanPairingFromWelcome = { scanTemporary = true },
                )
            }
        }

        composeRule.onNodeWithText(directConnection).assertDoesNotExist()
        assertTrue(events.isEmpty())
        composeRule.onNodeWithText(temporaryScan).assertIsDisplayed().performClick()
        assertTrue(scanTemporary)
    }

    @Test
    fun welcomeCopyResolvesForEverySupportedLanguage() {
        val expectedTitles = mapOf(
            "en" to "Connect your work computer",
            "zh-CN" to "连接工作设备",
            "zh-TW" to "連接工作裝置",
            "ja" to "仕事用コンピュータに接続",
            "ko" to "업무용 컴퓨터 연결",
            "fr" to "Connecter votre ordinateur de travail",
            "es" to "Conecta tu equipo de trabajo",
        )
        val requiredResources = listOf(
            WorkbenchR.string.welcome_scan_pairing_code,
            WorkbenchR.string.welcome_try_direct_connection,
            WorkbenchR.string.pairing_account_claim_guidance,
            WorkbenchR.string.settings_sign_in,
            WorkbenchR.string.welcome_other_connection_methods,
            WorkbenchR.string.journey_login_title,
            WorkbenchR.string.journey_connect_title,
            WorkbenchR.string.journey_setup_computer,
            WorkbenchR.string.journey_reverse_sign_in,
            WorkbenchR.string.journey_devices_failed,
            WorkbenchR.string.journey_desktop_trusted,
            WorkbenchR.string.sign_in_guide_continue_with_google,
            WorkbenchR.string.sign_in_guide_google_account,
        )

        expectedTitles.forEach { (languageTag, expectedTitle) ->
            val context = contextForLanguage(languageTag)
            assertEquals(
                "Welcome title should resolve for $languageTag",
                expectedTitle,
                context.getString(WorkbenchR.string.welcome_connect_title),
            )
            assertTrue(
                "Welcome copy should resolve for $languageTag",
                requiredResources.all { context.getString(it).isNotBlank() },
            )
        }
    }

    @Test
    fun googleSignInGuideUsesAFullScreenStepWithBackAndPrimaryAction() {
        var requestedSignIn = false
        var returnedToWelcome = false
        val title = workbenchText(WorkbenchR.string.journey_login_title)
        val continueWithGoogle = workbenchText(WorkbenchR.string.sign_in_guide_continue_with_google)
        val backToWelcome = workbenchText(WorkbenchR.string.welcome_back_to_connection)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.GoogleRequired,
                    ),
                    onPairingOnboardingEvent = {
                        returnedToWelcome = it == PairingOnboardingEvent.BackToWelcome
                    },
                    onRequestGoogleSignIn = { requestedSignIn = true },
                )
            }
        }

        composeRule.onNodeWithText(title).assertIsDisplayed()
        composeRule.onNodeWithText(continueWithGoogle).performClick()
        assertTrue("The primary action should request the sign-in confirmation", requestedSignIn)
        composeRule.onNodeWithContentDescription(backToWelcome).performClick()
        assertTrue("The back action should return to welcome", returnedToWelcome)
    }

    @Test
    fun signInModeUsesAccountGoogleRequest() {
        var request: com.andysagent.ragent.feature.workbench.GoogleSignInRequest? = null
        val continueWithGoogle = workbenchText(WorkbenchR.string.sign_in_guide_continue_with_google)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.GoogleRequired,
                        mode = PairingOnboardingMode.SignIn,
                    ),
                    onRequestGoogleSignIn = { request = it },
                )
            }
        }

        composeRule.onNodeWithText(continueWithGoogle).performClick()
        composeRule.runOnIdle {
            assertTrue(
                "The sign-in entry point should request account authentication",
                request == com.andysagent.ragent.feature.workbench.GoogleSignInRequest.Account,
            )
        }
    }

    @Test
    fun scanStepShowsQrActionAndDoesNotAskForEndpoint() {
        var scanned = false
        val linkComputer = workbenchText(WorkbenchR.string.pairing_link_computer)
        val guidance = workbenchText(WorkbenchR.string.pairing_account_claim_guidance)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.AccountClaimRequired,
                    ),
                    onPairingOnboardingEvent = {},
                    onScanPairing = { scanned = true },
                )
            }
        }

        composeRule.onNodeWithText(guidance).assertIsDisplayed()
        composeRule.onNodeWithText(linkComputer).performClick()
        assertTrue("The scan action should open the device scanner", scanned)
        composeRule.onNodeWithText("Pairing URI").assertDoesNotExist()
    }

    @Test
    fun errorStepShowsRecoveryMessage() {
        val retry = workbenchText(WorkbenchR.string.pairing_try_again)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.Error,
                        errorMessage = "That QR code has expired.",
                    ),
                )
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithText("That QR code has expired.").assertDoesNotExist()
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.onboarding_generic_error_hint)).assertIsDisplayed()
        composeRule.onNodeWithText(workbenchText(WorkbenchR.string.onboarding_details)).performScrollTo().performClick()
        composeRule.onNodeWithText("That QR code has expired.").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText(retry).assertIsDisplayed()
    }

    @Test
    fun scannerFailureFromWelcomeKeepsABackToConnectionAction() {
        var returnedToWelcome = false
        val back = workbenchText(WorkbenchR.string.pairing_back)
        val scannerUnavailable = workbenchText(WorkbenchR.string.pairing_scanner_title)
        val welcomeTitle = workbenchText(WorkbenchR.string.welcome_connect_title)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.Error,
                        scannerFailureReturnsToWelcome = true,
                        scannerUnavailable = true,
                    ),
                    onPairingOnboardingEvent = {
                        returnedToWelcome = it == PairingOnboardingEvent.BackToWelcome
                    },
                    onScanPairingFromWelcome = {},
                )
            }
        }

        composeRule.onNodeWithText(scannerUnavailable).assertIsDisplayed()
        composeRule.onNodeWithText(welcomeTitle).assertExists()
        composeRule.onNodeWithText(back).assertIsDisplayed().performClick()
        assertTrue("Scanner errors from Welcome should return to the connection entry", returnedToWelcome)
    }

    @Test
    fun quotaErrorExplainsLimitAndOpensSubscriptionInfo() {
        var opened = false
        val quotaHint = workbenchText(WorkbenchR.string.pairing_error_quota_hint)
        val viewPlans = workbenchText(WorkbenchR.string.pairing_view_pro_plans)
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    pairingOnboardingState = PairingOnboardingUiState(
                        open = true,
                        step = PairingOnboardingStep.Error,
                        errorMessage = "This Google account has reached the Free plan limit of 1 phone. Upgrade to Pro to link more devices.",
                        subscriptionRequired = true,
                    ),
                    onOpenSubscription = { opened = true },
                )
            }
        }

        composeRule.onNodeWithText("This Google account has reached the Free plan limit of 1 phone. Upgrade to Pro to link more devices.")
            .assertDoesNotExist()
        composeRule.onNodeWithText(quotaHint).assertIsDisplayed()
        composeRule.onNodeWithText(viewPlans).performClick()
        assertTrue("The subscription action should open the introduction page", opened)
    }

    @Test
    fun subscriptionActionRendersTheProIntroductionPage() {
        var back = false
        composeRule.setContent {
            RagentTheme {
                WorkbenchScreen(
                    state = WorkbenchUiState(),
                    subscriptionInfoOpen = true,
                    onCloseSubscriptionInfo = { back = true },
                )
            }
        }

        composeRule.onNodeWithText("Upgrade to Pro").assertIsDisplayed()
        composeRule.onNodeWithText("Connect more phones and computers to the same Ragent account. Pro is coming soon.")
            .assertIsDisplayed()
        composeRule.onNodeWithText("Subscription and payment are not available yet.").assertIsDisplayed()
        composeRule.onNodeWithText("Back to connection").performClick()
        assertTrue("The introduction page should support returning to the connection flow", back)
    }
}
