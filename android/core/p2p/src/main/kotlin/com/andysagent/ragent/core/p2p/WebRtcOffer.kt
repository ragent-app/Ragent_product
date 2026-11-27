package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.suspendCancellableCoroutine
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A native offer callback can arrive after its carrier has been closed. */
internal suspend fun createWebRtcOffer(
    connection: PeerConnection,
    iceRestart: Boolean = false,
    isCurrent: () -> Boolean,
): String =
    suspendCancellableCoroutine { cont ->
        val constraints = MediaConstraints().apply {
            if (iceRestart) mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
        }
        connection.createOffer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription?) {
                if (!cont.isActive) return
                if (!isCurrent()) {
                    cont.resumeWithException(IllegalStateException("WebRTC connection was closed"))
                    return
                }
                if (sdp == null) {
                    cont.resumeWithException(IllegalStateException("createOffer returned null SDP"))
                    return
                }
                try {
                    connection.setLocalDescription(object : SdpObserver {
                        override fun onSetSuccess() {
                            if (cont.isActive) {
                                if (isCurrent()) cont.resume(sdp.description)
                                else cont.resumeWithException(IllegalStateException("WebRTC connection was closed"))
                            }
                        }
                        override fun onSetFailure(reason: String?) {
                            if (cont.isActive) cont.resumeWithException(IllegalStateException("setLocalDescription failed: $reason"))
                        }
                        override fun onCreateSuccess(sdp: SessionDescription?) {}
                        override fun onCreateFailure(reason: String?) {}
                    }, sdp)
                } catch (error: Exception) {
                    if (cont.isActive) cont.resumeWithException(error)
                }
            }
            override fun onSetSuccess() {}
            override fun onSetFailure(reason: String?) {}
            override fun onCreateFailure(reason: String?) {
                if (cont.isActive) cont.resumeWithException(IllegalStateException("createOffer failed: $reason"))
            }
        }, constraints)
    }
