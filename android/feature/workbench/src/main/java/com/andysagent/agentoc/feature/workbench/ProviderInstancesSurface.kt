package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.font.FontWeight
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.designsystem.*

@Composable
internal fun ProviderInstanceSelector(state: WebParityUiState, onEvent: (WebParityEvent) -> Unit,
    modifier: Modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
    targetConnectionStates: Map<String, RuntimeConnectionState> = emptyMap()) {
    var expanded by remember { mutableStateOf(false) }
    val selected = state.providerInstances.firstOrNull { it.instance.id == state.providerTargetId }
    val canSwitch = !state.actionInProgress && state.providerOAuthJob?.terminal != false
    val colors = LocalAgentocColors.current
    Box(modifier) {
        Row(Modifier.widthIn(max = 240.dp).heightIn(min = 48.dp).clip(CircleShape)
            .background(colors.canvas)
            .clickable(enabled = canSwitch, role = Role.Button) { expanded = true }
            .testTag("provider-instance-selector").padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(selected?.instance?.label ?: stringResource(R.string.pi_all), Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.labelLarge.copy(fontSize = 14.sp), maxLines = 2, overflow = TextOverflow.Ellipsis)
            AgentoWebIcon(AgentoWebGlyph.ChevronDown, null, Modifier.size(16.dp), tint = colors.secondaryContent)
        }
        AgentoDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, opaqueFallback = true) {
            DropdownMenuItem(text = { Text(stringResource(R.string.pi_all)) },
                onClick = { expanded = false; onEvent(WebParityEvent.SelectProviderInstance(null)) },
                modifier = Modifier.testTag("provider-instance-all"))
            state.providerInstances.forEach { target ->
                DropdownMenuItem(text = { Column {
                    Text(target.instance.label)
                    Text(stringResource(when { target.loading -> R.string.pi_loading
                        target.available -> R.string.pi_config_read
                        targetConnectionStates[target.instance.id] == RuntimeConnectionState.Connected -> R.string.pi_transport_connected
                        else -> R.string.pi_config_unconfirmed }),
                        style = MaterialTheme.typography.bodySmall)
                } }, onClick = { expanded = false; onEvent(WebParityEvent.SelectProviderInstance(target.instance.id)) },
                    modifier = Modifier.testTag("provider-instance-${target.instance.id}"))
            }
        }
    }
}

@Composable
internal fun ProviderInstanceFailureText(failure: ProviderInstanceFailure?, modifier: Modifier = Modifier) {
    if (failure == null) return
    val message = when (failure.kind) {
        ProviderInstanceFailureKind.Unauthorized -> stringResource(R.string.pi_error_unauthorized)
        ProviderInstanceFailureKind.Forbidden -> stringResource(R.string.pi_error_forbidden)
        ProviderInstanceFailureKind.NotFound -> stringResource(R.string.pi_error_not_found)
        ProviderInstanceFailureKind.Server -> stringResource(R.string.pi_error_server, failure.httpStatusCode ?: 500)
        ProviderInstanceFailureKind.Http -> stringResource(R.string.pi_error_http, failure.httpStatusCode ?: 0)
        ProviderInstanceFailureKind.Network -> stringResource(R.string.pi_error_network)
        ProviderInstanceFailureKind.Unknown -> stringResource(R.string.pi_error_unknown)
    }
    Text(message, modifier = modifier, style = MaterialTheme.typography.bodyMedium,
        color = LocalAgentocColors.current.secondaryContent)
}

@Composable
internal fun AccountProvidersOverview(state: WebParityUiState, onEvent: (WebParityEvent) -> Unit) {
    val restricted = LocalRestrictedDemoEnvironment.current
    val groups = remember(state.providerInstances, restricted) { accountProviderGroups(state.providerInstances, restricted) }
    val colors = LocalAgentocColors.current
    LazyColumn(contentPadding = PaddingValues(start = 24.dp, end = 24.dp, top = 8.dp, bottom = 80.dp),
        modifier = Modifier.testTag("provider-account-overview")) {
        if (state.providerInstances.isEmpty() && !state.refreshing) item { Text(stringResource(R.string.pi_no_instances)) }
        val unconfirmed = state.providerInstances.filter { !it.available || it.loading }
        if (unconfirmed.isNotEmpty()) item {
            Text(stringResource(R.string.pi_unconfirmed, unconfirmed.joinToString("、") { it.instance.label }),
                Modifier.padding(top = 8.dp, bottom = 4.dp), style = MaterialTheme.typography.bodySmall,
                color = colors.secondaryContent)
        }
        if (groups.isEmpty() && !state.refreshing && state.providerInstances.any { it.available }) item {
            Text(stringResource(R.string.pi_empty))
        }
        listOf(false, true).forEach { local ->
          val section = groups.filter { it.provider.machineLocal == local }
          if (section.isNotEmpty()) item(key = "section-$local") {
              Text(stringResource(if (local) R.string.pi_local else R.string.pi_shared),
                  Modifier.padding(top = 24.dp, bottom = 2.dp), style = MaterialTheme.typography.labelMedium,
                  color = colors.secondaryContent)
          }
          items(section, key = { it.key }) { group ->
            ManagementSection(Modifier.testTag("provider-group-${group.key}")) {
                if (local) {
                    ProviderInstanceEntry(group.copies.first(), onEvent, group.provider.name)
                } else {
                    Text(group.provider.name, style = MaterialTheme.typography.titleSmall)
                    if (group.copies.size > 1) Text(stringResource(
                        when {
                            group.copies.any { copy -> state.providerInstances.any { it.instance.id == copy.instance.id && it.loading } } -> R.string.pi_compare_pending
                            group.configurationMatches -> R.string.pi_matching
                            group.configurationDiffers -> R.string.pi_different
                            else -> R.string.pi_compare_pending
                        }, group.copies.size), style = MaterialTheme.typography.bodySmall,
                        color = if (group.configurationDiffers) colors.waiting else colors.secondaryContent)
                    Column {
                        group.copies.forEach { copy ->
                            ProviderInstanceEntry(copy, onEvent)
                        }
                    }
                    if (!group.provider.machineLocal && group.provider.syncId.isBlank()) {
                        Text(stringResource(R.string.pi_legacy), style = MaterialTheme.typography.bodySmall,
                            color = LocalAgentocColors.current.secondaryContent)
                    }
                    if (!group.provider.machineLocal && group.provider.syncId.isNotBlank()) {
                        val absent = state.providerInstances.filter { target -> target.available && !target.loading &&
                            target.snapshot.providers.all { it.machineLocal || it.syncId.isNotBlank() } &&
                            group.copies.none { it.instance.id == target.instance.id } }
                        if (absent.isNotEmpty()) Text(stringResource(R.string.pi_not_observed, absent.joinToString("、") { it.instance.label }),
                            style = MaterialTheme.typography.bodySmall, color = LocalAgentocColors.current.secondaryContent)
                    }
                }
            }
          }
        }
    }
}

@Composable
private fun ProviderInstanceEntry(copy: ProviderInstanceCopy, onEvent: (WebParityEvent) -> Unit, title: String? = null) {
    val colors = LocalAgentocColors.current
    val credentialState = stringResource(if (copy.provider.ready) R.string.pi_credentials_saved else R.string.sp_credentials_missing)
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(8.dp))
        .clickable(role = Role.Button) { onEvent(WebParityEvent.SelectProviderInstance(copy.instance.id)) }
        .semantics { stateDescription = credentialState }
        .testTag("provider-manage-${copy.instance.id}-${copy.provider.id}").padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title ?: copy.instance.label, style = MaterialTheme.typography.bodyMedium.copy(
                fontSize = 15.sp, fontWeight = if (title != null) FontWeight.Medium else FontWeight.Normal))
            if (title != null) Text(copy.instance.label, style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
            if (!copy.provider.ready) Text(credentialState, style = MaterialTheme.typography.labelSmall, color = colors.error)
        }
        AgentoWebIcon(AgentoWebGlyph.ChevronRight, null, Modifier.size(16.dp), tint = colors.tertiaryContent)
    }
}
