package com.andysagent.ragent.core.auth

import android.content.Context
import android.content.ContextWrapper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Real Keystore tests in the library test UID; never the installed Ragent UID. */
@RunWith(AndroidJUnit4::class)
class AccountProfileNamespaceNativeTest {
    private fun stores(block: (AndroidCredentialStore, AndroidP2PSecretStore) -> Unit) {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        check(base.packageName.startsWith("com.andysagent.ragent.core.auth") && base.packageName.endsWith(".test"))
        val prefix = "qa-profile-${UUID.randomUUID()}-"
        val isolated = object : ContextWrapper(base) {
            override fun getApplicationContext(): Context = this
            override fun getSharedPreferences(name: String, mode: Int) = base.getSharedPreferences(prefix + name, mode)
        }
        try { block(AndroidCredentialStore(isolated), AndroidP2PSecretStore(isolated)) }
        finally {
            base.deleteSharedPreferences(prefix + "ragent-credential")
            base.deleteSharedPreferences(prefix + "ragent-p2p-credential")
        }
    }

    @Test fun arbitraryDeviceIdsCannotAddressEncryptedArchives() = stores { credentials, secrets ->
        val profiles = AccountTargetCredentialProfiles(credentials, secrets)
        credentials.write("one", "qa-real-token", "2099-01-01T00:00:00Z", "owner")
        secrets.write("one", StoredP2PConfig("https://signal.invalid", "room-one", "qa-real-secret"))
        profiles.archive("acct_a", listOf("one"))
        val oldAlias = "profile_" + MessageDigest.getInstance("SHA-256")
            .digest("acct_a\u0000one".toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
        credentials.write(oldAlias, "qa-other-device", null, "other")
        secrets.write(oldAlias, StoredP2PConfig("https://signal.invalid", "other", "qa-other-secret"))
        profiles.clearActive(listOf("one")); profiles.restore("acct_a", listOf("one"))
        assertEquals("qa-real-token", credentials.readToken("one"))
        assertEquals("qa-real-secret", secrets.read("one")?.secret)
        assertEquals("qa-other-device", credentials.readToken(oldAlias))
        assertEquals("qa-other-secret", secrets.read(oldAlias)?.secret)
    }

    @Test fun purgeFindsOrphansWithoutClearingOtherAccountsOrActiveCredentials() = stores { credentials, secrets ->
        val profiles = AccountTargetCredentialProfiles(credentials, secrets)
        for (owner in listOf("acct_a", "acct_b", null)) {
            for (id in listOf("same", "no-longer-in-directory")) {
                credentials.writeAccountProfile(owner, id, "qa-token-$owner", "2099-01-01T00:00:00Z", "owner")
                secrets.writeAccountProfile(owner, id, StoredP2PConfig("https://signal.invalid", id, "qa-secret-$owner"))
            }
        }
        credentials.write("active", "qa-active", null, "owner")
        secrets.write("active", StoredP2PConfig("https://signal.invalid", "active", "qa-active-secret"))
        profiles.purge("acct_a")
        for (id in listOf("same", "no-longer-in-directory")) {
            assertNull(credentials.readAccountProfileToken("acct_a", id))
            assertNull(secrets.readAccountProfile("acct_a", id))
            assertEquals("qa-token-acct_b", credentials.readAccountProfileToken("acct_b", id))
            assertEquals("qa-secret-acct_b", secrets.readAccountProfile("acct_b", id)?.secret)
            assertEquals("qa-token-null", credentials.readAccountProfileToken(null, id))
        }
        assertEquals("qa-active", credentials.readToken("active"))
        assertEquals("qa-active-secret", secrets.read("active")?.secret)
    }

    @Test fun localProfileIsDistinctFromAnAccountNamedLocal() = stores { credentials, secrets ->
        credentials.writeAccountProfile(null, "same", "qa-local", null, "local")
        credentials.writeAccountProfile("local", "same", "qa-account", null, "owner")
        secrets.writeAccountProfile(null, "same", StoredP2PConfig("https://signal.invalid", "local", "qa-local-secret"))
        secrets.writeAccountProfile("local", "same", StoredP2PConfig("https://signal.invalid", "account", "qa-account-secret"))
        credentials.clearAccountProfiles(null); secrets.clearAccountProfiles(null)
        assertNull(credentials.readAccountProfileToken(null, "same"))
        assertNull(secrets.readAccountProfile(null, "same"))
        assertEquals("qa-account", credentials.readAccountProfileToken("local", "same"))
        assertEquals("qa-account-secret", secrets.readAccountProfile("local", "same")?.secret)
    }

    @Test fun archivedWritesCannotPublishAsLegacyActiveCredentials() = stores { credentials, secrets ->
        credentials.write(token = "qa-legacy", expiresAt = null, scope = "legacy")
        val legacy = StoredP2PConfig("https://signal.invalid", "legacy", "qa-legacy-secret")
        secrets.write(config = legacy)
        credentials.writeAccountProfile("acct_a", "one", "qa-archive", null, "archive")
        secrets.writeAccountProfile("acct_a", "one", StoredP2PConfig("https://signal.invalid", "archive", "qa-archive-secret"))
        assertEquals("qa-legacy", credentials.readToken())
        assertEquals("legacy", credentials.credential.value?.scope)
        assertEquals(legacy, secrets.read())
        credentials.clearAccountProfiles("acct_a"); secrets.clearAccountProfiles("acct_a")
        assertEquals("qa-legacy", credentials.readToken())
        assertEquals(legacy, secrets.read())
    }

    @Test fun expiredArchiveOnlyClearsItsOwnSlot() = stores { credentials, _ ->
        credentials.writeAccountProfile("acct_a", "same", "qa-expired", Instant.now().minusSeconds(60).toString(), "owner")
        credentials.writeAccountProfile("acct_b", "same", "qa-live", "2099-01-01T00:00:00Z", "owner")
        credentials.write("same", "qa-active", null, "owner")
        assertNull(credentials.readAccountProfileToken("acct_a", "same"))
        assertEquals("qa-live", credentials.readAccountProfileToken("acct_b", "same"))
        assertEquals("qa-active", credentials.readToken("same"))
    }

    @Test fun expiredLegacyCredentialCannotEraseTargetAndOwnerProfiles() = stores { credentials, _ ->
        credentials.write(token = "qa-old-legacy", expiresAt = Instant.now().minusSeconds(60).toString(), scope = "legacy")
        credentials.write("active", "qa-active", "2099-01-01T00:00:00Z", "owner")
        credentials.writeAccountProfile("acct_a", "one", "qa-archive", "2099-01-01T00:00:00Z", "owner")
        assertNull(credentials.readToken())
        assertEquals("qa-active", credentials.readToken("active"))
        assertEquals("qa-archive", credentials.readAccountProfileToken("acct_a", "one"))
        credentials.write(token = "qa-current-legacy", expiresAt = null, scope = "legacy")
        credentials.write("active", "qa-new-active", null, "owner")
        assertEquals("qa-current-legacy", credentials.readToken())
    }
}
