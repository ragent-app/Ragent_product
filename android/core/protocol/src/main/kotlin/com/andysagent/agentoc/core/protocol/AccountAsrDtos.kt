package com.andysagent.agentoc.core.protocol

import kotlinx.serialization.Serializable

const val ACCOUNT_ASR_CONSENT_POLICY_VERSION = "account-asr-third-party-processing-v2"

@Serializable
data class AccountAsrTranscriptionDto(
    val contractVersion: Int,
    val requestId: String,
    val text: String,
    val languageCode: String? = null,
    val durationMs: Long,
)

@Serializable
data class AccountAsrConsentStateDto(
    val granted: Boolean = false,
    val policyVersion: String? = null,
    val recordedAt: String? = null,
)

@Serializable
data class AccountAsrConsentResponseDto(
    val contractVersion: Int,
    val policyVersion: String,
    val consent: AccountAsrConsentStateDto,
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
    val consent: AccountAsrConsentStateDto = AccountAsrConsentStateDto(),
)
