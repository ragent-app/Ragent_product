package com.andysagent.ragent.feature.organization.presentation

import com.andysagent.ragent.feature.organization.layout.LayoutResult
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.sin

/** A verified event may nominate an actual dispatcher; parent links alone are not evidence. */
internal data class PhysicsBirth(val nodeId: String, val actorNodeId: String, val order: Int)
internal data class PhysicsSnapshot(val frames: Map<String, NodePhysicsFrame> = emptyMap(), val running: Boolean = false)

/** One bounded, mass-weighted integrator supplies both node and edge geometry. */
internal class OrganizationPhysicsSolver {
    private data class Body(
        val id: String, var parent: String?, var root: Boolean,
        var x: Float, var y: Float, var vx: Float, var vy: Float,
        var targetX: Float, var targetY: Float,
        var radius: Float, var radiusVelocity: Float, var targetRadius: Float,
        var source: String? = null, var birthAge: Float = 0f, var birthDelay: Float = 0f,
        var launched: Boolean = false,
        var birthSettled: Boolean = false,
        var materialElapsed: Float = 0f,
        var materialStarted: Boolean = false,
        var materialGapDp: Float = 0f,
        var releaseAge: Float = 0f,
        var releaseX: Float = 0f, var releaseY: Float = 0f,
        var releaseOffsetX: Float = 0f, var releaseOffsetY: Float = 0f,
    )
    private val bodies = linkedMapOf<String, Body>()
    private var density = 1f
    private var lastFrameNanos: Long? = null
    private var moving = false
    private val materialDuration = .22f

    fun reportBirthSurfaceGaps(gapsDp: Map<String, Float>): PhysicsSnapshot {
        gapsDp.forEach { (id, gap) ->
            val b = bodies[id] ?: return@forEach
            if (b.source == null || !gap.isFinite()) return@forEach
            b.materialGapDp = gap
            if (gap > 0f) b.materialStarted = true
            if (b.materialStarted && materialDuration == 0f) b.materialElapsed = materialDuration
            if (b.materialStarted && b.materialElapsed < materialDuration) moving = true
            if (b.birthSettled && b.materialStarted && b.materialElapsed >= materialDuration && gap >= 6f) b.source = null
        }
        return snapshot()
    }

    fun updateTargets(layout: LayoutResult, parents: Map<String, String?>, density: Float,
        births: List<PhysicsBirth>, animate: Boolean): PhysicsSnapshot {
        this.density = density.coerceAtLeast(.1f)
        val newIds = layout.nodePositions.keys
        bodies.keys.retainAll(newIds)
        bodies.values.forEach { body ->
            val source = body.source
            if (source != null && source !in newIds) body.source = null
        }
        val cues = births.associateBy { it.nodeId }
        val remaining = layout.nodePositions.values.sortedBy { cues[it.id]?.order ?: -1 }.toMutableList()
        while (remaining.isNotEmpty()) {
            // An actor that is also newly present must be created before its child.
            // Cycles or absent actors fall back to ordinary appearance.
            val next = remaining.indexOfFirst { node ->
                val actor = cues[node.id]?.actorNodeId
                node.id in bodies || actor == null || actor in bodies || remaining.none { it.id == actor }
            }.let { if (it < 0) 0 else it }
            val node = remaining.removeAt(next)
            val targetRadius = node.radius * node.scale
            val existing = bodies[node.id]
            if (existing != null) {
                if (existing.targetX != node.x || existing.targetY != node.y || existing.targetRadius != targetRadius) moving = true
                existing.parent = parents[node.id]?.takeIf { it in newIds }
                existing.root = node.id == layout.rootId
                existing.targetX = node.x; existing.targetY = node.y; existing.targetRadius = targetRadius
            } else {
                val cue = cues[node.id]
                val source = cue?.actorNodeId?.let(bodies::get)
                val canBirth = animate && source != null
                val dx = node.x - (source?.x ?: node.x); val dy = node.y - (source?.y ?: node.y)
                val length = hypot(dx, dy).coerceAtLeast(1f)
                val startDistance = ((source?.radius ?: 0f) - 2f).coerceAtLeast(0f) * this.density
                bodies[node.id] = Body(node.id, parents[node.id]?.takeIf { it in newIds }, node.id == layout.rootId,
                    if (canBirth) source!!.x + dx / length * startDistance else node.x,
                    if (canBirth) source!!.y + dy / length * startDistance else node.y,
                    0f, 0f, node.x, node.y, if (canBirth) 2f else targetRadius, 0f, targetRadius,
                    if (canBirth) cue!!.actorNodeId else null, birthDelay = if (canBirth) (cue!!.order.coerceIn(0, 4) * .06f) else 0f)
                if (canBirth) moving = true
            }
        }
        if (!animate) snapToTargets() else if (moving) lastFrameNanos = null
        return snapshot()
    }

    /** Replays existing demo nodes through the same integrator; no business data changes. */
    fun replayDemoBirths(layout: LayoutResult, parents: Map<String, String?>, density: Float,
        births: List<PhysicsBirth>, animate: Boolean): PhysicsSnapshot {
        if (!animate) return snapToTargets()
        births.forEach { bodies.remove(it.nodeId) }
        return updateTargets(layout, parents, density, births, animate = true)
    }

    fun snapToTargets(preserveMaterial: Boolean = false): PhysicsSnapshot {
        bodies.values.forEach { b ->
            b.x = b.targetX; b.y = b.targetY; b.vx = 0f; b.vy = 0f
            b.radius = b.targetRadius; b.radiusVelocity = 0f
            if (preserveMaterial && b.source != null) b.birthSettled = true else b.source = null
            b.launched = false; b.releaseAge = 0f
        }
        moving = false
        lastFrameNanos = null
        return snapshot()
    }

    fun advance(frameNanos: Long): PhysicsSnapshot {
        if (!moving) return snapshot()
        val previous = lastFrameNanos
        lastFrameNanos = frameNanos
        if (previous == null) return snapshot()
        // Never replay background time; integration remains bounded after suspension.
        val elapsed = ((frameNanos - previous).coerceAtLeast(0L) / 1_000_000_000f).coerceAtMost(.05f)
        if (elapsed <= 0f) return snapshot()
        val count = ceil(elapsed / (1f / 120f)).toInt().coerceIn(1, 6)
        repeat(count) { integrate(elapsed / count) }
        val positionTolerance = .10f * density
        moving = bodies.values.any { b -> (b.source != null && (!b.birthSettled || b.materialStarted && b.materialElapsed < materialDuration)) || abs(b.x - b.targetX) > positionTolerance ||
            abs(b.y - b.targetY) > positionTolerance || abs(b.vx) > .5f * density || abs(b.vy) > .5f * density ||
            abs(b.radius - b.targetRadius) > .025f || abs(b.radiusVelocity) > .1f }
        if (!moving) return snapToTargets(preserveMaterial = true)
        return snapshot()
    }

    private fun sourceReady(body: Body): Boolean {
        val source = body.source?.let(bodies::get) ?: return true
        return source.source == null || source.radius >= source.targetRadius * .85f
    }

    private fun mass(body: Body): Float = (body.targetRadius * body.targetRadius * if (body.root) 2f else 1f).coerceAtLeast(.001f)

    private fun releaseBlend(body: Body): Float {
        val t = (body.releaseAge / .2f).coerceIn(0f, 1f)
        return t * t * (3f - 2f * t)
    }

    private fun integrate(dt: Float) {
        // Resolve attachment and one-time release before evaluating any forces.
        bodies.values.forEach { b ->
            val active = b.source != null && !b.birthSettled
            if (b.source != null && b.materialStarted) b.materialElapsed = (b.materialElapsed + dt).coerceAtMost(materialDuration)
            if (active && sourceReady(b)) b.birthAge += dt
            val age = (b.birthAge - b.birthDelay).coerceAtLeast(0f)
            val actor = if (active && !b.launched) b.source?.let(bodies::get) else null
            if (actor != null) {
                val dx = b.targetX - actor.targetX; val dy = b.targetY - actor.targetY
                val length = hypot(dx, dy)
                val ux = if (length > .001f) dx / length else 0f
                val uy = if (length > .001f) dy / length else 1f
                val t = (age / .14f).coerceIn(0f, 1f)
                val budding = t * t * (3f - 2f * t)
                b.radius = 2f + (b.targetRadius * .35f - 2f).coerceAtLeast(0f) * budding
                b.radiusVelocity = 0f
                val distance = (actor.radius + (-.7f + .4f * budding) * b.radius).coerceAtLeast(0f) * density
                b.x = actor.x + ux * distance; b.y = actor.y + uy * distance
                b.vx = actor.vx; b.vy = actor.vy
                if (age >= .22f) {
                    val parent = b.parent?.let(bodies::get)
                    b.releaseX = b.x; b.releaseY = b.y
                    b.releaseOffsetX = b.x - (parent?.x ?: b.x)
                    b.releaseOffsetY = b.y - (parent?.y ?: b.y)
                    b.releaseAge = 0f
                    val sourceMass = mass(actor); val childMass = mass(b)
                    val reducedMass = sourceMass * childMass / (sourceMass + childMass)
                    val side = if (dx >= 0f) -1f else 1f
                    val jx = reducedMass * (80f * ux - 12f * side * uy) * density
                    val jy = reducedMass * (80f * uy + 12f * side * ux) * density
                    b.vx += jx / childMass; b.vy += jy / childMass
                    actor.vx -= jx / sourceMass; actor.vy -= jy / sourceMass
                    b.launched = true
                }
            } else if (b.launched && b.releaseAge < .2f) {
                b.releaseAge = (b.releaseAge + dt).coerceAtMost(.2f)
            }
        }
        val accelerations = bodies.values.associate { b ->
            val omega = if (b.root) 18f else 8f
            val damping = if (b.root) .95f else .90f
            val blend = if (b.launched) releaseBlend(b) else 1f
            val anchorX = if (b.launched) b.releaseX + (b.targetX - b.releaseX) * blend else b.targetX
            val anchorY = if (b.launched) b.releaseY + (b.targetY - b.releaseY) * blend else b.targetY
            b.id to floatArrayOf(-omega * omega * (b.x - anchorX) - 2f * damping * omega * b.vx,
                -omega * omega * (b.y - anchorY) - 2f * damping * omega * b.vy)
        }
        bodies.values.forEach { child ->
            if (child.source != null && !child.launched && !child.birthSettled) return@forEach
            val parent = child.parent?.let(bodies::get) ?: return@forEach
            val targetX = child.targetX - parent.targetX; val targetY = child.targetY - parent.targetY
            val blend = if (child.launched) releaseBlend(child) else 1f
            val tx = if (child.launched) child.releaseOffsetX + (targetX - child.releaseOffsetX) * blend else targetX
            val ty = if (child.launched) child.releaseOffsetY + (targetY - child.releaseOffsetY) * blend else targetY
            val length = hypot(targetX, targetY)
            val ux = if (length > .001f) targetX / length else 0f
            val uy = if (length > .001f) targetY / length else 1f
            val ex = (child.x - parent.x) - tx; val ey = (child.y - parent.y) - ty
            val vx = child.vx - parent.vx; val vy = child.vy - parent.vy
            val radial = -14f * 14f * (ex * ux + ey * uy) - 2f * .68f * 14f * (vx * ux + vy * uy)
            val tangent = -10f * 10f * (-ex * uy + ey * ux) - 2f * .78f * 10f * (-vx * uy + vy * ux)
            val ax = radial * ux - tangent * uy; val ay = radial * uy + tangent * ux
            val childMass = mass(child); val parentMass = mass(parent)
            val reducedMass = childMass * parentMass / (childMass + parentMass)
            val childForce = accelerations.getValue(child.id); val parentForce = accelerations.getValue(parent.id)
            childForce[0] += ax * reducedMass / childMass; childForce[1] += ay * reducedMass / childMass
            parentForce[0] -= ax * reducedMass / parentMass; parentForce[1] -= ay * reducedMass / parentMass
        }
        bodies.values.forEach { b ->
            val activeBirth = b.source != null && !b.birthSettled
            val emergence = (b.birthAge - b.birthDelay).coerceAtLeast(0f)
            if (!activeBirth || b.launched) {
                val a = accelerations.getValue(b.id)
                b.vx += a[0] * dt; b.vy += a[1] * dt
                b.x += b.vx * dt; b.y += b.vy * dt
            }
            val radiusTarget = b.targetRadius
            val omega = if (activeBirth) 16f else 18f; val damping = if (activeBirth) .78f else 1f
            if (!activeBirth || emergence >= .22f) {
                b.radiusVelocity += (-omega * omega * (b.radius - radiusTarget) - 2f * damping * omega * b.radiusVelocity) * dt
                val nextRadius = (b.radius + b.radiusVelocity * dt).coerceAtLeast(0f)
                b.radius = if (activeBirth) nextRadius.coerceAtMost(b.targetRadius * 1.03f) else nextRadius
                if (activeBirth && b.radius >= b.targetRadius * 1.03f && b.radiusVelocity > 0f) b.radiusVelocity = 0f
            }
            if (activeBirth && emergence >= .22f && abs(b.radius - b.targetRadius) < .025f && abs(b.radiusVelocity) < .1f) {
                val parent = b.parent?.let(bodies::get)
                val clearParent = parent == null || (b.y > parent.y &&
                    hypot(b.x - parent.x, b.y - parent.y) >= maxOf(64f, b.radius + parent.radius) * density)
                val clearSiblings = bodies.values.none { other ->
                    other.id != b.id && other.parent == b.parent && other.source == null &&
                        hypot(other.x - b.x, other.y - b.y) < maxOf(64f, other.radius + b.radius) * density
                }
                if (clearParent && clearSiblings) b.birthSettled = true
            }
            if (b.birthSettled && b.materialStarted && b.materialElapsed >= materialDuration && b.materialGapDp >= 6f) b.source = null
        }
        bodies.values.forEach { child ->
            // A verified dispatcher can be an ancestor rather than the direct parent.
            // Keep the source overlap during birth; apply tree collision constraints after it emerges.
            if (child.source != null && !child.birthSettled) return@forEach
            val parent = child.parent?.let(bodies::get) ?: return@forEach
            val minimumY = parent.y + .5f * density
            if (child.y < minimumY) { child.y = minimumY; if (child.vy < parent.vy) child.vy = parent.vy }
            val targetDx = child.targetX - parent.targetX
            if (targetDx < -density && child.x > parent.x) { child.x = parent.x; if (child.vx > parent.vx) child.vx = parent.vx }
            if (targetDx > density && child.x < parent.x) { child.x = parent.x; if (child.vx < parent.vx) child.vx = parent.vx }
            if ((child.source == null || child.birthSettled) && (parent.source == null || parent.birthSettled)) {
                val dx = child.x - parent.x; val dy = child.y - parent.y
                val distance = hypot(dx, dy)
                val minimum = maxOf(64f, child.radius + parent.radius) * density
                if (distance < minimum) {
                    val tx = child.targetX - parent.targetX; val ty = child.targetY - parent.targetY
                    val length = hypot(tx, ty).coerceAtLeast(1f)
                    val ux = tx / length; val uy = ty / length
                    child.x = parent.x + ux * minimum; child.y = parent.y + uy * minimum
                    val inward = (child.vx - parent.vx) * ux + (child.vy - parent.vy) * uy
                    if (inward < 0f) { child.vx -= inward * ux; child.vy -= inward * uy }
                }
            }
        }
        bodies.values.filter { it.parent != null }.groupBy { it.parent }.values.forEach { siblings ->
            val ordered = siblings.sortedBy { it.targetX }
            ordered.zipWithNext().forEach { (left, right) ->
                val minimum = maxOf(64f, left.radius + right.radius) * density
                if ((left.source == null || left.birthSettled) && (right.source == null || right.birthSettled) && right.x - left.x < minimum) {
                    val midpoint = (left.x + right.x) / 2f
                    val velocity = (left.vx + right.vx) / 2f
                    left.x = midpoint - minimum / 2f; right.x = midpoint + minimum / 2f
                    if (left.vx > velocity) left.vx = velocity
                    if (right.vx < velocity) right.vx = velocity
                }
            }
        }
        // Sources may have moved during this substep or a layout constraint. Keep
        // attached children on their final displayed source, including its velocity.
        bodies.values.forEach { b ->
            if (b.source == null || b.launched || b.birthSettled) return@forEach
            val actor = b.source?.let(bodies::get) ?: return@forEach
            val dx = b.targetX - actor.targetX; val dy = b.targetY - actor.targetY
            val length = hypot(dx, dy)
            val ux = if (length > .001f) dx / length else 0f
            val uy = if (length > .001f) dy / length else 1f
            val t = ((b.birthAge - b.birthDelay).coerceAtLeast(0f) / .14f).coerceIn(0f, 1f)
            val budding = t * t * (3f - 2f * t)
            val distance = (actor.radius + (-.7f + .4f * budding) * b.radius).coerceAtLeast(0f) * density
            b.x = actor.x + ux * distance; b.y = actor.y + uy * distance
            b.vx = actor.vx; b.vy = actor.vy
        }
    }

    private fun snapshot(): PhysicsSnapshot {
        val deformation = mutableMapOf<String, Float>()
        val deformationDirection = mutableMapOf<String, Pair<Float, Float>>()
        bodies.values.forEach { b ->
            val age = b.birthAge - b.birthDelay
            val source = b.source
            if (source != null && !b.birthSettled && sourceReady(b) && age in .14f..0.22f) {
                val value = sin(Math.PI.toFloat() * (age - .14f) / .08f)
                if (value > (deformation[source] ?: 0f)) {
                    val actor = bodies[source]
                    if (actor != null) {
                        val dx = b.targetX - actor.targetX; val dy = b.targetY - actor.targetY
                        val length = hypot(dx, dy).coerceAtLeast(1f)
                        deformationDirection[source] = dx / length to dy / length
                    }
                    deformation[source] = value
                }
            }
        }
        return PhysicsSnapshot(bodies.mapValues { (_, b) ->
            val progress = if (b.targetRadius > 0f) (b.radius / b.targetRadius).coerceIn(0f, 1f) else 1f
            NodePhysicsFrame(b.x, b.y, b.radius, progress, b.source,
                separationMaterialProgress = if (b.source == null || materialDuration == 0f) 1f else (b.materialElapsed / materialDuration).coerceIn(0f, 1f),
                birthVisible = b.source == null || (sourceReady(b) && b.birthAge >= b.birthDelay),
                clickable = b.source == null || (sourceReady(b) && progress >= .85f),
                iconAlpha = if (b.source == null) 1f else ((progress - .60f) / .25f).coerceIn(0f, 1f),
                sourceDeformation = deformation[b.id] ?: 0f,
                deformationDirectionX = deformationDirection[b.id]?.first ?: 0f,
                deformationDirectionY = deformationDirection[b.id]?.second ?: 1f)
        }, moving)
    }
}
