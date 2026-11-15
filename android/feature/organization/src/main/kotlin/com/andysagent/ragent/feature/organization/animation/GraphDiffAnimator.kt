package com.andysagent.ragent.feature.organization.animation

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class NodeAppearanceAnimation(
    val nodeId: String,
    val edgeProgress: Float = 1.0f, // 0f .. 1f
    val nodeScale: Float = 1.0f,    // 0.7f .. 1.0f
    val nodeAlpha: Float = 1.0f,    // 0f .. 1f
    val isRetiring: Boolean = false,
)

class GraphDiffAnimator(
    private val scope: CoroutineScope,
) {
    private val _animations = MutableStateFlow<Map<String, NodeAppearanceAnimation>>(emptyMap())
    val animations: StateFlow<Map<String, NodeAppearanceAnimation>> = _animations.asStateFlow()

    private val activeJobs = mutableMapOf<String, Job>()

    /**
     * Animates the appearance of a newly created node:
     * 1. Edge grows 0% -> 100% (approx 350ms)
     * 2. Child appears with scale 0.7 -> 1.0 and alpha 0 -> 1 (approx 200ms)
     */
    fun animateNodeGrowth(nodeId: String, onFinished: () -> Unit = {}) {
        activeJobs[nodeId]?.cancel()
        activeJobs[nodeId] = scope.launch {
            val startTime = System.currentTimeMillis()
            val edgeDuration = 350L
            val nodeDuration = 200L

            // Phase 1: Edge growth
            while (true) {
                val elapsed = System.currentTimeMillis() - startTime
                val progress = (elapsed.toFloat() / edgeDuration).coerceIn(0f, 1f)
                _animations.value = _animations.value + (nodeId to NodeAppearanceAnimation(
                    nodeId = nodeId,
                    edgeProgress = progress,
                    nodeScale = 0.7f,
                    nodeAlpha = 0f,
                ))
                if (progress >= 1f) break
                delay(16)
            }

            // Phase 2: Child node appear
            val nodeStartTime = System.currentTimeMillis()
            while (true) {
                val elapsed = System.currentTimeMillis() - nodeStartTime
                val progress = (elapsed.toFloat() / nodeDuration).coerceIn(0f, 1f)
                val scale = 0.7f + (0.3f * progress)
                val alpha = progress

                _animations.value = _animations.value + (nodeId to NodeAppearanceAnimation(
                    nodeId = nodeId,
                    edgeProgress = 1f,
                    nodeScale = scale,
                    nodeAlpha = alpha,
                ))
                if (progress >= 1f) break
                delay(16)
            }

            onFinished()
        }
    }

    /**
     * Animates retirement of a node: scale 1 -> 0.85, alpha 1 -> 0
     */
    fun animateNodeRetire(nodeId: String, onFinished: () -> Unit = {}) {
        activeJobs[nodeId]?.cancel()
        activeJobs[nodeId] = scope.launch {
            val startTime = System.currentTimeMillis()
            val duration = 300L

            while (true) {
                val elapsed = System.currentTimeMillis() - startTime
                val progress = (elapsed.toFloat() / duration).coerceIn(0f, 1f)
                val scale = 1.0f - (0.15f * progress)
                val alpha = 1.0f - progress

                _animations.value = _animations.value + (nodeId to NodeAppearanceAnimation(
                    nodeId = nodeId,
                    edgeProgress = 1f - progress,
                    nodeScale = scale,
                    nodeAlpha = alpha,
                    isRetiring = true,
                ))
                if (progress >= 1f) break
                delay(16)
            }

            _animations.value = _animations.value - nodeId
            onFinished()
        }
    }
}
