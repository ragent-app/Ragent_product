package com.andysagent.ragent.core.network

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import kotlin.test.*

class ContentReportTransportTest {
    @Test fun shippedFactoryRejectsCleartextAndCredentialOrQueryEndpoints() {
        for (endpoint in listOf("http://example.com/accounts", "https://user:secret@example.com/accounts",
            "https://example.com/accounts?token=secret", "https://example.com/accounts#secret")) {
            assertFails { contentReportTransport(endpoint) }
        }
    }

    @Test fun serviceUnavailableRetryAfterZeroCannotRepostOneShotBody() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(503).setHeader("Retry-After", "0").setBody("{}"))
        server.enqueue(MockResponse().setBody("unexpected replay")); server.start()
        // Test-only loopback endpoint; shipped factory above requires HTTPS.
        val transport = OkHttpRagentTransport({ server.url("/accounts").toString() }, { null }, contentReportHttpClient())
        try {
            assertEquals(503, assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/v1/content-reports", "{}")) }.statusCode)
            assertEquals(1, server.requestCount)
            val received = server.takeRequest()
            assertEquals("/accounts/v1/content-reports", received.path)
            assertNull(received.getHeader("Authorization"))
        } finally { transport.close(); server.shutdown() }
    }

    @Test fun lostReplyCannotReplayBodyInsideHttpClient() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(MockResponse().setBody("unexpected replay")); server.start()
        val transport = OkHttpRagentTransport({ server.url("/accounts").toString() }, { null }, contentReportHttpClient())
        try {
            assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/v1/content-reports", "{}")) }
            assertEquals(1, server.requestCount)
        } finally { transport.close(); server.shutdown() }
    }
}
