package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.domain.CommunicationType
import com.andysagent.ragent.feature.organization.presentation.ParticleUiState
import com.andysagent.ragent.feature.organization.presentation.RenderedEdgeUiState

@Composable
fun OrganizationCanvas(
    edges: List<RenderedEdgeUiState>,
    particles: List<ParticleUiState>,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val strokeColor = colors.secondaryContent.copy(alpha = 0.22f)
    val reviewStrokeColor = colors.secondaryContent.copy(alpha = 0.28f)

    // Using drawWithCache to avoid allocating Path objects every frame for static paths
    Canvas(
        modifier = modifier
            .fillMaxSize()
            .drawWithCache {
                val cachedPaths = edges.map { edge ->
                    val fullPath = Path().apply {
                        moveTo(edge.start.x, edge.start.y)
                        if (edge.isCurved && edge.control1 != null && edge.control2 != null) {
                            cubicTo(
                                edge.control1.x, edge.control1.y,
                                edge.control2.x, edge.control2.y,
                                edge.end.x, edge.end.y,
                            )
                        } else {
                            lineTo(edge.end.x, edge.end.y)
                        }
                    }
                    val measure = PathMeasure()
                    measure.setPath(fullPath, false)
                    val length = measure.length
                    val edgePath = if (edge.growthProgress < 1.0f) {
                        val partialPath = Path()
                        measure.getSegment(0f, length * edge.growthProgress, partialPath, true)
                        partialPath
                    } else {
                        fullPath
                    }
                    Triple(edge, edgePath, edge.isReview)
                }

                onDrawBehind {
                    // Draw edges
                    cachedPaths.forEach { (edge, path, isReview) ->
                        val baseColor = if (isReview) reviewStrokeColor else strokeColor
                        val color = baseColor.copy(alpha = baseColor.alpha * edge.alpha)
                        drawPath(
                            path = path,
                            color = color,
                            style = Stroke(
                                width = 1.25.dp.toPx(),
                                cap = StrokeCap.Round,
                                pathEffect = if (isReview) PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 5.dp.toPx()), 0f) else null,
                            ),
                        )
                    }

                    // Draw communication particles
                    particles.forEach { p ->
                        val center = Offset(p.x, p.y)
                        when (p.type) {
                            CommunicationType.TASK_ASSIGNED -> {
                                // Blue particle heading to worker
                                drawCircle(
                                    color = colors.running.copy(alpha = 0.35f),
                                    radius = 7.dp.toPx(),
                                    center = center,
                                )
                                drawCircle(
                                    color = colors.running,
                                    radius = 3.5.dp.toPx(),
                                    center = center,
                                )
                            }

                            CommunicationType.RESULT_AVAILABLE -> {
                                // Emerald diamond particle heading back to manager
                                val s = 5.dp.toPx()
                                val diamond = Path().apply {
                                    moveTo(center.x, center.y - s)
                                    lineTo(center.x + s, center.y)
                                    lineTo(center.x, center.y + s)
                                    lineTo(center.x - s, center.y)
                                    close()
                                }
                                drawCircle(
                                    color = colors.success.copy(alpha = 0.35f),
                                    radius = 8.dp.toPx(),
                                    center = center,
                                )
                                drawPath(diamond, color = colors.success)
                            }

                            CommunicationType.REVIEW_REQUESTED -> {
                                val s = 5.dp.toPx()
                                val diamond = Path().apply {
                                    moveTo(center.x, center.y - s)
                                    lineTo(center.x + s, center.y)
                                    lineTo(center.x, center.y + s)
                                    lineTo(center.x - s, center.y)
                                    close()
                                }
                                drawPath(diamond, color = colors.waiting, style = Stroke(width = 1.5.dp.toPx()))
                            }

                            CommunicationType.REVIEW_COMPLETED -> {
                                drawCircle(
                                    color = colors.success,
                                    radius = 4.dp.toPx(),
                                    center = center,
                                )
                            }

                            CommunicationType.BLOCKER_ESCALATED -> {
                                // Warning alert particle
                                drawCircle(
                                    color = colors.error.copy(alpha = 0.4f),
                                    radius = 9.dp.toPx(),
                                    center = center,
                                )
                                drawCircle(
                                    color = colors.error,
                                    radius = 5.dp.toPx(),
                                    center = center,
                                )
                            }

                            else -> {
                                drawCircle(
                                    color = colors.primaryContent,
                                    radius = 3.dp.toPx(),
                                    center = center,
                                )
                            }
                        }
                    }
                }
            },
        onDraw = {
            // All rendering performed in onDrawBehind inside drawWithCache
        },
    )
}
