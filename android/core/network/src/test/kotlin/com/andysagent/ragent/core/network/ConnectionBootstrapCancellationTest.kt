package com.andysagent.ragent.core.network

import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import java.util.concurrent.TimeUnit
import kotlin.test.*

class ConnectionBootstrapCancellationTest {
    @Test fun oneBootstrapFetchUsesOneCredentialAcrossBothHttpRequests() = runBlocking {
        var token = "rda_old"
        val server = MockWebServer()
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                if (request.path?.endsWith("/public-key") == true) {
                    token = "rda_new"
                    return MockResponse().setBody("""{"algorithm":"ed25519","keyId":"fixture","publicKeyPem":"fixture"}""")
                }
                return MockResponse().setResponseCode(401)
            }
        }
        server.start()
        try {
            val client = ConnectionBootstrapClient({ server.url("/").toString().trimEnd('/') }, { token })
            assertEquals("BOOTSTRAP_HTTP_401", assertFailsWith<BootstrapException> { client.fetch() }.code)
            assertEquals(2, server.requestCount)
            assertEquals("Bearer rda_old", server.takeRequest()?.getHeader("Authorization"))
            assertEquals("Bearer rda_old", server.takeRequest()?.getHeader("Authorization"))
        } finally { server.shutdown() }
    }
    @Test fun cancelledBootstrapControlRequestCancelsTheActualHttpCall() = runBlocking {
        val server = MockWebServer(); server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)); server.start()
        val client = OkHttpClient()
        try {
            val bootstrap = ConnectionBootstrapClient({ server.url("/").toString().trimEnd('/') }, { "rda_test" }, client)
            val job = launch(Dispatchers.Default) { bootstrap.releaseTurn("lease-test", "teardown") }
            assertNotNull(withContext(Dispatchers.IO) { server.takeRequest(3, TimeUnit.SECONDS) })
            withTimeout(3_000) { job.cancelAndJoin() }
            assertTrue(job.isCancelled)
            withTimeout(3_000) { while (client.dispatcher.runningCallsCount() != 0) delay(10) }
        } finally { client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll(); server.shutdown() }
    }

    @Test fun bootstrapHttpFailureRetainsItsStructuredError() = runBlocking {
        val server = MockWebServer(); server.enqueue(MockResponse().setResponseCode(503)); server.start()
        try {
            val bootstrap = ConnectionBootstrapClient({ server.url("/").toString().trimEnd('/') }, { null })
            val error = assertFailsWith<BootstrapException> { bootstrap.releaseTurn("lease-test") }
            assertEquals("BOOTSTRAP_HTTP_503", error.code)
        } finally { server.shutdown() }
    }
}
