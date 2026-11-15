package com.andysagent.ragent.feature.workbench

internal data class RunContextPresentation(
    val primary: String?,
    val supporting: String?,
    val runId: String?,
    val phase: String?,
    val failure: String?,
) {
    val isEmpty: Boolean get() = primary == null && supporting == null && runId == null && phase == null && failure == null
}

/** Actual values only: model first, engine underneath, identifiers last. */
internal fun runContextPresentation(metrics: RunMetricsUiState): RunContextPresentation {
    fun String?.value() = this?.trim()?.takeIf(String::isNotEmpty)
    val engine = listOfNotNull(metrics.provider.value(), metrics.runtimeFamily.value()).distinct()
    val primary = metrics.model.value() ?: engine.firstOrNull()
    return RunContextPresentation(
        primary = primary,
        supporting = engine.filterNot { it == primary }.takeIf { it.isNotEmpty() }?.joinToString(" · "),
        runId = metrics.runId.value(), phase = metrics.phase.value(), failure = metrics.failureReason.value(),
    )
}
