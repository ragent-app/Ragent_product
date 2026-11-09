package com.andysagent.agentoc.feature.workbench

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Checkbox
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.key
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.testTag
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import android.content.Intent
import android.net.Uri
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.text.NumberFormat
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Color
import com.andysagent.agentoc.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.agentoc.core.designsystem.AgentoGlassSurface
import com.andysagent.agentoc.core.designsystem.AgentoGlassMaterial
import com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoCard
import com.andysagent.agentoc.core.designsystem.AgentoDialog
import com.andysagent.agentoc.core.designsystem.AgentoDropdownMenu
import com.andysagent.agentoc.core.designsystem.AgentoDropdownMenuItem
import com.andysagent.agentoc.core.designsystem.AgentoEmptyState
import com.andysagent.agentoc.core.designsystem.AgentoErrorText
import com.andysagent.agentoc.core.designsystem.AgentoListItem
import com.andysagent.agentoc.core.designsystem.AgentoProgress
import com.andysagent.agentoc.core.designsystem.AgentoSettingBadge
import com.andysagent.agentoc.core.designsystem.AgentoStatus
import com.andysagent.agentoc.core.designsystem.AgentoStatusTone
import com.andysagent.agentoc.core.designsystem.AgentoSurface
import com.andysagent.agentoc.core.designsystem.AgentoTextField
import com.andysagent.agentoc.core.designsystem.AgentoToolbarIconButton
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.AgentocSizes
import com.andysagent.agentoc.core.designsystem.AgentocSpacing
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.core.protocol.AgentocProtocol
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

@Composable
fun WebParitySurface(
    page: WebParityPage,
    state: WebParityUiState,
    onEvent: (WebParityEvent) -> Unit,
    onBack: () -> Unit,
    fallbackDevices: List<WebDevice> = emptyList(),
    connectedTargetId: String? = null,
    targetConnectionStates: Map<String, RuntimeConnectionState> = emptyMap(),
    connectingTargetId: String? = null,
    onConnectComputer: ((String) -> Unit)? = null,
    onDisconnectComputer: ((String) -> Unit)? = null,
    onAddComputer: (() -> Unit)? = null,
    targetId: String? = null,
    targetLabel: String? = null,
    projectId: String? = null,
    backContentDescription: String? = null,
    backProgress: Float = 0f,
    connectionAvailable: Boolean = true,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(page, targetId) { onEvent(WebParityEvent.OpenPage(page)) }
    val title = stringResource(page.titleRes())
    // Harness actions route to explicit computers, independently of the active session.
    val crossProviders = page == WebParityPage.ModelProviders && state.providerCrossInstance
    val selectedProviderInstance = state.providerInstances.firstOrNull { it.instance.id == state.providerTargetId }
    val providerLabel = if (crossProviders) selectedProviderInstance?.instance?.label else targetLabel
    val writable = if (crossProviders) selectedProviderInstance?.available == true && !state.actionInProgress
        else page == WebParityPage.Harnesses || connectionAvailable
    CompositionLocalProvider(LocalRemoteSettingsWritable provides writable) {
    AgentoSurface(modifier.fillMaxSize(), color = if (page == WebParityPage.ModelProviders || page == WebParityPage.Harnesses)
        LocalAgentocColors.current.surfaceLow else LocalAgentocColors.current.canvas) {
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
            SettingsWebHeader(
                onBack = { if (state.selectedFile != null) onEvent(WebParityEvent.CloseFile) else onBack() },
                title = title, subtitle = when (page) {
                    WebParityPage.Harnesses -> stringResource(R.string.settings_scope_account_computers)
                    WebParityPage.ModelProviders -> if (crossProviders) null else providerLabel?.let { stringResource(R.string.settings_provider_via, it) }
                    else -> targetLabel
                },
                backDescription = if (state.selectedFile != null) stringResource(R.string.settings_back_files) else backContentDescription,
                backTag = if (state.selectedFile != null) "web-parity-back" else "settings-back",
                onRefresh = { onEvent(WebParityEvent.Refresh) },
                refreshDescription = stringResource(R.string.settings_refresh_page, title),
                refreshing = state.refreshing,
            )
            if (!writable && !crossProviders) Column(Modifier.widthIn(max = AgentocSizes.ContentMaxWidth).fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
                Text(stringResource(R.string.settings_config_offline),
                    color = LocalAgentocColors.current.secondaryContent, style = MaterialTheme.typography.bodyMedium)
            }
            WorkbenchBackStackTransition(
                isOpen = state.selectedFile != null,
                backProgress = backProgress,
                modifier = Modifier.weight(1f).widthIn(max = AgentocSizes.ContentMaxWidth).fillMaxWidth(),
                parentContent = {
                    if (state.loading) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { AgentoProgress(modifier = Modifier.size(24.dp)) }
                    } else {
                        when (page) {
                            WebParityPage.Agents -> AgentsAppsPage(state, onEvent, projectId)
                            WebParityPage.Connectors -> ConnectorsPage(state, onEvent)
                            WebParityPage.ModelProviders -> if (crossProviders) {
                                Column(Modifier.fillMaxSize().background(LocalAgentocColors.current.surfaceLow)) {
                                    if (state.providerTargetId == null || selectedProviderInstance?.available != true)
                                        ProviderInstanceSelector(state, onEvent, targetConnectionStates = targetConnectionStates)
                                    if (state.providerTargetId == null) AccountProvidersOverview(state, onEvent)
                                    else if (selectedProviderInstance?.available == true) key(state.providerTargetId) {
                                        ProvidersPage(restrictDemoParityState(state, LocalRestrictedDemoEnvironment.current), onEvent, providerLabel,
                                            instanceSelector = { ProviderInstanceSelector(state, onEvent, Modifier, targetConnectionStates) })
                                    } else Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                        if (selectedProviderInstance?.loading == true) Text(stringResource(R.string.pi_loading))
                                        else {
                                            val connected = selectedProviderInstance?.instance?.id?.let(targetConnectionStates::get) == RuntimeConnectionState.Connected
                                            Text(stringResource(if (connected) R.string.pi_config_failed_connected else R.string.pi_config_failed))
                                            ProviderInstanceFailureText(selectedProviderInstance?.failure)
                                        }
                                        OnboardingTextAction(stringResource(R.string.pi_retry), { state.providerTargetId?.let { onEvent(WebParityEvent.RetryProviderInstance(it)) } })
                                    }
                                }
                            } else ProvidersPage(restrictDemoParityState(state, LocalRestrictedDemoEnvironment.current), onEvent, targetLabel)
                            WebParityPage.Harnesses -> HarnessesPage(restrictDemoParityState(state, LocalRestrictedDemoEnvironment.current), onEvent, targetId)
                            WebParityPage.Devices -> DevicesPage(
                                state = state,
                                onEvent = onEvent,
                                fallbackDevices = fallbackDevices,
                                connectedTargetId = connectedTargetId,
                                targetConnectionStates = targetConnectionStates,
                                connectingTargetId = connectingTargetId,
                                onConnectComputer = onConnectComputer,
                                onDisconnectComputer = onDisconnectComputer,
                                onAddComputer = onAddComputer,
                            )
                            WebParityPage.Files -> FilesPage(state, onEvent)
                            WebParityPage.Triggers -> TriggersPage(state, onEvent)
                            WebParityPage.Usage -> UsagePage(state.usage)
                        }
                    }
                },
                childContent = {
                    if (state.selectedFile != null) {
                        FileDetailSurface(state, onEvent)
                    }
                },
            )
            if (crossProviders && !LocalRestrictedDemoEnvironment.current) ProviderOAuthDialog(state, onEvent)
            state.error?.let { AgentoErrorText(localizedParityError(it), Modifier.fillMaxWidth().padding(AgentocSpacing.Gutter)) }
        }
    }
}

}

private val LocalRemoteSettingsWritable = staticCompositionLocalOf { true }

@Composable
private fun RemoteSettingsAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true, secondary: Boolean = false, leadingIcon: (@Composable () -> Unit)? = null) {
    AgentoButton(text, onClick, modifier, enabled = enabled && LocalRemoteSettingsWritable.current,
        secondary = secondary, leadingIcon = leadingIcon)
}

@Composable
private fun RemoteManagementAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true, secondary: Boolean = true, emphasized: Boolean = false) {
    ManagementAction(text, onClick, modifier, enabled && LocalRemoteSettingsWritable.current, secondary, emphasized)
}

@Composable
private fun RemoteSettingsDialog(title: String, confirmLabel: String, onConfirm: () -> Unit, onDismiss: () -> Unit,
    dismissLabel: String, confirmEnabled: Boolean = true, dismissEnabled: Boolean = true,
    confirmModifier: Modifier = Modifier, destructive: Boolean = false, content: @Composable () -> Unit) {
    AgentoDialog(title, confirmLabel, onConfirm, onDismiss, dismissLabel = dismissLabel,
        confirmEnabled = confirmEnabled && LocalRemoteSettingsWritable.current,
        dismissEnabled = dismissEnabled, confirmModifier = confirmModifier, destructive = destructive,
        opaqueFallback = true, textureAlpha = 0f, content = content)
}

/** Translate app-owned fallback messages while preserving unrecognized server diagnostics. */
@Composable
private fun localizedParityError(message: String): String {
    val resource = when (message) {
        "Account device actions require a verified account session." -> R.string.sp_error_account_required
        "Only account devices can be renamed." -> R.string.sp_error_rename_account_only
        "Unable to open the official page. Use Open login page to retry." -> R.string.sp_error_open_login
        "Cancellation is unconfirmed. Check login status before starting another login." -> R.string.sp_error_cancel_unconfirmed
        "Login status is not confirmed. Check status to continue; no new login was started." -> R.string.sp_error_login_unconfirmed
        "Login status could not be checked. Check status after reconnecting; no new login was started." -> R.string.sp_error_login_check
        "Web feature could not be loaded" -> R.string.sp_error_load
        "Action failed" -> R.string.sp_error_action
        "Harness action failed" -> R.string.sp_error_harness
        "Connector login failed" -> R.string.sp_error_connector_login
        "Provider login failed" -> R.string.sp_error_provider_login
        "Credential submission failed" -> R.string.sp_error_credentials
        "Provider rotation update failed" -> R.string.sp_error_rotation
        "Provider selection update failed" -> R.string.sp_error_selection
        "File could not be opened" -> R.string.sp_error_file
        "Folder could not be opened" -> R.string.sp_error_folder
        else -> null
    }
    return resource?.let { stringResource(it) } ?: message
}

@Composable
internal fun SettingsContentCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val colors = LocalAgentocColors.current
    val cardColor = if (colors.canvas.red < 0.5f) colors.surfaceHighest else colors.surfaceLow
    Box(modifier.clip(RoundedCornerShape(16.dp)).background(cardColor)) { content() }
}

@Composable
private fun FileDetailSurface(state: WebParityUiState, onEvent: (WebParityEvent) -> Unit) {
    val context = LocalContext.current
    val shareTitle = stringResource(R.string.sp_share_file)
    val payload = state.filePayload
    val saveLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(payload?.mimeType ?: "application/octet-stream")) { uri: Uri? ->
        if (uri != null && payload != null) runCatching {
            context.contentResolver.openOutputStream(uri)?.use { it.write(payload.bytes) }
        }
    }
    fun sharedUri(): Uri? = payload?.let {
        val directory = File(context.cacheDir, "shared").apply { mkdirs() }
        val file = File(directory, it.name.replace(Regex("[^A-Za-z0-9._-]"), "_"))
        file.writeBytes(it.bytes)
        FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    }
    fun shareFile() {
        val uri = sharedUri() ?: return
        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
            type = payload?.mimeType ?: "application/octet-stream"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }, shareTitle))
    }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(AgentocSpacing.Gutter),
        verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
    ) {
        AgentoButton(stringResource(R.string.settings_back_files), { onEvent(WebParityEvent.CloseFile) }, secondary = true, leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Back, null) })
        Text(state.selectedFile.orEmpty(), style = MaterialTheme.typography.titleMedium)
        if (payload == null && state.fileReadInProgress) {
            AgentoProgress()
        } else if (state.fileContent != null) {
            Text(state.fileContent, style = MaterialTheme.typography.bodySmall)
        } else if (payload != null) {
            Text("${payload.name} · ${payload.mimeType} · ${payload.bytes.size} bytes", style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.sp_binary_file_ready), style = MaterialTheme.typography.bodySmall)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
            AgentoButton(stringResource(R.string.sp_save_file), { payload?.let { saveLauncher.launch(it.name) } }, enabled = payload != null, secondary = true, leadingIcon = { AgentoWebIcon(AgentoWebGlyph.File, null) })
            AgentoButton(stringResource(R.string.sp_share), { shareFile() }, enabled = payload != null, secondary = true, leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Share, null) })
            AgentoButton(stringResource(R.string.sp_open), { sharedUri()?.let { uri -> context.startActivity(Intent(Intent.ACTION_VIEW).apply { setDataAndType(uri, payload?.mimeType); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }) } }, enabled = payload != null, secondary = true)
        }
    }
}

@Composable
fun AgentsAppsPage(
    state: WebParityUiState,
    onEvent: (WebParityEvent) -> Unit,
    projectId: String? = null,
) {
    var dialog by remember { mutableStateOf(false) }
    var editingAgent by remember { mutableStateOf<WebAgent?>(null) }
    var name by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var welcomeMessage by remember { mutableStateOf("") }
    var skillsText by remember { mutableStateOf("") }
    var perMessagePromptText by remember { mutableStateOf("") }
    var templateContextText by remember { mutableStateOf("") }
    var collaborationPolicyText by remember { mutableStateOf("") }
    var tool by remember { mutableStateOf(state.availableTools.firstOrNull() ?: "codex") }
    var advancedConfigurationExpanded by remember { mutableStateOf(false) }
    LazyColumn(contentPadding = navigationContentPadding(), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
        item {
            AgentoButton("Create Agent", {
                editingAgent = null
                name = ""
                prompt = ""
                welcomeMessage = ""
                skillsText = ""
                perMessagePromptText = ""
                templateContextText = ""
                collaborationPolicyText = ""
                tool = state.availableTools.firstOrNull() ?: "codex"
                advancedConfigurationExpanded = false
                dialog = true
            }, leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Plus, null) })
        }
        if (state.agents.isEmpty()) item { AgentoEmptyState("No agents", "Create a reusable workflow or start with the built-in Chat agent.") }
        items(state.agents, key = { it.id }) { agent ->
            AgentoCard(Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth().padding(AgentocSpacing.Standard), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                        AgentoWebIcon(AgentoWebGlyph.Agent, null, Modifier.size(24.dp))
                        Text(agent.name, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                        AgentoStatus(if (agent.builtin) "Built-in" else agent.tool, if (agent.builtin) AgentoStatusTone.Neutral else AgentoStatusTone.Running)
                    }
                    if (agent.description.isNotBlank()) Text(agent.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    Row(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                        AgentoButton(
                            "Open session",
                            { onEvent(WebParityEvent.StartAgent(agent.id, projectId)) },
                            modifier = Modifier.weight(1f),
                        )
                        if (!agent.builtin) {
                            AgentoButton(stringResource(R.string.sp_edit), {
                                editingAgent = agent
                                name = agent.name
                                prompt = agent.description
                                welcomeMessage = agent.welcomeMessage
                                skillsText = agent.skills.joinToString(", ")
                                perMessagePromptText = agent.perMessageSystemPrompt?.toString().orEmpty()
                                templateContextText = agent.templateContext?.toString().orEmpty()
                                collaborationPolicyText = agent.collaborationPolicy?.toString().orEmpty()
                                tool = agent.tool
                                advancedConfigurationExpanded = agent.skills.isNotEmpty() ||
                                    agent.perMessageSystemPrompt != null ||
                                    agent.templateContext != null ||
                                    agent.collaborationPolicy != null
                                dialog = true
                            }, modifier = Modifier.weight(1f), secondary = true)
                            AgentoButton(stringResource(R.string.sp_delete), { onEvent(WebParityEvent.DeleteAgent(agent.id)) }, modifier = Modifier.weight(1f), secondary = true)
                        }
                    }
                }
            }
        }
    }
    if (dialog) {
        AgentoDialog(
            title = if (editingAgent == null) "Create Agent" else "Edit Agent",
            confirmLabel = if (editingAgent == null) "Create" else "Save",
            onDismiss = {
                dialog = false
                editingAgent = null
                advancedConfigurationExpanded = false
            },
            onConfirm = {
                dialog = false
                val skills = skillsText.split(",", "\n").map(String::trim).filter(String::isNotEmpty).distinct()
                val existing = editingAgent
                fun jsonObjectOrNull(value: String): JsonObject? = value.trim().takeIf { it.isNotEmpty() }?.let { raw ->
                    runCatching { AgentocProtocol.json.parseToJsonElement(raw).jsonObject }.getOrNull()
                }
                val perMessage = jsonObjectOrNull(perMessagePromptText)
                val context = jsonObjectOrNull(templateContextText)
                val policy = jsonObjectOrNull(collaborationPolicyText)
                if (existing == null) onEvent(WebParityEvent.CreateAgent(name, prompt, tool, welcomeMessage, skills, perMessage, context, policy))
                else onEvent(WebParityEvent.UpdateAgent(existing.id, name, prompt, tool, welcomeMessage, skills, perMessage, context, policy))
                editingAgent = null
                advancedConfigurationExpanded = false
            },
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Standard)) {
                Text(
                    "Define the agent's behavior first.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                AgentoTextField(name, { name = it }, stringResource(R.string.sp_name), Modifier.fillMaxWidth())
                AgentoTextField(prompt, { prompt = it }, "System prompt", Modifier.fillMaxWidth(), singleLine = false)
                AgentoTextField(welcomeMessage, { welcomeMessage = it }, "Welcome message", Modifier.fillMaxWidth(), singleLine = false)
                if (state.availableTools.isNotEmpty()) {
                    Text(
                        "Runtime",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                        state.availableTools.forEach { option ->
                            AgentoButton(
                                option,
                                { tool = option },
                                modifier = Modifier.weight(1f),
                                secondary = tool != option,
                            )
                        }
                    }
                }
                AgentoButton(
                    text = if (advancedConfigurationExpanded) "Hide advanced configuration" else "Advanced configuration",
                    onClick = { advancedConfigurationExpanded = !advancedConfigurationExpanded },
                    modifier = Modifier.fillMaxWidth(),
                    secondary = true,
                )
                AnimatedVisibility(
                    visible = advancedConfigurationExpanded,
                    enter = fadeIn(tween(160)) + expandVertically(tween(180)),
                    exit = fadeOut(tween(120)) + shrinkVertically(tween(140)),
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                        Text(
                            "Advanced configuration",
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        AgentoTextField(skillsText, { skillsText = it }, "Skills (comma separated)", Modifier.fillMaxWidth())
                        AgentoTextField(perMessagePromptText, { perMessagePromptText = it }, "Per-message prompt JSON", Modifier.fillMaxWidth(), singleLine = false)
                        AgentoTextField(templateContextText, { templateContextText = it }, "Template context JSON", Modifier.fillMaxWidth(), singleLine = false)
                        AgentoTextField(collaborationPolicyText, { collaborationPolicyText = it }, "Collaboration policy JSON", Modifier.fillMaxWidth(), singleLine = false)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ConnectorsPage(state: WebParityUiState, onEvent: (WebParityEvent) -> Unit) {
    val uriHandler = LocalUriHandler.current
    LaunchedEffect(state.externalUrl) {
        state.externalUrl?.let { url -> runCatching { uriHandler.openUri(url) }; onEvent(WebParityEvent.ClearExternalUrl) }
    }
    var dialog by remember { mutableStateOf(false) }
    var family by remember { mutableStateOf("codex") }
    var name by remember { mutableStateOf("") }
    var command by remember { mutableStateOf("") }
    var deletingServer by remember { mutableStateOf<WebMcpServer?>(null) }
    LazyColumn(contentPadding = navigationContentPadding(), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
        item { RemoteSettingsAction(stringResource(R.string.sp_add_mcp), { dialog = true }, leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Plus, null) }) }
        item { Text(stringResource(R.string.sp_connected_services), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = AgentocSpacing.Compact)) }
        items(state.connectors, key = { it.id }) { connector ->
            val isGithub = connector.id.contains("github", ignoreCase = true)
            val isGoogle = connector.id.contains("google", ignoreCase = true) || connector.id.contains("calendar", ignoreCase = true)
            SettingsContentCard(Modifier.fillMaxWidth()) {
              Column(Modifier.fillMaxWidth().padding(AgentocSpacing.Standard), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                Row(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact), verticalAlignment = Alignment.CenterVertically) {
                    AgentoWebIcon(AgentoWebGlyph.Share, null)
                    Column(Modifier.weight(1f)) {
                        Text(connector.name, style = MaterialTheme.typography.titleSmall)
                        Text(connector.detail, style = MaterialTheme.typography.bodySmall, color = LocalAgentocColors.current.secondaryContent)
                    }
                    AgentoStatus(stringResource(if (connector.ready) R.string.sp_ready else R.string.sp_not_connected), if (connector.ready) AgentoStatusTone.Success else AgentoStatusTone.Neutral)
                }
                if (connector.description.isNotBlank()) Text(connector.description, style = MaterialTheme.typography.bodySmall, color = LocalAgentocColors.current.secondaryContent)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                    if (!connector.ready && (isGithub || isGoogle)) RemoteSettingsAction(stringResource(R.string.settings_connect), { onEvent(WebParityEvent.StartConnectorOAuth(connector.id)) }, secondary = true)
                    if (connector.ready && isGithub) RemoteSettingsAction(stringResource(R.string.settings_disconnect), { onEvent(WebParityEvent.DisconnectConnector(connector.id)) }, secondary = true)
                    if (connector.entryUrl.isNotBlank()) RemoteSettingsAction(stringResource(R.string.sp_open), { runCatching { uriHandler.openUri(connector.entryUrl) } }, secondary = true)
                }
              }
            }
        }
        item { Text(stringResource(R.string.sp_mcp_servers), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = AgentocSpacing.Compact)) }
        if (state.mcpServers.isEmpty()) item { AgentoEmptyState(stringResource(R.string.sp_no_mcp), stringResource(R.string.sp_no_mcp_detail)) }
        items(state.mcpServers, key = { "${it.family}:${it.name}" }) { server ->
            SettingsContentCard(Modifier.fillMaxWidth()) {
                AgentoListItem(title = server.name, supportingText = "${server.family} · ${server.detail}", leading = { AgentoWebIcon(AgentoWebGlyph.Terminal, null) }, trailing = { RemoteSettingsAction(stringResource(R.string.sp_delete), { deletingServer = server }, secondary = true) })
            }
        }
    }
    deletingServer?.let { server ->
        RemoteSettingsDialog(
            title = stringResource(R.string.sp_delete_mcp_title),
            confirmLabel = stringResource(R.string.sp_delete),
            confirmModifier = Modifier.testTag("mcp-delete-confirm"),
            dismissLabel = stringResource(R.string.settings_cancel),
            destructive = true,
            onDismiss = { deletingServer = null },
            onConfirm = { deletingServer = null; onEvent(WebParityEvent.DeleteMcpServer(server.family, server.name)) },
        ) { Text(stringResource(R.string.sp_delete_mcp_body, server.name)) }
    }
    if (dialog) RemoteSettingsDialog(
        title = stringResource(R.string.sp_add_mcp),
        confirmLabel = stringResource(R.string.sp_add),
        dismissLabel = stringResource(R.string.settings_cancel),
        onDismiss = { dialog = false },
        onConfirm = { dialog = false; onEvent(WebParityEvent.AddMcpServer(family, name, command)) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
            Text(stringResource(R.string.sp_command_hint), style = MaterialTheme.typography.bodySmall)
            AgentoTextField(family, { family = it.lowercase().takeIf { value -> value == "claude" } ?: "codex" }, stringResource(R.string.sp_runtime_label), Modifier.fillMaxWidth())
            AgentoTextField(name, { name = it }, stringResource(R.string.sp_name), Modifier.fillMaxWidth())
            AgentoTextField(command, { command = it }, stringResource(R.string.sp_command_url), Modifier.fillMaxWidth())
        }
    }
}

internal data class ProviderHarnessChoice(val id: String, val label: String, val protocols: List<String>)

internal fun installedProviderHarnessChoices(harnesses: List<WebHarness>): List<ProviderHarnessChoice> {
    return harnesses.filter { it.installed || it.globallyInstalled }.mapNotNull { harness ->
        // Older instances lack this capability field; retain their known
        // native clients without inventing support for other runtimes.
        val advertised = harness.providerProtocols ?: when (harness.id) {
            "codex" -> listOf("openai-responses", "openai-chat")
            "claude" -> listOf("anthropic-messages")
            "agy" -> listOf("agy")
            else -> emptyList()
        }
        val protocols = advertised.mapNotNull { protocol -> when (protocol) {
            "openai-responses" -> "responses"
            "openai-chat" -> "chat"
            "anthropic-messages" -> "anthropic"
            "github-copilot" -> "github-copilot"
            else -> null
        } }.distinct()
        if (protocols.isEmpty() && !(harness.id == "agy" && "agy" in advertised)) null
        else ProviderHarnessChoice(harness.id, harness.name.ifBlank { harness.id }, protocols)
    }
}

@Composable
private fun ProviderQuotaSection(snapshot: JsonObject) {
    val quota = remember(snapshot) { parseProviderQuota(snapshot) }
    Column(Modifier.fillMaxWidth().testTag("provider-quota"), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Grid)) {
        quota.planName?.let { Text(it, style = MaterialTheme.typography.labelMedium) }
        if (quota.status != "ok") {
            Text(stringResource(if (quota.status == "unsupported") R.string.sp_quota_unsupported else R.string.sp_quota_unavailable), style = MaterialTheme.typography.bodySmall)
        } else if (quota.windows.isEmpty() && quota.balances.isEmpty()) {
            Text(stringResource(R.string.sp_quota_no_data), style = MaterialTheme.typography.bodySmall)
        } else {
            quota.windows.forEach { window ->
                val title = window.label ?: when (window.id) {
                    "five_hour" -> stringResource(R.string.sp_quota_five_hours)
                    "weekly" -> stringResource(R.string.sp_quota_weekly)
                    "monthly" -> stringResource(R.string.sp_quota_monthly)
                    else -> window.id.replace('_', ' ').ifBlank { stringResource(R.string.sp_quota_window) }
                }
                val label = listOfNotNull(window.group, title).distinct().joinToString(" · ")
                val percent = window.remainingPercent ?: return@forEach
                val number = NumberFormat.getNumberInstance().apply { maximumFractionDigits = 1 }.format(percent)
                Text(stringResource(R.string.sp_quota_remaining, label, number), style = MaterialTheme.typography.labelMedium)
                LinearProgressIndicator(progress = { (percent / 100).toFloat() }, modifier = Modifier.fillMaxWidth())
                val reset = window.resetsAt?.let { raw ->
                    runCatching { DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").format(Instant.parse(raw).atZone(ZoneId.systemDefault())) }.getOrNull()
                }
                if (reset != null) Text(stringResource(R.string.sp_quota_resets, reset), style = MaterialTheme.typography.bodySmall)
            }
            quota.balances.forEach { balance ->
                val amount = NumberFormat.getNumberInstance().apply { maximumFractionDigits = 4 }.format(balance.remaining)
                Text(stringResource(R.string.sp_quota_balance, listOfNotNull(amount, balance.currency).joinToString(" ")), style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun ProvidersPage(state: WebParityUiState, onEvent: (WebParityEvent) -> Unit, targetLabel: String?,
    instanceSelector: (@Composable () -> Unit)? = null) {
    val uriHandler = LocalUriHandler.current
    var dialog by remember { mutableStateOf(false) }
    var submitted by remember { mutableStateOf(false) }
    LaunchedEffect(state.actionInProgress, state.error, state.providerSavedTarget) {
        if (submitted && !state.actionInProgress) {
            if (state.error == null || state.providerSavedTarget != null) dialog = false
            submitted = false
        }
    }
    var agentType by remember { mutableStateOf("codex") }
    val restrictedDemo = LocalRestrictedDemoEnvironment.current
    var authMode by remember { mutableStateOf("api-key") }
    var name by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var apiKey by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    var protocol by remember { mutableStateOf("responses") }
    var editingProvider by remember { mutableStateOf<WebProvider?>(null) }
    var deletingProvider by remember { mutableStateOf<WebProvider?>(null) }
    val availableHarnesses = remember(state.harnesses) { installedProviderHarnessChoices(state.harnesses) }
    val clipboard = LocalClipboardManager.current
    LaunchedEffect(state.externalUrl) {
        state.externalUrl?.let { url ->
            state.providerOAuthJob?.takeIf { it.url == url && it.code.isNotBlank() }?.let {
                clipboard.setText(AnnotatedString(it.code))
            }
            runCatching { uriHandler.openUri(url) }.onFailure { onEvent(WebParityEvent.ProviderOAuthBrowserFailed) }
            onEvent(WebParityEvent.ClearExternalUrl)
        }
    }
    Column(Modifier.fillMaxSize().background(LocalAgentocColors.current.surfaceLow)) {
      FlowRow(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp),
          horizontalArrangement = Arrangement.SpaceBetween, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        instanceSelector?.invoke()
        if (!restrictedDemo) {
            RemoteSettingsAction(stringResource(R.string.sp_add_provider), {
                editingProvider = null
                agentType = availableHarnesses.firstOrNull()?.id.orEmpty()
                authMode = if (agentType == "agy") "oauth" else "api-key"
                protocol = availableHarnesses.firstOrNull()?.protocols?.firstOrNull() ?: "chat"
                name = ""; baseUrl = ""; apiKey = ""; model = ""
                dialog = true
            }, leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Plus, null, Modifier.size(18.dp)) })
        }
      }
      LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 80.dp)) {
        state.providerSavedTarget?.let { saved -> item(key = "provider-saved") {
            Text(stringResource(R.string.pi_saved, saved), style = MaterialTheme.typography.bodySmall)
        } }
        if (!restrictedDemo && (state.providers.any { it.agentType == "agy" } || state.providerRotationEnabled || state.providerRotationIds.isNotEmpty())) item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(enabled = LocalRemoteSettingsWritable.current, checked = state.providerRotationEnabled, onCheckedChange = { onEvent(WebParityEvent.ToggleProviderRotation(it)) })
                Text(stringResource(R.string.sp_rotate_provider), style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (state.providers.isEmpty()) {
            item { AgentoEmptyState(stringResource(R.string.sp_none_provider), stringResource(R.string.sp_none_provider_detail)) }
        }
        items(state.providers, key = { it.id }) { provider ->
            val harnessInstalled = state.providerHarnessesLoaded && state.harnesses.any { it.id == provider.agentType && it.installed }
            ManagementSection(Modifier.fillMaxWidth().testTag("provider-card-${provider.id}")) {
                Row(modifier = Modifier.testTag("provider-info-${provider.id}"), horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact), verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Grid)) {
                        Text(provider.name, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        val machineLocal = provider.agentType in setOf("codex", "claude", "agy") && provider.authType in setOf("oauth", "oauth-token")
                        Text(if (machineLocal) stringResource(R.string.settings_provider_scope_local, targetLabel ?: stringResource(R.string.sp_this_computer))
                            else stringResource(R.string.settings_provider_scope_sync),
                            style = MaterialTheme.typography.bodySmall, color = LocalAgentocColors.current.secondaryContent,
                            modifier = Modifier.testTag("provider-scope-${provider.id}"))
                    }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    val status = when {
                        !state.providerHarnessesLoaded -> R.string.sp_provider_harness_unknown
                        !harnessInstalled -> R.string.sp_provider_harness_missing
                        provider.ready -> R.string.sp_ready
                        else -> R.string.sp_credentials_missing
                    }
                    val authLabel = when (provider.authType) {
                        "api-key" -> stringResource(R.string.sp_api_key)
                        "oauth", "oauth-token" -> stringResource(R.string.sp_official_oauth)
                        else -> provider.authType
                    }
                    Text("${providerRuntimeLabel(provider.agentType)} · $authLabel", style = MaterialTheme.typography.bodySmall, maxLines = 2,
                        color = LocalAgentocColors.current.secondaryContent, overflow = TextOverflow.Ellipsis)
                    Text(stringResource(status), style = MaterialTheme.typography.labelSmall,
                        color = if (provider.ready && harnessInstalled) LocalAgentocColors.current.success else LocalAgentocColors.current.secondaryContent)
                }
                if (state.providerHarnessesLoaded && !harnessInstalled && !restrictedDemo && LocalRemoteSettingsWritable.current) {
                    Text(stringResource(R.string.pi_harness_missing), style = MaterialTheme.typography.bodySmall,
                        color = LocalAgentocColors.current.secondaryContent)
                }
                if (provider.baseUrl.isNotBlank()) Text(provider.baseUrl, style = MaterialTheme.typography.bodySmall,
                    color = LocalAgentocColors.current.tertiaryContent, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (provider.quotaSnapshot != null) ProviderQuotaSection(provider.quotaSnapshot)
                else if (provider.quota.isNotBlank()) Text(stringResource(R.string.sp_quota, provider.quota), style = MaterialTheme.typography.labelSmall)
                FlowRow(
                    modifier = Modifier.fillMaxWidth().testTag("provider-actions-${provider.id}"),
                    horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
                    verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
                ) {
                        if (harnessInstalled && (provider.agentType.equals("agy", ignoreCase = true) || provider.id in state.providerRotationIds)) {
                            Checkbox(enabled = LocalRemoteSettingsWritable.current,
                                checked = provider.id in state.providerRotationIds,
                                onCheckedChange = { selected -> onEvent(WebParityEvent.ToggleProviderRotationProvider(provider.id, selected)) },
                            )
                        }
                        if (harnessInstalled) RemoteManagementAction(stringResource(R.string.sp_refresh_quota), { onEvent(WebParityEvent.RefreshProviderQuota(provider.id)) })
                        if (state.harnesses.any { it.id == provider.agentType && it.installed } && !restrictedDemo && provider.authType == "oauth" && provider.agentType in setOf("codex", "agy")) {
                            RemoteManagementAction(stringResource(R.string.provider_oauth_reauthenticate), {
                                onEvent(WebParityEvent.StartProviderOAuth(provider.agentType, provider.name, provider.id))
                            }, secondary = true)
                        }
                        if (!restrictedDemo) RemoteManagementAction(stringResource(R.string.sp_edit), {
                            editingProvider = provider
                            name = provider.name
                            agentType = provider.agentType
                            authMode = provider.authType.ifBlank { "api-key" }
                            baseUrl = provider.baseUrl
                            model = provider.defaultModel
                            protocol = when (provider.protocol) {
                                "openai-responses" -> "responses"
                                "openai-chat" -> "chat"
                                "anthropic-messages" -> "anthropic"
                                else -> provider.protocol.ifBlank { "responses" }
                            }
                            apiKey = ""
                            dialog = true
                        }, modifier = Modifier.testTag("provider-edit-${provider.id}"), emphasized = true)
                        if (!restrictedDemo) RemoteManagementAction(stringResource(R.string.sp_delete), { deletingProvider = provider }, modifier = Modifier.testTag("provider-delete-${provider.id}"))
                }
            }
        }
    }
    }
    deletingProvider?.let { provider ->
        RemoteSettingsDialog(
            title = stringResource(R.string.sp_delete_provider_title),
            confirmLabel = stringResource(R.string.sp_delete),
            dismissLabel = stringResource(R.string.settings_cancel),
            onDismiss = { deletingProvider = null },
            onConfirm = { deletingProvider = null; onEvent(WebParityEvent.DeleteProvider(provider.id)) },
            destructive = true,
            confirmModifier = Modifier.testTag("provider-delete-confirm"),
        ) { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.sp_delete_provider_body, provider.name))
            Text(stringResource(if (provider.machineLocal) R.string.pi_local_change else R.string.pi_shared_delete,
                targetLabel.orEmpty()), style = MaterialTheme.typography.bodySmall)
        } }
    }
    if (dialog) {
        RemoteSettingsDialog(
            title = stringResource(if (editingProvider == null) R.string.sp_add_model_provider else R.string.sp_edit_model_provider),
            confirmLabel = stringResource(if (editingProvider == null && authMode == "oauth") R.string.sp_start_login else R.string.settings_save),
            dismissLabel = stringResource(R.string.settings_cancel),
            onDismiss = {
                if (!state.actionInProgress) {
                    dialog = false
                    editingProvider = null
                }
            },
            confirmModifier = Modifier.testTag("provider-save"),
            onConfirm = {
                val current = editingProvider
                submitted = current != null || authMode != "oauth"
                if (!submitted) dialog = false
                if (current != null) {
                    onEvent(WebParityEvent.UpdateProvider(current.id, name, baseUrl, apiKey, model, protocol, current.enabled))
                } else if (authMode == "oauth") {
                    onEvent(WebParityEvent.StartProviderOAuth(agentType, name))
                } else {
                    onEvent(WebParityEvent.CreateProviderApiKey(agentType, name, baseUrl, apiKey, model, protocol))
                }
            },
            confirmEnabled = !state.actionInProgress && (editingProvider != null || availableHarnesses.any { it.id == agentType }) &&
                (editingProvider != null || authMode != "oauth" || state.harnesses.any { it.id == agentType && it.installed }),
            dismissEnabled = !state.actionInProgress,
        ) {
                Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                    state.error?.let { AgentoErrorText(localizedParityError(it)) }
                    if (editingProvider == null) {
                        Text(stringResource(if (state.providerHarnessesLoaded) R.string.sp_provider_installed_harness_hint else R.string.sp_provider_harness_status_unavailable), style = MaterialTheme.typography.bodySmall)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                            availableHarnesses.forEach { choice ->
                                RemoteSettingsAction(choice.label, {
                                    agentType = choice.id
                                    authMode = if (choice.id == "agy") "oauth" else "api-key"
                                    protocol = choice.protocols.firstOrNull() ?: "chat"
                                }, modifier = Modifier.testTag("provider-harness-${choice.id}"), secondary = agentType != choice.id)
                            }
                        }
                    } else {
                        Text(providerRuntimeLabel(editingProvider?.agentType.orEmpty()), style = MaterialTheme.typography.labelMedium,
                            color = LocalAgentocColors.current.accentPrimary)
                    }
                    Text(stringResource(if (authMode == "api-key") R.string.pi_shared_change else R.string.pi_local_change,
                        targetLabel.orEmpty()), style = MaterialTheme.typography.bodySmall,
                        color = LocalAgentocColors.current.secondaryContent)
                    if (agentType.isNotBlank()) {
                        if (editingProvider == null) Row(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                            if (agentType != "agy") RemoteSettingsAction(stringResource(R.string.sp_api_key), { authMode = "api-key" }, modifier = Modifier.weight(1f), secondary = authMode != "api-key")
                            if ((agentType == "codex" || agentType == "agy") && state.harnesses.any { it.id == agentType && it.installed }) RemoteSettingsAction(stringResource(R.string.sp_official_oauth), { authMode = "oauth" }, modifier = Modifier.weight(1f), secondary = authMode != "oauth")
                        }
                        ManagementField(name, { name = it }, stringResource(R.string.sp_display_name), enabled = !state.actionInProgress, inputModifier = Modifier.testTag("provider-name"))
                        if (authMode == "api-key") {
                            ManagementField(baseUrl, { baseUrl = it }, stringResource(R.string.sp_base_url), enabled = !state.actionInProgress)
                            ManagementField(apiKey, { apiKey = it }, stringResource(R.string.sp_api_key), enabled = !state.actionInProgress)
                            ManagementField(model, { model = it }, stringResource(R.string.sp_default_model), enabled = !state.actionInProgress)
                            val protocols = availableHarnesses.firstOrNull { it.id == agentType }?.protocols.orEmpty()
                            if (protocols.size > 1) {
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                                    protocols.forEach { option ->
                                        val label = when (option) { "responses" -> "Responses"; "chat" -> "Chat"; "anthropic" -> "Anthropic"; else -> "GitHub Copilot" }
                                        RemoteSettingsAction(label, { protocol = option }, secondary = protocol != option)
                                    }
                                }
                            }
                        } else {
                            Text(stringResource(R.string.sp_oauth_hint), style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
        }
    }
    if (!restrictedDemo && !state.providerCrossInstance) ProviderOAuthDialog(state, onEvent)
}

private fun WebParityPage.titleRes(): Int = when (this) {
    WebParityPage.Agents -> R.string.settings_agents_title
    WebParityPage.Connectors -> R.string.settings_connectors_mcp
    WebParityPage.ModelProviders -> R.string.settings_model_providers
    WebParityPage.Harnesses -> R.string.settings_harnesses
    WebParityPage.Devices -> R.string.settings_manage_devices
    WebParityPage.Files -> R.string.settings_workspace_files
    WebParityPage.Triggers -> R.string.settings_scheduled_work
    WebParityPage.Usage -> R.string.settings_usage
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HarnessesPage(
    state: WebParityUiState,
    onEvent: (WebParityEvent) -> Unit,
    targetId: String?,
) {
    val restrictedDemo = LocalRestrictedDemoEnvironment.current
    var dialogOperation by remember { mutableStateOf<WebHarnessOperation?>(null) }
    var dialogHarness by remember { mutableStateOf<WebHarness?>(null) }
    var selectedTargetIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    val targets = state.harnessTargets
    val activeTarget = targets.firstOrNull { it.instanceId == targetId && it.available }
        ?: targets.firstOrNull { it.available }
        ?: targets.firstOrNull()
    val installedIds = activeTarget?.installedHarnessIds
        ?: state.harnesses.filter { it.installed }.mapTo(mutableSetOf()) { it.id }
    val multipleTargets = targets.size > 1

    fun supports(target: WebHarnessTarget, harness: WebHarness) =
        target.supportedHarnessIds?.contains(harness.id) ?: harness.supportedOnPlatform

    fun candidates(harness: WebHarness, operation: WebHarnessOperation) = targets.filter { target ->
        when (operation) {
            WebHarnessOperation.Install -> harness.id !in target.installedHarnessIds
            WebHarnessOperation.Upgrade, WebHarnessOperation.Uninstall -> harness.id in target.installedHarnessIds
        }
    }

    fun eligible(target: WebHarnessTarget, harness: WebHarness, operation: WebHarnessOperation) =
        target.available && (operation == WebHarnessOperation.Uninstall || supports(target, harness))

    fun dispatch(harness: WebHarness, operation: WebHarnessOperation, ids: List<String>) {
        when (operation) {
            WebHarnessOperation.Install -> onEvent(WebParityEvent.InstallHarness(harness.id, ids))
            WebHarnessOperation.Upgrade -> onEvent(WebParityEvent.UpgradeHarness(harness.id, ids))
            WebHarnessOperation.Uninstall -> onEvent(WebParityEvent.UninstallHarness(harness.id, ids))
        }
    }

    fun requestAction(harness: WebHarness, operation: WebHarnessOperation) {
        val eligibleIds = candidates(harness, operation).filter { eligible(it, harness, operation) }
            .map { it.instanceId }.filter(String::isNotBlank).toSet()
        if (eligibleIds.isEmpty()) return
        dialogHarness = harness
        dialogOperation = operation
        selectedTargetIds = eligibleIds
    }

    LazyColumn(modifier = Modifier.fillMaxSize().background(LocalAgentocColors.current.surfaceLow).testTag("harness-catalog"),
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 80.dp)) {
        state.statusMessage?.takeIf(String::isNotBlank)?.let { message ->
            item { AgentoStatus(message, AgentoStatusTone.Success) }
        }
        if (targets.isEmpty()) {
            item { AgentoEmptyState(stringResource(R.string.settings_no_computers), stringResource(R.string.sp_harness_no_computers)) }
        } else if (state.harnesses.isEmpty()) {
            item {
                AgentoEmptyState(
                    stringResource(R.string.sp_harness_unavailable),
                    activeTarget?.detail?.takeIf(String::isNotBlank) ?: stringResource(R.string.sp_connect_refresh),
                )
            }
        }
        items(state.harnesses, key = { it.id }) { harness ->
            val installedCount = targets.count { it.available && harness.id in it.installedHarnessIds }
            val installedOnCurrent = harness.id in installedIds
            val computerLabel = activeTarget?.label?.takeIf(String::isNotBlank) ?: stringResource(R.string.sp_this_computer)
            val targetSummary = if (multipleTargets) {
                stringResource(R.string.settings_harness_installed_count, installedCount)
            } else if (activeTarget?.available != true) {
                stringResource(R.string.settings_harness_unknown)
            } else if (installedOnCurrent) {
                stringResource(R.string.sp_harness_installed_on, computerLabel)
            } else {
                stringResource(R.string.sp_harness_not_installed_on, computerLabel)
            }
            val detail = listOfNotNull(
                targetSummary,
                harness.version.takeIf { it.isNotBlank() && !multipleTargets }?.let { stringResource(R.string.sp_version_value, it) },
                harness.installationSource.takeIf { it.isNotBlank() && !multipleTargets }?.let { stringResource(R.string.sp_source_value, it) },
            ).joinToString(" · ")
            ManagementSection(Modifier.fillMaxWidth()) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                        ManagementIdentity(AgentoWebGlyph.Terminal)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Grid)) {
                            Text(harness.name, style = MaterialTheme.typography.titleSmall)
                            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    targets.forEach { target ->
                        val status = when {
                            !target.available -> R.string.settings_harness_unknown
                            harness.id in target.installedHarnessIds -> R.string.sp_installed
                            !supports(target, harness) -> R.string.sp_unsupported
                            else -> R.string.sp_not_installed
                        }
                        BoxWithConstraints(Modifier.fillMaxWidth().heightIn(min = 40.dp)) {
                            val statusText: @Composable () -> Unit = {
                                Text(stringResource(status), style = MaterialTheme.typography.bodySmall,
                                    color = if (status == R.string.sp_installed) LocalAgentocColors.current.success else LocalAgentocColors.current.secondaryContent,
                                    modifier = Modifier.testTag("harness-target-${harness.id}-${target.instanceId}"))
                            }
                            if (LocalDensity.current.fontScale > 1.3f || maxWidth < 280.dp) {
                                Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text(target.label, style = MaterialTheme.typography.bodyMedium)
                                    statusText()
                                }
                            } else Row(Modifier.fillMaxWidth().heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(target.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                statusText()
                            }
                        }
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Grid), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Grid)) {
                            if (!restrictedDemo && candidates(harness, WebHarnessOperation.Install).isNotEmpty()) {
                                RemoteManagementAction(
                                    stringResource(R.string.sp_install),
                                    { requestAction(harness, WebHarnessOperation.Install) },
                                    enabled = !state.actionInProgress && candidates(harness, WebHarnessOperation.Install).any { eligible(it, harness, WebHarnessOperation.Install) },
                                    emphasized = true,
                                    modifier = Modifier.testTag("harness-install-${harness.id}"),
                                )
                            }
                            if (!restrictedDemo && candidates(harness, WebHarnessOperation.Upgrade).isNotEmpty()) {
                                RemoteManagementAction(
                                    stringResource(R.string.sp_upgrade),
                                    { requestAction(harness, WebHarnessOperation.Upgrade) },
                                    enabled = !state.actionInProgress && candidates(harness, WebHarnessOperation.Upgrade).any { eligible(it, harness, WebHarnessOperation.Upgrade) },
                                    secondary = true,
                                    modifier = Modifier.testTag("harness-upgrade-${harness.id}"),
                                )
                                RemoteManagementAction(
                                    stringResource(R.string.sp_uninstall),
                                    { requestAction(harness, WebHarnessOperation.Uninstall) },
                                    enabled = !state.actionInProgress && candidates(harness, WebHarnessOperation.Uninstall).any { eligible(it, harness, WebHarnessOperation.Uninstall) },
                                    secondary = true,
                                    modifier = Modifier.testTag("harness-uninstall-${harness.id}"),
                                )
                            }
                    }
            }
        }
    }

    val operation = dialogOperation
    val harness = dialogHarness
    if (operation != null && harness != null) {
        val operationLabel = stringResource(when (operation) {
            WebHarnessOperation.Install -> R.string.sp_install
            WebHarnessOperation.Upgrade -> R.string.sp_upgrade
            WebHarnessOperation.Uninstall -> R.string.sp_uninstall
        })
        val candidates = candidates(harness, operation)
        val eligibleSelectedIds = candidates.filter { it.instanceId in selectedTargetIds && eligible(it, harness, operation) }.map { it.instanceId }
        RemoteSettingsDialog(
            title = stringResource(R.string.sp_operation_title, operationLabel, harness.name),
            confirmLabel = operationLabel,
            confirmModifier = Modifier.testTag("harness-operation-confirm"),
            dismissLabel = stringResource(R.string.settings_cancel),
            destructive = operation == WebHarnessOperation.Uninstall,
            onDismiss = {
                if (!state.actionInProgress) {
                    dialogOperation = null
                    dialogHarness = null
                }
            },
            onConfirm = {
                val ids = eligibleSelectedIds
                dialogOperation = null
                dialogHarness = null
                dispatch(harness, operation, ids)
            },
            confirmEnabled = eligibleSelectedIds.isNotEmpty() && !state.actionInProgress,
            dismissEnabled = !state.actionInProgress,
        ) {
                Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Grid)) {
                    if (operation == WebHarnessOperation.Uninstall) Text(stringResource(R.string.sp_harness_info),
                        style = MaterialTheme.typography.bodySmall, color = LocalAgentocColors.current.secondaryContent)
                    Text(
                        stringResource(R.string.settings_harness_select_hint),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    candidates.forEach { target ->
                        Row(
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                                .background(if (target.instanceId in eligibleSelectedIds) LocalAgentocColors.current.accentPrimary.copy(alpha = 0.08f) else Color.Transparent)
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(target.label, style = MaterialTheme.typography.bodyMedium)
                                if (!target.available) Text(stringResource(R.string.settings_harness_unknown), style = MaterialTheme.typography.labelSmall,
                                    color = LocalAgentocColors.current.secondaryContent)
                                else if (!supports(target, harness)) Text(stringResource(R.string.sp_unsupported), style = MaterialTheme.typography.labelSmall,
                                    color = LocalAgentocColors.current.secondaryContent)
                            }
                            Checkbox(enabled = eligible(target, harness, operation) && !state.actionInProgress,
                                modifier = Modifier.testTag("harness-select-${target.instanceId}"),
                                checked = target.instanceId in eligibleSelectedIds,
                                onCheckedChange = { checked ->
                                    selectedTargetIds = if (checked) selectedTargetIds + target.instanceId else selectedTargetIds - target.instanceId
                                },
                            )
                        }
                    }
                }
        }
    }
}

@Composable
private fun DevicesPage(
    state: WebParityUiState,
    onEvent: (WebParityEvent) -> Unit,
    fallbackDevices: List<WebDevice>,
    connectedTargetId: String?,
    targetConnectionStates: Map<String, RuntimeConnectionState>,
    connectingTargetId: String?,
    onConnectComputer: ((String) -> Unit)?,
    onDisconnectComputer: ((String) -> Unit)?,
    onAddComputer: (() -> Unit)?,
) {
    var editingDevice by remember { mutableStateOf<WebDevice?>(null) }
    var revokingDevice by remember { mutableStateOf<WebDevice?>(null) }
    var deviceName by remember { mutableStateOf("") }
    var actionsForDeviceId by remember { mutableStateOf<String?>(null) }
    val devices = if (state.page == WebParityPage.Devices) state.devices else fallbackDevices
    val computers = devices.filter { isComputerDevice(it.platform) }
    LazyColumn(contentPadding = navigationContentPadding(), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
        onAddComputer?.let { addComputer ->
            item(key = "device-add-computer") {
                DeviceSettingsCard(Modifier.fillMaxWidth()) {
                    AgentoListItem(
                        title = stringResource(R.string.settings_add_computer),
                        modifier = Modifier.testTag("settings-add-computer"),
                        leading = {
                            DeviceSettingsIcon(AgentoWebGlyph.Plus)
                        },
                        trailing = { AgentoWebIcon(AgentoWebGlyph.ChevronRight, contentDescription = null) },
                        onClick = addComputer,
                    )
                }
            }
        }
        if (computers.isEmpty()) {
            item {
                DevicesEmptyState()
            }
        } else {
            item(key = "devices-section-label") {
                Text(
                    text = stringResource(R.string.sp_computers),
                    modifier = Modifier.padding(start = AgentocSpacing.Compact, top = AgentocSpacing.Grid),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item(key = "devices-group") {
                DeviceSettingsCard(Modifier.fillMaxWidth()) {
                    BoxWithConstraints {
                    val compact = maxWidth < 360.dp || LocalDensity.current.fontScale > 1.3f
                    Column {
                        computers.forEachIndexed { index, device ->
                            val connection = targetConnectionStates[device.instanceId]
                            val isConnected = connection == RuntimeConnectionState.Connected ||
                                (connection == null && device.instanceId == connectedTargetId)
                            val isConnecting = !isConnected && (device.instanceId == connectingTargetId ||
                                connection == RuntimeConnectionState.Connecting ||
                                connection == RuntimeConnectionState.Reconnecting)
                            val canUseConnection = device.instanceId.isNotBlank() &&
                                device.status.lowercase() != "revoked" &&
                                (onConnectComputer != null || onDisconnectComputer != null)
                            // The list already establishes that these are computers.
                            // Escalate only a transitional or exceptional state.
                            val detail = when {
                                isConnecting -> if (canUseConnection) "" else stringResource(R.string.settings_connecting)
                                device.status.equals("revoked", ignoreCase = true) -> stringResource(R.string.settings_device_revoked)
                                isConnected -> stringResource(R.string.sp_device_connected)
                                canUseConnection -> stringResource(R.string.sp_device_not_connected)
                                else -> ""
                            }
                            val connectionAction: @Composable () -> Unit = {
                                            AgentoButton(
                                                text = when {
                                                    isConnecting -> stringResource(R.string.settings_connecting)
                                                    isConnected -> stringResource(R.string.settings_disconnect)
                                                    else -> stringResource(R.string.settings_connect)
                                                },
                                                onClick = {
                                                    if (isConnected) onDisconnectComputer?.invoke(device.instanceId)
                                                    else onConnectComputer?.invoke(device.instanceId)
                                                },
                                                enabled = !isConnecting,
                                                secondary = true,
                                                secondaryContainerColor = LocalAgentocColors.current.actionPrimary.copy(alpha = 0.22f),
                                                contentPadding = PaddingValues(horizontal = 12.dp),
                                                labelMaxLines = 2,
                                                modifier = Modifier.testTag("settings-device-action-${device.instanceId}"),
                                            )
                            }
                            AgentoListItem(
                                title = device.name,
                                modifier = Modifier.testTag("settings-device-${device.instanceId}"),
                                supportingText = detail.ifBlank { null },
                                leading = {
                                    DeviceSettingsIcon(deviceGlyph(device.platform))
                                },
                                trailing = {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        if (canUseConnection && !compact) connectionAction()
                                        if (device.accountOwned || device.revocable) {
                                            Box {
                                                AgentoToolbarIconButton(
                                                    onClick = { actionsForDeviceId = device.id },
                                                    contentDescription = stringResource(R.string.settings_device_actions, device.name),
                                                    modifier = Modifier.testTag("settings-device-menu-${device.id}"),
                                                ) {
                                                    AgentoWebIcon(AgentoWebGlyph.More, contentDescription = null)
                                                }
                                                AgentoDropdownMenu(
                                                    expanded = actionsForDeviceId == device.id,
                                                    onDismissRequest = { actionsForDeviceId = null },
                                                    opaqueFallback = true,
                                                ) {
                                                    if (device.accountOwned) {
                                                        AgentoDropdownMenuItem(
                                                            text = stringResource(R.string.settings_rename),
                                                            leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Edit, null) },
                                                            modifier = Modifier.testTag("settings-device-rename-${device.id}"),
                                                            onClick = {
                                                                actionsForDeviceId = null
                                                                editingDevice = device
                                                                deviceName = device.name
                                                            },
                                                        )
                                                    }
                                                    if (device.revocable) {
                                                        AgentoDropdownMenuItem(
                                                            text = stringResource(if (device.accountOwned) R.string.settings_unbind else R.string.settings_revoke),
                                                            leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Trash, null) },
                                                            modifier = Modifier.testTag("settings-device-unbind-${device.id}"),
                                                            onClick = {
                                                                actionsForDeviceId = null
                                                                revokingDevice = device
                                                            },
                                                        )
                                                    }
                                                }
                                            }
                                        }
                                    }
                                },
                            )
                            if (canUseConnection && compact) {
                                Row(Modifier.fillMaxWidth().padding(start = 68.dp, end = 16.dp, bottom = 12.dp), horizontalArrangement = Arrangement.End) {
                                    connectionAction()
                                }
                            }
                            if (index < computers.lastIndex) {
                                HorizontalDivider(
                                    modifier = Modifier.padding(start = 68.dp),
                                    thickness = 0.5.dp,
                                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f),
                                )
                            }
                        }
                    }
                    }
                }
            }
        }
    }
    revokingDevice?.let { device ->
        AgentoDialog(
            title = stringResource(if (device.accountOwned) R.string.settings_unbind else R.string.settings_revoke),
            confirmLabel = stringResource(if (device.accountOwned) R.string.settings_unbind else R.string.settings_revoke),
            dismissLabel = stringResource(R.string.settings_cancel),
            destructive = true,
            onDismiss = { revokingDevice = null },
            onConfirm = { revokingDevice = null; onEvent(WebParityEvent.RevokeDevice(device.id)) },
        ) { Text(stringResource(R.string.sp_confirm_remove_device, device.name)) }
    }
    editingDevice?.let { device ->
        AgentoDialog(
            title = stringResource(R.string.settings_rename_device),
            confirmLabel = stringResource(R.string.settings_save),
            onDismiss = { editingDevice = null },
            onConfirm = {
                editingDevice = null
                onEvent(WebParityEvent.RenameDevice(device.id, deviceName))
            },
            confirmEnabled = deviceName.trim().isNotEmpty() && !state.actionInProgress,
        ) {
                AgentoTextField(
                    deviceName,
                    { deviceName = it },
                    stringResource(R.string.settings_device_name),
                    Modifier.fillMaxWidth(),
                )
        }
    }
}

@Composable
private fun DeviceSettingsCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val colors = LocalAgentocColors.current
    val dark = colors.canvas.red < 0.5f
    AgentoFrostedGlassBox(
        modifier = modifier,
        shape = RoundedCornerShape(24.dp),
        surface = AgentoGlassSurface.Neutral,
        material = AgentoGlassMaterial.LiquidClear,
        showTopHairline = true,
        specularBrush = if (dark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
        shadowElevation = 5.dp, shadowAlpha = 0.035f, shadowSpotAlpha = 0.01f,
    ) { content() }
}

@Composable
private fun DeviceSettingsIcon(glyph: AgentoWebGlyph) {
    val colors = LocalAgentocColors.current
    val dark = colors.canvas.red < 0.5f
    Box(Modifier.size(36.dp).clip(RoundedCornerShape(12.dp))
        .background(colors.actionPrimary.copy(alpha = if (dark) 0.16f else 0.09f)),
        contentAlignment = Alignment.Center) {
        AgentoWebIcon(glyph, contentDescription = null, modifier = Modifier.size(19.dp), tint = colors.accentPrimary)
    }
}

@Composable
private fun DevicesEmptyState() {
    val colors = LocalAgentocColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .height(250.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        androidx.compose.material3.Surface(
            modifier = Modifier.size(56.dp),
            shape = com.andysagent.agentoc.core.designsystem.AgentoShapes.SurfaceLargeShape,
            color = colors.navigationSelection,
            contentColor = colors.accentPrimary,
        ) {
            Box(contentAlignment = Alignment.Center) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Monitor,
                    contentDescription = null,
                    modifier = Modifier.size(27.dp),
                    tint = colors.accentPrimary,
                )
            }
        }
        androidx.compose.foundation.layout.Spacer(Modifier.height(16.dp))
        Text(
            text = stringResource(R.string.settings_no_computers),
            style = MaterialTheme.typography.titleLarge,
            color = colors.primaryContent,
        )
    }
}

private fun deviceGlyph(platform: String): AgentoWebGlyph = when (platform.trim().lowercase()) {
    "phone", "android", "mobile", "tablet" -> AgentoWebGlyph.Device
    else -> AgentoWebGlyph.Monitor
}

private fun isComputerDevice(platform: String): Boolean = platform.trim().lowercase() !in setOf(
    "phone",
    "android",
    "mobile",
    "tablet",
)

@Composable
private fun FilesPage(state: WebParityUiState, onEvent: (WebParityEvent) -> Unit) {
    var query by remember { mutableStateOf("") }
    val visibleFiles = state.files.filter { query.isBlank() || it.path.contains(query.trim(), ignoreCase = true) }
    LazyColumn(contentPadding = navigationContentPadding(), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
        item { AgentoTextField(query, { query = it }, stringResource(R.string.sp_search_files), Modifier.fillMaxWidth()) }
        if (state.folderReadInProgress) item { AgentoProgress(modifier = Modifier.size(20.dp)) }
        if (state.fileDirectory.isNotBlank()) item {
            AgentoButton(stringResource(R.string.sp_parent_folder), { onEvent(WebParityEvent.ParentDirectory) }, secondary = true, leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Back, null) })
        }
        if (state.fileDirectory.isNotBlank()) item {
            Text(state.fileDirectory, style = MaterialTheme.typography.titleSmall)
        }
        if (visibleFiles.isEmpty()) item { AgentoEmptyState(stringResource(R.string.sp_no_files), stringResource(R.string.sp_no_files_detail)) }
        items(visibleFiles, key = { it.path }) { file ->
            SettingsContentCard(Modifier.fillMaxWidth()) {
                AgentoListItem(title = file.path, supportingText = if (file.directory) stringResource(R.string.sp_folder) else file.size, leading = { AgentoWebIcon(if (file.directory) AgentoWebGlyph.Folder else AgentoWebGlyph.File, null) }, onClick = { if (file.directory) onEvent(WebParityEvent.OpenDirectory(file.path)) else onEvent(WebParityEvent.OpenFile(file.path)) })
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TriggersPage(state: WebParityUiState, onEvent: (WebParityEvent) -> Unit) {
    var dialog by remember { mutableStateOf(false) }
    var editingTrigger by remember { mutableStateOf<WebTrigger?>(null) }
    var deletingTrigger by remember { mutableStateOf<WebTrigger?>(null) }
    var title by remember { mutableStateOf("") }
    var text by remember { mutableStateOf("") }
    var minutes by remember { mutableStateOf("30") }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f), contentPadding = navigationContentPadding(), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
            if (state.openSessionId.isNullOrBlank()) item {
                AgentoEmptyState(stringResource(R.string.sp_open_session_first), stringResource(R.string.sp_schedule_requires_session))
            }
            if (state.triggers.isEmpty() && !state.openSessionId.isNullOrBlank()) item { AgentoEmptyState(stringResource(R.string.sp_no_scheduled), stringResource(R.string.sp_no_scheduled_detail)) }
            items(state.triggers, key = { it.id }) { trigger ->
                val status = when (trigger.status.lowercase()) {
                    "pending" -> stringResource(R.string.sp_schedule_status_pending)
                    "failed" -> stringResource(R.string.sp_schedule_status_failed)
                    "delivered" -> stringResource(R.string.sp_schedule_status_delivered)
                    else -> trigger.status
                }
                val detail = listOfNotNull(
                    trigger.scheduledAt.takeIf(String::isNotBlank),
                    status.takeIf(String::isNotBlank),
                    trigger.tool.takeIf(String::isNotBlank),
                    trigger.model.takeIf(String::isNotBlank),
                    trigger.deliveryAttempts.takeIf { it > 0 }?.let { stringResource(R.string.sp_attempts, it) },
                    trigger.nextAttemptAt.takeIf(String::isNotBlank)?.let { stringResource(R.string.sp_retry_at, it) },
                    trigger.runId.takeIf(String::isNotBlank)?.let { stringResource(R.string.sp_run_id, it) },
                ).joinToString(" · ")
                val scheduledTitle = stringResource(R.string.sp_scheduled_fallback)
                SettingsContentCard(Modifier.fillMaxWidth()) {
                  Column(Modifier.fillMaxWidth().padding(AgentocSpacing.Standard), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                AgentoListItem(title = trigger.title.ifBlank { scheduledTitle }, supportingText = detail, leading = { AgentoWebIcon(AgentoWebGlyph.Clock, null) }, trailing = { RemoteSettingsAction(stringResource(if (trigger.enabled) R.string.sp_pause else R.string.sp_resume), { onEvent(WebParityEvent.ToggleTrigger(trigger.id, !trigger.enabled)) }, enabled = trigger.status != "delivered", secondary = true) })
                if (trigger.lastError.isNotBlank()) Text(trigger.lastError, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact), modifier = Modifier.fillMaxWidth()) {
                    RemoteSettingsAction(stringResource(R.string.sp_edit), {
                        editingTrigger = trigger
                        title = trigger.title
                        text = trigger.text
                        minutes = "30"
                        dialog = true
                    }, secondary = true)
                    if (trigger.status == "failed") {
                        RemoteSettingsAction(stringResource(R.string.sp_retry), { onEvent(WebParityEvent.RetryTrigger(trigger.id)) }, secondary = true)
                    }
                    RemoteSettingsAction(stringResource(R.string.sp_delete), { deletingTrigger = trigger }, secondary = true)
                }
                  }
                }
            }
        }
        RemoteSettingsAction(stringResource(R.string.sp_schedule_followup), { dialog = true }, enabled = !state.openSessionId.isNullOrBlank(), modifier = Modifier.fillMaxWidth().padding(start = AgentocSpacing.Gutter, end = AgentocSpacing.Gutter).navigationBarsPadding(), leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Plus, null) })
    }
    deletingTrigger?.let { trigger ->
        RemoteSettingsDialog(
            title = stringResource(R.string.sp_delete_scheduled_title),
            confirmLabel = stringResource(R.string.sp_delete),
            confirmModifier = Modifier.testTag("scheduled-delete-confirm"),
            dismissLabel = stringResource(R.string.settings_cancel),
            destructive = true,
            onDismiss = { deletingTrigger = null },
            onConfirm = { deletingTrigger = null; onEvent(WebParityEvent.DeleteTrigger(trigger.id)) },
        ) { Text(stringResource(R.string.sp_delete_scheduled_body, trigger.title.ifBlank { stringResource(R.string.sp_scheduled_fallback) })) }
    }
    if (dialog) RemoteSettingsDialog(
        title = stringResource(if (editingTrigger == null) R.string.sp_schedule_followup else R.string.sp_edit_scheduled),
        confirmLabel = stringResource(R.string.sp_schedule),
        dismissLabel = stringResource(R.string.settings_cancel),
        onDismiss = { dialog = false; editingTrigger = null },
        onConfirm = {
            dialog = false
            val current = editingTrigger
            if (current == null) {
                onEvent(WebParityEvent.CreateTrigger(title, text, minutes, state.openSessionId, state.triggerTool, state.triggerModel, state.triggerEffort, state.triggerThinking))
            } else {
                onEvent(WebParityEvent.UpdateTrigger(current.id, title, text, minutes, state.openSessionId ?: current.sessionId, current.tool.ifBlank { state.triggerTool }, current.model.takeIf(String::isNotBlank), current.effort.takeIf(String::isNotBlank), current.thinking))
            }
            editingTrigger = null
        },
        confirmEnabled = !state.openSessionId.isNullOrBlank() && title.isNotBlank() && text.isNotBlank(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
            AgentoTextField(title, { title = it }, stringResource(R.string.sp_title), Modifier.fillMaxWidth())
            AgentoTextField(text, { text = it }, stringResource(R.string.sp_message), Modifier.fillMaxWidth())
            AgentoTextField(minutes, { minutes = it }, stringResource(R.string.sp_minutes), Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun TextPage(text: String) {
    LazyColumn(contentPadding = navigationContentPadding()) { item { Text(text, style = MaterialTheme.typography.bodyMedium) } }
}

@Composable
private fun UsagePage(usage: JsonObject?) {
    val totals = usage?.get("totals")?.jsonObject
    val sections = listOf(
        stringResource(R.string.sp_by_day) to usage?.get("byDay")?.jsonArray,
        stringResource(R.string.sp_by_session) to usage?.get("bySession")?.jsonArray,
        stringResource(R.string.sp_by_model) to usage?.get("byModel")?.jsonArray,
    )
    LazyColumn(contentPadding = navigationContentPadding(), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
        if (usage == null) {
            item { AgentoEmptyState(stringResource(R.string.sp_usage_unavailable), stringResource(R.string.sp_usage_unavailable_detail)) }
            return@LazyColumn
        }
        item {
          SettingsContentCard(Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(AgentocSpacing.Standard), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
            Text(stringResource(R.string.sp_last_days, usage["window"]?.jsonObject?.get("days")?.jsonPrimitive?.contentOrNull ?: "7"), style = MaterialTheme.typography.titleMedium)
            Text(
                listOfNotNull(
                    totals?.get("runCount")?.let { stringResource(R.string.sp_runs, usageDisplay(it)) },
                    totals?.get("inputTokens")?.let { stringResource(R.string.sp_input_tokens, usageDisplay(it)) },
                    totals?.get("outputTokens")?.let { stringResource(R.string.sp_output_tokens, usageDisplay(it)) },
                    totals?.get("totalTokens")?.let { stringResource(R.string.sp_total_tokens, usageDisplay(it)) },
                    totals?.get("costUsd")?.let { stringResource(R.string.sp_cost, usageDisplay(it)) },
                ).joinToString(" · "),
                style = MaterialTheme.typography.bodyMedium,
            )
            }
          }
        }
        sections.forEach { (title, values) ->
            if (!values.isNullOrEmpty()) {
                item { Text(title, style = MaterialTheme.typography.titleSmall) }
                items(values, key = { value -> "$title:${value.hashCode()}" }) { value ->
                    val row = value.jsonObject
                    val unknownLabel = stringResource(R.string.sp_unknown)
                    val label = row["label"]?.jsonPrimitive?.contentOrNull
                        ?: row["sessionName"]?.jsonPrimitive?.contentOrNull
                        ?: row["day"]?.jsonPrimitive?.contentOrNull
                        ?: unknownLabel
                    SettingsContentCard(Modifier.fillMaxWidth()) {
                        Text(
                            stringResource(R.string.sp_usage_row, label, row["runCount"]?.let(::usageDisplay) ?: "0", row["totalTokens"]?.let(::usageDisplay) ?: "0"),
                            modifier = Modifier.padding(AgentocSpacing.Standard),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }
    }
}

private fun usageDisplay(value: kotlinx.serialization.json.JsonElement): String =
    value.jsonPrimitive.contentOrNull ?: value.toString()

// Settings detail pages cover the primary dock, so content only needs to
// clear the system navigation bar plus a breathing gap — not the dock.
@Composable
private fun navigationContentPadding() = PaddingValues(
    start = AgentocSpacing.Gutter,
    top = AgentocSpacing.Gutter,
    end = AgentocSpacing.Gutter,
    bottom = com.andysagent.agentoc.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateBottomPadding() + AgentocSpacing.Block,
)

private fun WebParityPage.icon(): AgentoWebGlyph = when (this) {
    WebParityPage.Agents -> AgentoWebGlyph.Agent
    WebParityPage.Connectors -> AgentoWebGlyph.Share
    WebParityPage.ModelProviders -> AgentoWebGlyph.Terminal
    WebParityPage.Harnesses -> AgentoWebGlyph.Terminal
    WebParityPage.Devices -> AgentoWebGlyph.Monitor
    WebParityPage.Files -> AgentoWebGlyph.File
    WebParityPage.Triggers -> AgentoWebGlyph.Clock
    WebParityPage.Usage -> AgentoWebGlyph.Info
}
