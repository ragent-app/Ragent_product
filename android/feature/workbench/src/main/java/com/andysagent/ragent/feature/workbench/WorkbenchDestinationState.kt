package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.ReusableContent
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.LocalSaveableStateRegistry
import androidx.compose.runtime.saveable.SaveableStateRegistry
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.lazy.LazyListState

internal const val DestinationStatePrefix = "workbench:"
internal const val DestinationVisitIdentity = "__workbench_visit__"

/** Keep implicit keys only for the same restored visit, not each new tab visit. */
internal fun destinationVisitSeed(values: Map<String, List<Any?>>?, visitId: String): Map<String, List<Any?>>? {
    if (values == null) return null
    val sameVisit = values[DestinationVisitIdentity]?.firstOrNull() == visitId
    return values.filterKeys { it != DestinationVisitIdentity && (sameVisit || it.startsWith(DestinationStatePrefix)) }
}

/**
 * Each navigation visit has its own registry, while tabs retain their latest
 * saved UI state. Two visits to Home can coexist during a rapid reversal:
 * they must not mount the same SaveableStateHolder key or share a live list
 * state. A new visit seeds from the latest live/saved registry for that tab.
 */
internal class WorkbenchDestinationState(
    private val saved: MutableMap<String, Map<String, List<Any?>>> = mutableMapOf(),
) {
    private val live = mutableMapOf<String, SaveableStateRegistry>()
    private val owner = mutableMapOf<String, String>()

    private fun snapshot(route: String): Map<String, List<Any?>>? =
        owner[route]?.let { id -> live[id]?.performSave()?.plus(DestinationVisitIdentity to listOf(id)) } ?: saved[route]

    private fun saveAll(): Map<String, Map<String, List<Any?>>> =
        saved.toMutableMap().apply { owner.keys.forEach { route -> snapshot(route)?.let { put(route, it) } } }

    @Composable
    fun Provider(route: String, visitId: String, active: Boolean, content: @Composable () -> Unit) {
        // The visit registry isolates concurrent copies. Portable page state
        // uses semantic keys: implicit Compose hashes include NavEntry identity.
        ReusableContent(route) {
            val parentRegistry = LocalSaveableStateRegistry.current
            val registry = remember(visitId) {
                SaveableStateRegistry(destinationVisitSeed(snapshot(route), visitId)) { parentRegistry?.canBeSaved(it) ?: true }
            }
            CompositionLocalProvider(LocalSaveableStateRegistry provides registry, content = content)
            SideEffect { if (active) owner[route] = visitId }
            // Effects are forgotten in reverse composition order. Snapshot
            // before the subtree unregisters its rememberSaveable providers.
            DisposableEffect(registry) {
                live[visitId] = registry
                onDispose {
                    // An older outgoing visit must not overwrite a newer visit.
                    if (owner[route] == visitId) {
                        saved[route] = registry.performSave() + (DestinationVisitIdentity to listOf(visitId))
                        owner.remove(route)
                    }
                    live.remove(visitId)
                }
            }
        }
    }

    companion object {
        val StateSaver = Saver<WorkbenchDestinationState, Map<String, Map<String, List<Any?>>>>(
            save = { it.saveAll() },
            restore = { WorkbenchDestinationState(it.toMutableMap()) },
        )
    }
}

@Composable
internal fun rememberWorkbenchDestinationState(): WorkbenchDestinationState =
    rememberSaveable(saver = WorkbenchDestinationState.StateSaver) { WorkbenchDestinationState() }

/** A new navigation visit must consume the same page-local scroll key. */
@Composable
internal fun rememberDestinationListState(key: String): LazyListState =
    rememberSaveable(key = DestinationStatePrefix + key, saver = LazyListState.Saver) { LazyListState() }

@Composable
internal fun rememberDestinationFlag(key: String, initial: Boolean = false): MutableState<Boolean> =
    rememberSaveable(key = DestinationStatePrefix + key) { mutableStateOf(initial) }
