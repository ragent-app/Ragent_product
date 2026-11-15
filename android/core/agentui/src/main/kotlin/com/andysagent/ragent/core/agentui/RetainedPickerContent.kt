package com.andysagent.ragent.core.agentui

/** Presentation lifetime only. Dismiss/commit still belongs to the caller. */
internal class RetainedPickerContent<T>(initial: T) {
    private var lastOpenContent = initial
    private var wasOpen = false
    var generation: Int = 0
        private set

    fun frame(open: Boolean, current: T): T {
        if (open) {
            if (!wasOpen) generation++
            lastOpenContent = current
        }
        wasOpen = open
        return lastOpenContent
    }
}
