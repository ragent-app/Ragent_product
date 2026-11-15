package com.andysagent.ragent

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.auth.AndroidDeviceIdentityStore
import com.andysagent.ragent.core.auth.BrokerApprovalProtocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BrokerApprovalAppDeviceIdentityTest {
    @Test
    fun brokerApprovalReusesTheInstalledAppDeviceIdentity() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("com.agentoncloud.android", context.packageName)

        val app = context.applicationContext as RagentApplication
        val appIdentity = app.runtime.identityStore
        val existingIdentity = AndroidDeviceIdentityStore(context)
        val publicKey = appIdentity.brokerPublicKey()
        val message = "Ragent Broker approval app identity reuse".toByteArray()

        assertEquals(publicKey, existingIdentity.brokerPublicKey())
        assertEquals(
            BrokerApprovalProtocol.deviceIdForPublicKey(publicKey),
            BrokerApprovalProtocol.deviceIdForPublicKey(existingIdentity.brokerPublicKey()),
        )
        assertTrue(
            BrokerApprovalProtocol.verifyBrokerSignature(
                publicKey,
                appIdentity.signBrokerBytes(message),
                message,
            ),
        )
    }
}
