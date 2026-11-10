package com.andysagent.agentoc.core.auth

import com.andysagent.agentoc.core.datastore.AccountSessionMetadata
import com.andysagent.agentoc.core.datastore.ClientConfigStore
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.protocol.AccountJoinAuthorizationRequest
import com.andysagent.agentoc.core.protocol.AccountJoinAuthorizationResponse
import com.andysagent.agentoc.core.protocol.AccountAsrTranscriptionDto
import com.andysagent.agentoc.core.protocol.AccountAsrUsageDto
import com.andysagent.agentoc.core.protocol.AccountSessionCredentialDto
import com.andysagent.agentoc.core.protocol.CompleteAccountSessionRequest
import com.andysagent.agentoc.core.protocol.CompleteAccountSessionResponse
import com.andysagent.agentoc.core.protocol.CreateAccountSessionChallengeRequest
import com.andysagent.agentoc.core.protocol.CreateAccountSessionChallengeResponse
import com.andysagent.agentoc.core.protocol.AccountJoinIntentDto
import com.andysagent.agentoc.core.protocol.AccountSessionDeviceDto
import com.andysagent.agentoc.core.protocol.CreateAccountRendezvousRequest
import com.andysagent.agentoc.core.protocol.CreateAccountRendezvousResponse
import com.andysagent.agentoc.core.protocol.AccountRendezvousTargetInstanceDto
import com.andysagent.agentoc.core.protocol.buildAccountJoinIntentMessage
import com.andysagent.agentoc.core.protocol.buildAccountSessionCompleteMessage
import com.andysagent.agentoc.core.protocol.buildAccountSessionRefreshMessage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.delay
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.security.SecureRandom
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import com.andysagent.agentoc.core.protocol.PairingUriDto
import com.andysagent.agentoc.core.protocol.AccountPairingResponse
import com.andysagent.agentoc.core.protocol.buildAccountPairingProof

private const val ACCOUNT_DIRECTORY_SCOPE = "account-directory"
private const val MIN_ACCOUNT_CREDENTIAL_VALIDITY_MS = 120_000L
private const val RENDEZVOUS_POLL_DELAY_MS = 5_000L
private const val RENDEZVOUS_POLL_TIMEOUT_MS = 120_000L
private const val RENDEZVOUS_POLL_MAX_ATTEMPTS = 24
private const val RENDEZVOUS_RESULT_WAIT_MS = 10_000L
private const val RENDEZVOUS_RATE_LIMIT_DEFAULT_MS = 5_000L
private const val RENDEZVOUS_RATE_LIMIT_RETRY_MIN_MS = 1_000L
private const val RENDEZVOUS_SETUP_RATE_LIMIT_RETRIES = 2
private val ACCOUNT_DEVICE_ID_PATTERN = Regex("^adev_[A-Za-z0-9_-]{4,156}$")
private val TARGET_DEVICE_ID_PATTERN = Regex("^rdev_[A-Za-z0-9_-]+$")
private val ACCOUNT_COMPUTER_ID_PATTERN = Regex("^inst_[A-Za-z0-9_-]{4,156}$")

@Serializable
data class AccountSessionChallenge(
    val transactionId: String,
    val requestId: String,
    val deviceId: String,
    val publicKeyFingerprint: String,
    val nonce: String,
    val expiresAt: String,
    /** One-time ticket for the browser sign-in page (non-GMS handoff). */
    val browserTicket: String = "",
    val completionRecoveryWindowMs: Long = 0,
)

data class AccountSessionCredential(
    val accountId: String,
    val deviceId: String,
    val credentialId: String,
    val token: String,
    val scope: String,
    val expiresAt: String,
    val demoAccessMode: String? = null,
)

/** Result of establishing an account session, including browser-handoff identity. */
data class AccountSessionEstablishment(
    val credential: AccountSessionCredential,
    val accountId: String,
    val email: String?,
)

data class AccountJoinAuthorizationProof(
    val requestId: String,
    val nonce: String,
    val issuedAt: String,
    val deviceSignature: String,
)

data class AccountJoinGrant(
    val accountJoinGrant: String,
    val expiresAt: String,
    val intentId: String,
    val instanceId: String,
    val deviceId: String,
    val rendezvousGrantSubmitted: Boolean = false,
)

/** Isolated boundary used by the target-pairing code; it never exposes `rac_`. */
interface AccountJoinGrantAuthorizer {
    suspend fun authorizeAccountJoin(
        intent: AccountJoinIntentDto,
        proof: AccountJoinAuthorizationProof,
    ): AccountJoinGrant

    /** A caller already proving an existing enrollment does not create a new device. */
    suspend fun authorizeExistingEnrollment(intent: AccountJoinIntentDto, proof: AccountJoinAuthorizationProof): AccountJoinGrant =
        authorizeAccountJoin(intent, proof)
}

data class AccountRendezvousHandoff(
    val requestId: String,
    val intent: AccountJoinIntentDto,
    val result: kotlinx.serialization.json.JsonObject,
)

/** Accounts-only rendezvous boundary. The target computer never sees this object. */
interface AccountRendezvousAuthorizer {
    suspend fun rendezvous(
        targetInstanceId: String,
        deviceName: String,
        accountClaimToken: String? = null,
        targetInstance: AccountRendezvousTargetInstanceDto? = null,
        computerAlias: String = "",
    ): AccountRendezvousHandoff
}

/** Minimal persistence boundary so protocol behavior has JVM unit coverage. */
interface AccountSessionMetadataStore {
    val accountSession: Flow<AccountSessionMetadata?>
    suspend fun getOrCreateAccountDeviceId(): String
    suspend fun saveAccountSession(value: AccountSessionMetadata)
    suspend fun clearAccountSession()
}

class ClientConfigAccountSessionStore(
    private val configStore: ClientConfigStore,
) : AccountSessionMetadataStore {
    override val accountSession: Flow<AccountSessionMetadata?> = configStore.accountSession
    override suspend fun getOrCreateAccountDeviceId(): String = configStore.getOrCreateAccountDeviceId()
    override suspend fun saveAccountSession(value: AccountSessionMetadata) = configStore.saveAccountSession(value)
    override suspend fun clearAccountSession() = configStore.clearAccountSession()
}

class AccountSessionException(
    val statusCode: Int,
    val code: String,
    override val message: String,
    val retryable: Boolean = false,
    val retryAfterMs: Long? = null,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

private fun isRendezvousRateLimit(error: AccountSessionException): Boolean =
    error.statusCode == 429 && error.code !in setOf("turn_connection_quota_exceeded", "turn_quota_exceeded")

/**
 * Owns the Android half of the Accounts v2 session protocol.
 *
 * [anonymousTransport] is used for challenge, complete, and signed refresh.
 * [authenticatedTransport] is the only transport that can attach the `rac_`
 * bearer, and is used only after [ensureActiveCredential] for Accounts
 * directory and account-join-grant calls. Target-computer transports never
 * receive the credential.
 */
class AccountSessionManager(
    private val anonymousTransport: AgentoCTransport,
    private val authenticatedTransport: AgentoCTransport,
    private val identity: DeviceIdentityStore,
    private val credentialStore: AccountCredentialStore,
    private val metadataStore: AccountSessionMetadataStore,
    private val clock: () -> Instant = { Instant.now() },
    private val randomNonce: () -> String = ::createNonce,
    private val pollDelay: suspend (Long) -> Unit = { delay(it) },
    private val pairingJournal: AccountPairingJournal = MemoryAccountPairingJournal(),
    private val monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000L },
    private val beforeRendezvousGrant: suspend () -> Unit = {},
    private val beforeDemoSignIn: suspend () -> Unit = {},
    private val afterDemoLogout: suspend () -> Unit = {},
    private val changeAccountDirectory: suspend (AccountDirectoryChange, suspend () -> Unit) -> Unit = { _, update -> update() },
    private val dispatchSessionInvalidation: ((suspend () -> Unit) -> Unit)? = null,
    private val rendezvousTrace: (String, String) -> Unit = { _, _ -> },
) : AccountJoinGrantAuthorizer, AccountRendezvousAuthorizer, AccountTurnLeaseClient {
    private val json = Json { ignoreUnknownKeys = true }
    private val refreshMutex = Mutex()
    private val accountDirectoryMutex = Mutex()
    private val invalidationLock = Any()
    private val rejectedAuthorities = mutableSetOf<String>()
    private val pairingMutex = Mutex()
    private var demoPresentationCheck: Pair<String, Long>? = null
    private fun traceRendezvous(target: String, event: String) {
        runCatching { rendezvousTrace(target, event) }
    }

    /** The QR authorizes this phone's key automatically; only Accounts receives or issues rac_. */
    suspend fun acceptDesktopAccount(invitation: PairingUriDto, alias: String): AccountSessionEstablishment = pairingMutex.withLock {
        require(invitation.version == 4 && invitation.accountInvitationId != null)
        val invitationId = requireNotNull(invitation.accountInvitationId)
        validateFutureExpiry(invitation.expiresAt, "Account pairing code")
        if (metadataStore.accountSession.first() != null) throw AccountSessionException(409,
            "account_pairing_already_signed_in", "This phone already has account authorization.")
        val expectedDeviceId = if (invitation.accountType == "demo") demoAccountDeviceId() else metadataStore.getOrCreateAccountDeviceId()
        val pending = pairingJournal.read()?.takeIf { it.instanceId == invitation.instanceId && it.invitationId == invitation.accountInvitationId }
        val challenge = pending?.challenge ?: createSessionChallenge(alias, "android", expectedDeviceId).also {
            pairingJournal.write(PendingAccountPairing(invitation.instanceId, invitationId, it))
        }
        validateFutureExpiry(challenge.expiresAt, "Account pairing challenge")
        if (challenge.deviceId != expectedDeviceId ||
            challenge.publicKeyFingerprint != devicePublicKeyFingerprint(identity.publicKeyEncoded())) {
            pairingJournal.clear()
            throw AccountSessionException(401, "account_pairing_identity_changed", "Phone identity changed. Create another code.")
        }
        val claim = buildJsonObject {
            put("token", invitation.token); put("transactionId", challenge.transactionId); put("requestId", challenge.requestId)
            put("deviceSignature", identity.sign(buildAccountSessionCompleteMessage(challenge.transactionId,
                challenge.requestId, challenge.deviceId, challenge.publicKeyFingerprint, challenge.nonce)))
        }
        var needsClaim = pending == null
        repeat(61) {
            validateFutureExpiry(invitation.expiresAt, "Account pairing code")
            try {
                if (needsClaim) { accountPairingRequest("claim", invitation, claim); needsClaim = false }
                val result = accountPairingRequest("result", invitation, buildJsonObject {})
                result.session?.let { session ->
                    requireV2(session.contractVersion)
                    if (result.status != "APPROVED" || session.deviceId != challenge.deviceId) throw AccountSessionException(401,
                        "account_session_device_mismatch", "Accounts returned a different phone device id.")
                    if (session.accountId.startsWith("acct_demo_") != (invitation.accountType == "demo")) throw AccountSessionException(401,
                        "account_pairing_account_type_mismatch", "Scan a fresh account-link code with an updated app.")
                    val credential = persistCredential(session.accountId, session.deviceId, session.credential, session.demoAccessMode)
                    pairingJournal.clear()
                    return@withLock AccountSessionEstablishment(credential, session.accountId, session.email?.takeIf(String::isNotBlank))
                }
            } catch (error: AccountSessionException) {
                if (error.code == "account_pairing_not_claimed") needsClaim = true
                else if (!error.retryable && error.statusCode != 429) throw error
            }
            pollDelay(2_000)
        }
        throw AccountSessionException(408, "account_pairing_confirmation_timeout", "Account sign-in timed out. Keep both devices online and scan a fresh code.", retryable = true)
    }

    private suspend fun accountPairingRequest(action: String, invitation: PairingUriDto, payload: JsonObject): AccountPairingResponse {
        val id = requireNotNull(invitation.accountInvitationId)
        val issuedAt = clock().toEpochMilli()
        val nonce = createNonce()
        val body = buildJsonObject {
            put("instanceId", invitation.instanceId); put("invitationId", id); put("issuedAt", issuedAt)
            put("nonce", nonce); put("payload", payload)
            put("signature", identity.sign(buildAccountPairingProof(action, invitation.instanceId, id, issuedAt, nonce, payload)))
        }
        val result = decode<AccountPairingResponse>(executeAnonymous(ApiRequest(method = "POST",
            path = "/v1/account-pairing/$action", body = body.toString())))
        if (result.instanceId != invitation.instanceId || result.invitationId != id ||
            result.expiresAt != Instant.parse(invitation.expiresAt).toEpochMilli() ||
            result.status !in setOf("PENDING", "CLAIMED", "APPROVED")) throw AccountSessionException(401,
                "account_pairing_response_invalid", "Accounts returned a different pairing exchange.")
        return result
    }

    suspend fun createGoogleChallenge(
        alias: String,
        platform: String = "android",
    ): AccountSessionChallenge = createSessionChallenge(alias, platform, metadataStore.getOrCreateAccountDeviceId())

    private suspend fun createSessionChallenge(
        alias: String,
        platform: String,
        deviceId: String,
    ): AccountSessionChallenge {
        val requestId = UUID.randomUUID().toString()
        val publicKey = identity.publicKeyEncoded()
        val fingerprint = devicePublicKeyFingerprint(publicKey)
        validateCanonicalField("requestId", requestId)
        validateAccountDeviceId(deviceId)
        val response = executeAnonymous(
            ApiRequest(
                method = "POST",
                path = "/v1/owner-auth/native/session/challenge",
                body = json.encodeToString(
                    CreateAccountSessionChallengeRequest(
                        requestId = requestId,
                        device = AccountSessionDeviceDto(
                            deviceId = deviceId,
                            publicKey = publicKey,
                            alias = alias.replace(Regex("[\\r\\n]+"), " ").trim().ifBlank { "Android device" },
                            platform = platform.trim().ifBlank { "android" },
                        ),
                    ),
                ),
                requestId = requestId,
                idempotencyKey = requestId,
            ),
        ).let { body ->
            decode<CreateAccountSessionChallengeResponse>(body)
        }
        requireV2(response.contractVersion)
        validateCanonicalField("transactionId", response.transactionId)
        validateCanonicalField("nonce", response.nonce)
        validateFutureExpiry(response.expiresAt, "Account session challenge")
        return AccountSessionChallenge(
            transactionId = response.transactionId,
            requestId = requestId,
            deviceId = deviceId,
            publicKeyFingerprint = fingerprint,
            nonce = response.nonce,
            expiresAt = response.expiresAt,
            browserTicket = response.browserTicket.orEmpty(),
            completionRecoveryWindowMs = response.completionRecoveryWindowMs.coerceIn(0L, 120_000L),
        )
    }

    /** Exchanges a nonce-bound Google ID token exactly once for an Accounts-only credential. */
    suspend fun completeGoogleChallenge(
        challenge: AccountSessionChallenge,
        idToken: String,
    ): AccountSessionCredential = completeAccountSession(challenge, idToken).credential

    /**
     * Completes a challenge whose Google identity was already verified in the
     * browser (the non-GMS handoff). The device signature alone authorizes
     * this call; Accounts matches it against the browser-verified nonce.
     */
    suspend fun completeBrowserVerifiedChallenge(challenge: AccountSessionChallenge): AccountSessionEstablishment =
        completeAccountSession(challenge, idToken = "")

    /** Server-authenticated demo identity; same device proof, RAC storage and expiry as Google. */
    suspend fun signInDemoAccount(username: String, password: String, alias: String): AccountSessionEstablishment =
        pairingMutex.withLock {
            beforeDemoSignIn()
            if (metadataStore.accountSession.first() != null) {
                throw AccountSessionException(409, "account_session_already_signed_in", "Sign out before using a demo account.")
            }
            if (!Regex("^[a-z0-9._-]{3,80}$").matches(username) || password.length !in 16..256) {
                throw AccountSessionException(400, "account_session_demo_input_invalid", "Check the demo account credentials.")
            }
            val demoId = demoAccountDeviceId()
            completeAccountSession(createSessionChallenge(alias, "android", demoId), idToken = "", demoUsername = username, demoPassword = password)
        }

    private suspend fun demoAccountDeviceId(): String = "adev_demo_" + java.security.MessageDigest.getInstance("SHA-256")
        .digest(metadataStore.getOrCreateAccountDeviceId().toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }.take(48)

    private suspend fun completeAccountSession(
        challenge: AccountSessionChallenge,
        idToken: String,
        demoUsername: String? = null,
        demoPassword: String? = null,
    ): AccountSessionEstablishment {
        validateCanonicalField("transactionId", challenge.transactionId)
        validateCanonicalField("requestId", challenge.requestId)
        validateAccountDeviceId(challenge.deviceId)
        validateCanonicalField("publicKeyFingerprint", challenge.publicKeyFingerprint)
        validateCanonicalField("nonce", challenge.nonce)
        validateFutureExpiry(challenge.expiresAt, "Account session challenge")
        val signature = identity.sign(
            buildAccountSessionCompleteMessage(
                transactionId = challenge.transactionId,
                requestId = challenge.requestId,
                deviceId = challenge.deviceId,
                publicKeyFingerprint = challenge.publicKeyFingerprint,
                nonce = challenge.nonce,
            ),
        )
        val response = executeAccountSessionCompletion(
            ApiRequest(
                method = "POST",
                path = if (demoUsername == null) "/v1/owner-auth/native/session/complete" else "/v1/owner-auth/native/session/demo",
                body = if (demoUsername != null) buildJsonObject {
                    put("transactionId", challenge.transactionId)
                    put("requestId", challenge.requestId)
                    put("signature", signature)
                    put("username", demoUsername)
                    put("password", requireNotNull(demoPassword))
                }.toString() else json.encodeToString(
                    CompleteAccountSessionRequest(
                        transactionId = challenge.transactionId,
                        requestId = challenge.requestId,
                        idToken = idToken,
                        signature = signature,
                    ),
                ),
                requestId = challenge.requestId,
                idempotencyKey = challenge.requestId,
            ),
            challenge,
        ).let { body -> decode<CompleteAccountSessionResponse>(body) }
        requireV2(response.contractVersion)
        if (response.deviceId != challenge.deviceId) {
            throw AccountSessionException(401, "account_session_device_mismatch", "Accounts returned a different phone device id.")
        }
        if (demoUsername != null && !Regex("^acct_demo_[a-f0-9]{48}$").matches(response.accountId)) {
            throw AccountSessionException(401, "account_session_demo_identity_invalid", "Accounts returned an invalid demo identity.")
        }
        val credential = persistCredential(
            accountId = response.accountId,
            deviceId = response.deviceId,
            credential = response.credential,
            demoAccessMode = response.demoAccessMode,
        )
        return AccountSessionEstablishment(
            credential = credential,
            accountId = response.accountId,
            email = response.email?.takeIf { it.isNotBlank() },
        )
    }

    /**
     * Returns a usable `rac_`, refreshing by Keystore proof when its remaining
     * lifetime is short. It never falls back to Google; callers must explicitly
     * initiate [createGoogleChallenge] after a reauthorization error.
     */
    suspend fun ensureActiveCredential(): AccountSessionCredential = ensureActiveCredential(refreshDemoPresentation = true)

    /** A delayed rejection belongs to the exact authority that started the operation. */
    suspend fun <T> withActiveAuthority(
        rejectionStatus: (Throwable) -> Int? = { (it as? AccountSessionException)?.statusCode },
        operation: suspend (AccountSessionCredential) -> T,
    ): T {
        val expected = ensureActiveCredential()
        return try { operation(expected) }
        catch (error: Throwable) {
            if (error !is CancellationException && rejectionStatus(error) in setOf(401, 403)) {
                invalidateLocalSession(expected)
            }
            throw error
        }
    }

    private suspend fun ensureActiveCredential(refreshDemoPresentation: Boolean): AccountSessionCredential = refreshMutex.withLock {
        val metadata = metadataStore.accountSession.first()
            ?: throw reauthorizationRequired("This phone needs account authorization.")
        val token = credentialStore.readToken()
        if (synchronized(invalidationLock) { authorityFingerprint(metadata, token) in rejectedAuthorities }) throw reauthorizationRequired("Account authorization was rejected.")
        if (!hasValidStoredSessionMetadata(metadata) || token.isNullOrBlank() || !token.startsWith("rac_")) {
            invalidateSession(metadata, token)
            throw reauthorizationRequired("This phone needs account authorization.")
        }
        val sufficientLifetime = hasSufficientLifetime(metadata.expiresAt)
        val presentationKey = "${metadata.accountId}:${metadata.deviceId}"
        val now = monotonicMillis()
        val lastCheck = demoPresentationCheck
        val restrictedPresentationDue = metadata.demoAccessMode == "restricted" &&
            (lastCheck == null || lastCheck.first != presentationKey || now < lastCheck.second || now - lastCheck.second >= 300_000L)
        val presentationDue = refreshDemoPresentation && metadata.accountId.startsWith("acct_demo_") &&
            (metadata.demoAccessMode == null || restrictedPresentationDue)
        if (sufficientLifetime && !presentationDue) {
            return@withLock metadata.toCredential(token)
        }
        if (presentationDue) demoPresentationCheck = presentationKey to now
        try {
            refresh(metadata)
        } catch (error: AccountSessionException) {
            // A rejected refresh or a malformed local proof cannot be treated as
            // an active login. Remove both halves atomically from the UI's point
            // of view; only transient transport failures retain retryable state.
            if (error.statusCode == 400 || error.statusCode == 401 || error.statusCode == 403) invalidateSession(metadata, token)
            // A presentation-only check must not discard valid offline authority.
            // Never return a credential superseded by logout, switch or rejection.
            if (presentationDue && sufficientLifetime && metadata.demoAccessMode == "restricted" && error.retryable &&
                metadataStore.accountSession.first() == metadata && credentialStore.readToken() == token &&
                synchronized(invalidationLock) { authorityFingerprint(metadata, token) !in rejectedAuthorities }) {
                return@withLock metadata.toCredential(token)
            }
            throw error
        }
    }

    override suspend fun authorizeAccountJoin(
        intent: AccountJoinIntentDto,
        proof: AccountJoinAuthorizationProof,
    ): AccountJoinGrant = authorizeAccountJoinGrant(intent, proof, rendezvous = false)

    override suspend fun authorizeExistingEnrollment(intent: AccountJoinIntentDto, proof: AccountJoinAuthorizationProof): AccountJoinGrant =
        authorizeAccountJoinGrant(intent, proof, rendezvous = false, existingEnrollment = true)

    private suspend fun authorizeAccountJoinGrant(
        intent: AccountJoinIntentDto,
        proof: AccountJoinAuthorizationProof,
        rendezvous: Boolean,
        existingEnrollment: Boolean = false,
        remainingMillis: (() -> Long)? = null,
    ): AccountJoinGrant {
        val accountSession = ensureActiveCredential()
        validateCanonicalField("intentId", intent.intentId)
        validateCanonicalField("instanceId", intent.instanceId)
        // New direct account-intent joins are target-device scoped (`rdev_`). An
        // endpoint-less rendezvous intent is phone-scoped instead: Accounts
        // carries the requesting phone's `adev_`, while the computer is
        // identified by the signed instance identity. An existing-enrollment
        // upgrade may keep only this phone's own adev_ and installation key.
        val ownPhoneEnrollment = existingEnrollment && intent.deviceId == accountSession.deviceId
        if (rendezvous || ownPhoneEnrollment) validateAccountDeviceId(intent.deviceId) else validateTargetDeviceId(intent.deviceId)
        if (existingEnrollment && intent.devicePublicKeyFingerprint != devicePublicKeyFingerprint(identity.publicKeyEncoded())) {
            throw AccountSessionException(400, "account_join_device_scope_invalid", "Existing enrollment must use this installation key.")
        }
        if (!rendezvous && !ownPhoneEnrollment && intent.deviceId == accountSession.deviceId) {
            throw AccountSessionException(400, "account_join_device_scope_invalid", "Account and target device identifiers must be distinct.")
        }
        validateCanonicalField("devicePublicKeyFingerprint", intent.devicePublicKeyFingerprint)
        validateCanonicalField("nonce", proof.nonce)
        validateCanonicalField("issuedAt", proof.issuedAt)
        if (proof.nonce != intent.nonce || proof.issuedAt != intent.issuedAt || proof.deviceSignature.isBlank()) {
            throw AccountSessionException(400, "account_join_proof_invalid", "Account join proof does not match its intent.")
        }
        val response = try {
            val request = ApiRequest(
                method = "POST",
                path = "/v1/owner-auth/account-intents/${encodePath(intent.intentId)}/authorize",
                body = json.encodeToString(
                    AccountJoinAuthorizationRequest(
                        requestId = proof.requestId,
                        deviceId = intent.deviceId,
                        devicePublicKeyFingerprint = intent.devicePublicKeyFingerprint,
                        nonce = proof.nonce,
                        issuedAt = proof.issuedAt,
                        deviceSignature = proof.deviceSignature,
                    ),
                ),
                requestId = proof.requestId,
                idempotencyKey = proof.requestId,
            )
            val body = if (rendezvous) {
                executeRendezvousAuthenticated(request, remainingMillis)
            } else {
                executeAuthenticated(request)
            }
            decode<AccountJoinAuthorizationResponse>(body)
        } catch (error: AccountSessionException) {
            // Refusal of this computer is independent from the phone's account
            // credential. Keep that credential for another target or a fresh QR.
            val targetDenied = error.statusCode == 403 && error.code in setOf(
                "owner_auth_binding_mismatch", "owner_auth_binding_revoked",
            )
            if ((error.statusCode == 401 || error.statusCode == 403) && !targetDenied) invalidateLocalSession(accountSession)
            throw error
        }
        if (response.accountJoinGrant.isBlank() || response.intentId != intent.intentId
            || response.instanceId != intent.instanceId || response.deviceId != intent.deviceId) {
            throw AccountSessionException(401, "account_join_grant_invalid", "Accounts returned an invalid account join grant.")
        }
        if (rendezvous || ownPhoneEnrollment) {
            validateAccountDeviceId(response.deviceId)
        } else if (!isTargetDeviceId(response.deviceId)) {
            throw AccountSessionException(401, "account_join_grant_invalid", "Accounts returned an invalid target device id.")
        }
        validateFutureExpiry(response.expiresAt, "Account join grant")
        return AccountJoinGrant(
            accountJoinGrant = response.accountJoinGrant,
            expiresAt = response.expiresAt,
            intentId = response.intentId,
            instanceId = response.instanceId,
            deviceId = response.deviceId,
            rendezvousGrantSubmitted = response.rendezvousGrantSubmitted,
        )
    }

    override suspend fun rendezvous(
        targetInstanceId: String,
        deviceName: String,
        accountClaimToken: String?,
        targetInstance: AccountRendezvousTargetInstanceDto?,
        computerAlias: String,
    ): AccountRendezvousHandoff = coroutineScope {
        traceRendezvous(targetInstanceId, "account-check-start")
        val accountCredential = ensureActiveCredential()
        traceRendezvous(targetInstanceId, "account-check-ready")
        validateCanonicalField("targetInstanceId", targetInstanceId)
        if (targetInstance != null && (targetInstance.instanceId != targetInstanceId
                || targetInstance.publicKey.isBlank() || targetInstance.keyFingerprint.isBlank())) {
            throw AccountSessionException(400, "account_session_target_invalid", "Target computer identity is incomplete.")
        }
        val requestId = UUID.randomUUID().toString()
        val deviceId = accountCredential.deviceId
        val publicKey = identity.publicKeyEncoded()
        val fingerprint = devicePublicKeyFingerprint(publicKey)
        // A pending intent grants nothing: Accounts will not put it in the
        // computer's inbox until authorization supplies the device signature.
        // Overlap only that preparation with the one-time old-lease cleanup.
        val grantBarrier = async(start = CoroutineStart.UNDISPATCHED) {
            traceRendezvous(targetInstanceId, "lease-cleanup-start")
            beforeRendezvousGrant()
            traceRendezvous(targetInstanceId, "lease-cleanup-ready")
        }
        val createStartedMono = monotonicMillis()
        currentCoroutineContext().ensureActive()
        traceRendezvous(targetInstanceId, "intent-create-start")
        val intent = executeRendezvousAuthenticated(
            ApiRequest(
                method = "POST",
                path = "/v1/owner-auth/rendezvous",
                body = json.encodeToString(
                    CreateAccountRendezvousRequest(
                        requestId = requestId,
                        targetInstanceId = targetInstanceId,
                        targetInstance = targetInstance,
                        accountClaimToken = accountClaimToken?.trim()?.takeIf { it.isNotEmpty() },
                        computerAlias = normalizeComputerAlias(computerAlias),
                        device = AccountSessionDeviceDto(
                            deviceId = deviceId,
                            publicKey = publicKey,
                            alias = deviceName.trim().ifBlank { "Android device" },
                            platform = "android",
                            devicePublicKeyFingerprint = fingerprint,
                        ),
                    ),
                ),
                requestId = requestId,
                idempotencyKey = requestId,
            ),
            remainingMillis = { RENDEZVOUS_POLL_TIMEOUT_MS - (monotonicMillis() - createStartedMono).coerceAtLeast(0L) },
            onRateLimited = { traceRendezvous(targetInstanceId, "intent-create-rate-limited") },
        ).let { decode<CreateAccountRendezvousResponse>(it).intent }
        traceRendezvous(targetInstanceId, "intent-create-ready")
        require(intent.instanceId == targetInstanceId && intent.devicePublicKeyFingerprint == fingerprint) {
            "Accounts returned an invalid rendezvous intent"
        }
        val intentDeadlineMs = runCatching { Instant.parse(intent.expiresAt).toEpochMilli() }.getOrElse {
            throw AccountSessionException(502, "account_session_response_invalid", "Accounts returned an invalid rendezvous expiry.")
        }
        val receivedMono = monotonicMillis()
        val deliveryBudgetMs = minOf(
            RENDEZVOUS_POLL_TIMEOUT_MS - (receivedMono - createStartedMono).coerceAtLeast(0L),
            intentDeadlineMs - clock().toEpochMilli(),
        )
        fun remainingPollMs(): Long = minOf(
            deliveryBudgetMs - (monotonicMillis() - receivedMono).coerceAtLeast(0L),
            intentDeadlineMs - clock().toEpochMilli(),
        )
        fun timedOut(): Nothing = throw AccountSessionException(408, "owner_auth_rendezvous_timeout",
            "The computer did not complete account rendezvous.", retryable = true)
        fun remainingBudget(): Long = remainingPollMs().also { if (it <= 0L) timedOut() }
        // In particular, a cancelled caller must not authorize a late create
        // response, even if its barrier has already completed synchronously.
        currentCoroutineContext().ensureActive()
        traceRendezvous(targetInstanceId, "grant-barrier-start")
        withTimeoutOrNull(remainingBudget()) { grantBarrier.await() } ?: timedOut()
        traceRendezvous(targetInstanceId, "grant-barrier-ready")
        currentCoroutineContext().ensureActive()
        val deviceSignature = identity.sign(
            buildAccountJoinIntentMessage(
                instanceId = intent.instanceId,
                intentId = intent.intentId,
                deviceId = intent.deviceId,
                devicePublicKeyFingerprint = intent.devicePublicKeyFingerprint,
                nonce = intent.nonce,
                issuedAt = intent.issuedAt,
            ),
        )
        traceRendezvous(targetInstanceId, "grant-authorize-start")
        val grant = withTimeoutOrNull(remainingBudget()) {
            authorizeAccountJoinGrant(
                intent,
                AccountJoinAuthorizationProof(requestId, intent.nonce, intent.issuedAt, deviceSignature),
                rendezvous = true,
                remainingMillis = ::remainingPollMs,
            )
        } ?: timedOut()
        traceRendezvous(targetInstanceId, "grant-authorize-ready")
        currentCoroutineContext().ensureActive()
        if (!grant.rendezvousGrantSubmitted) {
            withTimeoutOrNull(remainingBudget()) {
                executeRendezvousAuthenticated(
                    ApiRequest(
                        method = "POST",
                        path = "/v1/owner-auth/rendezvous/${encodePath(requestId)}/grant",
                        body = Json.encodeToString(mapOf("requestId" to requestId, "accountJoinGrant" to grant.accountJoinGrant)),
                        requestId = requestId,
                        idempotencyKey = requestId,
                    ),
                    remainingMillis = ::remainingPollMs,
                )
            } ?: timedOut()
        }
        var attempts = 0
        traceRendezvous(targetInstanceId, "result-wait-start")
        while (attempts < RENDEZVOUS_POLL_MAX_ATTEMPTS) {
            if (remainingPollMs() <= 0L) timedOut()
            attempts += 1
            var completedLongWait = false
            try {
                val requestStarted = monotonicMillis()
                val body = withTimeoutOrNull(remainingPollMs()) {
                    executeAuthenticated(
                        ApiRequest(method = "POST", path = "/v1/owner-auth/rendezvous/${encodePath(requestId)}/result",
                            body = buildJsonObject { put("requestId", requestId); put("waitMs", RENDEZVOUS_RESULT_WAIT_MS) }.toString(),
                            requestId = requestId),
                    )
                } ?: timedOut()
                // A delayed response or a wall-clock rollback must not extend
                // the original signed intent's delivery window.
                if (remainingPollMs() <= 0L) timedOut()
                val response = json.parseToJsonElement(body).jsonObject
                val result = response["result"] as? JsonObject
                if (result != null) {
                    traceRendezvous(targetInstanceId, "result-wait-ready")
                    return@coroutineScope AccountRendezvousHandoff(requestId, intent, result)
                }
                // Only a recognized server wait that actually lasted at least
                // the old polling interval can replace the following delay.
                // Old servers and early/spurious notifications retain 5s.
                completedLongWait = response["resultWaitVersion"]?.jsonPrimitive?.contentOrNull == "1" &&
                    monotonicMillis() - requestStarted >= RENDEZVOUS_POLL_DELAY_MS
            } catch (error: AccountSessionException) {
                if (!isRendezvousRateLimit(error)) throw error
                traceRendezvous(targetInstanceId, "result-wait-rate-limited")
                if (attempts >= RENDEZVOUS_POLL_MAX_ATTEMPTS) throw error
                val cooldown = rateLimitDelayMs(error)
                // The outer recovery loop must receive the original 429 and
                // cooldown when it cannot fit inside this signed intent.
                if (cooldown >= remainingPollMs()) throw error
                pollDelay(cooldown)
                continue
            }
            if (attempts < RENDEZVOUS_POLL_MAX_ATTEMPTS) {
                val remaining = remainingPollMs()
                if (remaining <= 0L) timedOut()
                if (!completedLongWait) pollDelay(minOf(RENDEZVOUS_POLL_DELAY_MS, remaining))
            }
        }
        timedOut()
    }

    /** Revokes an account-directory device through Accounts, then lets the
     * caller decide whether its local credential should be cleared. */
    suspend fun revokeAccountDevice(deviceId: String): Boolean {
        validateAccountDeviceIdOrTarget(deviceId)
        val credential = ensureActiveCredential()
        val requestId = UUID.randomUUID().toString()
        val response = executeAuthenticated(
            ApiRequest(
                method = "POST",
                path = "/v1/owner-auth/account/devices/${encodePath(deviceId)}/revoke",
                body = Json.encodeToString(mapOf("requestId" to requestId)),
                requestId = requestId,
                idempotencyKey = requestId,
            ),
        )
        val revoked = runCatching {
            Json.parseToJsonElement(response).jsonObject["revoked"]?.jsonPrimitive?.content == "true"
        }.getOrDefault(false)
        if (!revoked) throw AccountSessionException(502, "account_device_revoke_unconfirmed", "Accounts did not confirm device revocation.")
        if (deviceId == credential.deviceId) clearLocalSessionIfCurrent(credential)
        return true
    }

    /** Ends only this account session; the `adev_` and its key remain reusable. */
    suspend fun logoutAccountSession(): Boolean {
        val credential = try {
            // Logout needs valid authority, not a presentation-mode migration.
            ensureActiveCredential(refreshDemoPresentation = false)
        } catch (error: AccountSessionException) {
            // A credential may already be expired/revoked after a lost logout
            // response. The local session is no longer usable in that case, so
            // make logout idempotent from the UI's point of view.
            if (error.statusCode in setOf(400, 401, 403)) {
                return true
            }
            throw error
        }
        suspend fun finishLocalLogout() {
            clearLocalSessionIfCurrent(credential) {
                if (credential.accountId.startsWith("acct_demo_")) afterDemoLogout()
            }
        }
        val requestId = UUID.randomUUID().toString()
        val response = try {
            executeAuthenticated(
                ApiRequest(
                    method = "POST",
                    path = "/v1/owner-auth/account/session/logout",
                    body = Json.encodeToString(mapOf("requestId" to requestId)),
                    requestId = requestId,
                    idempotencyKey = requestId,
                ),
            )
        } catch (error: AccountSessionException) {
            if (error.statusCode in setOf(400, 401, 403)) {
                finishLocalLogout()
                return true
            }
            throw error
        }
        val loggedOut = runCatching {
            Json.parseToJsonElement(response).jsonObject["loggedOut"]?.jsonPrimitive?.content == "true"
        }.getOrDefault(false)
        if (!loggedOut) {
            throw AccountSessionException(502, "account_session_logout_unconfirmed", "Accounts did not confirm account logout.")
        }
        finishLocalLogout()
        return true
    }

    /** Renames an account-directory device; the directory remains authoritative. */
    suspend fun renameAccountDevice(deviceId: String, alias: String): Boolean {
        validateAccountDeviceIdOrTarget(deviceId)
        val normalizedAlias = alias.replace(Regex("[\\r\\n]+"), " ").trim().take(64)
        if (normalizedAlias.isBlank()) {
            throw AccountSessionException(400, "account_device_alias_invalid", "Device name must not be blank.")
        }
        ensureActiveCredential()
        val requestId = UUID.randomUUID().toString()
        val response = executeAuthenticated(
            ApiRequest(
                method = "POST",
                path = "/v1/owner-auth/account/devices/${encodePath(deviceId)}/rename",
                body = json.encodeToString(mapOf("requestId" to requestId, "alias" to normalizedAlias)),
                requestId = requestId,
                idempotencyKey = requestId,
            ),
        )
        val renamed = runCatching {
            Json.parseToJsonElement(response).jsonObject["renamed"]?.jsonPrimitive?.content == "true"
        }.getOrDefault(false)
        if (!renamed) throw AccountSessionException(502, "account_device_rename_unconfirmed", "Accounts did not confirm the device rename.")
        return true
    }

    suspend fun getAccountUsage(): com.andysagent.agentoc.core.protocol.AccountUsageDto {
        ensureActiveCredential()
        val usage = decode<com.andysagent.agentoc.core.protocol.AccountUsageDto>(executeAuthenticated(
            ApiRequest(method = "GET", path = "/v1/owner-auth/account/usage"),
        ))
        requireV2(usage.contractVersion)
        val turn = usage.turn
        val valid = turn.policyVersion == "turn-account-quota-v1" && turn.counting == "concurrent-logical-endpoints" &&
            turn.limits.phones > 0 && turn.limits.computers > 0 && turn.used.phones >= 0 && turn.used.computers >= 0 &&
            turn.remaining.phones == (turn.limits.phones - turn.used.phones).coerceAtLeast(0) &&
            turn.remaining.computers == (turn.limits.computers - turn.used.computers).coerceAtLeast(0) &&
            turn.overLimit.phones == (turn.used.phones > turn.limits.phones) &&
            turn.overLimit.computers == (turn.used.computers > turn.limits.computers) &&
            turn.connections.reserved >= 0 && turn.connections.connected >= 0 &&
            turn.connections.active.toLong() == turn.connections.reserved.toLong() + turn.connections.connected.toLong() &&
            usage.subscription.plan in setOf("free", "plus", "pro") &&
            usage.subscription.status in setOf("default", "active", "expired") &&
            runCatching { Instant.parse(usage.asOf) }.isSuccess
        if (!valid) throw AccountSessionException(502, "account_usage_invalid", "Accounts returned invalid usage information.")
        return usage
    }

    suspend fun transcribeAccountAudio(audioWav: ByteArray, requestId: String): AccountAsrTranscriptionDto {
        if (audioWav.size !in 44..(1024 * 1024) || !requestId.matches(Regex("^[A-Za-z0-9_-]{16,128}$"))) {
            throw AccountSessionException(400, "asr_request_invalid", "The voice recording could not be submitted.")
        }
        ensureActiveCredential()
        val result = decode<AccountAsrTranscriptionDto>(executeAuthenticated(ApiRequest(
            method = "POST",
            path = "/v1/owner-auth/account/asr/transcriptions",
            requestId = requestId,
            idempotencyKey = requestId,
            bodyBytes = audioWav,
            contentType = "audio/wav",
        )))
        val valid = result.contractVersion == 1 && result.requestId == requestId
            && result.text.isNotBlank() && result.text.length <= 20_000
            && result.durationMs in 500L..20_000L
            && (result.languageCode?.matches(Regex("^[A-Za-z0-9-]{2,16}$")) != false)
        if (!valid) throw AccountSessionException(502, "asr_response_invalid", "Accounts returned an invalid transcription.")
        return result
    }

    suspend fun getAccountAsrUsage(period: String? = null): AccountAsrUsageDto {
        if (period != null && !period.matches(Regex("^\\d{4}-(0[1-9]|1[0-2])$"))) {
            throw AccountSessionException(400, "asr_usage_period_invalid", "Invalid speech recognition usage period.")
        }
        ensureActiveCredential()
        val path = "/v1/owner-auth/account/asr/usage" + (period?.let { "?period=$it" } ?: "")
        val usage = decode<AccountAsrUsageDto>(executeAuthenticated(ApiRequest(method = "GET", path = path)))
        val valid = usage.contractVersion == 1 && usage.policyVersion == "account-asr-monthly-v1"
            && usage.period.matches(Regex("^\\d{4}-(0[1-9]|1[0-2])$"))
            && usage.plan in setOf("free", "plus", "pro")
            && listOf(usage.limitMs, usage.usedMs, usage.reservedMs, usage.remainingMs,
                usage.requestCount).all { it >= 0 }
            && usage.remainingMs == (usage.limitMs - usage.usedMs - usage.reservedMs).coerceAtLeast(0)
        if (!valid) throw AccountSessionException(502, "asr_usage_invalid", "Accounts returned invalid speech recognition usage.")
        return usage
    }

    override suspend fun listOwnTurnConnections(afterConnectionId: String?): AccountTurnConnectionsPage {
        if (afterConnectionId != null && !isTurnReservationId(afterConnectionId)) {
            throw AccountSessionException(400, "turn_phone_inventory_invalid", "Invalid reservation cursor.")
        }
        val credential = ensureActiveCredential()
        val path = "/v1/owner-auth/account/turn/connections" +
            (afterConnectionId?.let { "?after=${encodePath(it)}" } ?: "")
        val page = decode<AccountTurnConnectionsPage>(executeAuthenticated(ApiRequest(method = "GET", path = path)))
        val ids = page.connections.map { it.connectionId }
        val valid = page.contractVersion == 1 && page.accountId == credential.accountId && page.deviceId == credential.deviceId &&
            page.connections.size <= 100 && page.legacyConnections >= 0 &&
            runCatching { Instant.parse(page.asOf) }.isSuccess && ids.distinct().size == ids.size && ids == ids.sorted() &&
            page.connections.all { isTurnReservationId(it.connectionId) && (afterConnectionId == null || it.connectionId > afterConnectionId) &&
                ACCOUNT_COMPUTER_ID_PATTERN.matches(it.instanceId) && isRenewableEnrollmentId(it.deviceId) &&
                runCatching { Instant.parse(it.expiresAt) }.isSuccess } &&
            (page.nextCursor == null || (ids.isNotEmpty() && page.nextCursor == ids.last()))
        if (!valid) throw AccountSessionException(502, "turn_phone_inventory_invalid", "Accounts returned an invalid phone lease inventory.")
        return page
    }

    override suspend fun releaseOwnTurnConnections(connectionIds: List<String>, reason: String): AccountTurnConnectionsRelease {
        if (connectionIds.size !in 1..100 || connectionIds.any { !isTurnReservationId(it) } ||
            reason !in setOf("client-release", "cold-process-recovery")) {
            throw AccountSessionException(400, "turn_phone_release_invalid", "Invalid reservation release.")
        }
        val ids = connectionIds.distinct()
        val credential = ensureActiveCredential()
        val response = decode<AccountTurnConnectionsRelease>(executeAuthenticated(ApiRequest(method = "POST",
            path = "/v1/owner-auth/account/turn/connections/release",
            body = json.encodeToString(AccountTurnConnectionsReleaseRequest(ids, reason)))))
        if (response.contractVersion != 1 || response.accountId != credential.accountId || response.deviceId != credential.deviceId ||
            response.processedConnections != ids.size || response.releasedConnections !in 0..ids.size) {
            throw AccountSessionException(502, "turn_phone_release_invalid", "Accounts did not confirm this phone's exact reservation release.")
        }
        return response
    }

    private fun authorityFingerprint(metadata: AccountSessionMetadata?, token: String?): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest("${metadata?.accountId}\u0000${metadata?.deviceId}\u0000${metadata?.credentialId}\u0000${metadata?.expiresAt}\u0000$token".toByteArray())
            .joinToString("") { "%02x".format(it.toInt() and 255) }

    /** Reject immediately; lifecycle cleanup may run independently of the rejected connection job. */
    suspend fun invalidateLocalSession(expected: AccountSessionCredential? = null) {
        val metadata = metadataStore.accountSession.first()
        val token = credentialStore.readToken()
        if (expected != null && (metadata?.accountId != expected.accountId || metadata.deviceId != expected.deviceId ||
                metadata.credentialId != expected.credentialId || token != expected.token)) return
        invalidateSession(metadata, token)
    }

    private suspend fun invalidateSession(metadata: AccountSessionMetadata?, token: String?) {
        val fingerprint = authorityFingerprint(metadata, token)
        val admitted = synchronized(invalidationLock) {
            rejectedAuthorities.add(fingerprint)
        }
        if (!admitted) return
        val cleanup: suspend () -> Unit = {
            try {
                accountDirectoryMutex.withLock {
                    if (metadataStore.accountSession.first() == metadata && credentialStore.readToken() == token) clearLocalSessionLocked()
                }
            } finally {
                synchronized(invalidationLock) { rejectedAuthorities.remove(fingerprint) }
            }
        }
        val dispatcher = dispatchSessionInvalidation
        if (dispatcher == null) cleanup() else {
            try { dispatcher(cleanup) }
            catch (error: Throwable) {
                synchronized(invalidationLock) { rejectedAuthorities.remove(fingerprint) }
                throw error
            }
        }
    }

    suspend fun clearLocalSession() = accountDirectoryMutex.withLock { clearLocalSessionLocked() }

    private suspend fun clearLocalSessionIfCurrent(
        expected: AccountSessionCredential,
        afterClear: suspend () -> Unit = {},
    ) = accountDirectoryMutex.withLock {
        val current = metadataStore.accountSession.first()
        if (current?.accountId == expected.accountId && current.deviceId == expected.deviceId &&
            current.credentialId == expected.credentialId && credentialStore.readToken() == expected.token) {
            clearLocalSessionLocked()
            afterClear()
        }
    }

    private suspend fun clearLocalSessionLocked() {
        val previousToken = credentialStore.readToken()
        val previousMetadata = metadataStore.accountSession.first()
        val update: suspend () -> Unit = {
            try { credentialStore.clear(); metadataStore.clearAccountSession() }
            catch (error: Throwable) {
                withContext(NonCancellable) {
                    if (metadataStore.accountSession.first() == previousMetadata && previousToken != null) credentialStore.writeToken(previousToken)
                }
                throw error
            }
        }
        changeAccountDirectory(AccountDirectoryChange(null, null, false), update)
    }

    private suspend fun refresh(metadata: AccountSessionMetadata): AccountSessionCredential {
        val requestId = UUID.randomUUID().toString()
        // Accounts validates Date.parse(issuedAt) and verifies this exact
        // canonical field, so always produce an explicit RFC3339 UTC literal.
        val issuedAt = DateTimeFormatter.ISO_INSTANT.format(clock())
        val nonce = randomNonce()
        validateCanonicalField("credentialId", metadata.credentialId)
        validateAccountDeviceId(metadata.deviceId)
        validateCanonicalField("requestId", requestId)
        validateCanonicalField("issuedAt", issuedAt)
        validateCanonicalField("nonce", nonce)
        val signature = identity.sign(
            buildAccountSessionRefreshMessage(
                credentialId = metadata.credentialId,
                deviceId = metadata.deviceId,
                requestId = requestId,
                issuedAt = issuedAt,
                nonce = nonce,
            ),
        )
        val body = executeAnonymous(
            ApiRequest(
                method = "POST",
                path = "/v1/owner-auth/native/session/refresh",
                body = json.encodeToString(
                    com.andysagent.agentoc.core.protocol.RefreshAccountSessionRequest(
                        credentialId = metadata.credentialId,
                        deviceId = metadata.deviceId,
                        requestId = requestId,
                        issuedAt = issuedAt,
                        nonce = nonce,
                        signature = signature,
                    ),
                ),
                requestId = requestId,
                idempotencyKey = requestId,
            ),
        )
        val element = json.parseToJsonElement(body).jsonObject
        val credentialElement = element["credential"] ?: json.parseToJsonElement(body)
        val credential = json.decodeFromJsonElement(AccountSessionCredentialDto.serializer(), credentialElement)
        val accountId = element["accountId"]?.jsonPrimitive?.contentOrNull ?: metadata.accountId
        val deviceId = element["deviceId"]?.jsonPrimitive?.contentOrNull ?: metadata.deviceId
        if (deviceId != metadata.deviceId) {
            throw AccountSessionException(401, "account_session_device_mismatch", "Accounts returned a different phone device id.")
        }
        return persistCredential(accountId, deviceId, credential, element["demoAccessMode"]?.jsonPrimitive?.contentOrNull, expectedCredentialId = metadata.credentialId)
    }

    private suspend fun persistCredential(
        accountId: String,
        deviceId: String,
        credential: AccountSessionCredentialDto,
        demoAccessMode: String? = null,
        expectedCredentialId: String? = null,
    ): AccountSessionCredential {
        val verifiedDemoAccessMode = if (accountId.matches(Regex("^acct_demo_[a-f0-9]{48}$"))) {
            if (demoAccessMode == "full") "full" else "restricted"
        } else null
        if (accountId.isBlank() || !isAccountDeviceId(deviceId) || credential.credentialId.isBlank()
            || credential.scope != ACCOUNT_DIRECTORY_SCOPE || !credential.token.startsWith("rac_")) {
            throw AccountSessionException(401, "account_session_credential_invalid", "Accounts returned an invalid phone credential.")
        }
        validateFutureExpiry(credential.expiresAt, "Accounts credential")
        accountDirectoryMutex.withLock {
            val previous = metadataStore.accountSession.first()
            if (expectedCredentialId != null && (previous?.credentialId != expectedCredentialId || previous.accountId != accountId)) {
                throw AccountSessionException(409, "account_session_superseded", "Account session changed during refresh.")
            }
            val previousToken = credentialStore.readToken()
            val update: suspend () -> Unit = {
                try {
                credentialStore.writeToken(credential.token)
                metadataStore.saveAccountSession(
            AccountSessionMetadata(
                accountId = accountId,
                deviceId = deviceId,
                credentialId = credential.credentialId,
                scope = credential.scope,
                expiresAt = credential.expiresAt,
                demoAccessMode = verifiedDemoAccessMode,
            ),
        )
                } catch (error: Throwable) {
                    withContext(NonCancellable) {
                        if (metadataStore.accountSession.first() == previous) {
                            if (previousToken == null) credentialStore.clear() else credentialStore.writeToken(previousToken)
                        } else credentialStore.clear()
                    }
                    throw error
                }
            }
            if (previous?.accountId != accountId) changeAccountDirectory(AccountDirectoryChange(accountId, accountTokenFingerprint(credential.token), previous == null), update) else update()
        }
        return AccountSessionCredential(
            accountId = accountId,
            deviceId = deviceId,
            credentialId = credential.credentialId,
            token = credential.token,
            scope = credential.scope,
            expiresAt = credential.expiresAt,
            demoAccessMode = verifiedDemoAccessMode,
        )
    }

    private suspend fun executeAnonymous(request: ApiRequest): String = execute(anonymousTransport, request)

    /** Retry only this server-advertised, phone-bound delivery operation. */
    private suspend fun executeAccountSessionCompletion(request: ApiRequest, challenge: AccountSessionChallenge): String {
        val window = challenge.completionRecoveryWindowMs.coerceIn(0L, 120_000L)
        val deadline = minOf(Instant.parse(challenge.expiresAt).toEpochMilli(), clock().toEpochMilli() + window)
        var retries = 0
        while (true) {
            validateFutureExpiry(challenge.expiresAt, "Account session challenge")
            try { return executeAnonymous(request) }
            catch (error: AccountSessionException) {
                if (window == 0L || retries >= 1 || error.statusCode != 0 || !error.retryable ||
                    clock().toEpochMilli() + 1_000 >= deadline) throw error
                retries++
                pollDelay(1_000)
            }
        }
    }

    private suspend fun executeAuthenticated(request: ApiRequest): String = execute(authenticatedTransport, request)

    /** Setup calls are idempotent by requestId, so a transient Accounts 429 can
     * be retried without creating a second rendezvous transaction. */
    private suspend fun executeRendezvousAuthenticated(
        request: ApiRequest,
        remainingMillis: (() -> Long)? = null,
        onRateLimited: () -> Unit = {},
    ): String {
        var retries = 0
        while (true) {
            try {
                return executeAuthenticated(request)
            } catch (error: AccountSessionException) {
                if (!isRendezvousRateLimit(error)) throw error
                onRateLimited()
                if (retries >= RENDEZVOUS_SETUP_RATE_LIMIT_RETRIES) throw error
                val cooldown = rateLimitDelayMs(error)
                if (remainingMillis != null && cooldown >= remainingMillis()) throw error
                retries += 1
                pollDelay(cooldown)
            }
        }
    }

    private fun rateLimitDelayMs(error: AccountSessionException): Long =
        (error.retryAfterMs?.takeIf { it > 0L } ?: RENDEZVOUS_RATE_LIMIT_DEFAULT_MS)
            .coerceAtLeast(RENDEZVOUS_RATE_LIMIT_RETRY_MIN_MS)

    private suspend fun execute(transport: AgentoCTransport, request: ApiRequest): String = try {
        transport.execute(request).body
    } catch (error: ApiException) {
        if (error.statusCode == 401 || error.statusCode == 403) {
            throw AccountSessionException(
                error.statusCode,
                error.code ?: "account_session_reauthorization_required",
                error.message,
                retryable = false,
                retryAfterMs = error.retryAfterMs,
                cause = error,
            )
        }
        throw AccountSessionException(
            error.statusCode,
            error.code ?: "account_session_request_failed",
            error.message,
            error.retryable,
            error.retryAfterMs,
            error,
        )
    } catch (error: CancellationException) {
        throw error
    } catch (error: AccountSessionException) {
        throw error
    } catch (error: Throwable) {
        throw AccountSessionException(0, "account_session_request_failed", "Accounts could not be reached.", retryable = true, cause = error)
    }

    private inline fun <reified T> decode(body: String): T = try {
        json.decodeFromString(body)
    } catch (error: Throwable) {
        throw AccountSessionException(0, "account_session_response_invalid", "Accounts returned an invalid response.", cause = error)
    }

    private fun AccountSessionMetadata.toCredential(token: String) = AccountSessionCredential(
        accountId = accountId,
        deviceId = deviceId,
        credentialId = credentialId,
        token = token,
        scope = scope,
        expiresAt = expiresAt,
        demoAccessMode = demoAccessMode,
    )

    private fun hasSufficientLifetime(expiresAt: String): Boolean = runCatching {
        Instant.parse(expiresAt).toEpochMilli() - clock().toEpochMilli() > MIN_ACCOUNT_CREDENTIAL_VALIDITY_MS
    }.getOrDefault(false)

    private fun hasValidStoredSessionMetadata(metadata: AccountSessionMetadata): Boolean =
        metadata.accountId.isNotBlank() &&
            isCanonicalStoredField(metadata.accountId) &&
            isAccountDeviceId(metadata.deviceId) &&
            metadata.credentialId.isNotBlank() &&
            isCanonicalStoredField(metadata.credentialId) &&
            metadata.scope == ACCOUNT_DIRECTORY_SCOPE &&
            runCatching { Instant.parse(metadata.expiresAt) }.isSuccess

    private fun isCanonicalStoredField(value: String): Boolean =
        value.isNotBlank() && !value.contains('\n') && !value.contains('\r')

    private fun validateFutureExpiry(value: String, label: String) {
        if (!runCatching { Instant.parse(value).isAfter(clock()) }.getOrDefault(false)) {
            throw AccountSessionException(401, "account_session_expired", "$label is expired.")
        }
    }

    private fun requireV2(contractVersion: Int) {
        if (contractVersion != 2) {
            throw AccountSessionException(501, "account_session_unsupported", "This Accounts service does not support phone sessions.")
        }
    }

    private fun validateCanonicalField(name: String, value: String) {
        if (value.isBlank() || value.contains('\n') || value.contains('\r')) {
            throw AccountSessionException(400, "account_session_request_invalid", "Invalid $name.")
        }
    }

    private fun validateAccountDeviceId(value: String) {
        validateCanonicalField("accountDeviceId", value)
        if (!isAccountDeviceId(value)) {
            throw invalid("Invalid account device id.")
        }
    }

    private fun validateTargetDeviceId(value: String) {
        validateCanonicalField("targetDeviceId", value)
        if (!isTargetDeviceId(value)) {
            throw AccountSessionException(400, "account_join_device_scope_invalid", "Invalid target device id.")
        }
    }

    private fun validateAccountDeviceIdOrTarget(value: String) {
        validateCanonicalField("deviceId", value)
        if (!isAccountDeviceId(value) && !isTargetDeviceId(value) && !ACCOUNT_COMPUTER_ID_PATTERN.matches(value)) {
            throw AccountSessionException(400, "account_device_id_invalid", "Invalid account device id.")
        }
    }

    private fun normalizeComputerAlias(value: String): String =
        value.replace(Regex("[\\r\\n]+"), " ").trim().take(64)

    private fun isAccountDeviceId(value: String): Boolean = ACCOUNT_DEVICE_ID_PATTERN.matches(value)

    private fun isTargetDeviceId(value: String): Boolean = TARGET_DEVICE_ID_PATTERN.matches(value)

    private fun invalid(message: String) = AccountSessionException(400, "account_session_request_invalid", message)

    private fun reauthorizationRequired(message: String) =
        AccountSessionException(401, "account_session_reauthorization_required", message)

    private fun encodePath(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private companion object {
        fun createNonce(): String {
            val bytes = ByteArray(24)
            SecureRandom().nextBytes(bytes)
            return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        }
    }
}
