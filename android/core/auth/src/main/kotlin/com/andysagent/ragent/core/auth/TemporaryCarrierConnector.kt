package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.p2p.IceServer
import com.andysagent.ragent.core.p2p.P2PCandidate
import com.andysagent.ragent.core.p2p.P2PSession
import com.andysagent.ragent.core.p2p.P2PSessionFactory
import com.andysagent.ragent.core.protocol.VerifiedTemporaryConnection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/** Owns authenticated temporary DataChannels by fixed computer identity; it has no HTTP/Owner fallback. */
class TemporaryCarrierConnector(
    private val factory: P2PSessionFactory,
    private val scope: CoroutineScope,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val onRecoveryRequired: (instanceId: String, reason: String) -> Unit = { _, _ -> },
    private val connectTimeoutMs: Long = 20_000,
) {
    private class Lease(var delivery: VerifiedTemporaryConnection) {
        var generation = 0L
        var active: P2PSession? = null
        var pending: P2PSession? = null
        var expiryJob: Job? = null
    }

    private val lock = Any()
    private val leases = linkedMapOf<String, Lease>()

    suspend fun connect(delivery: VerifiedTemporaryConnection): P2PSession = open(delivery, turnOnly = true)

    /** A failed direct probe leaves the target's current TURN relay untouched. */
    suspend fun upgrade(instanceId: String): Boolean {
        val delivery = synchronized(lock) {
            leases[instanceId]?.takeIf { it.active?.isOpen == true }?.delivery
        } ?: return false
        return try { open(delivery, turnOnly = false); true }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { false }
    }

    /** Compatibility helper is intentionally ambiguous when more than one computer is active. */
    suspend fun upgrade(): Boolean {
        val targetId = synchronized(lock) { leases.filterValues { it.active?.isOpen == true }.keys.singleOrNull() }
            ?: return false
        return upgrade(targetId)
    }

    fun session(expected: VerifiedTemporaryConnection? = null): P2PSession? {
        val targetId = expected?.instanceId ?: synchronized(lock) {
            leases.filterValues { it.active?.isOpen == true }.keys.singleOrNull()
        } ?: return null
        val current = synchronized(lock) {
            leases[targetId]?.let { lease -> Triple(lease, lease.delivery, lease.active) }
        } ?: return null
        if (expected != null && current.second != expected) return null
        if (nowMs() >= current.second.expiresAt) { stopExpected(targetId, current.second); return null }
        return current.third?.takeIf { it.isOpen }
    }

    fun connectedInstanceIds(): Set<String> = synchronized(lock) {
        leases.filterValues { it.active?.isOpen == true }.keys.toSet()
    }

    /** Stops one temporary grant without disturbing other computers; null stops all. */
    fun stop(instanceId: String? = null) {
        val closing = synchronized(lock) {
            val selected = if (instanceId == null) leases.toList() else listOfNotNull(leases[instanceId]?.let { instanceId to it })
            selected.forEach { (id, lease) ->
                lease.generation++
                lease.expiryJob?.cancel(); lease.expiryJob = null
                leases.remove(id)
            }
            selected.flatMap { (_, lease) -> listOfNotNull(lease.active, lease.pending) }.distinct()
        }
        closing.forEach { it.setUnexpectedCloseListener(null); it.close() }
    }

    private suspend fun open(delivery: VerifiedTemporaryConnection, turnOnly: Boolean): P2PSession {
        require(delivery.businessAccessReady && nowMs() < delivery.expiresAt)
        require(delivery.roomSecret.length == 64 && delivery.iceServers.isNotEmpty())
        val lease = synchronized(lock) {
            leases.getOrPut(delivery.instanceId) { Lease(delivery) }.also { current ->
                if (current.delivery != delivery) {
                    current.generation++
                    current.expiryJob?.cancel(); current.expiryJob = null
                    listOfNotNull(current.active, current.pending).distinct().forEach {
                        it.setUnexpectedCloseListener(null); it.close()
                    }
                    current.active = null; current.pending = null
                    current.delivery = delivery
                }
                if (turnOnly && current.delivery == delivery && current.active?.isOpen == true) return current.active!!
            }
        }
        val epoch = synchronized(lock) { ++lease.generation }
        val candidate = P2PCandidate(delivery.signalingEndpoint, delivery.roomId, delivery.roomSecret,
            delivery.iceServers.map { IceServer(it.urls, it.username, it.password) }, turnOnly = turnOnly)
        val session = factory.create(candidate)
        val displaced = synchronized(lock) {
            check(leases[delivery.instanceId] === lease && lease.generation == epoch) {
                "Temporary carrier was superseded"
            }
            lease.pending.also { lease.pending = session }
        }
        displaced?.takeIf { it !== session }?.let { it.setUnexpectedCloseListener(null); it.close() }
        try {
            withTimeout(connectTimeoutMs) { session.connect().getOrThrow() }
            val prior = synchronized(lock) {
                check(leases[delivery.instanceId] === lease && lease.generation == epoch &&
                    lease.delivery == delivery && nowMs() < delivery.expiresAt && session.isOpen) {
                    "Temporary carrier expired or was stopped"
                }
                val old = lease.active
                lease.active = session; lease.pending = null
                lease.expiryJob?.cancel()
                lease.expiryJob = scope.launch {
                    delay((delivery.expiresAt - nowMs()).coerceAtLeast(1))
                    if (nowMs() >= delivery.expiresAt) stopExpected(delivery.instanceId, delivery)
                }
                old
            }
            session.setUnexpectedCloseListener { reason ->
                val wasCurrent = synchronized(lock) {
                    if (leases[delivery.instanceId] !== lease || lease.active !== session) false else {
                        lease.active = null
                        lease.expiryJob?.cancel(); lease.expiryJob = null
                        true
                    }
                }
                if (wasCurrent) onRecoveryRequired(delivery.instanceId, reason)
            }
            prior?.takeIf { it !== session }?.let { it.setUnexpectedCloseListener(null); runCatching { it.close() } }
            return session
        } catch (error: Throwable) {
            synchronized(lock) { if (lease.pending === session) lease.pending = null }
            session.setUnexpectedCloseListener(null)
            session.close()
            throw error
        }
    }

    private fun stopExpected(instanceId: String, expected: VerifiedTemporaryConnection) {
        val closing = synchronized(lock) {
            val lease = leases[instanceId]?.takeIf { it.delivery == expected } ?: return
            lease.generation++
            lease.expiryJob?.cancel(); lease.expiryJob = null
            leases.remove(instanceId)
            listOfNotNull(lease.active, lease.pending).distinct()
        }
        closing.forEach { it.setUnexpectedCloseListener(null); it.close() }
    }
}
