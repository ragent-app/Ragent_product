package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.AgentoDialog
import com.andysagent.ragent.core.designsystem.AgentoDialogActionLayout
import com.andysagent.ragent.core.designsystem.AgentoTextField
import com.andysagent.ragent.core.designsystem.RagentSpacing

@Composable
internal fun ProviderOAuthDialog(state: WebParityUiState, onEvent: (WebParityEvent) -> Unit) {
    val job = state.providerOAuthJob ?: return
    val clipboard = LocalClipboardManager.current
    var credential by remember(job.id) { mutableStateOf("") }
    LaunchedEffect(job.requiresInput) { if (!job.requiresInput) credential = "" }
    AgentoDialog(
        opaqueFallback = true, textureAlpha = 0f,
        title = stringResource(R.string.provider_oauth_title),
        confirmLabel = stringResource(if (job.terminal) R.string.provider_oauth_close else R.string.provider_oauth_check),
        onConfirm = { onEvent(if (job.terminal) WebParityEvent.CancelProviderOAuth else WebParityEvent.CheckProviderOAuth) },
        confirmEnabled = job.terminal || !state.providerOAuthPolling,
        dismissLabel = stringResource(R.string.provider_oauth_cancel),
        onDismiss = { onEvent(WebParityEvent.CancelProviderOAuth) },
        onDismissRequest = {},
        dismissEnabled = !job.terminal && !state.actionInProgress,
        actionLayout = if (job.terminal) AgentoDialogActionLayout.PrimaryOnly else AgentoDialogActionLayout.PrimaryWithTextDismiss,
    ) {
        Column(Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(RagentSpacing.Compact)) {
            state.providerOAuthTargetLabel?.let {
                Text(stringResource(R.string.pi_local_change, it), style = MaterialTheme.typography.bodyMedium)
            }
            Text(stringResource(R.string.provider_oauth_remote_vault), style = MaterialTheme.typography.bodySmall)
            Text(stringResource(when (job.state) {
                "completed" -> R.string.provider_oauth_saved
                "failed" -> R.string.provider_oauth_failed
                "cancelled" -> R.string.provider_oauth_cancelled
                "finalizing" -> R.string.provider_oauth_saving
                else -> if (job.agentType == "agy") R.string.provider_oauth_agy_instructions else if (job.code.isBlank()) R.string.provider_oauth_generating else R.string.provider_oauth_waiting
            }))
            if (job.code.isNotBlank()) {
                SelectionContainer { Text(job.code, style = MaterialTheme.typography.headlineSmall) }
                AgentoButton(stringResource(R.string.provider_oauth_copy), { clipboard.setText(AnnotatedString(job.code)) }, secondary = true)
            }
            if (job.canOpenBrowser) AgentoButton(stringResource(R.string.provider_oauth_open), { onEvent(WebParityEvent.OpenProviderOAuth) }, secondary = true)
            if (job.requiresInput && job.state == "awaiting-input") {
                AgentoTextField(credential, { credential = it }, stringResource(R.string.provider_oauth_credential), Modifier.fillMaxWidth(), singleLine = false)
                AgentoButton(stringResource(R.string.provider_oauth_submit), {
                    onEvent(WebParityEvent.SubmitProviderOAuthCredential(credential))
                }, enabled = credential.isNotBlank() && !state.actionInProgress)
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}

@Preview(widthDp = 320, heightDp = 568)
@Composable
private fun ProviderOAuthDialogPreview() {
    MaterialTheme { ProviderOAuthDialog(WebParityUiState(providerOAuthJob = ProviderOAuthJob("preview", "codex", "pending", "https://auth.openai.com/codex/device", "TEST-CODE", false, "", "")), {}) }
}
