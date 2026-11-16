package com.andysagent.ragent.feature.organization.presentation

import androidx.compose.ui.geometry.Offset
import androidx.lifecycle.ViewModel
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.feature.organization.data.BirthCue
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.feature.organization.animation.CommunicationVisualScheduler
import com.andysagent.ragent.feature.organization.animation.GraphDiffAnimator
import com.andysagent.ragent.feature.organization.animation.NodeAppearanceAnimation
import com.andysagent.ragent.feature.organization.animation.ParticleAnimation
import com.andysagent.ragent.feature.organization.data.OrganizationRepository
import com.andysagent.ragent.feature.organization.data.OrganizationProjectionDto
import com.andysagent.ragent.feature.organization.domain.OrganizationState
import com.andysagent.ragent.feature.organization.layout.EdgePoint
import com.andysagent.ragent.feature.organization.layout.LayoutResult
import com.andysagent.ragent.feature.organization.layout.LayoutBounds
import com.andysagent.ragent.feature.organization.layout.OrganizationLayoutEngine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private data class ViewportAnimationBundle(
    val nodeAnims: Map<String, NodeAppearanceAnimation>,
    val particles: List<ParticleAnimation>,
    val pan: Offset,
    val zoom: Float,
    val focus: String?,
)

private data class GraphRenderState(val layout: LayoutResult? = null, val physics: PhysicsSnapshot = PhysicsSnapshot())

private data class OrganizationInteractionState(
    val selectedSheetNodeId: String?,
    val activeDetailNodeId: String?,
    val isActivityFeedExpanded: Boolean,
    val reduceMotion: Boolean,
)

class OrganizationViewModel(
    private val repository: OrganizationRepository,
    private val layoutEngine: OrganizationLayoutEngine = OrganizationLayoutEngine(),
) : ViewModel() {

    fun applyProjection(projection: OrganizationProjectionDto, birthCues: List<BirthCue> = emptyList()) {
        if (birthCues.isNotEmpty()) {
            pendingBirths = (pendingBirths + birthCues.mapIndexed { index, cue -> PhysicsBirth(cue.nodeId, cue.actorNodeId, index) })
                .distinctBy { it.nodeId }
        }
        repository.applyProjection(projection)
    }

    private val physics = OrganizationPhysicsSolver()
    private val renderState = MutableStateFlow(GraphRenderState())
    private var motionPreference = MotionPreference.Full
    private var pendingBirths: List<PhysicsBirth> = emptyList()
    private var lastLayoutKey: String? = null
    private var lastAppliedLayoutKey: String? = null
    private var lastFitKey: String? = null
    private var lastFitScale: Float? = null
    private var lastAppliedWidth = 0f
    private var lastAppliedHeight = 0f
    private var hasUserTransform = false

    private val diffAnimator = GraphDiffAnimator(viewModelScope)
    private val communicationScheduler = CommunicationVisualScheduler(viewModelScope)

    private val panOffset = MutableStateFlow(Offset.Zero)
    private val zoomScale = MutableStateFlow(1.0f)
    private val focusNodeId = MutableStateFlow<String?>(null)
    private val collapsedClusterIds = MutableStateFlow<Set<String>>(emptySet())
    private val selectedSheetNodeId = MutableStateFlow<String?>(null)
    private val activeDetailNodeId = MutableStateFlow<String?>(null)
    private val isActivityFeedExpanded = MutableStateFlow(false)
    private val reduceMotion = MutableStateFlow(false)

    private var viewportWidth = 0f
    private var viewportHeight = 0f
    private var viewportDensity = 1f
    private var layoutGeneration = 0L

    private val previousPositions = mutableMapOf<String, EdgePoint>()

    private val _uiState = MutableStateFlow(OrganizationUiState())
    val uiState: StateFlow<OrganizationUiState> = _uiState.asStateFlow()

    init {
        // Compute layout off main thread on Dispatchers.Default whenever state or layout keys change
        viewModelScope.launch {
            combine(
                repository.state,
                focusNodeId,
                collapsedClusterIds,
            ) { state, focus, collapsed ->
                Triple(state, focus, collapsed)
            }.collect { (state, focus, collapsed) ->
                computeLayoutAsync(state, focus, collapsed)
            }
        }

        // Combine layout result with animation and UI state
        val bundleFlow = combine(
            diffAnimator.animations,
            communicationScheduler.activeParticles,
            panOffset,
            zoomScale,
            focusNodeId,
        ) { nodeAnims, particles, pan, zoom, focus ->
            ViewportAnimationBundle(nodeAnims, particles, pan, zoom, focus)
        }
        val interactionFlow = combine(
            selectedSheetNodeId,
            activeDetailNodeId,
            isActivityFeedExpanded,
            reduceMotion,
        ) { selected, detail, expanded, reduced ->
            OrganizationInteractionState(selected, detail, expanded, reduced)
        }

        viewModelScope.launch {
            combine(
                repository.state,
                renderState,
                bundleFlow,
                interactionFlow,
            ) { state, render, bundle, interaction ->
                val layout = render.layout
                val physicsFrame = render.physics
                val mapped = OrganizationUiMapper.mapToUiState(
                        state = state,
                        layout = layout ?: LayoutResult(emptyMap(), emptyList(), LayoutBounds(0f, 0f, 0f, 0f), null),
                        nodeAnimations = bundle.nodeAnims,
                        activeParticles = bundle.particles,
                        panOffset = bundle.pan,
                        zoomScale = bundle.zoom,
                        focusNodeId = bundle.focus,
                        selectedSheetNodeId = interaction.selectedSheetNodeId,
                        activeDetailNodeId = interaction.activeDetailNodeId,
                        isActivityFeedExpanded = interaction.isActivityFeedExpanded,
                        reduceMotion = interaction.reduceMotion,
                    )
                mapped.copy(
                    nodes = mapped.nodes.map { node ->
                        val frame = physicsFrame.frames[node.id]
                        if (frame == null) node else node.copy(x = frame.centerX, y = frame.centerY,
                            radiusDp = frame.radiusDp, scale = 1f, physicsFrame = frame)
                    },
                    physicsRunning = physicsFrame.running,
                )
            }.collect { mapped ->
                _uiState.value = mapped
            }
        }
    }

    fun updateViewportSize(width: Float, height: Float, density: Float = 1f) {
        if (width.isFinite() && height.isFinite() && density.isFinite() && width > 0 && height > 0 && density > 0 &&
            (viewportWidth == 0f || viewportHeight == 0f || density != viewportDensity ||
                kotlin.math.abs(width - viewportWidth) / viewportWidth >= .03f ||
                kotlin.math.abs(height - viewportHeight) / viewportHeight >= .03f)) {
            viewportWidth = width
            viewportHeight = height
            viewportDensity = density
            computeLayoutAsync(repository.state.value, focusNodeId.value, collapsedClusterIds.value)
        }
    }

    private fun computeLayoutAsync(
        state: OrganizationState,
        focus: String?,
        collapsed: Set<String>,
    ) {
        if (viewportWidth <= 0f || viewportHeight <= 0f) return
        val topology = buildString {
            append(state.rootSessionId).append('\u0001')
            state.nodes.values.sortedBy { it.id }.forEach { append(it.id).append('\u0000').append(it.parentId).append('\u0000').append(it.sessionId).append('\u0000').append(it.role).append('\u0000').append(it.domain).append('\u0001') }
            state.edges.sortedBy { it.id }.forEach { append(it.id).append('\u0000').append(it.fromNodeId).append('\u0000').append(it.toNodeId).append('\u0000').append(it.type).append('\u0001') }
            collapsed.sorted().forEach { append(it).append('\u0001') }
        }
        val fitKey = "$topology|$viewportWidth|$viewportHeight|$viewportDensity"
        val layoutKey = "$fitKey|$focus"
        if (lastLayoutKey == layoutKey) {
            if (lastAppliedLayoutKey == layoutKey) pendingBirths = emptyList()
            return
        }
        lastLayoutKey = layoutKey
        val retainedFit = lastFitScale.takeIf { lastFitKey == fitKey }
        val generation = ++layoutGeneration
        val width = viewportWidth
        val height = viewportHeight
        val density = viewportDensity
        val positions = previousPositions.toMap()
        viewModelScope.launch {
            val result = withContext(Dispatchers.Default) {
                layoutEngine.computeLayout(
                    nodes = state.nodes,
                    edges = state.edges,
                    viewportWidth = width,
                    viewportHeight = height,
                    density = density,
                    focusNodeId = focus,
                    collapsedClusterIds = collapsed,
                    previousPositions = positions,
                    preferredFitScale = retainedFit,
                    rootSessionId = state.rootSessionId,
                )
            }
            if (generation != layoutGeneration) return@launch
            if (hasUserTransform && lastAppliedWidth > 0f && lastAppliedHeight > 0f) {
                val oldRoot = result.rootId?.let(previousPositions::get)
                val newRoot = result.rootId?.let(result.nodePositions::get)
                if (oldRoot != null && newRoot != null) {
                    val zoom = zoomScale.value
                    val oldCenter = Offset(lastAppliedWidth / 2f, lastAppliedHeight / 2f)
                    val newCenter = Offset(width / 2f, height / 2f)
                    val oldScreen = oldCenter + (Offset(oldRoot.x, oldRoot.y) - oldCenter) * zoom
                    val newScreen = newCenter + (Offset(newRoot.x, newRoot.y) - newCenter) * zoom
                    panOffset.value += oldScreen - newScreen
                }
            }
            val minimumZoom = minimumZoomFor(result, density)
            if (zoomScale.value < minimumZoom) zoomScale.value = minimumZoom
            lastAppliedWidth = width; lastAppliedHeight = height
            lastFitKey = fitKey; lastFitScale = result.fitScale
            lastAppliedLayoutKey = layoutKey
            val parents = state.nodes.mapValues { it.value.parentId }.toMutableMap()
            result.nodePositions.values.filter { it.isCluster }.forEach { parents[it.id] = it.id.removePrefix("cluster_") }
            val births = pendingBirths.filter { it.nodeId in result.nodePositions }
            // Hidden/clustered creations are consumed, never replayed when a cluster opens.
            pendingBirths = emptyList()
            val frame = physics.updateTargets(result, parents, density, births, motionPreference == MotionPreference.Full && !reduceMotion.value)
            // Update previous positions cache for stable layout diffs
            previousPositions.clear()
            result.nodePositions.forEach { (id, pos) ->
                previousPositions[id] = EdgePoint(pos.x, pos.y)
            }
            renderState.value = GraphRenderState(result, frame)
        }
    }

    fun onPan(dragAmount: Offset) {
        hasUserTransform = true
        panOffset.value = panOffset.value + dragAmount
    }

    private fun minimumZoomFor(layout: LayoutResult?, density: Float): Float {
        val positions = layout?.nodePositions?.values?.toList().orEmpty()
        val minimumRadius = positions.minOfOrNull { it.radius * it.scale } ?: 32f
        var minimumSeparation = Float.POSITIVE_INFINITY
        positions.forEachIndexed { index, node ->
            positions.drop(index + 1).forEach { other ->
                minimumSeparation = minOf(minimumSeparation, kotlin.math.hypot(node.x - other.x, node.y - other.y))
            }
        }
        val hitFloor = if (minimumSeparation.isFinite()) 64f * density / minimumSeparation.coerceAtLeast(.01f) else 0f
        return maxOf(24f / minimumRadius.coerceAtLeast(.01f), hitFloor).coerceIn(.75f, 2.25f)
    }

    fun onZoom(zoomMultiplier: Float) {
        hasUserTransform = true
        zoomScale.value = (zoomScale.value * zoomMultiplier).coerceIn(minimumZoomFor(renderState.value.layout, viewportDensity), 2.25f)
    }

    fun onResetView() {
        hasUserTransform = false
        panOffset.value = Offset.Zero
        zoomScale.value = maxOf(1.0f, minimumZoomFor(renderState.value.layout, viewportDensity))
        focusNodeId.value = null
    }

    fun onNodeClicked(nodeId: String) {
        if (nodeId.startsWith("cluster_")) {
            // Expand cluster
            val leadId = nodeId.removePrefix("cluster_")
            collapsedClusterIds.value = collapsedClusterIds.value + leadId
            focusNodeId.value = leadId
        } else {
            selectedSheetNodeId.value = nodeId
        }
    }

    fun onNodeDoubleTapped(nodeId: String) {
        if (focusNodeId.value == nodeId) {
            focusNodeId.value = null // Reset focus
        } else {
            focusNodeId.value = nodeId
        }
    }

    fun onDismissSheet() {
        selectedSheetNodeId.value = null
    }

    fun onOpenAgentDetail(nodeId: String) {
        selectedSheetNodeId.value = null
        activeDetailNodeId.value = nodeId
    }

    fun onCloseAgentDetail() {
        activeDetailNodeId.value = null
    }

    fun onToggleActivityFeed() {
        isActivityFeedExpanded.value = !isActivityFeedExpanded.value
    }

    fun onApproveBlocker(blockerId: String) {
        // User approved action
    }

    fun onRejectBlocker(blockerId: String) {
        // User rejected action
    }

    /** Called only by the local debug demonstration, not by production events. */
    fun replayLocalDemoBirths() {
        val state = repository.state.value
        if (state.organizationId != "demo_only") return
        val layout = renderState.value.layout ?: return
        val parents = state.nodes.mapValues { it.value.parentId }
        val births = listOf("android", "backend").mapNotNull { id ->
            val node = state.nodes[id] ?: return@mapNotNull null
            if (node.parentId != "planning" || id !in layout.nodePositions || "planning" !in layout.nodePositions) null
            else id
        }.mapIndexed { index, id -> PhysicsBirth(id, "planning", index) }
        if (births.isEmpty()) return
        val frame = physics.replayDemoBirths(layout, parents, viewportDensity, births,
            motionPreference == MotionPreference.Full && !reduceMotion.value)
        renderState.value = renderState.value.copy(physics = frame)
    }

    fun setMotionPreference(preference: MotionPreference) {
        if (motionPreference == preference) return
        motionPreference = preference
        physics.setMaterialDuration(if (preference == MotionPreference.Reduced) .12f else .22f)
        if (preference != MotionPreference.Full) renderState.value = renderState.value.copy(
            physics = physics.snapToTargets(preserveMaterial = preference == MotionPreference.Reduced, wakeMaterial = preference == MotionPreference.Reduced))
    }

    fun advancePhysicsFrame(frameNanos: Long) {
        if (motionPreference != MotionPreference.None && renderState.value.physics.running) {
            renderState.value = renderState.value.copy(physics = physics.advance(frameNanos))
        }
    }

    fun reportBirthSurfaceGaps(gapsDp: Map<String, Float>) {
        if (gapsDp.isNotEmpty()) renderState.value = renderState.value.copy(physics = physics.reportBirthSurfaceGaps(gapsDp))
    }

    fun setReduceMotion(reduce: Boolean) {
        reduceMotion.value = reduce
        if (reduce) {
            physics.setMaterialDuration(.12f)
            renderState.value = renderState.value.copy(physics = physics.snapToTargets(preserveMaterial = true, wakeMaterial = true))
        }
    }
}
