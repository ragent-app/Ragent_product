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
import androidx.compose.ui.graphics.Path
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
    val materialProgress: Float = 1f,
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

private data class GradientField(val start: Offset, val end: Offset, val colors: List<Color>, val alpha: Float) {
    fun sample(point: Offset): Color {
        val vector = end - start
        val t = (dot(point - start, vector) / dot(vector, vector).coerceAtLeast(.000001f)).coerceIn(0f, 1f)
        return if (t <= .55f) platformGradientColor(colors[0], colors[1], t / .55f)
            else platformGradientColor(colors[1], colors[2], (t - .55f) / .45f)
    }
    fun brush(): Brush = Brush.linearGradient(0f to colors[0], .55f to colors[1], 1f to colors[2], start = start, end = end)
}

private fun ownField(node: GraphNodeSurface): GradientField {
    val r = node.radius.coerceAtLeast(.001f)
    val axis = node.axis
    val cross = Offset(-axis.y, axis.x)
    val localStart = Offset(-.76f * r, -.84f * r)
    val vector = Offset(1.52f * r, 1.68f * r)
    fun transform(v: Offset) = axis * (dot(v, axis) * node.major / r) + cross * (dot(v, cross) * node.minor / r)
    val inverseTranspose = axis * (dot(vector, axis) * r / node.major.coerceAtLeast(.001f)) +
        cross * (dot(vector, cross) * r / node.minor.coerceAtLeast(.001f))
    val worldStart = node.center + transform(localStart)
    val worldVector = inverseTranspose * (dot(vector, vector) / dot(inverseTranspose, inverseTranspose).coerceAtLeast(.000001f))
    return GradientField(worldStart, worldStart + worldVector, node.colors, node.alpha)
}

private fun smooth(value: Float): Float {
    val x = value.coerceIn(0f, 1f)
    return x * x * (3f - 2f * x)
}

private fun ellipseSupport(node: GraphNodeSurface, direction: Offset): Float {
    val axis = node.axis
    val cross = Offset(-axis.y, axis.x)
    val a = dot(direction, axis) * node.major
    val b = dot(direction, cross) * node.minor
    return sqrt(a * a + b * b)
}

private data class SurfaceSeparation(val gap: Float, val axis: Offset)

/** The best separating axis and the corresponding distance, zero for touching ellipses. */
private fun surfaceSeparation(a: GraphNodeSurface, b: GraphNodeSurface): SurfaceSeparation {
    fun separation(angle: Float): Float {
        val n = Offset(kotlin.math.cos(angle), kotlin.math.sin(angle))
        return dot(b.center - a.center, n) - ellipseSupport(a, n) - ellipseSupport(b, n)
    }
    val step = (2.0 * Math.PI / 48.0).toFloat()
    var bestAngle = 0f
    var best = Float.NEGATIVE_INFINITY
    for (i in 0 until 48) { val angle = i * step; val value = separation(angle); if (value > best) { best = value; bestAngle = angle } }
    var low = bestAngle - step
    var high = bestAngle + step
    repeat(18) {
        val left = low + (high - low) / 3f
        val right = high - (high - low) / 3f
        if (separation(left) < separation(right)) low = left else high = right
    }
    val refinedAngle = (low + high) / 2f
    val angle = if (separation(refinedAngle) >= best) refinedAngle else bestAngle
    return SurfaceSeparation(maxOf(0f, separation(angle)), Offset(kotlin.math.cos(angle), kotlin.math.sin(angle)))
}

internal fun graphSurfaceGap(a: GraphNodeSurface, b: GraphNodeSurface): Float = surfaceSeparation(a, b).gap

private fun supportPoint(node: GraphNodeSurface, normal: Offset): Offset {
    val axis = node.axis
    val cross = Offset(-axis.y, axis.x)
    val support = ellipseSupport(node, normal).coerceAtLeast(.001f)
    return node.center + axis * (dot(normal, axis) * node.major * node.major / support) +
        cross * (dot(normal, cross) * node.minor * node.minor / support)
}

private fun containmentExposure(a: GraphNodeSurface, b: GraphNodeSurface): Float {
    fun exposure(angle: Float): Float {
        val n = Offset(kotlin.math.cos(angle), kotlin.math.sin(angle))
        return dot(b.center - a.center, n) + ellipseSupport(b, n) - ellipseSupport(a, n)
    }
    val step = (2.0 * Math.PI / 48.0).toFloat()
    var bestAngle = 0f
    var maximum = Float.NEGATIVE_INFINITY
    for (i in 0 until 48) {
        val angle = i * step
        val value = exposure(angle)
        if (value > maximum) { maximum = value; bestAngle = angle }
    }
    var low = bestAngle - step
    var high = bestAngle + step
    repeat(18) {
        val left = low + (high - low) / 3f
        val right = high - (high - low) / 3f
        if (exposure(left) < exposure(right)) low = left else high = right
    }
    return maxOf(maximum, exposure((low + high) / 2f))
}

private fun mixedField(parent: GradientField, own: GradientField, t: Float): GradientField = GradientField(
    parent.start + (own.start - parent.start) * t,
    parent.end + (own.end - parent.end) * t,
    parent.colors.indices.map { platformGradientColor(parent.colors[it], own.colors[it], t) },
    parent.alpha + (own.alpha - parent.alpha) * t,
)

private fun nodeShape(node: GraphNodeSurface): Path {
    val axis = node.axis * node.major
    val cross = Offset(-node.axis.y, node.axis.x) * node.minor
    val c = node.center
    val k = .55228475f
    return Path().apply {
        moveTo(c.x + axis.x, c.y + axis.y)
        fun curve(a: Offset, b: Offset, end: Offset) = cubicTo(a.x, a.y, b.x, b.y, end.x, end.y)
        curve(c + axis + cross * k, c + cross + axis * k, c + cross)
        curve(c + cross - axis * k, c - axis + cross * k, c - axis)
        curve(c - axis - cross * k, c - cross - axis * k, c - cross)
        curve(c - cross + axis * k, c + axis - cross * k, c + axis)
        close()
    }
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

/** Real roots of a degree-at-most-four polynomial, bracketed by its stationary points. */
private fun polynomialRoots(input: List<Double>): List<Double> {
    val coefficients = input.toMutableList()
    val magnitude = coefficients.maxOfOrNull { kotlin.math.abs(it) } ?: return emptyList()
    if (magnitude == 0.0) return emptyList()
    while (coefficients.size > 1 && kotlin.math.abs(coefficients.last()) <= magnitude * 1e-13) coefficients.removeAt(coefficients.lastIndex)
    val degree = coefficients.lastIndex
    if (degree == 0) return emptyList()
    if (degree == 1) return listOf(-coefficients[0] / coefficients[1])
    fun value(x: Double): Double = coefficients.asReversed().fold(0.0) { acc, term -> acc * x + term }
    val bound = (1.0 + coefficients.dropLast(1).maxOf { kotlin.math.abs(it / coefficients.last()) }).coerceAtMost(1e8)
    val critical = polynomialRoots((1..degree).map { coefficients[it] * it }).filter { it > -bound && it < bound }.sorted()
    val boundaries = listOf(-bound) + critical + bound
    val roots = mutableListOf<Double>()
    critical.forEach { x ->
        val tolerance = magnitude * 1e-11 * kotlin.math.max(1.0, kotlin.math.abs(x)).let { Math.pow(it, degree.toDouble()) }
        if (kotlin.math.abs(value(x)) <= tolerance) roots += x
    }
    boundaries.zipWithNext().forEach { (left, right) ->
        var lo = left; var hi = right
        var loValue = value(lo); val hiValue = value(hi)
        if (loValue.isFinite() && hiValue.isFinite() && loValue * hiValue < 0.0) {
            repeat(72) {
                val mid = (lo + hi) / 2.0
                val midValue = value(mid)
                if ((midValue < 0.0) == (loValue < 0.0)) { lo = mid; loValue = midValue } else hi = mid
            }
            roots += (lo + hi) / 2.0
        }
    }
    return roots.sorted().fold(mutableListOf<Double>()) { out, x ->
        if (out.isEmpty() || kotlin.math.abs(x - out.last()) > 1e-7 * kotlin.math.max(1.0, kotlin.math.abs(x))) out += x
        out
    }
}

/** Intersections from the exact quadratic ellipse equations, without angular scan gaps. */
private fun ellipseCrossings(a: GraphNodeSurface, b: GraphNodeSurface): List<Offset> {
    val bAxis = b.axis
    val bCross = Offset(-bAxis.y, bAxis.x)
    fun normalized(v: Offset) = Offset(dot(v, bAxis) / b.major.coerceAtLeast(.001f), dot(v, bCross) / b.minor.coerceAtLeast(.001f))
    val origin = normalized(a.center - b.center)
    val u = normalized(a.axis * a.major)
    val v = normalized(Offset(-a.axis.y, a.axis.x) * a.minor)
    val aa = dot(u, u).toDouble(); val bb = dot(u, v).toDouble(); val cc = dot(v, v).toDouble()
    val dd = dot(origin, u).toDouble(); val ee = dot(origin, v).toDouble(); val ff = dot(origin, origin).toDouble() - 1.0
    val coeff = listOf(aa + 2 * dd + ff, 4 * bb + 4 * ee, -2 * aa + 4 * cc + 2 * ff, -4 * bb + 4 * ee, aa - 2 * dd + ff)
    val candidates = polynomialRoots(coeff).map { (2.0 * kotlin.math.atan(it)).toFloat() }.toMutableList()
    if (kotlin.math.abs(ellipseImplicit(b, ellipseBoundary(a, Math.PI.toFloat()))) < 1e-5f) candidates += Math.PI.toFloat()
    val points = mutableListOf<Offset>()
    candidates.forEach { angle ->
        val point = ellipseBoundary(a, angle)
        if (kotlin.math.abs(ellipseImplicit(b, point)) < 1e-4f && points.none { (it - point).getDistance() < .001f }) points += point
    }
    return points
}

private data class BridgeSide(val start: Offset, val control1: Offset, val control2: Offset, val end: Offset) {
    fun point(t: Float): Offset = Offset(bezier(start.x, control1.x, control2.x, end.x, t),
        bezier(start.y, control1.y, control2.y, end.y, t))
}

private fun birthBridgeSide(
    a: GraphNodeSurface, b: GraphNodeSurface, direction: Offset, normal: Offset,
    crossing: Offset?, sign: Float, centerY: Float, halfEnd: Float, opening: Float, round: Float,
): BridgeSide? {
    val distance = (b.center - a.center).getDistance()
    val support = minOf(ellipseSupport(a, normal), ellipseSupport(b, normal)) * .9999f
    if (support <= .001f) return null
    val crossingY = crossing?.let { dot(it - a.center, normal) } ?: centerY
    if (crossing != null && (crossingY - centerY) * sign < -.001f) return null
    val available = (support - sign * crossingY).coerceAtLeast(0f)
    var clearance = minOf(halfEnd * opening, available)
    fun endpoints(amount: Float): Pair<Offset, Offset>? {
        val y = if (crossing != null) crossingY + sign * amount else (centerY + sign * halfEnd).coerceIn(-support, support)
        val aPositive = if (crossing == null) true else {
            val qx = dot(crossing - a.center, direction)
            kotlin.math.abs(qx - ellipseIntersection(a, direction, normal, crossingY, true)) <=
                kotlin.math.abs(qx - ellipseIntersection(a, direction, normal, crossingY, false))
        }
        val bPositive = if (crossing == null) false else {
            val qx = dot(crossing - b.center, direction)
            kotlin.math.abs(qx - ellipseIntersection(b, direction, normal, crossingY, true)) <=
                kotlin.math.abs(qx - ellipseIntersection(b, direction, normal, crossingY, false))
        }
        val start = Offset(ellipseIntersection(a, direction, normal, y, aPositive), y)
        val end = Offset(distance + ellipseIntersection(b, direction, normal, y, bPositive), y)
        return if (start.x <= end.x && (start.y - centerY) * sign >= 0f) start to end else null
    }
    var pair = endpoints(clearance)
    repeat(14) { if (pair == null && crossing != null) { clearance *= .5f; pair = endpoints(clearance) } }
    if (pair == null && crossing != null) {
        // Tilt can put the two ellipse intersections on the same side of the
        // centre line. Select points on actual exposed arcs in the local bridge
        // half-plane instead of inventing a reflected intersection.
        fun exposed(node: GraphNodeSurface, other: GraphNodeSurface): List<Offset> {
            val axis = node.axis; val cross = Offset(-axis.y, axis.x)
            val relative = crossing - node.center
            val angle = kotlin.math.atan2(dot(relative, cross) / node.minor.coerceAtLeast(.001f),
                dot(relative, axis) / node.major.coerceAtLeast(.001f))
            val step = (halfEnd * opening / node.minor.coerceAtLeast(.001f)).coerceIn(.00001f, .5f)
            return listOf(-step, step).map { ellipseBoundary(node, angle + it) }.filter { point ->
                ellipseImplicit(other, point) >= -.00001f && (dot(point - a.center, normal) - centerY) * sign >= 0f
            }
        }
        val aPoints = exposed(a, b)
        val bPoints = exposed(b, a)
        pair = aPoints.flatMap { ap -> bPoints.map { bp ->
            Offset(dot(ap - a.center, direction), dot(ap - a.center, normal)) to
                Offset(dot(bp - a.center, direction), dot(bp - a.center, normal))
        } }.filter { (ap, bp) -> ap.x <= bp.x }.minByOrNull { (ap, bp) -> (bp - ap).getDistance() }
    }
    val (start, end) = pair ?: return null
    val span = end.x - start.x
    if (span <= .0001f) return null
    fun tangent(node: GraphNodeSurface, relative: Offset): Offset {
        val normalWorld = ellipseNormal(node, direction * relative.x + normal * relative.y)
        val localNormal = Offset(dot(normalWorld, direction), dot(normalWorld, normal))
        val candidate = Offset(-localNormal.y, localNormal.x)
        return if (candidate.x >= 0f) candidate else -candidate
    }
    val t0 = tangent(a, start)
    val t3 = tangent(b, Offset(end.x - distance, end.y))
    var length0 = minOf(round, span / (t0.x + t3.x).coerceAtLeast(.001f) * .45f)
    var length3 = length0
    if (sign * t0.y < 0f) length0 = minOf(length0, kotlin.math.abs((start.y - centerY) / t0.y))
    if (sign * t3.y > 0f) length3 = minOf(length3, kotlin.math.abs((end.y - centerY) / t3.y))
    return BridgeSide(start, start + t0 * length0, end - t3 * length3, end)
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
        val fields = mutableMapOf<String, GradientField>()
        fun resolve(node: GraphNodeSurface, seen: Set<String> = emptySet()): GradientField {
            fields[node.id]?.let { return it }
            val own = ownField(node)
            if (node.id in seen) return own
            val source = node.birthSourceId?.let(nodesById::get)
            val resolved = if (source == null || !source.visible) own else {
                val gate = smooth(graphSurfaceGap(source, node) / (6.dp.toPx() * inverseZoom).coerceAtLeast(.001f))
                mixedField(resolve(source, seen + node.id), own, smooth(node.materialProgress) * gate)
            }
            fields[node.id] = resolved
            return resolved
        }
        nodes.forEach { resolve(it) }
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
        val touchingBridges = mutableListOf<Triple<String, String, Path>>()
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
            if (isBirth) {
                val separation = surfaceSeparation(a, b)
                val surfaceGap = separation.gap
                // Even before a bridge has nonzero area, touching/contained
                // parent and child must share one fill and not double-blend.
                if (surfaceGap <= .0001f) touchingBridges += Triple(a.id, b.id, Path())
                val gateDistance = 6.dp.toPx() * inverseZoom
                val transition = smooth(surfaceGap / gateDistance.coerceAtLeast(.001f))
                val halfEnd = minOf(requestedHalfEnd, a.minor * .7f, b.minor * .7f)
                val crossings = if (surfaceGap <= .0001f) ellipseCrossings(a, b) else emptyList()
                val topCrossing = crossings.minByOrNull { dot(it - a.center, normal) }
                val bottomCrossing = crossings.maxByOrNull { dot(it - a.center, normal) }
                val exposure = containmentExposure(a, b).coerceAtLeast(0f)
                if (crossings.size < 2 && surfaceGap <= .0001f && exposure <= .0001f) return@forEach
                val contactMidpoint = if (crossings.size >= 2) (topCrossing!! + bottomCrossing!!) / 2f else
                    (supportPoint(a, separation.axis) + supportPoint(b, -separation.axis)) / 2f
                val localCenter = dot(contactMidpoint - a.center, normal) * (1f - transition)
                val opening = smooth(exposure / (halfEnd * 2f).coerceAtLeast(.001f))
                val top = birthBridgeSide(a, b, direction, normal, topCrossing.takeIf { crossings.size >= 2 }, -1f, localCenter, halfEnd, opening, round) ?: return@forEach
                val bottom = birthBridgeSide(a, b, direction, normal, bottomCrossing.takeIf { crossings.size >= 2 }, 1f, localCenter, halfEnd, opening, round) ?: return@forEach
                val start = minOf(ellipseIntersection(a, direction, normal, -halfEnd, true),
                    ellipseIntersection(a, direction, normal, halfEnd, true)) - overlap
                val end = distance + maxOf(ellipseIntersection(b, direction, normal, -halfEnd, false),
                    ellipseIntersection(b, direction, normal, halfEnd, false)) + overlap
                val span = (end - start).coerceAtLeast(.0001f)
                val shoulder = minOf(taper, span / 2f)
                val nA = ellipseNormal(a, direction * (start + overlap) - normal * halfEnd)
                val nB = ellipseNormal(b, direction * (end - distance - overlap) - normal * halfEnd)
                val tangentA = Offset(kotlin.math.abs(dot(nA, normal)), dot(nA, direction))
                val tangentB = Offset(kotlin.math.abs(dot(nB, normal)), dot(nB, direction))
                val c1x = (start + tangentA.x * round).coerceAtMost(start + shoulder)
                val c1w = (halfEnd - tangentA.y * round).coerceAtLeast(0f)
                val c2x = (end - tangentB.x * round).coerceAtLeast(end - shoulder)
                val c2w = (halfEnd + tangentB.y * round).coerceAtLeast(0f)
                fun normalBoundary(index: Int, side: Float): Offset {
                    val x: Float
                    val width: Float
                    when {
                        index <= 6 -> { val t = index / 6f; x = bezier(start, c1x, start + shoulder * .6f, start + shoulder, t); width = bezier(halfEnd, c1w, halfBody, halfBody, t) }
                        index <= 12 -> { val t = (index - 6) / 6f; x = start + shoulder + (end - start - 2f * shoulder) * t; width = halfBody }
                        else -> { val t = (index - 12) / 6f; x = bezier(end - shoulder, end - shoulder * .6f, c2x, end, t); width = bezier(halfBody, halfBody, c2w, halfEnd, t) }
                    }
                    return Offset(x, side * width)
                }
                fun world(point: Offset) = a.center + direction * point.x + normal * point.y
                if (surfaceGap <= .0001f) {
                    // Both shapes and the bridge use the identical world field while touching.
                    val path = Path().apply {
                        val p = world(top.start); val p1 = world(top.control1); val p2 = world(top.control2); val p3 = world(top.end)
                        moveTo(p.x, p.y); cubicTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y)
                        val q = world(bottom.end); val q1 = world(bottom.control2); val q2 = world(bottom.control1); val q3 = world(bottom.start)
                        lineTo(q.x, q.y); cubicTo(q1.x, q1.y, q2.x, q2.y, q3.x, q3.y); close()
                    }
                    touchingBridges += Triple(a.id, b.id, path)
                } else {
                    val positions = mutableListOf<Offset>(); val vertexColors = mutableListOf<Color>()
                    val first = fields.getValue(a.id); val last = fields.getValue(b.id)
                    for (index in 0..18) {
                        val t = index / 18f
                        val rawTop = top.point(t); val rawBottom = bottom.point(t)
                        val targetTop = normalBoundary(index, -1f); val targetBottom = normalBoundary(index, 1f)
                        val upper = rawTop + (targetTop - rawTop) * transition
                        val lower = rawBottom + (targetBottom - rawBottom) * transition
                        for (row in 0..16) {
                            val side = row / 8f - 1f
                            val axisY = localCenter * (1f - transition)
                            val local = if (side < 0f) Offset(upper.x + (lower.x - upper.x) * ((side + 1f) / 2f), axisY + (upper.y - axisY) * -side)
                                else Offset(upper.x + (lower.x - upper.x) * ((side + 1f) / 2f), axisY + (lower.y - axisY) * side)
                            val point = world(local)
                            positions += point
                            val normalAmount = ((local.x - start) / span).coerceIn(0f, 1f)
                            val worldColor = platformGradientColor(first.sample(point).copy(alpha = first.alpha), last.sample(point).copy(alpha = last.alpha), t)
                            val ay = (halfEnd * side).coerceIn(-a.minor * .7f, a.minor * .7f)
                            val by = (halfEnd * side).coerceIn(-b.minor * .7f, b.minor * .7f)
                            val aPoint = a.center + direction * ellipseIntersection(a, direction, normal, ay, true) + normal * ay
                            val bPoint = b.center + direction * ellipseIntersection(b, direction, normal, by, false) + normal * by
                            val normalColor = platformGradientColor(first.sample(aPoint).copy(alpha = first.alpha), last.sample(bPoint).copy(alpha = last.alpha), normalAmount)
                            vertexColors += platformGradientColor(worldColor, normalColor, transition)
                        }
                    }
                    val indices = mutableListOf<Int>()
                    for (index in 0 until 18) for (row in 0 until 16) {
                        val i = index * 17 + row; val j = (index + 1) * 17 + row
                        indices.addAll(listOf(i, j, j + 1, i, j + 1, i + 1))
                    }
                    val mesh = Vertices(VertexMode.Triangles, positions, textureCoordinates = positions, colors = vertexColors, indices = indices)
                    drawIntoCanvas { canvas -> canvas.drawVertices(mesh, BlendMode.Modulate, meshPaint) }
                }
                return@forEach
            }
            if (distance <= ra + rb) return@forEach
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
                val first = fields.getValue(a.id).sample(aPoint).copy(alpha = fields.getValue(a.id).alpha)
                val last = fields.getValue(b.id).sample(bPoint).copy(alpha = fields.getValue(b.id).alpha)
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
                val mesh = Vertices(VertexMode.Triangles, positions, textureCoordinates = positions, colors = vertexColors, indices = indices)
                drawIntoCanvas { canvas -> canvas.drawVertices(mesh, BlendMode.Modulate, meshPaint) }
            }
        }
        fun birthDepth(node: GraphNodeSurface): Int {
            var current = node; var depth = 0; val seen = mutableSetOf(node.id)
            while (true) { val source = current.birthSourceId?.let(nodesById::get) ?: break; if (!seen.add(source.id)) break; depth++; current = source }
            return depth
        }
        // All touching descendants share the same field. Draw each connected
        // set as one compound fill so translucent focus does not double-blend seams.
        val remaining = touchingBridges.toMutableList()
        val grouped = mutableSetOf<String>()
        while (remaining.isNotEmpty()) {
            val firstBridge = remaining.removeAt(0)
            val members = mutableSetOf(firstBridge.first, firstBridge.second)
            val paths = mutableListOf(firstBridge.third)
            var changed: Boolean
            do {
                changed = false
                val iterator = remaining.iterator()
                while (iterator.hasNext()) {
                    val bridge = iterator.next()
                    if (bridge.first in members || bridge.second in members) {
                        members += bridge.first; members += bridge.second; paths += bridge.third
                        iterator.remove(); changed = true
                    }
                }
            } while (changed)
            val compound = Path()
            members.mapNotNull(nodesById::get).filter { it.visible && !it.hidden && it.radius > 0f }.forEach { node ->
                compound.addPath(nodeShape(node)); grouped += node.id
            }
            paths.forEach { compound.addPath(it) }
            val field = fields.getValue(firstBridge.first)
            drawPath(compound, brush = field.brush(), alpha = field.alpha)
        }
        nodes.sortedByDescending(::birthDepth).forEach { node ->
            if (node.id !in grouped && node.visible && !node.hidden && node.radius > 0f) {
                val field = fields.getValue(node.id)
                drawPath(nodeShape(node), brush = field.brush(), alpha = field.alpha)
            }
        }
    }
}
