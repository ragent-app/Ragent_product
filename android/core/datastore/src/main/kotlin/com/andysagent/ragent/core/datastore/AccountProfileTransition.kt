package com.andysagent.ragent.core.datastore

import kotlinx.serialization.Serializable

@Serializable
data class AccountProfileTransition(
    val version: Int = 1,
    val id: String,
    val previousAccountId: String?,
    val previousTargets: List<String>,
    val nextAccountId: String?,
    val nextCredentialFingerprint: String?,
) {
    fun validate() {
        require(version == 1 && id.length in 8..128)
        require(previousAccountId == null || previousAccountId.length in 1..160)
        require(previousTargets.all { it.isNotBlank() && it.length <= 160 })
        require(nextAccountId == null || nextAccountId.length in 1..160)
        require(if (nextAccountId == null) nextCredentialFingerprint == null
            else nextCredentialFingerprint?.matches(Regex("[a-f0-9]{64}")) == true)
    }
}

data class AccountProfileDirectoryState(val profileAccountId: String?, val sessionAccountId: String?, val targets: List<String>)
