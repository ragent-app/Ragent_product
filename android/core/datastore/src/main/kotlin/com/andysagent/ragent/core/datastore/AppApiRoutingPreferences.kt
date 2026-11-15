package com.andysagent.ragent.core.datastore

import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Sharing/agent routing is independent from the computer selected in the UI. */
@Serializable
data class AppApiRoutingPreferences(
    val version: Int = 1,
    val defaultShareTargetId: String? = null,
    val aliasesByTarget: Map<String, Set<String>> = emptyMap(),
    @Transient val readable: Boolean = true,
)

internal object AppApiRoutingCodec {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun decode(raw: String?): AppApiRoutingPreferences {
        if (raw == null) return AppApiRoutingPreferences()
        // Broken/future settings must not silently change the target. Other UI
        // configuration remains usable so the owner can explicitly reset them.
        return runCatching {
            require(raw.length <= 256_000)
            json.decodeFromString<AppApiRoutingPreferences>(raw).also { value ->
                require(value.version == 1)
                require(value.defaultShareTargetId == null || value.defaultShareTargetId.isNotBlank())
                require(value.aliasesByTarget.all { (id, aliases) ->
                    id.isNotBlank() && aliases.size <= 8 && aliases.all(::validAlias)
                })
            }
        }.getOrElse { AppApiRoutingPreferences(readable = false) }
    }

    fun encode(value: AppApiRoutingPreferences): String {
        require(value.readable && value.version == 1)
        return json.encodeToString(value)
    }

    fun validAlias(alias: String): Boolean =
        alias.isNotBlank() && alias.length <= 64 && alias.none(Char::isISOControl)
}
