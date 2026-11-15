package com.andysagent.ragent.feature.workbench

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ProviderQuotaTest {
    @Test fun `coding plan exposes remaining windows rather than raw json`() {
        val snapshot = Json.parseToJsonElement("""{"status":"ok","planName":"Pro","windows":[{"id":"five_hour","usedPercent":25,"remainingPercent":75,"resetsAt":"2026-11-01T08:00:00Z"},{"id":"weekly","usedPercent":10}]}""").jsonObject
        val display = parseProviderQuota(snapshot)
        assertEquals("Pro", display.planName)
        assertEquals(listOf(75.0, 90.0), display.windows.map { it.remainingPercent })
        assertEquals("2026-11-01T08:00:00Z", display.windows.first().resetsAt)
    }

    @Test fun `balance currencies and empty or invalid data are handled`() {
        val snapshot = Json.parseToJsonElement("""{"status":"ok","balances":[{"remaining":12.5,"currency":"USD"},{"remaining":3,"currency":"CNY"}],"windows":[{"id":"weekly","remainingPercent":101},null]}""").jsonObject
        val display = parseProviderQuota(snapshot)
        assertEquals(listOf("USD", "CNY"), display.balances.map { it.currency })
        assertTrue(display.windows.isEmpty())
        assertEquals("unsupported", parseProviderQuota(Json.parseToJsonElement("""{"status":"unsupported"}""").jsonObject).status)
    }
}
