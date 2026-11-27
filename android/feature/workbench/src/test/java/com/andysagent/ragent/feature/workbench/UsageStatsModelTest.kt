package com.andysagent.ragent.feature.workbench

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageStatsModelTest {
    @Test
    fun `formatCompactTokens formats G, M, K and plain integers`() {
        assertEquals("0", formatCompactTokens(0L))
        assertEquals("999", formatCompactTokens(999L))
        assertEquals("1.50K", formatCompactTokens(1_500L))
        assertEquals("253.49M", formatCompactTokens(253_490_000L))
        assertEquals("25.57G", formatCompactTokens(25_570_000_000L))
    }

    @Test
    fun `formatCachePercent and formatWholeCount format consistently`() {
        assertEquals("76.0%", formatCachePercent(0.76))
        assertEquals("0.0%", formatCachePercent(null))
        assertEquals("6,452", formatWholeCount(6_452L))
        assertEquals("11-26", formatMonthDay("2026-11-26"))
    }

    @Test
    fun `parseUsageStatsUiModel parses heatmap, 24 hourly buckets, KPI totals and breakdowns`() {
        val payload = Json.parseToJsonElement(
            """
            {
              "window": {"days": 30},
              "totals": {
                "runCount": 14,
                "foregroundRuns": 10,
                "inputTokens": 1000000,
                "cachedInputTokens": 750000,
                "cachedInputShare": 0.75,
                "outputTokens": 250000,
                "totalTokens": 1250000
              },
              "heatmap": {
                "days": 2,
                "daily": [
                  {"day": "2026-11-25", "totalTokens": 500000, "runCount": 6},
                  {"day": "2026-11-26", "totalTokens": 750000, "runCount": 8}
                ]
              },
              "hourly": {
                "date": "2026-11-26",
                "buckets": [
                  {"hour": 0, "totalTokens": 120000, "runCount": 2},
                  {"hour": 14, "totalTokens": 630000, "runCount": 6}
                ]
              },
              "byProject": [
                {"key": "proj_1", "projectId": "proj_1", "label": "Ragent", "totalTokens": 900000, "runCount": 9, "cachedInputShare": 0.8, "isOther": false},
                {"key": "__other__", "projectId": "", "label": "Other", "totalTokens": 350000, "runCount": 5, "isOther": true}
              ],
              "byTool": [
                {"key": "codex", "label": "codex", "totalTokens": 1250000, "runCount": 14, "inputTokens": 1000000, "cachedInputTokens": 750000}
              ],
              "byModel": [
                {"key": "gpt-5.4", "label": "gpt-5.4", "totalTokens": 1250000, "runCount": 14, "cachedInputShare": 0.75}
              ]
            }
            """.trimIndent(),
        ).jsonObject

        val model = parseUsageStatsUiModel(payload)
        assertNotNull(model)
        requireNotNull(model)
        assertEquals(30, model.windowDays)
        assertEquals(1_250_000L, model.totals.totalTokens)
        assertEquals(1_000_000L, model.totals.grossInputTokens)
        assertEquals(250_000L, model.totals.newInputTokens)
        assertEquals(750_000L, model.totals.cacheHitTokens)
        assertEquals(0.75, model.totals.cacheHitShare!!, 0.0001)
        assertEquals(250_000L, model.totals.outputTokens)
        assertEquals(10L, model.totals.turns)
        assertEquals(14L, model.totals.runs)

        assertEquals(2, model.heatmapDays.size)
        assertEquals("2026-11-26", model.hourlyDate)
        assertEquals(24, model.hourlyBuckets.size)
        assertEquals(120_000L, model.hourlyBuckets[0].totalTokens)
        assertEquals(630_000L, model.hourlyBuckets[14].totalTokens)
        assertEquals(0L, model.hourlyBuckets[23].totalTokens)

        assertEquals(2, model.byProject.size)
        assertTrue(model.byProject[1].isOther)
        assertEquals(0.75, model.byTool[0].cachedInputShare!!, 0.0001)
        assertEquals("gpt-5.4", model.byModel[0].label)
    }

    @Test
    fun `parseUsageStatsUiModel falls back cleanly to legacy byDay payload`() {
        val legacyPayload = Json.parseToJsonElement(
            """
            {
              "window": {"days": 7},
              "totals": {"runCount": 2, "inputTokens": 1000, "outputTokens": 234, "totalTokens": 1234},
              "byDay": [{"day": "2026-10-29", "runCount": 2, "totalTokens": 1234}]
            }
            """.trimIndent(),
        ).jsonObject

        val model = parseUsageStatsUiModel(legacyPayload, fallbackSelectedDate = "2026-10-29")
        assertNotNull(model)
        requireNotNull(model)
        assertEquals(180, model.heatmapDays.size)
        assertEquals(1234L, model.heatmapDays.last().totalTokens)
        assertEquals("2026-10-29", model.hourlyDate)
        assertEquals(24, model.hourlyBuckets.size)
        assertNull(parseUsageStatsUiModel(null))
    }
}
