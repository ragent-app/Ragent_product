package com.andysagent.ragent

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.interfaces.RSAPublicKey
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.time.Instant
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject

/**
 * Opt-in credential rejection probe for the coordinated installed Windows QA target.
 * The local verifier holds its ephemeral RSA private key only in memory. Neither
 * plaintext credentials nor account credentials are emitted or restored.
 */
@RunWith(AndroidJUnit4::class)
class AccountRevocationCredentialLiveProbeTest {
    @Test fun sealsExistingTargetCredentialForLocalRejectionChecks() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("liveCentralRevocationCredentialProbe") == "true")
        val publicKeyBytes = Base64.getUrlDecoder().decode(
            requireNotNull(args.getString("localVerifierPublicKey")),
        )
        require(publicKeyBytes.size in 256..800) { "Unexpected verifier key size" }
        val key = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(publicKeyBytes)) as RSAPublicKey
        require(key.modulus.bitLength() == 3072) { "Expected the ephemeral local verifier key" }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val runtime = (instrumentation.targetContext.applicationContext as RagentApplication).runtime
        val target = requireNotNull(runtime.configStore.directory.first().activeTarget)
        val targetFingerprint = MessageDigest.getInstance("SHA-256")
            .digest(target.instanceId.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        require(targetFingerprint == WINDOWS_QA_FINGERPRINT) { "Unexpected selected target; no credential was exported" }
        val before = requireNotNull(runtime.credentialStore.read(target.instanceId))
        val token = requireNotNull(runtime.credentialStore.readToken(target.instanceId))
        require(token.matches(Regex("^rda_[A-Za-z0-9_-]{32,124}$"))) { "No existing target credential" }
        require(before == runtime.credentialStore.read(target.instanceId) &&
            token == runtime.credentialStore.readToken(target.instanceId)) { "Credential changed during capture" }
        val expiresAt = Instant.parse(requireNotNull(before.expiresAt))
        require(expiresAt.isAfter(Instant.now().plusSeconds(300))) { "Credential is too close to expiry for this probe" }
        val bytes = JSONObject().put("token", token).put("expiresAt", expiresAt.toString())
            .toString().toByteArray(Charsets.UTF_8)
        require(bytes.size <= 318) { "Unexpected probe envelope size" }
        try {
            val sealed = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding").run {
                init(Cipher.ENCRYPT_MODE, key, OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT))
                doFinal(bytes)
            }
            instrumentation.sendStatus(1, Bundle().apply {
                putString("revocationTargetFingerprint", targetFingerprint)
                putString("sealedRevocationProbe", Base64.getUrlEncoder().withoutPadding().encodeToString(sealed))
            })
        } finally {
            bytes.fill(0)
        }
    }

    private companion object {
        const val WINDOWS_QA_FINGERPRINT = "5c031d309caec9c8c42410265f28668d3e6e5ecdb678628f08885e52d384b12c"
    }
}
