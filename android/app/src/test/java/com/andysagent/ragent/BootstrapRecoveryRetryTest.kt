package com.andysagent.ragent

import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.core.network.ApiException
import kotlin.test.Test
import kotlin.test.assertEquals

class BootstrapRecoveryRetryTest {
    @Test fun `account throttling keeps the server cooldown across outer retries`() {
        val error = AccountSessionException(429, "rate_limited", "busy", retryable = true, retryAfterMs = 60_000)
        assertEquals(60_000L, bootstrapRecoveryRetryDelayMs(error, 0))
        assertEquals(60_000L, bootstrapRecoveryRetryDelayMs(error, 5))
    }

    @Test fun `direct transport throttling and missing hints have a bounded request rate`() {
        assertEquals(90_000L, bootstrapRecoveryRetryDelayMs(ApiException(429, null, "busy", retryAfterMs = 90_000), 0))
        assertEquals(5_000L, bootstrapRecoveryRetryDelayMs(AccountSessionException(429, "rate_limited", "busy"), 0))
        assertEquals(30_000L, bootstrapRecoveryRetryDelayMs(AccountSessionException(429, "rate_limited", "busy"), 5))
    }

    @Test fun `non throttling failures keep ordinary exponential recovery`() {
        assertEquals(2_000L, bootstrapRecoveryRetryDelayMs(AccountSessionException(503, "unavailable", "offline", retryAfterMs = 60_000), 1))
        assertEquals(4_000L, bootstrapRecoveryRetryDelayMs(IllegalStateException("failure"), 2))
    }
}
