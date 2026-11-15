package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.p2p.P2PHttpRequest
import com.andysagent.ragent.core.p2p.P2PHttpResponse
import com.andysagent.ragent.core.p2p.P2PSession
import com.andysagent.ragent.core.p2p.P2PSessionFactory
import com.andysagent.ragent.core.protocol.TemporaryControlProtocol
import com.andysagent.ragent.core.protocol.TemporaryIceServer
import com.andysagent.ragent.core.protocol.VerifiedTemporaryConnection
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TemporaryControlTransportRecoveryTest {
    private class Session : P2PSession {
        override var isOpen = false
        private var listener: ((String) -> Unit)? = null
        override fun setUnexpectedCloseListener(listener: ((String) -> Unit)?) { this.listener = listener }
        override suspend fun connect(): Result<Unit> { isOpen = true; return Result.success(Unit) }
        override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> =
            error("Recovery must not replay a business request")
        override fun close() { isOpen = false }
        fun lose() { isOpen = false; listener?.invoke("network-lost") }
    }

    private class Fixture(scope: CoroutineScope, validate: suspend () -> Unit = {}) {
        var now = 1_000_000L
        val deadline = now + 600_000
        var recoveries = 0
        val sessions = mutableListOf<Session>()
        val delivery = VerifiedTemporaryConnection("inst_${"a".repeat(32)}", "rdev_${"b".repeat(32)}",
            "rtr_${"c".repeat(32)}", deadline, true, "room", "d".repeat(64),
            "https://signal.example.test/", listOf(TemporaryIceServer("turn:turn.example.test:3478", "u", "p")), "signed")
        private val grant = TemporaryControlProtocol.VerifiedGrant("rtg_${"e".repeat(32)}", delivery.deviceId,
            "original-token", deadline, now)
        private val identity = object : DeviceIdentityStore {
            override fun publicKeyEncoded(): String = error("Recovery must not replace the device key")
            override fun sign(message: String): String = error("Recovery must not issue new authority")
            override fun clear() = error("Recovery must not clear the device key")
        }
        lateinit var transport: TemporaryControlTransport
        val connector = TemporaryCarrierConnector(P2PSessionFactory { Session().also(sessions::add) }, scope,
            { now }, onRecoveryRequired = { _, _ -> transport.carrierLost() })

        init {
            transport = TemporaryControlTransport(connector, delivery, grant, identity, scope, { now }, recover = {
                recoveries++
                validate()
                connector.connect(delivery)
            })
        }
        suspend fun connect() { connector.connect(delivery) }
    }

    @Test fun `temporary loss retains the workbench state and reopens only the original carrier`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val f = Fixture(this) { gate.await() }
        try {
            f.connect(); f.sessions.single().lose(); yield()
            assertEquals(RuntimeConnectionState.Reconnecting, f.transport.connectionState.value)
            f.transport.carrierLost(); assertEquals(1, f.recoveries)
            gate.complete(Unit)
            withTimeout(1_000) { f.transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            assertEquals(2, f.sessions.size)
            assertTrue(f.connector.session(f.delivery)?.isOpen == true)
            assertEquals(1, f.recoveries)
        } finally { f.transport.close() }
    }

    @Test fun `revoked grant ends control without reconnecting or retrying business writes`() = runBlocking {
        val f = Fixture(this) { throw ApiException(410, "temporary_control_inactive", "revoked", retryable = false) }
        try {
            f.connect(); f.sessions.single().lose(); yield()
            assertEquals(RuntimeConnectionState.Disconnected, f.transport.connectionState.value)
            assertEquals(1, f.recoveries); assertEquals(1, f.sessions.size)
            f.transport.carrierLost(); assertEquals(1, f.recoveries)
        } finally { f.transport.close() }
    }

    @Test fun `closing during recovery cannot republish a connected temporary session`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val f = Fixture(this) { gate.await() }
        f.connect(); f.sessions.single().lose(); yield()
        assertEquals(RuntimeConnectionState.Reconnecting, f.transport.connectionState.value)
        f.transport.close(); gate.complete(Unit); yield()
        assertEquals(RuntimeConnectionState.Disconnected, f.transport.connectionState.value)
        assertEquals(1, f.sessions.size)
    }

    @Test fun `late recovery never extends the original ten minute deadline`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val f = Fixture(this) { withContext(NonCancellable) { gate.await() } }
        try {
            f.connect(); f.sessions.single().lose(); yield()
            f.now = f.deadline
            gate.complete(Unit)
            withTimeout(1_000) { f.transport.connectionState.first { it == RuntimeConnectionState.Disconnected } }
            assertEquals(1, f.sessions.size)
            try { f.transport.execute(ApiRequest("GET", "/api/projects")); error("Expired control accepted a request") }
            catch (error: ApiException) { assertEquals(410, error.statusCode) }
            f.transport.carrierLost(); assertEquals(1, f.recoveries)
        } finally { f.transport.close() }
    }

    @Test fun `temporary validation failure retries recovery without changing the deadline`() = runBlocking {
        var validations = 0
        val f = Fixture(this) {
            if (++validations == 1) throw ApiException(0, "network", "offline", retryable = true)
        }
        try {
            f.connect(); f.sessions.single().lose(); yield()
            assertEquals(RuntimeConnectionState.Reconnecting, f.transport.connectionState.value)
            withTimeout(3_000) { f.transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            assertEquals(2, validations); assertEquals(2, f.sessions.size)
            f.now = f.deadline
            f.transport.carrierLost()
            assertEquals(RuntimeConnectionState.Disconnected, f.transport.connectionState.value)
        } finally { f.transport.close() }
    }

    @Test fun `a late callback from a closed transport cannot stop a replacement carrier`() = runBlocking {
        val f = Fixture(this)
        f.connect(); f.transport.close()
        try {
            f.connector.connect(f.delivery)
            f.transport.carrierLost(); f.transport.close()
            assertTrue(f.connector.session(f.delivery)?.isOpen == true)
            assertEquals(0, f.recoveries)
        } finally { f.connector.stop() }
    }
}
