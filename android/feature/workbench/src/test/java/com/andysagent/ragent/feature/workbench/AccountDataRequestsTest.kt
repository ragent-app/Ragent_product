package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.navigation.AgentoDestination
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w320dp-h568dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AccountDataRequestsTest {
    @get:Rule val rule = createComposeRule()

    @Test fun signedOutSettingsOffersTheActualAccountPrivacyRouteWithoutGoogleOrWorkbenchAccess() {
        val opened = mutableListOf<String>()
        val state = mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings))
        rule.setContent {
            CompositionLocalProvider(LocalUriHandler provides object : UriHandler {
                override fun openUri(uri: String) { opened += uri }
            }) {
                RagentTheme {
                    WorkbenchScreen(state = state.value, accountsViewModel = null,
                        onRequestGoogleSignIn = { error("Public instructions must not require sign-in") },
                        onEvent = { event ->
                            println("ACCOUNT_REQUEST_NAV_EVENT=$event")
                            when (event) {
                                is WorkbenchEvent.OpenSettingsPage -> state.value = state.value.copy(settingsPage = event.page)
                                is WorkbenchEvent.SelectDestination -> state.value = state.value.copy(destination = event.destination)
                                else -> Unit
                            }
                        })
                }
            }
        }
        rule.onNodeWithTag("settings-account-data").performScrollTo()
        println(rule.onRoot().printToString())
        // performScrollTo makes the row visible but does not account for the
        // product's overlay dock. Scroll the real list further before touching.
        rule.onNode(hasScrollAction()).performTouchInput { swipeUp(startY = centerY + 50f, endY = centerY - 50f) }
        val row = rule.onNodeWithTag("settings-account-data").fetchSemanticsNode().boundsInRoot
        val dock = rule.onNodeWithTag("bottom-navigation-shell").fetchSemanticsNode().boundsInRoot
        assertTrue(row.center.y < dock.top, "The tap must be above the overlay dock")
        rule.onNodeWithTag("settings-account-data").performClick()
        println(rule.onRoot().printToString())
        rule.runOnIdle { assertEquals(SettingsPage.Account, state.value.settingsPage) }
        rule.waitUntil(5_000) {
            rule.onAllNodesWithTag("account-deletion-request").fetchSemanticsNodes().size == 1
        }
        rule.onNodeWithTag("account-deletion-request").performScrollTo().assertIsDisplayed().performClick()
        rule.onNodeWithTag("account-deletion-open-web").performClick()
        assertEquals(listOf("https://support.agentoncloud.com/account-deletion/"), opened)
    }

    @Test fun deletionEntryExplainsManualRequestAndOnlyOpensPublicInstructionsAfterConfirmation() {
        val opened = mutableListOf<String>()
        rule.setContent {
            CompositionLocalProvider(LocalUriHandler provides object : UriHandler {
                override fun openUri(uri: String) { opened += uri }
            }) { RagentTheme { AccountDataRequests() } }
        }
        assertEquals(emptyList(), opened)
        rule.onNodeWithTag("account-deletion-request").performClick()
        rule.onNodeWithTag("account-deletion-instructions").assertIsDisplayed()
        rule.onNodeWithText("This opens the Ragent support website.", substring = true).assertExists()
        rule.onNodeWithText("Opening the page does not submit a request or delete anything.", substring = true).assertExists()
        assertEquals(emptyList(), opened)
        rule.onNodeWithTag("account-deletion-open-web").performClick()
        assertEquals(listOf("https://support.agentoncloud.com/account-deletion/"), opened)
        rule.onNodeWithTag("account-deletion-instructions").assertDoesNotExist()
    }

    @Test fun cancelDoesNotOpenAnythingAndPrivacyHasItsSeparateFixedDestination() {
        val opened = mutableListOf<String>()
        rule.setContent {
            CompositionLocalProvider(LocalUriHandler provides object : UriHandler {
                override fun openUri(uri: String) { opened += uri }
            }) { RagentTheme { AccountDataRequests() } }
        }
        rule.onNodeWithTag("account-deletion-request").performClick()
        rule.onNodeWithText("Cancel").performClick()
        assertEquals(emptyList(), opened)
        rule.onNodeWithTag("account-privacy-open").performClick()
        assertEquals(listOf("https://support.agentoncloud.com/privacy/"), opened)
    }

    @Test fun unavailableBrowserKeepsVisiblePublicLinkAndDoesNotClaimSubmissionOrDeletion() {
        val attempted = mutableListOf<String>()
        rule.setContent {
            CompositionLocalProvider(LocalUriHandler provides object : UriHandler {
                override fun openUri(uri: String) {
                    attempted += uri
                    throw IllegalArgumentException("No activity handles the link")
                }
            }) { RagentTheme { AccountDataRequests() } }
        }
        rule.onNodeWithTag("account-deletion-request").performClick()
        rule.onNodeWithTag("account-deletion-open-web").performClick()
        rule.onNodeWithTag("account-data-failed-url").assertTextEquals("https://support.agentoncloud.com/account-deletion/")
        rule.onNodeWithTag("account-data-browser-error").assertTextEquals(
            "Could not open a browser. Copy the link below and open it in a browser. No deletion request was submitted.")
        rule.onNodeWithTag("account-deletion-instructions").assertDoesNotExist()
        assertEquals(1, attempted.size)
    }

    @Test fun restoredDialogAndRestoredReturnFromBrowserNeverOpenTheLinkAutomatically() {
        val opened = mutableListOf<String>()
        val restoration = StateRestorationTester(rule)
        restoration.setContent {
            CompositionLocalProvider(LocalUriHandler provides object : UriHandler {
                override fun openUri(uri: String) { opened += uri }
            }) { RagentTheme { AccountDataRequests() } }
        }
        rule.onNodeWithTag("account-deletion-request").performClick()
        restoration.emulateSavedInstanceStateRestore()
        rule.onNodeWithTag("account-deletion-instructions").assertIsDisplayed()
        assertEquals(emptyList(), opened)
        rule.onNodeWithTag("account-deletion-open-web").performClick()
        restoration.emulateSavedInstanceStateRestore()
        rule.onNodeWithTag("account-deletion-instructions").assertDoesNotExist()
        assertEquals(listOf("https://support.agentoncloud.com/account-deletion/"), opened)
    }
}
