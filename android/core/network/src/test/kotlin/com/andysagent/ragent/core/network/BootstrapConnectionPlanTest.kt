package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.protocol.ConnectionBootstrapCandidateDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapContractDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapIceServerDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapInitialCarrierDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapPublicKeyDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapSignatureDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapTurnAuthorizationDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapTurnDto
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame

class BootstrapConnectionPlanTest {
    @Test fun `TCP retry narrows only the verified signed relay set`() {
        val udp = turn().iceServers.single()
        val tcp = udp.copy(urls = "turn:turn.cloudflare.com:50000?transport=tcp")
        val source = contract(turn = turn().copy(iceServers = listOf(udp, tcp)))
        val plan = BootstrapConnectionPlanFactory.create(verified(source), "", BootstrapP2PCredentials("fixture"))
        val alternate = preferSignedTcpRelay(plan)
        assertSame(source, alternate.contract)
        assertEquals(listOf(tcp.urls), alternate.turnCarrier!!.p2pCandidate.iceServers.map { it.url })
        assertEquals(plan.turnCarrier!!.connectionId, alternate.turnCarrier!!.connectionId)
        assertEquals("fixture", alternate.turnCarrier!!.p2pCandidate.secret)
        assertEquals(2, plan.turnCarrier!!.p2pCandidate.iceServers.size)
        val udpOnly = BootstrapConnectionPlanFactory.create(verified(contract(turn())), "", BootstrapP2PCredentials("fixture"))
        assertSame(udpOnly, preferSignedTcpRelay(udpOnly))
        kotlin.test.assertFalse(isTcpTurnRelay("turn:fixture?transport=tcp-extra"))
        kotlin.test.assertFalse(isTcpTurnRelay("stun:fixture?transport=tcp"))
    }

    @Test
    fun `TURN-first plan builds initial TURN carrier with turn-only ICE`() {
        val turn = turn()
        val contract = contract(turn = turn)
        val plan = BootstrapConnectionPlanFactory.create(
            verified = VerifiedBootstrap(contract, ConnectionBootstrapPublicKeyDto("ed25519", "key-1", "pem"), "signed-json"),
            bootstrapEndpoint = "http://192.168.1.10:7690",
            p2pCredentials = BootstrapP2PCredentials("paired-secret"),
        )

        val carrier = assertNotNull(plan.turnCarrier)
        val p2p = assertNotNull(carrier.p2pCandidate)
        assertEquals("turn-first", plan.connectionMode)
        assertEquals(true, p2p.turnOnly)
        assertEquals("123:app", p2p.iceServers.single().username)
        assertEquals("signed-password", p2p.iceServers.single().password)
        assertEquals("turn-connection-1", plan.turnConnectionId)
        assertEquals(plan.turnConnectionId, carrier.connectionId)
        assertEquals("http://192.168.1.10:7690", plan.preferredEndpoint)
        assertEquals("key-1", plan.publicKey?.keyId, "A replacement plan must use the originally verified key")
        assertEquals("signed-json", plan.rawContract, "Sending a verified contract must preserve its signed JSON")
    }

    @Test
    fun `TURN carrier is rejected without authorized account decision`() {
        val turn = turn()
        listOf("quota-exceeded", "account-mismatch", "broker-unavailable").forEach { status ->
            val denied = turn.copy(authorization = authorization("turn-connection-1", status, false))
            val plan = BootstrapConnectionPlanFactory.create(
                verified = VerifiedBootstrap(
                    contract(turn = denied, authorization = authorization("turn-connection-1", status, false)),
                    ConnectionBootstrapPublicKeyDto("ed25519", "key-1", "pem"),
                ),
                bootstrapEndpoint = "http://192.168.1.10:7690",
                p2pCredentials = BootstrapP2PCredentials("paired-secret"),
            )
            assertNull(plan.turnCarrier, status)
        }
    }

    @Test
    fun `TURN carrier is rejected when connection identities conflict`() {
        val conflicting = turn(connectionId = "turn-connection-2")
        val plan = BootstrapConnectionPlanFactory.create(
            verified = VerifiedBootstrap(
                contract(turn = conflicting, authorization = authorization("turn-connection-1")),
                ConnectionBootstrapPublicKeyDto("ed25519", "key-1", "pem"),
            ),
            bootstrapEndpoint = "http://192.168.1.10:7690",
            p2pCredentials = BootstrapP2PCredentials("paired-secret"),
        )
        assertNull(plan.turnCarrier)
    }

    private fun verified(contract: ConnectionBootstrapContractDto) = VerifiedBootstrap(
        contract,
        ConnectionBootstrapPublicKeyDto("ed25519", "key-1", "pem"),
    )

    private fun contract(
        turn: ConnectionBootstrapTurnDto,
        authorization: ConnectionBootstrapTurnAuthorizationDto = authorization("turn-connection-1"),
    ) = ConnectionBootstrapContractDto(
        contractVersion = 2,
        instanceId = "instance-1",
        deviceId = "device-1",
        enrollmentKind = "account-join",
        connectionMode = "turn-first",
        issuedAt = "2098-01-01T00:00:00.000Z",
        expiresAt = "2099-01-01T00:00:00.000Z",
        candidates = listOf(
            ConnectionBootstrapCandidateDto(
                id = "turn-candidate",
                kind = "turn",
                provider = "cloudflare-realtime",
                endpoint = turn.endpoint,
                priority = 120,
                expiresAt = turn.expiresAt,
                requiresUserConsent = false,
                metadata = JsonObject(emptyMap()),
            ),
            ConnectionBootstrapCandidateDto(
                id = "webrtc-candidate",
                kind = "webrtc",
                provider = "core_p2p",
                endpoint = "https://signal.example.com",
                priority = 60,
                expiresAt = "2099-01-01T00:00:00.000Z",
                requiresUserConsent = false,
                metadata = JsonObject(mapOf("roomId" to JsonPrimitive("room-1"))),
            ),
        ),
        turn = turn,
        turnAuthorization = authorization,
        initialCarrier = ConnectionBootstrapInitialCarrierDto(
            candidateId = "turn-candidate",
            kind = "turn",
            provider = "cloudflare-realtime",
            endpoint = turn.endpoint,
        ),
        upgrade = null,
        fallback = null,
        signature = ConnectionBootstrapSignatureDto("ed25519", "key-1", "2098-01-01T00:00:00.000Z", "signature"),
    )

    private fun turn(
        connectionId: String = "turn-connection-1",
        authorization: ConnectionBootstrapTurnAuthorizationDto? = authorization(connectionId),
    ) = ConnectionBootstrapTurnDto(
        provider = "cloudflare-realtime",
        endpoint = "turn:turn.cloudflare.com:50000?transport=udp",
        iceServers = listOf(ConnectionBootstrapIceServerDto(
            urls = "turn:turn.cloudflare.com:50000?transport=udp",
            username = "123:app",
            password = "signed-password",
        )),
        expiresAt = "2099-01-01T00:00:00.000Z",
        transport = "turn",
        appTrafficOnly = true,
        credentialScope = "device-access",
        source = "turn-broker",
        connectionId = connectionId,
        authorization = authorization,
    )

    private fun authorization(
        connectionId: String,
        status: String = "authorized",
        authorized: Boolean = true,
    ) = ConnectionBootstrapTurnAuthorizationDto(
        policyVersion = "turn-account-quota-v1",
        authorized = authorized,
        status = status,
        reasonCode = if (authorized) "turn_authorized" else "turn_not_authorized",
        plan = "free",
        maxDevices = 1,
        activeDeviceCount = if (authorized) 1 else 1,
        connectionId = connectionId,
    )
}
