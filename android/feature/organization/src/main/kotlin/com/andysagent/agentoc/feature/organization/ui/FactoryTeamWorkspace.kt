package com.andysagent.agentoc.feature.organization.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalContext
import com.andysagent.agentoc.feature.organization.R
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.andysagent.agentoc.core.designsystem.*
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.feature.organization.data.FactoryWorkflowRepository
import com.andysagent.agentoc.feature.organization.data.OrganizationNodeDto
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

private fun JsonObject.str(key: String): String = (this[key] as? JsonPrimitive)?.contentOrNull.orEmpty()
private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
private fun JsonObject.arr(key: String): List<JsonObject> = (this[key] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
private fun JsonObject.num(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull

@Composable
private fun workStateLabel(state: String): String = when (state) {
    "proposed" -> stringResource(R.string.factory_state_proposed)
    "ready" -> stringResource(R.string.factory_state_ready)
    "claimed" -> stringResource(R.string.factory_state_claimed)
    "running" -> stringResource(R.string.factory_state_running)
    "blocked" -> stringResource(R.string.factory_state_blocked)
    "review" -> stringResource(R.string.factory_state_review)
    "completed" -> stringResource(R.string.factory_state_completed)
    "failed" -> stringResource(R.string.factory_state_failed)
    "cancelled" -> stringResource(R.string.factory_state_cancelled)
    else -> state.ifBlank { stringResource(R.string.factory_state_unknown) }
}

@Composable
private fun controlStateLabel(state: String): String = when (state) {
    "", "none" -> ""
    "pause_requested" -> stringResource(R.string.factory_control_pause_requested)
    "paused" -> stringResource(R.string.factory_control_paused)
    "cancel_requested" -> stringResource(R.string.factory_control_cancel_requested)
    else -> state
}


/** Owner workflow; advanced controls remain available in the existing workspace. */
@Composable
fun FactoryTeamWorkspace(
    transport: AgentoCTransport, organizationId: String, nodes: List<OrganizationNodeDto>,
    responsibilityDraft: String, selectedResponsibilityId: String?, onResponsibilitySelected: (String?) -> Unit,
    sessionId: String, rootSessionId: String?, stableAccountScope: Boolean, onBack: () -> Unit,
) {
    val repo = remember(transport, organizationId) { FactoryWorkflowRepository(transport, organizationId) }
    val scope = rememberCoroutineScope()
    val appContext = LocalContext.current
    val colors = LocalAgentocColors.current
    var page by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("list") }
    var items by remember(organizationId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var goals by remember(organizationId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selected by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var selectedId by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var error by remember(organizationId) { mutableStateOf<String?>(null) }
    var notice by remember(organizationId) { mutableStateOf<String?>(null) }
    var loading by remember(organizationId) { mutableStateOf(false) }
    var workCursor by remember(organizationId) { mutableStateOf<String?>(null) }
    var goalCursor by remember(organizationId) { mutableStateOf<String?>(null) }
    var pending by rememberSaveable(organizationId, rootSessionId) { mutableStateOf<String?>(null) }
    var project by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var sessionProject by remember(organizationId, rootSessionId) { mutableStateOf("") }
    var goalText by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var goalId by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var nodeId by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var objective by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var criterion by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var tokens by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var cost by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var rationale by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var reviewDecision by remember(organizationId) { mutableStateOf<String?>(null) }
    var criterionIdSelected by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var approvalReview by remember(organizationId) { mutableStateOf(false) }
    var authorizedVersion by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }

    suspend fun refresh() {
        if (loading) return
        loading = true
        try {
            val work = repo.listWorkItems()
            val goalResponse = repo.listGoals()
            items = work.arr("items")
            goals = goalResponse.arr("items")
            workCursor = work.str("nextCursor").takeIf { it.isNotBlank() && it != "null" }
            goalCursor = goalResponse.str("nextCursor").takeIf { it.isNotBlank() && it != "null" }
            error = null
        } catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { error = e.message ?: appContext.getString(R.string.factory_team_refresh_error) }
        finally { loading = false }
    }
    suspend fun open(id: String) {
        if (loading) return
        loading = true
        try { selected = repo.getWorkItem(id).obj("item") ?: throw IllegalStateException(appContext.getString(R.string.factory_team_load_work)); if (selectedId != id) criterionIdSelected = ""; selectedId = id; error = null; page = "detail"; approvalReview = false; reviewDecision = null }
        catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { error = e.message ?: appContext.getString(R.string.factory_team_load_work) }
        finally { loading = false }
    }
    suspend fun send(checkOnly: Boolean = false) {
        val action = pending?.let { Json.parseToJsonElement(it) as? JsonObject } ?: return
        val key = action.str("key")
        val args = action.obj("args") ?: return
        loading = true
        val result = try { if (checkOnly) repo.getCommand(key) else when (action.str("type")) {
            "goal" -> repo.createGoal(key,key,args.str("project"),args.str("objective"))
            "proposal" -> repo.createReadOnlyWork(key,key,args.str("goal"),args.str("node"),args.str("project"),args.str("objective"),args.str("criterion"),args.num("tokens") ?: 0,args.str("cost").toDouble())
            "authorization" -> repo.authorizeReport(key,key,args.str("item"),args.num("version") ?: -1)
            "approval" -> repo.approveContract(key,key,args.str("item"),args.num("version") ?: -1)
            "decision" -> repo.decideManual(key,key,args.str("item"),args.num("version") ?: -1,args.num("revision") ?: -1,args.num("gate") ?: -1,args.str("candidate"),args.str("criterion"),args.str("decision"),args.str("reason"))
            else -> throw IllegalStateException("Unknown saved request")
        } }
        catch (cancel: CancellationException) { loading = false; throw cancel }
        catch (e: Exception) {
            if (!checkOnly && e is ApiException && e.statusCode == 409) {
                pending = null
                authorizedVersion = ""
                error = appContext.getString(R.string.factory_team_version_conflict)
            } else error = appContext.getString(R.string.factory_team_request_uncertain, e.message ?: appContext.getString(R.string.factory_team_connection_error))
            loading = false
            return
        }
        if (result.obj("operation")?.str("state") != "completed") {
            loading = false
            error = appContext.getString(R.string.factory_team_unknown_outcome)
            return
        }
        pending = null; error = null
        if (action.str("type") == "authorization") authorizedVersion = "${args.str("item")}:${args.num("version")}"
        notice = appContext.getString(R.string.factory_team_recorded)
        try {
            val resultItem = result.obj("item")
            val resultGoal = result.obj("goal")
            if (resultGoal != null) { goals = (goals + resultGoal).distinctBy { it.str("id") }; goalId = resultGoal.str("id"); project = resultGoal.str("projectId"); page = "createWork" }
            else if (resultItem != null) { selected = resultItem; selectedId = resultItem.str("id"); page = "detail"; selected = repo.getWorkItem(resultItem.str("id")).obj("item") ?: resultItem }
            else selected?.str("id")?.takeIf { it.isNotBlank() }?.let { selected = repo.getWorkItem(it).obj("item") ?: selected }
        } catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { error = appContext.getString(R.string.factory_team_refresh_failed, e.message ?: appContext.getString(R.string.factory_team_connection_error)) }
        finally { loading = false }
    }
    fun prepare(label: String, args: JsonObject) {
        if (pending != null || loading) return
        val id = UUID.randomUUID().toString()
        pending = buildJsonObject { put("type", label); put("key", id); put("args", args) }.toString()
        scope.launch { send() }
    }
    fun back() {
        when (page) {
            "list" -> onBack()
            "advanced" -> page = "list"
            "confirmWork" -> page = "createWork"
            "detail" -> { selected = null; selectedId = ""; page = "list" }
            else -> page = "list"
        }
    }
    BackHandler(enabled = page != "list") { if (!loading) back() }
    LaunchedEffect(repo, rootSessionId) {
        refresh()
        if (!rootSessionId.isNullOrBlank()) try { sessionProject = repo.getSessionProject(rootSessionId).orEmpty() }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { sessionProject = "" }
        if (page == "detail" && selectedId.isNotBlank()) open(selectedId)
    }
    val listState = rememberLazyListState()

    val animation = when (LocalMotionPolicy.current.preference) {
        MotionPreference.None -> snap()
        MotionPreference.Reduced -> tween<Float>(120)
        else -> AgentoMotion.AppleSpring
    }
    Crossfade(targetState = page, animationSpec = animation, label = "team-workspace") { screen ->
        if (screen == "advanced") {
            FactoryWorkScreen(transport, organizationId, responsibilityDraft, selectedResponsibilityId, onResponsibilitySelected, sessionId, onBack = { page = "list" })
        } else Column(Modifier.fillMaxSize().background(colors.canvas)) {
            AgentoTopBar(title = when (screen) { "list" -> stringResource(R.string.factory_team_00); "detail" -> stringResource(R.string.factory_team_01); "createGoal" -> stringResource(R.string.factory_team_02); "confirmWork" -> stringResource(R.string.factory_team_03); else -> stringResource(R.string.factory_team_04) },
                subtitle = stringResource(R.string.factory_team_05), navigationIcon = { TextButton(enabled = !loading, onClick = { back() }) { Text(stringResource(R.string.factory_team_06)) } })
            error?.let { Text(it, color = colors.error, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) }
            notice?.let { Text(it, color = colors.secondaryContent, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) }
            if (pending != null) Column(Modifier.padding(horizontal = 20.dp)) {
                Text(stringResource(R.string.factory_team_pending_identity, (Json.parseToJsonElement(pending!!) as? JsonObject)?.str("key").orEmpty()), color = colors.secondaryContent)
                if (!stableAccountScope) Text(stringResource(R.string.factory_team_pending_scope_warning), color = colors.secondaryContent)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AgentoButton(stringResource(R.string.factory_team_retry), onClick = { scope.launch { send() } }, enabled = !loading, secondary = true)
                if ((Json.parseToJsonElement(pending!!) as? JsonObject)?.str("type") != "authorization") {
                    AgentoButton(stringResource(R.string.factory_team_check_status), onClick = { scope.launch { send(checkOnly = true) } }, enabled = !loading, secondary = true)
                }
                }
            }
            when (screen) {
                "list" -> LazyColumn(state = listState, contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item { Text(stringResource(R.string.factory_team_07), color = colors.secondaryContent) }
                    item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        AgentoButton(stringResource(R.string.factory_team_04), onClick = { page = "createWork" }, enabled = pending == null)
                        AgentoButton(stringResource(R.string.factory_team_08), onClick = { scope.launch { refresh() } }, enabled = !loading, secondary = true)
                    } }
                    if (items.isEmpty()) item { Text(stringResource(if (loading) R.string.factory_team_09 else R.string.factory_team_10), color = colors.secondaryContent) }
                    items(items, key = { it.str("id") }) { work ->
                        AgentoCard(Modifier.fillMaxWidth(), onClick = { scope.launch { open(work.str("id")) } }) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(work.obj("contract")?.str("objective").orEmpty().ifBlank { "Work item" }, fontWeight = FontWeight.SemiBold, color = colors.primaryContent, maxLines = 3, overflow = TextOverflow.Ellipsis)
                                val control = controlStateLabel(work.str("controlState"))
                                Text(listOf(workStateLabel(work.str("state")), control).filter { it.isNotBlank() }.joinToString(" · "), color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                    if (workCursor != null) item { TextButton(enabled = !loading, onClick = { scope.launch {
                        loading = true
                        try { val response = repo.listWorkItems(workCursor); items = (items + response.arr("items")).distinctBy { it.str("id") }; workCursor = response.str("nextCursor").takeIf { it.isNotBlank() && it != "null" } }
                        catch (cancel: CancellationException) { throw cancel }
                        catch (e: Exception) { error = e.message ?: appContext.getString(R.string.factory_team_load_more_error) }
                        finally { loading = false }
                    } }) { Text(stringResource(R.string.factory_team_11)) } }
                    item { TextButton(enabled = pending == null, onClick = { page = "advanced" }) { Text(stringResource(R.string.factory_team_12)) } }
                }
                "createGoal" -> Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.factory_team_13), color = colors.secondaryContent)
                    Text(stringResource(R.string.factory_team_project, project), color = colors.secondaryContent)
                    OutlinedTextField(goalText, { goalText = it }, label = { Text(stringResource(R.string.factory_team_14)) }, modifier = Modifier.fillMaxWidth())
                    AgentoButton(stringResource(R.string.factory_team_15), enabled = project.isNotBlank() && goalText.isNotBlank() && pending == null && !loading, onClick = {
                        val p = project.trim(); val g = goalText.trim(); prepare("goal", buildJsonObject { put("project",p); put("objective",g) })
                    })
                }
                "createWork" -> Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.factory_team_16), color = colors.secondaryContent)
                    Text(stringResource(R.string.factory_team_14), fontWeight = FontWeight.SemiBold)
                    goals.forEach { goal -> AgentoRowSurface(selected = goalId == goal.str("id"), onClick = { goalId = goal.str("id"); project = goal.str("projectId") }, modifier = Modifier.fillMaxWidth()) {
                        Text(goal.obj("body")?.str("objective")?.ifBlank { goal.str("id") } ?: goal.str("objective").ifBlank { goal.str("id") }, Modifier.padding(12.dp), color = colors.primaryContent)
                    } }
                    if (goalCursor != null) TextButton(enabled = !loading, onClick = { scope.launch {
                        loading = true
                        try { val response = repo.listGoals(goalCursor); goals = (goals + response.arr("items")).distinctBy { it.str("id") }; goalCursor = response.str("nextCursor").takeIf { it.isNotBlank() && it != "null" } }
                        catch (cancel: CancellationException) { throw cancel }
                        catch (e: Exception) { error = e.message ?: appContext.getString(R.string.factory_team_load_more_error) }
                        finally { loading = false }
                    } }) { Text(stringResource(R.string.factory_team_17)) }
                    TextButton(enabled = sessionProject.isNotBlank() && (project.isBlank() || project == sessionProject), onClick = { project = sessionProject; page = "createGoal" }) { Text(stringResource(R.string.factory_team_18)) }
                    Text(stringResource(R.string.factory_team_19), fontWeight = FontWeight.SemiBold)
                    Text(stringResource(R.string.factory_team_reviewer), color = colors.secondaryContent)
                    nodes.filter { it.role.equals("reviewer", ignoreCase = true) && !it.sessionId.isNullOrBlank() && it.status.lowercase() !in setOf("retired", "inactive") }.forEach { node -> AgentoRowSurface(selected = nodeId == node.id, onClick = { nodeId = node.id }, modifier = Modifier.fillMaxWidth()) {
                        Text("${node.displayName.ifBlank { node.id }} · ${node.role} · ${node.status}", Modifier.padding(12.dp), color = colors.primaryContent)
                    } }
                    OutlinedTextField(objective, { objective = it }, label = { Text(stringResource(R.string.factory_team_20)) }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(criterion, { criterion = it }, label = { Text(stringResource(R.string.factory_team_21)) }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(tokens, { tokens = it }, label = { Text(stringResource(R.string.factory_team_22)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    OutlinedTextField(cost, { cost = it }, label = { Text(stringResource(R.string.factory_team_23)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                    AgentoButton(stringResource(R.string.factory_team_03), enabled = goalId.isNotBlank() && project.isNotBlank() && nodeId.isNotBlank() && objective.isNotBlank() && criterion.isNotBlank() && (tokens.toLongOrNull()?.let { it in 1..9_007_199_254_740_991L } == true) && (cost.toDoubleOrNull()?.let { it.isFinite() && it > 0 } == true) && pending == null, onClick = { page = "confirmWork" })
                }
                "confirmWork" -> Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(objective, style = MaterialTheme.typography.titleMedium, color = colors.primaryContent)
                    Text(stringResource(R.string.factory_team_assigned, nodes.find { it.id == nodeId }?.displayName?.ifBlank { nodeId } ?: nodeId))
                    Text(stringResource(R.string.factory_team_criterion, criterion))
                    Text(stringResource(R.string.factory_team_scope, tokens, cost), color = colors.secondaryContent)
                    Text(stringResource(R.string.factory_team_36), color = colors.secondaryContent)
                    AgentoButton(stringResource(R.string.factory_team_25), enabled = pending == null && !loading, onClick = {
                        val g=goalId; val n=nodeId; val p=project; val o=objective; val c=criterion; val t=tokens.toLong(); val amount=cost.toDouble()
                        prepare("proposal", buildJsonObject { put("goal",g); put("node",n); put("project",p); put("objective",o); put("criterion",c); put("tokens",t); put("cost",amount.toString()) })
                    })
                }
                "detail" -> selected?.let { work ->
                    val id = work.str("id"); val contract = work.obj("contract"); val candidate = work.str("candidateDigest")
                    val version = work.num("rowVersion"); val rev = work.num("contractRevision"); val gate = work.num("gateGeneration")
                    val resource = contract?.obj("resource")
                    val reportType = contract != null && resource != null && contract.str("accessMode") == "read" && (contract["allowedPaths"] as? JsonArray)?.isEmpty() == true &&
                        resource.str("readScope") == "entire_project" && resource.str("networkPolicy") == "inherit_existing_permissions" &&
                        resource.str("projectId") == work.str("projectId") && contract.arr("acceptanceCriteria").isNotEmpty() &&
                        contract.arr("acceptanceCriteria").all { it.str("method") == "manual" }
                    Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(contract?.str("objective").orEmpty(), style = MaterialTheme.typography.titleMedium)
                        val control = controlStateLabel(work.str("controlState"))
                        Text(listOf(workStateLabel(work.str("state")), control).filter { it.isNotBlank() }.joinToString(" · "), color = colors.secondaryContent)
                        contract?.arr("acceptanceCriteria")?.forEach { c -> Text(stringResource(R.string.factory_team_review_criterion, c.str("description").ifBlank { c.str("id") })) }
                        TextButton(onClick = { scope.launch { open(id) } }) { Text(stringResource(R.string.factory_team_26)) }
                        if (!reportType) Text(stringResource(R.string.factory_team_advanced_type), color = colors.secondaryContent)
                        if (reportType && work.str("state") == "proposed" && version != null) {
                            Text(stringResource(R.string.factory_team_35), color = colors.secondaryContent)
                            AgentoButton(stringResource(R.string.factory_team_27), enabled = pending == null && !loading, secondary = true, onClick = { prepare("authorization", buildJsonObject { put("item",id); put("version",version) }) })
                            AgentoButton(stringResource(R.string.factory_team_28), enabled = pending == null && !loading && authorizedVersion == "$id:$version", onClick = { approvalReview = true })
                            if (approvalReview) {
                                Text(stringResource(R.string.factory_team_34))
                                Text(stringResource(R.string.factory_team_member, nodes.find { it.id == work.str("assigneeNodeId") }?.displayName?.ifBlank { work.str("assigneeNodeId") } ?: work.str("assigneeNodeId")))
                                Text(stringResource(R.string.factory_team_reserve, contract?.obj("budgetReservation")?.str("tokens").orEmpty(), contract?.obj("budgetReservation")?.str("cost").orEmpty()))
                                AgentoButton(stringResource(R.string.factory_team_29), enabled = pending == null && !loading, onClick = { approvalReview = false; prepare("approval", buildJsonObject { put("item",id); put("version",version) }) })
                            }
                        }
                        val report = work.arr("candidates").lastOrNull { it.str("digest") == candidate && it.num("contractRevision") == rev && it.num("executionEpoch") == work.num("executionEpoch") && it.num("bindingGeneration") == work.num("bindingGeneration") }?.obj("report")
                        if (report != null) {
                            Text(stringResource(R.string.factory_team_30), style = MaterialTheme.typography.titleMedium)
                            Text(report.str("visibleText").ifBlank { report.obj("declaration")?.str("summary").orEmpty().ifBlank { appContext.getString(R.string.factory_team_report_empty) } })
                            Text(stringResource(R.string.factory_team_declaration, report.obj("declaration")?.str("state").orEmpty().ifBlank { report.obj("declaration")?.str("status").orEmpty() }), color = colors.secondaryContent)
                            val declaration = report.obj("declaration")
                            listOf("blockers", "risks").forEach { field ->
                                (declaration?.get(field) as? JsonArray)?.forEach { fact ->
                                    val value = (fact as? JsonPrimitive)?.contentOrNull
                                    if (!value.isNullOrBlank()) Text(stringResource(if (field == "blockers") R.string.factory_team_blockers else R.string.factory_team_risks) + ": " + value, color = colors.secondaryContent)
                                }
                            }
                        } else if (reportType && work.str("state") == "review") Text(stringResource(R.string.factory_team_report_empty), color = colors.secondaryContent)
                        work.arr("decisions").forEach {
                            val current = it.str("candidateDigest") == candidate && it.num("contractRevision") == rev && it.num("gateGeneration") == gate
                            Text(stringResource(R.string.factory_team_decision, it.str("decision"), it.str("criterionId")) + if (current) " · " + stringResource(R.string.factory_team_current) else " · " + stringResource(R.string.factory_team_historical))
                        }
                        val manualCriteria = contract?.arr("acceptanceCriteria")?.filter { it.str("method") == "manual" }.orEmpty()
                        val manual = manualCriteria.firstOrNull { it.str("id") == criterionIdSelected }
                        val reportReadable = report != null && report.str("source") == "persisted_assistant_final" && (report["readable"] as? JsonPrimitive)?.booleanOrNull == true
                        if (reportType && reportReadable && work.str("state") == "review" && candidate.isNotBlank() && version != null && rev != null && gate != null && manualCriteria.isNotEmpty()) {
                            manualCriteria.forEach { criterionEntry -> AgentoRowSurface(selected = criterionIdSelected == criterionEntry.str("id"), onClick = { criterionIdSelected = criterionEntry.str("id"); reviewDecision = null }, modifier = Modifier.fillMaxWidth()) {
                                Text(criterionEntry.str("description").ifBlank { criterionEntry.str("id") }, Modifier.padding(12.dp))
                            } }
                            OutlinedTextField(rationale, { rationale = it }, label = { Text(stringResource(R.string.factory_team_31)) }, modifier = Modifier.fillMaxWidth())
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                AgentoButton(stringResource(R.string.factory_team_32), onClick = { reviewDecision = "passed" }, enabled = pending == null && manual != null, secondary = true)
                                AgentoButton(stringResource(R.string.factory_team_33), onClick = { reviewDecision = "failed" }, enabled = pending == null && manual != null, secondary = true)
                            }
                            reviewDecision?.let { decision ->
                                val decisionLabel = stringResource(if (decision == "passed") R.string.factory_team_pass else R.string.factory_team_fail)
                                Text(stringResource(R.string.factory_team_confirm_decision, decisionLabel))
                                AgentoButton(stringResource(R.string.factory_team_confirm_button, decisionLabel), enabled = manual != null && rationale.isNotBlank() && rationale.length <= 4096 && pending == null && !loading, onClick = {
                                    val reason = rationale; val criterionId = manual?.str("id").orEmpty(); reviewDecision = null
                                    prepare("decision", buildJsonObject { put("item",id); put("version",version); put("revision",rev); put("gate",gate); put("candidate",candidate); put("criterion",criterionId); put("decision",decision); put("reason",reason) })
                                })
                            }
                        }
                    }
                }
            }
        }
    }
}
