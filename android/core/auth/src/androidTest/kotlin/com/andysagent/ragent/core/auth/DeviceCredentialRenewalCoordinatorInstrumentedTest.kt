package com.andysagent.ragent.core.auth

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.datastore.ClientConfigStore
import com.andysagent.ragent.core.datastore.LinkedComputer
import com.andysagent.ragent.core.datastore.PendingAccountJoin
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Real phone classes, Keystore and directory; remote PC and Accounts are loopback fixtures. */
@RunWith(AndroidJUnit4::class)
class DeviceCredentialRenewalCoordinatorInstrumentedTest {
    @Test fun ownPhoneEnrollmentUpgradesWithoutChangingDirectoryOrPublishingAnIntermediateToken() = runBlocking {
        runChain(replaceBeforeFinal = false)
    }

    @Test fun aNewerEncryptedCredentialWinsAfterTheUpgradeAndBeforeFinalPublication() = runBlocking {
        runChain(replaceBeforeFinal = true)
    }

    private suspend fun runChain(replaceBeforeFinal: Boolean) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val storeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val preferencesFile = context.filesDir.resolve("renewal-chain-${UUID.randomUUID()}.preferences_pb")
        val preferences = PreferenceDataStoreFactory.create(scope = storeScope, produceFile = { preferencesFile })
        val config = ClientConfigStore.withStore(context, preferences)
        val identity = AndroidDeviceIdentityStore(context)
        val credentials = AndroidCredentialStore(context); val secrets = AndroidP2PSecretStore(context)
        val accounts = AndroidAccountCredentialStore(context)
        val writes = mutableListOf<String>()
        val recording = object : CredentialStore by credentials {
            override fun write(instanceId: String, token: String, expiresAt: String?, scope: String?) {
                writes.add(token); credentials.write(instanceId, token, expiresAt, scope)
            }
        }
        val fixture = RenewalChainFixture(identity, recording, secrets, accounts, config)
        try {
            val expiry = fixture.now.plusSeconds(300).toString()
            credentials.write(RenewalChainFixture.INSTANCE, "rda_original", expiry, "device-access")
            credentials.write("pc-chain-other", "rda_other", expiry, "device-access")
            secrets.clear(RenewalChainFixture.INSTANCE)
            config.upsertComputer(LinkedComputer(RenewalChainFixture.INSTANCE, fixture.endpoint, "Primary", autoConnect = true), select = true)
            config.upsertComputer(LinkedComputer("pc-chain-other", "", "Background", autoConnect = true), select = false)
            config.savePendingAccountJoin(PendingAccountJoin("https://ui-pending.fixture.invalid", "rji_ui_pending", "pc-chain-other",
                "rdev_ui_pending", devicePublicKeyFingerprint(identity.publicKeyEncoded()), "ui_nonce_pending", fixture.now.toString(),
                fixture.now.plusSeconds(120).toString(), "request-ui-pending"))
            val directoryBefore = config.directory.first(); val pendingBefore = config.pendingAccountJoin.first()
            val mutex = Mutex(); var stages = 0
            val guard = PairingWriteGuard { target, publication -> mutex.withLock {
                check(target == RenewalChainFixture.INSTANCE)
                if (++stages == 3 && replaceBeforeFinal) credentials.write(target, "rda_external_new", expiry, "device-access")
                if (credentials.readToken(target) != "rda_original") throw CancellationException("Credential replaced")
                publication()
            } }
            if (replaceBeforeFinal) {
                try {
                    fixture.coordinator.renew(RenewalChainFixture.INSTANCE, fixture.endpoint, "Phone", guard)
                    fail("A stale attempt published its credential")
                } catch (_: CancellationException) { }
                assertTrue(writes.isEmpty()); assertNull(secrets.read(RenewalChainFixture.INSTANCE))
                assertEquals("rda_external_new", AndroidCredentialStore(context).readToken(RenewalChainFixture.INSTANCE))
            } else {
                fixture.coordinator.renew(RenewalChainFixture.INSTANCE, fixture.endpoint, "Phone", guard)
                assertEquals(listOf("rda_chain_final"), writes)
                assertEquals("rda_chain_final", AndroidCredentialStore(context).readToken(RenewalChainFixture.INSTANCE))
                assertEquals("chain-room", AndroidP2PSecretStore(context).read(RenewalChainFixture.INSTANCE)?.roomId)
            }
            assertEquals(3, stages); assertEquals(directoryBefore, config.directory.first())
            assertEquals(pendingBefore, config.pendingAccountJoin.first())
            assertEquals("rda_other", AndroidCredentialStore(context).readToken("pc-chain-other"))
            assertEquals(RenewalChainFixture.RAC, AndroidAccountCredentialStore(context).readToken())
            assertEquals(identity.publicKeyEncoded(), AndroidDeviceIdentityStore(context).publicKeyEncoded())
            fixture.verifyCompletedTraffic()
        } finally {
            fixture.close(); storeScope.coroutineContext[Job]?.cancelAndJoin()
            credentials.clear(RenewalChainFixture.INSTANCE); credentials.clear("pc-chain-other")
            secrets.clear(RenewalChainFixture.INSTANCE); accounts.clear()
            preferencesFile.delete()
        }
    }
}
