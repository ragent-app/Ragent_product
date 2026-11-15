package com.andysagent.ragent.core.datastore

import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.booleanPreferencesKey
import kotlinx.serialization.json.*

/** Non-secret directories only. Never archive bearer tokens, signing keys or provider data. */
internal object AccountDirectoryProfiles {
    private val archiveKey = stringPreferencesKey("account_directory_profiles_v1")
    private val ownerKey = stringPreferencesKey("directory_profile_owner")
    private val keys = listOf("endpoint", "instance_id", "label", "linked_computers", "active_target_id",
        "app_api_routing", "share_runtime_selections", "chat_runtime_cache_v1")
    private val restoreKey = booleanPreferencesKey("automatic_account_restore_suppressed")
    private const val LOCAL = "local"

    fun owner(prefs: Preferences, fallbackAccountId: String?): String? =
        prefs[ownerKey]?.let { if (it == LOCAL) null else it } ?: fallbackAccountId.takeIf { prefs[ownerKey] == null }

    fun switch(prefs: MutablePreferences, previousAccountId: String?, nextAccountId: String?) {
        val previous = prefs[ownerKey] ?: previousAccountId ?: LOCAL
        val next = nextAccountId ?: LOCAL
        if (previous == next) { prefs[ownerKey] = next; return }
        val raw = prefs[archiveKey]
        require(raw == null || raw.length <= 1_048_576) { "Account directory archive is too large" }
        // Invalid archives abort the DataStore transaction, preserving current data.
        val profiles = raw?.let { Json.parseToJsonElement(it).jsonObject.toMutableMap() } ?: mutableMapOf()
        val saved = buildJsonObject {
            keys.forEach { key -> prefs[stringPreferencesKey(key)]?.let { put(key, it) } }
            prefs[restoreKey]?.let { put("automatic_account_restore_suppressed", it) }
        }
        val restored = profiles[next]?.jsonObject
        val values = keys.associateWith { key -> restored?.get(key)?.jsonPrimitive?.contentOrNull }
        val suppressed = restored?.get("automatic_account_restore_suppressed")?.jsonPrimitive?.booleanOrNull
        profiles[previous] = saved
        val encoded = JsonObject(profiles).toString()
        require(encoded.length <= 1_048_576) { "Account directory archive is too large" }
        keys.forEach { key ->
            val pref = stringPreferencesKey(key)
            values[key]?.let { prefs[pref] = it } ?: prefs.remove(pref)
        }
        suppressed?.let { prefs[restoreKey] = it } ?: prefs.remove(restoreKey)
        prefs.asMap().keys.filter { it.name.startsWith("pending_join_") || it.name.startsWith("pending_google_") }
            .forEach { prefs.remove(it) }
        prefs[archiveKey] = encoded
        prefs[ownerKey] = next
    }
}
