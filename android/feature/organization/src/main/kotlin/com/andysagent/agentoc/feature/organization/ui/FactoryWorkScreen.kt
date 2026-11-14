package com.andysagent.agentoc.feature.organization.ui

import android.net.Uri
import android.content.Context
import android.media.AudioManager
import android.speech.tts.TextToSpeech
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiRequest
import java.util.UUID
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
fun FactoryWorkScreen(transport: AgentoCTransport, organizationId: String, responsibilityDraft: String = "", selectedResponsibilityId: String? = null, onResponsibilitySelected: (String?) -> Unit = {}, sessionId: String = "", onBack: () -> Unit) {
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
    var status by remember(organizationId) { mutableStateOf("Loading work items…") }
    var pending by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var responsibilities by remember(organizationId) { mutableStateOf<JsonArray?>(null) }
    var responsibility by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var responsibilityActivity by remember(organizationId) { mutableStateOf<JsonArray?>(null) }
    var responsibilityPolicy by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var responsibilityPlans by remember(organizationId) { mutableStateOf<JsonArray?>(null) }
    var capabilities by remember(organizationId) { mutableStateOf<JsonArray?>(null) }
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
    suspend fun request(path: String, body: JsonObject? = null): JsonObject {
        val response = transport.execute(ApiRequest(method = if (body == null) "GET" else "POST", path = base + path,
            body = body?.toString(), contentType = if (body == null) null else "application/json"))
        val parsed = Json.parseToJsonElement(response.body).jsonObject
        if (!response.isSuccessful) error(parsed["error"]?.jsonPrimitive?.contentOrNull ?: "HTTP ${response.statusCode}")
        return parsed
    }
    suspend fun reload() {
        item = null; responsibilities = null; responsibility = null; status = "Loading work items…"
        runCatching { request("/work-items") }.onSuccess { list = it; status = "As of ${it["asOf"]?.jsonPrimitive?.contentOrNull.orEmpty()}" }
            .onFailure { list = null; status = "Work items unavailable: ${it.message}" }
    }
    suspend fun responsibilityRequest(path: String): JsonObject {
        val response = transport.execute(ApiRequest(method = "GET", path = "/api/responsibilities$path"))
        val parsed = Json.parseToJsonElement(response.body).jsonObject
        if (!response.isSuccessful) error(parsed["error"]?.jsonPrimitive?.contentOrNull ?: "HTTP ${response.statusCode}")
        return parsed
    }
    suspend fun loadResponsibilities() {
        status = "Loading responsibilities…"; item = null; responsibility = null; proposal = null
        val catalog = runCatching { responsibilityRequest("/capabilities?organizationId=${Uri.encode(organizationId)}") }.getOrNull()
        capabilities = catalog?.get("providers") as? JsonArray
        planCatalogDescriptors = catalog?.get("planCatalogDescriptors") as? JsonArray
        runCatching { responsibilityRequest("?organizationId=${Uri.encode(organizationId)}") }.onSuccess {
            responsibilities = it["responsibilities"] as? JsonArray ?: JsonArray(emptyList()); status = "Responsibilities"
        }.onFailure { responsibilities = JsonArray(emptyList()); status = "Responsibilities unavailable: ${it.message}" }
    }
    suspend fun propose(id: String) {
        val body = buildJsonObject { put("text", responsibilityDraft); put("responsibilityId", id) }
        runCatching {
            val response = transport.execute(ApiRequest(method = "POST", path = "/api/responsibilities/intent", body = body.toString(), contentType = "application/json"))
            val parsed = Json.parseToJsonElement(response.body).jsonObject
            if (!response.isSuccessful) error(parsed["error"]?.jsonPrimitive?.contentOrNull ?: "HTTP ${response.statusCode}")
            parsed
        }.onSuccess { proposal = it; status = "Review the proposal. Voice or draft text is not authorization." }
            .onFailure { status = "Proposal unavailable: ${it.message}" }
    }
    suspend fun submitResponsibility(path: String, body: JsonObject, method: String = "POST") {
        pendingResponsibility = Triple(path, method, body)
        runCatching {
            val response = transport.execute(ApiRequest(method = method, path = path, body = body.toString(), contentType = "application/json"))
            val parsed = Json.parseToJsonElement(response.body).jsonObject
            if (!response.isSuccessful) error(parsed["error"]?.jsonPrimitive?.contentOrNull ?: "HTTP ${response.statusCode}")
            parsed
        }.onSuccess { result -> pendingResponsibility = null; proposal = null; form = ""; reviewForm = false; status = "Request recorded; actual stop is not established. Stop requests: ${result["stop"] ?: "none"}. Refresh for current facts." }
            .onFailure { status = "Request not confirmed: ${it.message}; retry uses the same key." }
    }
    suspend fun loadResponsibility(id: String) {
        status = "Loading responsibility…"; plannerReview = false; plannerNetworkConfirmed = false; autoReportPlans = false; reportReview = false; reportNetworkConfirmed = false; ciPolicyReviewed = false; codeBaseline = null; includeCode = false; includeReport = false
        runCatching {
            val path = "/${Uri.encode(id)}"
            val response = responsibilityRequest(path)
            val detail = response["responsibility"]!!.jsonObject
            require(detail["organizationId"]?.jsonPrimitive?.contentOrNull == organizationId)
            responsibilityPolicy = response["policy"] as? JsonObject
            responsibilityPlans = runCatching { responsibilityRequest("$path/plans")["plans"] as? JsonArray }.getOrNull()
            reviewedPlan = null
            detail to responsibilityRequest("$path/activity")["activity"]!!.jsonArray
        }.onSuccess { (detail, activity) -> responsibility = detail; responsibilityActivity = activity; onResponsibilitySelected(id); status = "Responsibility" }
            .onFailure { status = "Responsibility unavailable: ${it.message}" }
    }
    suspend fun submit(command: JsonObject) {
        pending = command; status = "Submitting request…"
        runCatching { request("/commands", command) }.onSuccess {
            pending = null
            status = "Receipt: ${it["operation"]}; task: ${it["item"]?.jsonObject?.get("controlState")}. Refresh for current facts."
        }.onFailure { status = "Request not confirmed: ${it.message}. Retry uses the same command ID." }
    }
    LaunchedEffect(transport, organizationId) {
        if (sessionId.isNotBlank()) runCatching {
            val response = transport.execute(ApiRequest(method = "GET", path = "/api/sessions/${Uri.encode(sessionId)}/responsibility-context"))
            if (!response.isSuccessful) error("HTTP ${response.statusCode}")
            Json.parseToJsonElement(response.body).jsonObject["context"] as? JsonObject
        }.onSuccess { sessionContext = it }
        val resumeId = selectedResponsibilityId ?: sessionContext?.takeIf { it["organizationId"]?.jsonPrimitive?.contentOrNull == organizationId }?.get("responsibilityId")?.jsonPrimitive?.contentOrNull
        if (resumeId == null) reload() else { loadResponsibilities(); loadResponsibility(resumeId) }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TextButton(onClick = { if (responsibility != null) { onResponsibilitySelected(null); scope.launch { loadResponsibilities() } } else if (item != null || responsibilities != null) scope.launch { reload() } else onBack() }) { Text("Back") }
        Text("Work items")
        Text(status)
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
                Text("Responsibility ${current["lifecycle"]}; version ${current["rowVersion"]}; policy ${current["policyRevision"]}")
                Text("A paused responsibility stops new admission; existing work may continue.")
                Text("A stop request is not proof of stopping. Unknown or older active executions need reconciliation; a run that finished first remains pending review. Archived history is retained.")
                Text("Responsibility notifications through Android FCM are not supported. Activity remains available in the app.")
                Text("Policy (not plan approval): ${responsibilityPolicy ?: "unavailable"}")
                val planner = capabilities?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == "generic-planner" && it["available"]?.jsonPrimitive?.booleanOrNull == true }
                val plannerTemplate = (planner?.get("templates") as? JsonArray)?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == "agentoc-responsibility-planner" }
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
                                val response = transport.execute(ApiRequest(method = "POST", path = "/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}/code-baseline", body = "{}", contentType = "application/json"))
                                val data = Json.parseToJsonElement(response.body).jsonObject
                                if (!response.isSuccessful) error(data["error"]?.jsonPrimitive?.contentOrNull ?: "HTTP ${response.statusCode}")
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
                    val ciTemplate = (ciProvider["templates"] as? JsonArray)?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == "agentoc-reviewed-change" && it["version"]?.jsonPrimitive?.intOrNull == 3 }
                    TextButton(onClick = {
                        val generations = ciGeneration.split(',').map { it.trim().toLongOrNull() }
                        val attempts = reportAttempts.toIntOrNull(); val cost = reportCost.toDoubleOrNull(); val daily = reportDailyCost.toDoubleOrNull()
                        if (ciTemplate?.get("digest") != null && generations.size == 3 && generations.all { it != null && it > 0 } && attempts != null && attempts in 1..10 && cost != null && cost.isFinite() && cost > 0 && daily != null && daily.isFinite() && daily >= 0 && listOf(ciRepository,ciBranch,ciPaths,ciCandidate,ciCheck,ciImplementation,ciReviewNode,ciIntegration,reportTimeZone,reportExpiry).all { it.isNotBlank() }) {
                            val policy = buildJsonObject {
                                put("validUntil", reportExpiry); put("repository", ciRepository); put("templateId", "agentoc-reviewed-change"); put("templateVersion", 3); put("templateDigest", ciTemplate["digest"]!!)
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
                val reportTemplate = (reportProvider?.get("templates") as? JsonArray)?.mapNotNull { it as? JsonObject }?.firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == "agentoc-project-report" && it["version"]?.jsonPrimitive?.intOrNull == 1 }
                if (reportProvider?.get("digest") != null && reportTemplate?.get("digest") != null) {
                    Text("Project report authorization: entire project readable; project file writes are blocked. Other tools remain subject to existing permissions; network isolation is not established. Manual or interval triggers may start the fixed report. Results require human review and are not verified facts.")
                    OutlinedTextField(reportNode, { reportNode = it; reportReview = false; reportNetworkConfirmed = false; plannerReview = false }, label = { Text("Report node ID") })
                    OutlinedTextField(reportGeneration, { reportGeneration = it; reportReview = false; reportNetworkConfirmed = false; plannerReview = false }, label = { Text("Node binding generation") })
                    OutlinedTextField(reportAttempts, { reportAttempts = it; reportReview = false; plannerReview = false }, label = { Text("Maximum attempts (1–10)") })
                    OutlinedTextField(reportCost, { reportCost = it; reportReview = false; plannerReview = false }, label = { Text("Maximum cost") })
                    OutlinedTextField(reportDailyCost, { reportDailyCost = it; reportReview = false; plannerReview = false }, label = { Text("Maximum daily cost") })
                    OutlinedTextField(reportTimeZone, { reportTimeZone = it; reportReview = false; plannerReview = false }, label = { Text("Daily budget IANA timezone") })
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
                    val validReport = reportNode.isNotBlank() && generation != null && generation > 0 && attempts != null && attempts in 1..10 && cost != null && cost.isFinite() && cost > 0 && dailyCost != null && dailyCost.isFinite() && dailyCost >= 0 && reportTimeZone.isNotBlank() && reportExpiry.isNotBlank() && (reportNetworkPolicy == "deny" || (reportNetworkPolicy == "inherit_existing_permissions" && reportNetworkConfirmed))
                    if (!reportReview) TextButton(enabled = validReport, onClick = { reportReview = true }) { Text("Review report authorization") }
                    else {
                        Text("Authorize entire project ${current["projectId"]} read-only; node $reportNode generation $reportGeneration; network $reportNetworkPolicy; attempts $reportAttempts; cost $reportCost; daily cost $reportDailyCost in $reportTimeZone; expiry $reportExpiry; provider ${reportProvider["digest"]}; template ${reportTemplate["digest"]}.")
                        TextButton(enabled = validReport, onClick = {
                            val policy = buildJsonObject {
                                put("validUntil", reportExpiry); put("providerId", "project-report"); put("providerVersion", 1); put("providerDigest", reportProvider["digest"]!!)
                                put("templateId", "agentoc-project-report"); put("templateVersion", 1); put("templateDigest", reportTemplate["digest"]!!)
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
                reviewedPlan?.let { plan ->
                    Text("Approve only this plan: ${plan["proposal"]} · digest ${plan["proposalDigest"]} · responsibility version ${current["rowVersion"]}")
                    TextButton(onClick = {
                        val planId = plan["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        val body = buildJsonObject { put("expectedVersion", current["rowVersion"]!!); put("proposalDigest", plan["proposalDigest"]!!); put("idempotencyKey", UUID.randomUUID().toString()); put("confirmed", true) }
                        scope.launch { submitResponsibility("/api/responsibilities/${Uri.encode(current["id"]!!.jsonPrimitive.content)}/plans/${Uri.encode(planId)}/approve", body); reviewedPlan = null }
                    }) { Text("Confirm this plan") }
                }
                (current["successCriteria"] as? JsonArray)?.forEach { Text(it.jsonPrimitive.content) }
                Text("Activity")
                responsibilityActivity?.forEach { Text("${it.jsonObject["createdAt"]} · ${it.jsonObject["type"]} · ${it.jsonObject["details"] ?: ""}") }
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
                if (sessionId.isNotBlank()) {
                    if (!confirmSessionContext) TextButton(onClick = { confirmSessionContext = true }) { Text("Review session responsibility") }
                    else {
                        Text("Save ${current["objective"]} as this session's responsibility? This does not approve or run an action.")
                        TextButton(onClick = { scope.launch {
                            val body = buildJsonObject { put("responsibilityId", id); put("expectedVersion", sessionContext?.get("rowVersion") ?: JsonPrimitive(0));
                                put("expectedResponsibilityVersion", current["rowVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString());
                                put("confirmed", true); put("confirmedIntent", "query"); put("activityCursor", 0) }
                            runCatching {
                                val response = transport.execute(ApiRequest(method = "PUT", path = "/api/sessions/${Uri.encode(sessionId)}/responsibility-context", body = body.toString(), contentType = "application/json"))
                                val result = Json.parseToJsonElement(response.body).jsonObject
                                if (!response.isSuccessful) error(result["error"]?.jsonPrimitive?.contentOrNull ?: "HTTP ${response.statusCode}")
                                result["context"]?.jsonObject
                            }.onSuccess { sessionContext = it; confirmSessionContext = false; status = "Session responsibility saved; no action was approved." }
                                .onFailure { status = "Session context not confirmed: ${it.message}. Reload before retrying." }
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
                if (form == "create") OutlinedTextField(value = projectId, onValueChange = { projectId = it; reviewForm = false }, label = { Text("Project ID") })
                OutlinedTextField(value = objective, onValueChange = { objective = it; reviewForm = false }, label = { Text("Objective") })
                if (form == "create") {
                    OutlinedTextField(value = criterion, onValueChange = { criterion = it; reviewForm = false }, label = { Text("Success criterion") })
                    OutlinedTextField(value = intervalMinutes, onValueChange = { intervalMinutes = it; reviewForm = false }, label = { Text("Interval minutes (blank for manual)") })
                    OutlinedTextField(value = expiry, onValueChange = { expiry = it; reviewForm = false }, label = { Text("Policy expiry (ISO time with timezone)") })
                }
                if (!reviewForm) TextButton(onClick = { reviewForm = true }) { Text("Review") }
                else {
                    Text("Review ${if (form == "create") "draft for project $projectId; criterion $criterion; trigger ${intervalMinutes.ifBlank { "manual" }}; expiry $expiry" else "objective change for version ${current?.get("rowVersion")}"}: $objective. This does not grant tool access or approve a plan.")
                    TextButton(enabled = form != "create" || intervalMinutes.isBlank() || (intervalMinutes.toLongOrNull()?.let { it in 1L..525600L } == true), onClick = {
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
            Text("State ${selected["state"]}; control ${selected["controlState"]}; priority ${selected["priority"]}; version ${selected["rowVersion"]}")
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
