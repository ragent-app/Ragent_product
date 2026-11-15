package com.andysagent.ragent.core.appapi

import kotlinx.serialization.Serializable
import java.security.MessageDigest

/** Platform-attested installation, never supplied as a request's authorization proof. */
@Serializable
data class InstalledCallerIdentity(
    val packageName: String,
    val uid: Int,
    val firstInstalledAt: Long,
    val currentSignerSha256: Set<String>,
) {
    fun validate() {
        require(packageName.length in 3..255 && Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+").matches(packageName))
        require(uid > 0 && firstInstalledAt > 0)
        require(currentSignerSha256.size in 1..16 && currentSignerSha256.all { Regex("[a-f0-9]{64}").matches(it) })
    }
    val binding: String get() {
        validate()
        val material = "$packageName\n$uid\n$firstInstalledAt\n${currentSignerSha256.sorted().joinToString("\n")}"
        return "android-install:" + MessageDigest.getInstance("SHA-256").digest(material.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}

/** Non-secret owner/account scope and currently paired targets, read from trusted local stores. */
@Serializable
data class CallerGrantContext(val accountBinding: String, val pairedTargetIds: Set<String>)

@Serializable
data class PersistedCallerGrant(
    val grantId: String,
    val identity: InstalledCallerIdentity,
    val grant: CallerGrant,
    val accountBinding: String,
    val createdAt: Long,
    val updatedAt: Long,
    val revision: Long = 0,
    val revokedAt: Long? = null,
    val version: Int = 1,
)

const val CALLER_GRANT_MAX_LIFETIME_MS = 30L * 24 * 60 * 60 * 1000

internal fun validateGrantContext(context: CallerGrantContext) {
    require(context.accountBinding.length in 1..256 && context.pairedTargetIds.size <= 256)
    require(context.pairedTargetIds.all { it.isNotBlank() && it.length <= 256 })
}

internal fun validateGrantRecord(row: PersistedCallerGrant) {
    row.identity.validate()
    require(row.version == 1 && Regex("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}").matches(row.grantId))
    require(row.grant.callerBinding == row.identity.binding && row.accountBinding.length in 1..256)
    require(row.createdAt >= 0 && row.updatedAt >= row.createdAt && row.revision >= 0)
    require(row.grant.expiresAt > row.createdAt && row.grant.expiresAt - row.createdAt <= CALLER_GRANT_MAX_LIFETIME_MS)
    require(row.revokedAt == null || row.revokedAt in row.createdAt..row.updatedAt)
    fun identifiers(ids: Set<String>?, maximum: Int) = ids == null || (ids.size <= maximum && ids.all { it.isNotBlank() && it.length <= 256 })
    require(row.grant.capabilityIds.isNotEmpty() && identifiers(row.grant.capabilityIds, 128))
    require(row.grant.targetIds.isNotEmpty() && identifiers(row.grant.targetIds, 256))
    require(identifiers(row.grant.sessionIds, 256) && identifiers(row.grant.projectIds, 256))
}
