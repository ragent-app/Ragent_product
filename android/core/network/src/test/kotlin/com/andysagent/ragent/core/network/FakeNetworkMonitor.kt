package com.andysagent.ragent.core.network

/**
 * In-memory [NetworkMonitor] for JVM unit tests.
 * No Android framework is required.
 */
class FakeNetworkMonitor(initialOnline: Boolean = true) : NetworkMonitor {
    @Volatile override var isOnline: Boolean = initialOnline
        private set

    private val listeners = mutableListOf<NetworkMonitor.Callback>()

    override fun register(callback: NetworkMonitor.Callback) {
        listeners.add(callback)
    }

    override fun unregister() {
        listeners.clear()
    }

    fun setOnline(online: Boolean) {
        isOnline = online
        if (online) {
            listeners.forEach { it.onAvailable() }
        } else {
            listeners.forEach { it.onLost() }
        }
    }

    fun simulateCapabilitiesChanged() {
        listeners.forEach { it.onCapabilitiesChanged() }
    }
}
