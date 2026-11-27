package com.andysagent.ragent

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.WebParityPage
import com.andysagent.ragent.feature.workbench.WebParitySurface
import com.andysagent.ragent.feature.workbench.WebParityUiState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.time.LocalDate

private fun buildHeatmapJson(): String {
    val end = LocalDate.of(2026, 11, 26)
    val start = end.minusDays(179)
    val entries = (0L..179L).map { idx ->
        val date = start.plusDays(idx)
        val tokens = when {
            idx < 90L -> if (idx % 9L == 0L || idx % 17L == 0L) 180_000_000L else 0L
            idx < 130L -> when ((idx % 5L).toInt()) {
                0 -> 620_000_000L
                1 -> 280_000_000L
                2 -> 0L
                3 -> 450_000_000L
                else -> 120_000_000L
            }
            idx < 155L -> when ((idx % 4L).toInt()) {
                0 -> 1_150_000_000L
                1 -> 890_000_000L
                2 -> 520_000_000L
                else -> 1_450_000_000L
            }
            else -> when ((idx % 6L).toInt()) {
                0 -> 2_450_000_000L
                1 -> 1_850_000_000L
                2 -> 2_180_000_000L
                3 -> 1_320_000_000L
                4 -> 1_760_000_000L
                else -> 980_000_000L
            }
        }
        val runs = if (tokens > 0L) (tokens / 60_000_000L).coerceAtLeast(1L) else 0L
        """{"day":"$date","totalTokens":$tokens,"runCount":$runs}"""
    }
    return entries.joinToString(",")
}

private fun usageStatsJson(): JsonObject {
    val hourlyWeights = mapOf(
        0 to 420_000_000L,
        1 to 290_000_000L,
        2 to 195_000_000L,
        3 to 55_000_000L,
        4 to 230_000_000L,
        5 to 310_000_000L,
        10 to 65_000_000L,
        11 to 215_000_000L,
        12 to 48_000_000L,
    )
    val hourlyJson = (0..23).joinToString(",") { hour ->
        val tokens = hourlyWeights[hour] ?: 0L
        val runs = if (tokens > 0L) (tokens / 40_000_000L).coerceAtLeast(1L) else 0L
        """{"hour":$hour,"totalTokens":$tokens,"runCount":$runs}"""
    }
    val payload = """
    {
      "window": {"days": 180},
      "totals": {
        "runCount": 8120,
        "foregroundRuns": 6452,
        "inputTokens": 25320000000,
        "cachedInputTokens": 19240000000,
        "cachedInputShare": 0.76,
        "outputTokens": 253490000,
        "totalTokens": 25573490000
      },
      "heatmap": {
        "days": 180,
        "startDay": "2026-05-31",
        "endDay": "2026-11-26",
        "daily": [${buildHeatmapJson()}]
      },
      "hourly": {
        "date": "2026-11-26",
        "buckets": [$hourlyJson]
      },
      "byProject": [
        {"key": "proj_hebot", "projectId": "proj_hebot", "label": "盒宝 HeBot", "totalTokens": 14910000000, "runCount": 4120, "cachedInputShare": 0.79, "isOther": false},
        {"key": "proj_vecho", "projectId": "proj_vecho", "label": "Vecho", "totalTokens": 2900000000, "runCount": 980, "cachedInputShare": 0.74, "isOther": false},
        {"key": "proj_workbench", "projectId": "proj_workbench", "label": "工作台", "totalTokens": 2530000000, "runCount": 820, "cachedInputShare": 0.71, "isOther": false},
        {"key": "__other__", "projectId": "", "label": "Other", "totalTokens": 364200000, "runCount": 210, "cachedInputShare": 0.63, "isOther": true},
        {"key": "proj_showcase", "projectId": "proj_showcase", "label": "App 展示台", "totalTokens": 223120000, "runCount": 140, "cachedInputShare": 0.68, "isOther": false}
      ],
      "byTool": [
        {"key": "antigravity", "label": "Antigravity", "totalTokens": 18150000000, "runCount": 5210, "cachedInputShare": 0.79},
        {"key": "codex", "label": "Codex", "totalTokens": 5120000000, "runCount": 2040, "cachedInputShare": 0.73},
        {"key": "claude", "label": "Claude Code", "totalTokens": 2303490000, "runCount": 870, "cachedInputShare": 0.64}
      ],
      "byModel": [
        {"key": "gpt-5.4", "label": "gpt-5.4", "totalTokens": 14200000000, "runCount": 4380, "cachedInputShare": 0.78},
        {"key": "claude-sonnet-4.6", "label": "claude-sonnet-4.6", "totalTokens": 7850000000, "runCount": 2610, "cachedInputShare": 0.75},
        {"key": "gemini-3.1-pro", "label": "gemini-3.1-pro", "totalTokens": 3523490000, "runCount": 1130, "cachedInputShare": 0.70}
      ]
    }
    """.trimIndent()
    return Json.parseToJsonElement(payload).jsonObject
}

private fun usageStatsFixture() = WebParityUiState(
    page = WebParityPage.Usage,
    usageDays = 180,
    usageSelectedDate = "2026-11-26",
    usage = usageStatsJson(),
)

@Preview(name = "usage-stats-light-zh", widthDp = 412, heightDp = 1120, locale = "zh-rCN", showBackground = true)
@PreviewTest
@Composable
fun UsageStatsLightZhPreview() {
    RagentTheme(darkTheme = false) {
        WebParitySurface(
            page = WebParityPage.Usage,
            state = usageStatsFixture(),
            onEvent = {},
            onBack = {},
            targetLabel = "Windows 工作电脑",
        )
    }
}

@Preview(name = "usage-stats-dark-zh", widthDp = 412, heightDp = 1120, locale = "zh-rCN", showBackground = true)
@PreviewTest
@Composable
fun UsageStatsDarkZhPreview() {
    RagentTheme(darkTheme = true) {
        WebParitySurface(
            page = WebParityPage.Usage,
            state = usageStatsFixture(),
            onEvent = {},
            onBack = {},
            targetLabel = "Windows 工作电脑",
        )
    }
}

@Preview(name = "usage-stats-light-en", widthDp = 412, heightDp = 1120, locale = "en", showBackground = true)
@PreviewTest
@Composable
fun UsageStatsLightEnPreview() {
    RagentTheme(darkTheme = false) {
        WebParitySurface(
            page = WebParityPage.Usage,
            state = usageStatsFixture(),
            onEvent = {},
            onBack = {},
            targetLabel = "Windows workstation",
        )
    }
}
