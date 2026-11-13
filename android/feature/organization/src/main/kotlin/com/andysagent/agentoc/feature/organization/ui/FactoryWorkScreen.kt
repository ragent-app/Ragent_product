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
    var proposal by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var pendingResponsibility by remember(organizationId) { mutableStateOf<Triple<String, String, JsonObject>?>(null) }
    var form by remember(organizationId) { mutableStateOf("") }
    var projectId by remember(organizationId) { mutableStateOf("") }
    var objective by remember(organizationId) { mutableStateOf("") }
    var criterion by remember(organizationId) { mutableStateOf("") }
    var expiry by remember(organizationId) { mutableStateOf("") }
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
        }.onSuccess { pendingResponsibility = null; proposal = null; form = ""; reviewForm = false; status = "Request recorded; existing work may continue. Refresh for current facts." }
            .onFailure { status = "Request not confirmed: ${it.message}; retry uses the same key." }
    }
    suspend fun loadResponsibility(id: String) {
        status = "Loading responsibility…"
        runCatching {
            val path = "/${Uri.encode(id)}"
            val detail = responsibilityRequest(path)["responsibility"]!!.jsonObject
            require(detail["organizationId"]?.jsonPrimitive?.contentOrNull == organizationId)
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
                (current["successCriteria"] as? JsonArray)?.forEach { Text(it.jsonPrimitive.content) }
                Text("Activity")
                responsibilityActivity?.forEach { Text("${it.jsonObject["createdAt"]} · ${it.jsonObject["type"]}") }
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
                listOf("pause", "resume", "wake").forEach { action ->
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
                    if (action in setOf("pause", "resume", "wake") && candidate["responsibilityId"]?.jsonPrimitive?.contentOrNull == id) {
                        TextButton(onClick = {
                            val body = buildJsonObject { put("expectedVersion", candidate["expectedVersion"]!!); put("idempotencyKey", UUID.randomUUID().toString()) }
                            scope.launch { submitResponsibility("/api/responsibilities/${Uri.encode(id)}/$action", body) }
                        }) { Text("Confirm $action") }
                    }
                }
            }
            if (form.isNotEmpty()) {
                if (form == "create") OutlinedTextField(value = projectId, onValueChange = { projectId = it; reviewForm = false }, label = { Text("Project ID") })
                OutlinedTextField(value = objective, onValueChange = { objective = it; reviewForm = false }, label = { Text("Objective") })
                if (form == "create") {
                    OutlinedTextField(value = criterion, onValueChange = { criterion = it; reviewForm = false }, label = { Text("Success criterion") })
                    OutlinedTextField(value = expiry, onValueChange = { expiry = it; reviewForm = false }, label = { Text("Policy expiry (ISO time with timezone)") })
                }
                if (!reviewForm) TextButton(onClick = { reviewForm = true }) { Text("Review") }
                else {
                    Text("Review ${if (form == "create") "draft for project $projectId; criterion $criterion; expiry $expiry" else "objective change for version ${current?.get("rowVersion")}"}: $objective")
                    TextButton(onClick = {
                        val body = if (form == "create") buildJsonObject {
                            put("organizationId", organizationId); put("projectId", projectId); put("objective", objective)
                            put("successCriteria", buildJsonArray { add(criterion) }); put("policy", buildJsonObject { put("validUntil", expiry) }); put("idempotencyKey", UUID.randomUUID().toString())
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
