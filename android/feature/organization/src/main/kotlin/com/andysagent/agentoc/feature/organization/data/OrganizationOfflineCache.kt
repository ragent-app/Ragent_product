package com.andysagent.agentoc.feature.organization.data

import android.content.Context
import com.andysagent.agentoc.core.auth.AndroidTemporaryEncryptedStore
import java.security.MessageDigest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject

/** Bounded, encrypted snapshots; scope contains verified account/device/target/session identity. */
internal class OrganizationOfflineCache(context: Context) {
    private val store = AndroidTemporaryEncryptedStore(context, "organization_offline_v1", "organization_offline_v1")
    private val identity = "organization-offline-snapshots-v1"
    private fun key(scope: String): String = MessageDigest.getInstance("SHA-256")
        .digest(scope.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }

    val invalidations: StateFlow<Long> get() = invalidationFlow

    fun generation(scope: String): Long = synchronized(lock) { generations[key(scope)] ?: 0L }
    fun isInvalid(scope: String): Boolean = synchronized(lock) { key(scope) in invalidScopes }
    fun isCurrent(scope: String, generation: Long): Boolean = synchronized(lock) {
        val scopeKey = key(scope)
        scopeKey !in invalidScopes && (generations[scopeKey] ?: 0L) == generation
    }

    fun read(scope: String, path: String = "projection"): Pair<String, Long>? {
        return synchronized(lock) { runCatching {
            if (key(scope) in invalidScopes) return null
            val record = JSONObject(store.read(identity) ?: return null).optJSONObject(key(scope) + key(path)) ?: return null
            val at = record.getLong("at")
            val age = System.currentTimeMillis() - at
            if (age < 0 || age > 7L * 24 * 60 * 60 * 1000) return null
            record.getString("body") to at
        }.getOrNull() }
    }

    /** Invalidates in-flight writers before attempting durable removal. */
    fun clear(scope: String): Boolean = synchronized(lock) {
        val scopeKey = key(scope)
        generations[scopeKey] = (generations[scopeKey] ?: 0L) + 1L
        invalidScopes.add(scopeKey)
        invalidationFlow.value += 1L
        val removed = runCatching {
            val all = JSONObject(store.read(identity) ?: "{}")
            all.keys().asSequence().toList().filter { it.startsWith(scopeKey) }.forEach { all.remove(it) }
            store.write(identity, all.toString())
        }.isSuccess || runCatching { store.clear(identity) }.isSuccess
        if (removed) invalidScopes.remove(scopeKey)
        removed
    }

    fun write(scope: String, body: String, generation: Long, path: String = "projection") {
        synchronized(lock) { runCatching {
            val scopeKey = key(scope)
            if (scopeKey in invalidScopes || (generations[scopeKey] ?: 0L) != generation) return
            if (body.toByteArray(Charsets.UTF_8).size > 20_000) return
            val all = JSONObject(store.read(identity) ?: "{}")
            all.put(key(scope) + key(path), JSONObject().put("at", System.currentTimeMillis()).put("body", body))
            val protectedProjection = key(scope) + key("projection")
            val keys = all.keys().asSequence().toList().filter { it != protectedProjection }
                .sortedByDescending { all.optJSONObject(it)?.optLong("at") ?: 0 }
            keys.drop(4).forEach { all.remove(it) }
            store.write(identity, all.toString())
        }
        Unit }
    }

    companion object {
        private val lock = Any()
        private val generations = mutableMapOf<String, Long>()
        private val invalidScopes = mutableSetOf<String>()
        private val invalidationFlow = MutableStateFlow(0L)
    }
}
