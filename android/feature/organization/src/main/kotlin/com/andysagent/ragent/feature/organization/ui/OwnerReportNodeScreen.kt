package com.andysagent.ragent.feature.organization.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.*
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.data.FactoryWorkflowRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull.orEmpty()
private fun JsonObject.objects(key: String) = (this[key] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
private fun JsonObject.strings(key: String) = (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

/** Owner preview and provisioning; this screen never starts a Run. */
@Composable
fun OwnerReportNodeScreen(repo: FactoryWorkflowRepository, organizationId: String, projectId: String, stableAccountScope: Boolean, pending: String, onPendingChange: (String) -> Boolean, bindPending: String, onBindPendingChange: (String) -> Boolean, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val colors = LocalRagentColors.current
    var catalog by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var models by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var agentId by rememberSaveable(organizationId, projectId) { mutableStateOf("") }
    var provider by rememberSaveable(organizationId, projectId) { mutableStateOf("") }
    var model by rememberSaveable(organizationId, projectId) { mutableStateOf("") }
    var effort by rememberSaveable(organizationId, projectId) { mutableStateOf("") }
    var tokenLimit by rememberSaveable(organizationId, projectId) { mutableStateOf("") }
    var costLimit by rememberSaveable(organizationId, projectId) { mutableStateOf("") }
    var previewInput by remember(organizationId, projectId) { mutableStateOf<JsonObject?>(null) }
    var previewDigest by remember(organizationId, projectId) { mutableStateOf("") }
    var previewResult by remember(organizationId, projectId) { mutableStateOf<JsonObject?>(null) }
    var resultState by rememberSaveable(organizationId, projectId) { mutableStateOf("") }
    var scopeState by rememberSaveable(organizationId, projectId) { mutableStateOf("") }
    var scopeNodeId by rememberSaveable(organizationId, projectId) { mutableStateOf("") }
    var responsibilities by remember(organizationId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selectedResponsibility by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var bindConfirm by remember { mutableStateOf(false) }
    var status by remember(organizationId, projectId) { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf(false) }
    val loadingText = stringResource(R.string.owner_node_loading)
    val unknownText = stringResource(R.string.owner_node_unknown)
    val conflictText = stringResource(R.string.owner_node_reload_required)
    val mismatchText = stringResource(R.string.owner_node_scope_mismatch)

    suspend fun refresh() {
        if (busy) return
        busy = true; status = loadingText
        try {
            val c = repo.ownerReportNodeCatalog()
            if (c.text("organizationId") != organizationId || projectId.isBlank() || c.text("projectId") != projectId) throw IllegalStateException(mismatchText)
            val m = repo.codexModels()
            catalog = c; models = m; status = ""
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { catalog = null; models = null; status = e.message ?: unknownText }
        finally { busy = false }
    }
    suspend fun checkReceipt() {
        val body = runCatching { Json.parseToJsonElement(pending) as JsonObject }.getOrNull() ?: return
        busy = true
        try {
            val result = repo.ownerReportNodeOperation(body.text("commandId"))
            val state = result.text("state").ifBlank { (result["operation"] as? JsonObject)?.text("state").orEmpty() }
            resultState = state
            scopeState = (result["scope"] as? JsonObject)?.text("state").orEmpty()
            scopeNodeId = result.text("nodeId")
            if (scopeState == "ready" && bindPending.isNotBlank()) onBindPendingChange("")
            status = if (state.isBlank()) unknownText else state
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { status = e.message ?: unknownText }
        finally { busy = false }
    }
    suspend fun commit(request: String = pending) {
        val body = runCatching { Json.parseToJsonElement(request) as JsonObject }.getOrNull() ?: return
        busy = true
        try {
            val result = repo.commitOwnerReportNode(body)
            val state = result.text("state").ifBlank { (result["operation"] as? JsonObject)?.text("state").orEmpty() }
            resultState = state
            scopeState = (result["scope"] as? JsonObject)?.text("state").orEmpty()
            scopeNodeId = result.text("nodeId")
            if (scopeState == "ready" && bindPending.isNotBlank()) onBindPendingChange("")
            status = if (state.isBlank()) unknownText else state
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { status = e.message ?: unknownText }
        finally { busy = false }
    }
    suspend fun bindScope(request: String = bindPending) {
        val body = runCatching { Json.parseToJsonElement(request) as JsonObject }.getOrNull() ?: return
        busy = true
        try {
            val result = repo.bindOwnerReportScope(body)
            if (result.text("state") == "ready") { scopeState = "ready"; onBindPendingChange(""); status = "" }
            else status = unknownText
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { status = e.message ?: unknownText }
        finally { busy = false }
    }
    LaunchedEffect(repo, projectId) { refresh() }
    BackHandler { onBack() }
    val agents = catalog?.objects("agents").orEmpty().filter { it.text("agentId").isNotBlank() && it.strings("capabilities").containsAll(listOf("read", "run")) }
    val available = models?.objects("catalogs").orEmpty().filter { it.text("status") == "fresh" && it.text("providerProfileId").isNotBlank() }
    val selectedCatalog = available.firstOrNull { it.text("providerProfileId") == provider }
    val availableModels = selectedCatalog?.objects("models").orEmpty().filter { it.text("model").isNotBlank() }
    val efforts = models?.strings("effortLevels").orEmpty()
    val support = catalog?.get("readOnlySupport") as? JsonObject
    val readOnlyAvailable = (support?.get("available") as? JsonPrimitive)?.booleanOrNull == true
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        AgentoTopBar(title = stringResource(R.string.owner_node_title), navigationIcon = { TextButton(onClick = onBack) { Text(stringResource(R.string.owner_node_back)) } })
        Text(stringResource(R.string.owner_node_intro), color = colors.secondaryContent)
        if (!stableAccountScope) Text(stringResource(R.string.owner_node_owner_required), color = colors.error)
        if (!readOnlyAvailable) Text(stringResource(R.string.owner_node_readonly_unavailable), color = colors.error)
        if (status.isNotBlank()) Text(status, color = colors.secondaryContent)
        if (pending.isNotBlank()) {
            Text(when (resultState) { "completed" -> stringResource(R.string.owner_node_completed, scopeState.ifBlank { unknownText }); "cancelled" -> stringResource(R.string.owner_node_cancelled); else -> stringResource(R.string.owner_node_pending) }, color = colors.secondaryContent)
            if (scopeState == "ready") Text(stringResource(R.string.owner_node_scope_ready), color = colors.secondaryContent)
            if (bindPending.isNotBlank()) {
                Text(stringResource(R.string.owner_node_bind_pending), color = colors.secondaryContent)
                AgentoButton(stringResource(R.string.owner_node_bind_retry), onClick = { scope.launch { bindScope() } }, enabled = !busy && stableAccountScope, secondary = true)
            } else if (resultState == "completed" && scopeState == "awaiting_responsibility") {
                Text(stringResource(R.string.owner_node_bind_explainer), color = colors.secondaryContent)
                TextButton(enabled = !busy, onClick = { scope.launch {
                    busy = true
                    try { responsibilities = repo.listOwnerResponsibilities().objects("responsibilities").filter { it.text("projectId") == projectId && it.text("organizationId") == organizationId && it.text("lifecycle") in listOf("draft", "active") }; status = "" }
                    catch (e: CancellationException) { throw e } catch (e: Exception) { status = e.message ?: unknownText }
                    finally { busy = false }
                } }) { Text(stringResource(R.string.owner_node_list_responsibilities)) }
                responsibilities.forEach { responsibility -> TextButton(enabled = !busy, onClick = { scope.launch {
                    busy = true
                    try { selectedResponsibility = repo.ownerResponsibility(responsibility.text("id")); status = "" }
                    catch (e: CancellationException) { throw e } catch (e: Exception) { status = e.message ?: unknownText }
                    finally { busy = false }
                } }) { Text(responsibility.text("objective")) } }
                val selected = selectedResponsibility?.get("responsibility") as? JsonObject
                val policy = selectedResponsibility?.get("policy") as? JsonObject
                if (selected != null && policy != null) {
                    Text(stringResource(R.string.owner_node_bind_review, selected.text("objective"), policy.toString()), color = colors.secondaryContent)
                    AgentoButton(stringResource(R.string.owner_node_bind_action), enabled = !busy && stableAccountScope && scopeNodeId.isNotBlank() && selected.text("projectId") == projectId && selected.text("organizationId") == organizationId, onClick = { bindConfirm = true }, secondary = true)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AgentoButton(stringResource(R.string.owner_node_check), onClick = { scope.launch { checkReceipt() } }, enabled = !busy, secondary = true)
                if (resultState != "completed" && resultState != "cancelled") AgentoButton(stringResource(R.string.owner_node_retry), onClick = { scope.launch { commit() } }, enabled = !busy && stableAccountScope, secondary = true)
            }
        } else {
            Text(stringResource(R.string.owner_node_choose_agent))
            if (agents.isEmpty()) Text(stringResource(R.string.owner_node_no_agents))
            agents.forEach { agent -> Row(Modifier.fillMaxWidth()) { RadioButton(selected = agentId == agent.text("agentId"), onClick = { agentId = agent.text("agentId"); previewDigest = "" }); Text(agent.text("name").ifBlank { agent.text("agentId") }, Modifier.padding(top = 12.dp)) } }
            Text(stringResource(R.string.owner_node_choose_provider))
            if (available.isEmpty()) Text(stringResource(R.string.owner_node_no_models))
            available.forEach { entry -> Row(Modifier.fillMaxWidth()) { RadioButton(selected = provider == entry.text("providerProfileId"), onClick = { provider = entry.text("providerProfileId"); model = ""; previewDigest = "" }); Text(entry.text("providerProfileId"), Modifier.padding(top = 12.dp)) } }
            Text(stringResource(R.string.owner_node_choose_model))
            availableModels.forEach { entry -> Row(Modifier.fillMaxWidth()) { RadioButton(selected = model == entry.text("model"), onClick = { model = entry.text("model"); previewDigest = "" }); Text(entry.text("label").ifBlank { entry.text("model") }, Modifier.padding(top = 12.dp)) } }
            Text(stringResource(R.string.owner_node_choose_effort))
            efforts.forEach { value -> Row(Modifier.fillMaxWidth()) { RadioButton(selected = effort == value, onClick = { effort = value; previewDigest = "" }); Text(value, Modifier.padding(top = 12.dp)) } }
            Text(stringResource(R.string.owner_node_budget), color = colors.secondaryContent)
            AgentoTextField(value = tokenLimit, onValueChange = { tokenLimit = it; previewDigest = ""; previewInput = null }, label = stringResource(R.string.owner_node_tokens), singleLine = true, showLabelWhenFilled = true)
            AgentoTextField(value = costLimit, onValueChange = { costLimit = it; previewDigest = ""; previewInput = null }, label = stringResource(R.string.owner_node_cost), singleLine = true, showLabelWhenFilled = true)
            AgentoButton(stringResource(R.string.owner_node_preview), enabled = !busy && stableAccountScope && readOnlyAvailable && agents.any { it.text("agentId") == agentId } && selectedCatalog != null && availableModels.any { it.text("model") == model } && effort in efforts, onClick = {
                val revision = (catalog?.get("revision") as? JsonPrimitive)?.intOrNull
                if (revision == null) { status = conflictText; return@AgentoButton }
                val tokens = tokenLimit.toLongOrNull(); val cost = costLimit.toDoubleOrNull()
                if (tokens == null || tokens < 1 || tokens > 9007199254740991L || cost == null || !cost.isFinite() || cost <= 0) { status = conflictText; return@AgentoButton }
                val body = buildJsonObject {
                    put("projectId", projectId); put("expectedRevision", revision); put("agentId", agentId)
                    put("runtime", buildJsonObject { put("tool", "codex"); put("provider", provider); put("model", model); put("effort", effort) })
                    put("budget", buildJsonObject { put("maxTotalRuns", 1); put("maxConcurrent", 1); put("maxTokens", tokens); put("maxCost", cost) })
                }
                scope.launch {
                    busy = true
                    try {
                        val result = repo.previewOwnerReportNode(body)
                        val runtime = result["runtime"] as? JsonObject; val budget = result["budget"] as? JsonObject
                        val valid = result.text("organizationId") == organizationId && result.text("projectId") == projectId &&
                            (result["revision"] as? JsonPrimitive)?.intOrNull == revision && result.text("agentId") == agentId &&
                            runtime == body["runtime"] && (budget?.get("maxTotalRuns") as? JsonPrimitive)?.intOrNull == 1 &&
                            (budget?.get("maxConcurrent") as? JsonPrimitive)?.intOrNull == 1 &&
                            (budget?.get("maxTokens") as? JsonPrimitive)?.longOrNull == tokens &&
                            (budget?.get("maxCost") as? JsonPrimitive)?.doubleOrNull == cost &&
                            ((result["readOnlySupport"] as? JsonObject)?.get("available") as? JsonPrimitive)?.booleanOrNull == true &&
                            result.text("previewDigest").matches(Regex("[a-f0-9]{64}"))
                        if (!valid) throw IllegalStateException(mismatchText)
                        previewDigest = result.text("previewDigest"); previewInput = body; previewResult = result; status = ""
                    }
                    catch (e: CancellationException) { throw e } catch (e: Exception) { previewInput = null; previewDigest = ""; status = e.message ?: unknownText }
                    finally { busy = false }
                }
            })
            if (previewInput != null && previewDigest.isNotBlank()) {
                Text(stringResource(R.string.owner_node_preview_details, (previewResult?.get("readOnlySupport") as? JsonObject)?.text("enforcement").orEmpty().ifBlank { unknownText }, previewResult?.get("existingBudget")?.toString() ?: unknownText, previewResult?.get("proposedBudget")?.toString() ?: unknownText, previewResult?.get("ledger")?.toString() ?: unknownText), color = colors.secondaryContent)
                AgentoButton(stringResource(R.string.owner_node_review), onClick = { confirm = true }, enabled = !busy && stableAccountScope)
            }
            TextButton(onClick = { scope.launch { refresh() } }, enabled = !busy) { Text(stringResource(R.string.owner_node_refresh)) }
        }
    }
    if (bindConfirm && selectedResponsibility != null) {
        val selected = selectedResponsibility?.get("responsibility") as? JsonObject
        AlertDialog(onDismissRequest = { bindConfirm = false }, title = { Text(stringResource(R.string.owner_node_bind_action)) },
            text = { Text(stringResource(R.string.owner_node_bind_confirm, selected?.text("objective").orEmpty())) },
            confirmButton = { TextButton(onClick = {
                val version = (selected?.get("rowVersion") as? JsonPrimitive)?.longOrNull
                if (selected == null || version == null) { status = conflictText; bindConfirm = false }
                else {
                    val commandId = UUID.randomUUID().toString()
                    val request = buildJsonObject { put("confirmed", true); put("commandId", commandId); put("idempotencyKey", commandId); put("responsibilityId", selected.text("id")); put("expectedVersion", version) }.toString()
                    if (onBindPendingChange(request)) { bindConfirm = false; scope.launch { bindScope(request) } }
                    else { status = unknownText; bindConfirm = false }
                }
            }) { Text(stringResource(R.string.owner_node_confirm_action)) } }, dismissButton = { TextButton(onClick = { bindConfirm = false }) { Text(stringResource(R.string.owner_node_cancel)) } })
    }
    if (confirm && previewInput != null) AlertDialog(onDismissRequest = { confirm = false }, title = { Text(stringResource(R.string.owner_node_title)) }, text = { Text(stringResource(R.string.owner_node_confirm, projectId, agents.firstOrNull { it.text("agentId") == agentId }?.text("name").orEmpty().ifBlank { agentId }, provider, model, effort, tokenLimit, costLimit)) }, confirmButton = { TextButton(onClick = {
        val commandId = UUID.randomUUID().toString()
        val request = buildJsonObject { previewInput!!.forEach { (key, value) -> put(key, value) }; put("previewDigest", previewDigest); put("commandId", commandId); put("idempotencyKey", commandId); put("confirmed", true) }.toString()
        if (onPendingChange(request)) { confirm = false; scope.launch { commit(request) } }
        else { status = unknownText; confirm = false }
    }) { Text(stringResource(R.string.owner_node_confirm_action)) } }, dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.owner_node_cancel)) } })
}
