package com.andysagent.ragent.core.datastore

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext

/** Keep DataStore creation (including its worker startup) off the UI thread. */
internal class IoPreferencesStore(
    private val store: () -> DataStore<Preferences>,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    // Cold, not a second cache: DataStore still owns persistence, consistency,
    // failures and the singleton. Merely constructing a config facade is cheap.
    val data: Flow<Preferences> = flow { emitAll(store().data) }.flowOn(dispatcher)

    suspend fun edit(transform: suspend (MutablePreferences) -> Unit): Preferences =
        withContext(dispatcher) { store().edit(transform) }
}
