package com.andysagent.ragent

/** Reuse only a recent successful capacity check; the server remains authoritative. */
internal fun canReuseAccountCapacity(lastSuccessMs: Long?, nowMs: Long): Boolean {
    if (lastSuccessMs == null || nowMs < lastSuccessMs) return false
    return nowMs - lastSuccessMs < 15_000L
}
