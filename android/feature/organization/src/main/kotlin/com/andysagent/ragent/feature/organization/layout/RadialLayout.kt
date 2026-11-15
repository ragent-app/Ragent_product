package com.andysagent.ragent.feature.organization.layout

import kotlin.math.cos
import kotlin.math.sin

object RadialLayout {

    /**
     * Calculates positions in a downward fan/arc (e.g. 130° to 160° total angle).
     * @param centerX center X of the radial source (Root)
     * @param centerY center Y of the radial source (Root)
     * @param radius distance from source
     * @param count number of items to distribute
     * @param arcDegrees total span of the fan (default 140 degrees)
     * @param startAngleDegrees center downward is 90 degrees
     */
    fun calculateFanPositions(
        centerX: Float,
        centerY: Float,
        radius: Float,
        count: Int,
        arcDegrees: Float = 140f,
        centerAngleDegrees: Float = 90f,
    ): List<EdgePoint> {
        if (count <= 0) return emptyList()
        if (count == 1) {
            val rad = Math.toRadians(centerAngleDegrees.toDouble())
            return listOf(EdgePoint(centerX + (radius * cos(rad)).toFloat(), centerY + (radius * sin(rad)).toFloat()))
        }

        val startAngle = centerAngleDegrees - (arcDegrees / 2f)
        val step = arcDegrees / (count - 1)

        return (0 until count).map { i ->
            val angleDeg = startAngle + (i * step)
            val rad = Math.toRadians(angleDeg.toDouble())
            val x = centerX + (radius * cos(rad)).toFloat()
            val y = centerY + (radius * sin(rad)).toFloat()
            EdgePoint(x, y)
        }
    }
}
