package com.andysagent.ragent.core.agentui

import androidx.compose.runtime.Immutable
import com.andysagent.ragent.core.model.RuntimeCatalog

/** Committed presentation, independent of the picker's temporary navigation path.
 * Metadata is retained for display only; it never adds choices to a live catalog.
 */
@Immutable
data class ComposerRuntimeIdentity(
    val toolId: String,
    val providerId: String?,
    val modelId: String?,
    val toolLabel: String,
    val modelLabel: String?,
    val supportsFast: Boolean,
) {
    fun matches(tool: String, provider: String?, model: String?) =
        toolId == tool && providerId == provider && modelId == model

    val description: String get() = listOfNotNull(toolLabel, modelLabel).joinToString(" · ")
    val label: String get() = modelLabel ?: description
}

fun composerRuntimeIdentity(
    catalog: RuntimeCatalog,
    toolId: String,
    providerId: String?,
    modelId: String?,
    previous: ComposerRuntimeIdentity? = null,
): ComposerRuntimeIdentity {
    val retained = previous?.takeIf { it.matches(toolId, providerId, modelId) }
    val tool = catalog.tools.firstOrNull { it.id == toolId }
    val model = tool?.models?.firstOrNull { it.id == modelId && it.provider == providerId }
    return ComposerRuntimeIdentity(
        toolId, providerId, modelId,
        tool?.label ?: retained?.toolLabel ?: if (toolId.equals("codex", true)) "Codex" else toolId,
        model?.label?.takeIf { it.isNotBlank() } ?: retained?.modelLabel,
        model?.supportsFast ?: retained?.supportsFast ?: false,
    )
}
