package com.andysagent.agentoc.core.domain

/** Short-lived negative capability cache; a computer upgrade is probed again. */
internal class CombinedIntentAvailability(
    private val nowNanos: () -> Long = System::nanoTime,
    private val ttlNanos: Long = 5L * 60 * 1_000_000_000,
    private val maximumEntries: Int = 256,
) {
    init { require(ttlNanos > 0 && maximumEntries > 0) }
    private val absent = LinkedHashMap<String, Long>()

    @Synchronized fun mayProbe(instanceId: String): Boolean {
        val seen = absent[instanceId] ?: return true
        if (nowNanos() - seen < ttlNanos) return false
        absent.remove(instanceId)
        return true
    }

    @Synchronized fun markAbsent(instanceId: String) {
        absent.remove(instanceId)
        absent[instanceId] = nowNanos()
        while (absent.size > maximumEntries) absent.remove(absent.keys.first())
    }
}
