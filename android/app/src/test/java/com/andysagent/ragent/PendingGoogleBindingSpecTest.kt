package com.andysagent.ragent

import com.andysagent.ragent.core.datastore.PendingGoogleBinding
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PendingGoogleBindingSpecTest {
    private val pending = PendingGoogleBinding(
        endpoint = "https://computer.example",
        instanceId = "instance-1",
        deviceId = "device-1",
        requestId = "request-1",
    )

    @Test
    fun `only a valid invitation for the pending instance can reuse promotion metadata`() {
        assertTrue(pendingGoogleBindingMatches(validUri("https://computer.example"), pending))
        assertFalse(pendingGoogleBindingMatches("https://computer.example/not-a-pair", pending))
        assertFalse(pendingGoogleBindingMatches(validUri("https://other.example"), pending))
    }

    private fun validUri(endpoint: String): String =
        "ragent://pair?v=3&instance=instance-1&endpoint=${java.net.URLEncoder.encode(endpoint, "UTF-8")}&token=rpi_test&expires=2099-01-01T00%3A00%3A00Z"
}
