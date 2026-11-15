package com.andysagent.ragent

/** One-shot first-draw gate; no network status, timeout or guessed persisted values. */
internal class InitialContentGate {
    var ready: Boolean = false
        private set

    fun update(themeLoaded: Boolean, languageLoaded: Boolean, entryResolved: Boolean) {
        ready = ready || (themeLoaded && languageLoaded && entryResolved)
    }
}
