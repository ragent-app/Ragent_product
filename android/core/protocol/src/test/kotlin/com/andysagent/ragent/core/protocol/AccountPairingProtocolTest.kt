package com.andysagent.ragent.core.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class AccountPairingProtocolTest {
    @Test fun `signed proof matches Node canonical vector`() {
        assertEquals("""["ragent-account-pairing-v1","claim","inst_protocol_test_0001","rpinv_protocol_test_0001",1000,"nonce_protocol_test_0001","06b1000bb8402838513c5370e639c2ddeb4944d4b0c2b29914136ec92b29a0ca"]""",
            buildAccountPairingProof("claim", "inst_protocol_test_0001", "rpinv_protocol_test_0001", 1000,
                "nonce_protocol_test_0001", Json.parseToJsonElement("""{"z":"phone","a":{"v":1}}""").jsonObject))
    }

    @Test fun `v4 requires exchange id and endpointless source identity`() {
        val uri = "ragent://pair?v=4&i=inst_protocol_test_0001&t=rpi_secret&x=2099-01-01T00%3A00%3A00Z&p=public-key&f=${"a".repeat(64)}"
        assertFailsWith<IllegalArgumentException> { parsePairingUri(uri) }
        assertEquals("rpinv_protocol_test_0001", parsePairingUri("$uri&q=rpinv_protocol_test_0001").accountInvitationId)
        assertEquals("demo", parsePairingUri("$uri&q=rpinv_protocol_test_0001&accountType=demo").accountType)
        assertEquals("google", parsePairingUri("$uri&q=rpinv_protocol_test_0001&accountType=google").accountType)
        assertFailsWith<IllegalArgumentException> { parsePairingUri("$uri&q=rpinv_protocol_test_0001&accountType=other") }
        assertFailsWith<IllegalArgumentException> { parsePairingUri("$uri&q=rpinv_protocol_test_0001&e=https%3A%2F%2Fexample.test") }
    }
}
