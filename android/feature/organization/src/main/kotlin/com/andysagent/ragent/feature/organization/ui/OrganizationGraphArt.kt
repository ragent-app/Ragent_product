package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.VertexMode
import androidx.compose.ui.graphics.Vertices
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.feature.organization.presentation.RenderedEdgeUiState
import kotlin.math.atan2
import kotlin.math.sqrt

internal data class GraphNodeSurface(
    val id: String,
    val center: Offset,
    val radius: Float,
    val colors: List<Color>,
    val alpha: Float,
    val hidden: Boolean,
    val birthSourceId: String?,
    val birthProgress: Float,
    val visible: Boolean = true,
    val deformation: Float = 0f,
    val deformationDirection: Offset = Offset(0f, 1f),
) {
    val axis: Offset get() = deformationDirection.let { if (it.getDistance() > .001f) it / it.getDistance() else Offset(0f, 1f) }
    val major: Float get() = radius * (1f + .025f * deformation.coerceIn(0f, 1f))
    val minor: Float get() = radius * (1f - .025f * deformation.coerceIn(0f, 1f))
}

private fun dot(a: Offset, b: Offset) = a.x * b.x + a.y * b.y

// Node brushes are platform linear gradients in the source sRGB color space.
// Compose Color.lerp uses Oklab and therefore does not reproduce their colors.
private fun platformGradientColor(a: Color, b: Color, progress: Float): Color {
    val t = progress.coerceIn(0f, 1f)
    return Color(
        red = a.red + (b.red - a.red) * t,
        green = a.green + (b.green - a.green) * t,
        blue = a.blue + (b.blue - a.blue) * t,
        alpha = a.alpha + (b.alpha - a.alpha) * t,
        colorSpace = a.colorSpace,
    )
}

/** Samples the exact gradient coordinates of the currently deformed node. */
private fun nodeColor(node: GraphNodeSurface, point: Offset): Color {
    val axis = node.axis
    val cross = Offset(-axis.y, axis.x)
    val v = point - node.center
    val undeformed = axis * (dot(v, axis) * node.radius / node.major.coerceAtLeast(.001f)) +
        cross * (dot(v, cross) * node.radius / node.minor.coerceAtLeast(.001f))
    val r = node.radius.coerceAtLeast(.001f)
    val x = (undeformed.x / r + 1f) / 2f
    val y = (undeformed.y / r + 1f) / 2f
    val t = (((x - .12f) * .76f + (y - .08f) * .84f) / (.76f * .76f + .84f * .84f)).coerceIn(0f, 1f)
    return if (t <= .55f) platformGradientColor(node.colors[0], node.colors[1], t / .55f)
        else platformGradientColor(node.colors[1], node.colors[2], (t - .55f) / .45f)
}

/** Intersection of a line parallel to direction at transverse offset y and the node ellipse. */
private fun ellipseIntersection(node: GraphNodeSurface, direction: Offset, normal: Offset, y: Float, positive: Boolean): Float {
    val axis = node.axis
    val cross = Offset(-axis.y, axis.x)
    val major = node.major.coerceAtLeast(.001f)
    val minor = node.minor.coerceAtLeast(.001f)
    val dx = dot(direction, axis) / major; val dy = dot(direction, cross) / minor
    val nx = dot(normal, axis) / major; val ny = dot(normal, cross) / minor
    val a = dx * dx + dy * dy
    val b = 2f * y * (dx * nx + dy * ny)
    val c = y * y * (nx * nx + ny * ny) - 1f
    val disc = (b * b - 4f * a * c).coerceAtLeast(0f)
    return (-b + (if (positive) 1f else -1f) * sqrt(disc)) / (2f * a).coerceAtLeast(.000001f)
}

private fun ellipseNormal(node: GraphNodeSurface, relative: Offset): Offset {
    val axis = node.axis; val cross = Offset(-axis.y, axis.x)
    val n = axis * (dot(relative, axis) / (node.major * node.major).coerceAtLeast(.000001f)) +
        cross * (dot(relative, cross) / (node.minor * node.minor).coerceAtLeast(.000001f))
    return if (n.getDistance() > .0001f) n / n.getDistance() else axis
}

private fun ellipseBoundary(node: GraphNodeSurface, angle: Float): Offset {
    val axis = node.axis
    val cross = Offset(-axis.y, axis.x)
    return node.center + axis * (node.major * kotlin.math.cos(angle)) + cross * (node.minor * kotlin.math.sin(angle))
}

private fun ellipseImplicit(node: GraphNodeSurface, point: Offset): Float {
    val axis = node.axis
    val cross = Offset(-axis.y, axis.x)
    val relative = point - node.center
    val x = dot(relative, axis) / node.major.coerceAtLeast(.001f)
    val y = dot(relative, cross) / node.minor.coerceAtLeast(.001f)
    return x * x + y * y - 1f
}

private fun ellipseCrossings(a: GraphNodeSurface, b: GraphNodeSurface): List<Offset> {
    val result = mutableListOf<Offset>()
    val step = (2.0 * Math.PI / 64.0).toFloat()
    var previousAngle = 0f
    var previousValue = ellipseImplicit(b, ellipseBoundary(a, previousAngle))
    for (index in 1..64) {
        val angle = index * step
        val value = ellipseImplicit(b, ellipseBoundary(a, angle))
        if ((previousValue < 0f && value >= 0f) || (previousValue >= 0f && value < 0f)) {
            var low = previousAngle
            var high = angle
            val lowInside = previousValue < 0f
            repeat(16) {
                val mid = (low + high) / 2f
                if ((ellipseImplicit(b, ellipseBoundary(a, mid)) < 0f) == lowInside) low = mid else high = mid
            }
            result += ellipseBoundary(a, (low + high) / 2f)
        }
        previousAngle = angle
        previousValue = value
    }
    return result
}

private data class JoinSection(val x: Float, val halfWidth: Float)
private fun bezier(a: Float, b: Float, c: Float, d: Float, t: Float): Float {
    val u = 1f - t
    return a * u * u * u + 3f * b * u * u * t + 3f * c * u * t * t + d * t * t * t
}

/** A single canvas draws node fills and joins from the same physical frame. */
@Composable
internal fun OrganizationGraphArt(nodes: List<GraphNodeSurface>, edges: List<RenderedEdgeUiState>, zoom: Float) {
    val nodesById = nodes.associateBy { it.id }
    Canvas(Modifier.fillMaxSize()) {
        val inverseZoom = 1f / zoom.coerceAtLeast(.001f)
        val halfBody = 1.5.dp.toPx() * inverseZoom
        val requestedHalfEnd = 2.5.dp.toPx() * inverseZoom
        val taper = 6.dp.toPx() * inverseZoom
        val round = 2.dp.toPx() * inverseZoom
        val overlap = 1f * inverseZoom
        val realEdges = edges.map { it.fromNodeId to it.toNodeId }.toSet()
        val temporaryBirthEdges = nodes.mapNotNull { child ->
            val source = child.birthSourceId ?: return@mapNotNull null
            if ((source to child.id) in realEdges || source !in nodesById) null else {
                RenderedEdgeUiState("birth:${child.id}", source, child.id,
                    com.andysagent.ragent.feature.organization.layout.EdgePoint(0f, 0f),
                    com.andysagent.ragent.feature.organization.layout.EdgePoint(0f, 0f))
            }
        }
        val meshPaint = Paint().apply { color = Color.White; isAntiAlias = true }
        (edges + temporaryBirthEdges).forEach { edge ->
            val a = nodesById[edge.fromNodeId] ?: return@forEach
            val b = nodesById[edge.toNodeId] ?: return@forEach
            if (!a.visible || !b.visible) return@forEach
            if (b.birthSourceId != null && b.birthSourceId != a.id) return@forEach
            val delta = b.center - a.center
            val distance = delta.getDistance()
            if (distance <= .001f || a.radius <= 0f || b.radius <= 0f) return@forEach
            val direction = delta / distance
            val normal = Offset(-direction.y, direction.x)
            val ra = ellipseIntersection(a, direction, normal, 0f, true)
            val rb = -ellipseIntersection(b, direction, normal, 0f, false)
            val isBirth = b.birthSourceId == a.id || a.birthSourceId == b.id
            if (distance <= ra + rb) {
                // While the emerging circle intersects its source, fill the concave lens corners
                // before drawing either circle. Full containment remains hidden behind the source.
                if (isBirth) {
                    val crossings = ellipseCrossings(a, b)
                    if (crossings.size >= 2) {
                        val fillet = minOf(round, (crossings[0] - crossings[1]).getDistance() * .225f,
                            a.minor * .25f, b.minor * .25f)
                        if (fillet > .01f) crossings.forEach { point ->
                            val brush = Brush.linearGradient(listOf(nodeColor(a, point), nodeColor(b, point)), point - direction * fillet, point + direction * fillet)
                            drawCircle(brush, fillet, point, alpha = minOf(a.alpha, b.alpha))
                        }
                    }
                }
                return@forEach
            }
            val halfEnd = minOf(requestedHalfEnd, a.minor * .7f, b.minor * .7f)
            // Rotated ellipses have unequal upper/lower intersections: begin inside
            // both sides and let the shared circle fill cover the overlap.
            val start = minOf(ellipseIntersection(a, direction, normal, -halfEnd, true),
                ellipseIntersection(a, direction, normal, halfEnd, true)) - overlap
            val end = distance + maxOf(ellipseIntersection(b, direction, normal, -halfEnd, false),
                ellipseIntersection(b, direction, normal, halfEnd, false)) + overlap
            val span = end - start
            if (span <= 0f) return@forEach
            val shoulder = minOf(taper, span / 2f)
            val nA = ellipseNormal(a, direction * (start + overlap) - normal * halfEnd)
            val nB = ellipseNormal(b, direction * (end - distance - overlap) - normal * halfEnd)
            val tangentA = Offset(kotlin.math.abs(dot(nA, normal)), dot(nA, direction))
            val tangentB = Offset(kotlin.math.abs(dot(nB, normal)), dot(nB, direction))
            val c1x = (start + tangentA.x * round).coerceAtMost(start + shoulder); val c1w = (halfEnd - tangentA.y * round).coerceAtLeast(0f)
            val c2x = (end - tangentB.x * round).coerceAtLeast(end - shoulder); val c2w = (halfEnd + tangentB.y * round).coerceAtLeast(0f)
            val sections = mutableListOf<JoinSection>()
            for (i in 0..6) { val t = i / 6f; sections += JoinSection(bezier(start, c1x, start + shoulder * .6f, start + shoulder, t), bezier(halfEnd, c1w, halfBody, halfBody, t)) }
            if (edge.isReview && span > 2f * shoulder) {
                val dash = 4.dp.toPx() * inverseZoom; val gap = 5.dp.toPx() * inverseZoom
                var x = start + shoulder
                while (x < end - shoulder) { sections += JoinSection(x, halfBody); sections += JoinSection(minOf(x + dash, end - shoulder), halfBody); x += dash + gap }
            } else sections += JoinSection(end - shoulder, halfBody)
            for (i in 1..6) { val t = i / 6f; sections += JoinSection(bezier(end - shoulder, end - shoulder * .6f, c2x, end, t), bezier(halfBody, halfBody, c2w, halfEnd, t)) }
            val positions = mutableListOf<Offset>(); val vertexColors = mutableListOf<Color>()
            fun addVertex(section: JoinSection, row: Int) {
                val fraction = row / 8f - 1f
                val y = section.halfWidth * fraction
                val ay = (halfEnd * fraction).coerceIn(-a.minor * .7f, a.minor * .7f)
                val by = (halfEnd * fraction).coerceIn(-b.minor * .7f, b.minor * .7f)
                val aPoint = a.center + direction * ellipseIntersection(a, direction, normal, ay, true) + normal * ay
                val bPoint = b.center + direction * ellipseIntersection(b, direction, normal, by, false) + normal * by
                val first = nodeColor(a, aPoint).copy(alpha = a.alpha)
                val last = nodeColor(b, bPoint).copy(alpha = b.alpha)
                positions += a.center + direction * section.x + normal * y
                vertexColors += platformGradientColor(first, last, ((section.x - start) / span).coerceIn(0f, 1f))
            }
            sections.forEach { section -> for (row in 0..16) addVertex(section, row) }
            val indices = mutableListOf<Int>()
            for (i in 0 until sections.lastIndex) {
                val left = sections[i]; val right = sections[i + 1]
                if (right.x <= left.x) continue
                if (edge.isReview && left.x >= start + shoulder && right.x <= end - shoulder && right.x - left.x > 4.01.dp.toPx() * inverseZoom) continue
                for (row in 0 until 16) {
                    val aIndex = i * 17 + row
                    val bIndex = (i + 1) * 17 + row
                    indices.addAll(listOf(aIndex, bIndex, bIndex + 1, aIndex, bIndex + 1, aIndex + 1))
                }
            }
            if (indices.isNotEmpty()) {
                val mesh = Vertices(VertexMode.Triangles, positions, colors = vertexColors, indices = indices)
                drawIntoCanvas { canvas -> canvas.drawVertices(mesh, BlendMode.Modulate, meshPaint) }
            }
        }
        fun birthDepth(node: GraphNodeSurface): Int {
            var current = node; var depth = 0; val seen = mutableSetOf(node.id)
            while (true) { val source = current.birthSourceId?.let(nodesById::get) ?: break; if (!seen.add(source.id)) break; depth++; current = source }
            return depth
        }
        nodes.sortedByDescending(::birthDepth).forEach { node ->
            if (node.visible && !node.hidden && node.radius > 0f) {
                val r = node.radius
                val topLeft = node.center - Offset(r, r)
                val brush = Brush.linearGradient(0f to node.colors[0], .55f to node.colors[1], 1f to node.colors[2],
                    start = topLeft + Offset(r * .24f, r * .16f), end = topLeft + Offset(r * 1.76f, r * 1.84f))
                val angle = Math.toDegrees(atan2(node.axis.y.toDouble(), node.axis.x.toDouble())).toFloat()
                rotate(angle, node.center) {
                    scale(node.major / r, node.minor / r, node.center) {
                        rotate(-angle, node.center) { drawCircle(brush, radius = r, center = node.center, alpha = node.alpha) }
                    }
                }
            }
        }
    }
}
