package com.andysagent.ragent.core.datastore

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AppApiRoutingPreferencesTest {
    @Test fun missingSettingHasNoImplicitDefaultOrAliases() {
        assertEquals(AppApiRoutingPreferences(), AppApiRoutingCodec.decode(null))
    }

    @Test fun roundTripRetainsExactDefaultIdentityAndUnicodeAliases() {
        val original = AppApiRoutingPreferences(defaultShareTargetId = "pc-b", aliasesByTarget = mapOf("pc-b" to setOf("主力电脑", "Gaming")))
        assertEquals(original, AppApiRoutingCodec.decode(AppApiRoutingCodec.encode(original)))
    }

    @Test fun malformedFutureAndInvalidSettingsDoNotEnableImplicitRouting() {
        for (raw in listOf("", "{", "{\"version\":2}", "{\"defaultShareTargetId\":\"\"}",
            "{\"aliasesByTarget\":{\"pc-a\":[\"\\n\"]}}")) {
            assertFalse(AppApiRoutingCodec.decode(raw).readable)
        }
    }

    @Test fun additiveFieldsDoNotBreakCurrentSettings() {
        val decoded = AppApiRoutingCodec.decode("{\"version\":1,\"defaultShareTargetId\":\"pc-b\",\"futureField\":true}")
        assertTrue(decoded.readable)
        assertEquals("pc-b", decoded.defaultShareTargetId)
    }
}
