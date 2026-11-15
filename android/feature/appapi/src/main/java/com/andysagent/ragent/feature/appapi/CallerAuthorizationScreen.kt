package com.andysagent.ragent.feature.appapi

import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.designsystem.*
import java.text.DateFormat
import java.util.Date

@Composable
internal fun ApiSettingsHeader(title: String, onClose: () -> Unit, enabled: Boolean = true) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        AgentoSettingsHeader(title = title, onBack = onClose, backDescription = stringResource(R.string.api_close),
            backEnabled = enabled, modifier = Modifier.widthIn(max = RagentSizes.ContentMaxWidth))
    }
}

@Composable
internal fun ApiSettingsCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val colors = LocalRagentColors.current
    val background = if (colors.canvas.red < 0.5f) colors.surfaceHighest else colors.surfaceLow
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(background).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
}

internal data class ApiPendingRecord(val id: String, val label: String, val revoking: Boolean, val revision: Long)

@Composable
internal fun ApiRecordConfirmation(record: ApiPendingRecord, assistant: Boolean, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val revoking = record.revoking
    val title = stringResource(if (assistant) {
        if (revoking) R.string.api_assistant_revoke else R.string.api_assistant_delete
    } else {
        if (revoking) R.string.api_access_revoke else R.string.api_access_clear_history
    })
    val body = stringResource(if (!revoking) R.string.api_access_clear_confirm else if (assistant)
        R.string.api_assistant_revoke_confirm else R.string.api_access_revocation_hint)
    val cancel = stringResource(R.string.api_cancel)
    val confirm = stringResource(R.string.api_confirm)
    AgentoDialog(title = title, confirmLabel = confirm, dismissLabel = cancel, destructive = true,
        onConfirm = onConfirm, onDismiss = onDismiss) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(record.label, color = LocalRagentColors.current.primaryContent, style = MaterialTheme.typography.titleSmall)
            Text(body, color = LocalRagentColors.current.primaryContent)
        }
    }
}

@Composable
internal fun AuthorizationPage(title: String, onClose: () -> Unit, canClose: Boolean = true, content: @Composable ColumnScope.() -> Unit) {
    val colors = LocalRagentColors.current
    CompositionLocalProvider(LocalContentColor provides colors.primaryContent) {
        Column(Modifier.fillMaxSize().background(colors.canvas).safeDrawingPadding().imePadding(),
            horizontalAlignment = Alignment.CenterHorizontally) {
            ApiSettingsHeader(title, onClose, canClose)
            Column(Modifier.weight(1f).widthIn(max = RagentSizes.ContentMaxWidth).fillMaxWidth()
                .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp), content = content)
        }
    }
}
@Composable
internal fun ScopeChoice(text: String, selected: Boolean, enabled: Boolean, change: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(selected, change, enabled = enabled, modifier = Modifier.semantics { contentDescription = text })
        Text(text, color = LocalRagentColors.current.primaryContent, modifier = Modifier.weight(1f))
    }
}
@Composable
internal fun CapabilityName(id: String): String = stringResource(when (id) {
    CapabilityRegistry.TARGETS_LIST -> R.string.api_access_cap_targets
    CapabilityRegistry.TASKS_PREPARE -> R.string.api_access_cap_prepare
    CapabilityRegistry.TASKS_COMMIT -> R.string.api_access_cap_commit
    CapabilityRegistry.TASKS_GET -> R.string.api_access_cap_get
    CapabilityRegistry.TASKS_RECONCILE -> R.string.api_access_cap_reconcile
    CapabilityRegistry.TASKS_CANCEL -> R.string.api_access_cap_cancel
    CapabilityRegistry.TASKS_RESULT -> R.string.api_access_cap_result
    CapabilityRegistry.TASKS_RESULT_EXPORT -> R.string.api_access_cap_export
    else -> R.string.api_access_cap_unknown
})
@Composable
internal fun AccessError(code: ApiErrorCode?) {
    if (code != null) Text(stringResource(R.string.api_access_error, code.name), color = LocalRagentColors.current.stateError,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
}
@Composable
internal fun ResourceScope(sessions: Set<String>?, projects: Set<String>?) {
    Text(stringResource(R.string.api_access_sessions, sessions?.sorted()?.joinToString(", ") ?: stringResource(R.string.api_access_all)), color = LocalRagentColors.current.secondaryContent)
    Text(stringResource(R.string.api_access_projects, projects?.sorted()?.joinToString(", ") ?: stringResource(R.string.api_access_all)), color = LocalRagentColors.current.secondaryContent)
}

@Composable
fun CallerConsentScreen(state: CallerConsentUiState, onEvent: (CallerConsentEvent) -> Unit, onCancel: () -> Unit) {
    AuthorizationPage(stringResource(R.string.api_access_request_title), onCancel, canClose = !state.saving) {
        if (state.loading) Text(stringResource(R.string.api_loading))
        AccessError(state.error)
        state.review?.let { review ->
            Text(review.appLabel, style = MaterialTheme.typography.titleMedium)
            Text(review.identity.packageName)
            Text(stringResource(R.string.api_access_signature, review.identity.currentSignerSha256.sorted().joinToString("\n")),
                color = LocalRagentColors.current.secondaryContent)
            Text(stringResource(R.string.api_access_request_hint))
            Text(stringResource(R.string.api_access_capabilities), style = MaterialTheme.typography.titleMedium)
            review.request.capabilityIds.sorted().forEach { id ->
                ScopeChoice(CapabilityName(id), id in state.capabilities, !state.saving && state.error == null) { onEvent(CallerConsentEvent.Capability(id, it)) }
            }
            Text(stringResource(R.string.api_access_computers), style = MaterialTheme.typography.titleMedium)
            review.targetLabels.keys.sorted().forEach { id ->
                ScopeChoice("${review.targetLabels.getValue(id)} ($id)", id in state.targets, !state.saving && state.error == null) { onEvent(CallerConsentEvent.Target(id, it)) }
            }
            ResourceScope(review.request.sessionIds, review.request.projectIds)
            if (review.request.mayCreateSessions) ScopeChoice(stringResource(R.string.api_access_creation), state.createSessions,
                !state.saving && state.error == null) { onEvent(CallerConsentEvent.Creation(it)) }
            Text(stringResource(R.string.api_access_duration, (state.durationMs + 999) / 1000))
            listOf(60L * 60 * 1000, 24L * 60 * 60 * 1000, review.request.lifetimeMs).filter { it <= review.request.lifetimeMs }.distinct().forEach { duration ->
                val label = stringResource(R.string.api_access_duration, (duration + 999) / 1000)
                AgentoSettingRow(title = label, showChevron = false, enabled = !state.saving && state.error == null,
                    modifier = Modifier.semantics { selected = state.durationMs == duration; role = Role.RadioButton },
                    onClick = { onEvent(CallerConsentEvent.Duration(duration)) })
            }
            Text(stringResource(R.string.api_access_revocation_hint), color = LocalRagentColors.current.secondaryContent)
        }
        if (state.error != null) AgentoButton(stringResource(R.string.api_access_review_again), { onEvent(CallerConsentEvent.Reload) }, enabled = !state.saving, secondary = true)
        AgentoButton(stringResource(R.string.api_access_allow), { onEvent(CallerConsentEvent.Approve) }, enabled = state.canApprove)
        AgentoButton(stringResource(R.string.api_access_deny), onCancel, enabled = !state.saving, secondary = true)
        if (state.saving) Text(stringResource(R.string.api_saving), modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
    }
}

@Composable
fun CallerGrantsScreen(state: CallerGrantsUiState, onEvent: (CallerGrantsEvent) -> Unit, onClose: () -> Unit) {
    var pending by remember { mutableStateOf<ApiPendingRecord?>(null) }
    val locale = LocalContext.current.resources.configuration.locales[0]
    AuthorizationPage(stringResource(R.string.api_access_manage_title), onClose, canClose = !state.busy) {
        ApiSettingsCard { Text(stringResource(R.string.api_access_revocation_hint)) }
        AccessError(state.error)
        if (state.loading) Text(stringResource(R.string.api_loading))
        if (!state.loading && state.error == null && state.grants.isEmpty()) ApiSettingsCard {
            Text(stringResource(R.string.api_access_empty), color = LocalRagentColors.current.secondaryContent)
        }
        state.grants.forEach { row ->
          ApiSettingsCard {
            Text(row.identity.packageName, style = MaterialTheme.typography.titleMedium)
            Text(stringResource(if (row.revokedAt != null) R.string.api_access_revoked else R.string.api_access_active))
            Text(stringResource(R.string.api_access_expires, DateFormat.getDateTimeInstance(DateFormat.DEFAULT, DateFormat.DEFAULT, locale).format(Date(row.grant.expiresAt))))
            row.grant.capabilityIds.sorted().forEach { Text(CapabilityName(it)) }
            Text(stringResource(R.string.api_access_targets_summary, row.grant.targetIds.sorted().joinToString(", ")))
            ResourceScope(row.grant.sessionIds, row.grant.projectIds)
            if (row.grant.mayCreateSessions) Text(stringResource(R.string.api_access_creation))
            if (row.revokedAt == null) AgentoButton(stringResource(R.string.api_access_revoke), { pending = ApiPendingRecord(row.grantId, row.identity.packageName, true, row.revision) }, enabled = !state.busy && !state.loading, secondary = true, labelMaxLines = Int.MAX_VALUE)
            else AgentoButton(stringResource(R.string.api_access_clear_history), { pending = ApiPendingRecord(row.grantId, row.identity.packageName, false, row.revision) }, enabled = !state.busy && !state.loading, secondary = true, labelMaxLines = Int.MAX_VALUE)
          }
        }
        AgentoButton(stringResource(R.string.api_access_refresh), { onEvent(CallerGrantsEvent.Refresh) }, enabled = !state.busy && !state.loading, secondary = true)
    }
    pending?.let { record ->
        ApiRecordConfirmation(record, assistant = false, onDismiss = { pending = null }, onConfirm = {
            pending = null
            val row = state.grants.firstOrNull { it.grantId == record.id }
            if (!state.busy && !state.loading && row != null && row.revision == record.revision && (row.revokedAt == null) == record.revoking) {
                onEvent(if (record.revoking) CallerGrantsEvent.Revoke(record.id) else CallerGrantsEvent.DeleteRevoked(record.id))
            }
        })
    }
}

private val previewRequest = CallerConsentRequest(setOf(CapabilityRegistry.TARGETS_LIST, CapabilityRegistry.TASKS_PREPARE, CapabilityRegistry.TASKS_COMMIT), setOf("office"), mayCreateSessions = true)
private val previewIdentity = InstalledCallerIdentity("example.assistant", 10011, 1, setOf("a".repeat(64)))
private val previewReview = CallerConsentReview(previewIdentity, "Example Assistant", previewRequest, mapOf("office" to "Office computer"), CallerGrantContext("local", setOf("office")), 1)
@Preview(widthDp = 360, heightDp = 960)
@Preview(widthDp = 840, heightDp = 960, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable private fun ConsentPreview() { RagentTheme(darkTheme = androidx.compose.foundation.isSystemInDarkTheme()) { CallerConsentScreen(CallerConsentUiState(loading = false, review = previewReview, durationMs = 3600000), {}, {}) } }
@Preview(widthDp = 360, heightDp = 800)
@Preview(widthDp = 840, heightDp = 800, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable private fun GrantsPreview() { RagentTheme(darkTheme = androidx.compose.foundation.isSystemInDarkTheme()) { CallerGrantsScreen(CallerGrantsUiState(loading = false,
    grants = listOf(PersistedCallerGrant("00000000-0000-0000-0000-000000000001", previewIdentity,
        previewRequest.narrow(previewIdentity, previewRequest.capabilityIds, previewRequest.targetIds, true, 3600000, 1), "local", 1, 1))), {}, {}) } }
