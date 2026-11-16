package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.feature.organization.data.OrganizationOfflineCache
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant
import java.security.MessageDigest
import com.andysagent.ragent.feature.organization.data.RealOrganizationApi
import com.andysagent.ragent.feature.organization.data.RealOrganizationRepository
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModel
import com.andysagent.ragent.core.designsystem.LocalRagentColors

@Composable
fun ConnectedOrganizationScreen(transport: RagentTransport, sessionId: String, targetId: String?, offlineScope: String? = null, responsibilityDraft: String = "", selectedResponsibilityId: String? = null, onResponsibilitySelected: (String?) -> Unit = {}, onBack: () -> Unit) {
    val context = LocalContext.current
    var demoOpen by remember { mutableStateOf(false) }
    val cache = remember(context) { OrganizationOfflineCache(context) }
    val connection by transport.connectionState.collectAsState()
    val scopeKey = remember(offlineScope) { offlineScope?.let { scope -> MessageDigest.getInstance("SHA-256").digest(scope.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) } }.orEmpty() }
    val workStateHolder = rememberSaveableStateHolder()
    var ownerVerified by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var ownerGeneration by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<Long?>(null) }
    var projectionGeneration by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<Long?>(null) }
    val cacheInvalidations by cache.invalidations.collectAsState()
    var cachedAt by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<Long?>(null) }
    var cacheClearFailed by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(offlineScope?.let { cache.isInvalid(it) } == true) }
    val repository = remember(transport, targetId, sessionId, scopeKey) { RealOrganizationRepository(RealOrganizationApi(transport)) }
    val factory = remember(repository) {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = OrganizationViewModel(repository) as T
        }
    }
    val transportKey = remember(transport) { java.util.UUID.randomUUID().toString() }
    val organizationViewModel: OrganizationViewModel = viewModel(key = "organization:${targetId.orEmpty()}:$sessionId:$scopeKey:$transportKey", factory = factory)
    var status by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf("Loading organization…") }
    var loaded by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var refresh by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(0) }
    var organizationId by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<String?>(null) }
    var rootSessionId by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<String?>(null) }
    var workOpen by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(selectedResponsibilityId != null) }
    var messagesOpen by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var nodes by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<List<OrganizationNodeDto>>(emptyList()) }
    LaunchedEffect(scopeKey, cacheInvalidations) {
        val generation = projectionGeneration
        if (offlineScope != null && generation != null && !cache.isCurrent(offlineScope, generation)) {
            ownerVerified = false
            ownerGeneration = null
            projectionGeneration = null
            loaded = false
            organizationId = null
            nodes = emptyList()
            cachedAt = null
            status = "Organization access changed. Refresh to check current authorization."
            cacheClearFailed = cache.isInvalid(offlineScope)
        }
    }
    LaunchedEffect(transport, targetId, sessionId, scopeKey, refresh, connection) {
        loaded = false
        ownerVerified = false
        ownerGeneration = null
        projectionGeneration = null
        cachedAt = null
        if (connection == RuntimeConnectionState.AuthenticationRequired && offlineScope != null) {
            cacheClearFailed = !withContext(Dispatchers.IO) { cache.clear(offlineScope) }
        }
        organizationId = null
        nodes = emptyList()
        status = "Loading organization…"
        val requestGeneration = offlineScope?.let { cache.generation(it) }
        val online = connection == RuntimeConnectionState.Connected
        val cacheAllowed = offlineScope != null && connection != RuntimeConnectionState.AuthenticationRequired
        val body: String? = if (online) {
            val ownerResponse = if (cacheAllowed) try {
                val response = transport.execute(ApiRequest("GET", "/api/auth/me"))
                val info = JSONObject(response.body)
                response.isSuccessful && info.optString("role") == "owner" && info.optString("principalKind") == "owner"
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                false
            } else false
            val owner = ownerResponse && (offlineScope == null || (requestGeneration != null && cache.isCurrent(offlineScope, requestGeneration)))
            ownerVerified = owner
            ownerGeneration = if (owner) requestGeneration else null
            if (!owner && offlineScope != null) cacheClearFailed = !withContext(Dispatchers.IO) { cache.clear(offlineScope) }
            val response = try {
                transport.execute(ApiRequest("GET", "/api/sessions/${android.net.Uri.encode(sessionId)}/organization/projection"))
            } catch (error: ApiException) {
                if (error.statusCode in listOf(401, 403, 404, 405, 410, 501) && offlineScope != null) {
                    ownerVerified = false
                    ownerGeneration = null
                    cacheClearFailed = !withContext(Dispatchers.IO) { cache.clear(offlineScope) }
                }
                null
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                null
            }
            if (response != null && response.statusCode in listOf(401, 403, 404, 405, 410, 501) && offlineScope != null) {
                ownerVerified = false
                ownerGeneration = null
                cacheClearFailed = !withContext(Dispatchers.IO) { cache.clear(offlineScope) }
            }
            val stillCurrent = offlineScope == null || (requestGeneration != null && cache.isCurrent(offlineScope, requestGeneration))
            if (response?.isSuccessful == true && stillCurrent) {
                if (owner && offlineScope != null && requestGeneration != null) withContext(Dispatchers.IO) { cache.write(offlineScope, response.body, requestGeneration) }
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
            val responseTransport = object : RagentTransport by transport {
                override suspend fun execute(request: ApiRequest): ApiResponse = ApiResponse(200, body)
            }
            RealOrganizationApi(responseTransport).getSessionOrganization(sessionId).fold(
                onSuccess = { projection ->
                    val stillCurrent = offlineScope == null || (requestGeneration != null && cache.isCurrent(offlineScope, requestGeneration))
                    if (!stillCurrent) status = "Organization access changed. Refresh to check current authorization."
                    else if (projection == null) status = "No organization is available for this session."
                    else { organizationViewModel.applyProjection(projection); organizationId = projection.organizationId; rootSessionId = projection.rootSessionId; nodes = projection.nodes; projectionGeneration = requestGeneration; loaded = true }
                },
                onFailure = { status = "Organization unavailable: ${it.message ?: "request failed"}" },
            )
        }
    }
    val cachedTransport = remember(transport, offlineScope, organizationId, ownerVerified) {
        object : RagentTransport by transport {
            override suspend fun execute(request: ApiRequest): ApiResponse {
                if (transport.connectionState.value != RuntimeConnectionState.Connected) error("Offline controls are disabled")
                val requestGeneration = offlineScope?.let { cache.generation(it) }
                val response = try { transport.execute(request) } catch (error: ApiException) {
                    if (offlineScope != null && error.statusCode in listOf(401, 403, 404, 405, 410, 501)) {
                        ownerVerified = false
                        ownerGeneration = null
                        projectionGeneration = null
                        loaded = false
                        organizationId = null
                        nodes = emptyList()
                        cachedAt = null
                        status = "Organization access changed. Refresh to check current authorization."
                        cacheClearFailed = !withContext(Dispatchers.IO) { cache.clear(offlineScope) }
                    }
                    throw error
                }
                if (offlineScope != null && response.statusCode in listOf(401, 403, 404, 405, 410, 501)) {
                    ownerVerified = false
                    ownerGeneration = null
                    projectionGeneration = null
                    loaded = false
                    organizationId = null
                    nodes = emptyList()
                    cachedAt = null
                    status = "Organization access changed. Refresh to check current authorization."
                    cacheClearFailed = !withContext(Dispatchers.IO) { cache.clear(offlineScope) }
                } else if (offlineScope != null && ownerVerified && requestGeneration == ownerGeneration && request.method == "GET" && response.isSuccessful && organizationId != null) {
                    val base = "/api/organizations/${android.net.Uri.encode(organizationId)}/factory/"
                    val tail = request.path.removePrefix(base)
                    val permitted = request.path.startsWith(base) &&
                        (tail == "work-items" || tail.matches(Regex("work-items/[^/?]+")) || tail.matches(Regex("nodes/[^/?]+/messages")))
                    if (permitted && requestGeneration != null) withContext(Dispatchers.IO) { cache.write(offlineScope, response.body, requestGeneration, request.path) }
                }
                return response
            }
        }
    }
    CompositionLocalProvider(LocalContentColor provides LocalRagentColors.current.primaryContent) {
    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).then(
        if (demoOpen) Modifier.clearAndSetSemantics {} else Modifier,
    )) {
        if (!(loaded && workOpen && connection == RuntimeConnectionState.Connected && cachedAt == null && organizationId != null)) {
            TextButton(onClick = onBack) { Text("Back") }
        }
        if ((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0 && !workOpen && !messagesOpen) {
            TextButton(onClick = { demoOpen = true }) { Text("查看演示组织图") }
        }
        if (cacheClearFailed) Text("Offline data could not be removed. Offline snapshots are disabled for this app session.")
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
        else if (loaded && workOpen && organizationId != null) {
            // Without a verified account/target scope, never restore another
            // transport's pending owner request after a change of identity.
            val workScope = "${targetId.orEmpty()}:${scopeKey.ifBlank { transportKey }}:$sessionId:${organizationId.orEmpty()}"
            workStateHolder.SaveableStateProvider(workScope) {
                FactoryTeamWorkspace(cachedTransport, organizationId!!, nodes, responsibilityDraft, selectedResponsibilityId, onResponsibilitySelected, sessionId, rootSessionId, scopeKey.isNotBlank(), onBack = { workOpen = false })
            }
        }
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
    if (demoOpen) OrganizationDemoScreen(onBack = { demoOpen = false })
    }
    }
}
