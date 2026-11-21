package com.andysagent.ragent.feature.organization.ui

import androidx.activity.compose.BackHandler
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
import kotlinx.serialization.json.contentOrNull
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
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.security.MessageDigest
import com.andysagent.ragent.feature.organization.data.RealOrganizationApi
import com.andysagent.ragent.feature.organization.data.SwarmBoardResponseDto
import com.andysagent.ragent.feature.organization.data.SwarmStatusDto
import com.andysagent.ragent.feature.organization.data.UnifiedMembersPageDto
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
private data class UnifiedMemberFrame(val page: com.andysagent.ragent.feature.organization.data.UnifiedMembersPageDto? = null, val cues: List<BirthCue> = emptyList())

@Composable
fun ConnectedOrganizationScreen(transport: RagentTransport, sessionId: String, targetId: String?, offlineScope: String? = null, responsibilityDraft: String = "", selectedResponsibilityId: String? = null, onResponsibilitySelected: (String?) -> Unit = {}, responsibilityNavigationKey: String? = null, selectedPlanId: String? = null, onBack: () -> Unit, embedded: Boolean = false, modifier: Modifier = Modifier, onRootClick: (Rect) -> Unit = {}, onRootAnchorChanged: (Rect?) -> Unit = {}, revealRoot: Boolean = false, rootHidden: Boolean = false, onRootVisualChanged: (OrganizationRootVisual) -> Unit = {}, openNodeId: String? = null, onOpenNodeConsumed: () -> Unit = {}, records: List<NativeDelegationDto> = emptyList(), nativeEvents: List<NativeBirthEvent> = emptyList(), nativeContinuous: Boolean = false, programmaticOpen: Pair<String, String>? = null, onProgrammaticOpenConsumed: () -> Unit = {}, onCollaboratorSnapshot: (resolved: Boolean, definitive: Boolean, hasCollaborators: Boolean) -> Unit = { _, _, _ -> }, onHasCollaboratorsChanged: (Boolean) -> Unit = {}, rootAction: com.andysagent.ragent.feature.organization.presentation.NodeActionKind? = null, nativeReceiptElapsed: Long = 0L) {
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
    LaunchedEffect(selectedResponsibilityId, responsibilityNavigationKey) {
        if (selectedResponsibilityId != null) {
            workOpen = true
        }
    }
    var messagesOpen by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var organizationNotFound by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var baseProjection by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<OrganizationProjectionDto?>(null) }
    var formalActivityAvailable by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var formalReceiptElapsed by remember(transport, targetId, sessionId, scopeKey) { mutableLongStateOf(0L) }
    var nodes by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<List<OrganizationNodeDto>>(emptyList()) }
    val formalBirthTracker = remember(transport, targetId, sessionId, scopeKey) { BirthEventTracker() }
    val nativeBirthTracker = remember(transport, targetId, sessionId, scopeKey) { BirthEventTracker() }
    var nativeFrame by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(NativeBirthFrame(emptyList(), emptyList())) }
    var rawUnifiedMembers by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<UnifiedMembersPageDto?>(null) }
    var unifiedFrame by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(UnifiedMemberFrame()) }
    val unifiedMembers = unifiedFrame.page
    val unifiedBirthTracker = remember(transport, targetId, sessionId, scopeKey) { BirthEventTracker() }
    var unifiedReceipt by remember(transport, targetId, sessionId, scopeKey) { mutableLongStateOf(0L) }
    var unifiedResolved by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    var swarmStatus by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<SwarmStatusDto?>(null) }
    var boardResponse by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf<SwarmBoardResponseDto?>(null) }
    var swarmResolved by remember(transport, targetId, sessionId, scopeKey) { mutableStateOf(false) }
    LaunchedEffect(transport, targetId, sessionId, scopeKey, connection, lifecycleState, demoOpen) {
        if (demoOpen) {
            swarmResolved = true
            return@LaunchedEffect
        }
        if (connection == RuntimeConnectionState.AuthenticationRequired) {
            swarmStatus = null
            boardResponse = null
            swarmResolved = true
            organizationViewModel.clearSwarmAndBoard()
            return@LaunchedEffect
        }
        if (connection != RuntimeConnectionState.Connected || lifecycleState != Lifecycle.State.RESUMED) {
            swarmResolved = true
            return@LaunchedEffect
        }
        val api = RealOrganizationApi(transport)
        while (true) {
            coroutineScope {
                val activeChannel = organizationViewModel.activeBoardChannel()
                val swarmDeferred = async { api.getSwarmStatus(sessionId) }
                val boardDeferred = async { api.getBoard(sessionId, channel = activeChannel) }
                val swarmResult = swarmDeferred.await()
                val boardResult = boardDeferred.await()
                swarmResult.exceptionOrNull()?.let { if (it is CancellationException) throw it }
                boardResult.exceptionOrNull()?.let { if (it is CancellationException) throw it }
                swarmResult.onSuccess { dto ->
                    swarmStatus = dto
                    organizationViewModel.applySwarmStatus(dto)
                }
                boardResult.onSuccess { dto ->
                    boardResponse = dto
                    organizationViewModel.applyBoardResponse(dto)
                }
            }
            swarmResolved = true
            delay(3_000)
        }
    }
    LaunchedEffect(transport, targetId, sessionId, scopeKey, connection, lifecycleState) {
        unifiedReceipt = 0L
        if (connection == RuntimeConnectionState.AuthenticationRequired) { rawUnifiedMembers = null; unifiedFrame = UnifiedMemberFrame(); unifiedResolved = true; return@LaunchedEffect }
        if (connection != RuntimeConnectionState.Connected || lifecycleState != Lifecycle.State.RESUMED) { unifiedResolved = true; return@LaunchedEffect }
        val api = RealOrganizationApi(transport)
        while (true) {
            val result = api.getSessionMembers(sessionId)
            result.exceptionOrNull()?.let { if (it is CancellationException) throw it }
            val page = result.getOrNull()
            unifiedResolved = true
            if (page != null && page.rootSessionId == sessionId && page.members.map { it.canonicalId }.distinct().size == page.members.size) {
                val previous = rawUnifiedMembers?.takeIf { it.rootCanonicalId == page.rootCanonicalId }
                val trustedComplete = page.membersComplete && page.sourceCoverage?.gap == false
                rawUnifiedMembers = if (trustedComplete || previous == null) page else {
                    val merged = previous.members.associateBy { it.canonicalId }.mapValues { it.value.copy(activity = null) }.toMutableMap()
                    page.members.forEach { member ->
                        val old = merged[member.canonicalId]
                        merged[member.canonicalId] = if (old == null) member else member.copy(
                            aliases = (old.aliases + member.aliases).distinct(),
                            parentCanonicalId = if (member.relationKnown) member.parentCanonicalId else old.parentCanonicalId,
                            relationKnown = member.relationKnown || old.relationKnown,
                            birth = member.birth ?: old.birth,
                        )
                    }
                    page.copy(members = merged.values.toList())
                }
                unifiedReceipt = if (page.sourceCoverage?.gap == false) android.os.SystemClock.elapsedRealtime() else 0L
            } else {
                unifiedReceipt = 0L
                val error = result.exceptionOrNull()
                if (error is ApiException && error.statusCode in setOf(401, 403)) { rawUnifiedMembers = null; unifiedFrame = UnifiedMemberFrame() }
            }
            delay(3_000)
        }
    }
    val latestRecords by rememberUpdatedState(nativeFrame.records)
    val latestUnifiedMembers by rememberUpdatedState(unifiedMembers)
    val latestRootChildren by rememberUpdatedState(confirmedRootChildren(nativeEvents, sessionId))
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
                transport.execute(ApiRequest("GET", "/api/sessions/${android.net.Uri.encode(sessionId)}/organization/projection?version=2"))
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
                    if (offlineScope != null && com.andysagent.ragent.feature.organization.data.isOrganizationAuthorizationRevokedStatus(error.statusCode)) {
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
                if (offlineScope != null && com.andysagent.ragent.feature.organization.data.isOrganizationAuthorizationRevokedStatus(response.statusCode)) {
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
                return com.andysagent.ragent.feature.organization.data.normalizeOrganizationUnavailableResponse(response)
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
            val matchedRoot = resolveFormalRootNodeId(projection.nodes, sessionId, projection.rootSessionId)
            val root = matchedRoot ?: "root:$sessionId"
            val nativeNodes = nativeDisplayNodes(latestRecords, root, latestMemberName, latestRootChildren)
            val graphNodes = latestUnifiedMembers?.let { unifiedMemberNodes(it, root, projection.nodes, latestMemberName) } ?: projection.nodes
            val graph = projection.copy(nodes = graphNodes, edges = unifiedMemberEdges(graphNodes, projection.edges))
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
    val rootNodeId = resolveFormalRootNodeId(nodes, sessionId, rootSessionId)
    val nativeMemberName = stringResource(R.string.organization_native_member)
    LaunchedEffect(rawUnifiedMembers, unifiedReceipt, connection, lifecycleState, rootNodeId, baseProjection, nativeMemberName) {
        val page = rawUnifiedMembers
        if (page == null || unifiedReceipt == 0L || connection != RuntimeConnectionState.Connected || lifecycleState != Lifecycle.State.RESUMED) {
            unifiedBirthTracker.reset()
            unifiedFrame = UnifiedMemberFrame(page)
            return@LaunchedEffect
        }
        val root = rootNodeId ?: page.rootCanonicalId
        val formal = baseProjection
        val graphNodes = unifiedMemberNodes(page, root, formal?.nodes.orEmpty(), nativeMemberName)
        val parents = graphNodes.associate { it.id to it.parentId }.toMutableMap()
        parents.putIfAbsent(root, null)
        val births = page.members.mapNotNull { member ->
            val birth = member.birth ?: return@mapNotNull null
            val child = unifiedDisplayId(page, member.canonicalId, root, formal?.nodes.orEmpty()) ?: return@mapNotNull null
            val actor = unifiedDisplayId(page, birth.actorCanonicalId, root, formal?.nodes.orEmpty()) ?: return@mapNotNull null
            val rawTime = (birth.timestamp as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
            val timestamp = rawTime?.toLongOrNull() ?: rawTime?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() } ?: 0L
            com.andysagent.ragent.feature.organization.data.UnifiedBirthEvent(birth.id, child, actor, timestamp)
        }
        val cues = unifiedBirthTracker.observe("$scopeKey:$sessionId:${page.rootCanonicalId}:$root", sessionId,
            page.sourceCoverage?.gap == false, parents, root, null, emptyList(), emptyList(), emptyList(), births)
        if (formal != null) {
            organizationViewModel.applyProjection(formal.copy(nodes = graphNodes, edges = unifiedMemberEdges(graphNodes, formal.edges)), birthCues = cues)
            unifiedFrame = UnifiedMemberFrame(page)
        } else unifiedFrame = UnifiedMemberFrame(page, cues)
    }
    LaunchedEffect(organizationViewModel, rootNodeId, rootAction, baseProjection, nativeFrame.records, nativeContinuous, nativeReceiptElapsed, unifiedMembers, unifiedReceipt, connection, lifecycleState, cachedAt, formalActivityAvailable, formalReceiptElapsed) {
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
                if (unifiedReceipt > 0L && now - unifiedReceipt in 0L..15_000L) unifiedMembers?.members?.forEach { member ->
                    val id = unifiedMembers?.let { page -> unifiedDisplayId(page, member.canonicalId, rootNodeId ?: page.rootCanonicalId, nodes) }
                    if (id != null) com.andysagent.ragent.feature.organization.presentation.nodeAction(member.activity)?.let { actions[id] = it }
                }
                if (rootNodeId != null) {
                    if (rootAction != null) actions[rootNodeId] = rootAction else actions.remove(rootNodeId)
                }
            }
            organizationViewModel.setNodeActions(actions)
            delay(3_000)
        }
    }
    LaunchedEffect(records, nativeEvents, nativeContinuous, connection, lifecycleState, rootNodeId, baseProjection, unifiedMembers) {
        val root = rootNodeId ?: "native-root:$sessionId"
        val nativeNodes = nativeDisplayNodes(records, root, nativeMemberName, confirmedRootChildren(nativeEvents, sessionId))
        val formal = baseProjection
        val graphNodes = unifiedMembers?.let { unifiedMemberNodes(it, root, formal?.nodes.orEmpty(), nativeMemberName) } ?: formal?.nodes.orEmpty()
        val parents = graphNodes.associate { it.id to it.parentId }.toMutableMap()
        parents.putIfAbsent(root, null)
        val cues = nativeBirthTracker.observe("$scopeKey:$sessionId:${formal?.organizationId.orEmpty()}", sessionId,
            nativeContinuous && connection == RuntimeConnectionState.Connected && lifecycleState == Lifecycle.State.RESUMED && (formal == null || formal.nodes.size < 200),
            parents, root, null, emptyList(), nativeEvents, records)
        if (formal != null && cues.isNotEmpty()) {
            organizationViewModel.applyProjection(formal.copy(nodes = graphNodes, edges = unifiedMemberEdges(graphNodes, formal.edges)), birthCues = cues.filter { it.nodeId in parents })
        }
        // The fallback graph must receive the snapshot and its cue together.
        nativeFrame = NativeBirthFrame(records, if (formal == null) cues else emptyList())
    }
    LaunchedEffect(baseProjection, nativeFrame.records, rootNodeId, nativeMemberName, nativeEvents, unifiedMembers) {
        val projection = baseProjection ?: return@LaunchedEffect
        val root = rootNodeId ?: "root:$sessionId"
        val nativeNodes = nativeDisplayNodes(nativeFrame.records, root, nativeMemberName, confirmedRootChildren(nativeEvents, sessionId))
        val graphNodes = unifiedMembers?.let { unifiedMemberNodes(it, root, projection.nodes, nativeMemberName) } ?: projection.nodes
        organizationViewModel.applyProjection(projection.copy(nodes = graphNodes, edges = unifiedMemberEdges(graphNodes, projection.edges)))
    }
    LaunchedEffect(embedded, loaded, status, connection, lifecycleState) {
        if (embedded && !loaded && status != "Loading organization…" && connection == RuntimeConnectionState.Connected && lifecycleState == Lifecycle.State.RESUMED) {
            delay(3_000)
            refresh++
        }
    }
    val hasSwarmOrBoard = swarmStatus != null || boardResponse?.activeBoard != null || boardResponse?.mode == "ragent_swarm"
    val hasCollaborators = computeHasCollaborators(unifiedMembers, loaded, baseProjection, swarmStatus, boardResponse)
    val snapshotResolved = unifiedResolved && (swarmResolved || connection != RuntimeConnectionState.Connected) &&
        (loaded || hasSwarmOrBoard || status != "Loading organization…" || connection != RuntimeConnectionState.Connected)
    // A successful gap-free observation establishes the current display baseline;
    // it does not assert that the historical member source is complete.
    val observedBaseline = unifiedReceipt > 0L && unifiedMembers?.sourceCoverage?.gap == false &&
        connection == RuntimeConnectionState.Connected && lifecycleState == Lifecycle.State.RESUMED &&
        ((loaded && baseProjection != null && formalActivityAvailable) || organizationNotFound)
    val snapshotDefinitive = hasCollaborators || observedBaseline
    LaunchedEffect(snapshotResolved, snapshotDefinitive, hasCollaborators, transport, targetId, sessionId, scopeKey) {
        onCollaboratorSnapshot(snapshotResolved, snapshotDefinitive, hasCollaborators)
        onHasCollaboratorsChanged(hasCollaborators)
    }
    if (!embedded) {
        BackHandler(enabled = workOpen) { workOpen = false }
        BackHandler(enabled = messagesOpen) { messagesOpen = false }
    }
    CompositionLocalProvider(LocalContentColor provides LocalRagentColors.current.primaryContent) {
    Box(modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).then(
        if (demoOpen) Modifier.clearAndSetSemantics {} else Modifier,
    )) {
        val effectiveOrganizationId = organizationId ?: swarmStatus?.organizationId ?: boardResponse?.organizationId
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
                FactoryTeamWorkspace(cachedTransport, organizationId!!, nodes, responsibilityDraft, selectedResponsibilityId, onResponsibilitySelected, responsibilityNavigationKey, selectedPlanId, sessionId, rootSessionId, scopeKey.isNotBlank(), onBack = { workOpen = false })
            }
        }
        else if (loaded && connection == RuntimeConnectionState.Connected && messagesOpen && organizationId != null) TeamMessagesScreen(cachedTransport, organizationId!!, nodes, onBack = { messagesOpen = false })
        else if ((loaded || hasSwarmOrBoard) && connection != RuntimeConnectionState.AuthenticationRequired && (connection == RuntimeConnectionState.Connected || cachedAt != null || ownerVerified)) {
            if (loaded && (connection != RuntimeConnectionState.Connected || cachedAt != null)) {
                Text(stringResource(R.string.organization_offline_snapshot), Modifier.padding(horizontal = 24.dp, vertical = 4.dp), color = LocalRagentColors.current.secondaryContent)
            }
            key(scopeKey, transportKey, ownerGeneration, projectionGeneration, effectiveOrganizationId) {
                OrganizationScreen(
                    organizationViewModel,
                    modifier = Modifier.weight(1f),
                    onBack = onBack,
                    onOpenWorkItems = { workOpen = true }.takeIf { organizationId != null },
                    onOpenTeamMessages = { messagesOpen = true }.takeIf { organizationId != null },
                    conversationContent = { nodeId, contentModifier ->
                        val member = nodes.firstOrNull { it.id == nodeId }
                        val swarmMember = swarmStatus?.members?.firstOrNull { (it.nodeId.ifBlank { it.id }) == nodeId }
                        val descriptor = member?.member ?: unifiedMembers?.members?.firstOrNull { unifiedUiId(it.canonicalId) == nodeId }
                        val conversationRef = resolveMemberConversationRef(member, descriptor)
                        val nodeUi = organizationViewModel.uiState.value.nodes.firstOrNull { it.id == nodeId }
                        val knownFailureText = nodeUi?.failureCode ?: nodeUi?.blockerText
                        val canOpenFormal = ownerVerified && ownerGeneration != null && ownerGeneration == projectionGeneration && organizationId != null
                        val canOpenSwarmOrNative = effectiveOrganizationId != null && hasSwarmOrBoard && connection == RuntimeConnectionState.Connected && (ownerVerified || offlineScope == null)
                        if ((member != null || conversationRef != null || swarmMember != null) && effectiveOrganizationId != null && (canOpenFormal || canOpenSwarmOrNative)) {
                            val requestGeneration = ownerGeneration
                            val requestOrganization = effectiveOrganizationId
                            OrganizationConversationContent(
                                transport,
                                effectiveOrganizationId,
                                nodeId,
                                targetId,
                                identityScope = "$scopeKey:$transportKey:${ownerGeneration ?: 0L}",
                                modifier = contentModifier,
                                rootSessionId = sessionId.takeIf { conversationRef != null },
                                memberRef = conversationRef,
                                knownFailureText = knownFailureText,
                                onRuntimeState = { state -> conversationRuntime = nodeId to state },
                                onAuthorizationDenied = {
                                    if (ownerGeneration == requestGeneration && (organizationId == requestOrganization || effectiveOrganizationId == requestOrganization)) {
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
                                },
                            )
                        } else {
                            Text(stringResource(R.string.organization_conversation_unavailable), contentModifier.padding(20.dp), color = LocalRagentColors.current.secondaryContent)
                        }
                    },
                    conversationRuntimeState = { nodeId -> conversationRuntime?.takeIf { it.first == nodeId }?.second },
                    embedded = embedded,
                    embeddedRootId = rootNodeId,
                    onRootClick = onRootClick,
                    onRootAnchorChanged = onRootAnchorChanged,
                    revealRoot = revealRoot,
                    rootHidden = rootHidden,
                    onRootVisualChanged = onRootVisualChanged,
                    openNodeId = programmaticOpen?.let { memberIdForLegacy(unifiedMembers, it.first, it.second, nodes) } ?: openNodeId,
                    onOpenNodeConsumed = { if (programmaticOpen != null) onProgrammaticOpenConsumed() else onOpenNodeConsumed() },
                    sessionId = sessionId,
                )
            }
        }
        else if (embedded && unifiedMembers?.members?.isNotEmpty() == true) {
            UnifiedOrganizationGraph(transport, sessionId, identityScope = "$scopeKey:$transportKey:${targetId.orEmpty()}", records = nativeFrame.records, nativeEvents = nativeEvents, unifiedMembers = unifiedMembers, unifiedReceiptElapsed = unifiedReceipt, unifiedActionsFresh = connection == RuntimeConnectionState.Connected && lifecycleState == Lifecycle.State.RESUMED, rootAction = rootAction.takeIf { connection == RuntimeConnectionState.Connected && lifecycleState == Lifecycle.State.RESUMED }, nativeActionsFresh = nativeContinuous && connection == RuntimeConnectionState.Connected && lifecycleState == Lifecycle.State.RESUMED, nativeReceiptElapsed = nativeReceiptElapsed, modifier = Modifier.weight(1f), onRootClick = onRootClick, onRootAnchorChanged = onRootAnchorChanged, onRootVisualChanged = onRootVisualChanged, revealRoot = revealRoot, rootHidden = rootHidden, programmaticOpen = programmaticOpen, onProgrammaticOpenConsumed = onProgrammaticOpenConsumed, birthCues = unifiedFrame.cues,
                onBirthCuesConsumed = { consumed -> if (unifiedFrame.cues == consumed) unifiedFrame = unifiedFrame.copy(cues = emptyList()) })
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

internal fun resolveFormalRootNodeId(
    nodes: List<OrganizationNodeDto>,
    sessionId: String,
    rootSessionId: String? = null,
): String? {
    val rootSession = rootSessionId?.takeIf { it.isNotBlank() } ?: sessionId
    val rootMatches = nodes.filter { node ->
        val boundSession = node.currentBinding?.sessionId?.takeIf { it.isNotBlank() } ?: node.sessionId
        boundSession == rootSession
    }
    return if (rootMatches.size == 1) rootMatches.single().id else null
}

internal fun computeHasCollaborators(
    unifiedMembers: UnifiedMembersPageDto?,
    loaded: Boolean,
    baseProjection: OrganizationProjectionDto?,
    swarmStatus: SwarmStatusDto?,
    boardResponse: SwarmBoardResponseDto?,
): Boolean {
    if (unifiedMembers?.members?.any { it.canonicalId != unifiedMembers.rootCanonicalId } == true) return true
    if (loaded && baseProjection?.hasCreatedSubordinate == true) return true
    if (swarmStatus != null && (swarmStatus.mode == "ragent_swarm" || swarmStatus.members.size > 1)) return true
    if (boardResponse != null && (boardResponse.mode == "ragent_swarm" || boardResponse.activeBoard?.messages?.isNotEmpty() == true)) return true
    return false
}

internal fun resolveMemberConversationRef(
    member: OrganizationNodeDto?,
    descriptor: com.andysagent.ragent.feature.organization.data.UnifiedMemberDto?,
): String? = descriptor?.conversation?.takeUnless {
    it.scope == "full" && member?.currentBinding?.sessionId != null
}?.ref
