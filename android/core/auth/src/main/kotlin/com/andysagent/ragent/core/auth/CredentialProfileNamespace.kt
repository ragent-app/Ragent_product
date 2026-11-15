package com.andysagent.ragent.core.auth

import java.security.MessageDigest

/** Opaque ids cannot alias the ordinary target_ namespace, including local ids. */
internal object CredentialProfileNamespace {
    fun owner(accountId: String?): String {
        require(accountId == null || accountId.isNotBlank()) { "Account id must not be blank" }
        return "account_profile_" + digest(accountId?.let { "account\u0000$it" } ?: "local") + "_"
    }

    fun target(accountId: String?, instanceId: String): String {
        require(instanceId.isNotBlank()) { "Instance id must not be blank" }
        return owner(accountId) + digest(instanceId) + "_"
    }

    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
}
