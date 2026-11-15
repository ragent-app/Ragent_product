package com.andysagent.ragent.feature.appapi

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.datastore.*
import com.andysagent.ragent.core.designsystem.*

@Composable
fun RoutingSettingsScreen(state: RoutingSettingsUiState, onEvent: (RoutingSettingsEvent) -> Unit,
    onClose: () -> Unit, onOpenDrafts: (() -> Unit)? = null, modifier: Modifier = Modifier,
    onOpenGrants: (() -> Unit)? = null, onOpenAssistantDelegation: (() -> Unit)? = null) {
    val colors = LocalRagentColors.current
    Column(modifier.fillMaxSize().background(colors.canvas).safeDrawingPadding().imePadding(),
        horizontalAlignment = Alignment.CenterHorizontally) {
        ApiSettingsHeader(stringResource(R.string.api_routing_title), onClose, !state.saving)
        Column(Modifier.weight(1f).widthIn(max = RagentSizes.ContentMaxWidth).fillMaxWidth()
            .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (state.loading) Text(stringResource(R.string.api_loading), color = colors.secondaryContent)
            state.error?.let { error ->
                Text(stringResource(when (error) {
                    RoutingSettingsError.LOAD -> R.string.api_load_error
                    RoutingSettingsError.INVALID_ALIASES -> R.string.api_alias_invalid
                    RoutingSettingsError.TARGET_REMOVED -> R.string.api_target_removed
                    RoutingSettingsError.SAVE -> R.string.api_save_error
                }), color = colors.stateError, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                if (error == RoutingSettingsError.LOAD) AgentoButton(stringResource(R.string.api_retry), { onEvent(RoutingSettingsEvent.Reload) }, secondary = true)
            }
            if (!state.loading && !state.directory.appApiRouting.readable) {
                Text(stringResource(R.string.api_routing_unreadable), color = colors.stateError)
                AgentoButton(stringResource(R.string.api_reset_routing), { onEvent(RoutingSettingsEvent.Reset) }, enabled = !state.saving, secondary = true)
            } else if (!state.loading && state.error != RoutingSettingsError.LOAD) {
                val defaultId = state.directory.appApiRouting.defaultShareTargetId
                if (defaultId != null && state.directory.computers.none { it.instanceId == defaultId }) {
                    Text(stringResource(R.string.api_default_missing), color = colors.stateError)
                }
                Text(stringResource(R.string.settings_share_target_title), color = colors.primaryContent,
                    style = MaterialTheme.typography.titleSmall)
                Text(stringResource(R.string.api_routing_description), color = colors.secondaryContent,
                    style = MaterialTheme.typography.bodyMedium)
                ApiSettingsCard {
                AgentoSettingRow(title = stringResource(R.string.api_no_default), showChevron = false, enabled = !state.saving, contentHorizontalPadding = 0.dp,
                    trailing = { if (defaultId == null) AgentoWebIcon(AgentoWebGlyph.Check, null, tint = colors.accentPrimary) },
                    modifier = Modifier.semantics(mergeDescendants = true) { selected = defaultId == null; role = Role.RadioButton; if (state.saving) disabled() },
                    onClick = { onEvent(RoutingSettingsEvent.SelectDefault(null)) })
                if (state.directory.computers.isEmpty()) Text(stringResource(R.string.api_no_computers), color = colors.secondaryContent)
                state.directory.computers.forEach { computer ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AgentoSettingRow(title = computer.label.ifBlank { computer.instanceId },
                            showDivider = false, showChevron = false, enabled = !state.saving, contentHorizontalPadding = 0.dp,
                            trailing = { if (defaultId == computer.instanceId) AgentoWebIcon(AgentoWebGlyph.Check, null, tint = colors.accentPrimary) },
                            modifier = Modifier.weight(1f).semantics(mergeDescendants = true) { selected = defaultId == computer.instanceId; role = Role.RadioButton; if (state.saving) disabled() },
                            onClick = { onEvent(RoutingSettingsEvent.SelectDefault(computer.instanceId)) })
                        AgentoToolbarIconButton(
                            onClick = { onEvent(RoutingSettingsEvent.EditAliases(computer.instanceId)) },
                            contentDescription = stringResource(R.string.api_edit_aliases, computer.label.ifBlank { computer.instanceId }),
                            enabled = !state.saving,
                        ) { AgentoWebIcon(AgentoWebGlyph.Edit, null, tint = colors.secondaryContent) }
                    }
                }
            }
                }
            state.editingTargetId?.let {
                val label = stringResource(R.string.api_alias_label)
                Text(stringResource(R.string.api_alias_help), color = colors.secondaryContent)
                AgentoTextField(state.aliasesText, { onEvent(RoutingSettingsEvent.ChangeAliases(it)) }, label,
                    enabled = !state.saving, singleLine = false, inputModifier = Modifier.semantics { contentDescription = label })
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AgentoButton(stringResource(R.string.api_save), { onEvent(RoutingSettingsEvent.SaveAliases) }, enabled = !state.saving)
                    AgentoButton(stringResource(R.string.api_cancel), { onEvent(RoutingSettingsEvent.CloseEditor) }, enabled = !state.saving, secondary = true)
                }
            }
            if (onOpenDrafts != null || onOpenGrants != null || onOpenAssistantDelegation != null) ApiSettingsCard {
                onOpenDrafts?.let { AgentoSettingRow(title = stringResource(R.string.api_saved_drafts), onClick = it, enabled = !state.saving, contentHorizontalPadding = 0.dp) }
                onOpenGrants?.let { AgentoSettingRow(title = stringResource(R.string.api_access_manage_title), onClick = it, enabled = !state.saving, contentHorizontalPadding = 0.dp) }
                onOpenAssistantDelegation?.let { AgentoSettingRow(title = stringResource(R.string.api_assistant_title), onClick = it, enabled = !state.saving, showDivider = false, contentHorizontalPadding = 0.dp) }
            }
            if (state.saving) Text(stringResource(R.string.api_saving), color = colors.secondaryContent, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
    }
}

class RoutingPreviewStates : PreviewParameterProvider<RoutingSettingsUiState> {
    private val computers = listOf(LinkedComputer("pc-a", "", "Office"), LinkedComputer("pc-b", "", "Home"))
    override val values = sequenceOf(
        RoutingSettingsUiState(),
        RoutingSettingsUiState(loading = false),
        RoutingSettingsUiState(loading = false, directory = ComputerDirectory(computers, "pc-a", AppApiRoutingPreferences(defaultShareTargetId = "pc-b"))),
        RoutingSettingsUiState(loading = false, directory = ComputerDirectory(computers, "pc-a", AppApiRoutingPreferences(defaultShareTargetId = "removed"))),
        RoutingSettingsUiState(loading = false, directory = ComputerDirectory(computers, "pc-a", AppApiRoutingPreferences(readable = false))),
        RoutingSettingsUiState(loading = false, directory = ComputerDirectory(computers), editingTargetId = "pc-a", aliasesText = "Main PC", saving = true),
    )
}
@Preview(widthDp = 360, heightDp = 800)
@Preview(widthDp = 360, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(widthDp = 840, heightDp = 800)
@Preview(widthDp = 840, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun RoutingSettingsPreview(@PreviewParameter(RoutingPreviewStates::class) state: RoutingSettingsUiState) {
    RagentTheme(darkTheme = isSystemInDarkTheme()) { RoutingSettingsScreen(state, {}, {}) }
}
