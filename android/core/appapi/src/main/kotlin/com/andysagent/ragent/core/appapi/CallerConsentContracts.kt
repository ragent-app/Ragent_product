package com.andysagent.ragent.core.appapi

import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString

/** Untrusted requested scope. It is never an identity or evidence of consent. */
@Serializable
data class CallerConsentRequest(
    val capabilityIds: Set<String>,
    val targetIds: Set<String> = emptySet(),
    val sessionIds: Set<String>? = null,
    val projectIds: Set<String>? = null,
    val mayCreateSessions: Boolean = false,
    val lifetimeMs: Long = 24L * 60 * 60 * 1000,
    val version: Int = 1,
) {
    fun validate(registry: CapabilityRegistry = CapabilityRegistry()) {
        require(version == 1 && lifetimeMs in 1..CALLER_GRANT_MAX_LIFETIME_MS)
        fun ids(values: Set<String>?, maximum: Int) = values == null ||
            (values.size <= maximum && values.all { it.isNotBlank() && it.length <= 256 && it.none(Char::isISOControl) })
        require(capabilityIds.isNotEmpty() && ids(capabilityIds, 32))
        require(ids(targetIds, 16))
        require(ids(sessionIds, 32) && ids(projectIds, 32))
        capabilityIds.forEach(registry::requireImplemented)
    }

    fun narrow(identity: InstalledCallerIdentity, capabilities: Set<String>, targets: Set<String>,
        createSessions: Boolean, durationMs: Long, now: Long): CallerGrant {
        validate(); identity.validate()
        require(capabilities.isNotEmpty() && capabilityIds.containsAll(capabilities))
        require(targets.isNotEmpty() && targets.size <= 16 && (targetIds.isEmpty() || targetIds.containsAll(targets)))
        require(!createSessions || mayCreateSessions)
        require(durationMs in 1..lifetimeMs && now >= 0 && now <= Long.MAX_VALUE - durationMs)
        return CallerGrant(identity.binding, capabilities.toSet(), targets.toSet(), now + durationMs,
            sessionIds?.toSet(), projectIds?.toSet(), createSessions)
    }
}

/** Bounded public Activity Result; IDs are references, never bearer authorization. */
@Serializable
data class CallerConsentReceipt(val grantId: String, val capabilityIds: Set<String>, val targetIds: Set<String>,
    val expiresAt: Long, val sessionIds: Set<String>?, val projectIds: Set<String>?, val mayCreateSessions: Boolean,
    val version: Int = 1)

object CallerConsentContract {
    const val ACTION = "com.agentoncloud.android.action.REQUEST_API_ACCESS"
    const val REQUEST = "ragent.api.consent.request.v1"
    const val RECEIPT = "ragent.api.consent.receipt.v1"
    const val ERROR = "ragent.api.consent.error.v1"
    const val MAX_REQUEST_BYTES = 24 * 1024
    fun decode(value: String): CallerConsentRequest {
        require(value.toByteArray(Charsets.UTF_8).size <= MAX_REQUEST_BYTES)
        return AppApiJson.decodeFromString<CallerConsentRequest>(value).also { it.validate() }
    }
}
