package com.andysagent.ragent.feature.organization.presentation

import androidx.compose.ui.geometry.Offset
import androidx.lifecycle.ViewModel
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

class OrganizationViewModel(
    private val repository: OrganizationRepository,
    private val layoutEngine: OrganizationLayoutEngine = OrganizationLayoutEngine(),
) : ViewModel() {

    fun applyProjection(projection: OrganizationProjectionDto) = repository.applyProjection(projection)

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

    private var viewportWidth = 1080f
    private var viewportHeight = 1920f

    private val layoutResult = MutableStateFlow<LayoutResult?>(null)
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

        viewModelScope.launch {
            combine(
                repository.state,
                layoutResult,
                bundleFlow,
            ) { state, layout, bundle ->
                if (layout != null) {
                    OrganizationUiMapper.mapToUiState(
                        state = state,
                        layout = layout,
                        nodeAnimations = bundle.nodeAnims,
                        activeParticles = bundle.particles,
                        panOffset = bundle.pan,
                        zoomScale = bundle.zoom,
                        focusNodeId = bundle.focus,
                        selectedSheetNodeId = selectedSheetNodeId.value,
                        activeDetailNodeId = activeDetailNodeId.value,
                        isActivityFeedExpanded = isActivityFeedExpanded.value,
                        reduceMotion = reduceMotion.value,
                    )
                } else {
                    _uiState.value
                }
            }.collect { mapped ->
                _uiState.value = mapped
            }
        }
    }

    fun updateViewportSize(width: Float, height: Float) {
        if (width > 0 && height > 0 && (width != viewportWidth || height != viewportHeight)) {
            viewportWidth = width
            viewportHeight = height
            computeLayoutAsync(repository.state.value, focusNodeId.value, collapsedClusterIds.value)
        }
    }

    private fun computeLayoutAsync(
        state: OrganizationState,
        focus: String?,
        collapsed: Set<String>,
    ) {
        viewModelScope.launch {
            val result = withContext(Dispatchers.Default) {
                layoutEngine.computeLayout(
                    nodes = state.nodes,
                    edges = state.edges,
                    viewportWidth = viewportWidth,
                    viewportHeight = viewportHeight,
                    focusNodeId = focus,
                    collapsedClusterIds = collapsed,
                    previousPositions = previousPositions,
                )
            }
            // Update previous positions cache for stable layout diffs
            result.nodePositions.forEach { (id, pos) ->
                previousPositions[id] = EdgePoint(pos.x, pos.y)
            }
            layoutResult.value = result
        }
    }

    fun onPan(dragAmount: Offset) {
        panOffset.value = panOffset.value + dragAmount
    }

    fun onZoom(zoomMultiplier: Float) {
        val current = zoomScale.value
        zoomScale.value = (current * zoomMultiplier).coerceIn(0.75f, 2.25f)
    }

    fun onResetView() {
        panOffset.value = Offset.Zero
        zoomScale.value = 1.0f
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

    fun setReduceMotion(reduce: Boolean) {
        reduceMotion.value = reduce
    }
}
