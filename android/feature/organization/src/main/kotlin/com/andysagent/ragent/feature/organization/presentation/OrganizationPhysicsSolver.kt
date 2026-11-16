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
        var recoilX: Float = 0f, var recoilY: Float = 0f, var recoilVx: Float = 0f, var recoilVy: Float = 0f,
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
            b.recoilX = 0f; b.recoilY = 0f; b.recoilVx = 0f; b.recoilVy = 0f
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
            abs(b.radius - b.targetRadius) > .025f || abs(b.radiusVelocity) > .1f ||
            abs(b.recoilX) > .05f * density || abs(b.recoilY) > .05f * density ||
            abs(b.recoilVx) > .25f * density || abs(b.recoilVy) > .25f * density }
        if (!moving) return snapToTargets(preserveMaterial = true)
        return snapshot()
    }

    private fun sourceReady(body: Body): Boolean {
        val source = body.source?.let(bodies::get) ?: return true
        return source.source == null || source.radius >= source.targetRadius * .85f
    }

    private fun integrate(dt: Float) {
        val accelerations = bodies.values.associate { b ->
            val omega = if (b.root) 18f else 8f
            val damping = if (b.root) .95f else .90f
            b.id to floatArrayOf(-omega * omega * (b.x - b.targetX) - 2f * damping * omega * b.vx,
                -omega * omega * (b.y - b.targetY) - 2f * damping * omega * b.vy)
        }
        val reactions = bodies.keys.associateWith { floatArrayOf(0f, 0f) }
        val birthReactions = bodies.keys.associateWith { floatArrayOf(0f, 0f) }
        bodies.values.forEach { child ->
            if (child.source != null && !child.birthSettled && (!sourceReady(child) || child.birthAge - child.birthDelay < .22f)) return@forEach
            val parent = child.parent?.let(bodies::get) ?: return@forEach
            val tx = child.targetX - parent.targetX; val ty = child.targetY - parent.targetY
            val length = hypot(tx, ty).coerceAtLeast(1f); val ux = tx / length; val uy = ty / length
            val ex = (child.x - parent.x) - tx; val ey = (child.y - parent.y) - ty
            val vx = child.vx - parent.vx; val vy = child.vy - parent.vy
            val radial = -14f * 14f * (ex * ux + ey * uy) - 2f * .68f * 14f * (vx * ux + vy * uy)
            val tangent = -10f * 10f * (-ex * uy + ey * ux) - 2f * .78f * 10f * (-vx * uy + vy * ux)
            val ax = radial * ux - tangent * uy; val ay = radial * uy + tangent * ux
            val childForce = accelerations.getValue(child.id); childForce[0] += ax; childForce[1] += ay
            val childMass = child.targetRadius * child.targetRadius
            val parentMass = parent.targetRadius * parent.targetRadius * if (parent.root) 2f else 1f
            val birthActive = child.source != null && !child.birthSettled
            val reactionTarget = (if (birthActive) child.source?.let(bodies::get) else null) ?: parent
            val reactionMass = reactionTarget.targetRadius * reactionTarget.targetRadius * if (reactionTarget.root) 2f else 1f
            val parentForce = if (birthActive) birthReactions.getValue(reactionTarget.id) else reactions.getValue(parent.id)
            val mass = if (birthActive) reactionMass else parentMass
            parentForce[0] -= ax * childMass / mass
            parentForce[1] -= ay * childMass / mass
        }
        bodies.values.forEach { body ->
            val reaction = reactions.getValue(body.id)
            val force = accelerations.getValue(body.id)
            force[0] += reaction[0]; force[1] += reaction[1]
            val birthForce = birthReactions.getValue(body.id)
            val limit = (if (body.root) 2f else 4f) * density
            val accelerationLimit = limit * 18f * 18f
            body.recoilVx += (-18f * 18f * body.recoilX - 2f * .95f * 18f * body.recoilVx + birthForce[0].coerceIn(-accelerationLimit, accelerationLimit)) * dt
            body.recoilVy += (-18f * 18f * body.recoilY - 2f * .95f * 18f * body.recoilVy + birthForce[1].coerceIn(-accelerationLimit, accelerationLimit)) * dt
            body.recoilX += body.recoilVx * dt; body.recoilY += body.recoilVy * dt
            val magnitude = hypot(body.recoilX, body.recoilY)
            if (magnitude > limit && magnitude > 0f) {
                body.recoilX *= limit / magnitude; body.recoilY *= limit / magnitude
                val outward = (body.recoilVx * body.recoilX + body.recoilVy * body.recoilY) / (limit * limit)
                if (outward > 0f) { body.recoilVx -= outward * body.recoilX; body.recoilVy -= outward * body.recoilY }
            }
        }
        bodies.values.forEach { b ->
            val activeBirth = b.source != null && !b.birthSettled
            if (b.source != null && b.materialStarted) b.materialElapsed = (b.materialElapsed + dt).coerceAtMost(materialDuration)
            if (activeBirth && sourceReady(b)) b.birthAge += dt
            val emergence = (b.birthAge - b.birthDelay).coerceAtLeast(0f)
            if (activeBirth && emergence < .22f) {
                val actor = b.source?.let(bodies::get)
                if (actor != null) {
                    val dx = b.targetX - actor.targetX; val dy = b.targetY - actor.targetY
                    val length = hypot(dx, dy).coerceAtLeast(1f)
                    val t = (emergence / .14f).coerceIn(0f, 1f)
                    val budding = t * t * (3f - 2f * t)
                    b.radius = 2f + (b.targetRadius * .35f - 2f).coerceAtLeast(0f) * budding
                    b.radiusVelocity = 0f
                    val distance = (actor.radius + (-.7f + .9f * budding) * b.radius).coerceAtLeast(0f) * density
                    b.x = actor.x + dx / length * distance; b.y = actor.y + dy / length * distance
                    b.vx = 0f; b.vy = 0f
                }
            } else {
                if (activeBirth && !b.launched) {
                    val actor = b.source?.let(bodies::get)
                    if (actor != null) {
                        val dx = b.targetX - actor.targetX; val dy = b.targetY - actor.targetY
                        val length = hypot(dx, dy).coerceAtLeast(1f)
                        val direction = if (dx >= 0f) -1f else 1f
                        b.vx += (-dy / length) * direction * 30f * density
                        b.vy += (dx / length) * direction * 30f * density
                    }
                    b.launched = true
                }
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
            NodePhysicsFrame(b.x + b.recoilX, b.y + b.recoilY, b.radius, progress, b.source,
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
