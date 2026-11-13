package com.andysagent.agentoc.feature.organization.ui

import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiRequest
import java.util.UUID
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
fun FactoryWorkScreen(transport: AgentoCTransport, organizationId: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val base = "/api/organizations/${Uri.encode(organizationId)}/factory"
    var list by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var item by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    var status by remember(organizationId) { mutableStateOf("Loading work items…") }
    var pending by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    suspend fun request(path: String, body: JsonObject? = null): JsonObject {
        val response = transport.execute(ApiRequest(method = if (body == null) "GET" else "POST", path = base + path,
            body = body?.toString(), contentType = if (body == null) null else "application/json"))
        val parsed = Json.parseToJsonElement(response.body).jsonObject
        if (!response.isSuccessful) error(parsed["error"]?.jsonPrimitive?.contentOrNull ?: "HTTP ${response.statusCode}")
        return parsed
    }
    suspend fun reload() {
        item = null; status = "Loading work items…"
        runCatching { request("/work-items") }.onSuccess { list = it; status = "As of ${it["asOf"]?.jsonPrimitive?.contentOrNull.orEmpty()}" }
            .onFailure { list = null; status = "Work items unavailable: ${it.message}" }
    }
    suspend fun submit(command: JsonObject) {
        pending = command; status = "Submitting request…"
        runCatching { request("/commands", command) }.onSuccess {
            pending = null
            status = "Receipt: ${it["operation"]}; task: ${it["item"]?.jsonObject?.get("controlState")}. Refresh for current facts."
        }.onFailure { status = "Request not confirmed: ${it.message}. Retry uses the same command ID." }
    }
    LaunchedEffect(transport, organizationId) { reload() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TextButton(onClick = { if (item != null) scope.launch { reload() } else onBack() }) { Text("Back") }
        Text("Work items")
        Text(status)
        if (pending != null) TextButton(onClick = { pending?.let { scope.launch { submit(it) } } }) { Text("Retry same request") }
        val selected = item
        if (selected == null) {
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
            TextButton(onClick = { scope.launch { submit(command("RequestCancel")) } }) { Text("Request cancel") }
        }
    }
}
