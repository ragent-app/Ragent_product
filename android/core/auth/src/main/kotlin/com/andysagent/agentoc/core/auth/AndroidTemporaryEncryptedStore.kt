package com.andysagent.agentoc.core.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Small synchronous, per-record encrypted journal primitive; all records bind their logical AAD. */
class AndroidTemporaryEncryptedStore(
    context: Context,
    name: String,
    private val alias: String,
    private val keyPrefix: String = "entry_",
    private val maxPlaintextBytes: Int = 131_040,
) {
    private val prefs = context.applicationContext.getSharedPreferences(name, Context.MODE_PRIVATE)

    fun read(identity: String): String? {
        val blob = prefs.getString(keyName(identity), null) ?: return null
        val parts = blob.split(':')
        require(parts.size == 2) { "Temporary journal is damaged" }
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)
        require(iv.size == 12 && ciphertext.size in 17..(maxPlaintextBytes + 16)) { "Temporary journal is damaged" }
        val plaintext = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            updateAAD(identity.toByteArray(Charsets.UTF_8))
        }.doFinal(ciphertext)
        return plaintext.toString(Charsets.UTF_8)
    }

    fun write(identity: String, value: String) {
        val plaintext = value.toByteArray(Charsets.UTF_8)
        require(plaintext.size <= maxPlaintextBytes) { "Temporary journal record is too large" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key())
            updateAAD(identity.toByteArray(Charsets.UTF_8))
        }
        val blob = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP)
        check(prefs.edit().putString(keyName(identity), blob).commit()) { "Temporary journal could not be saved" }
    }

    fun clear(identity: String) {
        check(prefs.edit().remove(keyName(identity)).commit()) { "Temporary journal could not be cleared" }
    }

    private fun keyName(identity: String): String = keyPrefix + MessageDigest.getInstance("SHA-256")
        .digest(identity.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
        }.generateKey()
    }
}
