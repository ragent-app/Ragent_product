package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.network.ApiException

/** A provider management target is independent of the foreground chat target. */
data class ProviderInstance(val id: String, val label: String)

data class ProviderInstanceSnapshot(
    val instance: ProviderInstance,
    val loading: Boolean = true,
    /** True only after the provider configuration endpoint returned a valid response. */
    val available: Boolean = false,
    val snapshot: WebParitySnapshot = WebParitySnapshot(),
    val rotation: Pair<Boolean, List<String>>? = null,
    val failure: ProviderInstanceFailure? = null,
)

enum class ProviderInstanceFailureKind {
    Unauthorized,
    Forbidden,
    NotFound,
    Server,
    Http,
    Network,
    Unknown,
}

/** Safe diagnostic metadata; deliberately excludes server-provided text and request data. */
data class ProviderInstanceFailure(
    val kind: ProviderInstanceFailureKind,
    val httpStatusCode: Int? = null,
) {
    companion object {
        fun from(error: Exception): ProviderInstanceFailure {
            val apiError = error as? ApiException
                ?: return ProviderInstanceFailure(ProviderInstanceFailureKind.Unknown)
            val status = apiError.statusCode.takeIf { it in 100..599 }
            val code = apiError.code.orEmpty().uppercase()
            val kind = when {
                apiError.statusCode == 401 -> ProviderInstanceFailureKind.Unauthorized
                apiError.statusCode == 403 -> ProviderInstanceFailureKind.Forbidden
                apiError.statusCode == 404 -> ProviderInstanceFailureKind.NotFound
                apiError.statusCode >= 500 -> ProviderInstanceFailureKind.Server
                apiError.statusCode == 0 && ("NETWORK" in code || "TIMEOUT" in code || code == "CARRIER_UNAVAILABLE") ->
                    ProviderInstanceFailureKind.Network
                apiError.statusCode == 0 -> ProviderInstanceFailureKind.Unknown
                else -> ProviderInstanceFailureKind.Http
            }
            return ProviderInstanceFailure(kind, status)
        }
    }
}

val WebProvider.machineLocal: Boolean
    get() = agentType in setOf("codex", "claude", "agy") && authType in setOf("oauth", "oauth-token")

data class ProviderInstanceCopy(val instance: ProviderInstance, val provider: WebProvider)
data class AccountProviderGroup(val key: String, val copies: List<ProviderInstanceCopy>) {
    val provider: WebProvider get() = copies.first().provider
    // Equality is only asserted when the server supplied credential comparison metadata.
    // Matching names or local revision numbers do not establish synchronization.
    val configurationDiffers: Boolean get() = copies.map { it.provider.configurationMetadata() }.distinct().size > 1 ||
        copies.map { it.provider.credentialFingerprint }.filter(String::isNotBlank).distinct().size > 1
    val configurationMatches: Boolean get() = copies.all { it.provider.credentialFingerprint.isNotBlank() } &&
        copies.map { it.provider.configurationIdentity() }.distinct().size == 1
}

private fun WebProvider.configurationIdentity() = configurationMetadata() + credentialFingerprint

private fun WebProvider.configurationMetadata() = listOf(
    name, agentType, authType, baseUrl, protocol, enabled.toString(), defaultModel, modelPolicyIdentity, quotaPolicyIdentity,
)

fun accountProviderGroups(instances: List<ProviderInstanceSnapshot>, restrictedDemo: Boolean = false): List<AccountProviderGroup> =
    instances.filter { it.available }.flatMap { target ->
        target.snapshot.providers.filter { !restrictedDemo || (it.agentType == "codex" && it.authType == "oauth") }
            .map { ProviderInstanceCopy(target.instance, it) }
    }.groupBy { copy ->
        val provider = copy.provider
        // Legacy servers do not expose the sync key: keep their rows separate rather than
        // merging unrelated credentials that happen to have the same display name or id.
        if (provider.machineLocal || provider.syncId.isBlank()) "local:${copy.instance.id}:${provider.id}"
        else "shared:${provider.agentType}:${provider.syncId}"
    }.map { (key, copies) -> AccountProviderGroup(key, copies) }
