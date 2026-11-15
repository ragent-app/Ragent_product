package com.andysagent.ragent.core.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

/**
 * Abstraction over ConnectivityManager.NetworkCallback so the
 * ConnectivitySupervisor can be tested without Android framework.
 */
interface NetworkMonitor {
    val isOnline: Boolean
    fun register(callback: Callback)
    fun unregister()

    interface Callback {
        fun onAvailable()
        fun onLost()
        fun onCapabilitiesChanged()
        fun onDefaultNetworkChanged() = onAvailable()
    }
}

/** Keeps route history through an offline interval and rejects late old-route events. */
internal class DefaultNetworkTracker<T> {
    private var current: T? = null
    private var observed = false
    fun available(network: T): Boolean {
        val changed = observed && current != network
        current = network
        observed = true
        return changed
    }
    fun lost(network: T): Boolean {
        if (current != network) return false
        current = null
        return true
    }
    fun isCurrent(network: T): Boolean = current == network
}

/**
 * Real implementation wrapping [ConnectivityManager.registerDefaultNetworkCallback].
 * ConnectivityManager cannot be instantiated in pure JVM unit tests — use a
 * [FakeNetworkMonitor] for testing instead.
 */
class AndroidNetworkMonitor(context: Context) : NetworkMonitor {
    private val cm: ConnectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private var listener: NetworkMonitor.Callback? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override val isOnline: Boolean
        get() {
            val network: Network = cm.activeNetwork ?: return false
            val caps: NetworkCapabilities = cm.getNetworkCapabilities(network) ?: return false
            return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        }

    override fun register(callback: NetworkMonitor.Callback) {
        listener = callback
        val cb = object : ConnectivityManager.NetworkCallback() {
            private val route = DefaultNetworkTracker<Network>()
            override fun onAvailable(network: Network) {
                if (networkCallback !== this) return
                val changed = route.available(network)
                if (changed) listener?.onDefaultNetworkChanged() else listener?.onAvailable()
            }

            override fun onLost(network: Network) {
                // A late loss notification for the former network must not
                // close the carrier already recovered on the new default.
                if (networkCallback !== this) return
                if (route.lost(network)) listener?.onLost()
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                if (networkCallback !== this) return
                if (route.isCurrent(network)) listener?.onCapabilitiesChanged()
            }
        }
        networkCallback = cb
        cm.registerDefaultNetworkCallback(cb)
    }

    override fun unregister() {
        networkCallback?.let { cm.unregisterNetworkCallback(it) }
        networkCallback = null
        listener = null
    }
}
