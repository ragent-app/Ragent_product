package com.andysagent.ragent.core.datastore

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Convenience only: neither a runtime catalog nor authorization to execute. */
@Serializable
data class ShareRuntimeSelection(val tool: String, val providerProfile: String? = null, val model: String,
    val effort: String? = null, val serviceTier: String = "standard")

@Serializable
private data class ShareRuntimePreferences(val version: Int = 1, val byTarget: Map<String, ShareRuntimeSelection> = emptyMap())

internal object ShareRuntimeCodec {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private fun validId(value: String) = value.isNotBlank() && value.length <= 512 && value.none(Char::isISOControl)
    fun valid(value: ShareRuntimeSelection) = validId(value.tool) && validId(value.model) &&
        (value.providerProfile == null || validId(value.providerProfile)) &&
        (value.effort == null || validId(value.effort)) && validId(value.serviceTier)

    fun decode(raw: String?): Map<String, ShareRuntimeSelection> = if (raw == null) emptyMap() else runCatching {
        require(raw.length <= 256_000)
        val value = json.decodeFromString<ShareRuntimePreferences>(raw)
        require(value.version == 1 && value.byTarget.size <= 128)
        require(value.byTarget.all { (id, selection) -> validId(id) && valid(selection) })
        value.byTarget
    }.getOrDefault(emptyMap())

    fun encode(values: Map<String, ShareRuntimeSelection>): String {
        require(values.size <= 128 && values.all { (id, selection) -> validId(id) && valid(selection) })
        return json.encodeToString(ShareRuntimePreferences(byTarget = values)).also { require(it.length <= 256_000) }
    }
}
