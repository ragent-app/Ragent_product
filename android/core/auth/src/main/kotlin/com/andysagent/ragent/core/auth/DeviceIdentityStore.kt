package com.andysagent.ragent.core.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Locale

interface DeviceIdentityStore {
    fun publicKeyEncoded(): String
    fun sign(message: String): String
    fun clear()
}

/** SHA-256 of the DER SubjectPublicKeyInfo represented by a PEM public key. */
fun devicePublicKeyFingerprint(publicKey: String): String {
    val encoded = publicKey
        .lineSequence()
        .map(String::trim)
        .filter { it.isNotEmpty() && !it.startsWith("-----") }
        .joinToString("")
    require(encoded.isNotBlank()) { "Device public key must be PEM encoded" }
    // java.util.Base64 is available from minSdk 26 and also keeps this
    // protocol utility runnable in JVM contract tests.
    val der = java.util.Base64.getDecoder().decode(encoded)
    return MessageDigest.getInstance("SHA-256").digest(der).joinToString("") {
        "%02x".format(it.toInt() and 0xff)
    }
}

/** Stable human-facing label for this installation, derived from its key. */
fun DeviceIdentityStore.defaultDeviceAlias(): String =
    "Android-${devicePublicKeyFingerprint(publicKeyEncoded()).take(8).uppercase(Locale.ROOT)}"

class AndroidDeviceIdentityStore(context: android.content.Context) : DeviceIdentityStore {
    private val alias = "ragent_device_identity_v3"
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    init {
        ensureKeyPair()
    }

    override fun publicKeyEncoded(): String {
        val publicKey = keyStore.getCertificate(alias).publicKey
        val der = publicKey.encoded
        val base64 = Base64.encodeToString(der, Base64.NO_WRAP)
        return buildString {
            appendLine("-----BEGIN PUBLIC KEY-----")
            base64.chunked(64).forEach { appendLine(it) }
            append("-----END PUBLIC KEY-----")
        }
    }

    /** Raw DER as standard Base64 for the Broker's device registration protocol. */
    fun brokerPublicKey(): String = java.util.Base64.getEncoder().encodeToString(
        Base64.decode(publicKeyEncoded().lineSequence().filterNot { it.startsWith("-----") }.joinToString(""), Base64.DEFAULT),
    )

    /** Signs the exact Broker canonical bytes with the app's existing device identity key. */
    fun signBrokerBytes(message: ByteArray): String {
        val privateKey = keyStore.getKey(alias, null) as PrivateKey
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(privateKey)
        signature.update(message)
        return java.util.Base64.getEncoder().encodeToString(signature.sign())
    }

    override fun sign(message: String): String {
        val privateKey = keyStore.getKey(alias, null) as PrivateKey
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(privateKey)
        signature.update(message.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(
            signature.sign(),
            Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING,
        )
    }

    override fun clear() {
        runCatching {
            keyStore.deleteEntry(alias)
        }
    }

    private fun ensureKeyPair() {
        if (keyStore.containsAlias(alias)) return
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build(),
            )
        }.generateKeyPair()
    }
}
