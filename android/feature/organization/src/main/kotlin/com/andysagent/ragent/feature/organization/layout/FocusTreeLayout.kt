package com.andysagent.ragent.feature.organization.layout

import com.andysagent.ragent.feature.organization.domain.OrganizationNodeModel

object FocusTreeLayout {

    /**
     * Lays out children of a focused node in a clean horizontal or tiered grid.
     */
    fun layoutChildren(
        parentPoint: EdgePoint,
        children: List<OrganizationNodeModel>,
        verticalSpacing: Float = 130f,
        horizontalSpacing: Float = 100f,
    ): Map<String, EdgePoint> {
        if (children.isEmpty()) return emptyMap()

        val count = children.size
        val result = mutableMapOf<String, EdgePoint>()

        if (count <= 4) {
            val totalWidth = (count - 1) * horizontalSpacing
            val startX = parentPoint.x - (totalWidth / 2f)
            children.forEachIndexed { i, child ->
                result[child.id] = EdgePoint(startX + i * horizontalSpacing, parentPoint.y + verticalSpacing)
            }
        } else {
            // Two rows for 5-8 children
            val row1Count = (count + 1) / 2
            val row2Count = count - row1Count

            val row1Width = (row1Count - 1) * horizontalSpacing
            val row1StartX = parentPoint.x - (row1Width / 2f)
            for (i in 0 until row1Count) {
                val child = children[i]
                result[child.id] = EdgePoint(row1StartX + i * horizontalSpacing, parentPoint.y + verticalSpacing)
            }

            val row2Width = (row2Count - 1) * horizontalSpacing
            val row2StartX = parentPoint.x - (row2Width / 2f)
            for (i in 0 until row2Count) {
                val child = children[row1Count + i]
                result[child.id] = EdgePoint(row2StartX + i * horizontalSpacing, parentPoint.y + verticalSpacing * 1.8f)
            }
        }

        return result
    }
}
