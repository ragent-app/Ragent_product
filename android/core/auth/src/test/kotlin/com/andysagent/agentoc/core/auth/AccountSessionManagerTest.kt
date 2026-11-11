package com.andysagent.agentoc.core.auth

import com.andysagent.agentoc.core.datastore.AccountSessionMetadata
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiResponse
import com.andysagent.agentoc.core.network.InvalidationHint
import com.andysagent.agentoc.core.protocol.AccountJoinIntentDto
import com.andysagent.agentoc.core.protocol.AccountRendezvousTargetInstanceDto
import com.andysagent.agentoc.core.protocol.buildAccountJoinIntentMessage
import com.andysagent.agentoc.core.protocol.buildAccountSessionCompleteMessage
import com.andysagent.agentoc.core.protocol.buildAccountSessionRefreshMessage
import com.andysagent.agentoc.core.protocol.PairingUriDto
import com.andysagent.agentoc.core.protocol.buildAccountPairingProof
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.longOrNull
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.time.Instant
import java.util.Base64
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.assertFailsWith

class AccountSessionManagerTest {
    @Test fun `late logout success or rejection leaves replacement login and connections intact`() = runBlocking {
        for (status in listOf(200, 401)) {
            val metadata = turnMetadata()
            val credentials = FakeAccountCredentialStore("rac_old")
            var disconnected = 0
            val transport = RecordingTransport {
                metadata.saveAccountSession(metadata.accountSession.value!!.copy(accountId = "acct_new", credentialId = "cred_new"))
                credentials.writeToken("rac_new")
                if (status == 401) throw ApiException(401, "revoked", "Old logout rejected")
                ApiResponse(200, """{"loggedOut":true}""")
            }
            val session = manager(transport, transport, FakeDeviceIdentityStore(), credentials, metadata,
                afterDemoLogout = { disconnected++ })
            assertTrue(session.logoutAccountSession())
            assertEquals("acct_new", session.ensureActiveCredential().accountId)
            assertEquals("rac_new", credentials.readToken())
            assertEquals(0, disconnected)
        }
    }

    @Test fun `late self revocation cannot clear a rotated bearer`() = runBlocking {
        val credentials = FakeAccountCredentialStore("rac_old")
        val metadata = turnMetadata()
        val transport = RecordingTransport {
            credentials.writeToken("rac_rotated")
            ApiResponse(200, """{"revoked":true}""")
        }
        val session = manager(transport, transport, FakeDeviceIdentityStore(), credentials, metadata)
        val device = session.ensureActiveCredential().deviceId
        assertTrue(session.revokeAccountDevice(device))
        assertEquals("rac_rotated", session.ensureActiveCredential().token)
    }

    @Test fun `delayed operation rejection cannot clear a different signed in account`() = runBlocking {
        val metadata = turnMetadata()
        val credentials = FakeAccountCredentialStore("rac_old")
        val transport = RecordingTransport { error("No network needed") }
        val session = manager(transport, transport, FakeDeviceIdentityStore(), credentials, metadata)
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val request = async {
            assertFailsWith<AccountSessionException> {
                session.withActiveAuthority {
                    started.complete(Unit); release.await()
                    throw AccountSessionException(401, "rejected", "Old operation rejected")
                }
            }
        }
        started.await()
        metadata.saveAccountSession(metadata.accountSession.value!!.copy(accountId = "acct_new", credentialId = "cred_new"))
        credentials.writeToken("rac_new")
        release.complete(Unit); request.await()
        assertEquals("acct_new", session.ensureActiveCredential().accountId)
        assertEquals("rac_new", credentials.readToken())
    }

    @Test fun `operation rejection cannot clear a rotated bearer with the same metadata`() = runBlocking {
        val credentials = FakeAccountCredentialStore("rac_old")
        val transport = RecordingTransport { error("No network needed") }
        val session = manager(transport, transport, FakeDeviceIdentityStore(), credentials, turnMetadata())
        assertFailsWith<AccountSessionException> {
            session.withActiveAuthority {
                credentials.writeToken("rac_rotated")
                throw AccountSessionException(403, "rejected", "Old bearer rejected")
            }
        }
        assertEquals("rac_rotated", session.ensureActiveCredential().token)
    }

    @Test fun `current operation rejection clears only current authority using repository status`() = runBlocking {
        val credentials = FakeAccountCredentialStore("rac_current")
        val metadata = turnMetadata()
        val transport = RecordingTransport { error("No network needed") }
        val session = manager(transport, transport, FakeDeviceIdentityStore(), credentials, metadata)
        assertFailsWith<IllegalStateException> {
            session.withActiveAuthority(rejectionStatus = { if (it is IllegalStateException) 401 else null }) {
                throw IllegalStateException("Repository rejected authority")
            }
        }
        assertEquals(null, credentials.readToken())
        assertEquals(null, metadata.accountSession.value)
    }

    @Test fun `cancellation and server failure do not invalidate authority`() = runBlocking {
        val credentials = FakeAccountCredentialStore("rac_current")
        val transport = RecordingTransport { error("No network needed") }
        val session = manager(transport, transport, FakeDeviceIdentityStore(), credentials, turnMetadata())
        assertFailsWith<CancellationException> {
            session.withActiveAuthority(rejectionStatus = { 401 }) { throw CancellationException("Cancelled") }
        }
        assertFailsWith<AccountSessionException> {
            session.withActiveAuthority { throw AccountSessionException(503, "unavailable", "Retry later") }
        }
        assertEquals("rac_current", session.ensureActiveCredential().token)
    }

    @Test fun `old rejection cannot clear a rotated bearer with unchanged metadata`() = runBlocking {
        val metadata=turnMetadata();val credentials=FakeAccountCredentialStore("rac_old")
        val pending=mutableListOf<suspend () -> Unit>()
        val transport=RecordingTransport {error("No network needed")}
        val session=manager(transport,transport,FakeDeviceIdentityStore(),credentials,metadata,
            dispatchSessionInvalidation={pending+=it})
        val old=session.ensureActiveCredential()
        session.invalidateLocalSession(old)
        credentials.writeToken("rac_rotated")
        pending.single().invoke()
        session.invalidateLocalSession(old)
        assertEquals(1,pending.size);assertEquals("rac_rotated",session.ensureActiveCredential().token)
    }

    @Test fun `connection job exits before independently launched cleanup waits for its teardown`() = runBlocking {
        val metadata=FakeAccountSessionMetadataStore("adev_test",AccountSessionMetadata("acct_1","adev_test","cred_1","account-directory","2000-01-01T00:00:00Z"))
        val credentials=FakeAccountCredentialStore("rac_old")
        val transport=RecordingTransport { throw ApiException(401,"revoked","Expired",retryable=false) }
        lateinit var connection:kotlinx.coroutines.Deferred<AccountSessionCredential>
        var cleanupJob:kotlinx.coroutines.Job?=null
        val connectionScope=kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob()+kotlinx.coroutines.Dispatchers.Unconfined)
        val lifecycleScope=kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob()+kotlinx.coroutines.Dispatchers.Unconfined)
        val session=manager(transport,transport,FakeDeviceIdentityStore(),credentials,metadata,
            dispatchSessionInvalidation={action->cleanupJob=lifecycleScope.launch(start=kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {action()}},
            changeAccountDirectory={_,update->connection.join();update()})
        try {
            connection=connectionScope.async(start=kotlinx.coroutines.CoroutineStart.LAZY) {session.ensureActiveCredential()}
            assertFailsWith<AccountSessionException> {withTimeout(2_000) {connection.await()}}
            withTimeout(2_000) {requireNotNull(cleanupJob).join()}
            assertEquals(null,credentials.token);assertEquals(null,metadata.accountSession.value)
        } finally {
            connectionScope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            lifecycleScope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
        }
    }

    @Test fun `failed queued storage cleanup can be retried without admitting rejected authority`() = runBlocking {
        val metadata=FakeAccountSessionMetadataStore("adev_test",AccountSessionMetadata("acct_1","adev_test","cred_1","account-directory","2000-01-01T00:00:00Z"))
        val credentials=FakeAccountCredentialStore("rac_old");val pending=mutableListOf<suspend () -> Unit>();var attempts=0
        val transport=RecordingTransport {throw ApiException(401,"revoked","Expired",retryable=false)}
        val session=manager(transport,transport,FakeDeviceIdentityStore(),credentials,metadata,
            dispatchSessionInvalidation={pending+=it},changeAccountDirectory={_,update->
                if(++attempts==1) error("storage failed") else update()
            })
        assertFailsWith<AccountSessionException> {session.ensureActiveCredential()}
        assertFailsWith<IllegalStateException> {pending[0].invoke()}
        assertFailsWith<AccountSessionException> {session.ensureActiveCredential()}
        assertEquals(2,pending.size);pending[1].invoke();assertEquals(null,credentials.token)
    }

    @Test fun `rejected authority stops admission while independent lifecycle cleanup is pending`() = runBlocking {
        val metadata=FakeAccountSessionMetadataStore("adev_test",AccountSessionMetadata("acct_1","adev_test","cred_1","account-directory","2000-01-01T00:00:00Z"))
        val credentials=FakeAccountCredentialStore("rac_old")
        val pending=mutableListOf<suspend () -> Unit>()
        val transport=RecordingTransport { throw ApiException(401,"revoked","Expired",retryable=false) }
        val session=manager(transport,transport,FakeDeviceIdentityStore(),credentials,metadata,
            dispatchSessionInvalidation={ pending += it })
        assertFailsWith<AccountSessionException> { session.ensureActiveCredential() }
        assertEquals(1,pending.size);assertEquals("rac_old",credentials.token)
        assertFailsWith<AccountSessionException> { session.ensureActiveCredential() }
        assertEquals(1,transport.requests.size);assertEquals(1,pending.size)
        pending.single().invoke()
        assertEquals(null,credentials.token);assertEquals(null,metadata.accountSession.value)
    }

    @Test fun `queued old rejection cannot clear a newly signed in account`() = runBlocking {
        val metadata=FakeAccountSessionMetadataStore("adev_test",AccountSessionMetadata("acct_1","adev_test","cred_1","account-directory","2000-01-01T00:00:00Z"))
        val credentials=FakeAccountCredentialStore("rac_old")
        val pending=mutableListOf<suspend () -> Unit>()
        val transport=RecordingTransport { throw ApiException(401,"revoked","Expired",retryable=false) }
        val session=manager(transport,transport,FakeDeviceIdentityStore(),credentials,metadata,
            dispatchSessionInvalidation={ pending += it })
        assertFailsWith<AccountSessionException> { session.ensureActiveCredential() }
        metadata.saveAccountSession(AccountSessionMetadata("acct_new","adev_test","cred_new","account-directory","2099-01-01T00:00:00Z"))
        credentials.writeToken("rac_new")
        pending.single().invoke()
        assertEquals("rac_new",credentials.token);assertEquals("acct_new",session.ensureActiveCredential().accountId)
    }

    @Test fun `failed local metadata removal keeps the matching bearer and directory authority`() = runBlocking {
        val metadata=turnMetadata(); val credentials=FakeAccountCredentialStore("rac_active")
        val failing=object:AccountSessionMetadataStore by metadata {
            override suspend fun clearAccountSession() { error("storage failed") }
        }
        val transport=RecordingTransport { error("No network") }
        val session=manager(transport,transport,FakeDeviceIdentityStore(),credentials,failing)
        assertFailsWith<IllegalStateException> { session.clearLocalSession() }
        assertEquals("rac_active",credentials.token)
        assertEquals("acct_1",metadata.accountSession.value?.accountId)
    }

    @Test fun `logout wraps authority removal inside the directory transition`() = runBlocking {
        val metadata=turnMetadata(); val credentials=FakeAccountCredentialStore("rac_active")
        val transport=RecordingTransport { error("No network needed for local teardown") }
        var transitions=0
        val session=manager(transport,transport,FakeDeviceIdentityStore(),credentials,metadata,
            changeAccountDirectory={ preserve,update ->
                assertEquals(false,preserve.preserveCaller);assertEquals("rac_active",credentials.token)
                update();assertEquals(null,credentials.token);assertEquals(null,metadata.accountSession.value);transitions++
            })
        session.clearLocalSession();assertEquals(1,transitions)
    }

    @Test fun `late refresh cannot resurrect a session after local logout`() = runBlocking {
        val metadata=FakeAccountSessionMetadataStore("adev_test",AccountSessionMetadata("acct_1","adev_test","cred_1","account-directory","2000-01-01T00:00:00Z"))
        val credentials=FakeAccountCredentialStore("rac_old")
        lateinit var session:AccountSessionManager
        val transport=RecordingTransport {
            session.clearLocalSession()
            ApiResponse(200,"""{"accountId":"acct_1","deviceId":"adev_test","credential":{"type":"Bearer","token":"rac_stale","credentialId":"cred_new","scope":"account-directory","expiresAt":"2099-01-01T00:00:00Z"}}""")
        }
        session=manager(transport,transport,FakeDeviceIdentityStore(),credentials,metadata)
        assertEquals("account_session_superseded",assertFailsWith<AccountSessionException> {session.ensureActiveCredential()}.code)
        assertEquals(null,credentials.token);assertEquals(null,metadata.accountSession.value)
    }

    @Test fun `cached restricted demo learns full mode before credential expiry`() = runBlocking {
        val accountId = "acct_demo_" + "a".repeat(48)
        val metadata = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(accountId, "adev_test", "cred_fixture",
            "account-directory", "2099-01-01T00:00:00Z", "restricted"))
        val transport = RecordingTransport { ApiResponse(200, """{"accountId":"$accountId","deviceId":"adev_test","demoAccessMode":"full","credential":{"type":"Bearer","token":"rac_refreshed","credentialId":"cred_fixture","scope":"account-directory","expiresAt":"2099-01-01T00:00:00Z"}}""") }
        val session = manager(transport, transport, FakeDeviceIdentityStore(), FakeAccountCredentialStore("rac_old"), metadata)
        assertEquals("full", session.ensureActiveCredential().demoAccessMode)
        assertEquals("full", session.ensureActiveCredential().demoAccessMode)
        assertEquals(1, transport.requests.size)
    }

    @Test fun `restricted presentation network checks are bounded and preserve valid offline authority`() = runBlocking {
        val accountId = "acct_demo_" + "a".repeat(48)
        val metadata = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(accountId, "adev_test", "cred_fixture",
            "account-directory", "2099-01-01T00:00:00Z", "restricted"))
        var elapsed = 0L
        val transport = RecordingTransport { throw ApiException(503, "unavailable", "Offline", retryable = true) }
        val session = manager(transport, transport, FakeDeviceIdentityStore(), FakeAccountCredentialStore("rac_old"), metadata,
            monotonicMillis = { elapsed })
        repeat(3) { assertEquals("rac_old", session.ensureActiveCredential().token) }
        assertEquals(1, transport.requests.size)
        elapsed = 300_000L
        assertEquals("rac_old", session.ensureActiveCredential().token)
        assertEquals(2, transport.requests.size)
    }

    @Test fun `presentation fallback cannot restore logged out authority`() = runBlocking {
        val accountId = "acct_demo_" + "a".repeat(48)
        val metadata = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(accountId, "adev_test", "cred_fixture",
            "account-directory", "2099-01-01T00:00:00Z", "restricted"))
        val credentials = FakeAccountCredentialStore("rac_old")
        lateinit var session: AccountSessionManager
        val transport = RecordingTransport {
            session.clearLocalSession()
            throw ApiException(503, "unavailable", "Offline", retryable = true)
        }
        session = manager(transport, transport, FakeDeviceIdentityStore(), credentials, metadata)
        assertFailsWith<AccountSessionException> { session.ensureActiveCredential() }
        assertEquals(null, credentials.token)
        assertEquals(null, metadata.accountSession.value)
    }

    @Test fun `legacy demo learns server mode once and refresh never retains stale full mode`() = runBlocking {
        val accountId = "acct_demo_" + "a".repeat(48)
        val metadata = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(
            accountId, "adev_test", "cred_fixture", "account-directory", "2099-01-01T00:00:00Z"))
        val credentials = FakeAccountCredentialStore("rac_legacy")
        val anonymous = RecordingTransport { request ->
            assertEquals("/v1/owner-auth/native/session/refresh", request.path)
            ApiResponse(200, """{"accountId":"$accountId","deviceId":"adev_test","demoAccessMode":"full","credential":{"type":"Bearer","token":"rac_refreshed","credentialId":"cred_fixture","scope":"account-directory","expiresAt":"2099-01-01T00:00:00Z"}}""")
        }
        val session = manager(anonymous, RecordingTransport { error("No workspace request") }, FakeDeviceIdentityStore(), credentials, metadata)
        assertEquals("full", session.ensureActiveCredential().demoAccessMode)
        assertEquals("full", metadata.accountSession.value?.demoAccessMode)
        assertEquals("full", session.ensureActiveCredential().demoAccessMode)
        assertEquals(1, anonymous.requests.size)
        for (mode in listOf<String?>(null, "unknown")) {
            val expired = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(
                accountId, "adev_test", "cred_fixture", "account-directory", "2000-01-01T00:00:00Z", "full"))
            val transport = RecordingTransport { ApiResponse(200,
                """{"accountId":"$accountId","deviceId":"adev_test",${if (mode == null) "" else "\"demoAccessMode\":\"$mode\","}"credential":{"type":"Bearer","token":"rac_new","credentialId":"cred_fixture","scope":"account-directory","expiresAt":"2099-01-01T00:00:00Z"}}""") }
            val downgraded = manager(transport, transport, FakeDeviceIdentityStore(), FakeAccountCredentialStore("rac_old"), expired)
            assertEquals("restricted", downgraded.ensureActiveCredential().demoAccessMode)
            assertEquals("restricted", expired.accountSession.value?.demoAccessMode)
        }
    }

    @Test fun `demo preflight rejects existing connections before any authentication side effect`() = runBlocking {
        val transport = RecordingTransport { error("No request may precede the workspace boundary") }
        val credentials = FakeAccountCredentialStore()
        val metadata = FakeAccountSessionMetadataStore("adev_test")
        val session = manager(transport, transport, FakeDeviceIdentityStore(), credentials, metadata,
            beforeDemoSignIn = { throw AccountSessionException(409, "demo_existing_connections", "Disconnect computers first") })
        assertEquals("demo_existing_connections", assertFailsWith<AccountSessionException> {
            session.signInDemoAccount("review-fixture", "fixture-password-long", "Fixture phone")
        }.code)
        assertTrue(transport.requests.isEmpty()); assertEquals(null, credentials.token); assertEquals(null, metadata.accountSession.value)
    }

    @Test fun `explicit demo logout clears local authority before disconnecting demo connections and preserves Google behavior`() = runBlocking {
        for (demo in listOf(true, false)) {
            val accountId = if (demo) "acct_demo_" + "a".repeat(48) else "acct_google_fixture"
            val metadata = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(accountId, "adev_test", "cred_fixture",
                "account-directory", "2099-01-01T00:00:00Z"))
            val credentials = FakeAccountCredentialStore("rac_active")
            var disconnected = 0
            val transport = RecordingTransport { ApiResponse(200, """{"loggedOut":true}""") }
            val session = manager(transport, transport, FakeDeviceIdentityStore(), credentials, metadata,
                afterDemoLogout = { assertEquals(null, credentials.token); assertEquals(null, metadata.accountSession.value); disconnected++ })
            assertTrue(session.logoutAccountSession())
            assertEquals(if (demo) 1 else 0, disconnected)
        }
    }

    @Test fun `demo exchange uses signed Accounts-only login and never persists a Google identity`() = runBlocking {
        val accountId = "acct_demo_" + "a".repeat(48)
        val identity = FakeDeviceIdentityStore()
        val credentials = FakeAccountCredentialStore()
        val metadata = FakeAccountSessionMetadataStore("adev_test")
        var challengeDeviceId = ""
        val anonymous = RecordingTransport { request -> when {
            request.path.endsWith("/challenge") -> {
                challengeDeviceId = Json.parseToJsonElement(requireNotNull(request.body)).jsonObject["device"]!!.jsonObject["deviceId"]!!.jsonPrimitive.content
                ApiResponse(201, """{"contractVersion":2,"transactionId":"transaction_demo_fixture","nonce":"nonce_demo_fixture","expiresAt":"2099-01-01T00:00:00Z"}""")
            }
            request.path.endsWith("/demo") -> {
                val body = Json.parseToJsonElement(requireNotNull(request.body)).jsonObject
                assertEquals("review-fixture", body["username"]!!.jsonPrimitive.content)
                assertEquals("fixture-password-long", body["password"]!!.jsonPrimitive.content)
                assertEquals(null, body["idToken"])
                verifySignature(identity, buildAccountSessionCompleteMessage("transaction_demo_fixture", body["requestId"]!!.jsonPrimitive.content,
                    challengeDeviceId, devicePublicKeyFingerprint(identity.publicKeyEncoded()), "nonce_demo_fixture"), body["signature"]!!.jsonPrimitive.content)
                assertTrue(challengeDeviceId.startsWith("adev_demo_"))
                ApiResponse(200, """{"contractVersion":2,"accountId":"$accountId","deviceId":"$challengeDeviceId","credential":{"type":"Bearer","token":"rac_demo_fixture","credentialId":"cred_demo_fixture","scope":"account-directory","expiresAt":"2099-01-01T00:00:00Z"}}""")
            }
            else -> error("Unexpected request")
        } }
        val session = manager(anonymous, RecordingTransport { error("No target or authenticated request before sign-in") }, identity, credentials, metadata)
        assertEquals(accountId, session.signInDemoAccount("review-fixture", "fixture-password-long", "Fixture phone").accountId)
        assertEquals("rac_demo_fixture", credentials.token)
        assertEquals(accountId, metadata.accountSession.value?.accountId)
        assertEquals(2, anonymous.requests.size)
        assertFailsWith<AccountSessionException> { session.signInDemoAccount("review-fixture", "fixture-password-long", "Fixture phone") }
        assertEquals(2, anonymous.requests.size)
        session.clearLocalSession()
        session.createGoogleChallenge("Normal phone")
        assertEquals("adev_test", challengeDeviceId, "Google retains its original installation identity after demo logout")
    }

    private fun turnId(suffix: Char) = "turn_${"a".repeat(32)}_1790000000000_${suffix.toString().repeat(32)}"
    private fun turnMetadata() = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(
        "acct_1", "adev_test", "cred_1", "account-directory", "2099-01-01T00:00:00Z"))

    @Test fun `own lease inventory and release use only Accounts and exact IDs`() = runBlocking {
        val first = turnId('1'); val second = turnId('2')
        val transport = RecordingTransport { request -> ApiResponse(200, if (request.method == "GET") {
            """{"contractVersion":1,"accountId":"acct_1","deviceId":"adev_test","asOf":"2026-10-25T00:00:00Z","connections":[{"connectionId":"$second","instanceId":"inst_primary","deviceId":"rdev_primary","expiresAt":"2099-01-01T00:00:00Z"}],"nextCursor":null,"legacyConnections":1}"""
        } else """{"contractVersion":1,"accountId":"acct_1","deviceId":"adev_test","processedConnections":1,"releasedConnections":1}""") }
        val metadata = turnMetadata(); val credentials = FakeAccountCredentialStore("rac_active")
        val session = manager(RecordingTransport { error("No Google or anonymous auth request") }, transport, FakeDeviceIdentityStore(), credentials, metadata)
        assertEquals(listOf(second), session.listOwnTurnConnections(first).connections.map { it.connectionId })
        assertEquals(1, session.releaseOwnTurnConnections(listOf(second, second), "client-release").releasedConnections)
        assertEquals("/v1/owner-auth/account/turn/connections?after=$first", transport.requests.first().path)
        assertEquals("/v1/owner-auth/account/turn/connections/release", transport.requests.last().path)
        assertTrue(transport.requests.last().body!!.contains(second)); assertTrue(!transport.requests.last().body!!.contains("rac_"))
        assertEquals("rac_active", credentials.token); assertEquals("acct_1", metadata.accountSession.value?.accountId)
    }

    @Test fun `foreign or malformed inventory cannot supply release IDs`() = runBlocking {
        val id = turnId('1')
        val row = """{"connectionId":"$id","instanceId":"inst_primary","deviceId":"rdev_primary","expiresAt":"2099-01-01T00:00:00Z"}"""
        val good = """{"contractVersion":1,"accountId":"acct_1","deviceId":"adev_test","asOf":"2026-10-25T00:00:00Z","connections":[$row],"nextCursor":null}"""
        for (bad in listOf(good.replace("acct_1", "acct_foreign"), good.replace("adev_test", "adev_other"),
            good.replace("contractVersion\":1", "contractVersion\":2"), good.replace("[$row]", "[$row,$row]"),
            good.replace("rdev_primary", "foreign"), good.replace("2099-01-01T00:00:00Z", "invalid"),
            good.replace("\"nextCursor\":null", "\"nextCursor\":\"${turnId('2')}\""))) {
            val transport = RecordingTransport { ApiResponse(200, bad) }
            val session = manager(transport, transport, FakeDeviceIdentityStore(), FakeAccountCredentialStore("rac_active"), turnMetadata())
            assertEquals(502, assertFailsWith<AccountSessionException> { session.listOwnTurnConnections() }.statusCode)
            assertEquals(1, transport.requests.size)
        }
    }

    @Test fun `legacy and unbounded release requests fail before spending RAC`() = runBlocking {
        val transport = RecordingTransport { error("Malformed IDs must not use Accounts") }
        val session = manager(transport, transport, FakeDeviceIdentityStore(), FakeAccountCredentialStore("rac_active"), turnMetadata())
        for (ids in listOf(emptyList(), listOf("turn_${"a".repeat(32)}"), List(101) { turnId('1') })) {
            assertEquals(400, assertFailsWith<AccountSessionException> { session.releaseOwnTurnConnections(ids) }.statusCode)
        }
        assertTrue(transport.requests.isEmpty())
    }

    @Test fun `release receipt must match the same account phone and exact processed count`() = runBlocking {
        val good = """{"contractVersion":1,"accountId":"acct_1","deviceId":"adev_test","processedConnections":1,"releasedConnections":1}"""
        for (bad in listOf(good.replace("acct_1", "acct_other"), good.replace("adev_test", "adev_other"),
            good.replace("processedConnections\":1", "processedConnections\":0"), good.replace("releasedConnections\":1", "releasedConnections\":2"))) {
            val transport = RecordingTransport { ApiResponse(200, bad) }
            val session = manager(transport, transport, FakeDeviceIdentityStore(), FakeAccountCredentialStore("rac_active"), turnMetadata())
            assertEquals(502, assertFailsWith<AccountSessionException> { session.releaseOwnTurnConnections(listOf(turnId('1'))) }.statusCode)
        }
    }

    @Test fun `existing phone exception preserves normal join scope and rejects other phones or keys`() = runBlocking {
        for (kind in listOf("normal-own", "existing-other", "existing-wrong-key")) {
            val transport = RecordingTransport { error("Invalid scope must not spend RAC") }
            val identity = FakeDeviceIdentityStore(); val credentials = FakeAccountCredentialStore("rac_active")
            val metadata = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(
                "acct_1", "adev_test", "cred_1", "account-directory", "2099-01-01T00:00:00Z"))
            val manager = manager(transport, transport, identity, credentials, metadata)
            val intent = AccountJoinIntentDto("rji_test", "inst_test", if (kind == "existing-other") "adev_other" else "adev_test",
                if (kind == "existing-wrong-key") "0".repeat(64) else devicePublicKeyFingerprint(identity.publicKeyEncoded()),
                "nonce_test", "2026-08-25T00:00:00Z", "2099-01-01T00:00:00Z")
            val proof = AccountJoinAuthorizationProof("request_test", intent.nonce, intent.issuedAt, "proof")
            assertEquals(400, assertFailsWith<AccountSessionException> {
                if (kind == "normal-own") manager.authorizeAccountJoin(intent, proof) else manager.authorizeExistingEnrollment(intent, proof)
            }.statusCode)
            assertTrue(transport.requests.isEmpty()); assertEquals("rac_active", credentials.token)
        }
    }

    private val now = Instant.parse("2026-08-25T00:00:00Z")
    private val json = Json { ignoreUnknownKeys = true }

    @Test fun `account directory operations accept computer instance ids and reject path material`() = runBlocking {
        val transport = RecordingTransport { ApiResponse(200, """{"renamed":true,"revoked":true}""") }
        val credentials = FakeAccountCredentialStore("rac_active")
        val metadata = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(
            "acct_1", "adev_test", "cred_1", "account-directory", "2099-01-01T00:00:00Z"))
        val manager = manager(transport, transport, FakeDeviceIdentityStore(), credentials, metadata)
        assertTrue(manager.renameAccountDevice("inst_real_computer_123", "Office"))
        assertTrue(manager.revokeAccountDevice("inst_real_computer_123"))
        assertEquals(listOf("/v1/owner-auth/account/devices/inst_real_computer_123/rename",
            "/v1/owner-auth/account/devices/inst_real_computer_123/revoke"), transport.requests.map { it.path })
        for (bad in listOf("inst_../other", "inst_pc/other", "https://example.invalid", "inst_")) {
            assertFailsWith<AccountSessionException> { manager.renameAccountDevice(bad, "Denied") }
            assertFailsWith<AccountSessionException> { manager.revokeAccountDevice(bad) }
        }
        assertEquals(2, transport.requests.size)
        assertEquals("rac_active", credentials.token)
    }

    @Test fun `usage query validates the policy without granting extra connection slots`() = runBlocking {
        val body = """{"contractVersion":2,"asOf":"2026-08-25T00:00:00Z","subscription":{"plan":"plus","status":"active","source":"fixture"},"turn":{"policyVersion":"turn-account-quota-v1","counting":"concurrent-logical-endpoints","limits":{"phones":2,"computers":3},"used":{"phones":1,"computers":2},"remaining":{"phones":1,"computers":1},"overLimit":{"phones":false,"computers":false},"connections":{"active":2,"reserved":1,"connected":1}}}"""
        for ((response, valid) in listOf(body to true, body.replace("\"computers\":1}", "\"computers\":9}") to false,
                body.replace("turn-account-quota-v1", "unknown-policy") to false)) {
            val transport = RecordingTransport { ApiResponse(200, response) }
            val credentials = FakeAccountCredentialStore("rac_active")
            val metadata = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(
                "acct_1", "adev_test", "cred_1", "account-directory", "2099-01-01T00:00:00Z"))
            val manager = manager(transport, transport, FakeDeviceIdentityStore(), credentials, metadata)
            if (valid) assertEquals(3, manager.getAccountUsage().turn.limits.computers)
            else assertEquals("account_usage_invalid", assertFailsWith<AccountSessionException> { manager.getAccountUsage() }.code)
            assertEquals("GET", transport.requests.single().method)
            assertEquals("/v1/owner-auth/account/usage", transport.requests.single().path)
            assertEquals(null, transport.requests.single().body)
            assertEquals("rac_active", credentials.token)
        }
    }

    @Test fun `account ASR uploads raw WAV bytes and validates returned usage`() = runBlocking {
        val requestId = "8e4f76e8-7727-4d75-949b-8e110526f813"
        val audio = ByteArray(128) { (it % 127).toByte() }
        val transcript = """{"contractVersion":1,"requestId":"$requestId","text":"hello world","languageCode":"en","durationMs":1200}"""
        val usage = """{"contractVersion":1,"available":true,"policyVersion":"account-asr-monthly-v1","period":"2026-11","plan":"plus","limitMs":7200000,"usedMs":1200,"reservedMs":0,"remainingMs":7198800,"requestCount":1,"consent":{"granted":false,"policyVersion":null,"recordedAt":null}}"""
        val transport = RecordingTransport { request ->
            when {
                request.path.endsWith("/transcriptions") -> ApiResponse(200, transcript)
                request.path.endsWith("/asr/consent") && request.body?.contains("\"accept\"") == true ->
                    ApiResponse(200, """{"contractVersion":1,"policyVersion":"account-asr-openai-transcription-v3","consent":{"granted":true,"policyVersion":"account-asr-openai-transcription-v3","recordedAt":"2026-11-10T00:00:00Z"}}""")
                request.path.endsWith("/asr/consent") ->
                    ApiResponse(200, """{"contractVersion":1,"policyVersion":"account-asr-openai-transcription-v3","consent":{"granted":false,"policyVersion":null,"recordedAt":"2026-11-10T00:00:00Z"}}""")
                else -> ApiResponse(200, usage)
            }
        }
        val credentials = FakeAccountCredentialStore("rac_active")
        val metadata = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(
            "acct_1", "adev_test", "cred_1", "account-directory", "2099-01-01T00:00:00Z"))
        val manager = manager(transport, transport, FakeDeviceIdentityStore(), credentials, metadata)

        val result = manager.transcribeAccountAudio(audio, requestId)
        assertEquals("hello world", result.text)
        assertEquals("/v1/owner-auth/account/asr/transcriptions", transport.requests[0].path)
        assertEquals("audio/wav", transport.requests[0].contentType)
        assertEquals(requestId, transport.requests[0].idempotencyKey)
        assertTrue(transport.requests[0].bodyBytes!!.contentEquals(audio))
        assertEquals(null, transport.requests[0].body)

        val accountUsage = manager.getAccountAsrUsage()
        assertEquals(7_198_800L, accountUsage.remainingMs)
        assertEquals("/v1/owner-auth/account/asr/usage", transport.requests[1].path)

        val granted = manager.setAccountAsrConsent(accepted = true)
        assertTrue(granted.granted)
        assertEquals("/v1/owner-auth/account/asr/consent", transport.requests[2].path)
        assertTrue(transport.requests[2].body!!.contains("account-asr-openai-transcription-v3"))
        val revoked = manager.setAccountAsrConsent(accepted = false)
        assertEquals(false, revoked.granted)
        assertTrue(transport.requests[3].body!!.contains("\"revoke\""))
    }

    @Test
    fun `only advertised delivery recovery retries a frozen completion after transport loss`() = runBlocking {
        for ((window, status) in listOf(120_000L to 0, 0L to 0, 120_000L to 403, 120_000L to 429)) {
            var attempts = 0
            val transport = RecordingTransport { request ->
                if (request.path.endsWith("/challenge")) ApiResponse(200,
                    """{"contractVersion":2,"transactionId":"txn_1","nonce":"google_nonce","expiresAt":"2026-08-25T00:05:00Z","completionRecoveryWindowMs":$window}""")
                else {
                    if (++attempts == 1) throw ApiException(status, "delivery_failed", "Transport failed", retryable = true)
                    ApiResponse(200, """{"contractVersion":2,"accountId":"acct_1","deviceId":"adev_test","credential":{"type":"Bearer","token":"rac_recovered","credentialId":"cred_1","scope":"account-directory","expiresAt":"2099-01-01T00:00:00Z"}}""")
                }
            }
            val credentials = FakeAccountCredentialStore()
            val metadata = FakeAccountSessionMetadataStore("adev_test")
            val manager = manager(transport, transport, FakeDeviceIdentityStore(), credentials, metadata)
            val challenge = manager.createGoogleChallenge("Phone")
            if (window > 0 && status == 0) {
                manager.completeBrowserVerifiedChallenge(challenge)
                assertEquals(2, attempts)
                val requests = transport.requests.filter { it.path.endsWith("/complete") }
                assertEquals(requests[0].body, requests[1].body)
                assertEquals(requests[0].idempotencyKey, requests[1].idempotencyKey)
                assertEquals("rac_recovered", credentials.token)
            } else {
                assertFailsWith<AccountSessionException> { manager.completeBrowserVerifiedChallenge(challenge) }
                assertEquals(1, attempts)
                assertEquals(null, credentials.token)
            }
        }
    }

    @Test
    fun `target binding refusal retains phone login while account revocation clears it`() = runBlocking {
        for (code in listOf("owner_auth_binding_mismatch", "owner_auth_binding_revoked", "owner_auth_account_device_revoked")) {
            val identity = FakeDeviceIdentityStore()
            val credentials = FakeAccountCredentialStore("rac_active")
            val metadata = FakeAccountSessionMetadataStore("adev_test",
                AccountSessionMetadata("acct_1", "adev_test", "cred_1", "account-directory", "2099-01-01T00:00:00Z"))
            val transport = RecordingTransport { throw ApiException(403, code, "Denied", retryable = false) }
            val manager = manager(transport, transport, identity, credentials, metadata)
            val intent = AccountJoinIntentDto("rji_1", "inst_1", "rdev_1",
                devicePublicKeyFingerprint(identity.publicKeyEncoded()), "join_nonce", "2026-08-25T00:00:00Z",
                "2026-08-25T00:02:00Z", instanceSignature = "instance-proof")
            val error = assertFailsWith<AccountSessionException> {
                manager.authorizeAccountJoin(intent, AccountJoinAuthorizationProof("request_1", intent.nonce, intent.issuedAt, "proof"))
            }
            assertEquals(code, error.code)
            if (code == "owner_auth_account_device_revoked") {
                assertEquals(null, credentials.token); assertEquals(null, metadata.accountSession.value)
            } else {
                assertEquals("rac_active", credentials.token); assertNotNull(metadata.accountSession.value)
            }
        }
    }

    @Test fun `demo QR and password use the same isolated phone identity`() = runBlocking {
        val identity = FakeDeviceIdentityStore()
        val credentials = FakeAccountCredentialStore()
        val metadata = FakeAccountSessionMetadataStore("adev_test")
        val accountId = "acct_demo_" + "a".repeat(48)
        var challengeDeviceId = ""
        val transport = RecordingTransport { request ->
            if (request.path.endsWith("/challenge")) {
                challengeDeviceId = Json.parseToJsonElement(request.body!!).jsonObject.getValue("device").jsonObject.getValue("deviceId").jsonPrimitive.content
                ApiResponse(200, """{"contractVersion":2,"transactionId":"transaction_demo_qr","nonce":"nonce_demo_qr","expiresAt":"2099-01-01T00:00:00Z"}""")
            } else {
                val session = """{"contractVersion":2,"accountId":"$accountId","demoAccessMode":"full","deviceId":"$challengeDeviceId","credential":{"credentialId":"cred_demo_qr","token":"rac_demo_qr","scope":"account-directory","expiresAt":"2099-01-01T00:00:00Z"}}"""
                if (request.path.endsWith("/demo")) ApiResponse(200, session)
                else ApiResponse(200, """{"instanceId":"inst_protocol_test_0001","invitationId":"rpinv_protocol_test_0001","status":"APPROVED","expiresAt":${now.plusSeconds(120).toEpochMilli()},"session":$session}""")
            }
        }
        val session = manager(transport, RecordingTransport { error("No Google or target request") }, identity, credentials, metadata)
        val password = session.signInDemoAccount("review-fixture", "fixture-password-long", "Phone")
        session.clearLocalSession()
        val invitation = PairingUriDto(4, "inst_protocol_test_0001", "", "rpi_secret", now.plusSeconds(120).toString(),
            accountInvitationId = "rpinv_protocol_test_0001", accountType = "demo")
        val qr = session.acceptDesktopAccount(invitation, "Phone")
        assertEquals(password.credential.deviceId, qr.credential.deviceId)
        assertEquals("full", qr.credential.demoAccessMode)
        assertTrue(qr.credential.deviceId.startsWith("adev_demo_"))
        assertEquals("adev_test", metadata.getOrCreateAccountDeviceId(), "Google namespace stays unchanged")
        session.clearLocalSession()
        assertEquals("account_pairing_account_type_mismatch", assertFailsWith<AccountSessionException> {
            session.acceptDesktopAccount(invitation.copy(accountType = null), "Phone")
        }.code)
        assertEquals(null, credentials.token, "Legacy demo QR must not persist a normal-namespace credential")
    }

    @Test
    fun `desktop confirmation signs phone challenge and recovers issued session after process exit`() = runBlocking {
        val identity = FakeDeviceIdentityStore()
        val credentials = FakeAccountCredentialStore()
        val metadata = FakeAccountSessionMetadataStore("adev_test")
        val journal = MemoryAccountPairingJournal()
        val invitation = PairingUriDto(4, "inst_protocol_test_0001", "", "rpi_qr_secret", "2026-08-25T00:02:00Z",
            accountInvitationId = "rpinv_protocol_test_0001")
        var approved = false
        var challengeCount = 0
        var claimCount = 0
        val transport = RecordingTransport { request ->
            assertTrue(request.headers.isEmpty(), "Account exchange must not send a bearer")
            if (request.path.endsWith("/challenge")) {
                challengeCount++
                ApiResponse(200, """{"contractVersion":2,"transactionId":"txn_1","nonce":"challenge_nonce","expiresAt":"2026-08-25T00:05:00Z"}""")
            } else {
                val input = json.parseToJsonElement(request.body!!).jsonObject
                val payload = input.getValue("payload").jsonObject
                val action = request.path.substringAfterLast('/')
                verifySignature(identity, buildAccountPairingProof(action, invitation.instanceId, invitation.accountInvitationId!!,
                    input.getValue("issuedAt").jsonPrimitive.longOrNull!!, input.getValue("nonce").jsonPrimitive.content, payload),
                    input.getValue("signature").jsonPrimitive.content)
                if (action == "claim") {
                    claimCount++
                    val challenge = requireNotNull(journal.read()).challenge
                    assertEquals(invitation.token, payload.getValue("token").jsonPrimitive.content)
                    verifySignature(identity, buildAccountSessionCompleteMessage(challenge.transactionId, challenge.requestId,
                        challenge.deviceId, challenge.publicKeyFingerprint, challenge.nonce), payload.getValue("deviceSignature").jsonPrimitive.content)
                }
                val session = if (approved) """, "session":{"contractVersion":2,"accountId":"acct_pc","deviceId":"adev_test","credential":{"credentialId":"cred_pc","token":"rac_phone_own","scope":"account-directory","expiresAt":"2099-01-01T00:00:00Z"}}""" else ""
                ApiResponse(200, """{"instanceId":"${invitation.instanceId}","invitationId":"${invitation.accountInvitationId}","status":"${if (approved) "APPROVED" else "CLAIMED"}","expiresAt":${now.plusSeconds(120).toEpochMilli()}$session}""")
            }
        }
        val authenticated = RecordingTransport { error("Google or directory calls are not needed") }
        val first = manager(transport, authenticated, identity, credentials, metadata, pairingJournal = journal,
            pollDelay = { throw CancellationException("Phone process left") })
        assertFailsWith<CancellationException> { first.acceptDesktopAccount(invitation, "Phone") }
        assertEquals(null, credentials.token)
        approved = true
        val restored = manager(transport, authenticated, identity, credentials, metadata, pairingJournal = journal)
        assertEquals("acct_pc", restored.acceptDesktopAccount(invitation, "Phone").accountId)
        assertEquals("rac_phone_own", credentials.token)
        assertEquals(1, challengeCount); assertEquals(1, claimCount)
        assertEquals(null, journal.read())
        assertTrue(transport.requests.none { it.path.endsWith("/complete") || it.body.orEmpty().contains("idToken") })
    }

    @Test
    fun `desktop exchange rejects another source before saving a credential`() = runBlocking {
        val credentials = FakeAccountCredentialStore()
        val transport = RecordingTransport { request ->
            if (request.path.endsWith("/challenge")) ApiResponse(200,
                """{"contractVersion":2,"transactionId":"txn_1","nonce":"nonce","expiresAt":"2026-08-25T00:05:00Z"}""")
            else ApiResponse(200, """{"instanceId":"inst_other_0000001","invitationId":"rpinv_protocol_test_0001","status":"CLAIMED","expiresAt":${now.plusSeconds(120).toEpochMilli()}}""")
        }
        val manager = manager(transport, transport, FakeDeviceIdentityStore(), credentials, FakeAccountSessionMetadataStore("adev_test"))
        val invitation = PairingUriDto(4, "inst_protocol_test_0001", "", "rpi_secret", "2026-08-25T00:02:00Z",
            accountInvitationId = "rpinv_protocol_test_0001")
        assertEquals("account_pairing_response_invalid", assertFailsWith<AccountSessionException> {
            manager.acceptDesktopAccount(invitation, "Phone") }.code)
        assertEquals(null, credentials.token)
    }

    @Test
    fun `default device alias is stable and key-derived rather than model-derived`() {
        val first = FakeDeviceIdentityStore()
        val second = FakeDeviceIdentityStore()

        assertEquals(first.defaultDeviceAlias(), first.defaultDeviceAlias())
        assertTrue(first.defaultDeviceAlias().startsWith("Android-"))
        assertNotEquals(first.defaultDeviceAlias(), second.defaultDeviceAlias())
    }

    @Test
    fun `challenge and complete bind Google nonce to the keystore proof and persist only rac separately`() = runBlocking {
        val anonymous = RecordingTransport { request ->
            when (request.path) {
                "/v1/owner-auth/native/session/challenge" -> ApiResponse(
                    200,
                    """{"contractVersion":2,"transactionId":"txn_1","nonce":"google_nonce","expiresAt":"2026-08-25T00:05:00Z"}""",
                )
                "/v1/owner-auth/native/session/complete" -> ApiResponse(
                    200,
                    """{"contractVersion":2,"accountId":"acct_1","deviceId":"adev_test","credential":{"type":"Bearer","token":"rac_issued_once","credentialId":"cred_1","scope":"account-directory","expiresAt":"2099-01-01T00:00:00Z"}}""",
                )
                else -> error("Unexpected anonymous request: ${request.path}")
            }
        }
        val authenticated = RecordingTransport { error("No authenticated call expected") }
        val identity = FakeDeviceIdentityStore()
        val credentials = FakeAccountCredentialStore()
        val metadata = FakeAccountSessionMetadataStore(deviceId = "adev_test")
        val manager = manager(anonymous, authenticated, identity, credentials, metadata)

        val challenge = manager.createGoogleChallenge("Pixel Test")
        val result = manager.completeGoogleChallenge(challenge, "google-id-token")

        assertEquals("rac_issued_once", credentials.token)
        assertEquals("cred_1", metadata.accountSession.value?.credentialId)
        assertEquals("account-directory", metadata.accountSession.value?.scope)
        assertEquals("acct_1", result.accountId)
        assertTrue(authenticated.requests.isEmpty(), "Session challenge/complete must not attach rac_")

        val challengeRequest = anonymous.requests[0]
        assertEquals("/v1/owner-auth/native/session/challenge", challengeRequest.path)
        val challengeBody = json.parseToJsonElement(challengeRequest.body!!).jsonObject
        assertEquals(challenge.requestId, challengeBody["requestId"]?.jsonPrimitive?.contentOrNull)
        assertEquals("adev_test", challengeBody["device"]?.jsonObject?.get("deviceId")?.jsonPrimitive?.contentOrNull)
        assertEquals(identity.publicKeyEncoded(), challengeBody["device"]?.jsonObject?.get("publicKey")?.jsonPrimitive?.contentOrNull)

        val completeRequest = anonymous.requests[1]
        val completeBody = json.parseToJsonElement(completeRequest.body!!).jsonObject
        assertEquals("google-id-token", completeBody["idToken"]?.jsonPrimitive?.contentOrNull)
        verifySignature(
            identity,
            buildAccountSessionCompleteMessage(
                transactionId = challenge.transactionId,
                requestId = challenge.requestId,
                deviceId = challenge.deviceId,
                publicKeyFingerprint = challenge.publicKeyFingerprint,
                nonce = challenge.nonce,
            ),
            completeBody["signature"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun `expired account credential refreshes with a signed proof and does not call Google`() = runBlocking {
        val anonymous = RecordingTransport { request ->
            assertEquals("/v1/owner-auth/native/session/refresh", request.path)
            ApiResponse(
                200,
                """{"credential":{"type":"Bearer","token":"rac_rotated","credentialId":"cred_2","scope":"account-directory","expiresAt":"2099-01-01T00:00:00Z"}}""",
            )
        }
        val authenticated = RecordingTransport { error("Refresh must not attach or use a stale rac") }
        val identity = FakeDeviceIdentityStore()
        val credentials = FakeAccountCredentialStore("rac_stale")
        val metadata = FakeAccountSessionMetadataStore(
            deviceId = "adev_test",
            initial = AccountSessionMetadata("acct_1", "adev_test", "cred_1", "account-directory", "2026-08-24T23:59:00Z"),
        )
        val manager = manager(anonymous, authenticated, identity, credentials, metadata, randomNonce = { "refresh_nonce" })

        val refreshed = manager.ensureActiveCredential()

        assertEquals("rac_rotated", refreshed.token)
        assertEquals("cred_2", metadata.accountSession.value?.credentialId)
        val body = json.parseToJsonElement(anonymous.requests.single().body!!).jsonObject
        assertEquals("cred_1", body["credentialId"]?.jsonPrimitive?.contentOrNull)
        assertEquals("refresh_nonce", body["nonce"]?.jsonPrimitive?.contentOrNull)
        verifySignature(
            identity,
            buildAccountSessionRefreshMessage(
                credentialId = "cred_1",
                deviceId = "adev_test",
                requestId = body["requestId"]!!.jsonPrimitive.content,
                issuedAt = body["issuedAt"]!!.jsonPrimitive.content,
                nonce = "refresh_nonce",
            ),
            body["signature"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun `missing rac clears otherwise plausible metadata instead of reporting an active account session`() = runBlocking {
        val anonymous = RecordingTransport { error("No request is valid without rac_") }
        val authenticated = RecordingTransport { error("No request is valid without rac_") }
        val credentials = FakeAccountCredentialStore()
        val metadata = FakeAccountSessionMetadataStore(
            deviceId = "adev_test",
            initial = AccountSessionMetadata("acct_1", "adev_test", "cred_1", "account-directory", "2099-01-01T00:00:00Z"),
        )
        val manager = manager(anonymous, authenticated, FakeDeviceIdentityStore(), credentials, metadata)

        val error = assertFailsWith<AccountSessionException> { manager.ensureActiveCredential() }

        assertEquals(401, error.statusCode)
        assertEquals(null, credentials.token)
        assertEquals(null, metadata.accountSession.value)
        assertTrue(anonymous.requests.isEmpty())
        assertTrue(authenticated.requests.isEmpty())
    }

    @Test
    fun `logout revokes only the current rac and clears local session`() = runBlocking {
        val anonymous = RecordingTransport { error("Logout must use the authenticated Accounts transport") }
        val authenticated = RecordingTransport { request ->
            assertEquals("/v1/owner-auth/account/session/logout", request.path)
            ApiResponse(
                200,
                """{"contractVersion":2,"loggedOut":true,"accountId":"acct_1","deviceId":"adev_test","unboundAt":"2026-08-25T00:00:00Z"}""",
            )
        }
        val credentials = FakeAccountCredentialStore("rac_active")
        val metadata = FakeAccountSessionMetadataStore(
            deviceId = "adev_test",
            initial = AccountSessionMetadata("acct_1", "adev_test", "cred_1", "account-directory", "2099-01-01T00:00:00Z"),
        )
        val manager = manager(anonymous, authenticated, FakeDeviceIdentityStore(), credentials, metadata)

        assertTrue(manager.logoutAccountSession())

        assertEquals(null, credentials.token)
        assertEquals(null, metadata.accountSession.value)
        assertEquals(1, authenticated.requests.size)
        assertTrue(authenticated.requests.single().body?.contains("rac_active") != true)
    }

    @Test
    fun `rejected refresh clears rac and metadata so the UI must require authorization`() = runBlocking {
        val anonymous = RecordingTransport {
            throw ApiException(401, "account_credential_revoked", "revoked")
        }
        val authenticated = RecordingTransport { error("No authenticated request expected") }
        val credentials = FakeAccountCredentialStore("rac_revoked")
        val metadata = FakeAccountSessionMetadataStore(
            deviceId = "adev_test",
            initial = AccountSessionMetadata("acct_1", "adev_test", "cred_1", "account-directory", "2026-08-24T23:59:00Z"),
        )
        val manager = manager(anonymous, authenticated, FakeDeviceIdentityStore(), credentials, metadata)

        val error = assertFailsWith<AccountSessionException> { manager.ensureActiveCredential() }

        assertEquals(401, error.statusCode)
        assertEquals(null, credentials.token)
        assertEquals(null, metadata.accountSession.value)
    }

    @Test
    fun `account join authorization uses rac only at Accounts and returns a bound one time grant`() = runBlocking {
        val anonymous = RecordingTransport { error("No anonymous request expected") }
        val authenticated = RecordingTransport { request ->
            assertEquals("/v1/owner-auth/account-intents/rji_1/authorize", request.path)
            ApiResponse(
                200,
                """{"accountJoinGrant":"raj_once","expiresAt":"2099-01-01T00:00:00Z","intentId":"rji_1","instanceId":"inst_1","deviceId":"rdev_1"}""",
            )
        }
        val identity = FakeDeviceIdentityStore()
        val credentials = FakeAccountCredentialStore("rac_active")
        val metadata = FakeAccountSessionMetadataStore(
            deviceId = "adev_test",
            initial = AccountSessionMetadata("acct_1", "adev_test", "cred_1", "account-directory", "2099-01-01T00:00:00Z"),
        )
        val manager = manager(anonymous, authenticated, identity, credentials, metadata)
        val intent = AccountJoinIntentDto(
            intentId = "rji_1",
            instanceId = "inst_1",
            deviceId = "rdev_1",
            devicePublicKeyFingerprint = devicePublicKeyFingerprint(identity.publicKeyEncoded()),
            nonce = "join_nonce",
            issuedAt = "2026-08-25T00:00:00Z",
            expiresAt = "2026-08-25T00:02:00Z",
            instanceSignature = "instance-proof",
        )
        val signature = identity.sign(buildAccountJoinIntentMessage(
            instanceId = intent.instanceId,
            intentId = intent.intentId,
            deviceId = intent.deviceId,
            devicePublicKeyFingerprint = intent.devicePublicKeyFingerprint,
            nonce = intent.nonce,
            issuedAt = intent.issuedAt,
        ))

        val grant = manager.authorizeAccountJoin(
            intent,
            AccountJoinAuthorizationProof("request_1", intent.nonce, intent.issuedAt, signature),
        )

        assertEquals("raj_once", grant.accountJoinGrant)
        assertEquals("rac_active", credentials.token)
        val body = json.parseToJsonElement(authenticated.requests.single().body!!).jsonObject
        assertEquals("request_1", body["requestId"]?.jsonPrimitive?.contentOrNull)
        assertEquals("rdev_1", body["deviceId"]?.jsonPrimitive?.contentOrNull)
        assertEquals(signature, body["deviceSignature"]?.jsonPrimitive?.contentOrNull)
        verifySignature(
            identity,
            buildAccountJoinIntentMessage(
                instanceId = intent.instanceId,
                intentId = intent.intentId,
                deviceId = intent.deviceId,
                devicePublicKeyFingerprint = intent.devicePublicKeyFingerprint,
                nonce = intent.nonce,
                issuedAt = intent.issuedAt,
            ),
            signature,
        )
    }

    @Test
    fun `rendezvous carries the QR claim and verified target identity without endpoint`() = runBlocking {
        val target = AccountRendezvousTargetInstanceDto(
            instanceId = "inst_target",
            publicKey = "target-public-key",
            keyFingerprint = "target-fingerprint",
        )
        val identity = FakeDeviceIdentityStore()
        val phoneFingerprint = devicePublicKeyFingerprint(identity.publicKeyEncoded())
        var rendezvousRequestId = ""
        var resultPollCount = 0
        val delays = mutableListOf<Long>()
        val anonymous = RecordingTransport { error("Rendezvous must use the authenticated Accounts transport") }
        val authenticated = RecordingTransport { request ->
            when (request.path) {
                "/v1/owner-auth/rendezvous" -> ApiResponse(
                    201,
                    """{"intent":{"intentId":"rji_rendezvous","instanceId":"inst_target","deviceId":"adev_test","devicePublicKeyFingerprint":"$phoneFingerprint","nonce":"rnonce","issuedAt":"2026-08-25T00:00:00Z","expiresAt":"2099-01-01T00:00:00Z","instancePublicKey":"target-public-key","instanceKeyFingerprint":"target-fingerprint","requestId":""}}""",
                )
                "/v1/owner-auth/account-intents/rji_rendezvous/authorize" -> ApiResponse(
                    200,
                    """{"accountJoinGrant":"raj_rendezvous","expiresAt":"2099-01-01T00:00:00Z","intentId":"rji_rendezvous","instanceId":"inst_target","deviceId":"adev_test"}""",
                )
                else -> {
                    if (request.path.endsWith("/grant")) {
                        rendezvousRequestId = request.path.removePrefix("/v1/owner-auth/rendezvous/").removeSuffix("/grant")
                        ApiResponse(200, "{}")
                    } else if (request.path.endsWith("/result")) {
                        resultPollCount += 1
                        if (resultPollCount == 1) {
                            throw AccountSessionException(
                                statusCode = 429,
                                code = "owner_auth_rate_limited",
                                message = "busy",
                                retryable = true,
                                retryAfterMs = 7_000L,
                            )
                        }
                        ApiResponse(
                            200,
                            if (resultPollCount == 2) {
                                """{"result":null}"""
                            } else {
                                """{"result":{"credential":{"type":"Bearer","token":"rda_rendezvous","expiresAt":"2099-01-01T00:00:00Z","scope":"device-access"}}}"""
                            },
                        )
                    } else error("Unexpected rendezvous request: ${request.path}")
                }
            }
        }
        val manager = manager(
            anonymous,
            authenticated,
            identity,
            FakeAccountCredentialStore("rac_active"),
            FakeAccountSessionMetadataStore(
                deviceId = "adev_test",
                initial = AccountSessionMetadata("acct_1", "adev_test", "cred_1", "account-directory", "2099-01-01T00:00:00Z"),
            ),
            pollDelay = { delays += it },
        )

        val handoff = manager.rendezvous("inst_target", "Pixel", "rpi_claim", target, "Living room PC")

        assertEquals("adev_test", handoff.intent.deviceId)
        val create = json.parseToJsonElement(authenticated.requests[0].body!!).jsonObject
        assertEquals("inst_target", create["targetInstanceId"]?.jsonPrimitive?.contentOrNull)
        assertEquals("rpi_claim", create["accountClaimToken"]?.jsonPrimitive?.contentOrNull)
        assertEquals("Living room PC", create["computerAlias"]?.jsonPrimitive?.contentOrNull)
        assertEquals("target-public-key", create["targetInstance"]?.jsonObject?.get("publicKey")?.jsonPrimitive?.contentOrNull)
        assertEquals(6, authenticated.requests.size)
        assertEquals(3, resultPollCount)
        assertEquals(listOf(7_000L, 5_000L), delays)
        assertTrue(rendezvousRequestId.isNotBlank())
    }

    @Test fun `advertised atomic rendezvous publication skips redundant grant submission`() = runBlocking {
        val identity = FakeDeviceIdentityStore()
        val fingerprint = devicePublicKeyFingerprint(identity.publicKeyEncoded())
        val transport = RecordingTransport { request ->
            when {
                request.path == "/v1/owner-auth/rendezvous" -> ApiResponse(201,
                    """{"intent":{"intentId":"rji_atomic","instanceId":"inst_target","deviceId":"adev_test","devicePublicKeyFingerprint":"$fingerprint","nonce":"rnonce","issuedAt":"2026-08-25T00:00:00Z","expiresAt":"2099-01-01T00:00:00Z"}}""")
                request.path.endsWith("/authorize") -> ApiResponse(200,
                    """{"accountJoinGrant":"raj_atomic","expiresAt":"2099-01-01T00:00:00Z","intentId":"rji_atomic","instanceId":"inst_target","deviceId":"adev_test","rendezvousGrantSubmitted":true}""")
                request.path.endsWith("/result") -> ApiResponse(200, """{"result":{"ready":true}}""")
                else -> error("A published grant must not be submitted again: ${request.path}")
            }
        }
        val metadata = FakeAccountSessionMetadataStore("adev_test", AccountSessionMetadata(
            "acct_1", "adev_test", "cred_1", "account-directory", "2099-01-01T00:00:00Z"))
        val handoff = manager(transport, transport, identity, FakeAccountCredentialStore("rac_active"), metadata)
            .rendezvous("inst_target", "Phone")
        assertEquals("inst_target", handoff.intent.instanceId)
        assertEquals(3, transport.requests.size)
        assertTrue(transport.requests.none { it.path.endsWith("/grant") })
        val resultBody = Json.parseToJsonElement(requireNotNull(transport.requests.single {
            it.path.endsWith("/result")
        }.body)).jsonObject
        assertEquals(10_000L, resultBody["waitMs"]?.jsonPrimitive?.longOrNull)
        assertEquals(handoff.requestId, resultBody["requestId"]?.jsonPrimitive?.contentOrNull)
        assertNotNull(metadata.accountSession.value)
        Unit
    }

    @Test fun `intent creation overlaps cleanup but authorization cannot pass its barrier`() = runBlocking {
        val cleanupEntered = CompletableDeferred<Unit>()
        val finishCleanup = CompletableDeferred<Unit>()
        val created = CompletableDeferred<Unit>()
        val (manager, transport) = grantBarrierFixture(beforeGrant = {
            cleanupEntered.complete(Unit); finishCleanup.await()
        }, beforeCreateReply = { _, _ -> created.complete(Unit) })
        val pending = async { manager.rendezvous("inst_primary", "Phone") }
        try {
            withTimeout(1_000) { cleanupEntered.await() }
            withTimeout(500) { created.await() }
            assertEquals(1, transport.requests.count { it.path == "/v1/owner-auth/rendezvous" })
            assertTrue(transport.requests.none { it.path.endsWith("/authorize") || it.path.endsWith("/grant") })
            finishCleanup.complete(Unit)
            assertEquals("inst_primary", withTimeout(1_000) { pending.await() }.intent.instanceId)
            assertEquals(3, transport.requests.size)
        } finally {
            pending.cancel(); finishCleanup.complete(Unit)
            withContext(NonCancellable) { pending.join() }
        }
    }

    @Test fun `cancellation and a late creation response cannot authorize its intent`() = runBlocking {
        val createEntered = CompletableDeferred<Unit>()
        val lateResponse = CompletableDeferred<Unit>()
        val (manager, transport) = grantBarrierFixture(beforeCreateReply = { _, _ ->
            createEntered.complete(Unit)
            withContext(NonCancellable) { lateResponse.await() }
        })
        val pending = async { manager.rendezvous("inst_primary", "Phone") }
        try {
            withTimeout(1_000) { createEntered.await() }
            pending.cancel(); lateResponse.complete(Unit)
            withTimeout(1_000) { pending.join() }
            assertTrue(pending.isCancelled)
            assertTrue(transport.requests.none { it.path.endsWith("/authorize") || it.path.endsWith("/grant") || it.path.endsWith("/result") })
        } finally {
            pending.cancel(); lateResponse.complete(Unit)
            withContext(NonCancellable) { pending.join() }
        }
    }

    @Test fun `two targets can create while sharing one exact-ID cleanup before either grant`() = runBlocking {
        val cleanupEntered = CompletableDeferred<Unit>()
        val finishCleanup = CompletableDeferred<Unit>()
        val bothCreated = CompletableDeferred<Unit>()
        val oldId = "turn_${"a".repeat(32)}_1790000000000_${"b".repeat(32)}"
        var reads = 0
        val released = mutableListOf<List<String>>()
        val client = object : AccountTurnLeaseClient {
            override suspend fun listOwnTurnConnections(afterConnectionId: String?): AccountTurnConnectionsPage {
                reads++
                return AccountTurnConnectionsPage(1, "acct_1", "adev_test", now.toString(),
                    listOf(AccountTurnConnection(oldId, "inst_old", "rdev_old", "2099-01-01T00:00:00Z")))
            }
            override suspend fun releaseOwnTurnConnections(connectionIds: List<String>, reason: String): AccountTurnConnectionsRelease {
                released += connectionIds
                cleanupEntered.complete(Unit); finishCleanup.await()
                return AccountTurnConnectionsRelease(1, "acct_1", "adev_test", 1, 1)
            }
        }
        val recovery = ColdTurnLeaseRecovery(client)
        val (manager, transport) = grantBarrierFixture(beforeGrant = { recovery.beforeNewReservations() },
            beforeCreateReply = { _, sequence -> if (sequence == 2) bothCreated.complete(Unit) })
        val primary = async { manager.rendezvous("inst_primary", "Phone") }
        val background = async { manager.rendezvous("inst_background", "Phone") }
        try {
            withTimeout(1_000) { cleanupEntered.await() }
            withTimeout(500) { bothCreated.await() }
            assertEquals(1, reads)
            assertEquals(listOf(listOf(oldId)), released)
            assertTrue(transport.requests.none { it.path.endsWith("/authorize") || it.path.endsWith("/grant") })
            finishCleanup.complete(Unit)
            val targets = withTimeout(1_000) { listOf(primary.await().intent.instanceId, background.await().intent.instanceId) }
            assertEquals(listOf("inst_primary", "inst_background"), targets)
            assertEquals(2, transport.requests.count { it.path == "/v1/owner-auth/rendezvous" })
            assertEquals(2, transport.requests.count { it.path.endsWith("/authorize") })
            assertEquals(0, transport.requests.count { it.path.endsWith("/grant") })
            assertEquals(1, reads)
        } finally {
            primary.cancel(); background.cancel(); finishCleanup.complete(Unit)
            withContext(NonCancellable) { primary.join(); background.join() }
        }
    }

    @Test fun `escaping cleanup failure never authorizes and preserves its error`() = runBlocking {
        val failure = IllegalStateException("synthetic cleanup failure")
        val (manager, transport) = grantBarrierFixture(beforeGrant = { throw failure })
        val actual = assertFailsWith<IllegalStateException> { manager.rendezvous("inst_primary", "Phone") }
        assertEquals(failure.message, actual.message)
        // Coroutine stack recovery may copy a Throwable; preserve its type,
        // message and original cause rather than requiring wrapper identity.
        assertTrue(generateSequence<Throwable>(actual) { it.cause }.take(8).any { it === failure })
        assertTrue(transport.requests.none { it.path.endsWith("/authorize") || it.path.endsWith("/grant") || it.path.endsWith("/result") })
    }

    @Test fun `creation failure cancels speculative cleanup without retrying or changing the error`() = runBlocking {
        val stopped = CompletableDeferred<Unit>()
        val failure = AccountSessionException(503, "synthetic_create_rejected", "synthetic create failure")
        val (manager, transport) = grantBarrierFixture(beforeGrant = {
            try { CompletableDeferred<Unit>().await() } finally { stopped.complete(Unit) }
        }, beforeCreateReply = { _, _ -> throw failure })
        val actual = assertFailsWith<AccountSessionException> {
            withTimeout(500) { manager.rendezvous("inst_primary", "Phone") }
        }
        assertTrue(actual === failure)
        withTimeout(500) { stopped.await() }
        assertEquals(1, transport.requests.size)
    }

    @Test fun `cleanup waiting cannot extend the original monotonic window after a wall rollback`() = runBlocking {
        val created = CompletableDeferred<Unit>()
        var elapsed = 0L
        var wall = now
        val (manager, transport) = grantBarrierFixture(beforeGrant = {
            created.await(); elapsed = 120_001L; wall = now.minusSeconds(300)
        }, beforeCreateReply = { _, _ -> created.complete(Unit) },
            monotonicMillis = { elapsed }, wallClock = { wall })
        val failure = assertFailsWith<AccountSessionException> { manager.rendezvous("inst_primary", "Phone") }
        assertEquals("owner_auth_rendezvous_timeout", failure.code)
        assertEquals(408, failure.statusCode)
        assertEquals(1, transport.requests.size)
    }

    @Test fun `cleanup waiting cannot authorize past the server intent expiry`() = runBlocking {
        val created = CompletableDeferred<Unit>()
        var wall = now
        val (manager, transport) = grantBarrierFixture(beforeGrant = {
            created.await(); wall = now.plusSeconds(2)
        }, beforeCreateReply = { _, _ -> created.complete(Unit) },
            wallClock = { wall }, intentExpiry = now.plusSeconds(1).toString())
        val failure = assertFailsWith<AccountSessionException> { manager.rendezvous("inst_primary", "Phone") }
        assertEquals("owner_auth_rendezvous_timeout", failure.code)
        assertEquals(1, transport.requests.size)
    }

    @Test fun `pending rendezvous retains five second pacing and original attempt bound`() = runBlocking {
        var elapsed = 0L
        var polls = 0
        val delays = mutableListOf<Long>()
        val manager = pollingManager(
            onResult = { polls += 1; ApiResponse(200, """{"result":null}""") },
            pollDelay = { delays += it; elapsed += it },
            monotonicMillis = { elapsed },
        )
        val error = assertFailsWith<AccountSessionException> { manager.rendezvous("inst_target", "Phone") }
        assertEquals(408, error.statusCode)
        assertEquals(115_000L, elapsed)
        assertEquals(24, polls)
        assertEquals(List(23) { 5_000L }, delays)
    }

    @Test fun `server intent deadline bounds the normal five second delay`() = runBlocking {
        var elapsed = 0L
        var polls = 0
        val manager = pollingManager(
            onResult = { polls += 1; ApiResponse(200, """{"result":null}""") },
            pollDelay = { elapsed += it }, monotonicMillis = { elapsed },
            expiresAt = now.plusSeconds(2).toString(),
        )
        assertEquals(408, assertFailsWith<AccountSessionException> {
            manager.rendezvous("inst_target", "Phone")
        }.statusCode)
        assertEquals(1, polls)
        assertEquals(2_000L, elapsed)
    }

    @Test fun `late successful response is not accepted after monotonic deadline`() = runBlocking {
        var elapsed = 0L
        var polls = 0
        val manager = pollingManager(
            onResult = { polls += 1; elapsed = 120_001L; ApiResponse(200, """{"result":{"ready":true}}""") },
            pollDelay = {}, monotonicMillis = { elapsed },
        )
        assertEquals(408, assertFailsWith<AccountSessionException> {
            manager.rendezvous("inst_target", "Phone")
        }.statusCode)
        assertEquals(1, polls)
    }

    @Test fun `clock rollback does not extend polling or bypass rate limit cooldown`() = runBlocking {
        var elapsed = 0L
        var wall = now
        var polls = 0
        val delays = mutableListOf<Long>()
        val manager = pollingManager(
            onResult = {
                polls += 1
                if (polls == 1) ApiResponse(200, """{"result":null}""")
                else throw AccountSessionException(429, "owner_auth_rate_limited", "busy", true, 60_000L)
            },
            pollDelay = { delays += it; elapsed += it; wall = wall.minusSeconds(300) },
            monotonicMillis = { elapsed }, wallClock = { wall },
        )
        val failure = assertFailsWith<AccountSessionException> {
            manager.rendezvous("inst_target", "Phone")
        }
        assertEquals(429, failure.statusCode)
        assertEquals(60_000L, failure.retryAfterMs)
        assertEquals(listOf(5_000L, 60_000L), delays)
        assertEquals(3, polls, "no request may follow the expired intent even after the cooldown")
    }

    @Test fun `rendezvous quota rejection is returned without polling again`() = runBlocking {
        for (code in listOf("turn_connection_quota_exceeded", "turn_quota_exceeded")) {
            var polls = 0
            val delays = mutableListOf<Long>()
            val manager = pollingManager(
                onResult = { polls++; throw AccountSessionException(429, code, "quota", true) },
                pollDelay = { delays += it }, monotonicMillis = { 0L },
            )
            val failure = assertFailsWith<AccountSessionException> { manager.rendezvous("inst_target", "Phone") }
            assertEquals(code, failure.code)
            assertEquals(1, polls)
            assertTrue(delays.isEmpty())
        }
    }

    @Test fun `rendezvous setup quota rejection is returned without retry`() = runBlocking {
        val identity = FakeDeviceIdentityStore()
        var creates = 0
        val delays = mutableListOf<Long>()
        val transport = RecordingTransport {
            creates++
            throw AccountSessionException(429, "turn_connection_quota_exceeded", "quota", true)
        }
        val manager = manager(transport, transport, identity, FakeAccountCredentialStore("rac_active"), turnMetadata(),
            pollDelay = { delays += it }, monotonicMillis = { 0L })
        val failure = assertFailsWith<AccountSessionException> { manager.rendezvous("inst_target", "Phone") }
        assertEquals("turn_connection_quota_exceeded", failure.code)
        assertEquals(1, creates)
        assertTrue(delays.isEmpty())
    }

    @Test fun `a cooldown longer than the intent is propagated without an early retry`() = runBlocking {
        var polls = 0
        val delays = mutableListOf<Long>()
        val manager = pollingManager(
            onResult = {
                polls += 1
                throw AccountSessionException(429, "owner_auth_rate_limited", "busy", true, 180_000L)
            },
            pollDelay = { delays += it }, monotonicMillis = { 0L },
        )
        val failure = assertFailsWith<AccountSessionException> { manager.rendezvous("inst_target", "Phone") }
        assertEquals(429, failure.statusCode)
        assertEquals(180_000L, failure.retryAfterMs)
        assertEquals(1, polls)
        assertTrue(delays.isEmpty())
    }

    @Test fun `setup rate limit beyond the budget does not start another intent`() = runBlocking {
        val identity = FakeDeviceIdentityStore()
        var creates = 0
        val delays = mutableListOf<Long>()
        val traces = mutableListOf<String>()
        val transport = RecordingTransport { request ->
            assertEquals("/v1/owner-auth/rendezvous", request.path)
            creates++
            throw AccountSessionException(429, "owner_auth_rate_limited", "busy", true, 180_000L)
        }
        val manager = manager(transport, transport, identity, FakeAccountCredentialStore("rac_active"), turnMetadata(),
            pollDelay = { delays += it }, monotonicMillis = { 0L }, rendezvousTrace = { _, event -> traces += event })
        val failure = assertFailsWith<AccountSessionException> { manager.rendezvous("inst_target", "Phone") }
        assertEquals(429, failure.statusCode)
        assertEquals(180_000L, failure.retryAfterMs)
        assertEquals(1, creates)
        assertTrue(delays.isEmpty())
        assertTrue("intent-create-rate-limited" in traces)
    }

    @Test fun `a long cooldown that fits is never shortened`() = runBlocking {
        var elapsed = 0L
        var polls = 0
        val delays = mutableListOf<Long>()
        val manager = pollingManager(onResult = {
            if (++polls == 1) throw AccountSessionException(429, "owner_auth_rate_limited", "busy", true, 70_000L)
            ApiResponse(200, """{"result":{"ready":true}}""")
        }, pollDelay = { delays += it; elapsed += it }, monotonicMillis = { elapsed })
        manager.rendezvous("inst_target", "Phone")
        assertEquals(listOf(70_000L), delays)
        assertEquals(2, polls)
    }

    @Test fun `authorization preserves throttling when cooldown exceeds intent expiry`() = runBlocking {
        val identity = FakeDeviceIdentityStore()
        val fingerprint = devicePublicKeyFingerprint(identity.publicKeyEncoded())
        var authorizations = 0
        val delays = mutableListOf<Long>()
        val transport = RecordingTransport { request -> when {
            request.path == "/v1/owner-auth/rendezvous" -> ApiResponse(201,
                """{"intent":{"intentId":"rji_timing","instanceId":"inst_target","deviceId":"adev_test","devicePublicKeyFingerprint":"$fingerprint","nonce":"rnonce","issuedAt":"2026-08-25T00:00:00Z","expiresAt":"${now.plusSeconds(2)}"}}""")
            request.path.endsWith("/authorize") -> {
                authorizations++
                throw AccountSessionException(429, "owner_auth_rate_limited", "busy", true, 3_000L)
            }
            else -> error("Unexpected authorization fixture request")
        } }
        val manager = manager(transport, transport, identity, FakeAccountCredentialStore("rac_active"), turnMetadata(),
            pollDelay = { delays += it }, monotonicMillis = { 0L })
        val failure = assertFailsWith<AccountSessionException> { manager.rendezvous("inst_target", "Phone") }
        assertEquals(429, failure.statusCode)
        assertEquals(3_000L, failure.retryAfterMs)
        assertEquals(1, authorizations)
        assertTrue(delays.isEmpty())
    }

    @Test fun `missing retry hint retains the previous five second cooldown`() = runBlocking {
        var elapsed = 0L
        var polls = 0
        val delays = mutableListOf<Long>()
        val manager = pollingManager(
            onResult = {
                polls += 1
                if (polls == 1) throw AccountSessionException(429, "owner_auth_rate_limited", "busy", true)
                ApiResponse(200, """{"result":{"ready":true}}""")
            },
            pollDelay = { delays += it; elapsed += it }, monotonicMillis = { elapsed },
        )
        manager.rendezvous("inst_target", "Phone")
        assertEquals(listOf(5_000L), delays)
        assertEquals(2, polls)
    }

    @Test fun `recognized actual long wait replaces delay without increasing request cadence`() = runBlocking {
        var elapsed = 0L
        var polls = 0
        val delays = mutableListOf<Long>()
        val manager = pollingManager(onResult = {
            polls += 1
            if (polls == 1) {
                elapsed += 10_000L
                ApiResponse(200, """{"result":null,"resultWaitVersion":1}""")
            } else ApiResponse(200, """{"result":{"ready":true}}""")
        }, pollDelay = { delays += it; elapsed += it }, monotonicMillis = { elapsed })
        manager.rendezvous("inst_target", "Phone")
        assertEquals(2, polls)
        assertEquals(10_000L, elapsed)
        assertTrue(delays.isEmpty())
    }

    @Test fun `early acknowledged waits and old servers retain five second pacing`() = runBlocking {
        for (version in listOf("", ",\"resultWaitVersion\":1")) {
            var elapsed = 0L
            var polls = 0
            val delays = mutableListOf<Long>()
            val manager = pollingManager(onResult = {
                polls += 1
                if (polls == 1) ApiResponse(200, """{"result":null$version}""")
                else ApiResponse(200, """{"result":{"ready":true}}""")
            }, pollDelay = { delays += it; elapsed += it }, monotonicMillis = { elapsed })
            manager.rendezvous("inst_target", "Phone")
            assertEquals(2, polls)
            assertEquals(listOf(5_000L), delays)
        }
    }

    private fun pollingManager(
        onResult: suspend () -> ApiResponse,
        pollDelay: suspend (Long) -> Unit,
        monotonicMillis: () -> Long,
        expiresAt: String = "2099-01-01T00:00:00Z",
        wallClock: () -> Instant = { now },
    ): AccountSessionManager {
        val identity = FakeDeviceIdentityStore()
        val fingerprint = devicePublicKeyFingerprint(identity.publicKeyEncoded())
        val transport = RecordingTransport { request -> when {
            request.path == "/v1/owner-auth/rendezvous" -> ApiResponse(201,
                """{"intent":{"intentId":"rji_timing","instanceId":"inst_target","deviceId":"adev_test","devicePublicKeyFingerprint":"$fingerprint","nonce":"rnonce","issuedAt":"2026-08-25T00:00:00Z","expiresAt":"$expiresAt"}}""")
            request.path.endsWith("/authorize") -> ApiResponse(200,
                """{"accountJoinGrant":"raj_timing","expiresAt":"$expiresAt","intentId":"rji_timing","instanceId":"inst_target","deviceId":"adev_test","rendezvousGrantSubmitted":true}""")
            request.path.endsWith("/result") -> onResult()
            else -> error("Unexpected polling fixture request")
        } }
        return manager(transport, transport, identity, FakeAccountCredentialStore("rac_active"), turnMetadata(),
            pollDelay = pollDelay, monotonicMillis = monotonicMillis, wallClock = wallClock)
    }

    private fun manager(
        anonymous: AgentoCTransport,
        authenticated: AgentoCTransport,
        identity: DeviceIdentityStore,
        credentials: AccountCredentialStore,
        metadata: AccountSessionMetadataStore,
        randomNonce: () -> String = { "test_nonce" },
        pollDelay: suspend (Long) -> Unit = {},
        pairingJournal: AccountPairingJournal = MemoryAccountPairingJournal(),
        monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000L },
        wallClock: () -> Instant = { now },
        beforeRendezvousGrant: suspend () -> Unit = {},
        beforeDemoSignIn: suspend () -> Unit = {},
        afterDemoLogout: suspend () -> Unit = {},
        changeAccountDirectory: suspend (AccountDirectoryChange, suspend () -> Unit) -> Unit = { _, update -> update() },
        dispatchSessionInvalidation: ((suspend () -> Unit) -> Unit)? = null,
        rendezvousTrace: (String, String) -> Unit = { _, _ -> },
    ) = AccountSessionManager(
        anonymousTransport = anonymous,
        authenticatedTransport = authenticated,
        identity = identity,
        credentialStore = credentials,
        metadataStore = metadata,
        clock = wallClock,
        randomNonce = randomNonce,
        pollDelay = pollDelay,
        pairingJournal = pairingJournal,
        monotonicMillis = monotonicMillis,
        beforeRendezvousGrant = beforeRendezvousGrant,
        beforeDemoSignIn = beforeDemoSignIn,
        afterDemoLogout = afterDemoLogout,
        changeAccountDirectory = changeAccountDirectory,
        dispatchSessionInvalidation = dispatchSessionInvalidation,
        rendezvousTrace = rendezvousTrace,
    )

    private fun grantBarrierFixture(
        beforeGrant: suspend () -> Unit = {},
        beforeCreateReply: suspend (String, Int) -> Unit = { _, _ -> },
        monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000L },
        wallClock: () -> Instant = { now },
        intentExpiry: String = "2099-01-01T00:00:00Z",
    ): Pair<AccountSessionManager, RecordingTransport> {
        val identity = FakeDeviceIdentityStore()
        val fingerprint = devicePublicKeyFingerprint(identity.publicKeyEncoded())
        val targets = mutableMapOf<String, String>()
        var sequence = 0
        val transport = RecordingTransport { request -> when {
            request.path == "/v1/owner-auth/rendezvous" -> {
                val target = Json.parseToJsonElement(requireNotNull(request.body)).jsonObject["targetInstanceId"]!!.jsonPrimitive.content
                val index = ++sequence
                val intentId = "rji_gate_$index"
                targets[intentId] = target
                beforeCreateReply(target, index)
                ApiResponse(201, """{"intent":{"intentId":"$intentId","instanceId":"$target","deviceId":"adev_test","devicePublicKeyFingerprint":"$fingerprint","nonce":"nonce_$index","issuedAt":"2026-08-25T00:00:00Z","expiresAt":"$intentExpiry"}}""")
            }
            request.path.endsWith("/authorize") -> {
                val id = request.path.removePrefix("/v1/owner-auth/account-intents/").removeSuffix("/authorize")
                ApiResponse(200, """{"accountJoinGrant":"raj_gate","expiresAt":"2099-01-01T00:00:00Z","intentId":"$id","instanceId":"${targets.getValue(id)}","deviceId":"adev_test","rendezvousGrantSubmitted":true}""")
            }
            request.path.endsWith("/result") -> ApiResponse(200, """{"result":{"ready":true}}""")
            else -> error("Unexpected fixture operation")
        } }
        return manager(transport, transport, identity, FakeAccountCredentialStore("rac_active"), turnMetadata(),
            beforeRendezvousGrant = beforeGrant, monotonicMillis = monotonicMillis, wallClock = wallClock) to transport
    }

    private fun verifySignature(identity: DeviceIdentityStore, message: String, signature: String) {
        val der = Base64.getDecoder().decode(identity.publicKeyEncoded().lineSequence()
            .filterNot { it.startsWith("-----") }
            .joinToString(""))
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der)))
        verifier.update(message.toByteArray(Charsets.UTF_8))
        assertTrue(verifier.verify(Base64.getUrlDecoder().decode(signature)))
    }

    private class FakeAccountCredentialStore(initial: String? = null) : AccountCredentialStore {
        var token: String? = initial
        override fun readToken(): String? = token
        override fun writeToken(token: String) { this.token = token }
        override fun clear() { token = null }
    }

    private class FakeAccountSessionMetadataStore(
        private val deviceId: String,
        initial: AccountSessionMetadata? = null,
    ) : AccountSessionMetadataStore {
        private val state = MutableStateFlow(initial)
        override val accountSession: StateFlow<AccountSessionMetadata?> = state
        override suspend fun getOrCreateAccountDeviceId(): String = deviceId
        override suspend fun saveAccountSession(value: AccountSessionMetadata) { state.value = value }
        override suspend fun clearAccountSession() { state.value = null }
    }

    private class RecordingTransport(
        private val responder: suspend (ApiRequest) -> ApiResponse,
    ) : AgentoCTransport {
        val requests = mutableListOf<ApiRequest>()
        override val invalidations: Flow<InvalidationHint> = emptyFlow()
        override val connectionState = MutableStateFlow(RuntimeConnectionState.Disconnected)
        override suspend fun execute(request: ApiRequest): ApiResponse {
            requests += request
            return responder(request)
        }
        override fun connectInvalidationSocket() = Unit
        override suspend fun close() = Unit
    }
}
