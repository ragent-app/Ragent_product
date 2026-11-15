package com.andysagent.ragent.core.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertFailsWith
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ConnectionBootstrapVerifierTest {
    @Test
    fun `handoff requires the pinned key same device and new lease`() {
        val fixture = javaClass.getResource("/fixtures/connection-bootstrap-signed.json")!!.readText()
        val envelope = RagentProtocol.json.parseToJsonElement(fixture).jsonObject
        val raw = envelope["contract"]!!.jsonObject.toString()
        val key = ConnectionBootstrapPublicKeyDto("ed25519", "fixture-key", envelope["publicKeyPem"]!!.jsonPrimitive.contentOrNull!!)
        val instant = 1_788_307_200_000L
        assertEquals("turn_fixture", ConnectionBootstrapVerifier.verifyHandoff(raw, key,
            "rli_fixture_001", "rdev_fixture_001", "turn_old", instant).contract.turn?.connectionId)
        for ((instance, device, previous) in listOf(Triple("other", "rdev_fixture_001", "turn_old"),
            Triple("rli_fixture_001", "other", "turn_old"), Triple("rli_fixture_001", "rdev_fixture_001", "turn_fixture"))) {
            assertFailsWith<ConnectionBootstrapVerificationException> {
                ConnectionBootstrapVerifier.verifyHandoff(raw, key, instance, device, previous, instant)
            }
        }
        assertFailsWith<ConnectionBootstrapVerificationException> {
            ConnectionBootstrapVerifier.verifyHandoff(raw.replace("turn_fixture", "turn_forged"), key,
                "rli_fixture_001", "rdev_fixture_001", "turn_old", instant)
        }
    }
    @Test
    fun `verifies Node signed contract after JSON transport round trip`() {
        val fixture = javaClass.getResource("/fixtures/connection-bootstrap-signed.json")!!.readText()
        val envelope = RagentProtocol.json.parseToJsonElement(fixture).jsonObject
        val rawContract = envelope["contract"]!!.jsonObject.toString()
        val publicKey = ConnectionBootstrapPublicKeyDto(
            algorithm = "ed25519",
            keyId = "fixture-key",
            publicKeyPem = envelope["publicKeyPem"]!!.jsonPrimitive.contentOrNull!!,
        )

        val verified = ConnectionBootstrapVerifier.verify(
            rawContract = rawContract,
            publicKey = publicKey,
            nowMs = 1_788_307_200_000L,
        )

        assertNotNull(verified)
        assertEquals("rli_fixture_001", verified.contract.instanceId)
        assertEquals("rdev_fixture_001", verified.contract.deviceId)
    }
}
