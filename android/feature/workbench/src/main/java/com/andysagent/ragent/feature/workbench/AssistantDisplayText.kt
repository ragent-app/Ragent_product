package com.andysagent.ragent.feature.workbench

/** Machine envelopes stay out of both completed and token-by-token rendering. */
internal fun displayAgentMessageText(text: String): String {
    val tags = listOf("session-labels", "organization-proposal", "collaboration-plan", "result-packet")
    var visible = text
    while (true) {
        val next = tags.mapNotNull { tag ->
            visible.indexOf("<ragent-$tag", ignoreCase = true).takeIf { it >= 0 }?.let { it to tag }
        }.minByOrNull { it.first } ?: break
        val endMarker = "</ragent-${next.second}>"
        val closing = visible.indexOf(endMarker, next.first, ignoreCase = true)
        visible = if (closing < 0) visible.substring(0, next.first)
            else visible.removeRange(next.first, closing + endMarker.length)
    }
    for (tag in tags) visible = visible.replace("</ragent-$tag>", "", ignoreCase = true)
    // A live chunk can end partway through a start marker. Do not flash it.
    val opening = visible.lastIndexOf('<')
    if (opening >= 0) {
        val tail = visible.substring(opening)
        if (tags.any { "<ragent-$it>".startsWith(tail, ignoreCase = true) }) visible = visible.substring(0, opening)
    }
    return visible.trimEnd()
}
