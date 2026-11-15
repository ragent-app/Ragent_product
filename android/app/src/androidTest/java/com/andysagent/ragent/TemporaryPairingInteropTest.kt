package com.andysagent.ragent

import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.protocol.TemporaryPairingProtocol
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.util.Base64
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** Actual Android crypto interoperability; no account, app pairing, network or Activity is touched. */
@RunWith(AndroidJUnit4::class)
class TemporaryPairingInteropTest {
    @Test fun nodeInvitationAndKeystoreProofInteroperate() {
        val encoded = requireNotNull(InstrumentationRegistry.getArguments().getString("temporaryPairingFixture"))
        val fixture = Json.parseToJsonElement(String(Base64.getDecoder().decode(encoded), Charsets.UTF_8)).jsonObject
        val envelope = fixture.getValue("envelope").jsonObject
        val original = envelope.getValue("invitation").jsonObject
        val invitation = TemporaryPairingProtocol.verifyForClaim(envelope.toString(),
            original.getValue("instanceId").jsonPrimitive.content,
            original.getValue("instanceKeyFingerprint").jsonPrimitive.content,
            original.getValue("createdAt").jsonPrimitive.content.toLong())
        assertEquals(fixture.getValue("invitationMessage").jsonPrimitive.content, TemporaryPairingProtocol.invitationMessage(invitation))

        // A dedicated disposable alias avoids the user's real DeviceIdentityStore key.
        val alias = "ragent_temporary_pairing_test_${UUID.randomUUID()}"
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        try {
            val pair = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256).build())
            }.generateKeyPair()
            val publicKey = Base64.getEncoder().encodeToString(pair.public.encoded)
            val requestId = "rtr_${UUID.randomUUID().toString().replace("-", "")}"
            val message = TemporaryPairingProtocol.claimMessage(invitation, requestId, publicKey)
            val signature = Signature.getInstance("SHA256withECDSA").apply {
                initSign(pair.private); update(message.toByteArray(Charsets.UTF_8))
            }.sign()
            val claim = JsonObject(mapOf(
                "instanceId" to JsonPrimitive(invitation.instanceId),
                "invitationId" to JsonPrimitive(invitation.invitationId),
                "invitationDigest" to JsonPrimitive(TemporaryPairingProtocol.invitationDigest(invitation)),
                "requestId" to JsonPrimitive(requestId), "devicePublicKey" to JsonPrimitive(publicKey),
                "signature" to JsonPrimitive(Base64.getUrlEncoder().withoutPadding().encodeToString(signature)),
            ))
            InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
                putString("temporaryPairingClaim", claim.toString())
            })
        } finally {
            keys.deleteEntry(alias)
        }
    }
}
