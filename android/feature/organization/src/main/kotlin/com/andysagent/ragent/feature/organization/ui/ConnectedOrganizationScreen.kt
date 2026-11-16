package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import java.security.MessageDigest
import com.andysagent.ragent.feature.organization.data.RealOrganizationApi
import com.andysagent.ragent.feature.organization.data.RealOrganizationRepository
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModel
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.AgentoIconButton
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.feature.organization.R

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
        if (loaded && connection != RuntimeConnectionState.AuthenticationRequired && cachedAt != null && offlineScope != null && (workOpen || messagesOpen)) {
            when {
                workOpen && organizationId != null -> OfflineOrganizationItems(cache, offlineScope, organizationId!!, null) { workOpen = false }
                messagesOpen && organizationId != null -> OfflineOrganizationItems(cache, offlineScope, organizationId!!, nodes) { messagesOpen = false }
                else -> Unit
            }
        }
        else if (loaded && connection == RuntimeConnectionState.Connected && workOpen && organizationId != null) {
            // Without a verified account/target scope, never restore another
            // transport's pending owner request after a change of identity.
            val workScope = "${targetId.orEmpty()}:${scopeKey.ifBlank { transportKey }}:$sessionId:${organizationId.orEmpty()}"
            workStateHolder.SaveableStateProvider(workScope) {
                FactoryTeamWorkspace(cachedTransport, organizationId!!, nodes, responsibilityDraft, selectedResponsibilityId, onResponsibilitySelected, sessionId, rootSessionId, scopeKey.isNotBlank(), onBack = { workOpen = false })
            }
        }
        else if (loaded && connection == RuntimeConnectionState.Connected && messagesOpen && organizationId != null) TeamMessagesScreen(cachedTransport, organizationId!!, nodes, onBack = { messagesOpen = false })
        else if (loaded && connection != RuntimeConnectionState.AuthenticationRequired && (connection == RuntimeConnectionState.Connected || cachedAt != null)) {
            if (cachedAt != null) Text(stringResource(R.string.organization_offline_snapshot), Modifier.padding(horizontal = 24.dp, vertical = 4.dp), color = LocalRagentColors.current.secondaryContent)
            OrganizationScreen(organizationViewModel, modifier = Modifier.weight(1f), onBack = onBack,
                onOpenWorkItems = { workOpen = true }, onOpenTeamMessages = { messagesOpen = true })
        }
        else {
            val colors = LocalRagentColors.current
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                AgentoIconButton(onClick = onBack, contentDescription = stringResource(R.string.organization_back)) {
                    AgentoWebIcon(AgentoWebGlyph.Back, contentDescription = null, modifier = Modifier.size(20.dp), tint = colors.primaryContent)
                }
                Text(stringResource(R.string.organization_title), Modifier.weight(1f).padding(start = 12.dp), color = colors.primaryContent, fontSize = 17.sp)
            }
            Column(Modifier.fillMaxWidth().padding(24.dp).background(colors.quietSurface, RoundedCornerShape(26.dp)).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val message = when {
                    cacheClearFailed -> R.string.organization_cache_unavailable
                    connection == RuntimeConnectionState.AuthenticationRequired -> R.string.organization_auth_required
                    connection != RuntimeConnectionState.Connected -> R.string.organization_reconnecting
                    status == "Loading organization…" -> R.string.organization_loading
                    status == "No organization is available for this session." -> R.string.organization_not_found
                    else -> R.string.organization_unavailable
                }
                Text(stringResource(message), color = colors.primaryContent)
                if (connection == RuntimeConnectionState.Connected && status != "Loading organization…") {
                    TextButton(onClick = { refresh++ }) { Text(stringResource(R.string.organization_retry)) }
                }
                if ((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                    TextButton(onClick = { demoOpen = true }) { Text(stringResource(R.string.organization_demo_open)) }
                }
            }
        }
    }
    if (demoOpen) OrganizationDemoScreen(onBack = { demoOpen = false })
    }
    }
}
