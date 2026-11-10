package com.andysagent.agentoc.core.protocol

import kotlinx.serialization.Serializable

@Serializable
data class AccountAsrTranscriptionDto(
    val contractVersion: Int,
    val requestId: String,
    val text: String,
    val languageCode: String? = null,
    val durationMs: Long,
)

@Serializable
data class AccountAsrUsageDto(
    val contractVersion: Int,
    val available: Boolean,
    val policyVersion: String,
    val period: String,
    val plan: String,
    val limitMs: Long,
    val usedMs: Long,
    val reservedMs: Long,
    val remainingMs: Long,
    val requestCount: Long,
)
