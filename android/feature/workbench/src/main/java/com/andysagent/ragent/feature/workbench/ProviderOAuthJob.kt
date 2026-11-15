package com.andysagent.ragent.feature.workbench

import java.net.URI
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** Short-lived display state only. Credentials stay in the connected computer's vault. */
data class ProviderOAuthJob(
    val id: String,
    val agentType: String,
    val state: String,
    val url: String?,
    val code: String,
    val requiresInput: Boolean,
    val providerId: String,
    val error: String,
) {
    val terminal: Boolean get() = state in setOf("completed", "failed", "cancelled")
    val canOpenBrowser: Boolean get() = !terminal && url != null && (agentType != "codex" || code.isNotBlank())
    override fun toString(): String = "ProviderOAuthJob(state=$state, contents=redacted)"
}

internal fun parseProviderOAuthJob(value: JsonObject): ProviderOAuthJob {
    fun text(key: String) = value[key]?.jsonPrimitive?.contentOrNull.orEmpty()
    val id = text("id")
    require(id.matches(Regex("[A-Za-z0-9._-]{1,128}"))) { "Invalid provider login job" }
    val state = text("state")
    require(state in setOf("pending", "awaiting-input", "authenticating", "finalizing", "completed", "failed", "cancelled")) {
        "Invalid provider login state"
    }
    val url = text("url").takeIf { raw ->
        runCatching { URI(raw).let { it.scheme == "https" && !it.host.isNullOrBlank() && it.rawUserInfo == null } }.getOrDefault(false)
    }
    val code = text("code").takeIf { it.length <= 64 && it.all { c -> c.isLetterOrDigit() || c == '-' } }.orEmpty()
    return ProviderOAuthJob(id, text("agentType"), state, url, if (state in setOf("completed", "failed", "cancelled")) "" else code,
        value["requiresInput"]?.jsonPrimitive?.booleanOrNull == true, text("providerId"), text("error").take(1200))
}
