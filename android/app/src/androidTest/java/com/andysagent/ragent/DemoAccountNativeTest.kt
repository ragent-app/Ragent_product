package com.andysagent.ragent

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.auth.AccountSessionManager
import com.andysagent.ragent.core.auth.AndroidAccountCredentialStore
import com.andysagent.ragent.core.auth.AndroidDeviceIdentityStore
import com.andysagent.ragent.core.auth.ClientConfigAccountSessionStore
import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.core.datastore.AccountSessionMetadata
import com.andysagent.ragent.core.datastore.ClientConfigStore
import com.andysagent.ragent.core.network.OkHttpRagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.Assume.assumeTrue

/** Run only on the owned emulator, with the bounded local Node Accounts fixture over adb reverse. */
class DemoAccountNativeTest {
    @Test fun realKeystoreHttpLoginColdReadAndLogoutPreserveNormalDeviceIdentity() = runBlocking {
        assumeTrue("Requires the owned emulator and bounded loopback Accounts fixture (-e demoFixture owned-emulator-5584)",
            InstrumentationRegistry.getArguments().getString("demoFixture") == "owned-emulator-5584")
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val testContext = object : ContextWrapper(base) {
            override fun getApplicationContext(): Context = this
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
                base.getSharedPreferences("demo-native-fixture-$name", mode)
        }
        val root = File(base.cacheDir, "demo-native-${System.nanoTime()}").apply { check(mkdir()) }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val dataStore = PreferenceDataStoreFactory.create(scope = scope) { File(root, "client.preferences_pb") }
        val config = ClientConfigStore.withStore(testContext, dataStore)
        val identity = AndroidDeviceIdentityStore(testContext)
        val credentialStore = AndroidAccountCredentialStore(testContext)
        val anonymous = OkHttpRagentTransport({ "http://127.0.0.1:18420" }, { null })
        val authenticated = OkHttpRagentTransport({ "http://127.0.0.1:18420" }, { credentialStore.readToken() })
        var demoDisconnects = 0
        fun manager() = AccountSessionManager(anonymous, authenticated, identity, credentialStore, ClientConfigAccountSessionStore(config),
            afterDemoLogout = { demoDisconnects++ })
        try {
            val normalDevice = config.getOrCreateAccountDeviceId()
            try {
                manager().signInDemoAccount("review-native-fixture", "wrong-fixture-password", "Fixture emulator")
                error("Wrong password accepted")
            } catch (error: AccountSessionException) { assertEquals(401, error.statusCode) }
            assertNull(config.accountSession.first()); assertNull(credentialStore.readToken())
            val established = manager().signInDemoAccount("review-native-fixture", "native-fixture-password-not-for-deployment", "Fixture emulator")
            assertTrue(established.accountId.startsWith("acct_demo_"))
            assertTrue(established.credential.deviceId.startsWith("adev_demo_"))
            assertEquals(normalDevice, config.getOrCreateAccountDeviceId())
            val coldCredential = AndroidAccountCredentialStore(testContext).readToken()
            assertEquals(established.credential.token, coldCredential)
            assertFalse(testContext.getSharedPreferences("ragent-account-credential", Context.MODE_PRIVATE).all.values
                .any { it.toString().contains(established.credential.token) })
            assertEquals(established.accountId, manager().ensureActiveCredential().accountId)
            val directory = authenticated.execute(ApiRequest(method = "POST", path = "/v1/owner-auth/discovery", body = "{}"))
            assertEquals(200, directory.statusCode)
            assertTrue(directory.body.contains("\"instances\":[]") || directory.body.contains("\"instances\": []"))
            assertTrue(manager().logoutAccountSession())
            assertEquals(1, demoDisconnects)
            assertNull(config.accountSession.first()); assertNull(AndroidAccountCredentialStore(testContext).readToken())
            assertEquals(normalDevice, manager().createGoogleChallenge("Normal phone").deviceId)
            config.saveAccountSession(AccountSessionMetadata("acct_google_fixture", normalDevice, "cred_normal_fixture", "account-directory", "2099-01-01T00:00:00Z"))
            assertEquals(normalDevice, config.getOrCreateAccountDeviceId())
        } finally {
            credentialStore.clear(); config.clearAccountSession(); scope.cancel()
            anonymous.close(); authenticated.close()
        }
    }

}
