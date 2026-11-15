package com.andysagent.ragent.feature.workbench

import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.andysagent.ragent.core.designsystem.RagentTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "zh-rCN-w320dp-h568dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PairingOnboardingDialogTest {
    @get:Rule val rule = createComposeRule()

    private fun show(state: PairingOnboardingUiState, onEvent: (PairingOnboardingEvent) -> Unit = {}) {
        rule.setContent {
            RagentTheme(darkTheme = false) {
                PairingOnboardingDialog(state, onEvent, {}, {}, {})
            }
        }
    }

    @Test fun waitingActionIsAvailableAndExplainsRemoteCompletionOnSmallChineseScreen() {
        var received: PairingOnboardingEvent? = null
        show(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Verifying)) {
            received = it
        }

        rule.onNodeWithText("停止等待").assertIsDisplayed().assertHasClickAction().performClick()
        assertEquals(PairingOnboardingEvent.StopWaiting, received)
        rule.onNodeWithText("可以关闭此窗口，连接请求仍会继续。此操作不会撤销电脑已接受的关联。重新打开“连接电脑”可查看结果。")
            .assertExists()
    }

    @Test fun linkedResultIsChineseOnSmallScreen() {
        var received: PairingOnboardingEvent? = null
        show(PairingOnboardingUiState(open = true, step = PairingOnboardingStep.Bound)) {
            received = it
        }

        rule.onNodeWithText("已连接").assertIsDisplayed()
        rule.onNodeWithText("这台电脑已关联到 Google 帐号。以后连接时无需再扫码。")
            .assertExists()
        rule.onNodeWithText("开始使用").assertIsDisplayed().assertHasClickAction().performClick()
        rule.onNodeWithText("关闭").assertDoesNotExist()
        rule.onNodeWithText("取消").assertDoesNotExist()
        assertEquals(PairingOnboardingEvent.Dismiss, received)
    }

    @Test fun accountFailureUsesLocalizedRecoveryCopyInsteadOfEnglishDiagnostic() {
        show(PairingOnboardingUiState(
            open = true,
            step = PairingOnboardingStep.Error,
            errorMessage = "This computer's Google account service is not configured.",
            errorMessageRes = R.string.pairing_error_accounts_not_configured,
        ))

        rule.onNodeWithText("这台电脑尚未配置 Google 帐号服务。请在电脑上配置 Accounts 后重试。")
            .assertIsDisplayed()
        rule.onNodeWithText("This computer's Google account service is not configured.")
            .assertDoesNotExist()
    }

    @Test fun rejectedCodeShowsLocalizedRestartAction() {
        show(PairingOnboardingUiState(
            open = true,
            step = PairingOnboardingStep.Error,
            errorMessageRes = R.string.pairing_error_request_conflict,
            requiresNewCode = true,
        ))

        rule.onNodeWithText("扫描二维码").assertIsDisplayed().assertHasClickAction()
        rule.onNodeWithText("电脑无法接受此帐号关联请求。请重新开始关联流程。")
            .assertExists()
    }

    @Test
    @Config(qualifiers = "zh-rTW-w320dp-h568dp")
    fun traditionalChineseTemporaryWaitDoesNotFallBackToEnglish() {
        show(PairingOnboardingUiState(
            open = true,
            step = PairingOnboardingStep.Verifying,
            temporaryPairing = true,
        ))

        rule.onNodeWithText("正在完成暫時連線，請保持兩台裝置連線。無需登入 Google。")
            .assertExists()
        rule.onNodeWithText("停止等待").assertIsDisplayed()
    }
}
