package com.andysagent.agentoc.core.datastore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AccountDeviceIdentityTest {
    @Test fun androidIdProducesStableOpaqueAccountDeviceId() {
        val first = stableAccountDeviceIdFromAndroidId("0123456789abcdef")
        assertEquals(first, stableAccountDeviceIdFromAndroidId("0123456789ABCDEF"))
        assertEquals("adev_android_", first?.take("adev_android_".length))
        assertEquals("adev_android_".length + 48, first?.length)
        assertNotEquals(first, stableAccountDeviceIdFromAndroidId("fedcba9876543210"))
    }

    @Test fun invalidOrUnavailableAndroidIdUsesFallbackPath() {
        assertNull(stableAccountDeviceIdFromAndroidId(null))
        assertNull(stableAccountDeviceIdFromAndroidId(""))
        assertNull(stableAccountDeviceIdFromAndroidId("9774d56d682e549c"))
        assertNull(stableAccountDeviceIdFromAndroidId("not-an-android-id"))
    }
}
