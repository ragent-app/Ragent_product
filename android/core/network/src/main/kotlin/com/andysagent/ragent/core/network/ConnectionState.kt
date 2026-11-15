package com.andysagent.ragent.core.network

/**
 * ADR-0001 v3 connection state types.
 * These are the authoritative ADR states; distinct states must never be conflated.
 *
 * paired   — device config exists and awaits a verified bootstrap contract
 * reachable— TURN/P2P carrier responds
 * authenticated — device credential valid (challenge/verify succeeded)
 * connected — session API reachable through the selected carrier
 * degraded — was connected but probes are now failing
 * offline  — no verified carrier or network down
 */
enum class ConnectionStatus { Paired, Reachable, Authenticated, Connected, Degraded, AuthenticationRequired, Offline, Error }

enum class TransportKind { None, P2P, Turn }

data class ConnectionState(
    val status: ConnectionStatus,
    val transport: TransportKind = TransportKind.None,
    val reachable: Boolean = false,
    val authenticated: Boolean = false,
    val instanceId: String? = null,
    val deviceId: String? = null,
    val endpoint: String? = null,
    val latencyMs: Long? = null,
    val retryCount: Int = 0,
    val lastError: String? = null,
    val updatedAt: Long = 0L,
)
