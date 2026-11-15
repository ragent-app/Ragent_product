package com.andysagent.ragent.core.network

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DefaultNetworkTrackerTest {
    @Test fun `offline then available requires a fresh contract even on the same network`() {
        val route = DefaultNetworkTracker<String>()
        assertFalse(route.available("wifi"))
        assertTrue(route.lost("wifi"))
        assertFalse(route.isCurrent("wifi"))
        assertTrue(route.available("wifi"))
        assertTrue(route.isCurrent("wifi"))
        assertFalse(route.available("wifi"), "Repeated availability must not mint another lease")
    }

    @Test fun `handover survives delayed former route loss and capability callbacks`() {
        val route = DefaultNetworkTracker<String>()
        assertFalse(route.available("wifi"))
        assertTrue(route.available("mobile"))
        assertFalse(route.lost("wifi"))
        assertFalse(route.isCurrent("wifi"))
        assertTrue(route.isCurrent("mobile"))
        assertTrue(route.lost("mobile"))
        assertTrue(route.available("next-wifi"))
        assertFalse(route.lost("mobile"))
        assertTrue(route.isCurrent("next-wifi"))
    }
}
