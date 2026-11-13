package com.andysagent.agentoc.feature.organization.ui

import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.feature.organization.data.OrganizationNodeDto
import java.util.UUID
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
fun TeamMessagesScreen(transport: AgentoCTransport, organizationId: String, nodes: List<OrganizationNodeDto>, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var recipient by remember(organizationId) { mutableStateOf<OrganizationNodeDto?>(null) }
    var messages by remember(organizationId) { mutableStateOf<JsonArray?>(null) }
    var body by remember(organizationId) { mutableStateOf("") }
    var status by remember(organizationId) { mutableStateOf("Choose a recipient. Messages are informational only.") }
    var pending by remember(organizationId) { mutableStateOf<JsonObject?>(null) }
    suspend fun request(nodeId: String, command: JsonObject? = null): JsonObject {
        val path = "/api/organizations/${Uri.encode(organizationId)}/factory/nodes/${Uri.encode(nodeId)}/messages"
        val response = transport.execute(ApiRequest(method = if (command == null) "GET" else "POST", path = path,
            body = command?.toString(), contentType = if (command == null) null else "application/json"))
        val data = Json.parseToJsonElement(response.body).jsonObject
        if (!response.isSuccessful) error(data["error"]?.jsonPrimitive?.contentOrNull ?: "HTTP ${response.statusCode}")
        return data
    }
    suspend fun refresh(nodeId: String) {
        runCatching { request(nodeId) }.onSuccess { messages = it["messages"]?.jsonArray; status = "Queued delivery is not a reply." }
            .onFailure { messages = null; status = "Messages unavailable: ${it.message}" }
    }
    suspend fun submit(nodeId: String, command: JsonObject) {
        pending = command; status = "Sending…"
        runCatching { request(nodeId, command) }.onSuccess { pending = null; body = ""; refresh(nodeId); status = "Message queued: ${it["message"]?.jsonObject?.get("deliveryState")}" }
            .onFailure { status = "Not confirmed: ${it.message}. Retry uses the same message ID." }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        TextButton(onClick = { if (recipient != null) { recipient = null; messages = null; pending = null } else onBack() }) { Text("Back") }
        Text("Team messages")
        Text(status)
        val selected = recipient
        if (selected == null) nodes.forEach { node -> TextButton(onClick = { recipient = node; scope.launch { refresh(node.id) } }) { Text(node.displayName.ifBlank { node.id }) } }
        else {
            Text("To ${selected.displayName.ifBlank { selected.id }}")
            messages?.forEach { element -> val message = element.jsonObject; Text("${message["createdAt"]} · ${if (message["deliveryState"]?.jsonPrimitive?.contentOrNull == "delivered") "Delivered to Run" else message["deliveryState"]} · ${message["requestState"] ?: "information"} · ${message["body"]} · ${message["reply"] ?: ""}") }
            OutlinedTextField(value = body, onValueChange = { if (it.length <= 4000) body = it }, label = { Text("Information") })
            TextButton(onClick = {
                if (body.isNotBlank()) {
                    val command = buildJsonObject { put("body", body); put("requestType", "information"); put("idempotencyKey", UUID.randomUUID().toString()) }
                    scope.launch { submit(selected.id, command) }
                }
            }) { Text("Send information") }
            TextButton(onClick = {
                if (body.isNotBlank()) {
                    val command = buildJsonObject { put("body", body); put("requestType", "required_response"); put("idempotencyKey", UUID.randomUUID().toString()) }
                    scope.launch { submit(selected.id, command) }
                }
            }) { Text("Request a reply") }
            if (pending != null) TextButton(onClick = { pending?.let { scope.launch { submit(selected.id, it) } } }) { Text("Retry same message") }
            TextButton(onClick = { scope.launch { refresh(selected.id) } }) { Text("Refresh") }
        }
    }
}
