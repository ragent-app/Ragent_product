package com.andysagent.ragent.feature.workbench

import android.content.Intent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.*

private const val COMPUTER_RELEASES_URL = "https://www.agentoncloud.com/download.html"

/** Two preparation pages, then the actual scanner; no extra confirmation page. */
@Composable
fun PairingScanGuideDialog(onScan: () -> Unit, onDismiss: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val colors = LocalRagentColors.current
    var step by rememberSaveable { mutableIntStateOf(0) }
    var feedback by rememberSaveable { mutableStateOf<Int?>(null) }
    val instructions = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 23.sp)
    OnboardingSheet(
        title = stringResource(if (step == 0) R.string.journey_install_step else R.string.journey_code_step),
        modifier = Modifier.testTag("computer-setup-guide"),
        progressLabel = "${step + 1} / 2",
        bodyMinHeight = 332.dp,
        confirmLabel = stringResource(if (step == 0) R.string.onboarding_opened else R.string.pairing_setup_guide_scan),
        confirmModifier = Modifier.testTag("computer-setup-next"),
        dismissLabel = stringResource(R.string.journey_previous),
        showDismiss = step > 0,
        onConfirm = { if (step == 1) onScan() else { step = 1; feedback = null } },
        onDismiss = { step = 0; feedback = null },
        onDismissRequest = onDismiss,
        onClose = onDismiss,
    ) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (step == 0) {
                Text(stringResource(R.string.onboarding_install_hint), style = instructions, color = colors.primaryContent)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    AgentoWebIcon(AgentoWebGlyph.Monitor, null, Modifier.size(22.dp), colors.accentPrimary)
                    Text("agentoncloud.com/download.html", style = MaterialTheme.typography.bodyMedium,
                        color = colors.primaryContent, modifier = Modifier.weight(1f))
                }
                OnboardingTextAction(stringResource(R.string.onboarding_send_link), leadingIcon = AgentoWebGlyph.Share,
                    onClick = {
                        feedback = null
                        runCatching {
                            context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_TEXT, COMPUTER_RELEASES_URL)
                            }, context.getString(R.string.onboarding_send_link)))
                        }.onFailure { feedback = R.string.journey_link_failed }
                    })
                OnboardingTextAction(stringResource(if (feedback == R.string.journey_link_copied)
                    R.string.journey_link_copied else R.string.pairing_setup_guide_copy), quiet = true,
                    leadingIcon = AgentoWebGlyph.Copy, onClick = {
                        clipboard.setText(AnnotatedString(COMPUTER_RELEASES_URL))
                        feedback = R.string.journey_link_copied
                    })
                Text(stringResource(if (feedback == R.string.journey_link_failed) R.string.journey_link_failed
                    else R.string.onboarding_no_desktop_login),
                    style = instructions, color = colors.secondaryContent,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            } else {
                Text(stringResource(R.string.onboarding_menu_path), style = instructions,
                    color = colors.primaryContent, modifier = Modifier.testTag("computer-setup-instructions"))
                PairingDesktopPreview()
                Text(stringResource(R.string.onboarding_scan_handoff), style = instructions, color = colors.secondaryContent)
            }
        }
    }
}

/** Cropped desktop illustration, not interactive controls or a scannable code.
 * Labels mirror static/chat/cross-device-panel.js and i18n.js.
 */
@Composable
private fun PairingDesktopPreview() {
    val colors = LocalRagentColors.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.semantics(mergeDescendants = true) {}) {
        Text(stringResource(R.string.onboarding_desktop_preview), style = MaterialTheme.typography.labelMedium,
            color = colors.secondaryContent)
        Surface(shape = RoundedCornerShape(16.dp), color = colors.canvas,
            border = BorderStroke(1.dp, colors.subtleOutline)) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AgentoWebIcon(AgentoWebGlyph.Monitor, null, Modifier.size(18.dp), colors.secondaryContent)
                    Text(stringResource(R.string.journey_desktop_tab), style = MaterialTheme.typography.labelLarge,
                        color = colors.primaryContent)
                }
                Text(stringResource(R.string.onboarding_desktop_formal), color = colors.accentPrimary,
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium))
                // A static replica of the desktop action, clearly contained in the illustration.
                Text(stringResource(R.string.onboarding_create_code),
                    modifier = Modifier.background(colors.actionPrimary, AgentoShapes.Pill)
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    color = colors.actionPrimaryContent, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}
