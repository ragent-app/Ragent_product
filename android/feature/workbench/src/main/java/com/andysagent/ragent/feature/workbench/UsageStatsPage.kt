package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.AgentoEmptyState
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.RagentSpacing
import com.andysagent.ragent.core.designsystem.remainingAppSystemBars
import androidx.compose.foundation.layout.asPaddingValues
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.text.NumberFormat
import java.time.LocalDate
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.roundToInt

internal data class UsageTotalsUi(
    val totalTokens: Long,
    val grossInputTokens: Long,
    val newInputTokens: Long,
    val cacheHitTokens: Long,
    val cacheHitShare: Double?,
    val outputTokens: Long,
    val turns: Long,
    val runs: Long,
)

internal data class UsageHeatmapDayUi(
    val day: String,
    val totalTokens: Long,
    val runCount: Long,
)

internal data class UsageHourlyBucketUi(
    val hour: Int,
    val totalTokens: Long,
    val runCount: Long,
)

internal data class UsageBreakdownItemUi(
    val key: String,
    val label: String,
    val totalTokens: Long,
    val runCount: Long,
    val cachedInputShare: Double?,
    val isOther: Boolean = false,
)

internal data class UsageStatsUiModel(
    val windowDays: Int,
    val totals: UsageTotalsUi,
    val heatmapDays: List<UsageHeatmapDayUi>,
    val hourlyDate: String,
    val hourlyBuckets: List<UsageHourlyBucketUi>,
    val byProject: List<UsageBreakdownItemUi>,
    val byTool: List<UsageBreakdownItemUi>,
    val byModel: List<UsageBreakdownItemUi>,
)

internal fun parseUsageStatsUiModel(
    usage: JsonObject?,
    fallbackSelectedDate: String? = null,
): UsageStatsUiModel? {
    usage ?: return null
    val windowDays = usage["window"]?.jsonObject?.get("days")?.asLongOrNull()?.toInt() ?: 180
    val totalsObj = usage["totals"]?.jsonObject
    val grossInput = totalsObj?.get("inputTokens")?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L
    val cacheHit = totalsObj?.get("cachedInputTokens")?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L
    val newInput = (grossInput - cacheHit).coerceAtLeast(0L)
    val output = totalsObj?.get("outputTokens")?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L
    val total = totalsObj?.get("totalTokens")?.asLongOrNull()?.coerceAtLeast(0L) ?: (grossInput + output)
    val runs = totalsObj?.get("runCount")?.asLongOrNull()?.coerceAtLeast(0L)
        ?: usage["runCount"]?.asLongOrNull()?.coerceAtLeast(0L)
        ?: 0L
    val turns = totalsObj?.get("foregroundRuns")?.asLongOrNull()?.coerceAtLeast(0L) ?: runs
    val cacheShare = totalsObj?.get("cachedInputShare")?.asDoubleOrNull()
        ?: if (grossInput > 0L) cacheHit.toDouble() / grossInput.toDouble() else null

    val heatmapArray = usage["heatmap"]?.jsonObject?.get("daily")?.jsonArray
    val parsedHeatmap = if (!heatmapArray.isNullOrEmpty()) {
        heatmapArray.mapNotNull { el ->
            val obj = el as? JsonObject ?: return@mapNotNull null
            val day = obj["day"]?.asStringOrNull() ?: return@mapNotNull null
            UsageHeatmapDayUi(
                day = day,
                totalTokens = obj["totalTokens"]?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L,
                runCount = obj["runCount"]?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L,
            )
        }
    } else {
        buildFallbackHeatmapFromByDay(usage["byDay"]?.jsonArray)
    }

    val hourlyObj = usage["hourly"]?.jsonObject
    val hourlyDate = hourlyObj?.get("date")?.asStringOrNull()
        ?: fallbackSelectedDate?.takeIf { it.isNotBlank() }
        ?: parsedHeatmap.lastOrNull()?.day
        ?: ""
    val rawHourlyBuckets = hourlyObj?.get("buckets")?.jsonArray.orEmpty()
        .mapNotNull { el ->
            val obj = el as? JsonObject ?: return@mapNotNull null
            val hour = obj["hour"]?.asLongOrNull()?.toInt() ?: return@mapNotNull null
            if (hour !in 0..23) return@mapNotNull null
            UsageHourlyBucketUi(
                hour = hour,
                totalTokens = obj["totalTokens"]?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L,
                runCount = obj["runCount"]?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L,
            )
        }
        .associateBy { it.hour }
    val hourlyBuckets = (0..23).map { hour ->
        rawHourlyBuckets[hour] ?: UsageHourlyBucketUi(hour = hour, totalTokens = 0L, runCount = 0L)
    }

    return UsageStatsUiModel(
        windowDays = windowDays,
        totals = UsageTotalsUi(
            totalTokens = total,
            grossInputTokens = grossInput,
            newInputTokens = newInput,
            cacheHitTokens = cacheHit,
            cacheHitShare = cacheShare,
            outputTokens = output,
            turns = turns,
            runs = runs,
        ),
        heatmapDays = parsedHeatmap,
        hourlyDate = hourlyDate,
        hourlyBuckets = hourlyBuckets,
        byProject = parseBreakdownList(usage["byProject"]?.jsonArray),
        byTool = parseBreakdownList(usage["byTool"]?.jsonArray),
        byModel = parseBreakdownList(usage["byModel"]?.jsonArray),
    )
}

private fun buildFallbackHeatmapFromByDay(byDay: JsonArray?): List<UsageHeatmapDayUi> {
    val map = byDay.orEmpty().mapNotNull { el ->
        val obj = el as? JsonObject ?: return@mapNotNull null
        val day = obj["day"]?.asStringOrNull()
            ?: obj["label"]?.asStringOrNull()
            ?: obj["key"]?.asStringOrNull()
            ?: return@mapNotNull null
        val parsed = runCatching { LocalDate.parse(day) }.getOrNull() ?: return@mapNotNull null
        parsed to UsageHeatmapDayUi(
            day = day,
            totalTokens = obj["totalTokens"]?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L,
            runCount = obj["runCount"]?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L,
        )
    }.toMap()
    if (map.isEmpty()) return emptyList()
    val endDate = map.keys.max()
    val startDate = endDate.minusDays(179)
    return (0L..179L).map { offset ->
        val date = startDate.plusDays(offset)
        map[date] ?: UsageHeatmapDayUi(day = date.toString(), totalTokens = 0L, runCount = 0L)
    }
}

private fun parseBreakdownList(array: JsonArray?): List<UsageBreakdownItemUi> =
    array.orEmpty().mapNotNull { el ->
        val obj = el as? JsonObject ?: return@mapNotNull null
        val key = obj["key"]?.asStringOrNull()
            ?: obj["projectId"]?.asStringOrNull()
            ?: obj["label"]?.asStringOrNull()
            ?: return@mapNotNull null
        val label = obj["label"]?.asStringOrNull() ?: key
        val input = obj["inputTokens"]?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L
        val cached = obj["cachedInputTokens"]?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L
        val cachedShare = obj["cachedInputShare"]?.asDoubleOrNull()
            ?: if (input > 0L) cached.toDouble() / input.toDouble() else null
        UsageBreakdownItemUi(
            key = key,
            label = label,
            totalTokens = obj["totalTokens"]?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L,
            runCount = obj["runCount"]?.asLongOrNull()?.coerceAtLeast(0L) ?: 0L,
            cachedInputShare = cachedShare,
            isOther = obj["isOther"]?.jsonPrimitive?.booleanOrNull == true || key == "__other__",
        )
    }

internal fun formatCompactTokens(value: Long): String {
    val safe = value.coerceAtLeast(0L)
    return when {
        safe >= 1_000_000_000L -> String.format(Locale.US, "%.2fG", safe / 1_000_000_000.0)
        safe >= 1_000_000L -> String.format(Locale.US, "%.2fM", safe / 1_000_000.0)
        safe >= 1_000L -> String.format(Locale.US, "%.2fK", safe / 1_000.0)
        else -> safe.toString()
    }
}

internal fun formatCachePercent(share: Double?): String {
    val clamped = (share ?: 0.0).coerceIn(0.0, 1.0)
    return String.format(Locale.US, "%.1f%%", clamped * 100.0)
}

internal fun formatWholePercent(share: Double): String {
    val pct = (share.coerceIn(0.0, 1.0) * 100.0).roundToInt()
    return "$pct%"
}

internal fun formatWholeCount(value: Long): String =
    NumberFormat.getIntegerInstance(Locale.US).format(value.coerceAtLeast(0L))

internal fun formatMonthDay(dayKey: String): String {
    val trimmed = dayKey.trim()
    return if (trimmed.length == 10 && trimmed[4] == '-' && trimmed[7] == '-') {
        trimmed.substring(5)
    } else {
        trimmed
    }
}

private val ChartPaletteLight = listOf(
    Color(0xFF7C6FD6),
    Color(0xFF566DD0),
    Color(0xFF4B89DC),
    Color(0xFF9E91E8),
    Color(0xFF7D93B8),
    Color(0xFFA2A6BD),
    Color(0xFF3A54A8),
)

private val ChartPaletteDark = listOf(
    Color(0xFF9D8FF0),
    Color(0xFF7992F5),
    Color(0xFF64A3F0),
    Color(0xFFB7AAFA),
    Color(0xFF8EA3C7),
    Color(0xFF9A9EB5),
    Color(0xFF566DD0),
)

private fun heatmapLevelColors(isDark: Boolean): List<Color> = if (isDark) {
    listOf(
        Color(0xFF2B2B33),
        Color(0xFF332F4D),
        Color(0xFF4B427A),
        Color(0xFF695EB0),
        Color(0xFF6974DB),
        Color(0xFF6D89EE),
        Color(0xFF93ADFF),
    )
} else {
    listOf(
        Color(0xFFEEEFF4),
        Color(0xFFE6E2F8),
        Color(0xFFC6BDF2),
        Color(0xFF9B8CE6),
        Color(0xFF7476DC),
        Color(0xFF566DD0),
        Color(0xFF2E47A8),
    )
}

private fun heatmapLevelFor(tokens: Long, maxTokens: Long): Int {
    if (tokens <= 0L || maxTokens <= 0L) return 0
    val ratio = tokens.toDouble() / maxTokens.toDouble()
    return when {
        ratio <= 0.12 -> 1
        ratio <= 0.28 -> 2
        ratio <= 0.48 -> 3
        ratio <= 0.68 -> 4
        ratio <= 0.86 -> 5
        else -> 6
    }
}

@Composable
internal fun UsageStatsPage(
    usage: JsonObject?,
    selectedDays: Int,
    selectedDate: String?,
    onSelectDays: (Int) -> Unit,
    onSelectDate: (String) -> Unit,
) {
    val model = remember(usage, selectedDate) { parseUsageStatsUiModel(usage, selectedDate) }
    val bottomPadding = remainingAppSystemBars().asPaddingValues().calculateBottomPadding() + RagentSpacing.Block
    LazyColumn(
        contentPadding = PaddingValues(
            start = RagentSpacing.Gutter,
            top = RagentSpacing.Compact,
            end = RagentSpacing.Gutter,
            bottom = bottomPadding,
        ),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxSize().testTag("usage-stats-list"),
    ) {
        if (model == null) {
            item(key = "usage-empty") {
                AgentoEmptyState(
                    stringResource(R.string.sp_usage_unavailable),
                    stringResource(R.string.sp_usage_unavailable_detail),
                )
            }
            return@LazyColumn
        }

        item(key = "usage-heatmap") {
            UsageHeatmapCard(
                days = model.heatmapDays,
                selectedDay = model.hourlyDate,
                onSelectDay = onSelectDate,
            )
        }

        item(key = "usage-hourly") {
            UsageHourlyCard(
                dateKey = model.hourlyDate,
                buckets = model.hourlyBuckets,
            )
        }

        item(key = "usage-window-selector") {
            UsageWindowSelector(
                selectedDays = selectedDays,
                onSelectDays = onSelectDays,
            )
        }

        item(key = "usage-kpi-grid") {
            UsageKpiGrid(totals = model.totals)
        }

        item(key = "usage-by-project") {
            UsageByProjectCard(
                items = model.byProject,
                totalProjectTokens = model.byProject.sumOf { it.totalTokens },
            )
        }

        item(key = "usage-by-tool") {
            UsageBreakdownListCard(
                title = stringResource(R.string.usage_by_tool),
                items = model.byTool,
            )
        }

        item(key = "usage-by-model") {
            UsageBreakdownListCard(
                title = stringResource(R.string.usage_by_model),
                items = model.byModel,
            )
        }
    }
}

private data class HeatmapGridCell(
    val day: String,
    val totalTokens: Long,
    val col: Int,
    val row: Int,
)

private data class HeatmapMonthLabel(
    val col: Int,
    val month: Int,
)

@Composable
private fun UsageHeatmapCard(
    days: List<UsageHeatmapDayUi>,
    selectedDay: String,
    onSelectDay: (String) -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val ramp = remember(isDark) { heatmapLevelColors(isDark) }
    val selectedStroke = if (isDark) Color(0xFFE8EEFF) else Color(0xFF2E47A8)
    val maxTokens = remember(days) { days.maxOfOrNull { it.totalTokens } ?: 0L }

    val layout = remember(days) {
        if (days.isEmpty()) {
            Triple(emptyList<HeatmapGridCell>(), 0, emptyList<HeatmapMonthLabel>())
        } else {
            val firstParsed = runCatching { LocalDate.parse(days.first().day) }.getOrNull()
            // Monday = 0 .. Sunday = 6
            val leadingEmpty = firstParsed?.let { it.dayOfWeek.value - 1 } ?: 0
            val cells = ArrayList<HeatmapGridCell>(days.size)
            val monthLabels = mutableListOf<HeatmapMonthLabel>()
            var lastLabeledCol = -3
            var prevMonth = -1
            days.forEachIndexed { idx, entry ->
                val slot = idx + leadingEmpty
                val col = slot / 7
                val row = slot % 7
                cells += HeatmapGridCell(
                    day = entry.day,
                    totalTokens = entry.totalTokens,
                    col = col,
                    row = row,
                )
                val parsed = runCatching { LocalDate.parse(entry.day) }.getOrNull()
                if (parsed != null) {
                    val month = parsed.monthValue
                    if ((parsed.dayOfMonth == 1 || idx == 0) && month != prevMonth && col - lastLabeledCol >= 2) {
                        monthLabels += HeatmapMonthLabel(col = col, month = month)
                        lastLabeledCol = col
                        prevMonth = month
                    } else if (prevMonth == -1) {
                        prevMonth = month
                    }
                }
            }
            val columns = ceil((days.size + leadingEmpty) / 7.0).toInt().coerceAtLeast(1)
            Triple(cells, columns, monthLabels)
        }
    }
    val cells = layout.first
    val columnCount = layout.second
    val monthLabels = layout.third

    val density = LocalDensity.current

    SettingsContentCard(Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(RagentSpacing.Standard),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = stringResource(R.string.usage_heatmap),
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.primaryContent,
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = stringResource(R.string.usage_less),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.secondaryContent,
                    )
                    listOf(0, 1, 2, 3, 4, 6).forEach { level ->
                        Box(
                            Modifier
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(ramp[level]),
                        )
                    }
                    Text(
                        text = stringResource(R.string.usage_more),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.secondaryContent,
                    )
                }
            }

            if (cells.isEmpty()) {
                Text(
                    text = stringResource(R.string.sp_usage_unavailable_detail),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.secondaryContent,
                )
            } else {
                BoxWithConstraints(Modifier.fillMaxWidth()) {
                    val widthPx = with(density) { maxWidth.toPx() }
                    val gapPx = with(density) { 2.5.dp.toPx() }
                    val stepPx = if (widthPx > 0f && columnCount > 0) {
                        (widthPx + gapPx) / columnCount.toFloat()
                    } else {
                        0f
                    }
                    val cellSizePx = (stepPx - gapPx).coerceAtLeast(1f)
                    val gridHeightDp = with(density) {
                        val totalHeightPx = if (stepPx > 0f) (cellSizePx * 7f + gapPx * 6f) else 96.dp.toPx()
                        totalHeightPx.toDp()
                    }

                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Canvas(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(gridHeightDp)
                                .pointerInput(cells, columnCount, widthPx) {
                                    detectTapGestures { offset ->
                                        if (columnCount <= 0 || widthPx <= 0f) return@detectTapGestures
                                        val step = (widthPx + gapPx) / columnCount.toFloat()
                                        if (step <= 0f) return@detectTapGestures
                                        val col = (offset.x / step).toInt()
                                        val row = (offset.y / step).toInt()
                                        val hit = cells.firstOrNull { it.col == col && it.row == row }
                                        if (hit != null) {
                                            onSelectDay(hit.day)
                                        }
                                    }
                                }
                                .testTag("usage-heatmap-canvas"),
                        ) {
                            if (columnCount <= 0) return@Canvas
                            val step = (size.width + gapPx) / columnCount.toFloat()
                            val cell = (step - gapPx).coerceAtLeast(2f)
                            val radius = (cell * 0.25f).coerceAtMost(4.dp.toPx())
                            cells.forEach { entry ->
                                val left = entry.col * step
                                val top = entry.row * step
                                val level = heatmapLevelFor(entry.totalTokens, maxTokens)
                                drawRoundRect(
                                    color = ramp[level],
                                    topLeft = Offset(left, top),
                                    size = Size(cell, cell),
                                    cornerRadius = CornerRadius(radius, radius),
                                )
                                if (entry.day == selectedDay) {
                                    drawRoundRect(
                                        color = selectedStroke,
                                        topLeft = Offset(left, top),
                                        size = Size(cell, cell),
                                        cornerRadius = CornerRadius(radius, radius),
                                        style = Stroke(width = 1.6.dp.toPx()),
                                    )
                                }
                            }
                        }

                        if (monthLabels.isNotEmpty() && widthPx > 0f && columnCount > 0) {
                            val step = (widthPx + gapPx) / columnCount.toFloat()
                            Box(Modifier.fillMaxWidth().height(16.dp)) {
                                monthLabels.forEach { label ->
                                    val xDp = with(density) { (label.col * step).coerceAtLeast(0f).toDp() }
                                    Text(
                                        text = stringResource(R.string.usage_month_label, label.month),
                                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                                        color = colors.secondaryContent,
                                        modifier = Modifier
                                            .align(Alignment.CenterStart)
                                            .padding(start = xDp),
                                        maxLines = 1,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun UsageHourlyCard(
    dateKey: String,
    buckets: List<UsageHourlyBucketUi>,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val barColor = if (isDark) Color(0xFF8E9CF5) else Color(0xFF6F72DA)
    val zeroBarColor = if (isDark) Color(0xFF34343D) else Color(0xFFE7E7EE)
    val maxTokens = remember(buckets) { buckets.maxOfOrNull { it.totalTokens } ?: 0L }
    val dayTotal = remember(buckets) { buckets.sumOf { it.totalTokens } }

    SettingsContentCard(Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(RagentSpacing.Standard),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = stringResource(
                        R.string.usage_hourly_title,
                        formatMonthDay(dateKey).ifBlank { "--" },
                    ),
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.primaryContent,
                )
                Text(
                    text = formatCompactTokens(dayTotal),
                    style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Medium),
                    color = colors.secondaryContent,
                )
            }

            Canvas(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(104.dp)
                    .testTag("usage-hourly-canvas"),
            ) {
                val count = 24
                val gap = 4.dp.toPx()
                val barWidth = ((size.width - gap * (count - 1)) / count.toFloat()).coerceAtLeast(2f)
                val minBarHeight = 2.5.dp.toPx()
                val corner = (barWidth / 2f).coerceAtMost(5.dp.toPx())
                for (hour in 0 until count) {
                    val tokens = buckets.getOrNull(hour)?.totalTokens ?: 0L
                    val left = hour * (barWidth + gap)
                    if (tokens <= 0L || maxTokens <= 0L) {
                        drawRoundRect(
                            color = zeroBarColor,
                            topLeft = Offset(left, size.height - minBarHeight),
                            size = Size(barWidth, minBarHeight),
                            cornerRadius = CornerRadius(corner, corner),
                        )
                    } else {
                        val ratio = (tokens.toDouble() / maxTokens.toDouble()).toFloat().coerceIn(0f, 1f)
                        val barHeight = (size.height * ratio).coerceAtLeast(6.dp.toPx())
                        drawRoundRect(
                            color = barColor,
                            topLeft = Offset(left, size.height - barHeight),
                            size = Size(barWidth, barHeight),
                            cornerRadius = CornerRadius(corner, corner),
                        )
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                listOf(0, 3, 6, 9, 12, 15, 18, 21).forEach { tick ->
                    Text(
                        text = tick.toString(),
                        style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp),
                        color = colors.secondaryContent,
                    )
                }
            }
        }
    }
}

@Composable
private fun UsageWindowSelector(
    selectedDays: Int,
    onSelectDays: (Int) -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val chipBg = if (isDark) colors.surfaceHighest else colors.surfaceLow
    val activeBg = if (isDark) Color(0xFF232C48) else Color(0xFFEDF0FD)
    val activeText = if (isDark) Color(0xFF8EA8FF) else Color(0xFF536AC2)
    val options = listOf(7, 30, 90, 180)

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        options.forEach { days ->
            val selected = selectedDays == days
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (selected) activeBg else chipBg)
                    .clickable { onSelectDays(days) }
                    .padding(vertical = 8.dp)
                    .testTag("usage-window-$days"),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(R.string.usage_window_days, days),
                    style = MaterialTheme.typography.labelMedium.copy(
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                    ),
                    color = if (selected) activeText else colors.secondaryContent,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun UsageKpiGrid(totals: UsageTotalsUi) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            UsageKpiTile(
                label = stringResource(R.string.usage_kpi_total),
                value = formatCompactTokens(totals.totalTokens),
                modifier = Modifier.weight(1f),
            )
            UsageKpiTile(
                label = stringResource(R.string.usage_kpi_gross_input),
                value = formatCompactTokens(totals.grossInputTokens),
                modifier = Modifier.weight(1f),
            )
            UsageKpiTile(
                label = stringResource(R.string.usage_kpi_new_input),
                value = formatCompactTokens(totals.newInputTokens),
                modifier = Modifier.weight(1f),
            )
            UsageKpiTile(
                label = stringResource(R.string.usage_kpi_cache_hit),
                value = formatCompactTokens(totals.cacheHitTokens),
                modifier = Modifier.weight(1f),
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            UsageKpiTile(
                label = stringResource(R.string.usage_kpi_cache_rate),
                value = formatCachePercent(totals.cacheHitShare),
                modifier = Modifier.weight(1f),
            )
            UsageKpiTile(
                label = stringResource(R.string.usage_kpi_output),
                value = formatCompactTokens(totals.outputTokens),
                modifier = Modifier.weight(1f),
            )
            UsageKpiTile(
                label = stringResource(R.string.usage_kpi_turns),
                value = formatWholeCount(totals.turns),
                modifier = Modifier.weight(1f),
            )
            UsageKpiTile(
                label = stringResource(R.string.usage_kpi_runs),
                value = formatWholeCount(totals.runs),
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun UsageKpiTile(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    SettingsContentCard(modifier) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.5.sp),
                color = colors.secondaryContent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
            Text(
                text = value,
                style = MaterialTheme.typography.titleSmall.copy(
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                ),
                color = colors.primaryContent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun UsageByProjectCard(
    items: List<UsageBreakdownItemUi>,
    totalProjectTokens: Long,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val palette = if (isDark) ChartPaletteDark else ChartPaletteLight
    val trackColor = if (isDark) Color(0xFF34343D) else Color(0xFFE7E7EE)
    val displayed = remember(items) { items.take(6) }

    SettingsContentCard(Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(RagentSpacing.Standard),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.usage_by_project),
                style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                color = colors.primaryContent,
            )

            if (items.isEmpty() || totalProjectTokens <= 0L) {
                Text(
                    text = stringResource(R.string.sp_usage_unavailable_detail),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.secondaryContent,
                )
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Box(
                        modifier = Modifier.size(104.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Canvas(Modifier.fillMaxSize()) {
                            val strokeWidth = 14.dp.toPx()
                            val inset = strokeWidth / 2f
                            val arcSize = Size(size.width - strokeWidth, size.height - strokeWidth)
                            val topLeft = Offset(inset, inset)
                            if (totalProjectTokens <= 0L) {
                                drawArc(
                                    color = trackColor,
                                    startAngle = 0f,
                                    sweepAngle = 360f,
                                    useCenter = false,
                                    topLeft = topLeft,
                                    size = arcSize,
                                    style = Stroke(width = strokeWidth),
                                )
                            } else {
                                val gapDeg = if (displayed.size > 1) 4f else 0f
                                var startAngle = -90f
                                displayed.forEachIndexed { idx, item ->
                                    val share = item.totalTokens.toFloat() / totalProjectTokens.toFloat()
                                    val rawSweep = share * 360f
                                    val sweep = (rawSweep - gapDeg).coerceAtLeast(2f)
                                    drawArc(
                                        color = palette[idx % palette.size],
                                        startAngle = startAngle,
                                        sweepAngle = sweep,
                                        useCenter = false,
                                        topLeft = topLeft,
                                        size = arcSize,
                                        style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
                                    )
                                    startAngle += rawSweep
                                }
                            }
                        }
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                text = stringResource(R.string.usage_project_total),
                                style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp),
                                color = colors.secondaryContent,
                                maxLines = 1,
                            )
                            Text(
                                text = formatCompactTokens(totalProjectTokens),
                                style = MaterialTheme.typography.labelLarge.copy(
                                    fontWeight = FontWeight.SemiBold,
                                    fontSize = 13.sp,
                                ),
                                color = colors.primaryContent,
                                maxLines = 1,
                            )
                        }
                    }

                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        displayed.forEachIndexed { idx, item ->
                            val dotColor = palette[idx % palette.size]
                            val pct = if (totalProjectTokens > 0L) {
                                formatWholePercent(item.totalTokens.toDouble() / totalProjectTokens.toDouble())
                            } else {
                                "0%"
                            }
                            val displayName = if (item.isOther) {
                                stringResource(R.string.usage_other)
                            } else {
                                item.label
                            }
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Box(Modifier.size(7.dp).clip(CircleShape).background(dotColor))
                                Text(
                                    text = displayName,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = colors.primaryContent,
                                    modifier = Modifier.weight(1f),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    text = pct,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.secondaryContent,
                                )
                                Text(
                                    text = formatCompactTokens(item.totalTokens),
                                    style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Medium),
                                    color = colors.primaryContent,
                                    maxLines = 1,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun UsageBreakdownListCard(
    title: String,
    items: List<UsageBreakdownItemUi>,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val palette = if (isDark) ChartPaletteDark else ChartPaletteLight
    val displayed = remember(items) { items.take(8) }

    SettingsContentCard(Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(RagentSpacing.Standard),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                color = colors.primaryContent,
            )

            if (displayed.isEmpty()) {
                Text(
                    text = stringResource(R.string.sp_usage_unavailable_detail),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.secondaryContent,
                )
            } else {
                displayed.forEachIndexed { idx, item ->
                    val dotColor = palette[idx % palette.size]
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Box(Modifier.size(7.dp).clip(CircleShape).background(dotColor))
                        Text(
                            text = item.label,
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.primaryContent,
                            modifier = Modifier.weight(1f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        item.cachedInputShare?.let { share ->
                            Text(
                                text = stringResource(R.string.usage_cache_badge, formatWholePercent(share)),
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.secondaryContent,
                            )
                        }
                        Text(
                            text = formatCompactTokens(item.totalTokens),
                            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                            color = colors.primaryContent,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}

private fun JsonElement.asStringOrNull(): String? =
    (this as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

private fun JsonElement.asLongOrNull(): Long? =
    (this as? kotlinx.serialization.json.JsonPrimitive)?.longOrNull

private fun JsonElement.asDoubleOrNull(): Double? =
    (this as? kotlinx.serialization.json.JsonPrimitive)?.doubleOrNull
