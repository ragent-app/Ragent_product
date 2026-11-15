package com.andysagent.ragent.core.auth

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class FakeCredentialStore : CredentialStore {
    private val state = MutableStateFlow<StoredCredential?>(null)
    private val tokenRef = mutableListOf<String>()

    override val credential: StateFlow<StoredCredential?> = state

    override fun read(): StoredCredential? {
        val meta = state.value
        if (meta != null && meta.expiresAt?.let { isExpired(it) } == true) {
            clear()
            return null
        }
        return if (tokenRef.lastOrNull().isNullOrBlank()) null else meta
    }

    override fun write(token: String, expiresAt: String?, scope: String?) {
        require(token.isNotBlank()) { "Credential token must not be blank" }
        tokenRef.add(token)
        state.value = StoredCredential(expiresAt, scope)
    }

    override fun clear() {
        tokenRef.clear()
        state.value = null
    }

    val lastToken: String? get() = tokenRef.lastOrNull()
    val lastScope: String? get() = state.value?.scope
    val isCleared: Boolean get() = state.value == null && tokenRef.isEmpty()

    private fun isExpired(value: String): Boolean = runCatching {
        java.time.Instant.parse(value).toEpochMilli() <= System.currentTimeMillis()
    }.getOrDefault(false)
}
