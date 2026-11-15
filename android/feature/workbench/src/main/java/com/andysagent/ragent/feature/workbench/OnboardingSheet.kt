package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.andysagent.ragent.core.designsystem.*

/** A quiet instruction surface with a fixed header and reachable actions. */
@Composable
internal fun OnboardingSheet(
    title: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    onDismissRequest: () -> Unit = onDismiss,
    confirmEnabled: Boolean = true,
    dismissLabel: String = stringResource(R.string.pairing_cancel),
    confirmModifier: Modifier = Modifier,
    icon: (@Composable () -> Unit)? = null,
    onClose: (() -> Unit)? = null,
    progressLabel: String? = null,
    bodyMinHeight: Dp = 0.dp,
    showConfirm: Boolean = true,
    showDismiss: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colors = LocalRagentColors.current
    val localizedContext = LocalContext.current
    val localizedConfiguration = LocalConfiguration.current
    Dialog(onDismissRequest, properties = DialogProperties(
        usePlatformDefaultWidth = false, decorFitsSystemWindows = false,
    )) {
        // Dialog has a separate Android window; preserve the app language in its body.
        CompositionLocalProvider(LocalContext provides localizedContext,
            LocalConfiguration provides localizedConfiguration) {
        AgentoSystemSafeArea {
            AgentoModalBackgroundDim(amount = 0.24f)
            Box(Modifier.fillMaxSize()) {
            Box(Modifier.matchParentSize().testTag("onboarding-scrim")
                .pointerInput(onDismissRequest) { detectTapGestures { onDismissRequest() } })
            // Some edge-to-edge Dialog windows report no gesture inset on Honor.
            // Keep the whole rounded surface, not just its label, clear of that edge.
            BoxWithConstraints(Modifier.fillMaxSize().systemBarsPadding().imePadding()
                .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 48.dp)) {
                val availableHeight = maxHeight
                Surface(
                    modifier = modifier.align(Alignment.BottomCenter).widthIn(max = 480.dp)
                        .fillMaxWidth().heightIn(max = availableHeight),
                    shape = RoundedCornerShape(28.dp),
                    color = if (colors.canvas.red < 0.5f) androidx.compose.ui.graphics.Color(0xFF1C1C20)
                        else androidx.compose.ui.graphics.Color.White,
                    contentColor = colors.primaryContent,
                ) {
                    Column(Modifier.padding(horizontal = 24.dp, vertical = 20.dp),
                        verticalArrangement = Arrangement.spacedBy(20.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            icon?.invoke()
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                progressLabel?.let { Text(it, color = colors.accentPrimary,
                                    style = MaterialTheme.typography.labelMedium,
                                    modifier = Modifier.testTag("computer-setup-step")) }
                                Text(title, color = colors.primaryContent,
                                    style = MaterialTheme.typography.titleLarge.copy(fontSize = 22.sp,
                                        lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                                    modifier = Modifier.semantics { heading() })
                            }
                            onClose?.let { close ->
                                AgentoIconButton(close, stringResource(R.string.onboarding_close_guide),
                                    modifier = Modifier.testTag("computer-setup-close")) {
                                    AgentoWebIcon(AgentoWebGlyph.Close, null, Modifier.size(20.dp), colors.secondaryContent)
                                }
                            }
                        }
                        Box(Modifier.fillMaxWidth().weight(1f, fill = false)
                            .verticalScroll(rememberScrollState())
                            .heightIn(min = minOf(bodyMinHeight, (availableHeight - 280.dp).coerceAtLeast(0.dp)))) {
                            content()
                        }
                        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (showConfirm) AgentoButton(confirmLabel, onConfirm,
                                Modifier.widthIn(min = 168.dp, max = 224.dp).then(confirmModifier),
                                enabled = confirmEnabled, decision = true, labelMaxLines = 3,
                                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 14.dp),
                                labelStyle = MaterialTheme.typography.labelLarge.copy(fontSize = 16.sp, lineHeight = 22.sp))
                            if (showDismiss) OnboardingTextAction(dismissLabel, onDismiss, quiet = true)
                            else if (onClose != null) Spacer(Modifier.height(48.dp))
                        }
                    }
                }
            }
            }
        }
        }
    }
}
