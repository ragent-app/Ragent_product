package com.andysagent.agentoc.feature.organization.data

import android.content.Context
import com.andysagent.agentoc.core.auth.AndroidTemporaryEncryptedStore
import java.security.MessageDigest
import org.json.JSONObject

/** Bounded, encrypted snapshots; scope contains verified account/device/target/session identity. */
internal class OrganizationOfflineCache(context: Context) {
    private val store = AndroidTemporaryEncryptedStore(context, "organization_offline_v1", "organization_offline_v1")
    private val identity = "organization-offline-snapshots-v1"
    private fun key(scope: String): String = MessageDigest.getInstance("SHA-256")
        .digest(scope.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }

    fun read(scope: String, path: String = "projection"): Pair<String, Long>? {
        return synchronized(lock) { runCatching {
            val record = JSONObject(store.read(identity) ?: return null).optJSONObject(key(scope) + key(path)) ?: return null
            val at = record.getLong("at")
            val age = System.currentTimeMillis() - at
            if (age < 0 || age > 7L * 24 * 60 * 60 * 1000) return null
            record.getString("body") to at
        }.getOrNull() }
    }

    fun clear(scope: String) {
        synchronized(lock) { runCatching {
            val all = JSONObject(store.read(identity) ?: return)
            all.keys().asSequence().toList().filter { it.startsWith(key(scope)) }.forEach { all.remove(it) }
            store.write(identity, all.toString())
        }
        Unit }
    }

    fun write(scope: String, body: String, path: String = "projection") {
        synchronized(lock) { runCatching {
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

    companion object { private val lock = Any() }
}
