package com.andysagent.agentoc.feature.organization.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiResponse
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.feature.organization.data.OrganizationOfflineCache
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant
import java.security.MessageDigest
import com.andysagent.agentoc.feature.organization.data.RealOrganizationApi
import com.andysagent.agentoc.feature.organization.data.RealOrganizationRepository
import com.andysagent.agentoc.feature.organization.data.OrganizationNodeDto
import com.andysagent.agentoc.feature.organization.presentation.OrganizationViewModel
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors

@Composable
fun ConnectedOrganizationScreen(transport: AgentoCTransport, sessionId: String, targetId: String?, offlineScope: String? = null, responsibilityDraft: String = "", selectedResponsibilityId: String? = null, onResponsibilitySelected: (String?) -> Unit = {}, onBack: () -> Unit) {
    val context = LocalContext.current
    val cache = remember(context) { OrganizationOfflineCache(context) }
    val connection by transport.connectionState.collectAsState()
    val scopeKey = remember(offlineScope) { offlineScope?.let { scope -> MessageDigest.getInstance("SHA-256").digest(scope.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) } }.orEmpty() }
    var ownerVerified by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var cachedAt by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<Long?>(null) }
    val repository = remember(transport, targetId, sessionId, scopeKey) { RealOrganizationRepository(RealOrganizationApi(transport)) }
    val factory = remember(repository) {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = OrganizationViewModel(repository) as T
        }
    }
    val organizationViewModel: OrganizationViewModel = viewModel(key = "organization:${targetId.orEmpty()}:$sessionId:$scopeKey", factory = factory)
    var status by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf("Loading organization…") }
    var loaded by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var refresh by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(0) }
    var organizationId by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<String?>(null) }
    var workOpen by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(selectedResponsibilityId != null) }
    var messagesOpen by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var nodes by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<List<OrganizationNodeDto>>(emptyList()) }
    LaunchedEffect(transport, targetId, sessionId, scopeKey, refresh, connection) {
        loaded = false
        ownerVerified = false
        cachedAt = null
        if (connection == RuntimeConnectionState.AuthenticationRequired && offlineScope != null) withContext(Dispatchers.IO) { cache.clear(offlineScope) }
        organizationId = null
        nodes = emptyList()
        status = "Loading organization…"
        val online = connection == RuntimeConnectionState.Connected
        val cacheAllowed = offlineScope != null && connection != RuntimeConnectionState.AuthenticationRequired
        val body: String? = if (online) {
            val owner = if (cacheAllowed) try {
                val response = transport.execute(ApiRequest("GET", "/api/auth/me"))
                val info = JSONObject(response.body)
                response.isSuccessful && info.optString("role") == "owner" && info.optString("principalKind") == "owner"
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                false
            } else false
            ownerVerified = owner
            if (!owner && offlineScope != null) withContext(Dispatchers.IO) { cache.clear(offlineScope) }
            val response = try {
                transport.execute(ApiRequest("GET", "/api/sessions/${android.net.Uri.encode(sessionId)}/organization/projection"))
            } catch (error: ApiException) {
                if (error.statusCode in listOf(401, 403, 404, 405, 410, 501) && offlineScope != null) {
                    ownerVerified = false
                    withContext(Dispatchers.IO) { cache.clear(offlineScope) }
                }
                null
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                null
            }
            if (response != null && response.statusCode in listOf(401, 403, 404, 405, 410, 501) && offlineScope != null) {
                ownerVerified = false
                withContext(Dispatchers.IO) { cache.clear(offlineScope) }
            }
            if (response?.isSuccessful == true) {
                if (owner && offlineScope != null) withContext(Dispatchers.IO) { cache.write(offlineScope, response.body) }
                response.body
            } else null
        } else if (cacheAllowed && offlineScope != null) {
            val saved = withContext(Dispatchers.IO) { cache.read(offlineScope) }
            cachedAt = saved?.second
            saved?.first
        } else null
        if (body == null) {
            status = if (online) "Organization unavailable." else "Offline: no authorized cached organization is available."
        } else {
            val responseTransport = object : AgentoCTransport by transport {
                override suspend fun execute(request: ApiRequest): ApiResponse = ApiResponse(200, body)
            }
            RealOrganizationApi(responseTransport).getSessionOrganization(sessionId).fold(
                onSuccess = { projection ->
                    if (projection == null) status = "No organization is available for this session."
                    else { organizationViewModel.applyProjection(projection); organizationId = projection.organizationId; nodes = projection.nodes; loaded = true }
                },
                onFailure = { status = "Organization unavailable: ${it.message ?: "request failed"}" },
            )
        }
    }
    val cachedTransport = remember(transport, offlineScope, organizationId, ownerVerified) {
        object : AgentoCTransport by transport {
            override suspend fun execute(request: ApiRequest): ApiResponse {
                if (transport.connectionState.value != RuntimeConnectionState.Connected) error("Offline controls are disabled")
                val response = try { transport.execute(request) } catch (error: ApiException) {
                    if (offlineScope != null && error.statusCode in listOf(401, 403, 404, 405, 410, 501)) {
                        ownerVerified = false
                        withContext(Dispatchers.IO) { cache.clear(offlineScope) }
                    }
                    throw error
                }
                if (offlineScope != null && response.statusCode in listOf(401, 403, 404, 405, 410, 501)) {
                    ownerVerified = false
                    withContext(Dispatchers.IO) { cache.clear(offlineScope) }
                } else if (offlineScope != null && ownerVerified && request.method == "GET" && response.isSuccessful && organizationId != null) {
                    val base = "/api/organizations/${android.net.Uri.encode(organizationId)}/factory/"
                    val tail = request.path.removePrefix(base)
                    val permitted = request.path.startsWith(base) &&
                        (tail == "work-items" || tail.matches(Regex("work-items/[^/?]+")) || tail.matches(Regex("nodes/[^/?]+/messages")))
                    if (permitted) withContext(Dispatchers.IO) { cache.write(offlineScope, response.body, request.path) }
                }
                return response
            }
        }
    }
    Column(Modifier.fillMaxSize().background(LocalAgentocColors.current.canvas)) {
        TextButton(onClick = onBack) { Text("Back") }
        if (cachedAt != null && connection != RuntimeConnectionState.AuthenticationRequired) Text("Offline snapshot from ${Instant.ofEpochMilli(cachedAt!!)}. Read-only; reconnect to refresh.")
        if (connection != RuntimeConnectionState.Connected && (cachedAt == null || connection == RuntimeConnectionState.AuthenticationRequired)) {
            Text("Offline: authorized snapshot unavailable.")
        }
        else if (loaded && cachedAt != null && offlineScope != null) {
            when {
                workOpen && organizationId != null -> OfflineOrganizationItems(cache, offlineScope, organizationId!!, null) { workOpen = false }
                messagesOpen && organizationId != null -> OfflineOrganizationItems(cache, offlineScope, organizationId!!, nodes) { messagesOpen = false }
                else -> {
                    TextButton(onClick = { workOpen = true }) { Text("Cached work items") }
                    TextButton(onClick = { messagesOpen = true }) { Text("Cached team messages") }
                    nodes.forEach { node -> Text("${node.displayName.ifBlank { node.id }} · ${node.status}") }
                }
            }
        }
        else if (loaded && workOpen && organizationId != null) FactoryWorkScreen(cachedTransport, organizationId!!, responsibilityDraft, selectedResponsibilityId, onResponsibilitySelected, sessionId, onBack = { workOpen = false })
        else if (loaded && messagesOpen && organizationId != null) TeamMessagesScreen(cachedTransport, organizationId!!, nodes, onBack = { messagesOpen = false })
        else if (loaded) {
            TextButton(onClick = { workOpen = true }) { Text("Work items") }
            TextButton(onClick = { messagesOpen = true }) { Text("Team messages") }
            OrganizationScreen(organizationViewModel, modifier = Modifier.weight(1f))
        }
        else {
            Text(status)
            TextButton(onClick = { refresh++ }) { Text("Retry") }
        }
    }
}
