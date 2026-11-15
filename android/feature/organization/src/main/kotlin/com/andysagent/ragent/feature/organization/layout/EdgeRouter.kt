package com.andysagent.ragent.feature.organization.layout

object EdgeRouter {

    fun routeEdge(
        edgeId: String,
        fromNodeId: String,
        toNodeId: String,
        from: EdgePoint,
        to: EdgePoint,
        alpha: Float = 1.0f,
    ): EdgePathModel {
        val dy = to.y - from.y
        val c1 = EdgePoint(from.x, from.y + dy * 0.45f)
        val c2 = EdgePoint(to.x, to.y - dy * 0.45f)
        return EdgePathModel(
            id = edgeId,
            fromNodeId = fromNodeId,
            toNodeId = toNodeId,
            start = from,
            end = to,
            control1 = c1,
            control2 = c2,
            isCurved = true,
            alpha = alpha,
        )
    }
}
