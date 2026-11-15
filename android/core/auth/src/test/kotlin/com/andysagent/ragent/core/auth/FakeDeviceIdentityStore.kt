package com.andysagent.ragent.core.auth

import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class FakeDeviceIdentityStore : DeviceIdentityStore {
    private val keyPair = run {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"), java.security.SecureRandom())
        generator.generateKeyPair()
    }
    private var cleared = false

    override fun publicKeyEncoded(): String {
        check(!cleared) { "Identity store has been cleared" }
        val der = keyPair.public.encoded
        val base64 = Base64.getEncoder().encodeToString(der)
        return buildString {
            appendLine("-----BEGIN PUBLIC KEY-----")
            base64.chunked(64).forEach { appendLine(it) }
            append("-----END PUBLIC KEY-----")
        }
    }

    override fun sign(message: String): String {
        check(!cleared) { "Identity store has been cleared" }
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(keyPair.private)
        signature.update(message.toByteArray(Charsets.UTF_8))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(signature.sign())
    }

    override fun clear() {
        cleared = true
    }

    val isCleared: Boolean get() = cleared
}
