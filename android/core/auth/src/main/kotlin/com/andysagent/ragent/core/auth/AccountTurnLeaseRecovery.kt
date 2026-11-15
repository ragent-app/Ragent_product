package com.andysagent.ragent.core.auth

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable

private val TURN_RESERVATION_ID = Regex("^turn_[a-f0-9]{32}_[0-9]{13}_[a-f0-9]{32}$")
internal fun isTurnReservationId(value: String): Boolean = TURN_RESERVATION_ID.matches(value)

@Serializable
data class AccountTurnConnection(val connectionId: String, val instanceId: String, val deviceId: String, val expiresAt: String)

@Serializable
data class AccountTurnConnectionsPage(
    val contractVersion: Int,
    val accountId: String,
    val deviceId: String,
    val asOf: String,
    val connections: List<AccountTurnConnection>,
    val nextCursor: String? = null,
    val legacyConnections: Int = 0,
)

@Serializable
data class AccountTurnConnectionsRelease(
    val contractVersion: Int,
    val accountId: String,
    val deviceId: String,
    val processedConnections: Int,
    val releasedConnections: Int,
)

@Serializable
internal data class AccountTurnConnectionsReleaseRequest(val connectionIds: List<String>, val reason: String)

interface AccountTurnLeaseClient {
    suspend fun listOwnTurnConnections(afterConnectionId: String? = null): AccountTurnConnectionsPage
    suspend fun releaseOwnTurnConnections(connectionIds: List<String>, reason: String = "client-release"): AccountTurnConnectionsRelease
}

/** A process-start barrier. Once opened, it can never inventory live new carriers. */
class ColdTurnLeaseRecovery(
    private val client: AccountTurnLeaseClient,
    private val enabled: () -> Boolean = { true },
    private val timeoutMs: Long = 1_500,
    private val maximumPages: Int = 10,
) {
    private val mutex = Mutex()
    private var attempted = false

    suspend fun beforeNewReservations() = mutex.withLock {
        if (attempted) return@withLock
        // Cancellation, old Accounts versions, offline state or missing RAC may
        // skip this cleanup. Never retry an inventory after new carriers start.
        attempted = true
        if (!enabled()) return@withLock
        try {
            withTimeoutOrNull(timeoutMs) {
                var cursor: String? = null
                repeat(maximumPages) {
                    val page = client.listOwnTurnConnections(cursor)
                    currentCoroutineContext().ensureActive()
                    val ids = page.connections.map { it.connectionId }
                    if (ids.isNotEmpty()) client.releaseOwnTurnConnections(ids, "cold-process-recovery")
                    currentCoroutineContext().ensureActive()
                    cursor = page.nextCursor ?: return@withTimeoutOrNull
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Lease expiry/new generation admission remains authoritative.
        }
    }
}
