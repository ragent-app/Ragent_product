package com.andysagent.ragent

import com.andysagent.ragent.core.network.ApiException
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TemporaryAccessRetryPolicyTest {
    @Test fun `quota denial is surfaced immediately instead of polling until expiry`() {
        assertFalse(shouldRetryTemporaryAccessFailure(ApiException(
            429, "temporary_broker_turn_quota_exceeded", "quota", retryable = true)))
    }

    @Test fun `transient broker rate limits remain retryable`() {
        assertTrue(shouldRetryTemporaryAccessFailure(ApiException(
            429, "temporary_host_rate_limited", "retry later", retryable = true)))
    }

    @Test fun `non-retryable failures remain terminal`() {
        assertFalse(shouldRetryTemporaryAccessFailure(ApiException(
            403, "temporary_access_denied", "denied", retryable = false)))
    }
}
