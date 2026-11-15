package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.datastore.AccountProfileTransition
import com.andysagent.ragent.core.datastore.AccountProfileDirectoryState
import java.security.MessageDigest
import java.util.UUID

/** Only non-secret intent and fingerprints cross the directory store boundary. */
data class AccountDirectoryChange(val nextAccountId: String?, val nextCredentialFingerprint: String?, val preserveCaller: Boolean)

interface AccountProfileTransitionStore {
    suspend fun read(): AccountProfileTransition?
    suspend fun write(value: AccountProfileTransition)
    suspend fun clear(id: String)
    suspend fun state(): AccountProfileDirectoryState
    suspend fun clearAccountSession()
}

internal fun accountTokenFingerprint(token: String?): String? = token?.let {
    MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { byte -> "%02x".format(byte.toInt() and 255) }
}

/** The caller serializes this coordinator with runtime admission and stops old resources first. */
class AccountProfileTransitions(private val store: AccountProfileTransitionStore,
    private val credentials: AccountCredentialStore, private val targets: AccountTargetCredentialProfiles,
    private val newId: () -> String = { UUID.randomUUID().toString() }) {
    suspend fun pending(): Boolean = store.read() != null

    suspend fun begin(change: AccountDirectoryChange): AccountProfileTransition {
        check(store.read() == null) { "Profile recovery is required before switching" }
        val current = store.state()
        val transition = AccountProfileTransition(id = newId(), previousAccountId = current.profileAccountId,
            previousTargets = current.targets.distinct(), nextAccountId = change.nextAccountId,
            nextCredentialFingerprint = change.nextCredentialFingerprint)
        transition.validate()
        targets.archive(current.profileAccountId, current.targets)
        // Active slots cannot be cleared until this intent is durable.
        store.write(transition)
        return transition
    }

    suspend fun recover() {
        val transition = store.read() ?: return
        transition.validate()
        val current = store.state()
        val committedLogin = transition.nextAccountId != null &&
            current.profileAccountId == transition.nextAccountId && current.sessionAccountId == transition.nextAccountId &&
            accountTokenFingerprint(credentials.readToken()) == transition.nextCredentialFingerprint
        if (!committedLogin) {
            // Never restore a pre-logout authority or trust a partially persisted login.
            credentials.clear()
            store.clearAccountSession()
        }
        val restored = store.state()
        targets.clearActive((transition.previousTargets + current.targets + restored.targets).distinct())
        targets.restore(restored.profileAccountId, restored.targets)
        // A failed repair keeps its intent for the next startup/retry.
        store.clear(transition.id)
    }
}
