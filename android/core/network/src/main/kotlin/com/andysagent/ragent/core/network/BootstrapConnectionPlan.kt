package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.p2p.IceServer
import com.andysagent.ragent.core.p2p.P2PCandidate
import com.andysagent.ragent.core.protocol.ConnectionBootstrapContractDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapTurnAuthorizationDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapTurnDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapPublicKeyDto
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Secret material already established by pairing; the signed contract supplies the route. */
data class BootstrapP2PCredentials(
    val secret: String,
)

/**
 * The only route description accepted by [ConnectivitySupervisor]. It is built after the
 * server contract has been authenticated and signature-verified.
 */
data class BootstrapConnectionPlan(
    val bootstrapEndpoint: String,
    val contract: ConnectionBootstrapContractDto,
    val p2pCandidate: P2PCandidate?,
    val turnCarrier: TurnCarrier?,
    val publicKey: ConnectionBootstrapPublicKeyDto? = null,
    val rawContract: String = "",
) {
    val connectionMode: String get() = contract.connectionMode
    val turnConnectionId: String?
        get() = contract.turn?.connectionId ?: contract.turnAuthorization?.connectionId
    val preferredEndpoint: String
        get() = bootstrapEndpoint
}

private val TURN_TCP_TRANSPORT = Regex("(?:[?&])transport=tcp(?:&|$)", RegexOption.IGNORE_CASE)

fun isTcpTurnRelay(url: String): Boolean =
    url.startsWith("turn:", ignoreCase = true) && TURN_TCP_TRANSPORT.containsMatchIn(url)

/** Narrow an already verified carrier to its signed TCP relays for one retry. */
fun preferSignedTcpRelay(plan: BootstrapConnectionPlan): BootstrapConnectionPlan {
    val carrier = plan.turnCarrier ?: return plan
    val servers = carrier.p2pCandidate.iceServers.filter { isTcpTurnRelay(it.url) }
    if (servers.isEmpty()) return plan
    return plan.copy(turnCarrier = carrier.copy(p2pCandidate = carrier.p2pCandidate.copy(iceServers = servers)))
}

object BootstrapConnectionPlanFactory {
    fun create(
        verified: VerifiedBootstrap,
        bootstrapEndpoint: String,
        p2pCredentials: BootstrapP2PCredentials?,
    ): BootstrapConnectionPlan {
        val contract = verified.contract
        val candidates = contract.candidates
        val webrtc = candidates.firstOrNull { it.kind == "webrtc" }
        val roomId = webrtc?.metadata?.stringValue("roomId")
        val p2p = if (webrtc != null && !roomId.isNullOrBlank() && p2pCredentials != null) {
            P2PCandidate(
                signalingUrl = webrtc.endpoint,
                roomId = roomId,
                secret = p2pCredentials.secret,
                iceServers = listOf(IceServer("stun:stun.l.google.com:19302")),
            )
        } else {
            null
        }

        val bootstrapCarrier = contract.initialCarrier
        val turn = if (bootstrapCarrier?.kind == "turn") {
            buildTurnCarrier(bootstrapCarrier, contract.turn, contract.turnAuthorization, p2p)
        } else {
            null
        }

        return BootstrapConnectionPlan(
            bootstrapEndpoint = bootstrapEndpoint.trimEnd('/'),
            contract = contract,
            p2pCandidate = p2p,
            turnCarrier = turn,
            publicKey = verified.publicKey,
            rawContract = verified.rawContract,
        )
    }

    private fun buildTurnCarrier(
        carrier: com.andysagent.ragent.core.protocol.ConnectionBootstrapInitialCarrierDto,
        turn: ConnectionBootstrapTurnDto?,
        authorization: ConnectionBootstrapTurnAuthorizationDto?,
        p2p: P2PCandidate?,
    ): TurnCarrier? {
        turn ?: return null
        p2p ?: return null
        // The signed top-level decision is authoritative. The nested copy is
        // accepted only when it agrees with it, so a stale or mixed response
        // cannot accidentally enable TURN.
        val topLevel = authorization ?: return null
        val nested = turn.authorization
        if (topLevel.policyVersion != "turn-account-quota-v1") return null
        if (topLevel.authorized != true || topLevel.status != "authorized") return null
        if (nested != null && nested.policyVersion != "turn-account-quota-v1") return null
        if (nested != null && (nested.authorized != true || nested.status != "authorized")) return null
        val ids = listOfNotNull(
            topLevel.connectionId,
            turn.connectionId,
            nested?.connectionId,
        ).filter { it.isNotBlank() }.distinct()
        if (ids.size > 1) return null
        if (turn.iceServers.isEmpty() || turn.iceServers.any { server ->
                !server.urls.startsWith("turn:")
                    || server.username.isBlank()
                    || server.password.isBlank()
            }) return null
        val turnCandidate = p2p.copy(
            iceServers = turn.iceServers.map { server ->
                IceServer(server.urls, server.username, server.password)
            },
            turnOnly = true,
        )
        return TurnCarrier(
            endpoint = carrier.endpoint,
            candidateId = carrier.candidateId,
            provider = carrier.provider,
            p2pCandidate = turnCandidate,
            connectionId = ids.singleOrNull(),
        )
    }

    private fun Map<String, kotlinx.serialization.json.JsonElement>.stringValue(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull
}
