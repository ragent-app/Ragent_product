package com.andysagent.ragent.core.datastore

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlin.test.fail

class IoPreferencesStoreTest {
    private class MemoryStore : DataStore<Preferences> {
        override val data = MutableStateFlow(emptyPreferences())
        private val mutex = Mutex()
        override suspend fun updateData(transform: suspend (Preferences) -> Preferences): Preferences =
            mutex.withLock { transform(data.value).also { data.value = it } }
    }

    @Test fun constructionAndGettingFlowDoNotInitializeStorage() {
        var calls = 0
        val facade = IoPreferencesStore(store = { calls++; MemoryStore() })
        facade.data
        assertEquals(0, calls)
    }

    @Test fun firstReadInitializesOffTheCollectingThread() = runBlocking {
        val caller = Thread.currentThread().id
        var initializationThread = caller
        val facade = IoPreferencesStore(store = {
            initializationThread = Thread.currentThread().id
            MemoryStore()
        })
        assertEquals(emptyPreferences(), facade.data.first())
        assertNotEquals(caller, initializationThread)
    }

    @Test fun firstWriteAndTransformRunOffTheCallingThread() = runBlocking {
        val caller = Thread.currentThread().id
        var initializationThread = caller
        var transformThread = caller
        val backing = MemoryStore()
        val facade = IoPreferencesStore(store = {
            initializationThread = Thread.currentThread().id
            backing
        })
        val key = stringPreferencesKey("theme")
        facade.edit { transformThread = Thread.currentThread().id; it[key] = "dark" }
        assertNotEquals(caller, initializationThread)
        assertNotEquals(caller, transformThread)
        assertEquals("dark", facade.data.first()[key])
    }

    @Test fun concurrentEditsKeepDataStoreTransactionSemantics() = runBlocking {
        val backing = MemoryStore()
        val facade = IoPreferencesStore(store = { backing })
        val count = intPreferencesKey("count")
        val preserved = stringPreferencesKey("preserved")
        facade.edit { it[preserved] = "keep" }
        (1..40).map { async { facade.edit { it[count] = (it[count] ?: 0) + 1 } } }.awaitAll()
        val result = facade.data.first()
        assertEquals(40, result[count])
        assertEquals("keep", result[preserved])
    }

    @Test fun readFailureIsNotReplacedByEmptyPreferences() = runBlocking {
        val expected = IllegalStateException("Storage unavailable")
        val facade = IoPreferencesStore(store = { throw expected })
        try { facade.data.first(); fail("Failure was hidden") }
        catch (actual: IllegalStateException) {
            // Coroutine stack-trace recovery can wrap/copy the exception, but
            // the original failure must remain in the chain, never defaults.
            assertEquals(expected.message, actual.message)
            assertTrue(generateSequence<Throwable>(actual) { it.cause }.any { it === expected })
        }
    }

    @Test fun cancelledEditDoesNotCommitOrHideCancellation() = runBlocking {
        val backing = MemoryStore()
        val facade = IoPreferencesStore(store = { backing })
        val key = stringPreferencesKey("theme")
        try {
            facade.edit { it[key] = "dark"; throw CancellationException("Cancelled") }
            fail("Cancellation was hidden")
        } catch (_: CancellationException) { }
        assertEquals(null, facade.data.first()[key])
    }
}
