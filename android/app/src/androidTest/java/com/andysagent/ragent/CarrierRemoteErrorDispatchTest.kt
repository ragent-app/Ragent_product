package com.andysagent.ragent

import android.util.Base64
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.p2p.P2PCandidate
import com.andysagent.ragent.core.p2p.P2PHttpResponse
import com.andysagent.ragent.core.p2p.WebRTCDataChannelTransport
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest
import org.webrtc.PeerConnection

/** Exercises the actual response dispatcher without opening a network connection. */
class CarrierRemoteErrorDispatchTest {
    @Test fun terminalIceBeforeChannelOpenFailsImmediately() {
        for (state in listOf(PeerConnection.IceConnectionState.FAILED, PeerConnection.IceConnectionState.CLOSED)) {
            val session = WebRTCDataChannelTransport(
                P2PCandidate("https://fixture.invalid", "fixture", "fixture"),
                InstrumentationRegistry.getInstrumentation().targetContext,
            )
            try {
                val observer = session.javaClass.getDeclaredField("peerObserver").apply { isAccessible = true }
                    .get(session) as PeerConnection.Observer
                observer.onIceConnectionChange(state)
                val failure = session.javaClass.getDeclaredField("connectFailure").apply { isAccessible = true }
                    .get(session) as String?
                assertEquals("ICE connection entered $state", failure)
                assertFalse(session.isOpen)
            } finally { session.close() }
        }
    }

    @Test fun cancellationRacingFirstStreamChunkDoesNotLeakReservedSpace() {
        val session = WebRTCDataChannelTransport(
            P2PCandidate("https://fixture.invalid", "fixture", "fixture"),
            InstrumentationRegistry.getInstrumentation().targetContext,
        )
        try {
            val pendingField = session.javaClass.getDeclaredField("pending").apply { isAccessible = true }
            @Suppress("UNCHECKED_CAST")
            val pending = pendingField.get(session) as MutableMap<String, Any>
            val constructor = Class.forName("com.andysagent.ragent.core.p2p.PendingRequest")
                .declaredConstructors.single().apply { isAccessible = true }
            val onResponse: (P2PHttpResponse) -> Unit = {}
            val onError: (Exception) -> Unit = {}
            val id = "cancelled"
            pending[id] = constructor.newInstance(onResponse, onError)
            val assembler = session.javaClass.getDeclaredField("responseStreams").apply { isAccessible = true }.get(session)
            val discard = assembler.javaClass.getDeclaredMethod("discard", String::class.java).apply { isAccessible = true }
            val reserved = assembler.javaClass.getDeclaredField("reserved").apply { isAccessible = true }
            val payload = ByteArray(25_000) { 65 }
            val digest = MessageDigest.getInstance("SHA-256").digest(payload).joinToString("") { "%02x".format(it) }
            val frame = JSONObject().put("type", "http_response_stream_v1").put("id", id)
                .put("index", 0).put("totalBytes", payload.size).put("sha256", digest)
                .put("dataBase64", Base64.encodeToString(payload.copyOfRange(0, 24 * 1024), Base64.NO_WRAP)).toString()
            val dispatch = session.javaClass.getDeclaredMethod("dispatchResponse", String::class.java).apply { isAccessible = true }
            val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
            val worker = Thread {
                try { dispatch.invoke(session, frame) } catch (error: Throwable) { failure.set(error) }
            }
            synchronized(assembler) {
                worker.start()
                val deadline = android.os.SystemClock.elapsedRealtime() + 3_000
                while (worker.state != Thread.State.BLOCKED && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(5)
                assertEquals(Thread.State.BLOCKED, worker.state)
                // The same order used by request cancellation: remove, discard.
                pending.remove(id)
                discard.invoke(assembler, id)
            }
            worker.join(3_000)
            assertTrue("Response dispatch did not finish", !worker.isAlive)
            assertNull(failure.get())
            assertEquals(0, reserved.getInt(assembler))
        } finally { session.close() }
    }

    @Test fun remoteErrorsRemainResponsesForBothFrameFormats() {
        val session = WebRTCDataChannelTransport(
            P2PCandidate("https://fixture.invalid", "fixture", "fixture"),
            InstrumentationRegistry.getInstrumentation().targetContext,
        )
        try {
            val pendingField = session.javaClass.getDeclaredField("pending").apply { isAccessible = true }
            @Suppress("UNCHECKED_CAST")
            val pending = pendingField.get(session) as MutableMap<String, Any>
            val pendingType = Class.forName("com.andysagent.ragent.core.p2p.PendingRequest")
            val constructor = pendingType.declaredConstructors.single().apply { isAccessible = true }
            val dispatch = session.javaClass.getDeclaredMethod("dispatchResponse", String::class.java).apply { isAccessible = true }
            for (streamed in listOf(false, true)) {
                val id = if (streamed) "streamed" else "plain"
                var response: P2PHttpResponse? = null
                var failure: Exception? = null
                val onResponse: (P2PHttpResponse) -> Unit = { response = it }
                val onError: (Exception) -> Unit = { failure = it }
                pending[id] = constructor.newInstance(onResponse, onError)
                val payload = JSONObject().put("type", "http_response").put("id", id)
                    .put("status", 0).put("error", "fixture remote failure").toString()
                val frame = if (streamed) {
                    val bytes = payload.toByteArray(Charsets.UTF_8)
                    val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                    JSONObject().put("type", "http_response_stream_v1").put("id", id)
                        .put("index", 0).put("totalBytes", bytes.size).put("sha256", digest)
                        .put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP)).toString()
                } else payload
                dispatch.invoke(session, frame)
                assertNull(failure)
                assertEquals("fixture remote failure", response?.error)
                assertEquals(false, pending.containsKey(id))
                val before = session.successfulResponseGeneration
                response = null
                pending[id] = constructor.newInstance(onResponse, onError)
                val success = JSONObject().put("type", "http_response").put("id", id).put("status", 200).toString()
                val successFrame = if (streamed) {
                    val bytes = success.toByteArray(Charsets.UTF_8)
                    val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                    JSONObject().put("type", "http_response_stream_v1").put("id", id)
                        .put("index", 0).put("totalBytes", bytes.size).put("sha256", digest)
                        .put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP)).toString()
                } else success
                dispatch.invoke(session, successFrame)
                assertEquals(200, response?.status)
                assertEquals(before + 1, session.successfulResponseGeneration)
            }
        } finally { session.close() }
    }
}
