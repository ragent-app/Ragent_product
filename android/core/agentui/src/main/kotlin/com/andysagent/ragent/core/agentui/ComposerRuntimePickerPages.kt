package com.andysagent.ragent.core.agentui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.LayoutDirection
import com.andysagent.ragent.core.designsystem.LocalMotionPolicy
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.model.RuntimeCatalog

internal enum class RuntimePickerLevel { Tools, Providers, Models }

/** Identity excludes live data: loading and catalog refresh stay on this page. */
internal data class RuntimePickerRoute(
    val level: RuntimePickerLevel,
    val tool: String? = null,
    val provider: String? = null,
) : java.io.Serializable

internal data class RuntimePickerChoice(
    val id: String,
    val label: String,
    val selected: Boolean = false,
    val disclosure: Boolean = false,
)

internal data class RuntimePickerStrings(
    val tools: String,
    val providers: String,
    val models: String,
    val returnToTools: String,
    val returnToProviders: String,
    val noProviders: String,
    val noModels: String,
    val loading: String,
)

/** The exiting page must never read the new route's mutable selection/catalog. */
internal data class ComposerRuntimePickerPage(
    val route: RuntimePickerRoute,
    val title: String,
    val context: String,
    val navigateUp: RuntimePickerLevel?,
    val navigateUpDescription: String?,
    val choices: List<RuntimePickerChoice>,
    val status: String? = null,
    val statusIsError: Boolean = false,
)

internal fun runtimePickerPage(
    level: RuntimePickerLevel,
    catalog: RuntimeCatalog,
    toolId: String,
    providerId: String?,
    modelId: String?,
    currentLabel: String,
    strings: RuntimePickerStrings,
    loading: Boolean = false,
    error: String? = null,
    committedIdentity: ComposerRuntimeIdentity = composerRuntimeIdentity(catalog, toolId, providerId, modelId),
): ComposerRuntimePickerPage {
    val tool = catalog.tools.firstOrNull { it.id == toolId }
    val up = when (level) {
        RuntimePickerLevel.Tools -> null
        RuntimePickerLevel.Providers -> RuntimePickerLevel.Tools
        RuntimePickerLevel.Models -> if (tool?.providerSelectionRequired == true) RuntimePickerLevel.Providers else RuntimePickerLevel.Tools
    }
    val choices = when (level) {
        RuntimePickerLevel.Tools -> catalog.tools.map { RuntimePickerChoice(it.id, it.label, disclosure = true) }
        RuntimePickerLevel.Providers -> tool?.providers.orEmpty().map { RuntimePickerChoice(it.id, it.label, disclosure = true) }
        RuntimePickerLevel.Models -> if (loading || !error.isNullOrBlank()) emptyList() else tool?.models.orEmpty()
            .filter { providerId.isNullOrBlank() || it.provider == providerId }
            .map { RuntimePickerChoice(it.id, it.label, selected = committedIdentity.matches(toolId, it.provider, it.id)) }
    }
    val status = when {
        level == RuntimePickerLevel.Providers && choices.isEmpty() -> strings.noProviders
        level != RuntimePickerLevel.Models -> null
        loading -> strings.loading
        !error.isNullOrBlank() -> error
        choices.isEmpty() -> strings.noModels
        else -> null
    }
    return ComposerRuntimePickerPage(
        route = RuntimePickerRoute(level, toolId.takeUnless { level == RuntimePickerLevel.Tools },
            providerId.takeIf { level == RuntimePickerLevel.Models }),
        title = when (level) { RuntimePickerLevel.Tools -> strings.tools; RuntimePickerLevel.Providers -> strings.providers; RuntimePickerLevel.Models -> strings.models },
        context = when (level) {
            RuntimePickerLevel.Tools -> currentLabel
            RuntimePickerLevel.Providers -> tool?.label ?: currentLabel
            RuntimePickerLevel.Models -> listOfNotNull(tool?.label, tool?.providers?.firstOrNull { it.id == providerId }?.label).joinToString(" · ")
        },
        navigateUp = up,
        navigateUpDescription = when (up) { RuntimePickerLevel.Tools -> strings.returnToTools; RuntimePickerLevel.Providers -> strings.returnToProviders; else -> null },
        choices = choices,
        status = status,
        statusIsError = level == RuntimePickerLevel.Models && !loading && !error.isNullOrBlank(),
    )
}

@Composable
internal fun ComposerRuntimePickerPages(
    page: ComposerRuntimePickerPage,
    onChoice: (RuntimePickerLevel, String) -> Unit,
    onNavigateUp: (RuntimePickerLevel) -> Unit,
    enabled: Boolean = true,
) {
    val duration = when (LocalMotionPolicy.current.preference) {
        MotionPreference.Full -> 280
        MotionPreference.Reduced -> 160
        MotionPreference.None -> 0
    }
    val direction = if (LocalLayoutDirection.current == LayoutDirection.Rtl) -1 else 1
    val savedPages = rememberSaveableStateHolder()
    AnimatedContent(
        targetState = page,
        contentKey = { it.route },
        transitionSpec = {
            val sign = direction * if (targetState.route.level.ordinal > initialState.route.level.ordinal) 1 else -1
            // Adjacent pages occupy disjoint horizontal regions. No stacked
            // readable-text crossfade; size and position use the same clock.
            (slideInHorizontally(tween(duration, easing = FastOutSlowInEasing)) { sign * it } togetherWith
                slideOutHorizontally(tween(duration, easing = FastOutSlowInEasing)) { -sign * it })
                .using(SizeTransform(clip = true) { _, _ -> tween(duration, easing = FastOutSlowInEasing) })
        },
        label = "composer_runtime_page",
    ) { snapshot ->
        val interactive = enabled && snapshot.route == page.route
        savedPages.SaveableStateProvider(snapshot.route) {
            ComposerPickerPageFrame(
                title = snapshot.title,
                supportingText = snapshot.context,
                onNavigateUp = snapshot.navigateUp?.let { parent -> ({ if (interactive) onNavigateUp(parent) }) },
                navigateUpDescription = snapshot.navigateUpDescription,
                modifier = if (interactive) Modifier.testTag("composer-picker-active-page")
                    else Modifier.clearAndSetSemantics { },
            ) {
                snapshot.status?.let { ComposerRuntimePickerStatus(it, snapshot.statusIsError) }
                snapshot.choices.forEach { choice ->
                    ComposerRuntimePickerOption(
                        label = choice.label,
                        selected = choice.selected,
                        disclosure = choice.disclosure,
                        onClick = { if (interactive) onChoice(snapshot.route.level, choice.id) },
                    )
                }
            }
        }
    }
}
