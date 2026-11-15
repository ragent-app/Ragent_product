package com.andysagent.ragent.feature.workbench

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.CredentialRejectionHandler
import com.andysagent.ragent.core.network.OkHttpRagentTransport
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StaleCredentialDeviceTest {
    @Test fun lateUnauthorizedResponseDoesNotDiscardRenewedCredential() = runBlocking {
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val responder = thread(name = "ragent-auth-fixture") {
            server.accept().use { socket ->
                val reader = socket.getInputStream().bufferedReader()
                while (!reader.readLine().isNullOrEmpty()) { /* Consume request headers. */ }
                val body = "{\"error\":\"expired\",\"code\":\"AUTH_EXPIRED\"}"
                socket.getOutputStream().write(("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n" + body).toByteArray())
            }
        }
        var credential = "old-token"
        var prompted = false
        val transport = OkHttpRagentTransport(
            endpointProvider = { "http://127.0.0.1:${server.localPort}" },
            credentialProvider = { credential },
            onAuthenticationRequired = { prompted = true },
            credentialRejectionHandler = CredentialRejectionHandler { _, _, _ -> credential = "new-token" },
        )
        try {
            transport.updateCarrierConnectionState(RuntimeConnectionState.Connected)
            val failure = runCatching { transport.execute(ApiRequest("GET", "/api/test")) }.exceptionOrNull() as ApiException
            assertEquals("CARRIER_UNAVAILABLE", failure.code)
            assertTrue(failure.retryable)
            assertEquals("new-token", credential)
            assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
            assertFalse(prompted)
        } finally {
            transport.close()
            server.close()
            responder.join(2_000)
        }
    }
}
