package com.andysagent.ragent.core.protocol

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.JsonElement

class ProtocolCodec(
    private val json: kotlinx.serialization.json.Json = RagentProtocol.json,
) {
    fun <T> decode(strategy: DeserializationStrategy<T>, body: String): T = json.decodeFromString(strategy, body)

    fun <T> encode(strategy: SerializationStrategy<T>, value: T): String = json.encodeToString(strategy, value)

    fun parseElement(body: String): JsonElement = json.parseToJsonElement(body)
}
