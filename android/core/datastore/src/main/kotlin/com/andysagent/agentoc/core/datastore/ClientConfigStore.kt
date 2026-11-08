package com.andysagent.agentoc.core.datastore

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.MessageDigest
import java.util.UUID

import com.andysagent.agentoc.core.model.AppLanguage
import com.andysagent.agentoc.core.model.AppTheme

private val Context.agentocConfigDataStore by preferencesDataStore(name = "agentoc-client-config")

private fun isValidVoiceLanguageCode(language: String): Boolean = language == "auto" || language.matches(Regex("[a-z]{2,3}"))

private fun normalizeVoiceLanguageCode(language: String?): String = when (language) {
    "zh-CN", "zh-TW" -> "zh"
    else -> language?.takeIf(::isValidVoiceLanguageCode) ?: "auto"
}

data class StoredInstance(
    val endpoint: String,
    val instanceId: String,
    val label: String = "",
    val autoConnect: Boolean = true,
)

/** Non-secret Google identity metadata stored only for this phone's UI. */
data class StoredGoogleAccountProfile(
    val displayName: String? = null,
    val email: String? = null,
    val photoUrl: String? = null,
)

/**
 * Non-secret projection of the Accounts phone session. The corresponding
 * `rac_` bearer is stored only in AccountCredentialStore's separate Keystore
 * namespace, never in Preferences/DataStore.
 */
data class AccountSessionMetadata(
    val accountId: String,
    val deviceId: String,
    val credentialId: String,
    val scope: String,
    val expiresAt: String,
    val demoAccessMode: String? = null,
)

/**
 * Non-secret directory metadata for one remote AgentoC computer.
 * Credentials and P2P material live in the target-scoped secure stores.
 */
@Serializable
data class LinkedComputer(
    val instanceId: String,
    val endpoint: String,
    val label: String = "",
    val platform: String? = null,
    val accessState: String = "Connected",
    val lastSelectedAt: Long = 0L,
    val lastSeenAt: Long? = null,
    /** Whether this target may be reconnected in the background automatically. */
    val autoConnect: Boolean = true,
) {
    init { require(instanceId.isNotBlank()) { "Computer instance id must not be blank" } }

    fun toStoredInstance(): StoredInstance = StoredInstance(endpoint, instanceId, label, autoConnect)
}

data class ComputerDirectory(
    val computers: List<LinkedComputer> = emptyList(),
    val activeTargetId: String? = null,
    val appApiRouting: AppApiRoutingPreferences = AppApiRoutingPreferences(),
    val shareRuntimeSelections: Map<String, ShareRuntimeSelection> = emptyMap(),
    val automaticAccountRestoreAllowed: Boolean = true,
) {
    val activeTarget: LinkedComputer?
        get() = computers.firstOrNull { it.instanceId == activeTargetId }
            ?: computers.firstOrNull()
}

/** Non-secret metadata required to retry an account join after a process restart. */
data class PendingAccountJoin(
    val endpoint: String,
    val intentId: String,
    val instanceId: String,
    val deviceId: String,
    val devicePublicKeyFingerprint: String,
    val nonce: String,
    val issuedAt: String,
    val expiresAt: String,
    val requestId: String,
    /** Name selected for the target computer before the join is completed. */
    val computerAlias: String = "",
)

/** Non-secret metadata required to retry Google promotion after a process restart. */
data class PendingGoogleBinding(
    val endpoint: String,
    val instanceId: String,
    val deviceId: String,
    val credentialExpiresAt: String? = null,
    val credentialScope: String? = null,
    val requestId: String,
)

class ClientConfigStore private constructor(private val context: Context, private val preferences: IoPreferencesStore) {
    constructor(context: Context) : this(context, IoPreferencesStore(store = { context.agentocConfigDataStore }))

    companion object {
        /** Explicit store ownership for isolated runtime graphs and alternate hosts. */
        fun withStore(context: Context, store: DataStore<Preferences>): ClientConfigStore =
            ClientConfigStore(context, IoPreferencesStore(store = { store }))
    }
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val accountDeviceIdPattern = Regex("^adev_[A-Za-z0-9_-]{4,156}$")

    private object Keys {
        val endpoint = stringPreferencesKey("endpoint")
        val instanceId = stringPreferencesKey("instance_id")
        val label = stringPreferencesKey("label")
        val joinEndpoint = stringPreferencesKey("pending_join_endpoint")
        val joinIntentId = stringPreferencesKey("pending_join_intent_id")
        val joinInstanceId = stringPreferencesKey("pending_join_instance_id")
        val joinDeviceId = stringPreferencesKey("pending_join_device_id")
        val joinDeviceFingerprint = stringPreferencesKey("pending_join_device_fingerprint")
        val joinNonce = stringPreferencesKey("pending_join_nonce")
        val joinIssuedAt = stringPreferencesKey("pending_join_issued_at")
        val joinExpiresAt = stringPreferencesKey("pending_join_expires_at")
        val joinRequestId = stringPreferencesKey("pending_join_request_id")
        val joinComputerAlias = stringPreferencesKey("pending_join_computer_alias")
        val googleEndpoint = stringPreferencesKey("pending_google_endpoint")
        val googleInstanceId = stringPreferencesKey("pending_google_instance_id")
        val googleDeviceId = stringPreferencesKey("pending_google_device_id")
        val googleCredentialExpiresAt = stringPreferencesKey("pending_google_credential_expires_at")
        val googleCredentialScope = stringPreferencesKey("pending_google_credential_scope")
        val googleRequestId = stringPreferencesKey("pending_google_request_id")
        val linkedComputers = stringPreferencesKey("linked_computers")
        val accountProfileTransition = stringPreferencesKey("account_profile_transition_v1")
        val automaticAccountRestoreSuppressed = booleanPreferencesKey("automatic_account_restore_suppressed")
        val activeTargetId = stringPreferencesKey("active_target_id")
        val primaryDatabaseInstanceId = stringPreferencesKey("primary_database_instance_id")
        val appApiRouting = stringPreferencesKey("app_api_routing")
        val shareRuntimeSelections = stringPreferencesKey("share_runtime_selections")
        val chatRuntimeCache = stringPreferencesKey("chat_runtime_cache_v1")
        val appTheme = stringPreferencesKey("app_theme")
        val appLanguage = stringPreferencesKey("app_language")
        val phoneLocalVoiceEnabled = booleanPreferencesKey("phone_local_voice_enabled")
        val voiceRecognitionLanguage = stringPreferencesKey("voice_recognition_language")
        val googleAccountDisplayName = stringPreferencesKey("google_account_display_name")
        val googleAccountEmail = stringPreferencesKey("google_account_email")
        val googleAccountPhotoUrl = stringPreferencesKey("google_account_photo_url")
        val accountDeviceId = stringPreferencesKey("account_device_id")
        val accountSessionAccountId = stringPreferencesKey("account_session_account_id")
        val accountSessionDeviceId = stringPreferencesKey("account_session_device_id")
        val accountSessionCredentialId = stringPreferencesKey("account_session_credential_id")
        val accountSessionScope = stringPreferencesKey("account_session_scope")
        val accountSessionExpiresAt = stringPreferencesKey("account_session_expires_at")
        val accountSessionDemoAccessMode = stringPreferencesKey("account_session_demo_access_mode")
    }

    /** The complete remote computer directory and the selected target. */
    val directory: Flow<ComputerDirectory> = preferences.data.map(::readDirectory)
    val directoryAccountId: Flow<String?> = preferences.data.map { AccountDirectoryProfiles.owner(it, it[Keys.accountSessionAccountId]) }
    val accountProfileState: Flow<AccountProfileDirectoryState> = preferences.data.map { prefs ->
        AccountProfileDirectoryState(AccountDirectoryProfiles.owner(prefs, prefs[Keys.accountSessionAccountId]),
            prefs[Keys.accountSessionAccountId], readDirectory(prefs).computers.map { it.instanceId })
    }
    val accountProfileTransition: Flow<AccountProfileTransition?> = preferences.data.map { prefs ->
        prefs[Keys.accountProfileTransition]?.let { raw ->
            require(raw.length <= 1_048_576) { "Profile transition is too large" }
            Json.decodeFromString<AccountProfileTransition>(raw).also { it.validate() }
        }
    }

    suspend fun saveAccountProfileTransition(value: AccountProfileTransition) {
        value.validate()
        val encoded = Json.encodeToString(AccountProfileTransition.serializer(), value)
        require(encoded.length <= 1_048_576)
        preferences.edit { prefs ->
            require(prefs[Keys.accountProfileTransition] == null) { "A profile transition needs recovery" }
            prefs[Keys.accountProfileTransition] = encoded
        }
    }

    suspend fun clearAccountProfileTransition(id: String) {
        preferences.edit { prefs ->
            val raw = prefs[Keys.accountProfileTransition] ?: return@edit
            require(Json.decodeFromString<AccountProfileTransition>(raw).id == id) { "Profile transition changed" }
            prefs.remove(Keys.accountProfileTransition)
        }
    }


    /** One-way legacy cache binding; removing a computer must not reassign its database. */
    suspend fun ensurePrimaryDatabaseBinding(): String? {
        var binding: String? = null
        preferences.edit { prefs ->
            binding = prefs[Keys.primaryDatabaseInstanceId]?.takeIf { it.isNotBlank() }
            if (binding == null) {
                binding = readDirectory(prefs).computers.firstOrNull()?.instanceId
                binding?.let { prefs[Keys.primaryDatabaseInstanceId] = it }
            }
        }
        return binding
    }

    /** Configured app theme preference. */
    val appTheme: Flow<AppTheme> = preferences.data.map { prefs ->
        AppTheme.fromValue(prefs[Keys.appTheme])
    }

    /** Configured app language preference. */
    val appLanguage: Flow<AppLanguage> = preferences.data.map { prefs ->
        AppLanguage.fromValue(prefs[Keys.appLanguage])
    }

    /** Explicit opt-in for recognition on this phone; it never enables a PC service. */
    val phoneLocalVoiceEnabled: Flow<Boolean> = preferences.data.map { prefs ->
        prefs[Keys.phoneLocalVoiceEnabled] ?: false
    }

    /** Recognition locale is independent of the app UI locale and defaults to multilingual detection. */
    val voiceRecognitionLanguage: Flow<String> = preferences.data.map { prefs ->
        normalizeVoiceLanguageCode(prefs[Keys.voiceRecognitionLanguage])
    }

    fun chatVoiceChoice(sessionId: String): Flow<String> {
        require(sessionId.isNotBlank())
        val key = chatVoiceChoiceKey(sessionId)
        return preferences.data.map { prefs ->
            prefs[key]?.takeIf { it in setOf("auto", "phone") || it.matches(Regex("computer:[A-Za-z0-9._:-]{1,128}")) } ?: "auto"
        }
    }

    /** Non-secret identity selected through Google on this phone. */
    val googleAccountProfile: Flow<StoredGoogleAccountProfile?> = preferences.data.map { prefs ->
        StoredGoogleAccountProfile(
            displayName = prefs[Keys.googleAccountDisplayName],
            email = prefs[Keys.googleAccountEmail],
            photoUrl = prefs[Keys.googleAccountPhotoUrl],
        ).takeIf { profile ->
            !profile.displayName.isNullOrBlank() || !profile.email.isNullOrBlank() || !profile.photoUrl.isNullOrBlank()
        }
    }

    /** Non-secret account-session metadata; null means this phone needs reauthorization. */
    val accountSession: Flow<AccountSessionMetadata?> = preferences.data.map { prefs ->
        val accountId = prefs[Keys.accountSessionAccountId]
        val deviceId = prefs[Keys.accountSessionDeviceId]
        val credentialId = prefs[Keys.accountSessionCredentialId]
        val scope = prefs[Keys.accountSessionScope]
        val expiresAt = prefs[Keys.accountSessionExpiresAt]
        if (accountId.isNullOrBlank() || deviceId.isNullOrBlank() || credentialId.isNullOrBlank()
            || scope.isNullOrBlank() || expiresAt.isNullOrBlank()) {
            null
        } else {
            AccountSessionMetadata(accountId, deviceId, credentialId, scope, expiresAt, prefs[Keys.accountSessionDemoAccessMode])
        }
    }

    /** Compatibility projection for code that still expects one configured instance. */
    val instance: Flow<StoredInstance?> = directory.map { it.activeTarget?.toStoredInstance() }

    val linkedComputers: Flow<List<LinkedComputer>> = directory.map { it.computers }
    val activeTargetId: Flow<String?> = directory.map { it.activeTargetId }

    val pendingAccountJoin: Flow<PendingAccountJoin?> = preferences.data.map { prefs ->
        val values = listOf(
            prefs[Keys.joinEndpoint],
            prefs[Keys.joinIntentId],
            prefs[Keys.joinInstanceId],
            prefs[Keys.joinDeviceId],
            prefs[Keys.joinDeviceFingerprint],
            prefs[Keys.joinNonce],
            prefs[Keys.joinIssuedAt],
            prefs[Keys.joinExpiresAt],
            prefs[Keys.joinRequestId],
        )
        if (values.any { it.isNullOrBlank() }) null
        else PendingAccountJoin(
            endpoint = values[0]!!,
            intentId = values[1]!!,
            instanceId = values[2]!!,
            deviceId = values[3]!!,
            devicePublicKeyFingerprint = values[4]!!,
            nonce = values[5]!!,
            issuedAt = values[6]!!,
            expiresAt = values[7]!!,
            requestId = values[8]!!,
            computerAlias = prefs[Keys.joinComputerAlias].orEmpty(),
        )
    }

    val pendingGoogleBinding: Flow<PendingGoogleBinding?> = preferences.data.map { prefs ->
        val endpoint = prefs[Keys.googleEndpoint]
        val instanceId = prefs[Keys.googleInstanceId]
        val deviceId = prefs[Keys.googleDeviceId]
        val requestId = prefs[Keys.googleRequestId]
        if (endpoint.isNullOrBlank() || instanceId.isNullOrBlank() || deviceId.isNullOrBlank() || requestId.isNullOrBlank()) null
        else PendingGoogleBinding(
            endpoint = endpoint,
            instanceId = instanceId,
            deviceId = deviceId,
            credentialExpiresAt = prefs[Keys.googleCredentialExpiresAt],
            credentialScope = prefs[Keys.googleCredentialScope],
            requestId = requestId,
        )
    }

    /**
     * Save a known computer without necessarily moving the foreground workbench
     * to it.  Background account carriers must retain `autoConnect` so they
     * are restored after a process restart, but they must never steal the
     * currently visible computer merely because their short-lived rendezvous
     * contract was refreshed.
     */
    suspend fun save(value: StoredInstance, select: Boolean = value.autoConnect) {
        upsertComputer(LinkedComputer(
            instanceId = value.instanceId,
            endpoint = value.endpoint.trimEnd('/'),
            label = value.label,
            lastSelectedAt = if (value.autoConnect) System.currentTimeMillis() else 0L,
            autoConnect = value.autoConnect,
        ), select = select)
    }

    suspend fun upsertComputer(value: LinkedComputer, select: Boolean = false) {
        preferences.edit { prefs ->
            val existing = decodeComputers(prefs[Keys.linkedComputers]).toMutableList()
            if (existing.isEmpty()) {
                val legacyEndpoint = prefs[Keys.endpoint].orEmpty().trimEnd('/')
                val legacyId = prefs[Keys.instanceId].orEmpty()
                if (legacyEndpoint.isNotBlank() && legacyId.isNotBlank()) {
                    existing += LinkedComputer(legacyId, legacyEndpoint, prefs[Keys.label].orEmpty())
                }
            }
            val normalized = value.copy(endpoint = value.endpoint.trimEnd('/'))
            val index = existing.indexOfFirst { it.instanceId == normalized.instanceId }
            if (index >= 0) existing[index] = normalized else existing += normalized
            prefs[Keys.linkedComputers] = json.encodeToString<List<LinkedComputer>>(existing)
            if (select || prefs[Keys.activeTargetId].isNullOrBlank()) {
                prefs[Keys.activeTargetId] = normalized.instanceId
            }
        }
    }

    /** Refresh display metadata only; an Accounts listing cannot pair or select a computer. */
    suspend fun refreshComputerLabels(labels: Map<String, String>) {
        preferences.edit { prefs ->
            val existing = decodeComputers(prefs[Keys.linkedComputers])
            val updated = existing.map { computer ->
                labels[computer.instanceId]?.takeIf { it.isNotBlank() }?.let { computer.copy(label = it) } ?: computer
            }
            if (updated != existing) prefs[Keys.linkedComputers] = json.encodeToString(updated)
        }
    }

    suspend fun selectTarget(instanceId: String) {
        preferences.edit { prefs ->
            val computers = decodeComputers(prefs[Keys.linkedComputers])
            require(computers.any { it.instanceId == instanceId }) { "Unknown computer target: $instanceId" }
            prefs[Keys.activeTargetId] = instanceId
            prefs[Keys.linkedComputers] = json.encodeToString<List<LinkedComputer>>(computers.map {
                if (it.instanceId == instanceId) it.copy(
                    lastSelectedAt = System.currentTimeMillis(),
                    autoConnect = true,
                ) else it
            })
        }
    }

    suspend fun setDefaultShareTarget(instanceId: String?) {
        preferences.edit { prefs ->
            require(instanceId == null || readDirectory(prefs).computers.any { it.instanceId == instanceId }) {
                "Sharing target must be a paired computer"
            }
            val routing = AppApiRoutingCodec.decode(prefs[Keys.appApiRouting])
            require(routing.readable) { "Routing settings require an explicit reset" }
            prefs[Keys.appApiRouting] = AppApiRoutingCodec.encode(routing.copy(defaultShareTargetId = instanceId))
        }
    }

    suspend fun setTargetAliases(instanceId: String, aliases: Collection<String>) {
        require(aliases.size <= 8) { "At most eight aliases are supported per computer" }
        val normalized = aliases.map(String::trim).also { values ->
            require(values.all(AppApiRoutingCodec::validAlias)) { "Aliases must contain 1–64 characters and no control characters" }
        }.distinctBy { it.lowercase(java.util.Locale.ROOT) }.toSet()
        preferences.edit { prefs ->
            require(readDirectory(prefs).computers.any { it.instanceId == instanceId }) { "Aliases require a paired computer" }
            val routing = AppApiRoutingCodec.decode(prefs[Keys.appApiRouting])
            require(routing.readable) { "Routing settings require an explicit reset" }
            val updated = routing.aliasesByTarget.toMutableMap().apply {
                if (normalized.isEmpty()) remove(instanceId) else put(instanceId, normalized)
            }
            prefs[Keys.appApiRouting] = AppApiRoutingCodec.encode(routing.copy(aliasesByTarget = updated))
        }
    }

    /** Owner action: forget malformed/future settings without changing the UI target. */
    suspend fun resetAppApiRouting() {
        preferences.edit { it.remove(Keys.appApiRouting) }
    }

    /** Stores only a human-selected complete configuration, independently of routing. */
    suspend fun rememberShareRuntime(instanceId: String, selection: ShareRuntimeSelection) {
        require(ShareRuntimeCodec.valid(selection))
        preferences.edit { prefs ->
            val paired = readDirectory(prefs).computers.map { it.instanceId }.toSet()
            require(instanceId in paired) { "Cannot remember an unpaired computer" }
            val previous = ShareRuntimeCodec.decode(prefs[Keys.shareRuntimeSelections]).filterKeys { it in paired }
            prefs[Keys.shareRuntimeSelections] = ShareRuntimeCodec.encode(previous + (instanceId to selection))
        }
    }

    private fun chatRuntimeCacheKey(instanceId: String, sessionId: String?): String =
        android.net.Uri.encode(instanceId) + "|" + (sessionId?.let { android.net.Uri.encode(it) } ?: "")

    suspend fun readChatRuntimeCache(instanceId: String, sessionId: String? = null): ShareRuntimeSelection? =
        ShareRuntimeCodec.decode(preferences.data.first()[Keys.chatRuntimeCache])[chatRuntimeCacheKey(instanceId, sessionId)]

    suspend fun cacheChatRuntime(instanceId: String, sessionId: String?, selection: ShareRuntimeSelection) {
        require(ShareRuntimeCodec.valid(selection))
        preferences.edit { prefs ->
            val paired = readDirectory(prefs).computers.map { it.instanceId }.toSet()
            if (instanceId !in paired) return@edit
            val prefixes = paired.map { chatRuntimeCacheKey(it, null) }
            val previous = ShareRuntimeCodec.decode(prefs[Keys.chatRuntimeCache]).filterKeys { key -> prefixes.any(key::startsWith) }.toMutableMap()
            val key = chatRuntimeCacheKey(instanceId, sessionId)
            previous.remove(key)
            previous[key] = selection
            while (previous.size > 128) previous.remove(previous.keys.first())
            prefs[Keys.chatRuntimeCache] = ShareRuntimeCodec.encode(previous)
        }
    }

    suspend fun removeTarget(instanceId: String) {
        preferences.edit { prefs ->
            prefs[Keys.automaticAccountRestoreSuppressed] = true
            val remaining = readDirectory(prefs).computers.filterNot { it.instanceId == instanceId }
            val remembered = ShareRuntimeCodec.decode(prefs[Keys.shareRuntimeSelections]) - instanceId
            if (remembered.isEmpty()) prefs.remove(Keys.shareRuntimeSelections)
            else prefs[Keys.shareRuntimeSelections] = ShareRuntimeCodec.encode(remembered)
            val prefix = chatRuntimeCacheKey(instanceId, null)
            val chatCache = ShareRuntimeCodec.decode(prefs[Keys.chatRuntimeCache]).filterKeys { !it.startsWith(prefix) }
            if (chatCache.isEmpty()) prefs.remove(Keys.chatRuntimeCache)
            else prefs[Keys.chatRuntimeCache] = ShareRuntimeCodec.encode(chatCache)
            val routing = AppApiRoutingCodec.decode(prefs[Keys.appApiRouting])
            if (routing.readable && instanceId in routing.aliasesByTarget) {
                // Keep a removed default's identity: a later headless request
                // must report the missing computer rather than select another.
                prefs[Keys.appApiRouting] = AppApiRoutingCodec.encode(routing.copy(aliasesByTarget = routing.aliasesByTarget - instanceId))
            }
            if (remaining.isEmpty()) {
                prefs.remove(Keys.linkedComputers)
                prefs.remove(Keys.activeTargetId)
                // Otherwise readDirectory()/migrateLegacy() can resurrect an
                // explicitly unpaired last computer from old singleton keys.
                prefs.remove(Keys.endpoint)
                prefs.remove(Keys.instanceId)
                prefs.remove(Keys.label)
            } else {
                prefs[Keys.linkedComputers] = json.encodeToString<List<LinkedComputer>>(remaining)
                if (prefs[Keys.activeTargetId] == instanceId) prefs[Keys.activeTargetId] = remaining.first().instanceId
            }
        }
    }

    suspend fun allowAutomaticAccountRestore() {
        preferences.edit { it.remove(Keys.automaticAccountRestoreSuppressed) }
    }

    /** Idempotently promotes the legacy singleton into the directory model. */
    suspend fun migrateLegacy() {
        preferences.edit { prefs ->
            if (!prefs[Keys.linkedComputers].isNullOrBlank()) return@edit
            val endpoint = prefs[Keys.endpoint].orEmpty().trimEnd('/')
            val instanceId = prefs[Keys.instanceId].orEmpty()
            if (endpoint.isBlank() || instanceId.isBlank()) return@edit
            val computer = LinkedComputer(instanceId, endpoint, prefs[Keys.label].orEmpty(), lastSelectedAt = System.currentTimeMillis())
            prefs[Keys.linkedComputers] = json.encodeToString<List<LinkedComputer>>(listOf(computer))
            prefs[Keys.activeTargetId] = instanceId
        }
    }

    suspend fun setAppTheme(theme: AppTheme) {
        preferences.edit { prefs ->
            prefs[Keys.appTheme] = theme.value
        }
    }

    suspend fun setAppLanguage(language: AppLanguage) {
        preferences.edit { prefs ->
            prefs[Keys.appLanguage] = language.value
        }
    }

    suspend fun setPhoneLocalVoiceEnabled(enabled: Boolean) {
        preferences.edit { prefs -> prefs[Keys.phoneLocalVoiceEnabled] = enabled }
    }

    suspend fun setVoiceRecognitionLanguage(languageTag: String) {
        val languageCode = normalizeVoiceLanguageCode(languageTag)
        require(languageCode == "auto" || languageCode == languageTag)
        preferences.edit { prefs -> prefs[Keys.voiceRecognitionLanguage] = languageCode }
    }

    suspend fun setChatVoiceChoice(sessionId: String, choice: String) {
        require(sessionId.isNotBlank())
        require(choice == "auto" || choice == "phone" || choice.matches(Regex("computer:[A-Za-z0-9._:-]{1,128}")))
        val key = chatVoiceChoiceKey(sessionId)
        preferences.edit { prefs -> prefs[key] = choice }
    }

    private fun chatVoiceChoiceKey(sessionId: String) = stringPreferencesKey(
        "chat_voice_choice_${MessageDigest.getInstance("SHA-256").digest(sessionId.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }}",
    )

    suspend fun saveGoogleAccountProfile(profile: StoredGoogleAccountProfile) {
        preferences.edit { prefs ->
            setOrRemove(prefs, Keys.googleAccountDisplayName, profile.displayName)
            setOrRemove(prefs, Keys.googleAccountEmail, profile.email)
            setOrRemove(prefs, Keys.googleAccountPhotoUrl, profile.photoUrl)
        }
    }

    suspend fun clearGoogleAccountProfile() {
        preferences.edit { prefs ->
            prefs.remove(Keys.googleAccountDisplayName)
            prefs.remove(Keys.googleAccountEmail)
            prefs.remove(Keys.googleAccountPhotoUrl)
        }
    }

    /**
     * The account device identifier is non-secret but must survive restart so
     * Accounts can associate this Keystore public key with the same phone.
     */
    suspend fun getOrCreateAccountDeviceId(): String {
        var result = ""
        preferences.edit { prefs ->
            result = prefs[Keys.accountDeviceId].orEmpty().trim()
            if (!accountDeviceIdPattern.matches(result)) {
                result = "adev_${UUID.randomUUID()}"
                prefs[Keys.accountDeviceId] = result
            }
        }
        return result
    }

    suspend fun saveAccountSession(value: AccountSessionMetadata) {
        require(value.accountId.isNotBlank()) { "Account id must not be blank" }
        require(accountDeviceIdPattern.matches(value.deviceId)) { "Account device id must be an adev_ identifier" }
        require(value.credentialId.isNotBlank()) { "Account credential id must not be blank" }
        require(value.scope == "account-directory") { "Unexpected Accounts credential scope" }
        require(value.expiresAt.isNotBlank()) { "Accounts credential expiry must not be blank" }
        preferences.edit { prefs ->
            AccountDirectoryProfiles.switch(prefs, prefs[Keys.accountSessionAccountId], value.accountId)
            prefs[Keys.accountSessionAccountId] = value.accountId
            prefs[Keys.accountSessionDeviceId] = value.deviceId
            prefs[Keys.accountSessionCredentialId] = value.credentialId
            prefs[Keys.accountSessionScope] = value.scope
            prefs[Keys.accountSessionExpiresAt] = value.expiresAt
            value.demoAccessMode?.let { prefs[Keys.accountSessionDemoAccessMode] = it } ?: prefs.remove(Keys.accountSessionDemoAccessMode)
            // If the server accepted the locally-generated device ID, keep it
            // as the source for future challenge and refresh proofs.
            // Demo sessions use a separate account-device namespace. Keep the
            // normal installation ID for a later Google login after sign-out.
            if (!value.accountId.startsWith("acct_demo_")) prefs[Keys.accountDeviceId] = value.deviceId
        }
    }

    suspend fun clearAccountSession() {
        preferences.edit { prefs ->
            AccountDirectoryProfiles.switch(prefs, prefs[Keys.accountSessionAccountId], null)
            prefs.remove(Keys.accountSessionAccountId)
            prefs.remove(Keys.accountSessionDeviceId)
            prefs.remove(Keys.accountSessionCredentialId)
            prefs.remove(Keys.accountSessionScope)
            prefs.remove(Keys.accountSessionExpiresAt)
            prefs.remove(Keys.accountSessionDemoAccessMode)
        }
    }

    suspend fun clear() {
        preferences.edit {
            // Cache files may survive configuration reset. Keep their historical owner.
            val primaryBinding = it[Keys.primaryDatabaseInstanceId]
            it.clear()
            primaryBinding?.let { binding -> it[Keys.primaryDatabaseInstanceId] = binding }
        }
    }

    suspend fun savePendingAccountJoin(value: PendingAccountJoin) {
        preferences.edit { prefs ->
            prefs[Keys.joinEndpoint] = value.endpoint.trimEnd('/')
            prefs[Keys.joinIntentId] = value.intentId
            prefs[Keys.joinInstanceId] = value.instanceId
            prefs[Keys.joinDeviceId] = value.deviceId
            prefs[Keys.joinDeviceFingerprint] = value.devicePublicKeyFingerprint
            prefs[Keys.joinNonce] = value.nonce
            prefs[Keys.joinIssuedAt] = value.issuedAt
            prefs[Keys.joinExpiresAt] = value.expiresAt
            prefs[Keys.joinRequestId] = value.requestId
            prefs[Keys.joinComputerAlias] = value.computerAlias
        }
    }

    suspend fun clearPendingAccountJoin() {
        preferences.edit { prefs ->
            prefs.remove(Keys.joinEndpoint)
            prefs.remove(Keys.joinIntentId)
            prefs.remove(Keys.joinInstanceId)
            prefs.remove(Keys.joinDeviceId)
            prefs.remove(Keys.joinDeviceFingerprint)
            prefs.remove(Keys.joinNonce)
            prefs.remove(Keys.joinIssuedAt)
            prefs.remove(Keys.joinExpiresAt)
            prefs.remove(Keys.joinRequestId)
            prefs.remove(Keys.joinComputerAlias)
        }
    }

    suspend fun savePendingGoogleBinding(value: PendingGoogleBinding) {
        preferences.edit { prefs ->
            prefs[Keys.googleEndpoint] = value.endpoint.trimEnd('/')
            prefs[Keys.googleInstanceId] = value.instanceId
            prefs[Keys.googleDeviceId] = value.deviceId
            if (value.credentialExpiresAt.isNullOrBlank()) prefs.remove(Keys.googleCredentialExpiresAt)
            else prefs[Keys.googleCredentialExpiresAt] = value.credentialExpiresAt
            if (value.credentialScope.isNullOrBlank()) prefs.remove(Keys.googleCredentialScope)
            else prefs[Keys.googleCredentialScope] = value.credentialScope
            prefs[Keys.googleRequestId] = value.requestId
        }
    }

    suspend fun clearPendingGoogleBinding() {
        preferences.edit { prefs ->
            prefs.remove(Keys.googleEndpoint)
            prefs.remove(Keys.googleInstanceId)
            prefs.remove(Keys.googleDeviceId)
            prefs.remove(Keys.googleCredentialExpiresAt)
            prefs.remove(Keys.googleCredentialScope)
            prefs.remove(Keys.googleRequestId)
        }
    }

    private fun readDirectory(prefs: androidx.datastore.preferences.core.Preferences): ComputerDirectory {
        val computers = decodeComputers(prefs[Keys.linkedComputers]).ifEmpty {
            val endpoint = prefs[Keys.endpoint].orEmpty()
            val id = prefs[Keys.instanceId].orEmpty()
            if (endpoint.isBlank() || id.isBlank()) emptyList()
            else listOf(LinkedComputer(id, endpoint, prefs[Keys.label].orEmpty()))
        }
        val selected = prefs[Keys.activeTargetId]?.takeIf { id -> computers.any { it.instanceId == id } }
            ?: computers.firstOrNull()?.instanceId
        return ComputerDirectory(computers, selected, AppApiRoutingCodec.decode(prefs[Keys.appApiRouting]),
            ShareRuntimeCodec.decode(prefs[Keys.shareRuntimeSelections]).filterKeys { id -> computers.any { it.instanceId == id } },
            automaticAccountRestoreAllowed = prefs[Keys.automaticAccountRestoreSuppressed] != true)
    }

    private fun decodeComputers(raw: String?): List<LinkedComputer> = raw.orEmpty()
        .takeIf { it.isNotBlank() }
        ?.let { runCatching { json.decodeFromString<List<LinkedComputer>>(it) }.getOrNull() }
        .orEmpty()
        // Account rendezvous intentionally stores an empty endpoint: the
        // verified bootstrap installs TURN-first/P2P carriers later.
        .filter { it.instanceId.isNotBlank() }
        .distinctBy { it.instanceId }

    private fun setOrRemove(
        prefs: androidx.datastore.preferences.core.MutablePreferences,
        key: androidx.datastore.preferences.core.Preferences.Key<String>,
        value: String?,
    ) {
        if (value.isNullOrBlank()) prefs.remove(key) else prefs[key] = value
    }
}
