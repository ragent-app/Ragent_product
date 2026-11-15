package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.BootstrapConnectionPlan
import com.andysagent.ragent.core.network.ConnectivitySupervisor
import com.andysagent.ragent.core.network.TurnCarrier
import com.andysagent.ragent.core.network.isTcpTurnRelay
import com.andysagent.ragent.core.p2p.P2PSession
import com.andysagent.ragent.core.p2p.WebRTCDataChannelTransport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.webrtc.PeerConnection
import org.webrtc.RTCStatsReport

/** Opt-in read-only stats from the existing carrier; never logs addresses or credentials. */
class CarrierNetworkStatsLiveTest {
    @Test fun iceFailureRetriesWithSignedTcpRelay(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveTcpAfterIce") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val directory = runtime.configStore.directory.first()
            val target = directory.computers.single { it.autoConnect && it.instanceId != directory.activeTarget?.instanceId }.instanceId
            withTimeout(120_000) { runtime.targetConnectionStates.first { it[target] == RuntimeConnectionState.Connected } }
            val runtimes = runtime.javaClass.getDeclaredField("targetRuntimes").apply { isAccessible = true }.get(runtime) as Map<*, *>
            val controller = (runtimes[target] as TargetRuntime).controller
            val supervisor = controller.javaClass.getDeclaredField("supervisor").apply { isAccessible = true }.get(controller)
            val carrierField = supervisor.javaClass.getDeclaredField("turnSession").apply { isAccessible = true }
            repeat(2) { attempt ->
                val previousSession = requireNotNull(carrierField.get(supervisor) as? P2PSession)
                val previousCarrier = previousSession.javaClass.getDeclaredField("carrier").apply { isAccessible = true }
                    .get(previousSession) as TurnCarrier
                val wasTcpOnly = previousCarrier.p2pCandidate.iceServers.all { isTcpTurnRelay(it.url) }
                val old = unwrap(previousSession)
                val observer = old.javaClass.getDeclaredField("peerObserver").apply { isAccessible = true }.get(old) as PeerConnection.Observer
                observer.onIceConnectionChange(PeerConnection.IceConnectionState.FAILED)
                withTimeout(30_000) { runtime.targetConnectionStates.first { it[target] != RuntimeConnectionState.Connected } }
                withTimeout(150_000) { runtime.targetConnectionStates.first { it[target] == RuntimeConnectionState.Connected } }
                val session = requireNotNull(carrierField.get(supervisor) as? P2PSession)
                val selectedCarrier = session.javaClass.getDeclaredField("carrier").apply { isAccessible = true }.get(session) as TurnCarrier
                val plan = requireNotNull(controller.javaClass.getDeclaredField("plan").apply { isAccessible = true }.get(controller) as? BootstrapConnectionPlan)
                val signed = plan.contract.turn!!.iceServers.map { it.urls }.toSet()
                val selected = selectedCarrier.p2pCandidate.iceServers.map { it.url }.toSet()
                val tcp = signed.filter { isTcpTurnRelay(it) }.toSet()
                assertTrue("Fixture requires both signed TCP and non-TCP relays", tcp.isNotEmpty() && signed != tcp)
                assertEquals(if (wasTcpOnly) signed else tcp, selected)
                val current = unwrap(session)
                val peer = current.javaClass.getDeclaredField("peerConnection").apply { isAccessible = true }.get(current) as PeerConnection
                val route = stats(peer)
                instrumentation.sendStatus(2, Bundle().apply { putString("iceRetryRoute$attempt", route) })
                if (!wasTcpOnly) assertTrue("TCP-only retry must select a TCP relay", route.contains("local-relayProtocol=tcp"))
                assertEquals(200, withTimeout(20_000) { runtime.executeOnTarget(target, ApiRequest("GET", "/api/projects")) }.statusCode)
            }
        }
    }

    @Test fun signedTcpRelayCanReconnectBackgroundTarget(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveTcpRelay") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val directory = runtime.configStore.directory.first()
            val target = directory.computers.single { it.autoConnect && it.instanceId != directory.activeTarget?.instanceId }.instanceId
            withTimeout(120_000) { runtime.targetConnectionStates.first { it[target] == RuntimeConnectionState.Connected } }
            val runtimes = runtime.javaClass.getDeclaredField("targetRuntimes").apply { isAccessible = true }.get(runtime) as Map<*, *>
            val controller = (runtimes[target] as TargetRuntime).controller
            val supervisor = controller.javaClass.getDeclaredField("supervisor").apply { isAccessible = true }.get(controller) as ConnectivitySupervisor
            val factoryField = supervisor.javaClass.getDeclaredField("turnSessionFactory").apply { isAccessible = true }
            @Suppress("UNCHECKED_CAST")
            val original = factoryField.get(supervisor) as suspend (TurnCarrier) -> P2PSession
            val tcpFactory: suspend (TurnCarrier) -> P2PSession = { carrier ->
                val servers = carrier.p2pCandidate.iceServers.filter { it.url.startsWith("turn:") && it.url.contains("transport=tcp") }
                check(servers.isNotEmpty()) { "Signed plan has no TCP relay" }
                original(carrier.copy(p2pCandidate = carrier.p2pCandidate.copy(iceServers = servers)))
            }
            val carrierField = supervisor.javaClass.getDeclaredField("turnSession").apply { isAccessible = true }
            fun disconnectCurrent() {
                (carrierField.get(supervisor) as? P2PSession)?.let(supervisor::carrierRequestFailed)
            }
            try {
                factoryField.set(supervisor, tcpFactory)
                disconnectCurrent()
                withTimeout(30_000) { runtime.targetConnectionStates.first { it[target] != RuntimeConnectionState.Connected } }
                withTimeout(150_000) { runtime.targetConnectionStates.first { it[target] == RuntimeConnectionState.Connected } }
                val carrier = requireNotNull(carrierField.get(supervisor) as? P2PSession)
                val transport = unwrap(carrier)
                val peer = transport.javaClass.getDeclaredField("peerConnection").apply { isAccessible = true }.get(transport) as PeerConnection
                val route = stats(peer)
                instrumentation.sendStatus(2, Bundle().apply { putString("tcpRelayRoute", route) })
                assertTrue("Expected signed TCP relay", route.contains("local-relayProtocol=tcp"))
                val primary = requireNotNull(directory.activeTarget).instanceId
                val started = SystemClock.elapsedRealtime()
                repeat(5) { index ->
                    assertEquals(200, withTimeout(20_000) { runtime.executeOnTarget(target, ApiRequest("GET", "/api/projects")) }.statusCode)
                    assertEquals(200, withTimeout(20_000) { runtime.executeOnTarget(primary, ApiRequest("GET", "/api/projects")) }.statusCode)
                    assertEquals(RuntimeConnectionState.Connected, runtime.targetConnectionStates.value[primary])
                    if (index < 4) delay(8_000)
                }
                instrumentation.sendStatus(2, Bundle().apply { putLong("tcpObservationMs", SystemClock.elapsedRealtime() - started) })
            } finally {
                factoryField.set(supervisor, original)
                disconnectCurrent()
            }
        }
    }

    @Test fun pairedTargetsUseDistinctRoomAndReservation(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveCarrierIsolation") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val targets = runtime.configStore.directory.first().computers.filter { it.autoConnect }.map { it.instanceId }
            assertEquals(2, targets.size)
            withTimeout(120_000) { runtime.targetConnectionStates.first { states ->
                targets.all { states[it] == RuntimeConnectionState.Connected }
            } }
            val runtimes = runtime.javaClass.getDeclaredField("targetRuntimes").apply { isAccessible = true }.get(runtime) as Map<*, *>
            val plans = targets.map { target ->
                val controller = (runtimes[target] as TargetRuntime).controller
                requireNotNull(controller.javaClass.getDeclaredField("plan").apply { isAccessible = true }
                    .get(controller) as? BootstrapConnectionPlan)
            }
            val rooms = plans.map { requireNotNull(it.turnCarrier?.p2pCandidate?.roomId).also { id -> require(id.isNotBlank()) } }
            val reservations = plans.map { requireNotNull(it.turnCarrier?.connectionId).also { id -> require(id.isNotBlank()) } }
            instrumentation.sendStatus(2, Bundle().apply {
                putBoolean("distinctRooms", rooms.distinct().size == 2)
                putBoolean("distinctReservations", reservations.distinct().size == 2)
            })
            assertTrue("Targets must not share a signal room", rooms.distinct().size == 2)
            assertTrue("Targets must not share a reservation", reservations.distinct().size == 2)
        }
    }

    private fun unwrap(session: P2PSession): WebRTCDataChannelTransport {
        var current: P2PSession = session
        repeat(4) {
            if (current is WebRTCDataChannelTransport) return current as WebRTCDataChannelTransport
            current = current.javaClass.declaredFields.asSequence().mapNotNull { field ->
                if (!P2PSession::class.java.isAssignableFrom(field.type)) null
                else { field.isAccessible = true; field.get(current) as? P2PSession }
            }.firstOrNull() ?: error("Carrier delegate unavailable")
        }
        error("Carrier delegate depth exceeded")
    }

    private suspend fun stats(peer: PeerConnection): String {
        val answer = CompletableDeferred<RTCStatsReport>()
        peer.getStats { answer.complete(it) }
        val report = withTimeoutOrNull(3_000) { answer.await() } ?: return "unavailable"
        val all = report.statsMap.values
        val pairId = all.firstOrNull { it.type == "transport" }?.members?.get("selectedCandidatePairId") as? String
        val pair = all.firstOrNull { it.type == "candidate-pair" && it.id == pairId }
            ?: return "selected_pair_unavailable"
        val route = listOf("localCandidateId" to "local", "remoteCandidateId" to "remote").flatMap { (idField, label) ->
            val id = pair.members[idField] as? String
            val candidate = all.firstOrNull { it.id == id }
            listOf("candidateType", "protocol", "relayProtocol").mapNotNull { key ->
                val value = candidate?.members?.get(key) as? String
                if (value in setOf("host", "srflx", "prflx", "relay", "udp", "tcp", "tls"))
                    "$label-$key=$value" else null
            }
        }
        val fields = listOf("state", "currentRoundTripTime", "availableOutgoingBitrate", "packetsSent",
            "packetsReceived", "bytesSent", "bytesReceived", "requestsSent", "responsesReceived")
        return (route + fields.mapNotNull { key ->
            val value = pair.members[key]
            if (value is Number || (key == "state" && value is String && value in setOf("succeeded", "failed", "in-progress", "waiting", "frozen")))
                "$key=$value" else null
        }).joinToString(",")
    }

    @Test fun observesCarrierStatsDuringProtectedReads() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveCarrierStats") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val target = requireNotNull(runtime.configStore.directory.first().activeTarget).instanceId
            withTimeout(120_000) { runtime.targetConnectionStates.first { it[target] == RuntimeConnectionState.Connected } }
            val runtimes = runtime.javaClass.getDeclaredField("targetRuntimes").apply { isAccessible = true }.get(runtime) as Map<*, *>
            val controller = (runtimes[target] as TargetRuntime).controller
            val plan = controller.javaClass.getDeclaredField("plan").apply { isAccessible = true }.get(controller) as? BootstrapConnectionPlan
            val offered = plan?.contract?.turn?.iceServers.orEmpty().map { server ->
                when {
                    server.urls.startsWith("turns:") -> "tls"
                    server.urls.startsWith("turn:") && server.urls.contains("transport=tcp") -> "tcp"
                    server.urls.startsWith("turn:") && server.urls.contains("transport=udp") -> "udp"
                    server.urls.startsWith("turn:") -> "turn-unspecified"
                    else -> "other"
                }
            }.distinct().sorted()
            instrumentation.sendStatus(2, Bundle().apply { putString("offeredTurnTransports", offered.joinToString(",")) })
            val supervisor = controller.javaClass.getDeclaredField("supervisor").apply { isAccessible = true }.get(controller)
            val carrier = supervisor.javaClass.getDeclaredField("turnSession").apply { isAccessible = true }.get(supervisor) as P2PSession
            val transport = unwrap(carrier)
            val peer = transport.javaClass.getDeclaredField("peerConnection").apply { isAccessible = true }.get(transport) as PeerConnection
            repeat(5) { index ->
                val before = stats(peer)
                val started = SystemClock.elapsedRealtime()
                val result = runCatching { withTimeout(20_000) { runtime.executeOnTarget(target, ApiRequest("GET", "/api/projects")) } }
                val elapsed = SystemClock.elapsedRealtime() - started
                val after = stats(peer)
                instrumentation.sendStatus(2, Bundle().apply {
                    putInt("readIndex", index)
                    putLong("readElapsedMs", elapsed)
                    putString("readResult", result.fold({ it.statusCode.toString() }, { it.javaClass.simpleName }))
                    putString("carrierBefore", before)
                    putString("carrierAfter", after)
                })
                result.getOrThrow().let { assertEquals(200, it.statusCode) }
                if (index < 4) delay(1_000)
            }
        }
    }
}
