package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.key
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.feature.organization.data.OrganizationOfflineCache
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.security.MessageDigest
import com.andysagent.ragent.feature.organization.data.RealOrganizationApi
import com.andysagent.ragent.feature.organization.data.RealOrganizationRepository
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.NativeDelegationDto
import com.andysagent.ragent.feature.organization.data.OrganizationProjectionDto
import com.andysagent.ragent.feature.organization.data.BirthEventTracker
import com.andysagent.ragent.feature.organization.data.NativeBirthEvent
import com.andysagent.ragent.feature.organization.data.BirthCue
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModel
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.OrganizationConversationContent

private data class NativeBirthFrame(val records: List<NativeDelegationDto>, val cues: List<BirthCue>)

@Composable
fun ConnectedOrganizationScreen(transport: RagentTransport, sessionId: String, targetId: String?, offlineScope: String? = null, responsibilityDraft: String = "", selectedResponsibilityId: String? = null, onResponsibilitySelected: (String?) -> Unit = {}, onBack: () -> Unit, embedded: Boolean = false, modifier: Modifier = Modifier, onRootClick: (Rect) -> Unit = {}, onRootAnchorChanged: (Rect?) -> Unit = {}, revealRoot: Boolean = false, rootHidden: Boolean = false, onRootVisualChanged: (OrganizationRootVisual) -> Unit = {}, openNodeId: String? = null, onOpenNodeConsumed: () -> Unit = {}, records: List<NativeDelegationDto> = emptyList(), nativeEvents: List<NativeBirthEvent> = emptyList(), nativeContinuous: Boolean = false, programmaticOpen: Pair<String, String>? = null, onProgrammaticOpenConsumed: () -> Unit = {}, onCollaboratorSnapshot: (resolved: Boolean, definitive: Boolean, hasCollaborators: Boolean) -> Unit = { _, _, _ -> }, onHasCollaboratorsChanged: (Boolean) -> Unit = {}, rootAction: com.andysagent.ragent.feature.organization.presentation.NodeActionKind? = null, nativeReceiptElapsed: Long = 0L) {
    val context = LocalContext.current
    var demoOpen by remember { mutableStateOf(false) }
    val cache = remember(context) { OrganizationOfflineCache(context) }
    val uiScope = rememberCoroutineScope()
    val connection by transport.connectionState.collectAsState()
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    val scopeKey = remember(offlineScope) { offlineScope?.let { scope -> MessageDigest.getInstance("SHA-256").digest(scope.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) } }.orEmpty() }
    val workStateHolder = rememberSaveableStateHolder()
    var ownerVerified by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var ownerGeneration by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<Long?>(null) }
    var conversationRuntime by remember(transport, targetId, sessionId, scopeKey, ownerGeneration) { mutableStateOf<Pair<String, String?>?>(null) }
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
    val localDemoReplay = LocalOrganizationDemoBirthReplay.current
    val localDemoReplaySequence = localDemoReplay?.sequence

    var status by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf("Loading organization…") }
    var loaded by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var refresh by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(0) }
    var organizationId by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<String?>(null) }
    var rootSessionId by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<String?>(null) }
    var workOpen by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(selectedResponsibilityId != null) }
    var messagesOpen by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var organizationNotFound by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var baseProjection by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<OrganizationProjectionDto?>(null) }
    var formalActivityAvailable by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var formalReceiptElapsed by remember(transport, targetId, sessionId, scopeKey) { mutableLongStateOf(0L) }
    var nodes by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<List<OrganizationNodeDto>>(emptyList()) }
    val formalBirthTracker = remember(transport, targetId, sessionId, scopeKey) { BirthEventTracker() }
    val nativeBirthTracker = remember(transport, targetId, sessionId, scopeKey) { BirthEventTracker() }
    var nativeFrame by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(NativeBirthFrame(emptyList(), emptyList())) }
    val latestRecords by rememberUpdatedState(nativeFrame.records)
    val latestMemberName by rememberUpdatedState(stringResource(R.string.organization_native_member))
    LaunchedEffect(scopeKey, cacheInvalidations) {
        val generation = projectionGeneration
        if (offlineScope != null && generation != null && !cache.isCurrent(offlineScope, generation)) {
            ownerVerified = false
            ownerGeneration = null
            projectionGeneration = null
            loaded = false
            organizationId = null
            baseProjection = null
            organizationNotFound = false
            nodes = emptyList()
            cachedAt = null
            status = "Organization access changed. Refresh to check current authorization."
            cacheClearFailed = cache.isInvalid(offlineScope)
        }
    }
    LaunchedEffect(transport, targetId, sessionId, scopeKey, refresh, connection) {
        val retained = loaded && ownerVerified && offlineScope != null && projectionGeneration != null &&
            ownerGeneration == projectionGeneration && cache.isCurrent(offlineScope, projectionGeneration!!)
        if (retained && connection != RuntimeConnectionState.Connected && connection != RuntimeConnectionState.AuthenticationRequired) return@LaunchedEffect
        if (!retained || connection == RuntimeConnectionState.AuthenticationRequired) {
            loaded = false
            ownerVerified = false
            ownerGeneration = null
            projectionGeneration = null
            cachedAt = null
            organizationId = null
            baseProjection = null
            organizationNotFound = false
            nodes = emptyList()
            status = "Loading organization…"
        }
        if (connection == RuntimeConnectionState.AuthenticationRequired && offlineScope != null) {
            cacheClearFailed = !withContext(Dispatchers.IO) { cache.clear(offlineScope) }
        }
        val requestGeneration = offlineScope?.let { cache.generation(it) }
        val online = connection == RuntimeConnectionState.Connected
        val cacheAllowed = offlineScope != null && connection != RuntimeConnectionState.AuthenticationRequired
        var confirmedNotFound = false
        val body: String? = if (online) {
            val ownerResponse: Boolean? = if (cacheAllowed) try {
                val response = transport.execute(ApiRequest("GET", "/api/auth/me"))
                val info = JSONObject(response.body)
                response.isSuccessful && info.optString("role") == "owner" && info.optString("principalKind") == "owner"
            } catch (error: CancellationException) {
                throw error
            } catch (error: ApiException) {
                if (error.statusCode == 401 || error.statusCode == 403) false else null
            } catch (_: Exception) {
                null
            } else false
            val owner = ownerResponse == true && (offlineScope == null || (requestGeneration != null && cache.isCurrent(offlineScope, requestGeneration)))
            if (ownerResponse != null) {
                ownerVerified = owner
                ownerGeneration = if (owner) requestGeneration else null
                if (!owner && offlineScope != null) cacheClearFailed = !withContext(Dispatchers.IO) { cache.clear(offlineScope) }
            }
            val response = try {
                transport.execute(ApiRequest("GET", "/api/sessions/${android.net.Uri.encode(sessionId)}/organization/projection"))
            } catch (error: ApiException) {
                confirmedNotFound = error.statusCode == 404 && error.code == "ORGANIZATION_NOT_FOUND" &&
                    (offlineScope == null || (requestGeneration != null && cache.isCurrent(offlineScope, requestGeneration)))
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
            if (response?.statusCode == 404 && runCatching { JSONObject(response.body).optString("code") }.getOrNull() == "ORGANIZATION_NOT_FOUND") {
                confirmedNotFound = offlineScope == null || (requestGeneration != null && cache.isCurrent(offlineScope, requestGeneration))
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
            formalActivityAvailable = false
            formalReceiptElapsed = 0L
            organizationNotFound = confirmedNotFound
            status = if (confirmedNotFound) "No organization is available for this session." else if (online) "Organization unavailable." else "Offline: no authorized cached organization is available."
        } else {
            val responseTransport = object : RagentTransport by transport {
                override suspend fun execute(request: ApiRequest): ApiResponse = ApiResponse(200, body)
            }
            RealOrganizationApi(responseTransport).getSessionOrganization(sessionId).fold(
                onSuccess = { projection ->
                    val stillCurrent = offlineScope == null || (requestGeneration != null && cache.isCurrent(offlineScope, requestGeneration))
                    if (!stillCurrent) status = "Organization access changed. Refresh to check current authorization."
                    else if (projection == null) status = "No organization is available for this session."
                    else { baseProjection = projection; organizationId = projection.organizationId; rootSessionId = projection.rootSessionId; nodes = projection.nodes; projectionGeneration = requestGeneration; loaded = true; formalActivityAvailable = online; formalReceiptElapsed = if (online) android.os.SystemClock.elapsedRealtime() else 0L }
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
                        baseProjection = null
                        organizationNotFound = false
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
                    baseProjection = null
                    organizationNotFound = false
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
    LaunchedEffect(transport, targetId, sessionId, scopeKey, organizationId, ownerVerified, ownerGeneration, projectionGeneration, connection, cachedAt, lifecycleState, demoOpen) {
        val id = organizationId ?: return@LaunchedEffect
        val generation = projectionGeneration ?: return@LaunchedEffect
        val scope = offlineScope ?: return@LaunchedEffect
        if (!ownerVerified || ownerGeneration != generation || connection != RuntimeConnectionState.Connected || cachedAt != null || lifecycleState != Lifecycle.State.RESUMED || demoOpen) return@LaunchedEffect
        val api = RealOrganizationApi(cachedTransport)
        val actionApi = RealOrganizationApi(transport)
        var cursor = 0L
        var established = false
        while (true) {
            if (!cache.isCurrent(scope, generation)) return@LaunchedEffect
            val batch = mutableListOf<com.andysagent.ragent.feature.organization.data.OrganizationActionDto>()
            var nextCursor = cursor
            var complete = true
            var more: Boolean
            do {
                val response = actionApi.getSessionActions(sessionId, nextCursor)
                response.exceptionOrNull()?.let { if (it is CancellationException) throw it }
                val page = response.getOrNull()
                if (page == null || page.organizationId != id || page.rootSessionId != sessionId ||
                    (page.hasMore && page.nextAfterId <= nextCursor)) {
                    complete = false
                    break
                }
                batch.addAll(page.actions)
                nextCursor = page.nextAfterId
                more = page.hasMore
            } while (more)
            val result = api.getSessionOrganization(sessionId)
            result.exceptionOrNull()?.let { if (it is CancellationException) throw it }
            val projection = result.getOrNull()
            if (!cache.isCurrent(scope, generation)) return@LaunchedEffect
            if (projection == null || projection.organizationId != id || projection.rootSessionId != sessionId) {
                formalActivityAvailable = false
                formalReceiptElapsed = 0L
                formalBirthTracker.reset()
                cursor = 0L
                established = false
                delay(3_000)
                continue
            }
            if (!complete) {
                formalActivityAvailable = true
                formalReceiptElapsed = android.os.SystemClock.elapsedRealtime()
                formalBirthTracker.reset()
                cursor = 0L
                established = false
                baseProjection = projection
                nodes = projection.nodes
                delay(3_000)
                continue
            }
            val roots = projection.nodes.filter { it.sessionId == sessionId }
            val root = when (roots.size) {
                0 -> projection.nodes.filter { it.parentId == null }.singleOrNull()?.id
                1 -> roots.single().id
                else -> null
            }
            if (root == null) {
                formalBirthTracker.reset(); established = false; cursor = 0L
                delay(3_000); continue
            }
            val nativeNodes = nativeDisplayNodes(latestRecords, root, latestMemberName)
            val graph = projection.copy(nodes = projection.nodes + nativeNodes, edges = projection.edges + nativeDisplayEdges(nativeNodes))
            val cues = formalBirthTracker.observe("$scopeKey:$sessionId:$id", sessionId,
                established && projection.nodes.size < 200, graph.nodes.associate { it.id to it.parentId }, root, id, batch, emptyList(), emptyList())
            organizationViewModel.applyProjection(graph, birthCues = cues)
            formalActivityAvailable = true
            formalReceiptElapsed = android.os.SystemClock.elapsedRealtime()
            cursor = nextCursor
            established = projection.nodes.size < 200
            baseProjection = projection
            nodes = projection.nodes
            delay(3_000)
        }
    }
    LaunchedEffect(localDemoReplay, localDemoReplaySequence, loaded, baseProjection) {
        val replay = localDemoReplay ?: return@LaunchedEffect
        val requested = localDemoReplaySequence ?: return@LaunchedEffect
        if (!embedded || !loaded || baseProjection?.organizationId != "demo_only" ||
            (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0 ||
            !replay.consume(requested)) return@LaunchedEffect
        organizationViewModel.uiState.first { state ->
            state.nodes.any { it.id == "planning" && it.physicsFrame != null } &&
                state.nodes.any { it.id == "android" && it.physicsFrame != null } &&
                state.nodes.any { it.id == "backend" && it.physicsFrame != null }
        }
        organizationViewModel.replayLocalDemoBirths()
    }
    val rootSession = rootSessionId?.takeIf { it.isNotBlank() } ?: sessionId
    val rootMatches = nodes.filter { it.sessionId == rootSession }
    val rootNodeId = when (rootMatches.size) {
        0 -> nodes.filter { it.parentId == null }.singleOrNull()?.id
        1 -> rootMatches.single().id
        else -> null
    }
    LaunchedEffect(organizationViewModel, rootNodeId, rootAction, baseProjection, nativeFrame.records, nativeContinuous, nativeReceiptElapsed, connection, lifecycleState, cachedAt, formalActivityAvailable, formalReceiptElapsed) {
        while (true) {
            val actions = mutableMapOf<String, com.andysagent.ragent.feature.organization.presentation.NodeActionKind>()
            if (connection == RuntimeConnectionState.Connected && lifecycleState == Lifecycle.State.RESUMED) {
                val now = android.os.SystemClock.elapsedRealtime()
                if (formalActivityAvailable && cachedAt == null && formalReceiptElapsed > 0L && now - formalReceiptElapsed in 0L..15_000L) baseProjection?.nodes?.forEach { node ->
                    com.andysagent.ragent.feature.organization.presentation.nodeAction(node.activity)?.let { actions[node.id] = it }
                }
                if (nativeContinuous && nativeReceiptElapsed > 0L && now - nativeReceiptElapsed in 0L..15_000L) nativeFrame.records.forEach { record ->
                    com.andysagent.ragent.feature.organization.presentation.nodeAction(record.activity)?.let { actions[nativeNodeId(record.runId, record.delegationId)] = it }
                }
                if (rootNodeId != null) {
                    if (rootAction != null) actions[rootNodeId] = rootAction else actions.remove(rootNodeId)
                }
            }
            organizationViewModel.setNodeActions(actions)
            delay(3_000)
        }
    }
    val nativeMemberName = stringResource(R.string.organization_native_member)
    LaunchedEffect(records, nativeEvents, nativeContinuous, connection, lifecycleState, rootNodeId, baseProjection) {
        val root = rootNodeId ?: "native-root:$sessionId"
        val nativeNodes = nativeDisplayNodes(records, root, nativeMemberName)
        val formal = baseProjection
        val parents = (formal?.nodes.orEmpty() + nativeNodes).associate { it.id to it.parentId }.toMutableMap()
        parents.putIfAbsent(root, null)
        val cues = nativeBirthTracker.observe("$scopeKey:$sessionId:${formal?.organizationId.orEmpty()}", sessionId,
            nativeContinuous && connection == RuntimeConnectionState.Connected && lifecycleState == Lifecycle.State.RESUMED && (formal == null || formal.nodes.size < 200),
            parents, root, null, emptyList(), nativeEvents, records)
        if (formal != null && rootNodeId != null && cues.isNotEmpty()) {
            organizationViewModel.applyProjection(formal.copy(nodes = formal.nodes + nativeNodes, edges = formal.edges + nativeDisplayEdges(nativeNodes)), birthCues = cues)
        }
        // The fallback graph must receive the snapshot and its cue together.
        nativeFrame = NativeBirthFrame(records, if (formal == null) cues else emptyList())
    }
    LaunchedEffect(baseProjection, nativeFrame.records, rootNodeId, nativeMemberName) {
        val projection = baseProjection ?: return@LaunchedEffect
        val root = rootNodeId ?: return@LaunchedEffect
        val nativeNodes = nativeDisplayNodes(nativeFrame.records, root, nativeMemberName)
        organizationViewModel.applyProjection(projection.copy(nodes = projection.nodes + nativeNodes, edges = projection.edges + nativeDisplayEdges(nativeNodes)))
    }
    LaunchedEffect(embedded, loaded, status, connection, lifecycleState) {
        if (embedded && !loaded && status != "Loading organization…" && connection == RuntimeConnectionState.Connected && lifecycleState == Lifecycle.State.RESUMED) {
            delay(3_000)
            refresh++
        }
    }
    val hasCollaborators = records.isNotEmpty() || (loaded && baseProjection?.hasCreatedSubordinate == true)
    val snapshotResolved = loaded || status != "Loading organization…" || connection != RuntimeConnectionState.Connected
    val snapshotDefinitive = (loaded && baseProjection != null) || organizationNotFound
    LaunchedEffect(snapshotResolved, snapshotDefinitive, hasCollaborators, transport, targetId, sessionId, scopeKey) {
        onCollaboratorSnapshot(snapshotResolved, snapshotDefinitive, hasCollaborators)
        onHasCollaboratorsChanged(hasCollaborators)
    }
    CompositionLocalProvider(LocalContentColor provides LocalRagentColors.current.primaryContent) {
    Box(modifier.fillMaxSize()) {
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
        else if (loaded && connection != RuntimeConnectionState.AuthenticationRequired && (connection == RuntimeConnectionState.Connected || cachedAt != null || ownerVerified)) {
            if (connection != RuntimeConnectionState.Connected || cachedAt != null) Text(stringResource(R.string.organization_offline_snapshot), Modifier.padding(horizontal = 24.dp, vertical = 4.dp), color = LocalRagentColors.current.secondaryContent)
            key(scopeKey, transportKey, ownerGeneration, projectionGeneration, organizationId) {
                OrganizationScreen(organizationViewModel, modifier = Modifier.weight(1f), onBack = onBack,
                    onOpenWorkItems = { workOpen = true }, onOpenTeamMessages = { messagesOpen = true },
                    conversationContent = { nodeId, contentModifier ->
                        if (nodeId.startsWith("native:")) {
                            Text(stringResource(R.string.organization_native_conversation_unavailable), contentModifier.padding(20.dp))
                        } else if (ownerVerified &&
                            ownerGeneration != null && ownerGeneration == projectionGeneration && organizationId != null) {
                            val requestGeneration = ownerGeneration
                            val requestOrganization = organizationId
                            OrganizationConversationContent(transport, organizationId!!, nodeId, targetId,
                                identityScope = "$scopeKey:$transportKey:$ownerGeneration", modifier = contentModifier,
                                onRuntimeState = { state -> conversationRuntime = nodeId to state },
                                onAuthorizationDenied = {
                                    if (ownerGeneration == requestGeneration && organizationId == requestOrganization) {
                                        ownerVerified = false
                                        ownerGeneration = null
                                        projectionGeneration = null
                                        loaded = false
                                        organizationId = null
                                        baseProjection = null
                                        organizationNotFound = false
                                        nodes = emptyList()
                                        cachedAt = null
                                        status = "Organization access changed. Refresh to check current authorization."
                                        if (offlineScope != null) uiScope.launch {
                                            cacheClearFailed = !withContext(Dispatchers.IO) { cache.clear(offlineScope) }
                                        }
                                    }
                                })
                        } else {
                            Text(stringResource(R.string.organization_conversation_unavailable), contentModifier.padding(20.dp), color = LocalRagentColors.current.secondaryContent)
                        }
                    }, conversationRuntimeState = { nodeId -> conversationRuntime?.takeIf { it.first == nodeId }?.second },
                    embedded = embedded, embeddedRootId = rootNodeId, onRootClick = onRootClick, onRootAnchorChanged = onRootAnchorChanged, revealRoot = revealRoot, rootHidden = rootHidden, onRootVisualChanged = onRootVisualChanged, openNodeId = programmaticOpen?.let { nativeNodeId(it.first, it.second) } ?: openNodeId, onOpenNodeConsumed = { if (programmaticOpen != null) onProgrammaticOpenConsumed() else onOpenNodeConsumed() })
            }
        }
        else if (embedded && nativeFrame.records.isNotEmpty()) {
            NativeOrganizationGraph(transport, sessionId, nativeFrame.records, rootAction = rootAction.takeIf { connection == RuntimeConnectionState.Connected && lifecycleState == Lifecycle.State.RESUMED }, nativeActionsFresh = nativeContinuous && connection == RuntimeConnectionState.Connected && lifecycleState == Lifecycle.State.RESUMED, nativeReceiptElapsed = nativeReceiptElapsed, modifier = Modifier.weight(1f), onRootClick = onRootClick, onRootAnchorChanged = onRootAnchorChanged, onRootVisualChanged = onRootVisualChanged, revealRoot = revealRoot, rootHidden = rootHidden, programmaticOpen = programmaticOpen, onProgrammaticOpenConsumed = onProgrammaticOpenConsumed, birthCues = nativeFrame.cues,
                onBirthCuesConsumed = { consumed -> if (nativeFrame.cues == consumed) nativeFrame = nativeFrame.copy(cues = emptyList()) })
        }
        else if (!embedded) {
            val colors = LocalRagentColors.current
            Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
            Column(Modifier.widthIn(max = 600.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
            OrganizationNavigation(onBack = onBack, memberCount = null)
            Column(Modifier.fillMaxWidth().padding(top = 20.dp).background(colors.quietSurface, RoundedCornerShape(26.dp)).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val message = when {
                    cacheClearFailed -> R.string.organization_cache_unavailable
                    connection == RuntimeConnectionState.AuthenticationRequired -> R.string.organization_auth_required
                    connection != RuntimeConnectionState.Connected -> R.string.organization_reconnecting
                    status == "Loading organization…" -> R.string.organization_loading
                    status == "No organization is available for this session." -> R.string.organization_not_found
                    else -> R.string.organization_unavailable
                }
                Text(stringResource(message), color = colors.primaryContent, fontSize = 16.sp, lineHeight = 24.sp)
                if (connection == RuntimeConnectionState.Connected && status != "Loading organization…") {
                    TextButton(onClick = { refresh++ }) { Text(stringResource(R.string.organization_retry)) }
                }
                if ((context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                    TextButton(onClick = { demoOpen = true }) { Text(stringResource(R.string.organization_demo_open)) }
                }
            }
            }
            }
        }
    }
    if (demoOpen) OrganizationDemoScreen(onBack = { demoOpen = false })
    }
    }
}

/** Embedded graph; anchor rectangles are in Compose root coordinates, in pixels. */
@Composable
fun ConnectedOrganizationGraph(
    transport: RagentTransport, sessionId: String, targetId: String?, offlineScope: String? = null,
    modifier: Modifier = Modifier, onRootClick: (Rect) -> Unit, rootAction: com.andysagent.ragent.feature.organization.presentation.NodeActionKind? = null, nativeReceiptElapsed: Long = 0L,
    onRootAnchorChanged: (Rect?) -> Unit = {}, revealRoot: Boolean = false, rootHidden: Boolean = false, onRootVisualChanged: (OrganizationRootVisual) -> Unit = {}, openNodeId: String? = null, onOpenNodeConsumed: () -> Unit = {}, records: List<NativeDelegationDto> = emptyList(), nativeEvents: List<NativeBirthEvent> = emptyList(), nativeContinuous: Boolean = false, programmaticOpen: Pair<String, String>? = null, onProgrammaticOpenConsumed: () -> Unit = {}, onCollaboratorSnapshot: (resolved: Boolean, definitive: Boolean, hasCollaborators: Boolean) -> Unit = { _, _, _ -> }, onHasCollaboratorsChanged: (Boolean) -> Unit,
) {
    ConnectedOrganizationScreen(transport, sessionId, targetId, offlineScope, onBack = {}, embedded = true,
        modifier = modifier, onRootClick = onRootClick, onRootAnchorChanged = onRootAnchorChanged, revealRoot = revealRoot, rootHidden = rootHidden, onRootVisualChanged = onRootVisualChanged, openNodeId = openNodeId, onOpenNodeConsumed = onOpenNodeConsumed, records = records, nativeEvents = nativeEvents, nativeContinuous = nativeContinuous, programmaticOpen = programmaticOpen, onProgrammaticOpenConsumed = onProgrammaticOpenConsumed, onCollaboratorSnapshot = onCollaboratorSnapshot,
        onHasCollaboratorsChanged = onHasCollaboratorsChanged, rootAction = rootAction, nativeReceiptElapsed = nativeReceiptElapsed)
}
