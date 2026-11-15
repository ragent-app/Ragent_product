package com.andysagent.ragent.feature.organization.animation

import com.andysagent.ragent.feature.organization.domain.CommunicationType
import com.andysagent.ragent.feature.organization.layout.EdgePoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.PriorityQueue

data class ParticleAnimation(
    val id: String,
    val type: CommunicationType,
    val fromNodeId: String,
    val toNodeId: String,
    val startPoint: EdgePoint,
    val endPoint: EdgePoint,
    val controlPoint: EdgePoint? = null,
    val startedAt: Long,
    val durationMs: Long,
    val progress: Float = 0f, // 0f .. 1f
) {
    val currentPosition: EdgePoint
        get() {
            val t = progress.coerceIn(0f, 1f)
            return if (controlPoint != null) {
                // Quadratic Bezier interpolation
                val oneMinusT = 1f - t
                val x = oneMinusT * oneMinusT * startPoint.x + 2f * oneMinusT * t * controlPoint.x + t * t * endPoint.x
                val y = oneMinusT * oneMinusT * startPoint.y + 2f * oneMinusT * t * controlPoint.y + t * t * endPoint.y
                EdgePoint(x, y)
            } else {
                val x = startPoint.x + (endPoint.x - startPoint.x) * t
                val y = startPoint.y + (endPoint.y - startPoint.y) * t
                EdgePoint(x, y)
            }
        }
}

data class QueuedCommunication(
    val id: String,
    val type: CommunicationType,
    val fromNodeId: String,
    val toNodeId: String,
    val priority: Int,
    val durationMs: Long = 500L,
) : Comparable<QueuedCommunication> {
    override fun compareTo(other: QueuedCommunication): Int = this.priority.compareTo(other.priority)
}

class CommunicationVisualScheduler(
    private val scope: CoroutineScope,
    val maxActiveParticles: Int = 3,
) {
    private val _activeParticles = MutableStateFlow<List<ParticleAnimation>>(emptyList())
    val activeParticles: StateFlow<List<ParticleAnimation>> = _activeParticles.asStateFlow()

    private val queue = PriorityQueue<QueuedCommunication>()
    private var loopActive = false

    fun scheduleCommunication(
        id: String,
        type: CommunicationType,
        fromNodeId: String,
        toNodeId: String,
    ) {
        val priority = when (type) {
            CommunicationType.BLOCKER_ESCALATED -> 1
            CommunicationType.REVIEW_REQUESTED, CommunicationType.REVIEW_COMPLETED -> 2
            CommunicationType.RESULT_AVAILABLE -> 3
            CommunicationType.TASK_ASSIGNED -> 4
            CommunicationType.HANDOFF_AVAILABLE -> 5
        }
        val duration = when (type) {
            CommunicationType.BLOCKER_ESCALATED -> 450L
            CommunicationType.RESULT_AVAILABLE -> 550L
            CommunicationType.TASK_ASSIGNED -> 500L
            else -> 600L
        }

        synchronized(queue) {
            queue.add(
                QueuedCommunication(
                    id = id,
                    type = type,
                    fromNodeId = fromNodeId,
                    toNodeId = toNodeId,
                    priority = priority,
                    durationMs = duration,
                )
            )
        }
    }

    fun updateTick(
        nodePositions: Map<String, EdgePoint>,
    ) {
        val now = System.currentTimeMillis()
        val currentActive = _activeParticles.value

        // Advance active particles
        val updated = currentActive.mapNotNull { p ->
            val elapsed = now - p.startedAt
            val progress = (elapsed.toFloat() / p.durationMs).coerceIn(0f, 1f)
            if (progress >= 1f) null else p.copy(progress = progress)
        }

        // Fill slots up to maxActiveParticles from queue
        val slotsAvailable = maxActiveParticles - updated.size
        val newBatch = mutableListOf<ParticleAnimation>()

        if (slotsAvailable > 0) {
            synchronized(queue) {
                while (newBatch.size < slotsAvailable && queue.isNotEmpty()) {
                    val next = queue.poll() ?: break
                    val fromPos = nodePositions[next.fromNodeId]
                    val toPos = nodePositions[next.toNodeId]
                    if (fromPos != null && toPos != null) {
                        val control = EdgePoint((fromPos.x + toPos.x) / 2f, minOf(fromPos.y, toPos.y) + (toPos.y - fromPos.y) * 0.5f)
                        newBatch.add(
                            ParticleAnimation(
                                id = next.id,
                                type = next.type,
                                fromNodeId = next.fromNodeId,
                                toNodeId = next.toNodeId,
                                startPoint = fromPos,
                                endPoint = toPos,
                                controlPoint = control,
                                startedAt = now,
                                durationMs = next.durationMs,
                                progress = 0f,
                            )
                        )
                    }
                }
            }
        }

        _activeParticles.value = updated + newBatch
    }
}
