package com.andysagent.ragent.core.protocol

import kotlinx.serialization.Serializable

@Serializable
data class AccountEndpointCountsDto(val phones: Int, val computers: Int)

@Serializable
data class AccountEndpointOverLimitDto(val phones: Boolean, val computers: Boolean)

@Serializable
data class AccountSubscriptionDto(val plan: String, val status: String, val source: String, val expiresAt: String? = null)

@Serializable
data class AccountTurnConnectionCountsDto(val active: Int, val reserved: Int, val connected: Int)

@Serializable
data class AccountTurnUsageDto(
    val policyVersion: String,
    val counting: String,
    val limits: AccountEndpointCountsDto,
    val used: AccountEndpointCountsDto,
    val remaining: AccountEndpointCountsDto,
    val overLimit: AccountEndpointOverLimitDto,
    val connections: AccountTurnConnectionCountsDto,
)

@Serializable
data class AccountUsageDto(val contractVersion: Int, val asOf: String, val subscription: AccountSubscriptionDto, val turn: AccountTurnUsageDto)
