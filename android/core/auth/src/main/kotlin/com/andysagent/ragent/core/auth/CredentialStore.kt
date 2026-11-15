package com.andysagent.ragent.core.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface CredentialStore {
    val credential: StateFlow<StoredCredential?>
    fun read(): StoredCredential?
    fun write(token: String, expiresAt: String? = null, scope: String? = null)
    fun clear()

    /** Target-aware APIs. Legacy implementations remain source-compatible. */
    fun read(instanceId: String): StoredCredential? = read()
    fun readToken(instanceId: String): String? = null
    fun write(instanceId: String, token: String, expiresAt: String? = null, scope: String? = null) = write(token, expiresAt, scope)
    fun clear(instanceId: String) = clear()

    /** Separate physical namespace; a device id must never address account archives. */
    fun readAccountProfile(accountId: String?, instanceId: String): StoredCredential? =
        throw UnsupportedOperationException("Account credential profiles are unsupported")
    fun readAccountProfileToken(accountId: String?, instanceId: String): String? =
        throw UnsupportedOperationException("Account credential profiles are unsupported")
    fun writeAccountProfile(accountId: String?, instanceId: String, token: String, expiresAt: String? = null, scope: String? = null): Unit =
        throw UnsupportedOperationException("Account credential profiles are unsupported")
    fun clearAccountProfile(accountId: String?, instanceId: String): Unit =
        throw UnsupportedOperationException("Account credential profiles are unsupported")
    fun clearAccountProfiles(accountId: String?): Unit =
        throw UnsupportedOperationException("Account credential profiles are unsupported")
}

data class StoredCredential(
    val expiresAt: String? = null,
    val scope: String? = null,
)

data class StoredP2PConfig(
    val signalingEndpoint: String,
    val roomId: String,
    val secret: String,
)

interface P2PSecretStore {
    fun read(): StoredP2PConfig?
    fun write(config: StoredP2PConfig)
    fun clear()
    fun read(instanceId: String): StoredP2PConfig? = read()
    fun write(instanceId: String, config: StoredP2PConfig) = write(config)
    fun clear(instanceId: String) = clear()

    fun readAccountProfile(accountId: String?, instanceId: String): StoredP2PConfig? =
        throw UnsupportedOperationException("Account P2P profiles are unsupported")
    fun writeAccountProfile(accountId: String?, instanceId: String, config: StoredP2PConfig): Unit =
        throw UnsupportedOperationException("Account P2P profiles are unsupported")
    fun clearAccountProfile(accountId: String?, instanceId: String): Unit =
        throw UnsupportedOperationException("Account P2P profiles are unsupported")
    fun clearAccountProfiles(accountId: String?): Unit =
        throw UnsupportedOperationException("Account P2P profiles are unsupported")
}

class AndroidCredentialStore(context: Context) : CredentialStore {
    private val prefs = context.applicationContext.getSharedPreferences("ragent-credential", Context.MODE_PRIVATE)
    private val tokenRef = AtomicReference<String?>(null)
    private val state = MutableStateFlow(loadMetadata(""))
    private val alias = "ragent_credential_key_v1"

    override val credential: StateFlow<StoredCredential?> = state

    override fun read(): StoredCredential? {
        return readForPrefix("")
    }

    override fun read(instanceId: String): StoredCredential? = readForPrefix(prefix(instanceId))

    override fun readToken(instanceId: String): String? {
        read(instanceId)
        return decryptToken(prefix(instanceId))
    }

    override fun write(instanceId: String, token: String, expiresAt: String?, scope: String?) {
        writeForPrefix(prefix(instanceId), token, expiresAt, scope)
    }

    override fun clear(instanceId: String) {
        prefs.edit().remove(prefix(instanceId) + "token").remove(prefix(instanceId) + "iv")
            .remove(prefix(instanceId) + "expiresAt").remove(prefix(instanceId) + "scope").commit().also { check(it) { "Could not persist encrypted device credentials" } }
    }

    override fun readAccountProfile(accountId: String?, instanceId: String): StoredCredential? =
        readForPrefix(CredentialProfileNamespace.target(accountId, instanceId))

    override fun readAccountProfileToken(accountId: String?, instanceId: String): String? {
        if (readAccountProfile(accountId, instanceId) == null) return null
        return decryptToken(CredentialProfileNamespace.target(accountId, instanceId))
    }

    override fun writeAccountProfile(accountId: String?, instanceId: String, token: String, expiresAt: String?, scope: String?) =
        writeForPrefix(CredentialProfileNamespace.target(accountId, instanceId), token, expiresAt, scope, publish = false)

    override fun clearAccountProfile(accountId: String?, instanceId: String) =
        clearPrefix(CredentialProfileNamespace.target(accountId, instanceId))

    override fun clearAccountProfiles(accountId: String?) {
        val owner = CredentialProfileNamespace.owner(accountId)
        val editor = prefs.edit()
        prefs.all.keys.filter { it.startsWith(owner) }.forEach { editor.remove(it) }
        check(editor.commit()) { "Could not persist encrypted device credentials" }
    }

    fun migrateLegacyTo(instanceId: String) {
        if (prefs.contains(prefix(instanceId) + "token")) return
        val token = readToken() ?: return
        val metadata = read() ?: return
        write(instanceId, token, metadata.expiresAt, metadata.scope)
    }

    private fun readForPrefix(prefix: String): StoredCredential? {
        val metadata = loadMetadata(prefix) ?: return null
        if (metadata.expiresAt?.let(::isExpired) == true) {
            // Expiring the legacy slot must not erase other targets or owners.
            clearPrefix(prefix)
            if (prefix.isBlank()) {
                tokenRef.set(null)
                state.value = null
            }
            return null
        }
        val token = if (prefix.isBlank()) {
            if (tokenRef.get() == null) tokenRef.set(decryptToken(prefix))
            tokenRef.get()
        } else decryptToken(prefix)
        return metadata.takeIf { !token.isNullOrBlank() }
    }

    fun readToken(): String? {
        if (read() == null) return null
        return tokenRef.get()
    }

    override fun write(token: String, expiresAt: String?, scope: String?) {
        writeForPrefix("", token, expiresAt, scope)
    }

    private fun writeForPrefix(prefix: String, token: String, expiresAt: String?, scope: String?, publish: Boolean = true) {
        require(token.isNotBlank()) { "Credential token must not be blank" }
        // Android Keystore AES/GCM generates the IV internally on ENCRYPT;
        // a caller-provided IV is rejected (InvalidAlgorithmParameterException).
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key())
        }
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val iv = cipher.iv
        val editor = prefs.edit()
            .putString(prefix + "token", encrypted.toBase64())
            .putString(prefix + "iv", iv.toBase64())
        if (expiresAt != null) editor.putString(prefix + "expiresAt", expiresAt) else editor.remove(prefix + "expiresAt")
        if (scope != null) editor.putString(prefix + "scope", scope) else editor.remove(prefix + "scope")
        // commit() (not apply()) so the credential is durable before the caller
        // proceeds — apply() is async and a quick process restart can lose it.
        editor.commit().also { check(it) { "Could not persist encrypted device credentials" } }
        if (prefix.isBlank()) tokenRef.set(token)
        if (publish) state.value = StoredCredential(expiresAt, scope)
    }

    override fun clear() {
        prefs.edit().clear().apply()
        tokenRef.set(null)
        state.value = null
    }

    private fun loadMetadata(prefix: String): StoredCredential? {
        val token = prefs.getString(prefix + "token", null)
        return if (token.isNullOrBlank()) null else StoredCredential(
            expiresAt = prefs.getString(prefix + "expiresAt", null),
            scope = prefs.getString(prefix + "scope", null),
        )
    }

    private fun decryptToken(prefix: String): String? {
        val token = prefs.getString(prefix + "token", null)?.fromBase64() ?: return null
        val iv = prefs.getString(prefix + "iv", null)?.fromBase64() ?: return null
        return runCatching {
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                // DECRYPT allows a caller-provided IV (the one saved at write time).
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            }.doFinal(token).toString(Charsets.UTF_8)
        }.getOrNull()
    }

    private fun clearPrefix(prefix: String) {
        prefs.edit().remove(prefix + "token").remove(prefix + "iv")
            .remove(prefix + "expiresAt").remove(prefix + "scope").commit().also { check(it) { "Could not persist encrypted device credentials" } }
    }

    private fun prefix(instanceId: String): String = "target_" + instanceId.sha256() + "_"

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

    private fun isExpired(value: String): Boolean = runCatching {
        java.time.Instant.parse(value).toEpochMilli() <= System.currentTimeMillis()
    }.getOrDefault(false)
}

private fun ByteArray.toBase64(): String = Base64.encodeToString(this, Base64.NO_WRAP)
private fun String.fromBase64(): ByteArray = Base64.decode(this, Base64.NO_WRAP)

class AndroidP2PSecretStore(context: Context) : P2PSecretStore {
    private val prefs = context.applicationContext.getSharedPreferences("ragent-p2p-credential", Context.MODE_PRIVATE)
    private val alias = "ragent_p2p_secret_key_v1"

    override fun read(): StoredP2PConfig? {
        return readForPrefix("")
    }

    override fun read(instanceId: String): StoredP2PConfig? = readForPrefix(prefix(instanceId))

    override fun write(instanceId: String, config: StoredP2PConfig) = writeForPrefix(prefix(instanceId), config)

    override fun clear(instanceId: String) = clearPrefix(prefix(instanceId))

    override fun readAccountProfile(accountId: String?, instanceId: String): StoredP2PConfig? =
        readForPrefix(CredentialProfileNamespace.target(accountId, instanceId))

    override fun writeAccountProfile(accountId: String?, instanceId: String, config: StoredP2PConfig) =
        writeForPrefix(CredentialProfileNamespace.target(accountId, instanceId), config)

    override fun clearAccountProfile(accountId: String?, instanceId: String) =
        clearPrefix(CredentialProfileNamespace.target(accountId, instanceId))

    override fun clearAccountProfiles(accountId: String?) {
        val owner = CredentialProfileNamespace.owner(accountId)
        val editor = prefs.edit()
        prefs.all.keys.filter { it.startsWith(owner) }.forEach { editor.remove(it) }
        check(editor.commit()) { "Could not persist encrypted device credentials" }
    }

    fun migrateLegacyTo(instanceId: String) {
        if (prefs.contains(prefix(instanceId) + "secret")) return
        read()?.let { write(instanceId, it) }
    }

    private fun readForPrefix(prefix: String): StoredP2PConfig? {
        val signalingEndpoint = prefs.getString(prefix + "signalingEndpoint", null).orEmpty()
        val scopedRoomId = prefs.getString(prefix + "roomId", null).orEmpty()
        val encrypted = prefs.getString(prefix + "secret", null)?.fromBase64() ?: return null
        val iv = prefs.getString(prefix + "iv", null)?.fromBase64() ?: return null
        if (signalingEndpoint.isBlank() || scopedRoomId.isBlank()) return null
        val secret = runCatching {
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            }.doFinal(encrypted).toString(Charsets.UTF_8)
        }.getOrNull().orEmpty()
        return secret.takeIf { it.isNotBlank() }?.let {
            StoredP2PConfig(signalingEndpoint, scopedRoomId, it)
        }
    }

    override fun write(config: StoredP2PConfig) {
        writeForPrefix("", config)
    }

    private fun writeForPrefix(prefix: String, config: StoredP2PConfig) {
        require(config.signalingEndpoint.isNotBlank()) { "P2P signaling endpoint must not be blank" }
        require(config.roomId.isNotBlank()) { "P2P room id must not be blank" }
        require(config.secret.isNotBlank()) { "P2P secret must not be blank" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key())
        }
        val encrypted = cipher.doFinal(config.secret.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString(prefix + "signalingEndpoint", config.signalingEndpoint.trimEnd('/'))
            .putString(prefix + "roomId", config.roomId)
            .putString(prefix + "secret", encrypted.toBase64())
            .putString(prefix + "iv", cipher.iv.toBase64())
            .commit().also { check(it) { "Could not persist encrypted device credentials" } }
    }

    override fun clear() {
        prefs.edit().clear().commit().also { check(it) { "Could not persist encrypted device credentials" } }
    }

    private fun clearPrefix(prefix: String) {
        prefs.edit().remove(prefix + "signalingEndpoint").remove(prefix + "roomId")
            .remove(prefix + "secret").remove(prefix + "iv").commit().also { check(it) { "Could not persist encrypted device credentials" } }
    }

    private fun prefix(instanceId: String): String = "target_" + instanceId.sha256() + "_"

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

private fun String.sha256(): String = MessageDigest.getInstance("SHA-256")
    .digest(toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
