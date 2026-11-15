package com.andysagent.ragent.core.auth

/** Archives remain inside the existing encrypted stores, never directory preferences. */
class AccountTargetCredentialProfiles(private val credentials: CredentialStore, private val p2p: P2PSecretStore) {
    fun archive(accountId: String?, targets: Collection<String>) {
        targets.forEach { id ->
            val token = credentials.readToken(id)
            val metadata = credentials.read(id)
            if (token == null) credentials.clearAccountProfile(accountId, id)
            else credentials.writeAccountProfile(accountId, id, token, metadata?.expiresAt, metadata?.scope)
            p2p.read(id)?.let { p2p.writeAccountProfile(accountId, id, it) } ?: p2p.clearAccountProfile(accountId, id)
        }
    }
    fun clearActive(targets: Collection<String>) {
        targets.forEach { credentials.clear(it); p2p.clear(it) }
    }
    fun restore(accountId: String?, targets: Collection<String>) {
        targets.forEach { id ->
            val token = credentials.readAccountProfileToken(accountId, id)
            val metadata = credentials.readAccountProfile(accountId, id)
            if (token == null) credentials.clear(id)
            else credentials.write(id, token, metadata?.expiresAt, metadata?.scope)
            p2p.readAccountProfile(accountId, id)?.let { p2p.write(id, it) } ?: p2p.clear(id)
        }
    }
    /** Includes archives for targets removed from the current directory. */
    fun purge(accountId: String?) {
        credentials.clearAccountProfiles(accountId)
        p2p.clearAccountProfiles(accountId)
    }
}
