package com.andysagent.ragent.core.sync

data class StreamingSnapshot(
    val requestId: String,
    val text: String,
    val completed: Boolean,
)

class StreamingAccumulator {
    private val buffers = linkedMapOf<String, StringBuilder>()

    fun seed(requestId: String, text: String) {
        buffers[requestId] = StringBuilder(text)
    }

    fun current(requestId: String): String? = buffers[requestId]?.toString()

    fun clear() {
        buffers.clear()
    }

    fun append(requestId: String, delta: String): StreamingSnapshot {
        val buffer = buffers.getOrPut(requestId) { StringBuilder() }
        buffer.append(delta)
        return StreamingSnapshot(requestId, buffer.toString(), completed = false)
    }

    fun complete(requestId: String, finalText: String? = null): StreamingSnapshot {
        val buffer = buffers.getOrPut(requestId) { StringBuilder() }
        if (finalText != null) {
            buffer.setLength(0)
            buffer.append(finalText)
        }
        val snapshot = StreamingSnapshot(requestId, buffer.toString(), completed = true)
        buffers.remove(requestId)
        return snapshot
    }

    fun clear(requestId: String) {
        buffers.remove(requestId)
    }

    fun appendChannel(requestId: String, channel: String, delta: String): StreamingSnapshot =
        append("$requestId:$channel", delta)

    fun completeChannel(requestId: String, channel: String, finalText: String? = null): StreamingSnapshot =
        complete("$requestId:$channel", finalText)

    fun currentChannel(requestId: String, channel: String): String? =
        current("$requestId:$channel")

    fun clearChannel(requestId: String, channel: String) {
        clear("$requestId:$channel")
    }

    fun activeKeys(): Set<String> = buffers.keys.toSet()
}
