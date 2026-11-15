package com.andysagent.ragent.feature.appapi

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.designsystem.*
import java.text.DateFormat
import java.util.Date

@Composable
fun AssistantDelegationScreen(state: AssistantDelegationUiState, onEvent: (AssistantDelegationEvent) -> Unit, onClose: () -> Unit) {
    var pending by remember { mutableStateOf<ApiPendingRecord?>(null) }
    val locale = LocalContext.current.resources.configuration.locales[0]
    AuthorizationPage(stringResource(R.string.api_assistant_title), onClose, !state.busy) {
        ApiSettingsCard {
            Text(stringResource(R.string.api_assistant_description))
            Text(stringResource(R.string.api_assistant_availability), color = LocalRagentColors.current.secondaryContent)
        }
        if (state.loading) Text(stringResource(R.string.api_loading))
        AccessError(state.error)
        if (state.error != null) {
            AgentoButton(stringResource(R.string.api_retry), { onEvent(AssistantDelegationEvent.Refresh) }, secondary = true,
                enabled = !state.loading && !state.busy)
        }
        state.review?.let { review ->
            val enabled = !state.busy && state.error == null
            ApiSettingsCard {
            Text(stringResource(R.string.api_access_capabilities), style = MaterialTheme.typography.titleMedium)
            AssistantTaskCapabilities.ids.forEach { id ->
                ScopeChoice(CapabilityName(id), id in state.capabilities, enabled) { onEvent(AssistantDelegationEvent.Capability(id, it)) }
            }
            }
            ApiSettingsCard {
            Text(stringResource(R.string.api_access_computers), style = MaterialTheme.typography.titleMedium)
            if (review.targetLabels.isEmpty()) Text(stringResource(R.string.api_no_computers))
            review.targetLabels.forEach { (id, label) ->
                ScopeChoice(label, id in state.targets, enabled) { onEvent(AssistantDelegationEvent.Target(id, it)) }
            }
            ScopeChoice(stringResource(R.string.api_assistant_create), state.mayCreateSessions, enabled) { onEvent(AssistantDelegationEvent.Creation(it)) }
            }
            ApiSettingsCard {
            Text(stringResource(R.string.api_assistant_scope_help), color = LocalRagentColors.current.secondaryContent)
            AgentoTextField(state.sessionsText, { onEvent(AssistantDelegationEvent.Sessions(it)) }, stringResource(R.string.api_assistant_sessions),
                enabled = enabled, singleLine = false)
            AgentoTextField(state.projectsText, { onEvent(AssistantDelegationEvent.Projects(it)) }, stringResource(R.string.api_assistant_projects),
                enabled = enabled, singleLine = false)
            ScopeChoice(stringResource(R.string.api_assistant_hour), state.lifetimeMs == 60 * 60 * 1000L, enabled) {
                if (it) onEvent(AssistantDelegationEvent.Lifetime(60 * 60 * 1000L))
            }
            ScopeChoice(stringResource(R.string.api_assistant_day), state.lifetimeMs == 24 * 60 * 60 * 1000L, enabled) {
                if (it) onEvent(AssistantDelegationEvent.Lifetime(24 * 60 * 60 * 1000L))
            }
            ScopeChoice(stringResource(R.string.api_assistant_acknowledge), state.acknowledgedGroup, enabled) { onEvent(AssistantDelegationEvent.Acknowledge(it)) }
            AgentoButton(stringResource(R.string.api_assistant_approve), { onEvent(AssistantDelegationEvent.Approve) }, enabled = state.canApprove)
            }
            Text(stringResource(R.string.api_assistant_history), style = MaterialTheme.typography.titleMedium)
            if (review.delegations.isEmpty()) Text(stringResource(R.string.api_assistant_empty))
            review.delegations.forEach { row ->
              ApiSettingsCard {
                Text(stringResource(if (row.revokedAt == null) R.string.api_assistant_active else R.string.api_assistant_revoked))
                Text(row.id, color = LocalRagentColors.current.secondaryContent)
                Text(row.scope.targetIds.sorted().joinToString { review.targetLabels[it] ?: it })
                row.scope.capabilityIds.sorted().forEach { Text(CapabilityName(it)) }
                ResourceScope(row.scope.sessionIds, row.scope.projectIds)
                Text(stringResource(R.string.api_assistant_until, DateFormat.getDateTimeInstance(DateFormat.DEFAULT, DateFormat.DEFAULT, locale).format(Date(row.scope.expiresAt))))
                AgentoButton(stringResource(if (row.revokedAt == null) R.string.api_assistant_revoke else R.string.api_assistant_delete), {
                    pending = ApiPendingRecord(row.id, row.id, row.revokedAt == null, row.revision)
                }, secondary = true, enabled = !state.busy, labelMaxLines = Int.MAX_VALUE)
              }
            }
        }
    }
    pending?.let { record ->
        ApiRecordConfirmation(record, assistant = true, onDismiss = { pending = null }, onConfirm = {
            pending = null
            val row = state.review?.delegations?.firstOrNull { it.id == record.id }
            if (!state.busy && !state.loading && row != null && row.revision == record.revision && (row.revokedAt == null) == record.revoking) {
                onEvent(if (record.revoking) AssistantDelegationEvent.Revoke(record.id) else AssistantDelegationEvent.DeleteRevoked(record.id))
            }
        })
    }
}
@Preview(showBackground = true, widthDp = 420, heightDp = 900)
@Composable
private fun AssistantDelegationPreview() {
    RagentTheme { AssistantDelegationScreen(AssistantDelegationUiState(loading = false,
        review = AssistantDelegationReview(CallerGrantContext("preview", setOf("office")), mapOf("office" to "Office"), emptyList(), 0)), {}, {}) }
}
