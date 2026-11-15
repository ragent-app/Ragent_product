package com.andysagent.ragent.feature.workbench

/** Keep repeated file paths or tool steps distinct while preserving append stability. */
internal fun <T> runSheetOccurrenceKeys(items: List<T>, identity: (T) -> String): List<String> {
    val occurrences = mutableMapOf<String, Int>()
    return items.map { item ->
        val value = identity(item)
        val ordinal = occurrences.getOrDefault(value, 0)
        occurrences[value] = ordinal + 1
        "${value.length}:$value:$ordinal"
    }
}
