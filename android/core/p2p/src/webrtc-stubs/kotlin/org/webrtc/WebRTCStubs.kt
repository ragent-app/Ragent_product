// ╔══════════════════════════════════════════════════════════════════╗
// ║  JVM TEST REPLACEMENT — NOT a WebRTC implementation.            ║
// ║  This source set is never packaged into the Android artifact.   ║
// ║  Android main uses io.getstream:stream-webrtc-android.          ║
// ╚══════════════════════════════════════════════════════════════════╝
package org.webrtc

// ── DataChannel ──────────────────────────────────────────────────────

open class DataChannel {
    open class Init {
        @JvmField var ordered: Boolean = true
        @JvmField var negotiated: Boolean = false
        @JvmField var id: Int = -1
    }

    interface Observer {
        fun onStateChange()
        fun onMessage(buffer: Buffer)
        fun onBufferedAmountChange(previousAmount: Long) {}
    }

    class Buffer(@JvmField val data: java.nio.ByteBuffer, @JvmField val binary: Boolean) {
        constructor(data: java.nio.ByteBuffer, binary: Boolean, offset: Int, size: Int) :
            this(data, binary)
    }

    enum class State { CONNECTING, OPEN, CLOSING, CLOSED }

    open fun registerObserver(observer: Observer) {}
    open fun unregisterObserver() {}
    open fun state(): State = State.CLOSED
    open fun send(buffer: Buffer): Boolean = false
    open fun bufferedAmount(): Long = 0L
    open fun close() {}
    open fun label(): String = ""
}

// ── IceCandidate ─────────────────────────────────────────────────────

open class IceCandidate(
    open val sdpMid: String?,
    open val sdpMLineIndex: Int,
    open val sdp: String,
) {
    override fun toString(): String = "$sdpMid:$sdpMLineIndex:$sdp"
}

// ── MediaConstraints ─────────────────────────────────────────────────

open class MediaConstraints {
    open class KeyValuePair(val key: String, val value: String)

    open val mandatory: MutableList<KeyValuePair> = mutableListOf()
    open val optional: MutableList<KeyValuePair> = mutableListOf()
}

// ── SdpObserver ──────────────────────────────────────────────────────

interface SdpObserver {
    fun onCreateSuccess(sdp: SessionDescription?)
    fun onSetSuccess()
    fun onCreateFailure(reason: String?)
    fun onSetFailure(reason: String?)
}

// ── SessionDescription ──────────────────────────────────────────────

open class SessionDescription(type: Type, description: String) {
    enum class Type { OFFER, PRANSWER, ANSWER, ROLLBACK }

    @JvmField val type: Type = type
    @JvmField val description: String = description
}

// ── PeerConnection ───────────────────────────────────────────────────

open class PeerConnection {

    interface Observer {
        fun onIceCandidate(candidate: IceCandidate?)
        fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?)
        fun onSignalingChange(state: SignalingState?)
        fun onIceConnectionChange(state: IceConnectionState?)
        fun onIceConnectionReceivingChange(receiving: Boolean)
        fun onIceGatheringChange(state: IceGatheringState?)
        fun onAddStream(stream: MediaStream?)
        fun onRemoveStream(stream: MediaStream?)
        fun onDataChannel(channel: DataChannel?) {}
        fun onRenegotiationNeeded()
        fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?)
        fun onIceConnectionReceivingChangeExt(receiving: Boolean) {}
    }

    enum class PeerConnectionState {
        NEW, CONNECTING, CONNECTED, DISCONNECTED, FAILED, CLOSED
    }

    enum class SignalingState { STABLE, HAVE_LOCAL_OFFER, HAVE_LOCAL_PRANSWER, HAVE_REMOTE_OFFER, HAVE_REMOTE_PRANSWER, CLOSED }

    enum class IceConnectionState { NEW, CHECKING, CONNECTED, COMPLETED, FAILED, DISCONNECTED, CLOSED }

    enum class IceGatheringState { NEW, GATHERING, COMPLETE }

    class IceServer(val uri: String) {
        companion object {
            @JvmStatic fun builder(uri: String): Builder = Builder(uri)
        }
        class Builder(private val uri: String) {
            fun setUsername(username: String): Builder = this
            fun setPassword(password: String): Builder = this
            fun createIceServer(): IceServer = IceServer(uri)
        }
    }

    // P2PDataChannelTransport accesses iceServers as `PeerConnection.RTCConfiguration(iceServers)`
    // The actual RTCConfiguration uses `IceServer` list. We provide a compatible constructor.
    open class RTCConfiguration internal constructor() {
        constructor(iceServers: List<IceServer>) : this()
        var iceServers: MutableList<IceServer> = mutableListOf()
        var iceTransportsType: IceTransportsType = IceTransportsType.ALL
    }

    enum class IceTransportsType { NONE, RELAY, NOHOST, ALL }

    open fun createDataChannel(label: String, init: DataChannel.Init): DataChannel = DataChannel()
    open fun createOffer(observer: SdpObserver, constraints: MediaConstraints) {}
    open fun createAnswer(observer: SdpObserver, constraints: MediaConstraints) {}
    open fun setLocalDescription(observer: SdpObserver, sdp: SessionDescription) {}
    open fun setRemoteDescription(observer: SdpObserver, sdp: SessionDescription) {}
    open fun addIceCandidate(candidate: IceCandidate): Boolean = true
    open fun connectionState(): PeerConnectionState = PeerConnectionState.CLOSED
    open fun close() {}
    open fun dispose() {}
}

// ── PeerConnectionFactory ─────────────────────────────────────────────

open class PeerConnectionFactory {

    class InitializationOptions(val context: android.content.Context) {
        companion object {
            @JvmStatic fun builder(context: android.content.Context): Builder = Builder(context)
        }
        class Builder(private val context: android.content.Context) {
            fun createInitializationOptions(): InitializationOptions = InitializationOptions(context)
        }
    }

    companion object {
        var isInitialized: Boolean = false
            private set

        @JvmStatic fun initialize(options: InitializationOptions) {
            isInitialized = true
        }

        @JvmStatic fun builder(): Builder = Builder()
    }

    class Builder {
        fun createPeerConnectionFactory(): PeerConnectionFactory? = PeerConnectionFactory()
        fun setVideoDecoderFactory(factory: Any?): Builder = this
        fun setVideoEncoderFactory(factory: Any?): Builder = this
        fun setAudioDecoderFactoryFactory(factory: Any?): Builder = this
        fun setAudioEncoderFactoryFactory(factory: Any?): Builder = this
    }

    open fun createPeerConnection(
        configuration: PeerConnection.RTCConfiguration,
        observer: PeerConnection.Observer,
    ): PeerConnection? = PeerConnection()

    open fun dispose() {}
}

// ── RtpReceiver & MediaStream (minimal) ───────────────────────────────

open class RtpReceiver
open class MediaStream
