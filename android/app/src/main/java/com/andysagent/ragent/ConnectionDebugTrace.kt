package com.andysagent.ragent

import android.app.Application
import android.content.pm.ApplicationInfo
import android.util.Log
import android.os.SystemClock
import java.security.MessageDigest

internal data class ConnectionTraceMarker(val elapsedMs: Long, val target: String, val event: String)
private val connectionTraceMarkers = ArrayDeque<ConnectionTraceMarker>()

internal fun connectionTraceSince(instanceId: String, elapsedMs: Long): List<ConnectionTraceMarker> {
    val target = connectionTraceTarget(instanceId)
    return synchronized(connectionTraceMarkers) {
        connectionTraceMarkers.filter { it.target == target && it.elapsedMs >= elapsedMs }
    }
}

private fun connectionTraceTarget(instanceId: String): String =
    MessageDigest.getInstance("SHA-256").digest(instanceId.toByteArray(Charsets.UTF_8))
        .take(4).joinToString("") { "%02x".format(it.toInt() and 0xff) }

/** Debug-only lifecycle markers. Never log credentials, endpoints, or payloads. */
internal fun connectionDebugTrace(application: Application, instanceId: String, event: String) {
    if (application.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return
    val target = connectionTraceTarget(instanceId)
    synchronized(connectionTraceMarkers) {
        if (connectionTraceMarkers.size >= 256) connectionTraceMarkers.removeFirst()
        connectionTraceMarkers.addLast(ConnectionTraceMarker(SystemClock.elapsedRealtime(), target, event))
    }
    Log.i("Ragent.Connection", "target=$target event=$event")
}
