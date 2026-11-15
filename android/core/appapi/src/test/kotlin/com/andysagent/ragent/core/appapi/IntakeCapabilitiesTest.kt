package com.andysagent.ragent.core.appapi

import kotlinx.serialization.decodeFromString
import org.junit.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class IntakeCapabilitiesTest {
    @Test fun bothProjectOperationsRequireTheExactProtocolVersion() {
        assertTrue(IntakeJson.decodeFromString<IntakeCapabilities>(
            """{"protocolVersion":1,"projectRouting":true,"projectCreation":true}""").supportsSmartShare)
        for (body in listOf(
            """{"protocolVersion":2,"projectRouting":true,"projectCreation":true}""",
            """{"protocolVersion":1,"projectRouting":false,"projectCreation":true}""",
            """{"protocolVersion":1,"projectRouting":true,"projectCreation":false}""",
        )) assertFalse(IntakeJson.decodeFromString<IntakeCapabilities>(body).supportsSmartShare)
    }
}
