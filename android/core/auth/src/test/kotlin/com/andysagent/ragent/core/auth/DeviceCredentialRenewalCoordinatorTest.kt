package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.network.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlin.test.*

class DeviceCredentialRenewalCoordinatorTest {
    private class Credentials : CredentialStore {
        data class Value(val token: String, val metadata: StoredCredential)
        val values = mutableMapOf<String, Value>()
        val writes = mutableListOf<String>()
        override val credential = MutableStateFlow<StoredCredential?>(null)
        override fun read() = read(RenewalChainFixture.INSTANCE)
        override fun read(instanceId: String) = values[instanceId]?.metadata
        override fun readToken(instanceId: String) = values[instanceId]?.token
        override fun write(token: String, expiresAt: String?, scope: String?) = write(RenewalChainFixture.INSTANCE, token, expiresAt, scope)
        override fun write(instanceId: String, token: String, expiresAt: String?, scope: String?) {
            writes.add(token); val metadata = StoredCredential(expiresAt, scope)
            values[instanceId] = Value(token, metadata); credential.value = metadata
        }
        override fun clear() { values.clear(); credential.value = null }
        override fun clear(instanceId: String) { values.remove(instanceId) }
    }
    private class Secrets : P2PSecretStore {
        private var value: StoredP2PConfig? = null
        override fun read() = value
        override fun write(config: StoredP2PConfig) { value = config }
        override fun clear() { value = null }
    }
    private class AccountCredentials : AccountCredentialStore {
        var token: String? = null
        override fun readToken() = token
        override fun writeToken(token: String) { this.token = token }
        override fun clear() { token = null }
    }

    private suspend fun scenario(enrollmentId: String = RenewalChainFixture.OWN_PHONE, finalStatus: Int = 200,
        initialCode: String = "owner_auth_authority_upgrade_required",
        action: suspend (RenewalChainFixture, Credentials, Secrets, PairingWriteGuard) -> Unit) {
        val credentials = Credentials(); val secrets = Secrets()
        val fixture = RenewalChainFixture(FakeDeviceIdentityStore(), credentials, secrets, AccountCredentials(),
            enrollmentId = enrollmentId, finalStatus = finalStatus, initialCode = initialCode)
        credentials.write(RenewalChainFixture.INSTANCE, "rda_original", fixture.now.plusSeconds(300).toString(), "device-access")
        credentials.write("pc-other", "rda_other", fixture.now.plusSeconds(300).toString(), "device-access")
        credentials.writes.clear()
        val guard = PairingWriteGuard { target, writes ->
            assertEquals(RenewalChainFixture.INSTANCE, target)
            if (credentials.readToken(target) != "rda_original") throw CancellationException("External credential replaced the attempt")
            writes()
        }
        try { action(fixture, credentials, secrets, guard) }
        finally { fixture.close() }
    }

    @Test fun `own adev enrollment upgrades through real phone classes and publishes only the final credential`() = runBlocking {
        scenario { fixture, credentials, secrets, guard ->
            fixture.coordinator.renew(RenewalChainFixture.INSTANCE, fixture.endpoint, "Phone", guard)
            assertEquals(listOf("rda_chain_final"), credentials.writes)
            assertEquals("rda_other", credentials.readToken("pc-other"))
            assertEquals("device-access", credentials.read(RenewalChainFixture.INSTANCE)?.scope)
            assertEquals("chain-room", secrets.read()?.roomId)
            assertEquals(RenewalChainFixture.RAC, fixture.accountCredentials.readToken())
            fixture.verifyCompletedTraffic()
        }
    }

    @Test fun `legacy rdev enrollment keeps the same restricted upgrade flow`() = runBlocking {
        scenario(enrollmentId = "rdev_legacy_phone") { fixture, credentials, _, guard ->
            fixture.coordinator.renew(RenewalChainFixture.INSTANCE, fixture.endpoint, "Phone", guard)
            assertEquals(listOf("rda_chain_final"), credentials.writes); fixture.verifyCompletedTraffic()
        }
    }

    @Test fun `ordinary denial never spends RAC or creates an upgrade intent`() = runBlocking {
        scenario(initialCode = "owner_auth_authority_required") { fixture, credentials, _, guard ->
            assertFailsWith<ApiException> { fixture.coordinator.renew(RenewalChainFixture.INSTANCE, fixture.endpoint, "Phone", guard) }
            assertEquals(2, fixture.pc.requestCount); assertEquals(0, fixture.accounts.requestCount); assertTrue(credentials.writes.isEmpty())
        }
    }

    @Test fun `another account phone id cannot enter the existing enrollment exception`() = runBlocking {
        scenario(enrollmentId = "adev_other_phone") { fixture, credentials, _, guard ->
            assertEquals(400, assertFailsWith<AccountSessionException> {
                fixture.coordinator.renew(RenewalChainFixture.INSTANCE, fixture.endpoint, "Phone", guard)
            }.statusCode)
            assertEquals(3, fixture.pc.requestCount); assertEquals(0, fixture.accounts.requestCount)
            assertTrue(credentials.writes.isEmpty()); assertEquals(RenewalChainFixture.RAC, fixture.accountCredentials.readToken())
        }
    }

    @Test fun `revocation after Accounts completion prevents final publication without reenrolling`() = runBlocking {
        scenario(finalStatus = 404) { fixture, credentials, secrets, guard ->
            assertEquals(404, assertFailsWith<ApiException> {
                fixture.coordinator.renew(RenewalChainFixture.INSTANCE, fixture.endpoint, "Phone", guard)
            }.statusCode)
            assertTrue(credentials.writes.isEmpty()); assertNull(secrets.read()); fixture.verifyCompletedTraffic()
        }
    }

    @Test fun `a newer credential arriving before final publication remains authoritative`() = runBlocking {
        scenario { fixture, credentials, secrets, guard ->
            var stage = 0
            val interleaved = PairingWriteGuard { target, writes ->
                if (++stage == 3) credentials.write(target, "rda_external_new", fixture.now.plusSeconds(300).toString(), "device-access")
                guard.persist(target, writes)
            }
            assertFailsWith<CancellationException> { fixture.coordinator.renew(RenewalChainFixture.INSTANCE, fixture.endpoint, "Phone", interleaved) }
            assertEquals(listOf("rda_external_new"), credentials.writes); assertNull(secrets.read()); fixture.verifyCompletedTraffic()
        }
    }

    @Test fun `removal during the upgrade cannot publish a credential or carrier`() = runBlocking {
        scenario { fixture, credentials, secrets, guard ->
            var stage = 0
            val removal = PairingWriteGuard { target, writes ->
                if (++stage == 3) throw CancellationException("Target removed")
                guard.persist(target, writes)
            }
            assertFailsWith<CancellationException> { fixture.coordinator.renew(RenewalChainFixture.INSTANCE, fixture.endpoint, "Phone", removal) }
            assertTrue(credentials.writes.isEmpty()); assertNull(secrets.read()); fixture.verifyCompletedTraffic()
        }
    }
}
