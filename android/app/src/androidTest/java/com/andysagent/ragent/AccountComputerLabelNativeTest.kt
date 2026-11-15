package com.andysagent.ragent

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import androidx.test.core.app.ApplicationProvider
import com.andysagent.ragent.core.datastore.ClientConfigStore
import com.andysagent.ragent.core.datastore.LinkedComputer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AccountComputerLabelNativeTest {
    private class MemoryStore : DataStore<Preferences> {
        override val data = MutableStateFlow(emptyPreferences())
        private val mutex = Mutex()
        override suspend fun updateData(transform: suspend (Preferences) -> Preferences): Preferences =
            mutex.withLock { transform(data.value).also { data.value = it } }
    }

    @Test fun accountLabelsPreserveConnectionAndRoutingAndCannotRestoreRemovedTargets() = runBlocking {
        val config = ClientConfigStore.withStore(ApplicationProvider.getApplicationContext(), MemoryStore())
        config.upsertComputer(LinkedComputer("mac", "https://example.invalid/mac", "Android-phone",
            platform = "macos", autoConnect = false, lastSelectedAt = 123, lastSeenAt = 456), select = true)
        config.upsertComputer(LinkedComputer("windows", "", "Android-phone", platform = "windows"))
        config.setDefaultShareTarget("mac")
        config.setTargetAliases("mac", listOf("office"))
        val before = config.directory.first()
        config.refreshComputerLabels(mapOf("mac" to "Mac", "windows" to "MSI", "unpaired" to "Other PC"))
        val after = config.directory.first()
        assertEquals(before.activeTargetId, after.activeTargetId)
        assertEquals(before.appApiRouting, after.appApiRouting)
        assertEquals(before.computers.map { it.copy(label = if (it.instanceId == "mac") "Mac" else "MSI") }, after.computers)
        config.removeTarget("mac")
        val removed = config.directory.first()
        config.refreshComputerLabels(mapOf("mac" to "Mac", "windows" to ""))
        assertEquals(removed, config.directory.first())
        assertFalse(config.directory.first().computers.any { it.instanceId == "mac" })
    }
}
