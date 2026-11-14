package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoIconButton
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.designsystem.AgentocTextStyles
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors

@Composable
fun WelcomeScreen(
    onConnectComputer: () -> Unit,
    onScanPairing: () -> Unit,
    signedIn: Boolean = false,
    onLearnConnectionMethods: () -> Unit = {},
    onSkip: () -> Unit = {},
    onDemoSignIn: (() -> Unit)? = null,
    onSetUpComputer: () -> Unit = onScanPairing,
    onLocalRuntime: () -> Unit = {},
    showLocalRuntime: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas),
        contentAlignment = Alignment.Center,
    ) {
        BoxWithConstraints(
            modifier = Modifier
                .widthIn(max = 480.dp)
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.statusBars.only(WindowInsetsSides.Top))
                .windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
                .windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal)),
        ) {
            WelcomeConnectionContent(
                signedIn = signedIn,
                onConnectComputer = onConnectComputer,
                onScanPairing = onScanPairing,
                onLearnConnectionMethods = onLearnConnectionMethods,
                onSkip = onSkip,
                onDemoSignIn = onDemoSignIn,
                onSetUpComputer = onSetUpComputer,
                onLocalRuntime = onLocalRuntime,
                showLocalRuntime = showLocalRuntime,
            )
        }
    }
}

/** The welcome entry opens account sign-in; signed-in setup remains a separate destination. */
@Composable
private fun WelcomeConnectionContent(
    signedIn: Boolean,
    onConnectComputer: () -> Unit,
    onScanPairing: () -> Unit,
    onLearnConnectionMethods: () -> Unit,
    onSkip: () -> Unit,
    onDemoSignIn: (() -> Unit)?,
    onSetUpComputer: () -> Unit,
    onLocalRuntime: () -> Unit,
    showLocalRuntime: Boolean,
) {
    val colors = LocalAgentocColors.current
    OnboardingPageContent(
        Modifier.testTag(if (signedIn) "connect-computer-page" else "welcome-entry-page"),
        footer = {
            if (showLocalRuntime) OnboardingTextAction(stringResource(R.string.local_runtime_entry), onLocalRuntime, quiet = true)
            if (!signedIn) {
                OnboardingTextAction(stringResource(R.string.journey_temporary_entry), onLearnConnectionMethods,
                    Modifier.testTag("temporary-access-entry"), quiet = true)
            }
        },
    ) { compact ->
        AccountConnectionIllustration(compact = compact || signedIn)
        Spacer(Modifier.height(if (compact) 28.dp else 36.dp))
        Text(stringResource(if (signedIn) R.string.journey_connect_title else R.string.welcome_connect_title),
            style = MaterialTheme.typography.headlineMedium.copy(
                fontSize = 28.sp, lineHeight = 36.sp, fontWeight = FontWeight.SemiBold,
                letterSpacing = (-0.4).sp,
            ), color = colors.primaryContent,
            textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Spacer(Modifier.height(12.dp))
        Text(stringResource(if (signedIn) R.string.onboarding_connect_summary else R.string.welcome_value_summary),
            style = MaterialTheme.typography.bodyMedium.copy(
                fontSize = 15.sp, lineHeight = 24.sp, lineBreak = LineBreak.Heading,
            ), color = colors.secondaryContent,
            textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 304.dp))
        Spacer(Modifier.height(if (compact) 28.dp else 40.dp))
        AgentoButton(stringResource(if (signedIn) R.string.journey_setup_computer else R.string.settings_sign_in),
            onClick = if (signedIn) onSetUpComputer else onConnectComputer,
            modifier = Modifier.widthIn(min = 200.dp, max = 280.dp)
                .testTag(if (signedIn) "connect-my-computer" else "welcome-sign-in"),
            decision = true, labelMaxLines = 2,
            labelStyle = MaterialTheme.typography.labelLarge.copy(fontSize = 16.sp, lineHeight = 22.sp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 24.dp, vertical = 12.dp))
        if (!signedIn) {
            Spacer(Modifier.height(8.dp))
            OnboardingTextAction(stringResource(R.string.journey_reverse_sign_in), onScanPairing,
                Modifier.widthIn(max = 288.dp).testTag("sign-in-from-computer"), quiet = true)
        }
    }
}

enum class AccountComputerLookup { Loading, Empty, Available, Failed }

@Composable
fun AccountComputerLookupScreen(state: AccountComputerLookup, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    Column(modifier.fillMaxSize().background(colors.canvas).systemBarsPadding().padding(24.dp)
        .testTag("account-computer-lookup"), verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally) {
        if (state == AccountComputerLookup.Loading) {
            com.andysagent.agentoc.core.designsystem.AgentoProgress(modifier = Modifier.size(28.dp))
        } else if (state == AccountComputerLookup.Failed) {
            AgentoWebIcon(AgentoWebGlyph.Monitor, null, Modifier.size(32.dp), colors.secondaryContent)
        }
        Spacer(Modifier.height(20.dp))
        Text(stringResource(if (state == AccountComputerLookup.Failed) R.string.journey_devices_failed else R.string.journey_devices_loading),
            style = MaterialTheme.typography.titleMedium, color = colors.primaryContent,
            textAlign = TextAlign.Center)
        if (state == AccountComputerLookup.Failed) {
            Spacer(Modifier.height(10.dp))
            Text(stringResource(R.string.onboarding_lookup_failed_hint), color = colors.secondaryContent,
                style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 280.dp))
            Spacer(Modifier.height(24.dp))
            AgentoButton(stringResource(R.string.journey_devices_retry), onClick = onRetry,
                modifier = Modifier.widthIn(min = 200.dp, max = 280.dp).testTag("retry-account-computers"),
                labelMaxLines = 3, contentPadding = androidx.compose.foundation.layout.PaddingValues(20.dp, 14.dp))
        }
    }
}

/** Keeps launch on the onboarding route while persisted setup state is loading. */
@Composable
fun WelcomeLaunchScreen(modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas)
            .windowInsetsPadding(WindowInsets.statusBars.only(WindowInsetsSides.Top))
            .windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "Ragent",
            style = AgentocTextStyles.brandDisplay,
            color = colors.primaryContent,
        )
    }
}

@Composable
fun ConnectionMethodsScreen(
    onBack: () -> Unit,
    onTryDirectConnection: () -> Unit = {},
    onScanTemporary: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    Box(modifier.fillMaxSize().background(colors.canvas), contentAlignment = Alignment.TopCenter) {
        OnboardingPageContent(
            Modifier.widthIn(max = 440.dp).fillMaxSize().systemBarsPadding()
                .windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal)),
            header = {
                Box(Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                    Box(Modifier.align(Alignment.Center)) { OnboardingWordmark() }
                    AgentoIconButton(onBack, stringResource(R.string.pairing_back), Modifier.align(Alignment.CenterStart)) {
                        AgentoWebIcon(AgentoWebGlyph.Back, null, Modifier.size(22.dp), colors.primaryContent)
                    }
                }
            },
        ) { compact ->
            AgentoWebIcon(AgentoWebGlyph.Clock, null, Modifier.size(48.dp), colors.accentPrimary)
            Spacer(Modifier.height(20.dp))
            Text(stringResource(R.string.journey_temporary), color = colors.primaryContent,
                style = MaterialTheme.typography.headlineMedium.copy(fontSize = 28.sp, lineHeight = 36.sp,
                    fontWeight = FontWeight.SemiBold, letterSpacing = (-0.4).sp),
                modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.journey_temporary_summary), color = colors.accentPrimary,
                style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.height(24.dp))
            Column(Modifier.widthIn(max = 304.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.onboarding_temporary_path), color = colors.primaryContent,
                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 23.sp))
                Text(stringResource(R.string.onboarding_temporary_permissions), color = colors.secondaryContent,
                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 22.sp))
                Text(stringResource(R.string.onboarding_temporary_expiry), color = colors.secondaryContent,
                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 22.sp))
            }
            Spacer(Modifier.height(if (compact) 24.dp else 32.dp))
            AgentoButton(stringResource(R.string.temporary_pairing_scan), onScanTemporary,
                Modifier.widthIn(min = 200.dp, max = 280.dp).testTag("temporary-scan"),
                decision = true, labelMaxLines = 3,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 24.dp, vertical = 14.dp),
                labelStyle = MaterialTheme.typography.labelLarge.copy(fontSize = 16.sp, lineHeight = 22.sp))
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun WelcomePreview() {
    AgentocTheme {
        WelcomeScreen(
            onConnectComputer = {},
            onScanPairing = {},
        )
    }
}

@Preview(showBackground = true, widthDp = 320, heightDp = 640)
@Preview(showBackground = true, widthDp = 840, heightDp = 900, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun SignedInWelcomePreview() {
    AgentocTheme {
        WelcomeScreen(
            onConnectComputer = {},
            onScanPairing = {},
            signedIn = true,
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun ConnectionMethodsPreview() {
    AgentocTheme {
        ConnectionMethodsScreen(onBack = {})
    }
}
