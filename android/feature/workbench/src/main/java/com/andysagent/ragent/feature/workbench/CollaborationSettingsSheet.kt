package com.andysagent.ragent.feature.workbench

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.AgentoFrostedModalBottomSheet
import com.andysagent.ragent.core.designsystem.AgentoSwitch
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.RagentTransport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

private val collaborationJson = Json { ignoreUnknownKeys = true }
private data class CollaborationPolicySnapshot(
    val revision: Long,
    val baseCanDelegate: Boolean,
    val effective: JsonObject,
    val overrides: JsonObject,
)

private suspend fun readCollaborationPolicy(transport: RagentTransport, method: String, path: String, body: String? = null): CollaborationPolicySnapshot {
    val response = transport.execute(ApiRequest(method, path, body))
    if (!response.isSuccessful) throw CollaborationPolicyException(response.statusCode)
    val root = collaborationJson.parseToJsonElement(response.body).jsonObject
    return CollaborationPolicySnapshot(
        revision = root.getValue("revision").jsonPrimitive.long,
        baseCanDelegate = root.getValue("baseCanDelegate").jsonPrimitive.boolean,
        effective = root.getValue("effective").jsonObject,
        overrides = root["override"] as? JsonObject ?: JsonObject(emptyMap()),
    )
}
private class CollaborationPolicyException(val status: Int) : Exception()
private fun collaborationErrorStatus(error: Exception): Int = when (error) {
    is ApiException -> error.statusCode
    is CollaborationPolicyException -> error.status
    else -> -1
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CollaborationSettingsSheet(
    transport: RagentTransport?,
    sessionId: String?,
    onDismiss: () -> Unit,
    backdropLayer: GraphicsLayer? = null,
) {
    val colors = LocalRagentColors.current
    val scope = rememberCoroutineScope()
    var snapshot by remember(transport, sessionId) { mutableStateOf<CollaborationPolicySnapshot?>(null) }
    var loading by remember(transport, sessionId) { mutableStateOf(false) }
    var errorStatus by remember(transport, sessionId) { mutableStateOf<Int?>(null) }
    var dirty by remember(transport, sessionId) { mutableStateOf(setOf<String>()) }
    var canDelegate by remember(transport, sessionId) { mutableStateOf(false) }
    var concurrent by remember(transport, sessionId) { mutableStateOf("") }
    var children by remember(transport, sessionId) { mutableStateOf("") }
    var depth by remember(transport, sessionId) { mutableStateOf("") }
    val path = sessionId?.takeIf { it.isNotBlank() }?.let { "/api/sessions/${Uri.encode(it)}/collaboration-policy" }
    fun apply(value: CollaborationPolicySnapshot) {
        val nextDelegate = value.effective.getValue("canDelegate").jsonPrimitive.boolean
        val nextConcurrent = value.effective.getValue("maxConcurrent").jsonPrimitive.int.toString()
        val nextChildren = value.effective.getValue("maxChildren").jsonPrimitive.int.toString()
        val nextDepth = value.effective.getValue("maxDepth").jsonPrimitive.int.toString()
        canDelegate = nextDelegate; concurrent = nextConcurrent; children = nextChildren; depth = nextDepth
        snapshot = value
        dirty = emptySet()
    }
    suspend fun load() {
        if (path == null || transport == null) return
        loading = true; errorStatus = null
        try { apply(readCollaborationPolicy(transport, "GET", path)) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { errorStatus = collaborationErrorStatus(e) }
        finally { loading = false }
    }
    LaunchedEffect(transport, sessionId) { load() }
    val valid = concurrent.toIntOrNull()?.let { it in 1..64 } == true &&
        children.toIntOrNull()?.let { it in 1..200 } == true && depth.toIntOrNull()?.let { it in 0..8 } == true
    AgentoFrostedModalBottomSheet(onDismissRequest = onDismiss, backdropLayer = backdropLayer) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(stringResource(R.string.collaboration_settings), style = MaterialTheme.typography.titleMedium, color = colors.primaryContent)
            Text(stringResource(R.string.collaboration_policy_scope), style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
            if (path == null) {
                Text(stringResource(R.string.collaboration_policy_need_session), color = colors.secondaryContent)
            } else if (transport == null) {
                Text(stringResource(R.string.collaboration_policy_offline), color = colors.secondaryContent)
            } else if (snapshot == null) {
                if (loading) CircularProgressIndicator(Modifier.size(24.dp))
                else {
                    Text(stringResource(if (errorStatus == 403) R.string.collaboration_policy_forbidden else if (errorStatus == 404 || errorStatus == 501) R.string.collaboration_policy_unsupported else R.string.collaboration_policy_load_error), color = colors.error)
                    TextButton(onClick = { scope.launch { load() } }) { Text(stringResource(R.string.collaboration_policy_retry)) }
                }
            } else {
                val current = snapshot!!
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.collaboration_policy_delegate), color = colors.primaryContent)
                        if (!current.baseCanDelegate) Text(stringResource(R.string.collaboration_policy_delegate_locked), style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                    }
                    AgentoSwitch(checked = canDelegate, enabled = current.baseCanDelegate && !loading,
                        onCheckedChange = { canDelegate = it; dirty = dirty + "canDelegate" })
                }
                PolicyNumber(stringResource(R.string.collaboration_policy_concurrent), concurrent, 1..64, canDelegate && !loading) { concurrent = it; dirty = dirty + "maxConcurrent" }
                PolicyNumber(stringResource(R.string.collaboration_policy_children), children, 1..200, canDelegate && !loading) { children = it; dirty = dirty + "maxChildren" }
                PolicyNumber(stringResource(R.string.collaboration_policy_depth), depth, 0..8, canDelegate && !loading) { depth = it; dirty = dirty + "maxDepth" }
                if (errorStatus != null) {
                    Text(stringResource(if (errorStatus == 409) R.string.collaboration_policy_conflict else if (errorStatus == 403) R.string.collaboration_policy_forbidden else if (errorStatus == 404 || errorStatus == 501) R.string.collaboration_policy_unsupported else R.string.collaboration_policy_save_error), color = colors.error)
                    if (errorStatus == 409) TextButton(onClick = { scope.launch { load() } }) { Text(stringResource(R.string.collaboration_policy_reload)) }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    TextButton(enabled = !loading, onClick = { scope.launch {
                        loading = true; errorStatus = null
                        try { apply(readCollaborationPolicy(transport, "DELETE", "$path?expectedRevision=${current.revision}")) }
                        catch (e: CancellationException) { throw e }
                        catch (e: Exception) { errorStatus = collaborationErrorStatus(e) }
                        finally { loading = false }
                    } }) { Text(stringResource(R.string.collaboration_policy_reset)) }
                    Button(enabled = !loading && valid && dirty.isNotEmpty(), onClick = { scope.launch {
                        loading = true; errorStatus = null
                        val updates = current.overrides.toMutableMap()
                        if ("canDelegate" in dirty) { if (canDelegate) updates.remove("canDelegate") else updates["canDelegate"] = JsonPrimitive(false) }
                        if ("maxConcurrent" in dirty) updates["maxConcurrent"] = JsonPrimitive(concurrent.toInt())
                        if ("maxChildren" in dirty) updates["maxChildren"] = JsonPrimitive(children.toInt())
                        if ("maxDepth" in dirty) updates["maxDepth"] = JsonPrimitive(depth.toInt())
                        val body = buildJsonObject { put("expectedRevision", current.revision); put("override", JsonObject(updates)) }.toString()
                        try { readCollaborationPolicy(transport, "PUT", path, body); onDismiss() }
                        catch (e: CancellationException) { throw e }
                        catch (e: Exception) { errorStatus = collaborationErrorStatus(e) }
                        finally { loading = false }
                    } }) { Text(stringResource(R.string.collaboration_policy_save)) }
                }
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun PolicyNumber(label: String, value: String, range: IntRange, enabled: Boolean, onChange: (String) -> Unit) {
    val valid = value.toIntOrNull()?.let { it in range } == true
    OutlinedTextField(value = value, onValueChange = { if (it.length <= 3 && it.all(Char::isDigit)) onChange(it) },
        label = { Text(label) }, supportingText = { Text("${range.first}–${range.last}") },
        isError = enabled && !valid, enabled = enabled, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
}
