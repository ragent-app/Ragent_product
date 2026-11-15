package com.andysagent.ragent.core.agentui

import kotlin.math.exp
import kotlin.math.floor

/**
 * Display-clock pacing for live assistant text.
 *
 * Provider deltas are a target, not a paint instruction. This clock advances
 * the presented grapheme count with a bounded, smoothly changing rate so a
 * burst cannot replace the whole Markdown frontier in one composition frame.
 */
internal class StreamingPresentationClock(
    private val baseRatePerSecond: Float = 60f,
    private val maxRatePerSecond: Float = 360f,
    private val maxAdvancePerFrame: Int = 6,
) {
    private var ratePerSecond = baseRatePerSecond
    private var revealBudget = 0f

    fun reset() {
        ratePerSecond = baseRatePerSecond
        revealBudget = 0f
    }

    fun advance(currentCount: Int, targetCount: Int, elapsedMs: Long): Int {
        if (targetCount <= 0) return 0
        // A transient target replacement must not make already-painted text
        // disappear. The caller will receive the next monotonic target and
        // continue from this frontier.
        if (targetCount < currentCount) return currentCount
        val boundedCurrent = currentCount.coerceAtLeast(0)
        val backlog = targetCount - boundedCurrent
        if (backlog == 0) return boundedCurrent

        // The first frame is an intentional one-grapheme handshake. It makes
        // a newly started response feel alive without revealing a whole burst.
        if (elapsedMs <= 0L) return boundedCurrent + 1

        val elapsed = elapsedMs.coerceIn(1L, 120L).toFloat()
        val desiredRate = (baseRatePerSecond + backlog * 1.2f)
            .coerceAtMost(maxRatePerSecond)
        val timeConstant = if (desiredRate >= ratePerSecond) 220f else 480f
        val blend = (1f - exp(-elapsed / timeConstant)).coerceIn(0f, 1f)
        ratePerSecond += (desiredRate - ratePerSecond) * blend
        revealBudget += ratePerSecond * elapsed / 1000f

        val byBudget = floor(revealBudget).toInt()
        val advance = byBudget.coerceAtLeast(1).coerceAtMost(
            minOf(backlog, maxAdvancePerFrame),
        )
        revealBudget = (revealBudget - advance).coerceAtLeast(0f)
        return boundedCurrent + advance
    }
}
