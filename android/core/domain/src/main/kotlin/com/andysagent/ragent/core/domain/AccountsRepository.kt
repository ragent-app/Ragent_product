package com.andysagent.ragent.core.domain

import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.put

/** Result of submitting a native Google ID token to the instance. */
data class GoogleTokenSubmitResult(
    val bound: Boolean,
    val mode: String,
    val deviceState: String? = null,
    val deviceId: String? = null,
    val credentialToken: String? = null,
    val credentialExpiresAt: String? = null,
    val credentialScope: String? = null,
)

/** Server-owned Google account and trusted-device projection. */
data class GoogleAccountProfile(
    val displayName: String? = null,
    val email: String? = null,
    val photoUrl: String? = null,
)

/**
 * Non-secret evidence that the Android phone currently holds a usable Accounts
 * session. The `rac_` bearer itself never leaves the Keystore-backed auth
 * boundary; UI code may only render this projection.
 */
data class ActiveAccountSession(
    val accountId: String,
    val deviceId: String,
    val credentialId: String,
    val scope: String,
    val expiresAt: String,
    val demoAccessMode: String? = null,
)

/**
 * Result of checking the phone's real Accounts session. A cached Google
 * profile, a selected Android Google account, or a target-computer `rda_`
 * credential must never be substituted for this result.
 */
sealed interface AccountSessionVerification {
    data class Active(val session: ActiveAccountSession) : AccountSessionVerification
    data object ReauthorizationRequired : AccountSessionVerification
    data class Unavailable(val message: String? = null) : AccountSessionVerification
}

/**
 * UI-facing boundary for the Accounts-only phone session. Implementations
 * verify the Keystore `rac_` plus its metadata and renew it when necessary,
 * without exposing a bearer to feature/UI code.
 */
interface AccountSessionStateSource {
    suspend fun verify(): AccountSessionVerification

    suspend fun clear()
}

/**
 * The account selected on this phone. This is deliberately independent from a
 * computer's owner-account binding: selecting a Google account is useful even
 * before this phone has connected to any Ragent computer.
 *
 * Implementations may persist only this non-secret profile data. Google ID
 * tokens must never be stored here.
 */
interface GoogleAccountIdentityStore {
    val profile: Flow<GoogleAccountProfile?>

    suspend fun save(profile: GoogleAccountProfile)

    suspend fun clearSelectedAccount()
}

data class GoogleAccountStatusResult(
    val enabled: Boolean,
    val bound: Boolean,
    val mode: String,
    val contractVersion: Int = 1,
    val nativeGoogleAuthEnabled: Boolean = false,
    val accountJoinEnabled: Boolean = false,
    val deviceState: String? = null,
    val accountId: String? = null,
    val accountProfile: GoogleAccountProfile? = null,
    val deviceId: String? = null,
    val temporaryExpiresAt: String? = null,
)

data class AccountsMutationResult(
    val unbound: Boolean = false,
    val revoked: Boolean = false,
    val deviceId: String? = null,
)

/** Account-wide default permission posture, persisted and synced by each instance. */
data class AccountPermissionPolicy(
    val permissionPolicy: String = "",
    val updatedAt: String = "",
)

/** A same-account Ragent instance returned by the Accounts directory. */
data class DiscoveredComputer(
    val instanceId: String,
    val alias: String,
    val endpoint: String?,
    val boundAt: String? = null,
    val lastSeenAt: String? = null,
    val canTakeOver: Boolean = false,
    /** Account-authoritative concurrent computer connection budget. */
    val connectionPlan: String = "free",
    val maximumConcurrentConnections: Int = 1,
    val activeComputerConnections: Int = 0,
    val instancePublicKey: String? = null,
    val instanceKeyFingerprint: String? = null,
    val unlimitedConnections: Boolean = false,
) {
    /** The target's server control-plane endpoint. */
    val connectionEndpoint: String?
        get() = endpoint?.takeIf { it.isNotBlank() }
}

/**
 * A device row from the Accounts directory. This is account-owned metadata,
 * not a locally cached pairing target, so callers must not synthesize rows
 * from DataStore when an account session is active.
 */
data class AccountDirectoryDevice(
    val deviceId: String,
    val instanceId: String,
    val alias: String,
    val deviceKind: String,
    val endpoint: String? = null,
    val boundAt: String? = null,
    val unboundAt: String? = null,
    val lastSeenAt: String? = null,
    val instancePublicKey: String? = null,
    val instanceKeyFingerprint: String? = null,
)

class AccountsRepositoryException(
    val statusCode: Int,
    val code: String?,
    override val message: String,
    val retryable: Boolean,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

/**
 * Accounts I/O boundary. The server status projection is authoritative: callers
 * must refresh it before presenting a successful bind, unbind, or revoke result.
 *
 * The two-argument token method remains the compatibility entry point for previews
 * and older fakes. Production callers use the idempotent overload.
 */
interface AccountsRepository {
    suspend fun getGoogleAccountStatus(): GoogleAccountStatusResult

    suspend fun submitGoogleIdToken(idToken: String, alias: String? = null): GoogleTokenSubmitResult

    suspend fun submitGoogleIdToken(
        idToken: String,
        alias: String? = null,
        idempotencyKey: String,
    ): GoogleTokenSubmitResult = submitGoogleIdToken(idToken, alias)

    /** Owner-only server unbind. A local state change is never a substitute. */
    suspend fun unbindGoogleAccount(idempotencyKey: String): AccountsMutationResult =
        throw AccountsRepositoryException(501, "accounts_unbind_unsupported", "Account unbind is unavailable.", retryable = false)

    /** Owner-only trusted-device revoke. A local state change is never a substitute. */
    suspend fun revokeTrustedDevice(deviceId: String, idempotencyKey: String): AccountsMutationResult =
        throw AccountsRepositoryException(501, "device_revoke_unsupported", "Device revoke is unavailable.", retryable = false)

    /**
     * Discover same-account instances with the Accounts-only bearer already
     * attached by the directory transport. Google ID tokens are never accepted
     * on this path.
     */
    suspend fun discoverComputers(requestId: String): List<DiscoveredComputer> =
        throw AccountsRepositoryException(501, "account_discovery_unsupported", "Account discovery is unavailable.", retryable = false)

    /**
     * Returns the signed-in account's authoritative device directory. The
     * attached `rac_` bearer determines the account; callers cannot supply an
     * account id or turn a local cached device into an account device.
     */
    suspend fun listAccountDevices(): List<AccountDirectoryDevice> =
        throw AccountsRepositoryException(501, "account_device_directory_unsupported", "Account device directory is unavailable.", retryable = false)

    /** Owner-only account policy projection from the currently connected instance. */
    suspend fun getAccountPermissionPolicy(): AccountPermissionPolicy =
        throw AccountsRepositoryException(501, "account_policy_unsupported", "Account permission policy is unavailable.", retryable = false)

    /** Owner-only idempotent account policy update. */
    suspend fun setAccountPermissionPolicy(
        permissionPolicy: String,
        idempotencyKey: String,
    ): AccountPermissionPolicy =
        throw AccountsRepositoryException(501, "account_policy_unsupported", "Account permission policy is unavailable.", retryable = false)
}

class DefaultAccountsRepository(
    private val transport: RagentTransport,
    private val credentialWriter: ((String, String?, String?) -> Unit)? = null,
    private val discoveryTransport: RagentTransport? = null,
) : AccountsRepository {
    override suspend fun getGoogleAccountStatus(): GoogleAccountStatusResult {
        val body = execute(ApiRequest("GET", "/api/auth/google/status"))
        return body.toStatusResult()
    }

    override suspend fun submitGoogleIdToken(idToken: String, alias: String?): GoogleTokenSubmitResult =
        submitGoogleIdToken(idToken, alias, UUID.randomUUID().toString())

    override suspend fun submitGoogleIdToken(
        idToken: String,
        alias: String?,
        idempotencyKey: String,
    ): GoogleTokenSubmitResult {
        require(idToken.isNotBlank()) { "Google ID token must not be blank" }
        require(idempotencyKey.isNotBlank()) { "Idempotency key must not be blank" }
        val payload = buildJsonObject {
            put("idToken", JsonPrimitive(idToken))
            put("idempotencyKey", JsonPrimitive(idempotencyKey))
            alias?.trim()?.takeIf { it.isNotEmpty() }?.let { put("alias", JsonPrimitive(it)) }
        }.toString()
        val body = execute(ApiRequest(
            method = "POST",
            path = "/api/auth/google/token",
            body = payload,
            requestId = idempotencyKey,
            idempotencyKey = idempotencyKey,
        ))
        val ok = body["ok"]?.jsonPrimitive?.booleanOrNull ?: true
        if (!ok) {
            throw AccountsRepositoryException(200, "owner_auth_token_invalid", "Google sign-in was not completed.", retryable = false)
        }
        val credential = body["credential"]?.jsonObject
        val credentialToken = credential?.get("token")?.jsonPrimitive?.contentOrNull
        val credentialExpiresAt = credential?.get("expiresAt")?.jsonPrimitive?.contentOrNull
        val credentialScope = credential?.get("scope")?.jsonPrimitive?.contentOrNull
        if (!credentialToken.isNullOrBlank()) {
            credentialWriter?.invoke(credentialToken, credentialExpiresAt, credentialScope)
        }
        return GoogleTokenSubmitResult(
            bound = body["bound"]?.jsonPrimitive?.booleanOrNull ?: false,
            mode = body["mode"]?.jsonPrimitive?.contentOrNull ?: "",
            deviceState = body["deviceState"]?.jsonPrimitive?.contentOrNull,
            deviceId = body["deviceId"]?.jsonPrimitive?.contentOrNull,
            credentialToken = credentialToken,
            credentialExpiresAt = credentialExpiresAt,
            credentialScope = credentialScope,
        )
    }

    override suspend fun unbindGoogleAccount(idempotencyKey: String): AccountsMutationResult {
        require(idempotencyKey.isNotBlank()) { "Idempotency key must not be blank" }
        val body = execute(ApiRequest(
            method = "POST",
            path = "/api/auth/google/unbind",
            requestId = idempotencyKey,
            idempotencyKey = idempotencyKey,
        ))
        return AccountsMutationResult(
            unbound = body["unbound"]?.jsonPrimitive?.booleanOrNull ?: false,
            deviceId = body["deviceId"]?.jsonPrimitive?.contentOrNull,
        )
    }

    override suspend fun revokeTrustedDevice(deviceId: String, idempotencyKey: String): AccountsMutationResult {
        require(deviceId.isNotBlank()) { "Device id must not be blank" }
        require(idempotencyKey.isNotBlank()) { "Idempotency key must not be blank" }
        val body = execute(ApiRequest(
            method = "POST",
            path = "/api/device-pairing/devices/${encodePath(deviceId)}/revoke",
            requestId = idempotencyKey,
            idempotencyKey = idempotencyKey,
        ))
        val device = body["device"]?.jsonObject
        return AccountsMutationResult(
            revoked = !device?.get("revokedAt")?.jsonPrimitive?.contentOrNull.isNullOrBlank(),
            deviceId = device?.get("id")?.jsonPrimitive?.contentOrNull ?: deviceId,
        )
    }

    override suspend fun discoverComputers(requestId: String): List<DiscoveredComputer> {
        require(requestId.isNotBlank()) { "Discovery request id must not be blank" }
        val discoveryBody = buildJsonObject {
            put("requestId", JsonPrimitive(requestId))
        }.toString()
        val body = executeWith(
            discoveryTransport ?: throw AccountsRepositoryException(
                501,
                "account_discovery_unsupported",
                "Account discovery is unavailable.",
                retryable = false,
            ),
            ApiRequest(
                method = "POST",
                path = "/v1/owner-auth/discovery",
                body = discoveryBody,
                requestId = requestId,
                idempotencyKey = requestId,
            ),
        )
        return body["instances"]?.jsonArray.orEmpty().mapNotNull { element ->
            val item = element.jsonObject
            val instanceId = item["instanceId"]?.jsonPrimitive?.contentOrNull.orEmpty()
            if (instanceId.isBlank()) return@mapNotNull null
            DiscoveredComputer(
                instanceId = instanceId,
                alias = item["alias"]?.jsonPrimitive?.contentOrNull.orEmpty().ifBlank { "Ragent computer" },
                endpoint = item["endpoint"]?.jsonPrimitive?.contentOrNull,
                boundAt = item["boundAt"]?.jsonPrimitive?.contentOrNull,
                lastSeenAt = item["lastSeenAt"]?.jsonPrimitive?.contentOrNull,
                canTakeOver = item["canTakeOver"]?.jsonPrimitive?.booleanOrNull ?: false,
                instancePublicKey = item["instancePublicKey"]?.jsonPrimitive?.contentOrNull,
                instanceKeyFingerprint = item["instanceKeyFingerprint"]?.jsonPrimitive?.contentOrNull,
                connectionPlan = body["quota"]?.jsonObject?.get("plan")?.jsonPrimitive?.contentOrNull ?: "free",
                unlimitedConnections = body["quota"]?.jsonObject?.get("limits")?.jsonObject
                    ?.get("unlimited")?.jsonPrimitive?.booleanOrNull == true,
                maximumConcurrentConnections = body["quota"]?.jsonObject?.get("limits")?.jsonObject
                    ?.get("computers")?.jsonPrimitive?.intOrNull ?: 1,
                activeComputerConnections = body["quota"]?.jsonObject?.get("activeComputers")
                    ?.jsonPrimitive?.intOrNull ?: 0,
            )
        }.filter { it.canTakeOver }
    }

    override suspend fun listAccountDevices(): List<AccountDirectoryDevice> {
        val body = executeWith(
            discoveryTransport ?: throw AccountsRepositoryException(
                501,
                "account_device_directory_unsupported",
                "Account device directory is unavailable.",
                retryable = false,
            ),
            ApiRequest(
                method = "GET",
                path = "/v1/owner-auth/account/devices",
            ),
        )
        return body["devices"]?.jsonArray.orEmpty().mapNotNull { element ->
            val item = element.jsonObject
            val deviceId = item["deviceId"]?.jsonPrimitive?.contentOrNull.orEmpty()
            val instanceId = item["instanceId"]?.jsonPrimitive?.contentOrNull.orEmpty()
            if (deviceId.isBlank() || instanceId.isBlank()) return@mapNotNull null
            AccountDirectoryDevice(
                deviceId = deviceId,
                instanceId = instanceId,
                alias = item["alias"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                deviceKind = item["deviceKind"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                endpoint = item["endpoint"]?.jsonPrimitive?.contentOrNull,
                boundAt = item["boundAt"]?.jsonPrimitive?.contentOrNull,
                unboundAt = item["unboundAt"]?.jsonPrimitive?.contentOrNull,
                lastSeenAt = item["lastSeenAt"]?.jsonPrimitive?.contentOrNull,
                instancePublicKey = item["instancePublicKey"]?.jsonPrimitive?.contentOrNull,
                instanceKeyFingerprint = item["instanceKeyFingerprint"]?.jsonPrimitive?.contentOrNull,
            )
        }
    }

    override suspend fun getAccountPermissionPolicy(): AccountPermissionPolicy {
        val body = execute(ApiRequest("GET", "/api/account-policy"))
        return body["policy"]?.jsonObject?.toAccountPermissionPolicy()
            ?: throw AccountsRepositoryException(200, "account_policy_response_invalid", "Account policy response was invalid.", retryable = false)
    }

    override suspend fun setAccountPermissionPolicy(
        permissionPolicy: String,
        idempotencyKey: String,
    ): AccountPermissionPolicy {
        require(permissionPolicy in setOf("", "full-auto", "approval", "conservative-auto")) {
            "Account permission policy must be full-auto, approval, conservative-auto, or empty."
        }
        require(idempotencyKey.isNotBlank()) { "Idempotency key must not be blank" }
        val body = execute(ApiRequest(
            method = "PATCH",
            path = "/api/account-policy",
            body = buildJsonObject { put("permissionPolicy", JsonPrimitive(permissionPolicy)) }.toString(),
            requestId = idempotencyKey,
            idempotencyKey = idempotencyKey,
        ))
        return body["policy"]?.jsonObject?.toAccountPermissionPolicy()
            ?: throw AccountsRepositoryException(200, "account_policy_response_invalid", "Account policy response was invalid.", retryable = false)
    }

    private suspend fun execute(request: ApiRequest): kotlinx.serialization.json.JsonObject = executeWith(transport, request)

    private suspend fun executeWith(
        target: RagentTransport,
        request: ApiRequest,
    ): kotlinx.serialization.json.JsonObject = try {
        Json.parseToJsonElement(target.execute(request).body).jsonObject
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: ApiException) {
        throw AccountsRepositoryException(error.statusCode, error.code, error.message, error.retryable, error)
    } catch (error: AccountsRepositoryException) {
        throw error
    } catch (error: Throwable) {
        throw AccountsRepositoryException(0, "accounts_response_invalid", "Accounts response was invalid.", retryable = false, cause = error)
    }

    private fun kotlinx.serialization.json.JsonObject.toStatusResult(): GoogleAccountStatusResult = GoogleAccountStatusResult(
        enabled = this["enabled"]?.jsonPrimitive?.booleanOrNull ?: false,
        bound = this["bound"]?.jsonPrimitive?.booleanOrNull ?: false,
        mode = this["mode"]?.jsonPrimitive?.contentOrNull ?: "",
        contractVersion = this["contractVersion"]?.jsonPrimitive?.intOrNull ?: 1,
        nativeGoogleAuthEnabled = this["capabilities"]?.jsonObject?.get("nativeGoogleAuth")?.jsonPrimitive?.booleanOrNull ?: false,
        accountJoinEnabled = this["capabilities"]?.jsonObject?.get("accountJoin")?.jsonPrimitive?.booleanOrNull ?: false,
        deviceState = this["deviceState"]?.jsonPrimitive?.contentOrNull,
        accountId = this["accountId"]?.jsonPrimitive?.contentOrNull,
        accountProfile = this["accountProfile"]?.jsonObject?.let { profile ->
            GoogleAccountProfile(
                displayName = profile["displayName"]?.jsonPrimitive?.contentOrNull,
                email = profile["email"]?.jsonPrimitive?.contentOrNull,
                photoUrl = profile["photoUrl"]?.jsonPrimitive?.contentOrNull,
            )
        },
        deviceId = this["deviceId"]?.jsonPrimitive?.contentOrNull,
        temporaryExpiresAt = this["temporaryExpiresAt"]?.jsonPrimitive?.contentOrNull,
    )

    private fun kotlinx.serialization.json.JsonObject.toAccountPermissionPolicy(): AccountPermissionPolicy = AccountPermissionPolicy(
        permissionPolicy = this["permissionPolicy"]?.jsonPrimitive?.contentOrNull
            ?.trim()?.lowercase()?.takeIf { it == "full-auto" || it == "approval" || it == "conservative-auto" } ?: "",
        updatedAt = this["updatedAt"]?.jsonPrimitive?.contentOrNull.orEmpty(),
    )

    private fun encodePath(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}
