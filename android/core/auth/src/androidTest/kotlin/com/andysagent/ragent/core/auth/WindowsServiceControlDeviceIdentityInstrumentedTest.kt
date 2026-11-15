package com.andysagent.ragent.core.auth

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WindowsServiceControlDeviceIdentityInstrumentedTest {
    @Test
    fun deviceKeySignsOnlyTheReviewedServiceOperation() {
        val identity = AndroidDeviceIdentityStore(InstrumentationRegistry.getInstrumentation().targetContext)
        val now = System.currentTimeMillis()
        val grant = WindowsServiceControlGrant(
            1, "test-key", "test-broker", 1, "test-request", "test-session", "test-run", "test-turn", "test-action",
            "0123456789abcdefghijklmn", "测试服务", "restart-service", "a".repeat(64), "owner", now, now + 60_000,
        )
        val approval = WindowsServiceControlApproval.ownerSigningBytes(grant, now)
        val signature = identity.signBrokerBytes(approval)
        val publicKey = identity.brokerPublicKey()
        assertTrue(BrokerApprovalProtocol.verifyBrokerSignature(publicKey, signature, approval))
        assertFalse(BrokerApprovalProtocol.verifyBrokerSignature(
            publicKey, signature, WindowsServiceControlApproval.ownerSigningBytes(grant.copy(action = "stop-service"), now),
        ))
        assertFalse(BrokerApprovalProtocol.verifyBrokerSignature(
            publicKey, signature, WindowsServiceControlApproval.ownerDenialSigningBytes(grant, now),
        ))
    }
}
