package com.andysagent.ragent

import java.security.MessageDigest

/** A local guard key scoped to the original computer and every signed challenge field. */
internal fun brokerDecisionJournalKey(instanceId: String, requestId: String, challengeDigest: String): String {
    require(instanceId.isNotBlank() && requestId.isNotBlank() && challengeDigest.matches(Regex("^[0-9a-f]{64}$")))
    val material = "$instanceId\n$requestId\n$challengeDigest".toByteArray(Charsets.UTF_8)
    return "decision." + MessageDigest.getInstance("SHA-256").digest(material)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

internal class BrokerDecisionAlreadyRecordedException(val recordedStatus: String) : IllegalStateException()
internal class BrokerDecisionNotRecordedException : IllegalStateException("Could not record this Broker decision before submission.")

/** Commits the guard before invoking the network call, including across process recreation. */
internal class BrokerDecisionJournal(
    private val lock: Any,
    private val read: (String) -> String?,
    private val write: (String, String) -> Boolean,
) {
    suspend fun <T> submitOnce(key: String, send: suspend () -> T): T {
        synchronized(lock) {
            read(key)?.let { throw BrokerDecisionAlreadyRecordedException(it) }
            if (!write(key, "submitted")) throw BrokerDecisionNotRecordedException()
        }
        return send()
    }

    fun complete(key: String, status: String) {
        check(write(key, status)) { "Could not finish recording this Broker decision." }
    }
}
