package com.andysagent.ragent.core.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secure storage for an Accounts-only `rac_` credential.
 *
 * This is intentionally independent from [CredentialStore]: that store holds
 * target-computer `rda_` credentials and must never be able to substitute an
 * Accounts credential into a computer request. Account, device, credential ID,
 * scope and expiry are non-secret metadata owned by ClientConfigStore.
 */
interface AccountCredentialStore {
    fun readToken(): String?
    fun writeToken(token: String)
    fun clear()
}

class AndroidAccountCredentialStore(context: Context) : AccountCredentialStore {
    private val prefs = context.applicationContext.getSharedPreferences(
        "ragent-account-credential",
        Context.MODE_PRIVATE,
    )
    private val tokenRef = AtomicReference<String?>(null)
    private val alias = "ragent_account_credential_key_v1"

    override fun readToken(): String? {
        tokenRef.get()?.let { return it }
        val encrypted = prefs.getString(KEY_TOKEN, null)?.fromAccountBase64() ?: return null
        val iv = prefs.getString(KEY_IV, null)?.fromAccountBase64() ?: return null
        val token = runCatching {
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            }.doFinal(encrypted).toString(Charsets.UTF_8)
        }.getOrNull()?.takeIf { it.isNotBlank() }
        if (token == null) clear()
        tokenRef.set(token)
        return token
    }

    override fun writeToken(token: String) {
        require(token.startsWith("rac_") && token.length > 4) {
            "Accounts credential must be a non-empty rac_ token"
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key())
        }
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        check(
            prefs.edit()
                .putString(KEY_TOKEN, encrypted.toAccountBase64())
                .putString(KEY_IV, cipher.iv.toAccountBase64())
                // Commit before returning: callers persist the corresponding
                // metadata immediately after and may be interrupted at any time.
                .commit(),
        ) { "Could not persist Accounts credential" }
        tokenRef.set(token)
    }

    override fun clear() {
        check(prefs.edit().clear().commit()) { "Could not clear Accounts credential" }
        tokenRef.set(null)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
        }.generateKey()
    }

    private companion object {
        const val KEY_TOKEN = "token"
        const val KEY_IV = "iv"
    }
}

private fun ByteArray.toAccountBase64(): String = Base64.encodeToString(this, Base64.NO_WRAP)
private fun String.fromAccountBase64(): ByteArray = Base64.decode(this, Base64.NO_WRAP)
