package com.andysagent.ragent.core.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertFailsWith
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
        assertEquals(false, verified.contract.allowDirectIce)
    }

    @Test
    fun `decodes allowDirectIce true when present and defaults to false when absent`() {
        val fixture = javaClass.getResource("/fixtures/connection-bootstrap-signed.json")!!.readText()
        val envelope = RagentProtocol.json.parseToJsonElement(fixture).jsonObject
        val baseContract = envelope["contract"]!!.jsonObject.toString()

        val defaultDto = RagentProtocol.json.decodeFromString(
            ConnectionBootstrapContractDto.serializer(),
            baseContract,
        )
        assertEquals(false, defaultDto.allowDirectIce)

        val directJson = baseContract.dropLast(1) + ""","allowDirectIce":true}"""
        val directDto = RagentProtocol.json.decodeFromString(
            ConnectionBootstrapContractDto.serializer(),
            directJson,
        )
        assertEquals(true, directDto.allowDirectIce)
    }

    @Test
    fun `parity verifies real Node signed contracts for allowDirectIce true false and legacy omitted`() {
        // Generated directly via lib/connection-bootstrap-contract.mjs (buildConnectionBootstrapContract + buildContractSigningPayload + ed25519 sign)
        val publicKey = ConnectionBootstrapPublicKeyDto(
            algorithm = "ed25519",
            keyId = "parity-key",
            publicKeyPem = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAdJxVvM+fH/z11nHYSD/qhBezd+RACy6HxAB+UopJOQ=\n-----END PUBLIC KEY-----\n",
        )
        val nowMs = 1_788_307_202_000L

        fun nodeSignedContract(allowDirectIceField: String, signatureValue: String): String = """
            {
              "contractVersion": 2,
              "instanceId": "rli_parity_001",
              "deviceId": "rdev_parity_001",
              "enrollmentKind": "account-join",
              "connectionMode": "turn-first",
              $allowDirectIceField
              "issuedAt": "2026-09-02T00:00:00.000Z",
              "expiresAt": "2099-01-01T00:00:00.000Z",
              "candidates": [
                {
                  "id": "cand_1cd4b64b1d15e6702f605e30",
                  "kind": "turn",
                  "provider": "cloudflare-realtime",
                  "endpoint": "turn:turn.example.com:3478?transport=udp",
                  "priority": 120,
                  "expiresAt": "2099-01-01T00:00:00.000Z",
                  "requiresUserConsent": false,
                  "metadata": {
                    "appTrafficOnly": true,
                    "carrier": "cloudflare-realtime-turn",
                    "connectionId": "turn_parity_1",
                    "iceServers": [
                      {
                        "urls": "turn:turn.example.com:3478?transport=udp",
                        "username": "u",
                        "password": "p"
                      }
                    ]
                  }
                },
                {
                  "id": "cand_d47ec3594134aea07ca7f275",
                  "kind": "webrtc",
                  "provider": "core_p2p",
                  "endpoint": "https://signal.example.com",
                  "priority": 60,
                  "expiresAt": "2099-01-01T00:00:00.000Z",
                  "requiresUserConsent": false,
                  "metadata": {
                    "roomId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "turnAllowed": true
                  }
                }
              ],
              "turn": {
                "provider": "cloudflare-realtime",
                "endpoint": "turn:turn.example.com:3478?transport=udp",
                "iceServers": [
                  {
                    "urls": "turn:turn.example.com:3478?transport=udp",
                    "username": "u",
                    "password": "p"
                  }
                ],
                "expiresAt": "2099-01-01T00:00:00.000Z",
                "transport": "turn",
                "appTrafficOnly": true,
                "credentialScope": "device-access",
                "source": "turn-broker",
                "connectionId": "turn_parity_1",
                "authorization": {
                  "policyVersion": "turn-account-quota-v1",
                  "authorized": true,
                  "status": "authorized",
                  "reasonCode": "turn_authorized",
                  "plan": "pro",
                  "maxDevices": 10,
                  "activeDeviceCount": 1,
                  "connectionId": "turn_parity_1"
                }
              },
              "turnAuthorization": {
                "policyVersion": "turn-account-quota-v1",
                "authorized": true,
                "status": "authorized",
                "reasonCode": "turn_authorized",
                "plan": "pro",
                "maxDevices": 10,
                "activeDeviceCount": 1,
                "connectionId": "turn_parity_1"
              },
              "initialCarrier": {
                "candidateId": "cand_1cd4b64b1d15e6702f605e30",
                "kind": "turn",
                "provider": "cloudflare-realtime",
                "endpoint": "turn:turn.example.com:3478?transport=udp"
              },
              "upgrade": {
                "strategy": "probe-after-bootstrap",
                "targets": ["webrtc"],
                "retainCurrentWhenNoP2PPath": true
              },
              "fallback": null,
              "signature": {
                "algorithm": "ed25519",
                "keyId": "parity-key",
                "signedAt": "2026-09-02T00:00:01.000Z",
                "value": "$signatureValue"
              }
            }
        """.trimIndent()

        val directTrueRaw = nodeSignedContract(
            """"allowDirectIce": true,""",
            "Z1YUwh-lthzArMjqmqY-_evm3zao4J-Jzbs3HA4ox1qWMVMXP_JwzyLLgv9rk8mswJcbWFvA5zI5B03VwLQ7AQ",
        )
        assertEquals(
            "ragent-connection-bootstrap-v2\nrli_parity_001\nrdev_parity_001\nturn-first\n2026-09-02T00:00:00.000Z\n2099-01-01T00:00:00.000Z\n889003f7eb0abcd4121b3a79a0b02414c4e59a4c54e6150f16f04365b1800f2c",
            ConnectionBootstrapVerifier.buildSigningPayload(RagentProtocol.json.parseToJsonElement(directTrueRaw).jsonObject),
        )
        val verifiedTrue = ConnectionBootstrapVerifier.verify(directTrueRaw, publicKey, nowMs)
        assertEquals(true, verifiedTrue.contract.allowDirectIce)

        // Key-order independence across HTTP/JSON re-serialization
        val reorderedTrueObj = RagentProtocol.json.parseToJsonElement(directTrueRaw).jsonObject
        val reorderedTrueRaw = JsonObject(reorderedTrueObj.toList().reversed().toMap()).toString()
        assertEquals(true, ConnectionBootstrapVerifier.verify(reorderedTrueRaw, publicKey, nowMs).contract.allowDirectIce)

        val directFalseRaw = nodeSignedContract(
            """"allowDirectIce": false,""",
            "qtOlgZxQXRrlMQrIw6qiqgVLUjwoCQIFefOxJ8zoTje5YywX9YDKfwHchpLFw5SF2tkCnaiBZTiyFNITfrByCg",
        )
        assertEquals(
            "ragent-connection-bootstrap-v2\nrli_parity_001\nrdev_parity_001\nturn-first\n2026-09-02T00:00:00.000Z\n2099-01-01T00:00:00.000Z\n8b6f549face077944e015e13b8a88f1bf464e08145e25d4d2233e18b5e33a21c",
            ConnectionBootstrapVerifier.buildSigningPayload(RagentProtocol.json.parseToJsonElement(directFalseRaw).jsonObject),
        )
        assertEquals(false, ConnectionBootstrapVerifier.verify(directFalseRaw, publicKey, nowMs).contract.allowDirectIce)

        val legacyRaw = nodeSignedContract(
            "",
            "XT_oYdve9_Gql8p28MIXcsqSxcNQaQmI02timgn0UkhhHq6lITgwEOCcXAoBGvYCsksJ5YzlIoSgrF95wOsPCQ",
        )
        assertEquals(
            "ragent-connection-bootstrap-v2\nrli_parity_001\nrdev_parity_001\nturn-first\n2026-09-02T00:00:00.000Z\n2099-01-01T00:00:00.000Z\nf5a2867c6f518d81cccb05967169a6616e2f39c3033dd0dcaad58f80016dda49",
            ConnectionBootstrapVerifier.buildSigningPayload(RagentProtocol.json.parseToJsonElement(legacyRaw).jsonObject),
        )
        assertEquals(false, ConnectionBootstrapVerifier.verify(legacyRaw, publicKey, nowMs).contract.allowDirectIce)

        // Tampering or invalid allowDirectIce types must fail verification
        val directTrueObj = RagentProtocol.json.parseToJsonElement(directTrueRaw).jsonObject
        val directFalseObj = RagentProtocol.json.parseToJsonElement(directFalseRaw).jsonObject
        val legacyObj = RagentProtocol.json.parseToJsonElement(legacyRaw).jsonObject
        for (tampered in listOf(
            JsonObject(directTrueObj + ("allowDirectIce" to JsonPrimitive(false))),
            JsonObject(directTrueObj - "allowDirectIce"),
            JsonObject(directFalseObj + ("allowDirectIce" to JsonPrimitive(true))),
            JsonObject(legacyObj + ("allowDirectIce" to JsonPrimitive(true))),
            JsonObject(directTrueObj + ("allowDirectIce" to JsonNull)),
            JsonObject(directTrueObj + ("allowDirectIce" to JsonPrimitive("true"))),
        )) {
            assertFailsWith<ConnectionBootstrapVerificationException> {
                ConnectionBootstrapVerifier.verify(tampered.toString(), publicKey, nowMs)
            }
        }
    }
}
