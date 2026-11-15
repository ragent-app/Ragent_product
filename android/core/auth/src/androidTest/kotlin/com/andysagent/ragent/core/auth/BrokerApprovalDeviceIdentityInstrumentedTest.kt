package com.andysagent.ragent.core.auth

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BrokerApprovalDeviceIdentityInstrumentedTest {
    @Test
    fun brokerDecisionUsesTheExistingReusableAppDeviceIdentity() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val identity = AndroidDeviceIdentityStore(context)
        val sameIdentity = AndroidDeviceIdentityStore(context)
        val publicKey = identity.brokerPublicKey()
        val message = "Ragent Broker approval device identity reuse".toByteArray()

        assertEquals(publicKey, sameIdentity.brokerPublicKey())
        assertEquals(
            devicePublicKeyFingerprint(identity.publicKeyEncoded()),
            BrokerApprovalProtocol.deviceIdForPublicKey(publicKey),
        )
        val signature = identity.signBrokerBytes(message)
        assertTrue(BrokerApprovalProtocol.verifyBrokerSignature(publicKey, signature, message))
    }
}
