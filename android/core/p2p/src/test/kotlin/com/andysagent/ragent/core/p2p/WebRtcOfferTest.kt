package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class WebRtcOfferTest {
    private class Connection : PeerConnection() {
        lateinit var offerObserver: SdpObserver
        var localObserver: SdpObserver? = null
        override fun createOffer(observer: SdpObserver, constraints: MediaConstraints) { offerObserver = observer }
        override fun setLocalDescription(observer: SdpObserver, sdp: SessionDescription) { localObserver = observer }
    }

    private fun offer() = SessionDescription(SessionDescription.Type.OFFER, "sdp")

    @Test fun `late offer after cancellation never starts local description`() = runBlocking {
        val connection = Connection()
        val operation = async(start = CoroutineStart.UNDISPATCHED) { createWebRtcOffer(connection) { true } }
        operation.cancel()
        connection.offerObserver.onCreateSuccess(offer())
        assertNull(connection.localObserver)
    }

    @Test fun `closed connection rejects late offer without starting local description`() = runBlocking {
        val connection = Connection()
        var current = true
        val operation = async(start = CoroutineStart.UNDISPATCHED) { runCatching { createWebRtcOffer(connection) { current } } }
        current = false
        connection.offerObserver.onCreateSuccess(offer())
        assertFailsWith<IllegalStateException> { operation.await().getOrThrow() }
        assertNull(connection.localObserver)
    }

    @Test fun `closed connection cannot publish a late local description`() = runBlocking {
        val connection = Connection()
        var current = true
        val operation = async(start = CoroutineStart.UNDISPATCHED) { runCatching { createWebRtcOffer(connection) { current } } }
        connection.offerObserver.onCreateSuccess(offer())
        current = false
        connection.localObserver!!.onSetSuccess()
        assertFailsWith<IllegalStateException> { operation.await().getOrThrow() }
        Unit
    }

    @Test fun `current connection publishes its completed offer`() = runBlocking {
        val connection = Connection()
        val operation = async(start = CoroutineStart.UNDISPATCHED) { createWebRtcOffer(connection) { true } }
        connection.offerObserver.onCreateSuccess(offer())
        connection.localObserver!!.onSetSuccess()
        assertEquals("sdp", operation.await())
    }
}
