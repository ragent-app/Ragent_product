package com.andysagent.ragent.feature.organization.ui

import android.net.Uri
import android.app.TimePickerDialog
import android.content.Context
import android.media.AudioManager
import android.speech.tts.TextToSpeech
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.encodeOrganizationUriComponent
import com.andysagent.ragent.feature.organization.data.formatOrganizationFeatureUnavailableBanner
import com.andysagent.ragent.feature.organization.data.isOrganizationFeatureUnavailableStatus
import com.andysagent.ragent.feature.organization.data.parseOrganizationApiException
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
fun FactoryWorkScreen(transport: RagentTransport, organizationId: String, responsibilityDraft: String = "", selectedResponsibilityId: String? = null, onResponsibilitySelected: (String?) -> Unit = {}, responsibilityNavigationKey: String? = null, selectedPlanId: String? = null, nodes: List<OrganizationNodeDto> = emptyList(), availableProjectId: String = "", sessionId: String = "", onOpenVoiceButler: ((String, String?) -> Unit)? = null, onOpenWorkItem: ((String) -> Unit)? = null, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val audio = remember(context) { context.getSystemService(Context.AUDIO_SERVICE) as AudioManager }
    var speech by remember { mutableStateOf<TextToSpeech?>(null) }
    var speechReady by remember { mutableStateOf(false) }
    val focusListener = remember { AudioManager.OnAudioFocusChangeListener { change -> if (change <= 0) speech?.stop() } }
    DisposableEffect(context) {
        val engine = TextToSpeech(context) { status -> speechReady = status == TextToSpeech.SUCCESS }
        speech = engine
        onDispose { engine.stop(); engine.shutdown(); audio.abandonAudioFocus(focusListener); speech = null; speechReady = false }
    }
    LaunchedEffect(responsibilityDraft) { speech?.stop(); audio.abandonAudioFocus(focusListener) }
    val base = "/api/organizations/${Uri.encode(organizationId)}/factory"
    var list by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var item by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var itemBudget by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var itemReconciliation by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var handoff by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var handoffPending by remember(organizationId) { mutableStateOf<Pair<String, JsonObject>?>(null) }
    var handoffBusy by remember(organizationId) { mutableStateOf(false) }
    var scopedObjective by remember(organizationId) { mutableStateOf("") }
    var scopedCriterion by remember(organizationId) { mutableStateOf("") }
    var scopedPreview by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var scopedPending by remember(organizationId) { mutableStateOf<Pair<String, JsonObject>?>(null) }
    var multiObjectives by remember(organizationId) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var multiCriteria by remember(organizationId) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var multiPreview by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var multiPending by remember(organizationId) { mutableStateOf<Pair<String, JsonObject>?>(null) }
    var status by remember(organizationId) { mutableStateOf("Loading work items…") }
    var pending by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var responsibilities by remember(organizationId) { mutableStateOf<JsonArray?>(null) }
    var responsibility by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var responsibilityActivity by remember(organizationId) { mutableStateOf<JsonArray?>(null) }
    var linkedReviews by remember(organizationId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var linkedReviewsIncomplete by remember(organizationId) { mutableStateOf(false) }
    var memoryConflictData by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var memoryData by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var memoryChanges by remember(organizationId) { mutableStateOf<Map<String, Pair<String,String>>>(emptyMap()) }
    var memoryPreview by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var responsibilityPolicy by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var weeklyEligibility by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var weeklyDay by remember(organizationId) { mutableIntStateOf(1) }
    var weeklyHour by remember(organizationId) { mutableIntStateOf(9) }
    var weeklyMinute by remember(organizationId) { mutableIntStateOf(0) }
    var weeklyZone by remember(organizationId) { mutableStateOf(java.time.ZoneId.systemDefault().id) }
    var weeklyDayMenu by remember { mutableStateOf(false) }
    var weeklyZoneMenu by remember { mutableStateOf(false) }
    var weeklyReview by remember(organizationId) { mutableStateOf(false) }
    var weeklyManualReview by remember(organizationId) { mutableStateOf(false) }
    var responsibilityPlans by remember(organizationId) { mutableStateOf<JsonArray?>(null) }
    var responsibilityNotifications by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var pendingNotificationToggle by remember(organizationId) { mutableStateOf<Boolean?>(null) }
    var capabilities by remember(organizationId) { mutableStateOf<JsonArray?>(null) }
    var responsibilityFeatures by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var triggerBindings by remember(organizationId) { mutableStateOf<JsonArray?>(null) }
    var triggerTime by remember(organizationId) { mutableStateOf("") }
    var triggerInterval by remember(organizationId) { mutableStateOf("") }
    var reviewTrigger by remember(organizationId) { mutableStateOf(false) }
    var reviewRunTrigger by remember(organizationId) { mutableStateOf(false) }
    var reviewGitCondition by remember(organizationId) { mutableStateOf(false) }
    var reviewedBindingAction by remember(organizationId) { mutableStateOf<Pair<JsonObject, String>?>(null) }
    var planCatalogDescriptors by remember(organizationId) { mutableStateOf<JsonArray?>(null) }
    var reviewedPlan by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var proposal by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var pendingResponsibility by remember(organizationId) { mutableStateOf<Triple<String, String, JsonObject>?>(null) }
    var form by remember(organizationId) { mutableStateOf("") }
    var projectId by remember(organizationId) { mutableStateOf("") }
    var objective by remember(organizationId) { mutableStateOf("") }
    var criterion by remember(organizationId) { mutableStateOf("") }
    var expiry by remember(organizationId) { mutableStateOf("") }
    var intervalMinutes by remember(organizationId) { mutableStateOf("") }
    var reportNode by remember(organizationId) { mutableStateOf("") }
    var reportGeneration by remember(organizationId) { mutableStateOf("") }
    var reportAttempts by remember(organizationId) { mutableStateOf("1") }
    var reportCost by remember(organizationId) { mutableStateOf("") }
    var reportDailyCost by remember(organizationId) { mutableStateOf("") }
    var reportTimeZone by remember(organizationId) { mutableStateOf("") }
    var reportExpiry by remember(organizationId) { mutableStateOf("") }
    var reportReview by remember(organizationId) { mutableStateOf(false) }
    var reportNetworkPolicy by remember(organizationId) { mutableStateOf("") }
    var reportNetworkConfirmed by remember(organizationId) { mutableStateOf(false) }
    var plannerReview by remember(organizationId) { mutableStateOf(false) }
    var plannerNetworkConfirmed by remember(organizationId) { mutableStateOf(false) }
    var autoReportPlans by remember(organizationId) { mutableStateOf(false) }
    var plannerNode by remember(organizationId) { mutableStateOf("") }
    var plannerGeneration by remember(organizationId) { mutableStateOf("") }
    var ciPolicyText by remember(organizationId) { mutableStateOf("") }
    var ciPolicyReviewed by remember(organizationId) { mutableStateOf(false) }
    var ciRepository by remember(organizationId) { mutableStateOf("") }
    var ciBranch by remember(organizationId) { mutableStateOf("") }
    var ciPaths by remember(organizationId) { mutableStateOf("") }
    var ciCandidate by remember(organizationId) { mutableStateOf("") }
    var ciCheck by remember(organizationId) { mutableStateOf("") }
    var ciImplementation by remember(organizationId) { mutableStateOf("") }
    var ciReviewNode by remember(organizationId) { mutableStateOf("") }
    var ciIntegration by remember(organizationId) { mutableStateOf("") }
    var ciGeneration by remember(organizationId) { mutableStateOf("") }
    var codeBaseline by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var includeCode by remember(organizationId) { mutableStateOf(false) }
    var includeReport by remember(organizationId) { mutableStateOf(false) }
    var reviewForm by remember(organizationId) { mutableStateOf(false) }
    var sessionContext by remember(organizationId, sessionId) { mutableStateOf<JsonObject?>(null) }
    var confirmSessionContext by remember(organizationId, sessionId) { mutableStateOf(false) }
    var responsibilityBanner by remember(organizationId, sessionId) { mutableStateOf<String?>(null) }
    suspend fun executeJsonObject(method: String, path: String, body: JsonObject? = null): JsonObject {
        val response = transport.execute(ApiRequest(
            method = method,
            path = path,
            body = body?.toString(),
            contentType = if (body == null) null else "application/json",
        ))
        if (!response.isSuccessful) throw parseOrganizationApiException(response.statusCode, response.body, "HTTP ${response.statusCode}")
        return Json.parseToJsonElement(response.body).jsonObject
    }
    suspend fun request(path: String, body: JsonObject? = null): JsonObject =
        executeJsonObject(if (body == null) "GET" else "POST", base + path, body)
    suspend fun reload() {
        item = null; responsibilities = null; responsibility = null; status = "Loading work items…"
        runCatching { request("/work-items") }.onSuccess { list = it; status = "As of ${it["asOf"]?.jsonPrimitive?.contentOrNull.orEmpty()}" }
            .onFailure { if (it is CancellationException) throw it; list = null; status = "Work items unavailable: ${it.message}" }
    }
    suspend fun responsibilityRequest(path: String): JsonObject =
        executeJsonObject("GET", "/api/responsibilities$path")
    suspend fun loadResponsibilities() {
        status = "Loading responsibilities…"; item = null; responsibility = null; proposal = null
        val loaded = fetchResponsibilitiesOrBanner(transport, organizationId)
        capabilities = loaded.capabilities
        responsibilityFeatures = loaded.features
        planCatalogDescriptors = loaded.planCatalogDescriptors
        responsibilities = loaded.responsibilities
        status = if (loaded.banner == null) "Responsibilities" else "Responsibilities unavailable"
        responsibilityBanner = loaded.banner
    }
    suspend fun propose(id: String) {
        val body = buildJsonObject { put("text", responsibilityDraft); put("responsibilityId", id) }
        val path = "/api/responsibilities/intent"
        runCatching { executeJsonObject("POST", path, body) }
            .onSuccess { proposal = it; status = "Review the proposal. Voice or draft text is not authorization." }
            .onFailure { err ->
                if (err is CancellationException) throw err
                status = "Proposal unavailable: ${err.message}"
                if (err is ApiException && isOrganizationFeatureUnavailableStatus(err.statusCode, err.code, path)) {
                    responsibilityBanner = formatOrganizationFeatureUnavailableBanner(err, "Proposal unavailable")
                }
            }
    }
    suspend fun submitResponsibility(path: String, body: JsonObject, method: String = "POST") {
        pendingResponsibility = Triple(path, method, body)
        runCatching { executeJsonObject(method, path, body) }
            .onSuccess { result ->
                pendingResponsibility = null; proposal = null; form = ""; reviewForm = false
                status = when {
                    path.endsWith("/wake") -> "Report request recorded; execution has not been established."
                    path.endsWith("/trigger-bindings") -> "Schedule recorded; a trigger does not prove execution."
                    else -> "Request recorded; actual stop is not established. Stop requests: ${result["stop"] ?: "none"}. Refresh for current facts."
                }
            }
            .onFailure { err ->
                if (err is CancellationException) throw err
                if (err is ApiException && err.statusCode == 409) {
                    pendingResponsibility = null; weeklyEligibility = null; weeklyReview = false
                    status = "The responsibility or authorization changed. Refresh before trying again."
                } else status = "Request not confirmed: ${err.message}; retry uses the same key."
                if (err is ApiException && isOrganizationFeatureUnavailableStatus(err.statusCode, err.code, path)) {
                    responsibilityBanner = formatOrganizationFeatureUnavailableBanner(err, "Responsibility action unavailable")
                }
            }
    }
    suspend fun loadResponsibility(id: String) {
        linkedReviews = emptyList(); linkedReviewsIncomplete = false; weeklyEligibility = null; weeklyReview = false; weeklyManualReview = false; responsibility = null
        status = "Loading responsibility…"; plannerReview = false; plannerNetworkConfirmed = false; autoReportPlans = false; reportReview = false; reportNetworkConfirmed = false; ciPolicyReviewed = false; codeBaseline = null; includeCode = false; includeReport = false; reviewTrigger = false; reviewRunTrigger = false; reviewGitCondition = false; reviewedBindingAction = null; triggerBindings = null; memoryData = null; memoryConflictData = null; memoryChanges = emptyMap(); memoryPreview = null; responsibilityNotifications = null; pendingNotificationToggle = null
        val path = "/${Uri.encode(id)}"
        runCatching {
            val response = responsibilityRequest(path)
            val detail = response["responsibility"]!!.jsonObject
            require(detail["organizationId"]?.jsonPrimitive?.contentOrNull == organizationId)
            responsibilityPolicy = response["policy"] as? JsonObject
            weeklyEligibility = try { responsibilityRequest("$path/weekly-report") } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
            responsibilityPlans = runCatching { responsibilityRequest("$path/plans")["plans"] as? JsonArray }.getOrNull()
            responsibilityNotifications = runCatching { responsibilityRequest("$path/notifications") }.getOrNull()
            if (responsibilityFeatures?.get("timeTriggerBridge")?.jsonPrimitive?.booleanOrNull == true) triggerBindings = runCatching { responsibilityRequest("$path/trigger-bindings")["bindings"] as? JsonArray }.getOrNull()
            val focusedPlan = selectedPlanId?.takeIf { it.isNotBlank() }?.let { targetPlanId ->
                responsibilityPlans?.mapNotNull { it as? JsonObject }?.firstOrNull { plan ->
                    plan["id"]?.jsonPrimitive?.contentOrNull == targetPlanId &&
                        plan["state"]?.jsonPrimitive?.contentOrNull == "pending_review" &&
                        plan["proposal"] is JsonObject && plan["catalog"] is JsonArray &&
                        plan["proposalDigest"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true
                }
            }
            reviewedPlan = focusedPlan
            detail to responsibilityRequest("$path/activity")["activity"]!!.jsonArray
        }.onSuccess { (detail, activity) -> responsibility = detail; responsibilityActivity = activity; onResponsibilitySelected(id); status = "Responsibility"; responsibilityBanner = null }
            .onFailure { err ->
                if (err is CancellationException) throw err
                status = "Responsibility unavailable: ${err.message}"
                if (err is ApiException && isOrganizationFeatureUnavailableStatus(err.statusCode, err.code, "/api/responsibilities$path")) {
                    responsibilityBanner = formatOrganizationFeatureUnavailableBanner(err, "Responsibility unavailable")
                }
            }
    }
    suspend fun resolveNotificationReviews(id: String) {
        linkedReviews = emptyList(); linkedReviewsIncomplete = false
        if (onOpenWorkItem == null || selectedPlanId != null) return
        try {
            val response = responsibilityRequest("/${Uri.encode(id)}")
            val detail = response["responsibility"] as? JsonObject ?: error("Responsibility unavailable")
            require(detail["id"]?.jsonPrimitive?.contentOrNull == id && detail["organizationId"]?.jsonPrimitive?.contentOrNull == organizationId)
            val summary = response["workSummary"] as? JsonArray ?: error("Linked work unavailable")
            val projectId = detail["projectId"]?.jsonPrimitive?.contentOrNull ?: error("Project unavailable")
            val ids = summary.mapNotNull { entry ->
                val row = entry as? JsonObject ?: error("Invalid linked work")
                if (row["state"]?.jsonPrimitive?.contentOrNull == "review") row["workItemId"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: error("Missing linked work ID") else null
            }.distinct()
            if (ids.size > 100) { linkedReviewsIncomplete = true; return }
            val reviews = ids.mapNotNull { workId ->
                val work = request("/work-items/${Uri.encode(workId)}")["item"] as? JsonObject ?: error("Work unavailable")
                require(work["id"]?.jsonPrimitive?.contentOrNull == workId && work["projectId"]?.jsonPrimitive?.contentOrNull == projectId)
                val contract = work["contract"] as? JsonObject
                val resource = contract?.get("resource") as? JsonObject
                val digest = work["candidateDigest"]?.jsonPrimitive?.contentOrNull
                val candidate = (work["candidates"] as? JsonArray)?.mapNotNull { it as? JsonObject }?.firstOrNull {
                    it["digest"]?.jsonPrimitive?.contentOrNull == digest && it["contractRevision"] == work["contractRevision"] &&
                        it["executionEpoch"] == work["executionEpoch"] && it["bindingGeneration"] == work["bindingGeneration"]
                }
                val isReport = contract?.get("accessMode")?.jsonPrimitive?.contentOrNull == "read" &&
                    (contract["allowedPaths"] as? JsonArray)?.isEmpty() == true && resource?.get("readScope")?.jsonPrimitive?.contentOrNull == "entire_project" &&
                    resource["projectId"]?.jsonPrimitive?.contentOrNull == projectId
                if (work["state"]?.jsonPrimitive?.contentOrNull == "review" && !digest.isNullOrBlank() && candidate != null && isReport) work else null
            }
            linkedReviews = reviews
            if (reviews.size == 1) onOpenWorkItem(reviews.single()["id"]!!.jsonPrimitive.content)
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { linkedReviewsIncomplete = true }
    }
    suspend fun submit(command: JsonObject) {
        pending = command; status = "Submitting request…"
        runCatching { request("/commands", command) }.onSuccess {
            pending = null
            status = "Receipt: ${it["operation"]}; task: ${it["item"]?.jsonObject?.get("controlState")}. Refresh for current facts."
        }.onFailure { if (it is CancellationException) throw it; status = "Request not confirmed: ${it.message}. Retry uses the same command ID." }
    }
    val latestSelectedResponsibilityId = rememberUpdatedState(selectedResponsibilityId)
    val latestNavigationKey = rememberUpdatedState(responsibilityNavigationKey)
    var initialized by remember(transport, organizationId) { mutableStateOf(false) }
    var lastHandledNavKey by remember(transport, organizationId) { mutableStateOf<String?>(null) }
    LaunchedEffect(transport, organizationId) {
        val (fetchedContext, contextBanner) = fetchResponsibilityContextOrBanner(transport, sessionId)
        sessionContext = fetchedContext
        responsibilityBanner = contextBanner
        val targetId = latestSelectedResponsibilityId.value
        lastHandledNavKey = latestNavigationKey.value
        initialized = true
        val resumeId = targetId ?: sessionContext?.takeIf { it["organizationId"]?.jsonPrimitive?.contentOrNull == organizationId }?.get("responsibilityId")?.jsonPrimitive?.contentOrNull
        if (resumeId == null) reload() else { loadResponsibilities(); loadResponsibility(resumeId); if (lastHandledNavKey != null && responsibility?.get("id")?.jsonPrimitive?.contentOrNull == resumeId) resolveNotificationReviews(resumeId) }
    }
    LaunchedEffect(transport, organizationId, selectedResponsibilityId, responsibilityNavigationKey) {
        if (!initialized) return@LaunchedEffect
        val targetId = selectedResponsibilityId?.takeIf { it.isNotBlank() } ?: return@LaunchedEffect
        val currentId = responsibility?.get("id")?.jsonPrimitive?.contentOrNull
        val isNewDeepLink = responsibilityNavigationKey != null && responsibilityNavigationKey != lastHandledNavKey
        if (!isNewDeepLink && targetId == currentId) return@LaunchedEffect
        lastHandledNavKey = responsibilityNavigationKey
        if (responsibilities == null) loadResponsibilities()
        loadResponsibility(targetId)
        if (isNewDeepLink && responsibility?.get("id")?.jsonPrimitive?.contentOrNull == targetId) resolveNotificationReviews(targetId)
    }
    LaunchedEffect(organizationId, item?.get("id")) {
        itemBudget = null; itemReconciliation = null; scopedPreview = null; scopedPending = null; scopedObjective = ""; scopedCriterion = ""; multiObjectives = emptyMap(); multiCriteria = emptyMap(); multiPreview = null; multiPending = null
        val id = item?.get("id")?.jsonPrimitive?.contentOrNull
        if (!id.isNullOrBlank()) {
            itemReconciliation = runCatching { request("/work-items/${Uri.encode(id)}/reconcile") }.getOrNull()
            itemBudget = runCatching { request("/work-items/${Uri.encode(id)}/budget") }.getOrNull()
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TextButton(onClick = { if (responsibility != null) { onResponsibilitySelected(null); scope.launch { loadResponsibilities() } } else if (item != null || responsibilities != null) scope.launch { reload() } else onBack() }) { Text("Back") }
        Text("Work items")
        Text(status)
        responsibilityBanner?.let { banner ->
            FactoryInlineBanner(
                text = banner,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 6.dp)
                    .testTag("factory-responsibility-banner"),
            )
        }
        if (pending != null) TextButton(onClick = { pending?.let { scope.launch { submit(it) } } }) { Text("Retry same request") }
        val selected = item
        if (responsibilities != null) {
            val current = responsibility
            if (current == null) {
                Text("A draft records an objective; execution needs a separately reviewed policy and an available adapter.")
                if (capabilities == null) Text("Adapter availability is unavailable; no execution capability is assumed.")
                capabilities?.forEach { Text("Adapter: $it") }
                responsibilities?.forEach { entry ->
                    val row = entry.jsonObject
                    val id = row["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
                    TextButton(onClick = { scope.launch { loadResponsibility(id) } }) { Text("${row["objective"]?.jsonPrimitive?.contentOrNull.orEmpty()} · ${row["lifecycle"]?.jsonPrimitive?.contentOrNull.orEmpty()}") }
                }
                TextButton(onClick = { scope.launch { loadResponsibilities() } }) { Text("Refresh") }
                TextButton(onClick = { form = "create"; reviewForm = false; objective = responsibilityDraft }) { Text("Create responsibility") }
            } else {
                Text(current["objective"]?.jsonPrimitive?.contentOrNull.orEmpty())
                if (responsibilityFeatures?.get("timeTriggerBridge")?.jsonPrimitive?.booleanOrNull == true) {
                    val days = listOf(
                        stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_sunday),
                        stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_monday),
                        stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_tuesday),
                        stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_wednesday),
                        stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_thursday),
                        stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_friday),
                        stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_saturday),
                    )
                    Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_title), style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_gate))
                    val reportPolicy = responsibilityPolicy?.get("providerId")?.jsonPrimitive?.contentOrNull == "project-report"
                    val active = current["lifecycle"]?.jsonPrimitive?.contentOrNull == "active"
                    if (!weeklyManualReview) TextButton(enabled = reportPolicy && active && pendingResponsibility == null, onClick = { weeklyManualReview = true }) { Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_manual)) }
                    else {
                        Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_manual_confirm))
                        TextButton(enabled = reportPolicy && active && pendingResponsibility == null, onClick = {
                            val body = buildJsonObject { put("expectedVersion", current["rowVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString()); put("confirmed", true) }
                            scope.launch { submitResponsibility("/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}/wake", body); weeklyManualReview = false }
                        }) { Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_manual_submit)) }
                    }
                    val baseline = weeklyEligibility?.get("baseline") as? JsonObject
                    if (baseline != null) {
                        Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_baseline, baseline["workItemId"]?.jsonPrimitive?.contentOrNull.orEmpty(), baseline["candidateDigest"]?.jsonPrimitive?.contentOrNull.orEmpty(), baseline["acceptedAt"]?.jsonPrimitive?.contentOrNull.orEmpty()))
                        val source = baseline["source"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        val report = baseline["report"] as? JsonObject
                        Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_baseline_context, baseline["runId"]?.jsonPrimitive?.contentOrNull.orEmpty().ifBlank { "—" }, source.ifBlank { "—" }, baseline["packetId"]?.jsonPrimitive?.contentOrNull.orEmpty().ifBlank { "—" }))
                        Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_model_statement))
                        Text(report?.get("visibleText")?.jsonPrimitive?.contentOrNull.orEmpty().ifBlank { stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_content_unknown) })
                    }
                    Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_comparison_unavailable))
                    TextButton(onClick = { weeklyDayMenu = true }) { Text(days[weeklyDay]) }
                    DropdownMenu(expanded = weeklyDayMenu, onDismissRequest = { weeklyDayMenu = false }) {
                        days.forEachIndexed { index, day -> DropdownMenuItem(text = { Text(day) }, onClick = { weeklyDay = index; weeklyReview = false; weeklyDayMenu = false }) }
                    }
                    TextButton(onClick = { TimePickerDialog(context, { _, h, m -> weeklyHour = h; weeklyMinute = m; weeklyReview = false }, weeklyHour, weeklyMinute, true).show() }) { Text("%02d:%02d".format(weeklyHour, weeklyMinute)) }
                    TextButton(onClick = { weeklyZoneMenu = true }) { Text(weeklyZone) }
                    DropdownMenu(expanded = weeklyZoneMenu, onDismissRequest = { weeklyZoneMenu = false }) {
                        java.time.ZoneId.getAvailableZoneIds().sorted().forEach { zone -> DropdownMenuItem(text = { Text(zone) }, onClick = { weeklyZone = zone; weeklyReview = false; weeklyZoneMenu = false }) }
                    }
                    val eligible = weeklyEligibility?.get("eligible")?.jsonPrimitive?.booleanOrNull == true
                    if (!eligible) Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_unavailable) + " " + weeklyEligibility?.get("reason")?.jsonPrimitive?.contentOrNull.orEmpty())
                    if (!weeklyReview) TextButton(enabled = eligible && pendingResponsibility == null, onClick = { weeklyReview = true }) { Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_review)) }
                    else {
                        Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_confirm_details, days[weeklyDay], "%02d:%02d".format(weeklyHour, weeklyMinute), weeklyZone))
                        TextButton(enabled = eligible && pendingResponsibility == null, onClick = {
                            val body = buildJsonObject { put("type", "weekly_report"); put("weekday", weeklyDay); put("hour", weeklyHour); put("minute", weeklyMinute); put("timeZone", weeklyZone); put("confirmed", true); put("expectedVersion", current["rowVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString()) }
                            scope.launch {
                                val responsibilityId = current["id"]!!.jsonPrimitive.content
                                submitResponsibility("/api/responsibilities/${Uri.encode(responsibilityId)}/trigger-bindings", body)
                                weeklyReview = false
                                if (pendingResponsibility == null) loadResponsibility(responsibilityId)
                            }
                        }) { Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_enable)) }
                    }
                }
                Text("Responsibility ${current["lifecycle"]}; version ${current["rowVersion"]}; policy ${current["policyRevision"]}")
                Text("A paused responsibility stops new admission; existing work may continue.")
                Text("A stop request is not proof of stopping. Unknown or older active executions need reconciliation; a run that finished first remains pending review. Archived history is retained.")
                val topPendingPlans = responsibilityPlans?.mapNotNull { it as? JsonObject }?.filter {
                    it["state"]?.jsonPrimitive?.contentOrNull == "pending_review"
                }.orEmpty()
                if (topPendingPlans.isNotEmpty()) {
                    Text("Pending plans awaiting owner review: ${topPendingPlans.size}")
                    topPendingPlans.forEach { plan ->
                        val pid = plan["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        val focused = pid == selectedPlanId
                        Text("${if (focused) "[Focused] " else ""}Plan $pid · digest ${plan["proposalDigest"]}")
                        if (reviewedPlan?.get("id")?.jsonPrimitive?.contentOrNull != pid &&
                            plan["proposal"] is JsonObject && plan["catalog"] is JsonArray &&
                            plan["proposalDigest"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true) {
                            TextButton(onClick = { reviewedPlan = plan }) { Text("Review plan $pid") }
                        }
                    }
                }
                reviewedPlan?.let { plan ->
                    Text("Approve only this plan: ${plan["proposal"]} · digest ${plan["proposalDigest"]} · responsibility version ${current["rowVersion"]}")
                    TextButton(onClick = {
                        val planId = plan["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        val body = buildJsonObject { put("expectedVersion", current["rowVersion"]!!); put("proposalDigest", plan["proposalDigest"]!!); put("idempotencyKey", UUID.randomUUID().toString()); put("confirmed", true) }
                        scope.launch {
                            submitResponsibility("/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}/plans/${Uri.encode(planId)}/approve", body)
                            reviewedPlan = null
                            loadResponsibility(current["id"]!!.jsonPrimitive.content)
                        }
                    }) { Text("Confirm this plan") }
                }
                if (responsibilityFeatures?.get("timeTriggerBridge")?.jsonPrimitive?.booleanOrNull == true) {
                    Text("触发只记录唤醒请求，不代表工作已经启动。")
                    if (triggerBindings == null) Text("Schedules unavailable.")
                    triggerBindings?.forEach { entry -> val binding=entry.jsonObject
                        val config = binding["config"] as? JsonObject
                        if (config?.get("type")?.jsonPrimitive?.contentOrNull == "weekly_report") {
                            val days = listOf(
                                stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_sunday), stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_monday),
                                stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_tuesday), stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_wednesday),
                                stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_thursday), stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_friday), stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_saturday))
                            val day = config["weekday"]?.jsonPrimitive?.intOrNull?.let { days.getOrNull(it) }.orEmpty().ifBlank { "—" }
                            val hour = config["hour"]?.jsonPrimitive?.intOrNull
                            val minute = config["minute"]?.jsonPrimitive?.intOrNull
                            val time = if (hour != null && minute != null) "%02d:%02d".format(hour, minute) else "—"
                            Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_schedule_status, day, time, config["timeZone"]?.jsonPrimitive?.contentOrNull.orEmpty(), binding["state"]?.jsonPrimitive?.contentOrNull.orEmpty(), binding["nextScheduledAt"]?.jsonPrimitive?.contentOrNull.orEmpty().ifBlank { "—" }))
                        } else Text("Schedule ${binding["config"]} · ${binding["state"]} · delivery ${binding["delivery"] ?: "unknown"} · ${binding["lastError"] ?: ""}")
                        if ((binding["config"] as? JsonObject)?.get("type")?.jsonPrimitive?.contentOrNull == "event") Text("来源：组织根会话中保留的执行记录，创建后开始观察。来源状态 ${binding["source"] ?: "未知"}；待处理 ${binding["pendingCount"] ?: "未知"}。发现前已删除或漏索引的记录可能遗漏；发现后才持久化。")
                        val sourceError = (binding["source"] as? JsonObject)?.get("lastError")?.jsonPrimitive?.contentOrNull
                        if (sourceError == "receipt_capacity") Text("历史回执已达容量上限；普通恢复无法释放历史。请先核对未收区间，再撤销并重新绑定新的观察起点；可能存在遗漏。")
                        if (sourceError == "pending_capacity") Text("待处理队列已满，队列排空后会继续观察。")
                        val sourceStatus = (binding["source"] as? JsonObject)?.get("status")?.jsonPrimitive?.contentOrNull
                        if (sourceStatus in listOf("source_unavailable", "retention_gap")) Text("来源不可用或可能存在未观察区间；请核对来源和历史后再审阅恢复，不能假设没有遗漏。")
                        val delivery = binding["delivery"] as? JsonObject
                        if (delivery?.get("status")?.jsonPrimitive?.contentOrNull == "failed" && delivery["lastError"]?.jsonPrimitive?.contentOrNull == "Trigger binding is inactive") Text("暂停期间错过触发，等待恢复确认。请先恢复责任，再审阅恢复该日程。")
                        listOf("revoke","recover").forEach { action -> TextButton(onClick = { reviewedBindingAction = binding to action }) { Text("Review $action schedule") } }
                    }
                    reviewedBindingAction?.let { (binding, action) ->
                        Text("$action this schedule, version ${binding["version"]}? This does not establish that work has stopped.")
                        TextButton(onClick = {
                            val body=buildJsonObject { put("confirmed",true); put("expectedVersion",binding["version"]!!); put("idempotencyKey",UUID.randomUUID().toString()) }
                            scope.launch { submitResponsibility("/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}/trigger-bindings/${Uri.encode(binding["id"]!!.jsonPrimitive.content)}/$action",body); reviewedBindingAction = null }
                        }) { Text("Confirm $action schedule") }
                    }
                    OutlinedTextField(triggerTime,{triggerTime=it;reviewTrigger=false},label={Text("Scheduled time (ISO with timezone)")})
                    OutlinedTextField(triggerInterval,{triggerInterval=it;reviewTrigger=false},label={Text("Repeat minutes (blank for once)")})
                    val interval=triggerInterval.toLongOrNull()
                    if(!reviewTrigger) TextButton(enabled=triggerTime.isNotBlank() && (triggerInterval.isBlank() || interval?.let { it in 1L..525600L } == true),onClick={reviewTrigger=true}) { Text("Review schedule") }
                    else { Text("Schedule $triggerTime${if(interval!=null) " every $interval minutes" else " once"}; a wake is not proof of execution.")
                        TextButton(onClick={ val body=buildJsonObject { put("type","at_time"); put("scheduledAt",triggerTime); if(interval!=null)put("intervalMs",interval*60000); put("confirmed",true); put("expectedVersion",current["rowVersion"]!!); put("idempotencyKey",UUID.randomUUID().toString()) }; scope.launch { submitResponsibility("/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}/trigger-bindings",body); reviewTrigger=false } }) { Text("Confirm schedule") }
                    }
                    if (responsibilityFeatures?.get("eventTriggerBridge")?.jsonPrimitive?.booleanOrNull == true) {
                        if (!reviewRunTrigger) TextButton(onClick={reviewRunTrigger=true}) { Text("审阅根会话执行结果触发") }
                        else { Text("从此绑定创建后开始，尽力观察组织根会话中保留的已结束执行记录；发现前已删除或漏索引的记录可能遗漏，发现后才持久化。此触发不授予额外权限，也不保证执行已启动。")
                            TextButton(onClick={val body=buildJsonObject {put("type","event");put("eventType","run_terminal");put("source",buildJsonObject {put("kind","root_session")});put("observeFrom","binding_created");put("confirmed",true);put("expectedVersion",current["rowVersion"]!!);put("idempotencyKey",UUID.randomUUID().toString())};scope.launch {submitResponsibility("/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}/trigger-bindings",body);reviewRunTrigger=false}}) { Text("确认创建执行结果触发") }
                        }
                    }
                }
                val notifications = responsibilityNotifications
                if (notifications == null) {
                    Text("Responsibility notification status is unavailable. Activity remains available in the app.")
                } else {
                    val optIn = notifications["enabled"]?.jsonPrimitive?.booleanOrNull == true
                    val notifVersion = notifications["version"]?.jsonPrimitive?.longOrNull ?: 0L
                    val deliveryEnabled = notifications["deliveryEnabled"]?.jsonPrimitive?.booleanOrNull == true
                    val cloudPush = notifications["accountCloudPush"] as? JsonObject
                    val cloudConfigured = cloudPush?.get("configured")?.jsonPrimitive?.booleanOrNull == true
                    Text("Notifications: opt-in ${if (optIn) "on" else "off"} · server delivery ${if (deliveryEnabled) "enabled" else "disabled"} · Android Account Cloud Push ${if (cloudConfigured && deliveryEnabled) "configured" else if (cloudConfigured) "account bound (server delivery disabled)" else "not configured"}. Accounts acceptance is not proof of Firebase delivery or user reading.")
                    TextButton(onClick = { pendingNotificationToggle = !optIn }) {
                        Text(if (optIn) "Review disabling notifications" else "Review enabling notifications")
                    }
                    pendingNotificationToggle?.let { targetEnabled ->
                        Text("${if (targetEnabled) "Enable" else "Disable"} notifications (Web Push & Account Cloud Push) for this responsibility, settings version $notifVersion? Provider acceptance does not prove reading.")
                        TextButton(onClick = {
                            val id = current["id"]!!.jsonPrimitive.content
                            val body = buildJsonObject {
                                put("enabled", targetEnabled)
                                put("expectedVersion", notifVersion)
                                put("idempotencyKey", UUID.randomUUID().toString())
                                put("confirmed", true)
                            }
                            scope.launch {
                                submitResponsibility("/api/responsibilities/${Uri.encode(id)}/notifications", body, "PUT")
                                pendingNotificationToggle = null
                                responsibilityNotifications = runCatching { responsibilityRequest("/${Uri.encode(id)}/notifications") }.getOrNull()
                            }
                        }) { Text("Confirm notification setting") }
                    }
                    (notifications["receipts"] as? JsonArray)?.take(5)?.forEach { entry ->
                        val receipt = entry as? JsonObject ?: return@forEach
                        Text("Receipt [${receipt["channel"] ?: "web_push"}] · ${receipt["type"]} · ${receipt["state"]} · ${receipt["updatedAt"]} (provider status, not proof of reading)")
                    }
                }
                TextButton(onClick={scope.launch {runCatching { val path="/${Uri.encode(current["id"]!!.jsonPrimitive.content)}/memory"; responsibilityRequest(path) to responsibilityRequest("$path/conflicts") }.onSuccess { (memory,conflicts) -> memoryData=memory; memoryConflictData=conflicts; memoryChanges=emptyMap();memoryPreview=null }.onFailure {status="记忆不可用：${it.message}"}}}) { Text("查看记忆和可能冲突") }
                memoryConflictData?.let { conflicts ->
                    Text("仅为可能冲突，不判断真假；保留双方只针对当前版本。${if (conflicts["truncated"]?.jsonPrimitive?.booleanOrNull == true) "候选不完整。" else ""}")
                    (conflicts["groups"] as? JsonArray)?.forEach { Text("候选与来源：$it") }
                    val memory = memoryData?.get("memory") as? JsonObject
                    (memory?.get("currentFacts") as? JsonArray)?.mapNotNull {it as? JsonObject}?.filter {it["state"]?.jsonPrimitive?.contentOrNull=="active"}?.forEach { fact ->
                        val id=fact["factId"]?.jsonPrimitive?.contentOrNull.orEmpty(); if(id.isNotBlank()) {
                            Text("事实：${fact["factValue"]} · $id")
                            TextButton(onClick={memoryChanges=if(memoryChanges.containsKey(id)) memoryChanges-id else memoryChanges+(id to ("keep" to ""));memoryPreview=null}) {Text(if(memoryChanges.containsKey(id)) "取消选择" else "选择事实")}
                            memoryChanges[id]?.let { (action,value) ->
                                listOf("keep","correct","retract").forEach { next -> TextButton(onClick={memoryChanges=memoryChanges+(id to (next to value));memoryPreview=null}) {Text("${if(action==next) "✓ " else ""}$next")} }
                                if(action=="correct") OutlinedTextField(value,{memoryChanges=memoryChanges+(id to (action to it));memoryPreview=null},label={Text("更正后的值")})
                            }
                        }
                    }
                    TextButton(enabled=memoryChanges.size in 2..20 && memoryChanges.values.all {it.first!="correct" || it.second.isNotBlank()},onClick={scope.launch {runCatching {
                        val changes=JsonArray(memoryChanges.map { (id,choice) -> buildJsonObject {put("factId",id);put("action",choice.first);if(choice.first=="correct")put("value",choice.second)} });val body=buildJsonObject {put("factIds",JsonArray(memoryChanges.keys.map {JsonPrimitive(it)}));put("changes",changes);put("expectedVersion",conflicts["version"]!!)}
                        val result=executeJsonObject("POST","/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}/memory/conflicts/preview",body);buildJsonObject {put("request",body);put("result",result)}
                    }.onSuccess {memoryPreview=it}.onFailure {status="预览不可用：${it.message}"}}}) {Text("预览事实审阅")}
                    memoryPreview?.let { saved -> val result=saved["result"]!!.jsonObject;val preview=result["preview"]!!.jsonObject
                        Text("事实和来源：${preview["facts"]}\n处理：${preview["changes"]}\n原摘要：${preview["previousSummary"]}\n重建正文：${preview["projectedContent"]}\n重建摘要：${preview["projectedSummary"]}\n到期：${preview["expiresAt"]}。撤回不是物理删除。")
                        if(memoryData?.get("revisionEnabled")?.jsonPrimitive?.booleanOrNull==true) TextButton(onClick={val original=saved["request"]!!.jsonObject;val body=buildJsonObject {original.forEach {(key,value)->put(key,value)};put("previewDigest",result["previewDigest"]!!);put("confirmed",true);put("idempotencyKey",UUID.randomUUID().toString())};memoryPreview=null;scope.launch {submitResponsibility("/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}/memory/conflicts/commit",body)}}) {Text("确认事实审阅")}
                        else Text("记忆写入当前关闭，不能提交。")
                    }
                }
                Text("Policy (not plan approval): ${responsibilityPolicy ?: "unavailable"}")
                if (responsibilityFeatures?.get("committedGitChangesOnly")?.jsonPrimitive?.booleanOrNull == true && responsibilityPolicy?.get("providerId")?.jsonPrimitive?.contentOrNull in listOf("generic-planner", "project-report")) {
                    val enabled = responsibilityPolicy?.get("committedGitChangesOnly")?.jsonPrimitive?.booleanOrNull == true
                    Text("已提交 Git 版本变化条件：${if (enabled) "开启" else "关闭"}。仅周期及时间触发比较本地已提交 HEAD 与分支；未提交、未跟踪、忽略文件及网络资料不在范围内，瞬时 A→B→A 可能漏过。手动唤醒和执行结果触发不受此条件限制；游离 HEAD 或无法读取时等待，不视为无变化。")
                    if (!reviewGitCondition) TextButton(onClick = { reviewGitCondition = true }) { Text(if (enabled) "审阅关闭 Git 变化条件" else "审阅启用 Git 变化条件") }
                    else { Text("确认更新责任政策；此操作不授予额外工具权限。")
                        TextButton(onClick = { val policy = buildJsonObject { responsibilityPolicy?.forEach { (key, value) -> if (key != "digest" && key != "committedGitChangesOnly") put(key, value) }; put("committedGitChangesOnly", !enabled) }; val body = buildJsonObject { put("policy", policy); put("expectedVersion", current["rowVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString()) }; scope.launch { submitResponsibility("/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}", body, "PATCH"); reviewGitCondition = false } }) { Text("确认更新条件") }
                    }
                }
                val planner = capabilities?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == "generic-planner" && it["available"]?.jsonPrimitive?.booleanOrNull == true }
                val plannerTemplate = (planner?.get("templates") as? JsonArray)?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == "ragent-responsibility-planner" }
                val reportDescriptor = planCatalogDescriptors?.mapNotNull { it as? JsonObject }?.firstOrNull { it["capability"]?.jsonPrimitive?.contentOrNull == "project-report" && it["available"]?.jsonPrimitive?.booleanOrNull == true }
                val codeDescriptor = planCatalogDescriptors?.mapNotNull { it as? JsonObject }?.firstOrNull { it["capability"]?.jsonPrimitive?.contentOrNull == "project-code" && it["available"]?.jsonPrimitive?.booleanOrNull == true }
                if (planner?.get("digest") != null && plannerTemplate?.get("digest") != null && reportDescriptor?.get("templateDigest") != null) {
                    Text("Configure project read, network and budget below; select report and/or code. Plan review is required by default.")
                    OutlinedTextField(plannerNode, { plannerNode = it; plannerReview = false; plannerNetworkConfirmed = false }, label = { Text("Planner node ID") })
                    OutlinedTextField(plannerGeneration, { plannerGeneration = it; plannerReview = false; plannerNetworkConfirmed = false }, label = { Text("Planner node generation") })
                    TextButton(onClick = { includeReport = !includeReport; plannerReview = false; autoReportPlans = false }) { Text(if (includeReport) "Remove report capability" else "Add report capability") }
                    val resource = if (reportNetworkPolicy.isNotBlank()) buildJsonObject { put("projectId", current["projectId"]!!); put("readScope", "entire_project"); put("networkPolicy", reportNetworkPolicy) } else null
                    val attemptsValue = reportAttempts.toIntOrNull(); val costValue = reportCost.toDoubleOrNull(); val dailyValue = reportDailyCost.toDoubleOrNull(); val reportGenerationValue = reportGeneration.toLongOrNull()
                    val baseReady = attemptsValue != null && attemptsValue in 1..10 && costValue != null && costValue.isFinite() && costValue > 0 && dailyValue != null && dailyValue.isFinite() && dailyValue >= 0 && reportTimeZone.isNotBlank() && reportExpiry.isNotBlank() && (!includeReport || (reportNode.isNotBlank() && reportGenerationValue != null && reportGenerationValue > 0))
                    val existing = buildJsonObject { put("validUntil", reportExpiry); put("resource", resource ?: JsonNull); put("nodeBindings", buildJsonObject { put("report", buildJsonObject { put("nodeId", reportNode); put("bindingGeneration", reportGenerationValue ?: 0) }) }); put("maxAttempts", attemptsValue ?: 0); put("maxCost", costValue ?: 0.0); put("dailyBudget", buildJsonObject { put("timeZone", reportTimeZone); put("maxCost", dailyValue ?: 0.0) }) }
                    val inherits = resource?.get("networkPolicy")?.jsonPrimitive?.contentOrNull == "inherit_existing_permissions"
                    if (codeDescriptor != null) {
                        Text("Optional code capability requires a clean local baseline, bounded paths, registered check and independent human review. It is separate from project read access.")
                        TextButton(onClick = { scope.launch {
                            runCatching {
                                val data = executeJsonObject("POST", "/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}/code-baseline", buildJsonObject { })
                                data["baseline"]!!.jsonObject
                            }.onSuccess { codeBaseline = it; includeCode = false; plannerReview = false }.onFailure { status = "Code baseline unavailable: ${it.message}" }
                        } }) { Text("Capture clean code baseline") }
                        codeBaseline?.let { Text("Baseline: $it. Fill code paths, check and three node bindings in GitHub CI fields below; repository and branch come from this baseline.") }
                        if (codeBaseline != null) TextButton(onClick = { includeCode = !includeCode; plannerReview = false }) { Text(if (includeCode) "Remove separately authorized code capability" else "Add code capability for review") }
                    }
                    if (inherits && !plannerNetworkConfirmed) TextButton(onClick = { plannerNetworkConfirmed = true }) { Text("Separately confirm planner node's existing network and tool permissions") }
                    Text("Plan approval: ${if (autoReportPlans) "eligible report-only plans may be admitted automatically" else "every plan requires approval"}. Code and external publication always require human approval; report results still require review.")
                    TextButton(onClick = { autoReportPlans = false; plannerReview = false }) { Text("Require approval for every plan") }
                    if (includeReport && !autoReportPlans && reportDescriptor["autoEligible"]?.jsonPrimitive?.booleanOrNull == true) TextButton(onClick = { autoReportPlans = true; plannerReview = false }) { Text("Separately confirm automatic eligible report-only plans within this policy") }
                    TextButton(enabled = plannerNode.isNotBlank() && (plannerGeneration.toLongOrNull() ?: 0) > 0 && resource != null && baseReady && (includeReport || includeCode) && (!inherits || plannerNetworkConfirmed), onClick = { plannerReview = true }) { Text("Review planner authorization") }
                    if (plannerReview) {
                        Text("Review planner node $plannerNode generation $plannerGeneration; scope $resource; report catalog $reportDescriptor; existing report policy $existing. Code included: $includeCode; baseline $codeBaseline; allowed paths $ciPaths; candidate $ciCandidate; registered check $ciCheck; nodes $ciImplementation/$ciReviewNode/$ciIntegration; generations $ciGeneration. Automatic eligible report-only plans: $autoReportPlans; code requires human approval.")
                        val codeGenerations = ciGeneration.split(',').map { it.trim().toLongOrNull() }
                        val codeReady = !includeCode || (codeDescriptor != null && codeBaseline != null && listOf(ciPaths,ciCandidate,ciCheck,ciImplementation,ciReviewNode,ciIntegration).all { it.isNotBlank() } && codeGenerations.size == 3 && codeGenerations.all { it != null && it > 0 })
                        TextButton(enabled = codeReady, onClick = {
                            val oldBindings = existing["nodeBindings"]!!.jsonObject
                            val entry = buildJsonObject { put("capability", "project-report"); put("templateId", reportDescriptor["templateId"]!!); put("templateVersion", reportDescriptor["templateVersion"]!!); put("templateDigest", reportDescriptor["templateDigest"]!!); put("resource", resource!!); put("nodeBindings", buildJsonObject { put("report", oldBindings["report"]!!) }); put("maxAttempts", existing["maxAttempts"]!!); put("maxCost", existing["maxCost"]!!); if (autoReportPlans) { put("autoApproval", true); put("requiresHumanApproval", false) } }
                            val policy = buildJsonObject {
                                put("validUntil", existing["validUntil"]!!); put("providerId", planner["id"]!!); put("providerVersion", planner["version"]!!); put("providerDigest", planner["digest"]!!)
                                put("templateId", plannerTemplate["id"]!!); put("templateVersion", plannerTemplate["version"]!!); put("templateDigest", plannerTemplate["digest"]!!); put("resource", resource!!)
                                put("nodeBindings", buildJsonObject { put("planning", buildJsonObject { put("nodeId", plannerNode); put("bindingGeneration", plannerGeneration.toLong()) }) })
                                put("maxAttempts", existing["maxAttempts"]!!); put("maxCost", existing["maxCost"]!!); put("dailyBudget", existing["dailyBudget"]!!)
                                put("planCatalog", buildJsonArray { if (includeReport) add(entry); if (includeCode) add(buildJsonObject {
                                    put("capability", "project-code"); put("templateId", codeDescriptor!!["templateId"]!!); put("templateVersion", codeDescriptor["templateVersion"]!!); put("templateDigest", codeDescriptor["templateDigest"]!!)
                                    put("codeBaselineId", codeBaseline!!["id"]!!); put("repositoryFactId", codeBaseline!!["repositoryFactId"]!!); put("repository", codeBaseline!!["repository"]!!); put("targetBranch", codeBaseline!!["branch"]!!)
                                    put("allowedPaths", buildJsonArray { ciPaths.split(',').map { it.trim() }.filter { it.isNotEmpty() }.forEach { add(it) } }); put("candidateScope", ciCandidate); put("checkActionId", ciCheck)
                                    put("nodeBindings", buildJsonObject { listOf("implementation" to ciImplementation,"review" to ciReviewNode,"integration" to ciIntegration).forEachIndexed { index, pair -> put(pair.first, buildJsonObject { put("nodeId", pair.second); put("bindingGeneration", codeGenerations[index]!!) }) } })
                                    put("maxAttempts", existing["maxAttempts"]!!); put("maxCost", existing["maxCost"]!!)
                                }) }); put("planExecutionMaxAttempts", existing["maxAttempts"]!!.jsonPrimitive.int * if (includeCode && includeReport) 2 else 1); put("planExecutionMaxCost", existing["maxCost"]!!.jsonPrimitive.double * if (includeCode && includeReport) 2 else 1); put("planApproval", if (autoReportPlans && includeReport) "within_policy" else "always"); if (autoReportPlans && includeReport) put("planAutoAdmissionConfirmed", true)
                                if (inherits) put("networkPermissionConfirmed", plannerNetworkConfirmed)
                            }
                            val body = buildJsonObject { put("policy", policy); put("expectedVersion", current["rowVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString()) }
                            scope.launch { submitResponsibility("/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}", body, "PATCH"); plannerReview = false }
                        }) { Text("Confirm planner authorization") }
                    }
                }
                val ciProvider = capabilities?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == "github-ci" && it["available"]?.jsonPrimitive?.booleanOrNull == true }
                if (ciProvider != null) {
                    Text("GitHub CI policy: include repository, targetBranch, allowedPaths, candidateScope, registered checkActionId, implementation/review/integration node IDs and binding generations, maxAttempts, maxCost, dailyBudget and validUntil. The check is a registered action, not a shell command. Catalog: $ciProvider")
                    OutlinedTextField(ciRepository, { ciRepository = it; ciPolicyReviewed = false }, label = { Text("Repository owner/name") })
                    OutlinedTextField(ciBranch, { ciBranch = it; ciPolicyReviewed = false }, label = { Text("Target branch") })
                    OutlinedTextField(ciPaths, { ciPaths = it; ciPolicyReviewed = false; plannerReview = false }, label = { Text("Allowed project paths, comma separated") })
                    OutlinedTextField(ciCandidate, { ciCandidate = it; ciPolicyReviewed = false; plannerReview = false }, label = { Text("Candidate path within allowed paths") })
                    OutlinedTextField(ciCheck, { ciCheck = it; ciPolicyReviewed = false; plannerReview = false }, label = { Text("Existing registered check ID") })
                    OutlinedTextField(ciImplementation, { ciImplementation = it; ciPolicyReviewed = false; plannerReview = false }, label = { Text("Implementation node ID") })
                    OutlinedTextField(ciReviewNode, { ciReviewNode = it; ciPolicyReviewed = false; plannerReview = false }, label = { Text("Review node ID") })
                    OutlinedTextField(ciIntegration, { ciIntegration = it; ciPolicyReviewed = false; plannerReview = false }, label = { Text("Integration node ID") })
                    OutlinedTextField(ciGeneration, { ciGeneration = it; ciPolicyReviewed = false; plannerReview = false }, label = { Text("Node generations: implementation, review, integration") })
                    Text("Use the report authorization budget fields below for attempts, cost, daily limit, timezone and expiry, then prepare the CI policy for review.")
                    val ciTemplate = (ciProvider["templates"] as? JsonArray)?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == "ragent-reviewed-change" && it["version"]?.jsonPrimitive?.intOrNull == 3 }
                    TextButton(onClick = {
                        val generations = ciGeneration.split(',').map { it.trim().toLongOrNull() }
                        val attempts = reportAttempts.toIntOrNull(); val cost = reportCost.toDoubleOrNull(); val daily = reportDailyCost.toDoubleOrNull()
                        if (ciTemplate?.get("digest") != null && generations.size == 3 && generations.all { it != null && it > 0 } && attempts != null && attempts in 1..10 && cost != null && cost.isFinite() && cost > 0 && daily != null && daily.isFinite() && daily >= 0 && listOf(ciRepository,ciBranch,ciPaths,ciCandidate,ciCheck,ciImplementation,ciReviewNode,ciIntegration,reportTimeZone,reportExpiry).all { it.isNotBlank() }) {
                            val policy = buildJsonObject {
                                put("validUntil", reportExpiry); put("repository", ciRepository); put("templateId", "ragent-reviewed-change"); put("templateVersion", 3); put("templateDigest", ciTemplate["digest"]!!)
                                put("targetBranch", ciBranch); put("allowedPaths", buildJsonArray { ciPaths.split(',').map { it.trim() }.filter { it.isNotEmpty() }.forEach { add(it) } }); put("candidateScope", ciCandidate); put("checkActionId", ciCheck)
                                put("nodeBindings", buildJsonObject { listOf("implementation" to ciImplementation, "review" to ciReviewNode, "integration" to ciIntegration).forEachIndexed { index, pair -> put(pair.first, buildJsonObject { put("nodeId", pair.second); put("bindingGeneration", generations[index]!!) }) } })
                                put("maxAttempts", attempts); put("maxCost", cost); put("dailyBudget", buildJsonObject { put("timeZone", reportTimeZone); put("maxCost", daily) })
                            }
                            ciPolicyText = policy.toString(); ciPolicyReviewed = false
                        } else status = "Complete CI fields and budget with valid node generations."
                    }) { Text("Prepare GitHub CI policy") }
                    OutlinedTextField(ciPolicyText, { ciPolicyText = it; ciPolicyReviewed = false }, label = { Text("Advanced GitHub CI policy JSON") })
                    val parsedCiPolicy = runCatching { Json.parseToJsonElement(ciPolicyText) as? JsonObject }.getOrNull()
                    if (!ciPolicyReviewed) TextButton(enabled = parsedCiPolicy != null, onClick = { ciPolicyReviewed = true }) { Text("Review GitHub CI authorization") }
                    else {
                        Text("Authorize exactly this policy: $parsedCiPolicy. Existing work may continue until separately stopped.")
                        TextButton(enabled = parsedCiPolicy != null, onClick = {
                            val body = buildJsonObject { put("policy", parsedCiPolicy!!); put("expectedVersion", current["rowVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString()) }
                            scope.launch { submitResponsibility("/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}", body, "PATCH"); ciPolicyReviewed = false }
                        }) { Text("Confirm GitHub CI authorization") }
                    }
                }
                val reportProvider = capabilities?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == "project-report" && it["version"]?.jsonPrimitive?.intOrNull == 1 && it["available"]?.jsonPrimitive?.booleanOrNull == true }
                val reportTemplate = (reportProvider?.get("templates") as? JsonArray)?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == "ragent-project-report" && it["version"]?.jsonPrimitive?.intOrNull == 1 }
                if (reportProvider?.get("digest") != null && reportTemplate?.get("digest") != null) {
                    Text("Project report authorization: entire project readable; project file writes are blocked. Other tools remain subject to existing permissions; network isolation is not established. Manual or interval triggers may start the fixed report. Results require human review and are not verified facts.")
                    Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_project, current["projectId"]?.jsonPrimitive?.contentOrNull.orEmpty()))
                    Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_choose_node))
                    val reportNodes = nodes.filter { !it.sessionId.isNullOrBlank() && (it.currentBinding?.generation ?: 0L) > 0L && it.status.lowercase() !in setOf("retired", "inactive") }
                    if (reportNodes.isEmpty()) Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_no_node))
                    reportNodes.forEach { node -> TextButton(onClick = {
                        reportNode = node.id; reportGeneration = node.currentBinding!!.generation.toString()
                        reportReview = false; reportNetworkConfirmed = false; plannerReview = false
                    }) { Text((if (reportNode == node.id && reportGeneration == node.currentBinding?.generation?.toString()) "✓ " else "") + node.displayName.ifBlank { node.id }) } }
                    OutlinedTextField(reportAttempts, { reportAttempts = it; reportReview = false; plannerReview = false }, label = { Text("Maximum attempts (1–10)") })
                    OutlinedTextField(reportCost, { reportCost = it; reportReview = false; plannerReview = false }, label = { Text("Maximum cost") })
                    OutlinedTextField(reportDailyCost, { reportDailyCost = it; reportReview = false; plannerReview = false }, label = { Text("Maximum daily cost") })
                    TextButton(onClick = { reportTimeZone = weeklyZone; reportReview = false; plannerReview = false }) { Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_use_budget_zone, weeklyZone, reportTimeZone.ifBlank { "—" })) }
                    OutlinedTextField(reportExpiry, { reportExpiry = it; reportReview = false; plannerReview = false }, label = { Text("Authorization expiry (ISO time)") })
                    Text("Network policy: ${reportNetworkPolicy.ifBlank { "not selected" }}")
                    TextButton(onClick = { reportNetworkPolicy = "deny"; reportNetworkConfirmed = false; reportReview = false; plannerReview = false; plannerNetworkConfirmed = false }) { Text("Deny network (requires verified isolation)") }
                    TextButton(onClick = { reportNetworkPolicy = "inherit_existing_permissions"; reportNetworkConfirmed = false; reportReview = false; plannerReview = false; plannerNetworkConfirmed = false }) { Text("Review existing network and tool permissions") }
                    if (reportNetworkPolicy == "inherit_existing_permissions" && !reportNetworkConfirmed) {
                        Text("Filesystem read-only does not prevent external actions. This node retains existing network and tool permissions, with no domain restriction or proven network isolation.")
                        TextButton(onClick = { reportNetworkConfirmed = true; reportReview = false }) { Text("Separately confirm inherited network and tools") }
                    }
                    val generation = reportGeneration.toLongOrNull()
                    val attempts = reportAttempts.toIntOrNull()
                    val cost = reportCost.toDoubleOrNull()
                    val dailyCost = reportDailyCost.toDoubleOrNull()
                    val validReport = reportNodes.any { it.id == reportNode && it.currentBinding?.generation == generation } && generation != null && generation > 0 && attempts != null && attempts in 1..10 && cost != null && cost.isFinite() && cost > 0 && dailyCost != null && dailyCost.isFinite() && dailyCost >= 0 && reportTimeZone.isNotBlank() && reportExpiry.isNotBlank() && (reportNetworkPolicy == "deny" || (reportNetworkPolicy == "inherit_existing_permissions" && reportNetworkConfirmed))
                    if (!reportReview) TextButton(enabled = validReport, onClick = { reportReview = true }) { Text("Review report authorization") }
                    else {
                        Text("Authorize entire project ${current["projectId"]} read-only; node $reportNode generation $reportGeneration; network $reportNetworkPolicy; attempts $reportAttempts; cost $reportCost; daily cost $reportDailyCost in $reportTimeZone; expiry $reportExpiry; provider ${reportProvider["digest"]}; template ${reportTemplate["digest"]}.")
                        TextButton(enabled = validReport, onClick = {
                            val policy = buildJsonObject {
                                put("validUntil", reportExpiry); put("providerId", "project-report"); put("providerVersion", 1); put("providerDigest", reportProvider["digest"]!!)
                                put("templateId", "ragent-project-report"); put("templateVersion", 1); put("templateDigest", reportTemplate["digest"]!!)
                                put("resource", buildJsonObject { put("projectId", current["projectId"]!!); put("readScope", "entire_project"); put("networkPolicy", reportNetworkPolicy) })
                                if (reportNetworkPolicy == "inherit_existing_permissions") put("networkPermissionConfirmed", reportNetworkConfirmed)
                                put("nodeBindings", buildJsonObject { put("report", buildJsonObject { put("nodeId", reportNode); put("bindingGeneration", generation!!) }) })
                                put("maxAttempts", attempts!!); put("maxCost", cost!!); put("dailyBudget", buildJsonObject { put("timeZone", reportTimeZone); put("maxCost", dailyCost!!) })
                            }
                            val body = buildJsonObject { put("policy", policy); put("expectedVersion", current["rowVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString()) }
                            scope.launch { submitResponsibility("/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}", body, "PATCH"); reportReview = false }
                        }) { Text("Confirm report authorization") }
                    }
                }
                Text("Plans awaiting review")
                if (responsibilityPlans == null) Text("Plan review is unavailable.")
                responsibilityPlans?.forEach { entry ->
                    val plan = entry.jsonObject
                    Text("${plan["state"]} · ${plan["summary"]} · digest ${plan["proposalDigest"]}")
                    ((plan["proposal"] as? JsonObject)?.get("steps") as? JsonArray)?.forEach { step -> Text("Step: $step") }
                    Text("Authorized catalog and bounds: ${plan["catalog"] ?: "unavailable"}")
                    if (plan["proposal"] !is JsonObject) Text("Full proposal unavailable; approval is disabled.")
                    else Text("Full proposal: ${plan["proposal"]}")
                    if (plan["state"]?.jsonPrimitive?.contentOrNull == "pending_review" && plan["proposal"] is JsonObject && plan["catalog"] is JsonArray && plan["proposalDigest"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true) TextButton(onClick = { reviewedPlan = plan }) { Text("Review plan") }
                }
                (current["successCriteria"] as? JsonArray)?.forEach { Text(it.jsonPrimitive.content) }
                if (linkedReviewsIncomplete) Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_review_links_incomplete))
                if (linkedReviews.isNotEmpty()) {
                    Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_review_choose))
                    linkedReviews.forEach { review ->
                        val workId = review["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        val title = (review["contract"] as? JsonObject)?.get("objective")?.jsonPrimitive?.contentOrNull.orEmpty()
                        TextButton(onClick = { onOpenWorkItem?.invoke(workId) }) { Text("$title · $workId") }
                    }
                }
                Text("Activity")
                responsibilityActivity?.forEach { entry -> val activity = entry.jsonObject; val type = activity["type"]?.jsonPrimitive?.contentOrNull; val reason = (activity["details"] as? JsonObject)?.get("reason")?.jsonPrimitive?.contentOrNull
                    val detail=activity["details"] as? JsonObject; val identity="工作 ${detail?.get("workItemId") ?: "未知"} · 执行代次 ${detail?.get("executionEpoch") ?: "未知"} · 绑定 ${detail?.get("bindingId") ?: "未知"}"
                    val message = when { type == "budget_blocked" -> "预算准入被拒绝；不表示执行失败或已扣费。$identity"; type == "execution_attempt_failed" -> "一次执行尝试已核实失败，不代表整个责任失败。$identity"; type == "committed_git_unchanged" -> "已提交 Git 版本未变化，本次周期规划已跳过。"; type == "committed_git_changed_before_admission" -> "规划前后 Git 版本发生变化，本次未准入；需要重新观察。"; type == "decision_waiting" && reason == "committed_git_observation_unavailable" -> "无法核实已提交 Git 版本，等待处理；不视为无变化。"; else -> "$type · ${activity["details"] ?: ""}" }
                    Text("${activity["createdAt"]} · $message")
                    val workId = detail?.get("workItemId")?.jsonPrimitive?.contentOrNull
                    if (!workId.isNullOrBlank() && onOpenWorkItem != null) TextButton(onClick = { onOpenWorkItem(workId) }) { Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_review_open_work)) }
                }
                val spokenActivity = responsibilityActivity.orEmpty().mapNotNull { entry ->
                    val row = entry as? JsonObject ?: return@mapNotNull null
                    val type = row["type"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    "${row["createdAt"]?.jsonPrimitive?.contentOrNull.orEmpty()}: $type"
                }.joinToString(". ")
                if (spokenActivity.isNotBlank()) TextButton(enabled = speechReady, onClick = {
                    if (audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
                        speech?.speak(spokenActivity, TextToSpeech.QUEUE_FLUSH, null, "responsibility-activity")
                }) { Text("Read activity aloud") }
                TextButton(onClick = { speech?.stop(); audio.abandonAudioFocus(focusListener) }) { Text("Stop reading") }
                val id = current["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
                if (onOpenVoiceButler != null && id.isNotBlank()) {
                    TextButton(onClick = {
                        speech?.stop()
                        audio.abandonAudioFocus(focusListener)
                        onOpenVoiceButler(id, current["objective"]?.jsonPrimitive?.contentOrNull)
                    }) { Text("Open Voice Butler (continuous)") }
                }
                if (sessionId.isNotBlank()) {
                    if (!confirmSessionContext) TextButton(onClick = { confirmSessionContext = true }) { Text("Review session responsibility") }
                    else {
                        Text("Save ${current["objective"]} as this session's responsibility? This does not approve or run an action.")
                        TextButton(onClick = { scope.launch {
                            val body = buildJsonObject { put("responsibilityId", id); put("expectedVersion", sessionContext?.get("rowVersion") ?: JsonPrimitive(0));
                                put("expectedResponsibilityVersion", current["rowVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString());
                                put("confirmed", true); put("confirmedIntent", "query"); put("activityCursor", 0) }
                            val path = "/api/sessions/${Uri.encode(sessionId)}/responsibility-context"
                            runCatching {
                                val result = executeJsonObject("PUT", path, body)
                                result["context"]?.jsonObject
                            }.onSuccess { sessionContext = it; confirmSessionContext = false; responsibilityBanner = null; status = "Session responsibility saved; no action was approved." }
                                .onFailure { err ->
                                    if (err is CancellationException) throw err
                                    status = "Session context not confirmed: ${err.message}. Reload before retrying."
                                    if (err is ApiException && isOrganizationFeatureUnavailableStatus(err.statusCode, err.code, path)) {
                                        responsibilityBanner = formatOrganizationFeatureUnavailableBanner(err, "Session context unavailable")
                                    }
                                }
                        } }) { Text("Confirm session responsibility") }
                    }
                }
                TextButton(onClick = { form = "edit"; reviewForm = false; objective = current["objective"]?.jsonPrimitive?.contentOrNull.orEmpty() }) { Text("Edit objective") }
                listOf("pause", "resume", "wake", "complete", "cancel", "archive").forEach { action ->
                    TextButton(onClick = { proposal = buildJsonObject {
                        put("action", action); put("responsibilityId", id); put("objective", current["objective"]!!)
                        put("expectedVersion", current["rowVersion"]!!)
                    } }) { Text("Review $action") }
                }
                if (responsibilityDraft.isNotBlank()) {
                    Text("Draft for review: $responsibilityDraft")
                    TextButton(onClick = { scope.launch { propose(id) } }) { Text("Review draft for this responsibility") }
                }
                proposal?.let { candidate ->
                    val action = candidate["action"]?.jsonPrimitive?.contentOrNull.orEmpty()
                    Text("Proposal: $action · ${candidate["objective"] ?: "manual review"} · version ${candidate["expectedVersion"] ?: "unknown"}")
                    if (action == "complete") Text("Confirm that this responsibility's objective is achieved. This does not stop existing work.")
                    if (action in setOf("pause", "resume", "wake", "complete", "cancel", "archive") && candidate["responsibilityId"]?.jsonPrimitive?.contentOrNull == id) {
                        TextButton(onClick = {
                            val body = buildJsonObject { put("expectedVersion", candidate["expectedVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString()); put("confirmed", true) }
                            scope.launch { submitResponsibility("/api/responsibilities/${Uri.encode(id)}/$action", body) }
                        }) { Text("Confirm $action") }
                        if (action in setOf("pause", "cancel")) TextButton(onClick = {
                            val body = buildJsonObject { put("expectedVersion", candidate["expectedVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString()); put("confirmed", true); put("stopExisting", true) }
                            scope.launch { submitResponsibility("/api/responsibilities/${Uri.encode(id)}/$action", body) }
                        }) { Text("Confirm $action and request stop (not proof of stopping)") }
                    }
                }
            }
            if (form.isNotEmpty()) {
                if (form == "create") {
                    Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_choose_project))
                    if (availableProjectId.isBlank()) Text(stringResource(com.andysagent.ragent.feature.organization.R.string.factory_weekly_no_project))
                    else TextButton(onClick = { projectId = availableProjectId; reviewForm = false }) {
                        Text((if (projectId == availableProjectId) "✓ " else "") + availableProjectId)
                    }
                }
                OutlinedTextField(value = objective, onValueChange = { objective = it; reviewForm = false }, label = { Text("Objective") })
                if (form == "create") {
                    OutlinedTextField(value = criterion, onValueChange = { criterion = it; reviewForm = false }, label = { Text("Success criterion") })
                    OutlinedTextField(value = intervalMinutes, onValueChange = { intervalMinutes = it; reviewForm = false }, label = { Text("Interval minutes (blank for manual)") })
                    OutlinedTextField(value = expiry, onValueChange = { expiry = it; reviewForm = false }, label = { Text("Policy expiry (ISO time with timezone)") })
                }
                if (!reviewForm) TextButton(enabled = form != "create" || (availableProjectId.isNotBlank() && projectId == availableProjectId), onClick = { reviewForm = true }) { Text("Review") }
                else {
                    Text("Review ${if (form == "create") "draft for project $projectId; criterion $criterion; trigger ${intervalMinutes.ifBlank { "manual" }}; expiry $expiry" else "objective change for version ${current?.get("rowVersion")}"}: $objective. This does not grant tool access or approve a plan.")
                    TextButton(enabled = form != "create" || (projectId == availableProjectId && projectId.isNotBlank() && (intervalMinutes.isBlank() || (intervalMinutes.toLongOrNull()?.let { it in 1L..525600L } == true))), onClick = {
                        val body = if (form == "create") buildJsonObject {
                            put("organizationId", organizationId); put("projectId", projectId); put("objective", objective)
                            put("successCriteria", buildJsonArray { add(criterion) }); put("policy", buildJsonObject { put("validUntil", expiry) }); put("idempotencyKey", UUID.randomUUID().toString())
                            intervalMinutes.toLongOrNull()?.let { put("intervalMs", it * 60000) }
                        } else buildJsonObject { put("objective", objective); put("expectedVersion", current!!["rowVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString()) }
                        val path = if (form == "create") "/api/responsibilities" else "/api/responsibilities/${Uri.encode(current!!["id"]!!.jsonPrimitive.content)}"
                        scope.launch { submitResponsibility(path, body, if (form == "create") "POST" else "PATCH") }
                    }) { Text("Confirm") }
                }
            }
            pendingResponsibility?.let { (path, method, body) -> TextButton(onClick = { scope.launch { submitResponsibility(path, body, method) } }) { Text("Retry same request") } }
        } else if (selected == null) {
            TextButton(onClick = { scope.launch { loadResponsibilities() } }) { Text("Responsibilities") }
            list?.get("items")?.jsonArray?.forEach { element ->
                val row = element.jsonObject
                val id = row["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
                val objective = row["contract"]?.jsonObject?.get("objective")?.jsonPrimitive?.contentOrNull ?: id
                TextButton(onClick = { scope.launch {
                    runCatching { request("/work-items/${Uri.encode(id)}") }.onSuccess { item = it["item"]?.jsonObject; status = "As of ${it["asOf"]}" }
                        .onFailure { status = "Work item unavailable: ${it.message}" }
                } }) { Text("$objective · ${row["state"]} · ${row["controlState"]}") }
            }
            if (list?.get("nextCursor") !is JsonNull && list?.get("nextCursor") != null) Text("More items exist; this view shows the first page.")
            TextButton(onClick = { scope.launch { reload() } }) { Text("Refresh") }
        } else {
            Text("${selected["contract"]?.jsonObject?.get("objective") ?: selected["id"]}")
            val observation = itemReconciliation?.get("acceptedRunObservation") as? JsonObject
            Text(if (observation?.get("state")?.jsonPrimitive?.contentOrNull == "found") "发现执行记录，等待系统核实关联。执行记录：${observation["expectedRunId"] ?: "未知"}；状态：${observation["runState"] ?: "未知"}。" else "暂未核实是否已执行。")
            val reservation = itemBudget?.get("reservation") as? JsonObject
            Text(if (reservation == null) "Budget facts unavailable; this does not prove work did not run." else "Budget ${reservation["state"] ?: "unavailable"}; reserved ${reservation["reserved"]?.takeUnless { it is JsonNull } ?: "unknown"}; actual usage ${if (itemBudget?.get("usageState")?.jsonPrimitive?.contentOrNull == "actual") reservation["actualUsage"]?.takeUnless { it is JsonNull } ?: "unknown" else "unknown"}; window ${reservation["window"]?.takeUnless { it is JsonNull } ?: "unknown"}. Admission estimates do not enforce a provider spending cap.")
            OutlinedTextField(scopedObjective,{scopedObjective=it;scopedPreview=null},label={Text("新的此项工作目标")})
            OutlinedTextField(scopedCriterion,{scopedCriterion=it;scopedPreview=null},label={Text("可选追加人工验收标准 ID；固定责任合同不支持")})
            TextButton(enabled=scopedObjective.isNotBlank(),onClick={ scope.launch {
                runCatching {
                    val goalId=selected["goalId"]!!.jsonPrimitive.content; var cursor=""; var goal:JsonObject?=null
                    for (page in 0 until 10) { val result=request("/goals?limit=200" + if(cursor.isNotEmpty()) "&cursor=${Uri.encode(cursor)}" else ""); goal=result["items"]?.jsonArray?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull==goalId }; cursor=result["nextCursor"]?.jsonPrimitive?.contentOrNull.orEmpty(); if(goal!=null || cursor.isEmpty()) break }
                    val version=goal?.get("rowVersion")?.jsonPrimitive?.longOrNull ?: error("无法读取当前目标版本")
                    val criteria=if(scopedCriterion.isBlank()) null else JsonArray(listOf(buildJsonObject {put("id",scopedCriterion.trim());put("method","manual")}))
                    val body=buildJsonObject { put("expectedVersion",version); put("rootWorkItemId",selected["id"]!!); put("objective",scopedObjective); if(criteria!=null)put("additionalManualCriteria",criteria) }
                    val preview=request("/goals/${Uri.encode(goalId)}/scoped-revision/preview",body)
                    require(preview["goalVersion"]?.jsonPrimitive?.longOrNull==version && preview["rootWorkItemId"]==selected["id"] && preview["objective"]?.jsonPrimitive?.contentOrNull==scopedObjective && preview["additionalManualCriteria"]==criteria && preview["impactDigest"]?.jsonPrimitive?.contentOrNull?.isNotBlank()==true) { "预览与请求不一致，请刷新" }
                    preview
                }.onSuccess { scopedPreview=it }.onFailure { status="无法审阅局部修改：${it.message}" }
            } }) { Text("审阅局部目标修改") }
            scopedPreview?.takeIf { it["rootWorkItemId"] == selected["id"] }?.let { preview ->
                Text("新目标：${preview["objective"]}；追加人工标准：${preview["additionalManualCriteria"] ?: "无"}；目标版本：${preview["goalVersion"]}；受影响工作：${preview["items"]}。保留原权限、标准和检查；活动下游仅请求取消，不代表已停止。")
                TextButton(onClick={ val command=UUID.randomUUID().toString(); val body=buildJsonObject { put("expectedVersion",preview["goalVersion"]!!);put("rootWorkItemId",preview["rootWorkItemId"]!!);put("objective",preview["objective"]!!);preview["additionalManualCriteria"]?.let {put("additionalManualCriteria",it)};put("impactDigest",preview["impactDigest"]!!);put("commandId",command);put("idempotencyKey",command) }; val path="/goals/${Uri.encode(preview["goalId"]!!.jsonPrimitive.content)}/scoped-revision/commit"; scopedPending=path to body; scope.launch { runCatching { request(path,body) }.onSuccess { scopedPending=null;scopedPreview=null;status="修改已记录，请刷新查看实际停止和工作状态。" }.onFailure { status="修改未确认：${it.message}" } } }) { Text("确认局部修改") }
            }
            scopedPending?.takeIf { it.second["rootWorkItemId"] == selected["id"] }?.let { (path,body) -> TextButton(onClick={scope.launch { runCatching { request(path,body) }.onSuccess {scopedPending=null;scopedPreview=null;status="修改已记录。"}.onFailure {status="修改未确认：${it.message}"} }}) { Text("使用同一请求重试") } }
            Text("多个工作目标：选择同一目标内 2 至 32 项工作并填写各自新目标。仅显示当前列表页。")
            list?.get("items")?.jsonArray?.mapNotNull { it as? JsonObject }?.filter { it["goalId"] == selected["goalId"] }?.forEach { row ->
                val id = row["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
                if (id.isNotBlank()) {
                    TextButton(onClick = { multiObjectives = if (multiObjectives.containsKey(id)) multiObjectives - id else multiObjectives + (id to ""); multiPreview = null }) { Text("${if (multiObjectives.containsKey(id)) "取消选择" else "选择"} $id · ${row["state"]}") }
                    if (multiObjectives.containsKey(id)) OutlinedTextField(multiObjectives[id].orEmpty(), { multiObjectives = multiObjectives + (id to it); multiPreview = null }, label = { Text("此工作的新目标") })
                    if (multiObjectives.containsKey(id)) OutlinedTextField(multiCriteria[id].orEmpty(), { multiCriteria = multiCriteria + (id to it); multiPreview = null }, label = { Text("可选人工标准 ID；固定责任合同不支持") })
                }
            }
            TextButton(enabled = multiObjectives.size in 2..32 && multiObjectives.values.all { it.isNotBlank() }, onClick = { scope.launch {
                runCatching {
                    val goalId=selected["goalId"]!!.jsonPrimitive.content; var cursor=""; var goal:JsonObject?=null
                    for (page in 0 until 10) { val result=request("/goals?limit=200" + if(cursor.isNotEmpty()) "&cursor=${Uri.encode(cursor)}" else ""); goal=result["items"]?.jsonArray?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull==goalId }; cursor=result["nextCursor"]?.jsonPrimitive?.contentOrNull.orEmpty(); if(goal!=null || cursor.isEmpty()) break }
                    val version=goal?.get("rowVersion")?.jsonPrimitive?.longOrNull ?: error("无法读取当前目标版本")
                    val revisions=JsonArray(multiObjectives.entries.map { (id, objective) -> buildJsonObject { put("rootWorkItemId",id); put("objective",objective.trim());multiCriteria[id]?.trim()?.takeIf {it.isNotEmpty()}?.let {put("additionalManualCriteria",JsonArray(listOf(buildJsonObject {put("id",it);put("method","manual")})))} } })
                    val preview=request("/goals/${Uri.encode(goalId)}/scoped-revision/preview",buildJsonObject {put("expectedVersion",version);put("revisions",revisions)})
                    val returned=(preview["revisions"] as? JsonArray)?.map { it.jsonObject["rootWorkItemId"]!!.jsonPrimitive.content to it.jsonObject["objective"]!!.jsonPrimitive.content }?.toMap()
                    require(preview["goalVersion"]?.jsonPrimitive?.longOrNull==version && returned==multiObjectives.mapValues { it.value.trim() } && (preview["revisions"] as? JsonArray)?.toSet()==revisions.toSet() && preview["impactDigest"]?.jsonPrimitive?.contentOrNull?.isNotBlank()==true) { "预览与请求不一致，请刷新" }; preview
                }.onSuccess { multiPreview=it }.onFailure { status="无法审阅局部修改：${it.message}" }
            } }) { Text("预览合并影响") }
            multiPreview?.let { preview ->
                Text("修改目标：${preview["revisions"]}；受影响工作：${preview["items"]}。活动下游仅请求取消，不代表已停止；原权限与验收条件保留。")
                TextButton(onClick = { val command=UUID.randomUUID().toString(); val body=buildJsonObject {put("expectedVersion",preview["goalVersion"]!!);put("revisions",preview["revisions"]!!);put("impactDigest",preview["impactDigest"]!!);put("commandId",command);put("idempotencyKey",command)};val path="/goals/${Uri.encode(preview["goalId"]!!.jsonPrimitive.content)}/scoped-revision/commit";multiPending=path to body;scope.launch {runCatching {request(path,body)}.onSuccess {multiPending=null;multiPreview=null;status="修改已记录，请刷新查看实际工作状态。"}.onFailure {status="修改未确认：${it.message}"}} }) { Text("确认多个目标修改") }
            }
            multiPending?.let { (path,body) -> TextButton(onClick={scope.launch {runCatching {request(path,body)}.onSuccess {multiPending=null;multiPreview=null;status="修改已记录。"}.onFailure {status="修改未确认：${it.message}"}}}) { Text("使用同一多目标请求重试") } }
            Text("State ${selected["state"]}; control ${selected["controlState"]}; priority ${selected["priority"]}; version ${selected["rowVersion"]}")
            Text("交接仅核对快照，不证明旧执行已停止，也不授权继续执行或自动重派。未确认请求的同键重试仅在本页面保留；离开后不会自动重试，需先核查交接记录。")
            handoff?.let { snapshot ->
                val label=when(snapshot["assessment"]?.jsonPrimitive?.contentOrNull) {"current"->"快照核对为当前";"stale"->"快照已过期";else->"快照无法完整核实"}
                Text("$label · 原因 ${snapshot["staleReasons"] ?: "未知"} · ${snapshot["asOf"] ?: "时间未知"}\n${snapshot["facts"] ?: "事实不可用"}")
                TextButton(enabled=!handoffBusy,onClick={snapshot["id"]?.jsonPrimitive?.contentOrNull?.let { handoffId -> handoffBusy=true;scope.launch {runCatching {request("/handoffs/${Uri.encode(handoffId)}")}.onSuccess {handoff=it}.onFailure {status="无法核对快照：${it.message}"};handoffBusy=false} }}) {Text("重新核对该快照")}
            }
            TextButton(enabled=!handoffBusy && handoffPending==null,onClick={handoffBusy=true;scope.launch {
                runCatching {val id=selected["id"]!!.jsonPrimitive.content;val latest=request("/work-items/${Uri.encode(id)}")["item"]!!.jsonObject;val version=latest["rowVersion"]?.jsonPrimitive?.longOrNull ?: error("无法读取当前工作版本");"/work-items/${Uri.encode(id)}/handoffs" to buildJsonObject {put("expectedVersion",version);put("commandId",UUID.randomUUID().toString())}}
                    .onSuccess { (path,body) -> handoffPending=path to body;runCatching {request(path,body)}.onSuccess {handoff=it;handoffPending=null}.onFailure {status="交接未确认，请使用相同请求重试：${it.message}"} }
                    .onFailure {status="无法读取当前工作：${it.message}"};handoffBusy=false
            }}) {Text("生成或刷新交接快照")}
            handoffPending?.let { (path,body) -> TextButton(enabled=!handoffBusy,onClick={handoffBusy=true;scope.launch {runCatching {request(path,body)}.onSuccess {handoff=it;handoffPending=null}.onFailure {status="交接未确认：${it.message}"};handoffBusy=false}}) {Text("使用相同交接请求重试")} }
            listOf("contract", "dependencies", "bindings", "candidates", "decisions").forEach { Text("$it: ${selected[it] ?: "[]"}") }
            Text("Delivery evidence")
            val candidates = selected["candidates"] as? JsonArray ?: JsonArray(emptyList())
            if (candidates.isEmpty()) Text("Candidate: unverified")
            candidates.forEach { entry ->
                val fact = entry.jsonObject
                Text("Candidate ${fact["digest"] ?: "unverified"} · contract ${fact["contractRevision"]} · execution ${fact["executionEpoch"]}")
            }
            val decisions = selected["decisions"] as? JsonArray ?: JsonArray(emptyList())
            if (decisions.isEmpty()) Text("Acceptance and checks: unverified")
            decisions.forEach { entry ->
                val fact = entry.jsonObject
                Text("Acceptance ${fact["criterionId"]}: ${fact["decision"]} · candidate ${fact["candidateDigest"]}. Evidence: ${fact["evidence"] ?: "not provided"}")
            }
            val milestones = selected["milestones"] as? JsonArray ?: JsonArray(emptyList())
            milestones.forEach { entry ->
                val fact = entry.jsonObject
                val evidence = fact["evidence"] as? JsonObject
                Text("${fact["milestone"]} · candidate ${fact["candidateDigest"]} · commit ${evidence?.get("commit") ?: "unverified"} · target ${fact["target"] ?: "unknown"}")
            }
            if (milestones.none { (it as? JsonObject)?.get("milestone")?.jsonPrimitive?.contentOrNull == "integrated" }) Text("Integrated commit: unverified")
            Text("Package availability and publication: unverified unless supported by a recorded delivery operation.")
            fun command(type: String, payload: JsonObject = buildJsonObject { }): JsonObject {
                val id = UUID.randomUUID().toString()
                return buildJsonObject { put("commandId", id); put("idempotencyKey", id); put("type", type); put("targetId", selected["id"]!!); put("expectedVersion", selected["rowVersion"]!!); put("payload", payload) }
            }
            val priority = selected["priority"]?.jsonPrimitive?.intOrNull ?: 0
            TextButton(onClick = { scope.launch { submit(command("ChangePriority", buildJsonObject { put("priority", priority + 1) })) } }) { Text("Increase priority") }
            TextButton(onClick = { scope.launch { submit(command("RequestPause")) } }) { Text("Request pause") }
            if (selected["controlState"]?.jsonPrimitive?.contentOrNull == "paused") {
                TextButton(onClick = { scope.launch { submit(command("ResumeWork")) } }) { Text("Release pause") }
                Text("Releasing a pause does not start work. A stopped task may also need an authorized retry.")
            }
            TextButton(onClick = { scope.launch { submit(command("RequestCancel")) } }) { Text("Request cancel") }
        }
    }
}

internal data class ResponsibilitiesLoadResult(
    val capabilities: JsonArray?,
    val features: JsonObject?,
    val planCatalogDescriptors: JsonArray?,
    val responsibilities: JsonArray,
    val banner: String?,
)

internal suspend fun fetchResponsibilitiesOrBanner(
    transport: RagentTransport,
    organizationId: String,
): ResponsibilitiesLoadResult {
    val encodedOrg = encodeOrganizationUriComponent(organizationId)
    val catalog = try {
        val response = transport.execute(ApiRequest("GET", "/api/responsibilities/capabilities?organizationId=$encodedOrg"))
        if (!response.isSuccessful) {
            throw parseOrganizationApiException(response.statusCode, response.body, "HTTP ${response.statusCode}")
        }
        Json.parseToJsonElement(response.body) as? JsonObject
    } catch (error: CancellationException) {
        throw error
    } catch (_: Throwable) {
        null
    }
    val capabilities = catalog?.get("providers") as? JsonArray
    val features = catalog?.get("features") as? JsonObject
    val planCatalogDescriptors = catalog?.get("planCatalogDescriptors") as? JsonArray
    return try {
        val response = transport.execute(ApiRequest("GET", "/api/responsibilities?organizationId=$encodedOrg"))
        if (!response.isSuccessful) {
            throw parseOrganizationApiException(response.statusCode, response.body, "HTTP ${response.statusCode}")
        }
        val payload = Json.parseToJsonElement(response.body).jsonObject
        ResponsibilitiesLoadResult(
            capabilities = capabilities,
            features = features,
            planCatalogDescriptors = planCatalogDescriptors,
            responsibilities = payload["responsibilities"] as? JsonArray ?: JsonArray(emptyList()),
            banner = null,
        )
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        ResponsibilitiesLoadResult(
            capabilities = capabilities,
            features = features,
            planCatalogDescriptors = planCatalogDescriptors,
            responsibilities = JsonArray(emptyList()),
            banner = formatOrganizationFeatureUnavailableBanner(error, "Responsibilities unavailable"),
        )
    }
}

internal suspend fun fetchResponsibilityContextOrBanner(
    transport: RagentTransport,
    sessionId: String,
): Pair<JsonObject?, String?> {
    if (sessionId.isBlank()) return null to null
    return try {
        val response = transport.execute(
            ApiRequest(
                method = "GET",
                path = "/api/sessions/${encodeOrganizationUriComponent(sessionId)}/responsibility-context",
            ),
        )
        if (!response.isSuccessful) {
            throw parseOrganizationApiException(
                statusCode = response.statusCode,
                body = response.body,
                fallback = "HTTP ${response.statusCode}",
            )
        }
        val context = (Json.parseToJsonElement(response.body) as? JsonObject)
            ?.get("context") as? JsonObject
        context to null
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        null to formatOrganizationFeatureUnavailableBanner(
            error = error,
            fallbackPrefix = "Responsibility context unavailable",
        )
    }
}

@Composable
private fun FactoryInlineBanner(
    text: String,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val accent = colors.error
    Row(
        modifier = modifier
            .clip(AgentoShapes.SurfaceSmallShape)
            .background(accent.copy(alpha = 0.12f))
            .border(0.75.dp, accent.copy(alpha = 0.36f), AgentoShapes.SurfaceSmallShape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.ErrorOutline, contentDescription = null, tint = accent, modifier = Modifier.size(18.dp))
        Text(text = text, style = MaterialTheme.typography.bodySmall, color = colors.primaryContent)
    }
}
