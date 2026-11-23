package com.andysagent.ragent.feature.organization.ui

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
import com.andysagent.ragent.feature.organization.R
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.ragent.core.designsystem.*
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.feature.organization.data.FactoryWorkflowRepository
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.RealButlerRepository
import com.andysagent.ragent.feature.organization.presentation.ButlerViewModel
import com.andysagent.ragent.feature.organization.voice.AndroidSpeechRecognizerAsrAdapter
import com.andysagent.ragent.feature.organization.voice.AndroidTextToSpeechAdapter
import com.andysagent.ragent.feature.organization.voice.resolveButlerDeviceIdentity
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
    "waiting" -> stringResource(R.string.factory_ux_waiting)
    "blocked" -> stringResource(R.string.factory_state_blocked)
    "review" -> stringResource(R.string.factory_state_review)
    "completed" -> stringResource(R.string.factory_state_completed)
    "failed" -> stringResource(R.string.factory_state_failed)
    "cancelled" -> stringResource(R.string.factory_state_cancelled)
    else -> stringResource(R.string.factory_state_unknown)
}

@Composable
private fun controlStateLabel(state: String): String = when (state) {
    "", "none" -> ""
    "pause_requested" -> stringResource(R.string.factory_control_pause_requested)
    "paused" -> stringResource(R.string.factory_control_paused)
    "cancel_requested" -> stringResource(R.string.factory_control_cancel_requested)
    else -> stringResource(R.string.factory_state_unknown)
}

/** Owner workflow; advanced controls remain available in the existing workspace. */
@Composable
fun FactoryTeamWorkspace(
    transport: RagentTransport, organizationId: String, nodes: List<OrganizationNodeDto>,
    responsibilityDraft: String, selectedResponsibilityId: String?, onResponsibilitySelected: (String?) -> Unit,
    responsibilityNavigationKey: String? = null, selectedPlanId: String? = null,
    sessionId: String, rootSessionId: String?, stableAccountScope: Boolean, ownerScopeKey: String, onBack: () -> Unit,
    onOpenSourceSession: ((String) -> Unit)? = null,
) {
    val repo = remember(transport, organizationId) { FactoryWorkflowRepository(transport, organizationId) }
    val scope = rememberCoroutineScope()
    val appContext = LocalContext.current
    val colors = LocalRagentColors.current
    val butlerFactory = remember(transport, appContext) {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return ButlerViewModel(
                    repository = RealButlerRepository(transport),
                    asrAdapter = AndroidSpeechRecognizerAsrAdapter(appContext),
                    ttsAdapter = AndroidTextToSpeechAdapter(appContext),
                    deviceIdentity = resolveButlerDeviceIdentity(appContext),
                ) as T
            }
        }
    }
    val butlerViewModel: ButlerViewModel = viewModel(
        key = "butler:$organizationId:$sessionId:${rootSessionId.orEmpty()}",
        factory = butlerFactory,
    )
    val butlerState by butlerViewModel.uiState.collectAsState()
    LaunchedEffect(butlerViewModel, organizationId, rootSessionId, sessionId) {
        butlerViewModel.initialize(organizationId, rootSessionId ?: sessionId)
    }
    var focusedPlanFromButler by rememberSaveable(organizationId, rootSessionId) { mutableStateOf<String?>(null) }
    var page by rememberSaveable(organizationId, rootSessionId) { mutableStateOf(if (selectedResponsibilityId != null) "advanced" else "butler") }
    LaunchedEffect(selectedResponsibilityId, responsibilityNavigationKey) {
        if (selectedResponsibilityId != null) page = "advanced"
    }
    var items by remember(organizationId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var goals by remember(organizationId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var goalsLoaded by remember(organizationId) { mutableStateOf(false) }
    var selected by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var handoff by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var reconciliation by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var budgetFacts by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    // Request bodies contain no credentials. Persist before sending so process
    // death cannot silently create a second command under a new key.
    val ownerRequestStore = remember(appContext) { appContext.getSharedPreferences("owner_report_setup_requests", android.content.Context.MODE_PRIVATE) }
    val ownerRequestKey = remember(ownerScopeKey, organizationId) { "${ownerScopeKey}:${organizationId}" }
    var ownerNodePending by remember(ownerRequestKey) { mutableStateOf(if (stableAccountScope) ownerRequestStore.getString("$ownerRequestKey:setup", "").orEmpty() else "") }
    var ownerBindPending by remember(ownerRequestKey) { mutableStateOf(if (stableAccountScope) ownerRequestStore.getString("$ownerRequestKey:bind", "").orEmpty() else "") }
    var pendingHandoff by rememberSaveable(organizationId, rootSessionId) { mutableStateOf<String?>(null) }
    var selectedId by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var queuedWorkId by remember(organizationId) { mutableStateOf<String?>(null) }
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
    var criterion by rememberSaveable(organizationId, rootSessionId) { mutableStateOf(appContext.getString(R.string.factory_ux_default_criterion)) }
    var attempts by rememberSaveable(organizationId, rootSessionId) { mutableIntStateOf(1) }
    var tokens by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var cost by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var rationale by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var reviewDecision by remember(organizationId) { mutableStateOf<String?>(null) }
    var criterionIdSelected by rememberSaveable(organizationId, rootSessionId) { mutableStateOf("") }
    var approvalReview by remember(organizationId) { mutableStateOf(false) }
    var settingsOpen by rememberSaveable(organizationId, rootSessionId) { mutableStateOf(false) }
    var technicalOpen by rememberSaveable(organizationId, rootSessionId) { mutableStateOf(false) }
    var nodeChoiceConfirmed by rememberSaveable(organizationId, rootSessionId) { mutableStateOf(false) }
    var startSettings by rememberSaveable(organizationId, rootSessionId) { mutableStateOf(false) }
    var needsRefresh by rememberSaveable(organizationId, rootSessionId) { mutableStateOf(false) }

    suspend fun refresh() {
        if (loading) return
        loading = true
        try {
        try {
            val work = repo.listWorkItems()
            val goalResponse = repo.listGoals()
            items = work.arr("items")
            goals = goalResponse.arr("items")
            goalsLoaded = true
            workCursor = work.str("nextCursor").takeIf { it.isNotBlank() && it != "null" }
            goalCursor = goalResponse.str("nextCursor").takeIf { it.isNotBlank() && it != "null" }
            error = null
        } catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { goalsLoaded = false; error = e.message ?: appContext.getString(R.string.factory_team_refresh_error) }
        if (!rootSessionId.isNullOrBlank()) try { sessionProject = repo.getSessionProject(rootSessionId).orEmpty() }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { sessionProject = "" }
        } finally { loading = false }
    }
    suspend fun open(id: String) {
        if (loading) return
        loading = true
        try {
            val loaded = repo.getWorkItem(id).obj("item") ?: throw IllegalStateException(appContext.getString(R.string.factory_team_load_work))
            if (selectedId != id) { handoff = null; criterionIdSelected = ""; tokens = ""; cost = ""; startSettings = false }
            selected = loaded; selectedId = id; error = null; needsRefresh = false; page = "detail"; approvalReview = false; reviewDecision = null
            reconciliation = try { repo.getReconciliation(id) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
            budgetFacts = try { repo.getBudget(id) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        } catch (cancel: CancellationException) { throw cancel }
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
            "proposal" -> repo.createReadOnlyWork(key,key,args.str("goal"),args.str("node"),args.str("project"),args.str("objective"),args.str("criterion"), (args.num("attempts") ?: 1).toInt())
            "budget" -> repo.amendReportBudget(key,key,args.str("item"),args.num("version") ?: -1,args.obj("contract") ?: throw IllegalStateException("Missing saved contract"),args.num("tokens") ?: 0,args.str("cost").toDouble())
            "authorization" -> repo.authorizeReport(key,key,args.str("item"),args.num("version") ?: -1)
            "retry" -> repo.retryWork(key,key,args.str("item"),args.num("version") ?: -1)
            "approval" -> repo.approveContract(key,key,args.str("item"),args.num("version") ?: -1)
            "decision" -> repo.decideManual(key,key,args.str("item"),args.num("version") ?: -1,args.num("revision") ?: -1,args.num("gate") ?: -1,args.str("candidate"),args.str("criterion"),args.str("decision"),args.str("reason"),args.str("packetId"),args.str("packetDigest"),args["targets"] as? JsonArray)
            else -> throw IllegalStateException("Unknown saved request")
        } }
        catch (cancel: CancellationException) { loading = false; throw cancel }
        catch (e: Exception) {
            if (!checkOnly && e is ApiException && e.statusCode == 409) {
                pending = null
                needsRefresh = true
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
        error = null
        val nextDraft = action.obj("next")
        if (action.str("type") == "authorization" && nextDraft != null) {
            if (result.str("scope") != "owner_read_only_report" || result.num("contractRevision") != args.num("revision") || result.num("executionEpoch") != args.num("epoch")) {
                loading = false; error = appContext.getString(R.string.factory_team_unknown_outcome); return
            }
            pending = nextDraft.toString()
            loading = false; send(); return
        }
        if (action.str("type") == "goal" && nextDraft != null) {
            val savedGoal = result.obj("goal")
            if (savedGoal == null || savedGoal.str("id").isBlank() || savedGoal.str("projectId") != args.str("project")) {
                loading = false; error = appContext.getString(R.string.factory_team_unknown_outcome); return
            }
            val nextArgs = buildJsonObject { nextDraft.obj("args")?.forEach { (k,v) -> put(k,v) }; put("goal",savedGoal.str("id")) }
            pending = buildJsonObject { put("type","proposal"); put("key",nextDraft.str("key")); put("args",nextArgs) }.toString()
            goals = (goals + savedGoal).distinctBy { it.str("id") }; goalId = savedGoal.str("id"); project = savedGoal.str("projectId")
            loading = false; send(); return
        }
        pending = null
        reconciliation = null; budgetFacts = null
        if (action.str("type") == "budget") { startSettings = false; tokens = ""; cost = "" }
        notice = appContext.getString(R.string.factory_team_recorded)
        try {
            val resultItem = result.obj("item")
            val resultGoal = result.obj("goal")
            if (resultGoal != null) { goals = (goals + resultGoal).distinctBy { it.str("id") }; goalId = resultGoal.str("id"); project = resultGoal.str("projectId"); page = "createWork" }
            else if (resultItem != null) { selected = resultItem; selectedId = resultItem.str("id"); page = "detail"; needsRefresh = true; selected = repo.getWorkItem(resultItem.str("id")).obj("item") ?: throw IllegalStateException(appContext.getString(R.string.factory_team_load_work)); needsRefresh = false }
            else selected?.str("id")?.takeIf { it.isNotBlank() }?.let { needsRefresh = true; selected = repo.getWorkItem(it).obj("item") ?: throw IllegalStateException(appContext.getString(R.string.factory_team_load_work)); needsRefresh = false }
        } catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { error = appContext.getString(R.string.factory_team_refresh_failed, e.message ?: appContext.getString(R.string.factory_team_connection_error)) }
        finally { loading = false }
    }
    suspend fun sendHandoff() {
        val action = pendingHandoff?.let { Json.parseToJsonElement(it) as? JsonObject } ?: return
        loading = true
        try {
            handoff = repo.createHandoff(action.str("item"), action.num("version") ?: error("Missing version"), action.str("key"))
            pendingHandoff = null
            error = null
        } catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) {
            if (e is ApiException && e.statusCode == 409) { pendingHandoff = null; needsRefresh = true; error = appContext.getString(R.string.factory_team_version_conflict) }
            else error = appContext.getString(R.string.factory_team_request_uncertain, e.message ?: appContext.getString(R.string.factory_team_connection_error))
        } finally { loading = false }
    }
    fun prepare(label: String, args: JsonObject) {
        if (pending != null || loading) return
        val id = UUID.randomUUID().toString()
        pending = buildJsonObject { put("type", label); put("key", id); put("args", args) }.toString()
        scope.launch { send() }
    }
    fun back() {
        when (page) {
            "butler" -> onBack()
            "list" -> page = "butler"
            "advanced" -> { focusedPlanFromButler = null; page = "butler" }
            "detail" -> { selected = null; selectedId = ""; page = "list" }
            else -> page = "list"
        }
    }
    BackHandler(enabled = page != "butler") { if (!loading) back() }
    LaunchedEffect(queuedWorkId, loading) {
        val target = queuedWorkId
        if (!loading && target != null) { queuedWorkId = null; open(target) }
    }
    LaunchedEffect(repo, rootSessionId) {
        refresh()
        if (page == "detail" && selectedId.isNotBlank()) open(selectedId)
    }
    val eligibleNodes = remember(nodes) { nodes.filter { it.role.equals("reviewer", ignoreCase = true) && !it.sessionId.isNullOrBlank() && it.status.lowercase() !in setOf("retired", "inactive") } }
    LaunchedEffect(eligibleNodes) { if (nodeId.isBlank() && eligibleNodes.size == 1) nodeId = eligibleNodes.single().id }
    LaunchedEffect(goals, sessionProject) {
        val active = goals.filter { it.str("state") == "active" && it.str("projectId") == sessionProject }
        if (goalId.isBlank() && goalCursor == null && active.size == 1) { goalId = active.single().str("id"); project = sessionProject }
    }
    val listState = rememberLazyListState()
    fun saveDraft() {
        if (objective.isBlank() || !goalsLoaded || sessionProject.isBlank() || pending != null || loading) return
        if (eligibleNodes.none { it.id == nodeId } || (eligibleNodes.size > 1 && !nodeChoiceConfirmed)) { nodeId = ""; nodeChoiceConfirmed = false; page = "createWork"; return }
        val review = criterion.trim().ifEmpty { appContext.getString(R.string.factory_ux_default_criterion) }
        val draftArgs = buildJsonObject { put("node",nodeId); put("project",sessionProject); put("objective",objective.trim()); put("criterion",review); put("attempts",attempts) }
        val eligibleGoals = goals.filter { it.str("state") == "active" && it.str("projectId") == sessionProject }
        val selectedGoal = eligibleGoals.firstOrNull { it.str("id") == goalId }
        if ((goalCursor != null || eligibleGoals.size > 1) && selectedGoal == null) { page = "createWork"; return }
        val chosen = selectedGoal?.str("id") ?: eligibleGoals.singleOrNull()?.str("id").orEmpty()
        if (chosen.isNotBlank()) {
            prepare("proposal", buildJsonObject { draftArgs.forEach { (k,v) -> put(k,v) }; put("goal",chosen) })
        } else {
            val draft = buildJsonObject { put("key",UUID.randomUUID().toString()); put("args",draftArgs) }
            pending = buildJsonObject { put("type","goal"); put("key",UUID.randomUUID().toString()); put("args",buildJsonObject { put("project",sessionProject); put("objective",objective.trim()) }); put("next",draft) }.toString()
            scope.launch { send() }
        }
    }

    val animation = when (LocalMotionPolicy.current.preference) {
        MotionPreference.None -> snap()
        MotionPreference.Reduced -> tween<Float>(120)
        else -> AgentoMotion.AppleSpring
    }
    Box(Modifier.fillMaxSize()) {
    Crossfade(targetState = page, animationSpec = animation, label = "team-workspace") { screen ->
        if (screen == "butler") {
            ButlerOverviewScreen(
                uiState = butlerState,
                onBack = onBack,
                onRefresh = butlerViewModel::refreshOverview,
                onSelectFilter = butlerViewModel::setFilter,
                onOpenVoiceButler = { rid, title ->
                    butlerViewModel.openVoiceButler(responsibilityId = rid, responsibilityTitle = title)
                },
                onOpenApproval = butlerViewModel::openApprovalFromOverviewItem,
                onOpenResponsibilityDetails = { rid, pid ->
                    focusedPlanFromButler = pid
                    onResponsibilitySelected(rid)
                    page = "advanced"
                },
                onOpenLegacyReports = { page = "list" },
                onOpenOwnerReportNode = { page = "ownerNode" },
                onOpenAllResponsibilities = {
                    focusedPlanFromButler = null
                    onResponsibilitySelected(null)
                    page = "advanced"
                },
            )
        } else if (screen == "ownerNode") {
            OwnerReportNodeScreen(repo, organizationId, sessionProject, stableAccountScope, ownerNodePending, { value ->
                val saved = stableAccountScope && ownerRequestStore.edit().putString("$ownerRequestKey:setup", value).commit()
                if (saved) ownerNodePending = value
                saved
            }, ownerBindPending, { value ->
                val saved = stableAccountScope && ownerRequestStore.edit().putString("$ownerRequestKey:bind", value).commit()
                if (saved) ownerBindPending = value
                saved
            }) { page = "butler" }
        } else if (screen == "advanced") {
            FactoryWorkScreen(
                transport = transport,
                organizationId = organizationId,
                responsibilityDraft = responsibilityDraft,
                selectedResponsibilityId = selectedResponsibilityId,
                onResponsibilitySelected = onResponsibilitySelected,
                responsibilityNavigationKey = responsibilityNavigationKey,
                selectedPlanId = focusedPlanFromButler ?: selectedPlanId,
                nodes = nodes,
                availableProjectId = sessionProject,
                sessionId = sessionId,
                onOpenVoiceButler = { rid, title ->
                    butlerViewModel.openVoiceButler(responsibilityId = rid, responsibilityTitle = title)
                },
                onOpenWorkItem = { id -> queuedWorkId = id },
                onBack = { focusedPlanFromButler = null; page = "butler" },
            )
        } else Column(Modifier.fillMaxSize().background(colors.canvas)) {
            AgentoTopBar(title = when (screen) { "list" -> stringResource(R.string.factory_team_00); "detail" -> stringResource(R.string.factory_team_01); "createGoal" -> stringResource(R.string.factory_team_02); else -> stringResource(R.string.factory_team_04) },
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
                    item { Text(stringResource(R.string.factory_ux_subtitle), color = colors.secondaryContent) }
                    item { OutlinedTextField(objective, { objective = it }, label = { Text(stringResource(R.string.factory_ux_question)) }, modifier = Modifier.fillMaxWidth(), minLines = 2) }
                    if (eligibleNodes.size == 1) item { Text(stringResource(R.string.factory_team_assigned, eligibleNodes.single().displayName.ifBlank { eligibleNodes.single().id }), color = colors.secondaryContent) }
                    item { Text(stringResource(R.string.factory_review_attempts_note), color = colors.secondaryContent)
                        Row { TextButton(onClick = { attempts = 1 }) { Text(stringResource(R.string.factory_review_attempts_one) + if (attempts == 1) " ✓" else "") }
                            TextButton(onClick = { attempts = 2 }) { Text(stringResource(R.string.factory_review_attempts_two) + if (attempts == 2) " ✓" else "") } }
                    }
                    item { TextButton(onClick = { settingsOpen = !settingsOpen }) { Text(stringResource(R.string.factory_ux_review_settings)) }
                        if (settingsOpen) OutlinedTextField(criterion, { criterion = it }, label = { Text(stringResource(R.string.factory_ux_criterion)) }, modifier = Modifier.fillMaxWidth()) }
                    item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        AgentoButton(stringResource(R.string.factory_ux_save), onClick = { if (nodeId.isBlank() || sessionProject.isBlank()) page = "createWork" else saveDraft() }, enabled = pending == null && !loading && goalsLoaded && objective.isNotBlank())
                        AgentoButton(stringResource(R.string.factory_team_08), onClick = { scope.launch { refresh() } }, enabled = !loading, secondary = true)
                    } }
                    item { Text(stringResource(R.string.factory_ux_save_note), color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall) }
                    if (!loading && sessionProject.isBlank()) item { Text(stringResource(R.string.factory_ux_project_unavailable), color = colors.secondaryContent) }
                    if (!loading && eligibleNodes.isEmpty()) item { Text(stringResource(R.string.factory_ux_no_person), color = colors.secondaryContent) }
                    if (items.isEmpty()) item { Text(stringResource(if (loading) R.string.factory_team_09 else R.string.factory_team_10), color = colors.secondaryContent) }
                    items(items, key = { it.str("id") }) { work ->
                        RagentCard(Modifier.fillMaxWidth(), onClick = { scope.launch { open(work.str("id")) } }) {
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
                    Text(stringResource(R.string.factory_ux_choose_note), color = colors.secondaryContent)
                    if (goalCursor != null || goals.count { it.str("state") == "active" && it.str("projectId") == sessionProject } > 1) Text(stringResource(R.string.factory_ux_choose_plan), fontWeight = FontWeight.SemiBold)
                    goals.filter { it.str("state") == "active" && it.str("projectId") == sessionProject }.takeIf { goalCursor != null || it.size > 1 }?.forEach { goal -> AgentoRowSurface(selected = goalId == goal.str("id"), onClick = { goalId = goal.str("id"); project = goal.str("projectId") }, modifier = Modifier.fillMaxWidth()) {
                        Text(goal.obj("body")?.str("objective")?.ifBlank { goal.str("id") } ?: goal.str("objective").ifBlank { goal.str("id") }, Modifier.padding(12.dp), color = colors.primaryContent)
                    } }
                    if (goalCursor != null) TextButton(enabled = !loading, onClick = { scope.launch {
                        loading = true
                        try { val response = repo.listGoals(goalCursor); goals = (goals + response.arr("items")).distinctBy { it.str("id") }; goalCursor = response.str("nextCursor").takeIf { it.isNotBlank() && it != "null" } }
                        catch (cancel: CancellationException) { throw cancel }
                        catch (e: Exception) { error = e.message ?: appContext.getString(R.string.factory_team_load_more_error) }
                        finally { loading = false }
                    } }) { Text(stringResource(R.string.factory_team_17)) }
                    Text(stringResource(R.string.factory_ux_person), fontWeight = FontWeight.SemiBold)
                    Text(stringResource(R.string.factory_ux_person_note), color = colors.secondaryContent)
                    if (eligibleNodes.isEmpty()) Text(stringResource(R.string.factory_ux_no_person), color = colors.secondaryContent)
                    eligibleNodes.forEach { node -> AgentoRowSurface(selected = nodeId == node.id, onClick = { nodeId = node.id; nodeChoiceConfirmed = true }, modifier = Modifier.fillMaxWidth()) {
                        Text(node.displayName.ifBlank { node.id }, Modifier.padding(12.dp), color = colors.primaryContent)
                    } }
                    OutlinedTextField(objective, { objective = it }, label = { Text(stringResource(R.string.factory_team_20)) }, modifier = Modifier.fillMaxWidth())
                    Text(stringResource(R.string.factory_review_attempts_note), color = colors.secondaryContent)
                    Row { TextButton(onClick = { attempts = 1 }) { Text(stringResource(R.string.factory_review_attempts_one) + if (attempts == 1) " ✓" else "") }
                        TextButton(onClick = { attempts = 2 }) { Text(stringResource(R.string.factory_review_attempts_two) + if (attempts == 2) " ✓" else "") } }
                    TextButton(onClick = { settingsOpen = !settingsOpen }) { Text(stringResource(R.string.factory_ux_review_settings)) }
                    if (settingsOpen) OutlinedTextField(criterion, { criterion = it }, label = { Text(stringResource(R.string.factory_ux_criterion)) }, modifier = Modifier.fillMaxWidth())
                    AgentoButton(stringResource(R.string.factory_ux_save), enabled = goalsLoaded && sessionProject.isNotBlank() && eligibleNodes.any { it.id == nodeId } && objective.isNotBlank() && pending == null && !loading, onClick = { saveDraft() })
                    Text(stringResource(R.string.factory_ux_save_note), color = colors.secondaryContent)
                }
                "detail" -> selected?.let { work ->
                    val id = work.str("id"); val contract = work.obj("contract"); val candidate = work.str("candidateDigest")
                    val version = work.num("rowVersion"); val rev = work.num("contractRevision"); val gate = work.num("gateGeneration")
                    var selectedExcerpts by remember(id, candidate) { mutableStateOf<List<Pair<Int, String>>>(emptyList()) }
                    var passageReasons by remember(id, candidate) { mutableStateOf<Map<Int, String>>(emptyMap()) }
                    val resource = contract?.obj("resource")
                    val reportType = contract != null && resource != null && contract.str("accessMode") == "read" && (contract["allowedPaths"] as? JsonArray)?.isEmpty() == true &&
                        resource.str("readScope") == "entire_project" && resource.str("networkPolicy") in setOf("deny", "inherit_existing_permissions") &&
                        resource.str("projectId") == work.str("projectId") && contract.arr("acceptanceCriteria").isNotEmpty() &&
                        contract.arr("acceptanceCriteria").all { it.str("method") == "manual" }
                    Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(contract?.str("objective").orEmpty(), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.factory_review_identity, work.str("projectId"), work.str("goalId"), id), color = colors.secondaryContent)
                        Text(stringResource(R.string.factory_review_version, version?.toString().orEmpty(), rev?.toString().orEmpty(), gate?.toString().orEmpty(), candidate.ifBlank { "—" }), color = colors.secondaryContent)
                        Text(stringResource(R.string.factory_review_formal_note), color = colors.secondaryContent)
                        val allowedPaths = (contract?.get("allowedPaths") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                        Text(stringResource(R.string.factory_review_permissions, contract?.str("accessMode").orEmpty().ifBlank { "—" }, allowedPaths?.joinToString(", ")?.ifBlank { "—" } ?: "—"), color = colors.secondaryContent)
                        val control = controlStateLabel(work.str("controlState"))
                        Text(listOf(workStateLabel(work.str("state")), control).filter { it.isNotBlank() }.joinToString(" · "), color = colors.secondaryContent)
                        TextButton(onClick = { scope.launch { open(id) } }) { Text(stringResource(R.string.factory_team_26)) }
                        if (!reportType) Text(stringResource(R.string.factory_team_advanced_type), color = colors.secondaryContent)
                        val report = work.arr("candidates").lastOrNull { it.str("digest") == candidate && it.num("contractRevision") == rev && it.num("executionEpoch") == work.num("executionEpoch") && it.num("bindingGeneration") == work.num("bindingGeneration") }?.obj("report")
                        if (report != null) {
                            Text(stringResource(R.string.factory_team_30), style = MaterialTheme.typography.titleMedium)
                            Text(stringResource(R.string.factory_review_packet, report.str("packetId"), report.str("packetDigest")), color = colors.secondaryContent)
                            val producer = report.obj("producer")
                            if (producer != null) Text(stringResource(R.string.factory_review_producer, producer.str("projectId").ifBlank { "—" }, producer.str("sessionId").ifBlank { "—" }, producer.str("runId").ifBlank { "—" }, producer.str("taskId").ifBlank { "—" }, producer.str("packetCreatedAt").ifBlank { "—" }), color = colors.secondaryContent)
                            else Text(stringResource(R.string.factory_review_source_unknown), color = colors.secondaryContent)
                            val sourceSession = producer?.str("sessionId").orEmpty()
                            if (sourceSession.isNotBlank() && onOpenSourceSession != null) TextButton(onClick = { onOpenSourceSession(sourceSession) }) { Text(stringResource(R.string.factory_review_open_source_session)) }
                            Text(stringResource(R.string.factory_review_event_unavailable), color = colors.secondaryContent)
                            Text(report.str("visibleText").ifBlank { report.obj("declaration")?.str("summary").orEmpty().ifBlank { appContext.getString(R.string.factory_team_report_empty) } })
                            val declared = report.obj("declaration")
                            if (declared?.str("status") == "valid") {
                                val declaredState = declared.str("state")
                                val label = if (declaredState in setOf("completed", "failed", "blocked", "waiting")) workStateLabel(declaredState) else stringResource(R.string.factory_state_unknown)
                                Text(stringResource(R.string.factory_team_declaration, label), color = colors.secondaryContent)
                            }
                            val declaration = report.obj("declaration")
                            listOf("blockers", "risks").forEach { field ->
                                (declaration?.get(field) as? JsonArray)?.forEach { fact ->
                                    val value = (fact as? JsonPrimitive)?.contentOrNull
                                    if (!value.isNullOrBlank()) Text(stringResource(if (field == "blockers") R.string.factory_team_blockers else R.string.factory_team_risks) + ": " + value, color = colors.secondaryContent)
                                }
                            }
                        } else if (reportType && work.str("state") == "review") Text(stringResource(R.string.factory_team_report_empty), color = colors.secondaryContent)
                        val comparison = work.obj("reportComparison")
                        if (comparison != null) {
                            Text(stringResource(R.string.factory_weekly_compare_title), style = MaterialTheme.typography.titleMedium)
                            val baseline = comparison.obj("baseline")
                            if (comparison.str("status") != "available" || baseline == null) {
                                Text(stringResource(R.string.factory_weekly_compare_unavailable, comparison.str("reason").ifBlank { "unknown" }), color = colors.secondaryContent)
                            } else {
                                Text(stringResource(R.string.factory_weekly_compare_baseline, baseline.str("workItemId"), baseline.str("candidateDigest"), baseline.str("acceptedAt").ifBlank { "—" }), color = colors.secondaryContent)
                                Text(stringResource(R.string.factory_weekly_compare_refs, baseline.str("runId").ifBlank { "—" }, baseline.str("packetId").ifBlank { "—" }, baseline.str("packetDigest").ifBlank { "—" }, baseline.str("capturedAt").ifBlank { "—" }), color = colors.secondaryContent)
                                val resource = baseline.obj("resource")
                                Text(stringResource(R.string.factory_weekly_compare_scope, resource?.str("projectId").orEmpty().ifBlank { "—" }, resource?.str("readScope").orEmpty().ifBlank { "—" }, baseline.str("source").ifBlank { "—" }), color = colors.secondaryContent)
                                val previousReport = baseline.obj("report")
                                Text(stringResource(R.string.factory_weekly_compare_previous))
                                Text(previousReport?.str("visibleText").orEmpty().ifBlank { stringResource(R.string.factory_weekly_content_unknown) })
                                if ((previousReport?.get("truncated") as? JsonPrimitive)?.booleanOrNull == true) Text(stringResource(R.string.factory_review_more), color = colors.secondaryContent)
                                listOf(stringResource(R.string.factory_weekly_compare_old_risks) to previousReport?.obj("declaration"), stringResource(R.string.factory_weekly_compare_new_risks) to report?.obj("declaration")).forEach { (label, declaration) ->
                                    val risks = (declaration?.get("risks") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
                                    Text("$label: ${risks.joinToString("; ").ifBlank { "—" }}", color = colors.secondaryContent)
                                }
                                Text(stringResource(R.string.factory_weekly_compare_caution), color = colors.secondaryContent)
                            }
                        }
                        work.arr("decisions").forEach {
                            val current = it.str("candidateDigest") == candidate && it.num("contractRevision") == rev && it.num("gateGeneration") == gate
                            val label = when (it.str("decision")) { "passed" -> stringResource(R.string.factory_team_pass); "failed" -> stringResource(R.string.factory_team_fail); else -> stringResource(R.string.factory_state_unknown) }
                            val description = contract?.arr("acceptanceCriteria")?.firstOrNull { c -> c.str("id") == it.str("criterionId") }?.str("description").orEmpty()
                            Text(stringResource(R.string.factory_team_decision, label, description.ifBlank { stringResource(R.string.factory_ux_criterion) }) + if (current) " · " + stringResource(R.string.factory_team_current) else " · " + stringResource(R.string.factory_team_historical))
                            it.arr("evidence").flatMap { evidence -> evidence.arr("targets") }.forEach { target ->
                                Text(stringResource(R.string.factory_review_recorded_target, target.str("excerpt"), target.str("rationale")), color = colors.secondaryContent)
                            }
                        }
                        Text(stringResource(R.string.factory_review_independent_title), style = MaterialTheme.typography.titleMedium)
                        work.obj("reviewHandoff")?.let { link ->
                            val origin = link.obj("candidate")
                            val reviewer = link.obj("reviewer")
                            val originRun = origin?.obj("runtime")
                            val reviewerRun = reviewer?.obj("runtime")
                            Text(stringResource(R.string.factory_review_handoff_context, link.str("state").ifBlank { "unavailable" }, reviewer?.str("accessMode").orEmpty().ifBlank { "—" }), color = colors.secondaryContent)
                            Text(stringResource(R.string.factory_review_candidate_trace, origin?.str("workItemId").orEmpty(), origin?.str("digest").orEmpty(), origin?.num("contractRevision")?.toString().orEmpty(), origin?.num("executionEpoch")?.toString().orEmpty()), color = colors.secondaryContent)
                            Text(stringResource(R.string.factory_review_run_trace, originRun?.str("runId").orEmpty().ifBlank { "—" }, originRun?.str("tool").orEmpty().ifBlank { "—" }, originRun?.str("provider").orEmpty().ifBlank { "—" }, originRun?.str("state").orEmpty().ifBlank { "—" }), color = colors.secondaryContent)
                            Text(stringResource(R.string.factory_review_reviewer_trace, reviewer?.str("workItemId").orEmpty(), reviewer?.str("nodeId").orEmpty(), reviewerRun?.str("runId").orEmpty().ifBlank { "—" }, reviewerRun?.str("tool").orEmpty().ifBlank { "—" }, reviewerRun?.str("provider").orEmpty().ifBlank { "—" }, reviewerRun?.str("state").orEmpty().ifBlank { "—" }), color = colors.secondaryContent)
                            Text(stringResource(R.string.factory_review_host_unknown), color = colors.secondaryContent)
                        }
                        work.arr("reviewWorkItems").forEach { review ->
                            val reviewId = review.str("workItemId")
                            Text(stringResource(R.string.factory_review_work_trace, reviewId, review.str("nodeId"), review.str("state"), review.str("controlState"), review.num("contractRevision")?.toString().orEmpty(), review.num("executionEpoch")?.toString().orEmpty()), color = colors.secondaryContent)
                            TextButton(enabled = !loading && reviewId.isNotBlank(), onClick = { scope.launch { open(reviewId) } }) { Text(stringResource(R.string.factory_review_open_work)) }
                        }
                        if ((work["reviewWorkItemsTruncated"] as? JsonPrimitive)?.booleanOrNull == true) Text(stringResource(R.string.factory_review_more), color = colors.secondaryContent)
                        val opinions = work.arr("reviewOpinions")
                        if (opinions.isEmpty()) Text(stringResource(R.string.factory_review_none), color = colors.secondaryContent)
                        opinions.forEach { opinion ->
                            val source = opinion.obj("candidate")
                            val reviewer = opinion.obj("reviewer")
                            val sourceRun = source?.obj("runtime")
                            val reviewRun = reviewer?.obj("runtime")
                            Text(stringResource(R.string.factory_review_opinion, opinion.str("verdict").ifBlank { "—" }, opinion.str("reason").ifBlank { "—" }))
                            Text(stringResource(R.string.factory_review_candidate_trace, source?.str("workItemId").orEmpty(), source?.str("digest").orEmpty(), source?.num("contractRevision")?.toString().orEmpty(), source?.num("executionEpoch")?.toString().orEmpty()), color = colors.secondaryContent)
                            val sourcePaths = (source?.get("allowedPaths") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                            Text(stringResource(R.string.factory_review_scope, sourcePaths?.joinToString(", ")?.ifBlank { "—" } ?: "—"), color = colors.secondaryContent)
                            Text(stringResource(R.string.factory_review_run_trace, sourceRun?.str("runId").orEmpty().ifBlank { "—" }, sourceRun?.str("tool").orEmpty().ifBlank { "—" }, sourceRun?.str("provider").orEmpty().ifBlank { "—" }, sourceRun?.str("state").orEmpty().ifBlank { "—" }), color = colors.secondaryContent)
                            Text(stringResource(R.string.factory_review_reviewer_trace, reviewer?.str("workItemId").orEmpty(), reviewer?.str("nodeId").orEmpty(), reviewRun?.str("runId").orEmpty().ifBlank { "—" }, reviewRun?.str("tool").orEmpty().ifBlank { "—" }, reviewRun?.str("provider").orEmpty().ifBlank { "—" }, reviewRun?.str("state").orEmpty().ifBlank { "—" }), color = colors.secondaryContent)
                            Text(stringResource(R.string.factory_review_receipt_trace, opinion.str("verification").ifBlank { "—" }, opinion.str("currentContext").ifBlank { "—" }, opinion.obj("receipt")?.str("packetId").orEmpty().ifBlank { "—" }, opinion.obj("receipt")?.str("packetDigest").orEmpty().ifBlank { "—" }), color = colors.secondaryContent)
                            Text(stringResource(R.string.factory_review_opinion_note), color = colors.secondaryContent)
                        }
                        if ((work["reviewOpinionsTruncated"] as? JsonPrimitive)?.booleanOrNull == true) Text(stringResource(R.string.factory_review_more), color = colors.secondaryContent)
                        if (work.arr("validationWorkItems").isNotEmpty() || work.arr("checks").isNotEmpty()) {
                            Text(stringResource(R.string.factory_validation_title), style = MaterialTheme.typography.titleMedium)
                            work.arr("validationWorkItems").forEach { validation ->
                                val workspace = validation.obj("workspace")
                                Text(stringResource(R.string.factory_validation_work, validation.str("workItemId"), validation.str("state"), validation.str("runId").ifBlank { "—" }, workspace?.str("state").orEmpty().ifBlank { "—" }, workspace?.str("provenance").orEmpty().ifBlank { "—" }), color = colors.secondaryContent)
                                TextButton(enabled = !loading, onClick = { scope.launch { open(validation.str("workItemId")) } }) { Text(stringResource(R.string.factory_review_open_work)) }
                            }
                            work.arr("checks").forEach { check ->
                                Text(stringResource(R.string.factory_validation_check, check.str("actionId"), check.str("state"), check.str("candidateDigest"), check.str("validationRunId").ifBlank { "—" }), color = colors.secondaryContent)
                            }
                            Text(stringResource(R.string.factory_validation_note), color = colors.secondaryContent)
                            if ((work["checksTruncated"] as? JsonPrimitive)?.booleanOrNull == true || (work["validationWorkItemsTruncated"] as? JsonPrimitive)?.booleanOrNull == true) Text(stringResource(R.string.factory_review_more), color = colors.secondaryContent)
                        }
                        Text(stringResource(R.string.factory_recovery_title), style = MaterialTheme.typography.titleMedium)
                        val recovery = reconciliation
                        val observed = recovery?.obj("acceptedRunObservation")
                        val unknown = recovery?.obj("unknownOutcome")
                        if (recovery == null) Text(stringResource(R.string.factory_recovery_unavailable), color = colors.secondaryContent)
                        else {
                            Text(stringResource(R.string.factory_recovery_execution, observed?.str("expectedRunId").orEmpty().ifBlank { "—" }, observed?.str("state").orEmpty().ifBlank { "unknown" }, observed?.str("runState").orEmpty().ifBlank { "—" }, observed?.str("observedAt").orEmpty().ifBlank { "—" }), color = colors.secondaryContent)
                            Text(stringResource(R.string.factory_recovery_stop, recovery.str("controlState").ifBlank { "—" }, recovery.str("stopStatus").ifBlank { "unknown" }), color = colors.secondaryContent)
                            if ((observed?.get("requiresVerification") as? JsonPrimitive)?.booleanOrNull == true) Text(stringResource(R.string.factory_recovery_verify), color = colors.secondaryContent)
                            if ((unknown?.get("isUnknown") as? JsonPrimitive)?.booleanOrNull == true) Text(stringResource(R.string.factory_recovery_unknown, unknown?.str("reason").orEmpty().ifBlank { "—" }), color = colors.secondaryContent)
                        }
                        val reservation = budgetFacts?.obj("reservation")
                        val reserved = reservation?.obj("reserved")
                        val actual = reservation?.obj("actualUsage")
                        val actualKnown = budgetFacts?.str("usageState") == "actual" && actual != null
                        if (reservation == null) Text(stringResource(R.string.factory_recovery_budget_unavailable), color = colors.secondaryContent)
                        else Text(stringResource(R.string.factory_recovery_budget, reservation.str("state").ifBlank { "unknown" }, reserved?.str("tokens").orEmpty().ifBlank { "—" }, reserved?.str("cost").orEmpty().ifBlank { "—" }, if (actualKnown) actual?.str("tokens").orEmpty().ifBlank { "—" } else "—", if (actualKnown) actual?.str("cost").orEmpty().ifBlank { "—" } else "—"), color = colors.secondaryContent)
                        val external = recovery?.obj("externalOutcomes")
                        if (external?.str("state") == "observed") {
                            external.arr("entries").forEach { entry ->
                                val receipt = entry.obj("providerReceipt")
                                Text(stringResource(R.string.factory_external_receipt, entry.str("targetId"), entry.str("state").ifBlank { "unknown" }, receipt?.str("provider").orEmpty().ifBlank { "—" }, receipt?.str("statusCode").orEmpty().ifBlank { "—" }, receipt?.str("responseId").orEmpty().ifBlank { "—" }), color = colors.secondaryContent)
                                entry.arr("manualReviews").forEach { review -> Text(stringResource(R.string.factory_external_human, review.str("observation"), review.str("reviewedAt")), color = colors.secondaryContent) }
                            }
                            if ((external["truncated"] as? JsonPrimitive)?.booleanOrNull == true) Text(stringResource(R.string.factory_review_more), color = colors.secondaryContent)
                        } else Text(stringResource(R.string.factory_recovery_external), color = colors.secondaryContent)
                        TextButton(enabled = !loading, onClick = { scope.launch { open(id) } }) { Text(stringResource(R.string.factory_recovery_recheck)) }
                        Text(stringResource(R.string.factory_handoff_title), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.factory_handoff_note), color = colors.secondaryContent)
                        work.arr("bindings").forEach { binding ->
                            Text(stringResource(R.string.factory_handoff_run, binding.num("executionEpoch")?.toString().orEmpty(), binding.str("runId").ifBlank { "—" }, binding.str("status").ifBlank { "—" }), color = colors.secondaryContent)
                        }
                        if (work.arr("bindings").isEmpty()) Text(stringResource(R.string.factory_handoff_no_run), color = colors.secondaryContent)
                        val savedHandoff = pendingHandoff?.let { Json.parseToJsonElement(it) as? JsonObject }
                        if (savedHandoff != null) {
                            Text(stringResource(R.string.factory_handoff_pending, savedHandoff.str("item")), color = colors.secondaryContent)
                            AgentoButton(stringResource(R.string.factory_team_retry), enabled = !loading, secondary = true, onClick = { scope.launch { sendHandoff() } })
                        } else if (version != null) AgentoButton(stringResource(R.string.factory_handoff_create), enabled = !loading && !needsRefresh, secondary = true, onClick = {
                            pendingHandoff = buildJsonObject { put("item", id); put("version", version); put("key", UUID.randomUUID().toString()) }.toString()
                            scope.launch { sendHandoff() }
                        })
                        handoff?.takeIf { it.str("workItemId") == id }?.let { snapshot ->
                            Text(stringResource(R.string.factory_handoff_result, snapshot.str("assessment").ifBlank { "unknown" }, snapshot.str("asOf"), snapshot["staleReasons"]?.toString().orEmpty()), color = colors.secondaryContent)
                            val snapshotBindings = snapshot.obj("facts")?.obj("sourceRefs")?.arr("bindings").orEmpty()
                            snapshotBindings.forEach { binding ->
                                Text(stringResource(R.string.factory_handoff_saved_run, binding.str("execution_epoch").ifBlank { "—" }, binding.str("run_id").ifBlank { "—" }, binding.str("status").ifBlank { "—" }), color = colors.secondaryContent)
                            }
                            Text(stringResource(R.string.factory_handoff_no_guarantee), color = colors.secondaryContent)
                            TextButton(enabled = !loading, onClick = { scope.launch {
                                loading = true
                                try { handoff = repo.getHandoff(snapshot.str("id")); error = null }
                                catch (cancel: CancellationException) { throw cancel }
                                catch (e: Exception) { error = e.message ?: appContext.getString(R.string.factory_team_connection_error) }
                                finally { loading = false }
                            } }) { Text(stringResource(R.string.factory_handoff_refresh)) }
                        }
                        val returnedCandidate = work.arr("decisions").any { it.str("decision") == "failed" && it.str("candidateDigest") == candidate && it.num("contractRevision") == rev && it.num("gateGeneration") == gate }
                        if (reportType && work.str("state") == "review" && returnedCandidate && version != null) {
                            Text(stringResource(R.string.factory_review_revision_note), color = colors.secondaryContent)
                            val attemptLimit = contract?.obj("retry")?.num("maxAttempts")
                            val usedAttempts = work.arr("bindings").size
                            Text(stringResource(R.string.factory_review_attempts_limit, attemptLimit?.toString() ?: "—", usedAttempts.toString()), color = colors.secondaryContent)
                            if (attemptLimit == null || usedAttempts >= attemptLimit) Text(stringResource(R.string.factory_review_attempts_exhausted), color = colors.secondaryContent)
                            AgentoButton(stringResource(R.string.factory_review_request_revision), enabled = pending == null && !loading && !needsRefresh && attemptLimit != null && usedAttempts < attemptLimit, onClick = {
                                prepare("retry", buildJsonObject { put("item", id); put("version", version) })
                            }, secondary = true)
                        }
                        val priorReturned = work.arr("decisions").any { it.str("decision") == "failed" && it.num("contractRevision") == rev }
                        val authority = work.obj("reportAuthority")?.str("kind")
                        if (reportType && work.str("state") == "ready" && candidate.isBlank() && priorReturned && version != null) {
                            when (authority) {
                                "owner" -> {
                                    Text(stringResource(R.string.factory_review_authorize_note), color = colors.secondaryContent)
                                    val reservation = contract?.obj("budgetReservation")
                                    val budget = contract?.obj("budget")
                                    Text(stringResource(R.string.factory_review_budget, reservation?.str("tokens").orEmpty().ifBlank { budget?.str("maxTokens").orEmpty().ifBlank { "—" } }, reservation?.str("cost").orEmpty().ifBlank { budget?.str("maxCost").orEmpty().ifBlank { "—" } }), color = colors.secondaryContent)
                                    when ((work.obj("reportAuthority")?.get("nextExecutionAuthorized") as? JsonPrimitive)?.booleanOrNull) {
                                        true -> Text(stringResource(R.string.factory_review_already_authorized), color = colors.secondaryContent)
                                        false -> AgentoButton(stringResource(R.string.factory_review_authorize), enabled = pending == null && !loading && !needsRefresh, onClick = {
                                            prepare("authorization", buildJsonObject { put("item", id); put("version", version) })
                                        })
                                        null -> Text(stringResource(R.string.factory_review_authority_unknown), color = colors.secondaryContent)
                                    }
                                }
                                "responsibility" -> Text(stringResource(R.string.factory_review_responsibility_authority), color = colors.secondaryContent)
                                else -> Text(stringResource(R.string.factory_review_authority_unknown), color = colors.secondaryContent)
                            }
                        }
                        if (reportType && resource?.str("networkPolicy") == "inherit_existing_permissions" && work.str("state") == "proposed" && version != null && contract != null) {
                            val reservation = contract.obj("budgetReservation")
                            val budget = contract.obj("budget")
                            val tokenValues = listOfNotNull(reservation?.get("tokens"), budget?.get("maxTokens"))
                            val costValues = listOfNotNull(reservation?.get("cost"), budget?.get("maxCost"))
                            val validTokens = tokenValues.all { value -> (value as? JsonPrimitive)?.let { !it.isString && it.longOrNull?.let { n -> n in 1..9_007_199_254_740_991L } == true } == true }
                            val validCost = costValues.all { value -> (value as? JsonPrimitive)?.let { !it.isString && it.contentOrNull?.toDoubleOrNull()?.let { n -> n.isFinite() && n > 0 } == true } == true }
                            val hasBudget = tokenValues.isNotEmpty() || costValues.isNotEmpty()
                            val invalidSavedBudget = (contract.containsKey("budgetReservation") && (reservation == null || (!reservation.containsKey("tokens") && !reservation.containsKey("cost")))) ||
                                (contract.containsKey("budget") && budget == null) || !validTokens || !validCost
                            val nextEpochAvailable = work.num("executionEpoch")?.let { it in 0..9_007_199_254_740_990L } == true
                            val unsavedBudget = tokens.isNotBlank() || cost.isNotBlank()
                            Text(stringResource(R.string.factory_ux_ready_to_start), color = colors.secondaryContent)
                            if (invalidSavedBudget) Text(stringResource(R.string.factory_ux_budget_invalid), color = colors.secondaryContent)
                            else if (hasBudget) {
                                if (tokenValues.isNotEmpty() && validTokens) Text(stringResource(R.string.factory_ux_saved_tokens, tokenValues.minOf { (it as JsonPrimitive).long }.toString()))
                                if (costValues.isNotEmpty() && validCost) Text(stringResource(R.string.factory_ux_saved_cost, costValues.minOf { (it as JsonPrimitive).content.toDouble() }.toString()))
                            }
                            else Text(stringResource(R.string.factory_ux_budget_optional), color = colors.secondaryContent)
                            TextButton(enabled = pending == null && !loading && !needsRefresh, onClick = { startSettings = !startSettings }) { Text(stringResource(R.string.factory_ux_set_budget)) }
                                if (startSettings) {
                                    OutlinedTextField(tokens, { tokens = it }, label = { Text(stringResource(R.string.factory_team_22)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                                    OutlinedTextField(cost, { cost = it }, label = { Text(stringResource(R.string.factory_team_23)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                                    Text(stringResource(R.string.factory_ux_budget_note), color = colors.secondaryContent)
                                    if (unsavedBudget) Text(stringResource(R.string.factory_ux_budget_unsaved), color = colors.secondaryContent)
                                    AgentoButton(stringResource(R.string.factory_ux_save_settings), enabled = pending == null && !loading && !needsRefresh && (tokens.toLongOrNull()?.let { it in 1..9_007_199_254_740_991L } == true) && (cost.toDoubleOrNull()?.let { it.isFinite() && it > 0 } == true), onClick = {
                                        val savedTokens = tokens.toLong(); val savedCost = cost.toDouble(); val savedContract = contract
                                        prepare("budget", buildJsonObject { put("item",id); put("version",version); work.num("contractRevision")?.let { put("revision",it) }; put("contract",savedContract); put("tokens",savedTokens); put("cost",savedCost.toString()) })
                                    })
                                }
                            run {
                                Text(stringResource(R.string.factory_ux_start_scope), color = colors.secondaryContent)
                                Text(stringResource(R.string.factory_team_member, nodes.find { it.id == work.str("assigneeNodeId") }?.displayName?.ifBlank { work.str("assigneeNodeId") } ?: work.str("assigneeNodeId")))
                                if (!approvalReview) {
                                    AgentoButton(stringResource(R.string.factory_ux_start), enabled = pending == null && !loading && !needsRefresh && !unsavedBudget && !invalidSavedBudget && rev != null && nextEpochAvailable, onClick = { approvalReview = true })
                                } else {
                                    AlertDialog(onDismissRequest = { approvalReview = false }, title = { Text(stringResource(R.string.factory_ux_start)) },
                                        text = { Text(stringResource(R.string.factory_ux_start_confirm) + "\n\n" + stringResource(R.string.factory_ux_start_scope)) },
                                        confirmButton = { TextButton(enabled = pending == null && !loading && !needsRefresh && !unsavedBudget && !invalidSavedBudget && rev != null && nextEpochAvailable, onClick = {
                                            val epoch = work.num("executionEpoch") ?: return@TextButton
                                            val revision = rev ?: return@TextButton
                                            approvalReview = false
                                            val approval = buildJsonObject { put("type","approval"); put("key",UUID.randomUUID().toString()); put("args",buildJsonObject { put("item",id); put("version",version) }) }
                                            pending = buildJsonObject { put("type","authorization"); put("key",UUID.randomUUID().toString()); put("args",buildJsonObject { put("item",id); put("version",version); put("revision",revision); put("epoch",epoch + 1) }); put("next",approval) }.toString()
                                            scope.launch { send() }
                                        }) { Text(stringResource(R.string.factory_ux_confirm_start)) } },
                                        dismissButton = { TextButton(onClick = { approvalReview = false }) { Text(stringResource(R.string.factory_team_06)) } })
                                }
                            }
                        }
                        TextButton(onClick = { technicalOpen = !technicalOpen }) { Text(stringResource(R.string.factory_ux_details)) }
                        if (technicalOpen) contract?.arr("acceptanceCriteria")?.forEach { c -> Text(stringResource(R.string.factory_team_review_criterion, c.str("description").ifBlank { c.str("id") })) }
                        val manualCriteria = contract?.arr("acceptanceCriteria")?.filter { it.str("method") == "manual" }.orEmpty()
                        val manual = manualCriteria.firstOrNull { it.str("id") == criterionIdSelected }
                        val reportReadable = report != null && report.str("source") == "persisted_assistant_final" && (report["readable"] as? JsonPrimitive)?.booleanOrNull == true && report.str("packetId").isNotBlank() && report.str("packetDigest").isNotBlank()
                        if (work.str("state") == "review" && !reportReadable) Text(stringResource(R.string.factory_review_unverified), color = colors.secondaryContent)
                        if (reportType && reportReadable && work.str("state") == "review" && candidate.isNotBlank() && version != null && rev != null && gate != null && manualCriteria.isNotEmpty()) {
                            manualCriteria.forEach { criterionEntry -> AgentoRowSurface(selected = criterionIdSelected == criterionEntry.str("id"), onClick = { criterionIdSelected = criterionEntry.str("id"); reviewDecision = null }, modifier = Modifier.fillMaxWidth()) {
                                Text(criterionEntry.str("description").ifBlank { criterionEntry.str("id") }, Modifier.padding(12.dp))
                            } }
                            Text(stringResource(R.string.factory_review_select_passages), color = colors.secondaryContent)
                            val reportText = report?.str("visibleText").orEmpty()
                            var offset = 0
                            reportText.split('\n').forEach { line ->
                                val trimmed = line.trim()
                                val start = offset + if (trimmed.isEmpty()) 0 else line.indexOf(trimmed)
                                val prefix = trimmed.take(1000)
                                val excerpt = if (prefix.lastOrNull()?.isHighSurrogate() == true) prefix.dropLast(1) else prefix
                                offset += line.length + 1
                                if (excerpt.isNotBlank()) {
                                    val selectedPassage = selectedExcerpts.any { it.first == start && it.second == excerpt }
                                    TextButton(enabled = pending == null && !loading && !needsRefresh, onClick = {
                                        selectedExcerpts = if (selectedPassage) selectedExcerpts.filterNot { it.first == start && it.second == excerpt }
                                            else if (selectedExcerpts.size < 20 && selectedExcerpts.sumOf { it.second.toByteArray(Charsets.UTF_8).size } + excerpt.toByteArray(Charsets.UTF_8).size <= 11000) selectedExcerpts + (start to excerpt) else selectedExcerpts
                                        reviewDecision = null
                                    }) { Text((if (selectedPassage) "✓ " else "") + excerpt) }
                                    if (selectedPassage) OutlinedTextField(passageReasons[start].orEmpty(), { passageReasons = passageReasons + (start to it.take(1200)) }, label = { Text(stringResource(R.string.factory_review_passage_reason)) }, modifier = Modifier.fillMaxWidth())
                                }
                            }
                            Text(stringResource(R.string.factory_review_passage_count, selectedExcerpts.size), color = colors.secondaryContent)
                            OutlinedTextField(rationale, { rationale = it }, label = { Text(stringResource(R.string.factory_team_31)) }, modifier = Modifier.fillMaxWidth())
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                AgentoButton(stringResource(R.string.factory_team_32), onClick = { reviewDecision = "passed" }, enabled = pending == null && !loading && !needsRefresh && manual != null, secondary = true)
                                AgentoButton(stringResource(R.string.factory_team_33), onClick = { reviewDecision = "failed" }, enabled = pending == null && !loading && !needsRefresh && manual != null, secondary = true)
                            }
                            val selectedTargets = buildJsonArray { selectedExcerpts.forEach { (start, excerpt) -> add(buildJsonObject { put("section", "visibleText"); put("start", start); put("excerpt", excerpt); put("rationale", passageReasons[start].orEmpty().trim()) }) } }
                            val validTargets = selectedExcerpts.all { passageReasons[it.first]?.isNotBlank() == true } && selectedTargets.toString().toByteArray(Charsets.UTF_8).size <= 11000
                            reviewDecision?.let { decision ->
                                val decisionLabel = stringResource(if (decision == "passed") R.string.factory_team_pass else R.string.factory_team_fail)
                                Text(stringResource(R.string.factory_team_confirm_decision, decisionLabel))
                                AgentoButton(stringResource(R.string.factory_team_confirm_button, decisionLabel), enabled = manual != null && rationale.isNotBlank() && rationale.length <= 4096 && (decision != "failed" || validTargets) && pending == null && !loading && !needsRefresh, onClick = {
                                    val reason = rationale; val criterionId = manual?.str("id").orEmpty(); reviewDecision = null
                                    prepare("decision", buildJsonObject { put("item",id); put("version",version); put("revision",rev); put("gate",gate); put("candidate",candidate); put("criterion",criterionId); put("decision",decision); put("reason",reason); put("packetId",report!!.str("packetId")); put("packetDigest",report.str("packetDigest")); if (decision == "failed" && selectedExcerpts.isNotEmpty()) put("targets", selectedTargets) })
                                })
                            }
                        }
                    }
                }
            }
        }
    }
    if (butlerState.voiceSheetOpen) {
        ButlerVoiceSheet(
            uiState = butlerState,
            onDismiss = butlerViewModel::closeVoiceButler,
            onMicOrBargeIn = butlerViewModel::startListeningOrBargeIn,
            onInterruptSpeaking = { butlerViewModel.interruptSpeakingOnly() },
            onToggleContinuousMode = butlerViewModel::setContinuousMode,
            onDraftTextChange = butlerViewModel::setDraftText,
            onSubmitTextTurn = { text -> butlerViewModel.submitTypedOrSimulatedTurn(text) },
            onRefreshSession = butlerViewModel::refreshActiveVoiceSession,
            onStartNewSession = { butlerViewModel.startNewVoiceSession() },
            onResumeSession = butlerViewModel::resumeVoiceSession,
            onRequestHandoff = { id, type, label ->
                butlerViewModel.requestHandoff(targetDeviceId = id, targetDeviceType = type, targetDeviceLabel = label)
            },
            onSelectAdapters = butlerViewModel::selectAdapters,
            onOpenApprovalCard = butlerViewModel::openVisualApprovalCard,
        )
    }
    butlerState.pendingApprovalCard?.let { card ->
        ButlerVisualApprovalDialog(
            card = card,
            busy = butlerState.approvalConfirmBusy,
            error = butlerState.approvalConfirmError,
            onConfirm = butlerViewModel::confirmPendingApproval,
            onDismiss = butlerViewModel::dismissVisualApprovalCard,
            onOpenDetails = { rid, pid ->
                focusedPlanFromButler = pid
                onResponsibilitySelected(rid)
                page = "advanced"
            },
        )
    }
    }
}
