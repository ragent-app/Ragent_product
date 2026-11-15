package com.andysagent.ragent.core.auth

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.datastore.AccountSessionMetadata
import com.andysagent.ragent.core.datastore.ClientConfigStore
import com.andysagent.ragent.core.datastore.LinkedComputer
import com.andysagent.ragent.core.datastore.PendingAccountJoin
import com.andysagent.ragent.core.network.ConnectionBootstrapClient
import com.andysagent.ragent.core.network.OkHttpRagentTransport
import com.andysagent.ragent.core.network.TurnReservationRelease
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Real phone transport, encrypted RAC and directory; Accounts/PC are loopback fixtures. */
@RunWith(AndroidJUnit4::class)
class AccountTurnLeaseRecoveryInstrumentedTest {
    @Test fun coldCleanupKeepsPrimaryBackgroundCredentialsAndOnlyReleasesCapturedIds() = runBlocking { runRecovery(false) }
    @Test fun unreachableComputerReleasesTheSameReservationThroughTheEncryptedAccountSession() = runBlocking { runRecovery(true) }

    private suspend fun runRecovery(peerFailure: Boolean) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val storeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val file = context.filesDir.resolve("phone-turn-${UUID.randomUUID()}.preferences_pb")
        val config = ClientConfigStore.withStore(context, PreferenceDataStoreFactory.create(scope = storeScope, produceFile = { file }))
        val identity = AndroidDeviceIdentityStore(context)
        val account = AndroidAccountCredentialStore(context)
        val credentials = AndroidCredentialStore(context); val secrets = AndroidP2PSecretStore(context)
        val server = MockWebServer().apply { start() }; val pc = MockWebServer().apply { start() }
        val anonymous = OkHttpRagentTransport({ server.url("/").toString().trimEnd('/') }, { null })
        val authenticated = OkHttpRagentTransport({ server.url("/").toString().trimEnd('/') }, account::readToken)
        val manager = AccountSessionManager(anonymous, authenticated, identity, account, ClientConfigAccountSessionStore(config))
        val primary = "inst_phone_turn_primary"; val background = "inst_phone_turn_background"
        val now = Instant.now(); val expiry = now.plusSeconds(3600).toString()
        fun id(suffix: Char) = "turn_${"a".repeat(32)}_${System.currentTimeMillis()}_${suffix.toString().repeat(32)}"
        val captured = listOf(id('1'), id('2')); val fresh = id('3')
        try {
            val phone = config.getOrCreateAccountDeviceId()
            config.saveAccountSession(AccountSessionMetadata("acct_phone_turn", phone, "cred_phone_turn", "account-directory", expiry))
            account.writeToken("rac_phone_turn_fixture")
            credentials.write(primary, "rda_primary", expiry, "device-access")
            credentials.write(background, "rda_background", expiry, "device-access")
            val p2p = StoredP2PConfig("https://signal.fixture.invalid", "room-primary", "fixture-primary-secret")
            secrets.write(primary, p2p)
            config.upsertComputer(LinkedComputer(primary, "", "Primary", autoConnect = true), select = true)
            config.upsertComputer(LinkedComputer(background, "", "Background", autoConnect = true), select = false)
            config.savePendingAccountJoin(PendingAccountJoin("https://ui-pending.fixture.invalid", "rji_ui_pending", background,
                "rdev_background", devicePublicKeyFingerprint(identity.publicKeyEncoded()), "ui-pending-nonce", now.toString(),
                now.plusSeconds(120).toString(), "ui-pending-request"))
            val directory = config.directory.first(); val pending = config.pendingAccountJoin.first(); val key = identity.publicKeyEncoded()
            val receipt = """{"contractVersion":1,"accountId":"acct_phone_turn","deviceId":"$phone","processedConnections":${if (peerFailure) 1 else 2},"releasedConnections":${if (peerFailure) 1 else 2}}"""
            if (peerFailure) {
                pc.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
                server.enqueue(MockResponse().setBody(receipt))
                val peer = ConnectionBootstrapClient({ pc.url("/").toString().trimEnd('/') }, { "rda_primary" })
                TurnReservationRelease({ peer.releaseTurn(it, "test-peer-release"); Unit },
                    { manager.releaseOwnTurnConnections(listOf(it), "client-release"); Unit }).release(captured.first())
                val request = requireNotNull(pc.takeRequest(2, TimeUnit.SECONDS))
                assertEquals("Bearer rda_primary", request.getHeader("Authorization"))
                assertTrue(request.body.readUtf8().contains(captured.first()))
                assertEquals(1, server.requestCount)
            } else {
                val rows = captured.mapIndexed { index, connectionId ->
                    """{"connectionId":"$connectionId","instanceId":"${if (index == 0) primary else background}","deviceId":"rdev_phone_turn_$index","expiresAt":"$expiry"}"""
                }.joinToString(",")
                server.enqueue(MockResponse().setBody("""{"contractVersion":1,"accountId":"acct_phone_turn","deviceId":"$phone","asOf":"$now","connections":[$rows],"nextCursor":null,"legacyConnections":0}"""))
                server.enqueue(MockResponse().setBody(receipt))
                val recovery = ColdTurnLeaseRecovery(manager)
                recovery.beforeNewReservations(); recovery.beforeNewReservations()
                assertEquals(2, server.requestCount)
                assertEquals("/v1/owner-auth/account/turn/connections", requireNotNull(server.takeRequest(2, TimeUnit.SECONDS)).path)
            }
            val release = requireNotNull(server.takeRequest(2, TimeUnit.SECONDS))
            assertEquals("/v1/owner-auth/account/turn/connections/release", release.path)
            assertEquals("Bearer rac_phone_turn_fixture", release.getHeader("Authorization"))
            val body = Json.parseToJsonElement(release.body.readUtf8()).jsonObject
            assertEquals(if (peerFailure) captured.take(1) else captured, body.getValue("connectionIds").jsonArray.map { it.jsonPrimitive.content })
            assertFalse(body.toString().contains(fresh)); assertFalse(body.toString().contains("rda_"))
            assertEquals(directory, config.directory.first()); assertEquals(pending, config.pendingAccountJoin.first())
            assertEquals("rda_primary", AndroidCredentialStore(context).readToken(primary))
            assertEquals("rda_background", AndroidCredentialStore(context).readToken(background))
            assertEquals(p2p, AndroidP2PSecretStore(context).read(primary))
            assertEquals("rac_phone_turn_fixture", AndroidAccountCredentialStore(context).readToken())
            assertEquals(key, AndroidDeviceIdentityStore(context).publicKeyEncoded())
        } finally {
            anonymous.close(); authenticated.close(); server.shutdown(); pc.shutdown()
            storeScope.coroutineContext[Job]?.cancelAndJoin()
            credentials.clear(primary); credentials.clear(background); secrets.clear(primary); account.clear(); file.delete()
        }
    }
}
