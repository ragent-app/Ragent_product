package com.andysagent.agentoc.core.network

import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.p2p.P2PHttpRequest
import com.andysagent.agentoc.core.p2p.P2PHttpResponse
import com.andysagent.agentoc.core.p2p.P2PRequestTimeoutException
import com.andysagent.agentoc.core.p2p.P2PSession
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.ResponseBody
import okhttp3.MediaType.Companion.toMediaType
import okio.Buffer
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OkHttpAgentoCTransportTest {
    @Test fun directUploadStreamsAndVerifiesAReopenableBody() = runBlocking {
        val server = MockWebServer().apply {
            enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("{\"ok\":true}"))
            start()
        }
        val content = ByteArray(2 * 1024 * 1024 + 73) { (it % 251).toByte() }
        val digest = MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { "%02x".format(it) }
        var opens = 0
        val transport = OkHttpAgentoCTransport({ server.url("/").toString().trimEnd('/') }, { null })
        try {
            val response = transport.execute(ApiRequest("PUT", server.url("/upload").toString(),
                contentType = "application/octet-stream",
                bodySource = ApiRequestBodySource(content.size.toLong(), digest) { opens++; ByteArrayInputStream(content) }))
            assertEquals("{\"ok\":true}", response.body)
            assertEquals(1, opens)
            val request = server.takeRequest(5, java.util.concurrent.TimeUnit.SECONDS)!!
            assertEquals("PUT", request.method)
            assertTrue(request.body.readByteArray().contentEquals(content))
        } finally { transport.close(); server.shutdown() }
    }

    @Test fun directHttpResponseRejectsDeclaredBodiesBeyondTheBound() {
        val body = object : ResponseBody() {
            private val content = Buffer().writeUtf8("{}")
            override fun contentType() = "application/json".toMediaType()
            override fun contentLength() = OkHttpAgentoCTransport.MAX_HTTP_RESPONSE_BYTES + 1
            override fun source() = content
        }
        assertFailsWith<java.io.IOException> { readBoundedHttpResponse(200, emptyMap(), body) }
    }

    @Test fun approvalTimeoutDoesNotTearDownAnOpenCarrierOrReplayTheDecision() = runBlocking {
        for (turn in listOf(true)) {
            var calls = 0
            var recoveries = 0
            val peer = object : P2PSession {
                override val isOpen = true
                override suspend fun connect() = Result.success(Unit)
                override fun close() = Unit
                override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                    calls++
                    return if (calls == 1) Result.failure(P2PRequestTimeoutException())
                    else Result.success(P2PHttpResponse(id = request.id, status = 200))
                }
            }
            val transport = OkHttpAgentoCTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true,
                onCarrierUnavailable = { recoveries++ })
            try {
                if (turn) transport.setTurnSession(peer) else transport.setP2PSession(peer)
                transport.updateCarrierConnectionState(RuntimeConnectionState.Connected)
                assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/api/runs/run/approvals/approval", "{}")) }
                assertEquals(1, calls)
                assertEquals(0, recoveries)
                assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
                assertEquals(200, transport.execute(ApiRequest("GET", "/api/auth/me")).statusCode)
            } finally { transport.close() }
        }
    }

    @Test fun carrierHandoffDrainsInFlightRequestsWithoutReplayingWrites() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        var oldCalls = 0
        var oldCloses = 0
        val old = object : P2PSession {
            override val isOpen get() = oldCloses == 0
            override suspend fun connect() = Result.success(Unit)
            override fun close() { oldCloses++ }
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                oldCalls++
                entered.complete(Unit)
                finish.await()
                return Result.success(P2PHttpResponse(id = request.id, status = 200))
            }
        }
        val replacement = RecordingP2PSession()
        val transport = OkHttpAgentoCTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true)
        try {
            transport.setTurnSession(old)
            val writing = async(Dispatchers.Default) { transport.execute(ApiRequest("POST", "/api/sessions", "{}")) }
            withTimeout(5_000) { entered.await() }
            transport.handoffTurnSession(replacement)
            assertEquals(0, oldCloses)
            assertEquals(200, transport.execute(ApiRequest("GET", "/api/projects")).statusCode)
            assertEquals("/api/projects", replacement.request!!.path)
            finish.complete(Unit)
            assertEquals(200, writing.await().statusCode)
            assertEquals(1, oldCalls, "handoff must not replay an in-flight write")
            assertEquals(1, oldCloses)
        } finally { finish.complete(Unit); transport.close() }
        Unit
    }

    @Test fun carrierFailureDiagnosticsUseOnlyKnownCategories() {
        assertEquals("transport_closed", carrierFailureCategory(Exception("P2P transport closed")))
        assertEquals("request_timeout", carrierFailureCategory(Exception("P2P request timed out")))
        assertEquals("channel_unavailable", carrierFailureCategory(Exception("DataChannel is not open")))
        assertEquals("invalid_response_stream", carrierFailureCategory(Exception("Invalid P2P response stream")))
        assertEquals("other", carrierFailureCategory(Exception("private request content")))
    }

    @Test fun remoteErrorDoesNotDisconnectEitherCarrierOrReplayTheRequest() = runBlocking {
        for (turn in listOf(true, false)) {
            var calls = 0
            var recoveries = 0
            val peer = object : P2PSession {
                override val isOpen = true
                override suspend fun connect() = Result.success(Unit)
                override fun close() = Unit
                override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                    calls++
                    return Result.success(if (calls == 1) P2PHttpResponse(id = request.id, status = 0, error = "remote failure")
                    else P2PHttpResponse(id = request.id, status = 200))
                }
            }
            val transport = OkHttpAgentoCTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true,
                onCarrierUnavailable = { recoveries++ })
            try {
                if (turn) transport.setTurnSession(peer) else transport.setP2PSession(peer)
                transport.updateCarrierConnectionState(RuntimeConnectionState.Connected)
                val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/api/sessions", "{}")) }
                assertEquals(if (turn) "TURN_REMOTE_ERROR" else "P2P_REMOTE_ERROR", error.code)
                assertEquals(1, calls)
                assertEquals(0, recoveries)
                assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
                assertEquals(200, transport.execute(ApiRequest("GET", "/api/projects")).statusCode)
                assertEquals(2, calls)
            } finally { transport.close() }
        }
    }

    @Test fun missingCarrierRequestsRecoveryOnceWithoutReplayingBusinessWrites() = runBlocking {
        var signals = 0
        val transport = OkHttpAgentoCTransport({ "https://unused.invalid" }, { "rda_fixture" },
            requireVerifiedCarrier = true, onCarrierUnavailable = { signals++ })
        try {
            repeat(2) {
                val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/api/sessions/s/messages", "{}", "android:original", "android:original")) }
                assertEquals("CARRIER_UNAVAILABLE", error.code)
            }
            assertEquals(1, signals)
            assertEquals(RuntimeConnectionState.Reconnecting, transport.connectionState.value)
            val replacement = RecordingP2PSession()
            transport.setTurnSession(replacement)
            assertEquals(200, transport.execute(ApiRequest("GET", "/api/sessions")).statusCode)
            transport.clearTurnSession(replacement)
            assertFailsWith<ApiException> { transport.execute(ApiRequest("GET", "/api/sessions")) }
            assertEquals(2, signals)
        } finally { transport.close() }
    }

    @Test fun failedCarrierExchangeIsReportedToItsOwnerWithoutReplayingTheWrite() = runBlocking {
        var sends = 0; var signals = 0
        val peer = object : P2PSession {
            override val isOpen = true
            override suspend fun connect() = Result.success(Unit)
            override fun close() = Unit
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                sends++; return Result.failure(java.io.IOException("connection lost"))
            }
        }
        val transport = OkHttpAgentoCTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true,
            onCarrierUnavailable = { failed -> assertTrue(failed === peer); signals++ })
        try {
            transport.setTurnSession(peer)
            assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/api/sessions/s/messages", "{}")) }
            assertEquals(1, sends); assertEquals(1, signals)
            assertEquals(RuntimeConnectionState.Reconnecting, transport.connectionState.value)
        } finally { transport.close() }
    }

    @Test fun colonDelimitedBusinessIdentityIsPreservedOutsideFreshCarrierIds() = runBlocking {
        for (turn in listOf(true, false)) {
            val calls = java.util.Collections.synchronizedList(mutableListOf<P2PHttpRequest>())
            val peer = object : P2PSession {
                override val isOpen = true
                override suspend fun connect() = Result.success(Unit)
                override fun close() = Unit
                override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                    calls += request
                    // The peer's bounded chunk-frame contract forbids ':' in wire IDs.
                    require(request.id.matches(Regex("^[A-Za-z0-9_-]{1,128}$")))
                    return Result.success(P2PHttpResponse(id = request.id, status = 200,
                        bodyBase64 = com.andysagent.agentoc.core.p2p.P2PProtocol.encodeBody("{}")))
                }
            }
            val transport = OkHttpAgentoCTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true)
            val businessId = "android:3d4df183-cb29-400f-961c-f61811cf571a"
            val body = """{"text":"hello","requestId":"$businessId"}"""
            try {
                if (turn) transport.setTurnSession(peer) else transport.setP2PSession(peer)
                // An explicit caller retry retains business idempotency while each
                // transport exchange has its own response-correlation identity.
                repeat(2) { transport.execute(ApiRequest("POST", "/api/sessions/fixture/messages", body, businessId, businessId)) }
                assertEquals(2, calls.size)
                assertEquals(2, calls.map { it.id }.toSet().size)
                calls.forEach { wire ->
                    assertTrue(wire.id != businessId)
                    assertEquals(businessId, wire.headers["X-AgentoC-Request-Id"])
                    assertEquals(businessId, wire.headers["Idempotency-Key"])
                    assertEquals("application/json", wire.headers["Content-Type"])
                    assertEquals(body, com.andysagent.agentoc.core.p2p.P2PProtocol.decodeBodyToString(wire.bodyBase64))
                }
                transport.execute(ApiRequest("POST", "/api/upload", bodyBytes = byteArrayOf(1, 2), contentType = "text/csv"))
                assertEquals("text/csv", calls.last().headers["Content-Type"])
                transport.execute(ApiRequest("POST", "/api/upload", bodyBytes = byteArrayOf(1, 2)))
                assertEquals("application/octet-stream", calls.last().headers["Content-Type"])
                transport.execute(ApiRequest("POST", "/api/upload", body = "{}", headers = mapOf("content-type" to "application/custom")))
                assertEquals("application/custom", calls.last().headers["content-type"])
                assertFalse(calls.last().headers.containsKey("Content-Type"))
            } finally { transport.close() }
        }
    }

    @Test fun lateHttpCredentialDenialCannotClearTheReplacementOrReplayTheWrite() = runBlocking {
        for (status in listOf(401, 403)) {
            val token = java.util.concurrent.atomic.AtomicReference<String?>("rda_old")
            val server = MockWebServer()
            server.enqueue(MockResponse().setResponseCode(status).setBody("""{"code":"DEVICE_REVOKED","error":"old request"}""")); server.start()
            val client = okhttp3.OkHttpClient.Builder().addInterceptor { chain ->
                chain.proceed(chain.request()).also { token.set("rda_new") }
            }.build()
            var notifications = 0
            val transport = OkHttpAgentoCTransport({ server.url("/").toString().trimEnd('/') }, { token.get() }, client,
                onAuthenticationRequired = { notifications++; token.set(null) })
            try {
                transport.updateCarrierConnectionState(RuntimeConnectionState.Connected)
                val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/unknown-write", "{}")) }
                assertEquals("CARRIER_UNAVAILABLE", error.code)
                assertTrue(error.retryable)
                assertEquals("rda_new", token.get()); assertEquals(0, notifications)
                assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
                assertEquals(1, server.requestCount)
                assertEquals("Bearer rda_old", server.takeRequest()?.getHeader("Authorization"))
            } finally { transport.close(); client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll(); server.shutdown() }
        }
    }

    @Test fun oldPeerDenialKeepsTheNewBearerOnBothCarrierTypes() = runBlocking {
        for (turn in listOf(true, false)) {
            val token = java.util.concurrent.atomic.AtomicReference<String?>("rda_old")
            var notifications = 0; var writes = 0
            val session = object : P2PSession {
                override val isOpen = true
                override suspend fun connect() = Result.success(Unit)
                override fun close() = Unit
                override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                    assertEquals("Bearer rda_old", request.headers["Authorization"]); writes++
                    token.set("rda_new")
                    return Result.success(P2PHttpResponse(id = request.id, status = 403, bodyBase64 = com.andysagent.agentoc.core.p2p.P2PProtocol.encodeBody("""{"code":"DEVICE_REVOKED"}""")))
                }
            }
            val transport = OkHttpAgentoCTransport({ "" }, { token.get() }, onAuthenticationRequired = { notifications++; token.set(null) }, requireVerifiedCarrier = true)
            try {
                if (turn) transport.setTurnSession(session) else transport.setP2PSession(session)
                transport.updateCarrierConnectionState(RuntimeConnectionState.Connected)
                val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/unknown-write", "{}")) }
                assertEquals("CARRIER_UNAVAILABLE", error.code)
                assertTrue(error.retryable)
                assertEquals("rda_new", token.get()); assertEquals(0, notifications); assertEquals(1, writes)
                assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
            } finally { transport.close() }
        }
    }

    @Test fun publicChallengeDenialDoesNotInvalidateBearerOnEitherCarrier() = runBlocking {
        for (turn in listOf(true, false)) {
            var notifications = 0
            val session = object : P2PSession {
                override val isOpen = true
                override suspend fun connect() = Result.success(Unit)
                override fun close() = Unit
                override suspend fun request(request: P2PHttpRequest) = Result.success(P2PHttpResponse(
                    id = request.id, status = 401,
                    bodyBase64 = com.andysagent.agentoc.core.p2p.P2PProtocol.encodeBody("""{"code":"DEVICE_REVOKED"}""")))
            }
            val transport = OkHttpAgentoCTransport({ "" }, { "rda_fixture" },
                onAuthenticationRequired = { notifications++ }, requireVerifiedCarrier = true)
            try {
                if (turn) transport.setTurnSession(session) else transport.setP2PSession(session)
                transport.updateCarrierConnectionState(RuntimeConnectionState.Connected)
                val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/api/device-auth/verify", "{}",
                    isolateCredentialFailure = true)) }
                assertEquals(401, error.statusCode); assertEquals(0, notifications)
                assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
            } finally { transport.close() }
        }
    }

    @Test fun externalStorageDenialCannotInvalidateTheComputerCredential() = runBlocking {
        val server = MockWebServer(); server.enqueue(MockResponse().setResponseCode(401)); server.start()
        var notifications = 0
        val transport = OkHttpAgentoCTransport({ "https://computer.invalid" }, { "rda_current" },
            onAuthenticationRequired = { notifications++ }, requireVerifiedCarrier = true)
        try {
            assertEquals(401, assertFailsWith<ApiException> { transport.execute(ApiRequest("PUT", server.url("/signed-upload").toString(), "bytes")) }.statusCode)
            assertEquals(0, notifications); assertEquals(1, server.requestCount)
            assertEquals(null, server.takeRequest()?.getHeader("Authorization"))
        } finally { transport.close(); server.shutdown() }
    }

    @Test fun cancellingAnUnansweredWriteCancelsItsSocketWithoutReplayingIt() = runBlocking {
        assertHttpCancellation(stalledBody = false)
    }

    @Test fun cancellingAnIncompleteResponseBodyCancelsItsSocketWithoutReplayingTheWrite() = runBlocking {
        assertHttpCancellation(stalledBody = true)
    }

    private suspend fun assertHttpCancellation(stalledBody: Boolean) = kotlinx.coroutines.coroutineScope {
        val server = MockWebServer()
        server.enqueue(if (stalledBody) MockResponse().setBody("partial").setHeader("Content-Length", 1024)
            else MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE))
        server.enqueue(MockResponse().setBody("recovered")); server.start()
        val cancelled = CompletableDeferred<Unit>(); val failed = CompletableDeferred<Unit>(); val bodyStarted = CompletableDeferred<Unit>()
        val client = okhttp3.OkHttpClient.Builder()
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .dispatcher(okhttp3.Dispatcher().apply { maxRequests = 1; maxRequestsPerHost = 1 })
            .eventListener(object : okhttp3.EventListener() {
                override fun canceled(call: okhttp3.Call) { cancelled.complete(Unit) }
                override fun callFailed(call: okhttp3.Call, ioe: java.io.IOException) { failed.complete(Unit) }
                override fun responseBodyStart(call: okhttp3.Call) { bodyStarted.complete(Unit) }
            }).build()
        val transport = OkHttpAgentoCTransport({ server.url("/").toString().trimEnd('/') }, { null }, client)
        val write = async(Dispatchers.Default) { transport.execute(ApiRequest("POST", "/unknown-write", "{}")) }
        try {
            val request = withContext(Dispatchers.IO) { server.takeRequest(5, java.util.concurrent.TimeUnit.SECONDS) }
            assertEquals("POST", request?.method); assertEquals("/unknown-write", request?.path)
            if (stalledBody) withTimeout(5_000) { bodyStarted.await() }
            withTimeout(2_000) { write.cancelAndJoin(); cancelled.await(); failed.await() }
            assertTrue(write.isCancelled)
            val response = withTimeout(5_000) { transport.execute(ApiRequest("GET", "/next-request")) }
            assertEquals("recovered", response.body)
            assertEquals(2, server.requestCount)
            assertEquals("/next-request", server.takeRequest()?.path)
        } finally {
            write.cancelAndJoin(); transport.close(); client.dispatcher.executorService.shutdownNow()
            client.connectionPool.evictAll(); server.shutdown()
        }
    }

    @Test fun browserPendingPreservesServerCodeAndDoesNotReplayCompletion() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"owner_auth_account_session_browser_pending","error":"pending"}"""))
        server.start()
        val transport = OkHttpAgentoCTransport({ server.url("/").toString().trimEnd('/') }, { null })
        try {
            val error = assertFailsWith<ApiException> {
                transport.execute(ApiRequest("POST", "/v1/owner-auth/native/session/complete", "{}"))
            }
            assertEquals(409, error.statusCode)
            assertEquals("owner_auth_account_session_browser_pending", error.code)
            assertEquals(1, server.requestCount)
        } finally { transport.close(); server.shutdown() }
    }

    @Test fun networkFailureShowsCauseWithoutBrowserTicketOrAuthorization() = runBlocking {
        val client = okhttp3.OkHttpClient.Builder().addInterceptor {
            throw java.io.IOException("outer", java.net.UnknownHostException(
                "Cannot reach https://accounts.example.test/complete?ticket=fixture-secret idToken=google-secret " +
                    "Authorization: Bearer bearer-secret api_key=api-secret password=pass-secret nonce=nonce-secret"))
        }.build()
        val transport = OkHttpAgentoCTransport({ "https://accounts.example.test" }, { null }, client)
        try {
            val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/complete", "{}")) }
            assertEquals("NETWORK_ERROR", error.code)
            assertTrue(error.retryable)
            assertTrue(error.message.orEmpty().contains("UnknownHostException"))
            for (secret in listOf("accounts.example.test", "fixture-secret", "google-secret", "bearer-secret", "api-secret", "pass-secret", "nonce-secret"))
                assertFalse(error.message.orEmpty().contains(secret))
        } finally { transport.close() }
    }

    @Test fun tlsFailureCategorySurvivesNestedEndOfStreamCause() {
        val handshake = javax.net.ssl.SSLHandshakeException("TLS handshake failed").apply {
            initCause(java.io.EOFException("unexpected end of stream"))
        }
        assertEquals("SSLException", networkFailureCategory(java.io.IOException("request failed", handshake)))
    }

    @Test fun circularNetworkCauseRemainsBounded() = runBlocking {
        val first = java.io.IOException("first"); val second = java.io.IOException("second")
        first.initCause(second); second.initCause(first)
        val client = okhttp3.OkHttpClient.Builder().addInterceptor { throw first }.build()
        val transport = OkHttpAgentoCTransport({ "https://accounts.example.test" }, { null }, client)
        try {
            val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/complete", "{}")) }
            assertEquals("NETWORK_ERROR", error.code)
            assertTrue(error.message.orEmpty().contains("IOException"))
        } finally { transport.close() }
    }
    @Test fun pairedCarriersNeverInventBodyProgressOrSerializeTheObserver() = runBlocking {
        for (turn in listOf(true, false)) {
            val transport = OkHttpAgentoCTransport({ "" }, { null }, requireVerifiedCarrier = true)
            val carrier = RecordingP2PSession()
            if (turn) transport.setTurnSession(carrier) else transport.setP2PSession(carrier)
            val progress = mutableListOf<Long>()
            try {
                transport.execute(ApiRequest("POST", "/api/assets/upload", bodyBytes = byteArrayOf(1, 2),
                    onBodyBytesWritten = progress::add))
                assertTrue(progress.isEmpty())
                assertEquals("AQI=", carrier.request!!.bodyBase64)
                assertEquals("/api/assets/upload", carrier.request!!.path)
            } finally { transport.close() }
        }
    }

    @Test fun delayedConnectedSignalCannotReviveClosedBoundCarrier() = runBlocking {
        val transport = OkHttpAgentoCTransport({ "https://unused.invalid" }, { null }, requireVerifiedCarrier = true)
        val connected = com.andysagent.agentoc.core.model.RuntimeConnectionState.Connected
        val connecting = com.andysagent.agentoc.core.model.RuntimeConnectionState.Connecting
        try {
            transport.updateCarrierConnectionState(connected)
            assertEquals(connecting, transport.connectionState.value)
            val carrier = RecordingP2PSession()
            transport.setTurnSession(carrier)
            transport.updateCarrierConnectionState(connected)
            assertEquals(connected, transport.connectionState.value)
            transport.close()
            transport.updateCarrierConnectionState(connected)
            assertEquals(connecting, transport.connectionState.value)
            assertFailsWith<ApiException> { transport.execute(ApiRequest("GET", "/api/sessions")) }
        } finally { transport.close() }
        Unit
    }

    @Test fun boundComputerCannotUseHttpOrWsAfterCarrierLoss() = runBlocking {
        val server = MockWebServer(); server.start()
        val transport = OkHttpAgentoCTransport({ server.url("/").toString().trimEnd('/') }, { "rda_private" }, requireVerifiedCarrier = true)
        try {
            assertTrue(transport.requiresEventPolling)
            assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/api/sessions", "{}")) }
            transport.connectInvalidationSocket()
            val carrier = RecordingP2PSession()
            transport.setTurnSession(carrier)
            assertEquals(200, transport.execute(ApiRequest("GET", "/api/sessions")).statusCode)
            assertEquals("/api/sessions", carrier.request!!.path)
            transport.clearTurnSession(carrier)
            assertFailsWith<ApiException> { transport.execute(ApiRequest("GET", "/api/sessions")) }
            transport.connectInvalidationSocket()
            assertEquals(0, server.requestCount)
        } finally { transport.close(); server.shutdown() }
    }

    @Test fun signedExternalUploadStillUsesItsUrlWithoutComputerCredential() = runBlocking {
        val server = MockWebServer(); server.enqueue(MockResponse().setResponseCode(200)); server.start()
        val transport = OkHttpAgentoCTransport({ "https://computer.invalid" }, { "rda_private" }, requireVerifiedCarrier = true)
        try {
            val progress = mutableListOf<Long>()
            val response = transport.execute(ApiRequest("PUT", server.url("/signed-upload").toString(),
                bodyBytes = byteArrayOf(1, 2), contentType = "image/png", onBodyBytesWritten = progress::add))
            assertEquals(200, response.statusCode)
            val request = server.takeRequest()
            assertEquals("/signed-upload", request.path)
            assertEquals(null, request.getHeader("Authorization"))
            assertEquals(0L, progress.first()); assertEquals(2L, progress.last())
            assertEquals(2L, request.bodySize)
        } finally { transport.close(); server.shutdown() }
    }

    @Test
    fun endpointlessCarrierRequiresEventPollingButEndpointCarrierDoesNot() = runBlocking {
        val endpointless = OkHttpAgentoCTransport(
            endpointProvider = { "" },
            credentialProvider = { null },
        )
        val endpointful = OkHttpAgentoCTransport(
            endpointProvider = { "https://computer.example.test" },
            credentialProvider = { null },
        )

        assertTrue(endpointless.requiresEventPolling)
        assertFalse(endpointful.requiresEventPolling)

        endpointless.close()
        endpointful.close()
    }

    @Test
    fun openCarrierRequiresEventPollingEvenWhenAnEndpointExists() = runBlocking {
        val transport = OkHttpAgentoCTransport(
            endpointProvider = { "https://computer.example.test" },
            credentialProvider = { null },
        )
        transport.setTurnSession(RecordingP2PSession())

        assertTrue(transport.requiresEventPolling)
        transport.close()
    }

    @Test
    fun sendsBinaryBodyAndContentType() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        server.start()
        try {
            val transport = OkHttpAgentoCTransport(
                endpointProvider = { server.url("/").toString().trimEnd('/') },
                credentialProvider = { null },
            )
            val response = transport.execute(
                ApiRequest(
                    method = "PUT",
                    path = "/api/assets/upload",
                    bodyBytes = byteArrayOf(0, 1, 2, 255.toByte()),
                    contentType = "image/png",
                ),
            )
            val request = server.takeRequest()

            assertEquals(200, response.statusCode)
            assertEquals("image/png", request.getHeader("Content-Type"))
            assertEquals(listOf<Byte>(0, 1, 2, -1), request.body.readByteArray().toList())
            transport.close()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun signedAbsoluteUploadUrlBypassesPeerTransport() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        server.start()
        try {
            val session = RecordingP2PSession(
                P2PHttpResponse(id = "unused", status = 200, bodyBase64 = "eyJwZWVyIjp0cnVlfQ=="),
            )
            val transport = OkHttpAgentoCTransport(
                endpointProvider = { "https://control.example.test" },
                credentialProvider = { "rda_test" },
            )
            transport.setP2PSession(session)

            val response = transport.execute(
                ApiRequest(
                    method = "PUT",
                    path = server.url("/signed/upload").toString(),
                    bodyBytes = byteArrayOf(1, 2, 3),
                    contentType = "text/plain",
                ),
            )

            assertEquals(200, response.statusCode)
            assertEquals(1, server.requestCount)
            assertEquals(null, session.request)
            val request = server.takeRequest()
            assertEquals("text/plain", request.getHeader("Content-Type"))
            assertEquals(null, request.getHeader("Authorization"))
            assertEquals(null, request.getHeader("X-AgentoC-Request-Id"))
            transport.close()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun sendsBearerAndRequestMetadata() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200).setBody("{\"ok\":true}"))
        server.start()
        try {
            val transport = OkHttpAgentoCTransport(
                endpointProvider = { server.url("/").toString().trimEnd('/') },
                credentialProvider = { "rda_test" },
            )
            val response = transport.execute(ApiRequest("POST", "/api/test", "{}", "req_1", "idem_1"))
            val request = server.takeRequest()
            assertEquals(200, response.statusCode)
            assertEquals("Bearer rda_test", request.getHeader("Authorization"))
            assertEquals("req_1", request.getHeader("X-AgentoC-Request-Id"))
            assertEquals("idem_1", request.getHeader("Idempotency-Key"))
            transport.close()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun mapsStructuredApiErrors() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(410).setBody("{\"error\":\"expired\",\"code\":\"PAIRING_EXPIRED\"}"))
        server.start()
        try {
            val transport = OkHttpAgentoCTransport({ server.url("/").toString().trimEnd('/') }, { null })
            val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("GET", "/api/test")) }
            assertEquals(410, error.statusCode)
            assertEquals("PAIRING_EXPIRED", error.code)
            assertEquals(false, error.retryable)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun preservesRetryAfterFromRateLimitBodyAndHeader() = runBlocking {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setResponseCode(429)
                .setHeader("Retry-After", "9")
                .setBody("{\"error\":\"busy\",\"code\":\"RATE_LIMITED\",\"retryAfterMs\":1250}"),
        )
        server.start()
        try {
            val transport = OkHttpAgentoCTransport({ server.url("/").toString().trimEnd('/') }, { null })
            val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("POST", "/api/test", "{}")) }
            assertEquals(429, error.statusCode)
            assertEquals("RATE_LIMITED", error.code)
            assertEquals(9_000L, error.retryAfterMs)
            assertEquals("9", error.headers["Retry-After"])
            transport.close()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun maps401ToAuthenticationRequiredAndNotifiesOwner() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"expired\",\"code\":\"AUTH_EXPIRED\"}"))
        server.start()
        var notified = false
        try {
            val transport = OkHttpAgentoCTransport(
                { server.url("/").toString().trimEnd('/') },
                { "rda_stale" },
                onAuthenticationRequired = { notified = true },
            )
            val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("GET", "/api/auth/me")) }
            assertEquals(401, error.statusCode)
            assertEquals("AUTH_EXPIRED", error.code)
            assertEquals(com.andysagent.agentoc.core.model.RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
            assertTrue(notified)
            transport.close()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun maps403ToAuthenticationRequiredAndNotifiesOwner() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(403).setBody("{\"error\":\"revoked\",\"code\":\"DEVICE_REVOKED\"}"))
        server.start()
        var notified = false
        try {
            val transport = OkHttpAgentoCTransport(
                { server.url("/").toString().trimEnd('/') },
                { "rda_revoked" },
                onAuthenticationRequired = { notified = true },
            )
            val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("GET", "/api/auth/me")) }
            assertEquals(403, error.statusCode)
            assertEquals("DEVICE_REVOKED", error.code)
            assertEquals(com.andysagent.agentoc.core.model.RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
            assertTrue(notified)
            transport.close()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun preservesConnectionOnPermissionDenied403() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(403).setBody("{\"error\":\"Device access not permitted for this route\"}"))
        server.start()
        var notified = false
        try {
            val transport = OkHttpAgentoCTransport(
                { server.url("/").toString().trimEnd('/') },
                { "rda_active" },
                onAuthenticationRequired = { notified = true },
            )
            transport.updateCarrierConnectionState(RuntimeConnectionState.Connected)

            val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("GET", "/api/native-providers")) }

            assertEquals(403, error.statusCode)
            assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
            assertFalse(notified)
            transport.close()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun staleAuthenticationFailuresAfterRenewalRemainRetryable() = runBlocking {
        for (carrier in listOf("http", "p2p", "turn")) {
            val server = MockWebServer()
            server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":\"expired\"}"))
            server.start()
            var token = "old-token"
            var notified = false
            try {
                val transport = OkHttpAgentoCTransport(
                    endpointProvider = { server.url("/").toString().trimEnd('/') },
                    credentialProvider = { token },
                    onAuthenticationRequired = { notified = true },
                    credentialRejectionHandler = CredentialRejectionHandler { attempted, _, _ ->
                        assertEquals("old-token", attempted)
                        // Renewal commits before the old response is handled.
                        token = "new-token"
                    },
                )
                transport.updateCarrierConnectionState(RuntimeConnectionState.Connected)
                val peerResponse = P2PHttpResponse(id = "unused", status = 401)
                if (carrier == "p2p") transport.setP2PSession(RecordingP2PSession(peerResponse))
                if (carrier == "turn") transport.setTurnSession(RecordingP2PSession(peerResponse))
                val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("GET", "/api/test")) }
                assertEquals("CARRIER_UNAVAILABLE", error.code, carrier)
                assertTrue(error.retryable, carrier)
                assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value, carrier)
                assertFalse(notified, carrier)
                assertEquals("new-token", token, carrier)
                transport.close()
            } finally { server.shutdown() }
        }
    }

    @Test
    fun preservesConnectionOnPermissionDenied403OverPeerCarriers() = runBlocking {
        val installCarrier = listOf<(OkHttpAgentoCTransport) -> Unit>(
            { transport -> transport.setP2PSession(RecordingP2PSession(P2PHttpResponse(id = "unused", status = 403))) },
            { transport -> transport.setTurnSession(RecordingP2PSession(P2PHttpResponse(id = "unused", status = 403))) },
        )

        installCarrier.forEach { install ->
            var notified = false
            val transport = OkHttpAgentoCTransport(
                endpointProvider = { "" },
                credentialProvider = { "rda_active" },
                onAuthenticationRequired = { notified = true },
            )
            transport.updateCarrierConnectionState(RuntimeConnectionState.Connected)
            install(transport)

            val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("GET", "/api/native-providers")) }

            assertEquals(403, error.statusCode)
            assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
            assertFalse(notified)
            transport.close()
        }
    }

    @Test
    fun usesOpenP2PSessionWithoutRepeatingRequestOverHttp() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val session = RecordingP2PSession(
                P2PHttpResponse(id = "unused", status = 200, bodyBase64 = "eyJvayI6dHJ1ZX0="),
            )
            val transport = OkHttpAgentoCTransport(
                endpointProvider = { server.url("/").toString().trimEnd('/') },
                credentialProvider = { "rda_test" },
            )
            transport.setP2PSession(session)

            val response = transport.execute(ApiRequest("POST", "/api/test?view=full", "{}", "req_1", "idem_1"))

            assertEquals(200, response.statusCode)
            assertEquals(0, server.requestCount)
            assertEquals("POST", session.request?.method)
            assertEquals("/api/test?view=full", session.request?.path)
            assertEquals("Bearer rda_test", session.request?.headers?.get("Authorization"))
            assertEquals("req_1", session.request?.headers?.get("X-AgentoC-Request-Id"))
            assertEquals("idem_1", session.request?.headers?.get("Idempotency-Key"))
            transport.close()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun p2pFailureDoesNotFallBackByRepeatingRequestOverHttp() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200).setBody("{\"wrong\":true}"))
        server.start()
        try {
            val session = RecordingP2PSession(result = Result.failure(IllegalStateException("data channel closed")))
            val transport = OkHttpAgentoCTransport({ server.url("/").toString().trimEnd('/') }, { null })
            transport.setP2PSession(session)

            val error = assertFailsWith<ApiException> { transport.execute(ApiRequest("GET", "/api/test")) }

            assertEquals("P2P_NETWORK_ERROR", error.code)
            assertEquals(0, server.requestCount)
            transport.close()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun usesOpenTurnSessionWithoutRepeatingRequestOverHttp() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            val session = RecordingP2PSession(
                P2PHttpResponse(id = "unused", status = 200, bodyBase64 = "eyJvayI6dHJ1ZX0="),
            )
            val transport = OkHttpAgentoCTransport(
                endpointProvider = { server.url("/").toString().trimEnd('/') },
                credentialProvider = { "rda_test" },
            )
            transport.setTurnSession(session)

            val response = transport.execute(ApiRequest("POST", "/api/test", "{}", "req_2", "idem_2"))

            assertEquals(200, response.statusCode)
            assertEquals(0, server.requestCount)
            assertEquals("Bearer rda_test", session.request?.headers?.get("Authorization"))
            assertEquals("req_2", session.request?.headers?.get("X-AgentoC-Request-Id"))
            assertEquals("idem_2", session.request?.headers?.get("Idempotency-Key"))
            transport.close()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun closeClosesInstalledTurnAndP2PCarriers() = runBlocking {
        val turn = RecordingP2PSession()
        val p2p = RecordingP2PSession()
        val transport = OkHttpAgentoCTransport({ "" }, { null })

        transport.setTurnSession(turn)
        transport.setP2PSession(p2p)
        transport.close()

        assertEquals(1, turn.closeCount)
        assertEquals(1, p2p.closeCount)
    }

    @Test
    fun mapsP2PRemoteErrorsAndHttpStatusResponses() = runBlocking {
        val remoteErrorSession = RecordingP2PSession(
            P2PHttpResponse(id = "unused", status = 0, error = "host rejected request"),
        )
        val remoteErrorTransport = OkHttpAgentoCTransport({ "http://unused.test" }, { null })
        remoteErrorTransport.setP2PSession(remoteErrorSession)
        val remoteError = assertFailsWith<ApiException> {
            remoteErrorTransport.execute(ApiRequest("GET", "/api/test"))
        }
        assertEquals(0, remoteError.statusCode)
        assertEquals("P2P_REMOTE_ERROR", remoteError.code)
        assertEquals("host rejected request", remoteError.message)
        assertFalse(remoteError.retryable)
        remoteErrorTransport.close()

        var authRequired = false
        val statusSession = RecordingP2PSession(
            P2PHttpResponse(
                id = "unused",
                status = 401,
                bodyBase64 = "eyJlcnJvciI6ImV4cGlyZWQiLCJjb2RlIjoiQVVUSF9FWFBJUkVEIn0=",
            ),
        )
        val statusTransport = OkHttpAgentoCTransport(
            endpointProvider = { "http://unused.test" },
            credentialProvider = { "rda_stale" },
            onAuthenticationRequired = { authRequired = true },
        )
        statusTransport.setP2PSession(statusSession)
        val statusError = assertFailsWith<ApiException> {
            statusTransport.execute(ApiRequest("GET", "/api/auth/me"))
        }
        assertEquals(401, statusError.statusCode)
        assertEquals("AUTH_EXPIRED", statusError.code)
        assertTrue(authRequired)
        statusTransport.close()
    }
}

private class RecordingP2PSession(
    private val response: P2PHttpResponse = P2PHttpResponse(id = "unused", status = 200),
    private val result: Result<P2PHttpResponse>? = null,
) : P2PSession {
    override val isOpen = true
    var request: P2PHttpRequest? = null
        private set
    var closeCount: Int = 0
        private set

    override suspend fun connect(): Result<Unit> = Result.success(Unit)

    override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
        this.request = request
        return result ?: Result.success(response.copy(id = request.id))
    }

    override fun close() {
        closeCount += 1
    }
}
