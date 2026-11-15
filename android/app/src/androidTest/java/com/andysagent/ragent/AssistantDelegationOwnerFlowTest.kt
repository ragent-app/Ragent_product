package com.andysagent.ragent

import android.content.Intent
import android.content.res.Configuration
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.datastore.LinkedComputer
import com.andysagent.ragent.core.model.AppLanguage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** Real owner Activity/ViewModel/port/Room. Uses one temporary nonconnecting computer. */
class AssistantDelegationOwnerFlowTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun explicitOwnerApprovalPersistsWhileRotationAndReopeningNeverApprove() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<RagentApplication>()
        val graph = app.runtime
        val id = "assistant-ui-${UUID.randomUUID()}"
        val label = "Synthetic assistant PC ${id.takeLast(8)}"
        graph.configStore.upsertComputer(LinkedComputer(id, "", label, autoConnect = false))
        graph.appApi.listTargets(graph.appApiOwner)
        val language = graph.configStore.appLanguage.first()
        val context = if (language == AppLanguage.System || language.tag.isBlank()) app else
            app.createConfigurationContext(Configuration(app.resources.configuration).apply { setLocale(Locale.forLanguageTag(language.tag)) })
        fun text(resource: Int) = context.getString(resource)
        val approve = text(com.andysagent.ragent.feature.appapi.R.string.api_assistant_approve)
        fun waitForReview() {
            // Room/DataStore loading runs outside Compose's idling resources.
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText(approve).fetchSemanticsNodes().size == 1
            }
        }
        suspend fun records() = graph.assistantDelegations.list(graph.appApiOwner).filter { id in it.scope.targetIds }
        val intent = Intent(app, AssistantDelegationActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            ActivityScenario.launch<AssistantDelegationActivity>(intent).use { scenario ->
                waitForReview()
                compose.onNodeWithText(approve).performScrollTo().assertIsNotEnabled()
                assertTrue(records().isEmpty())
                compose.onNodeWithContentDescription(text(com.andysagent.ragent.feature.appapi.R.string.api_access_cap_targets))
                    .performScrollTo().performClick()
                compose.onNodeWithContentDescription(label).performScrollTo().performClick()
                compose.onNodeWithText(approve).performScrollTo().assertIsNotEnabled()
                compose.onNodeWithContentDescription(text(com.andysagent.ragent.feature.appapi.R.string.api_assistant_acknowledge))
                    .performScrollTo().performClick()
                compose.onNodeWithText(approve).performScrollTo().assertIsEnabled()
                scenario.recreate()
                compose.waitForIdle()
                assertTrue(records().isEmpty())
                val focused = AtomicBoolean()
                compose.waitUntil(10_000) { scenario.onActivity { focused.set(it.hasWindowFocus()) }; focused.get() }
                compose.onNodeWithText(approve).performScrollTo().assertIsEnabled().performClick()
                compose.waitUntil(10_000) { runBlocking { records().size == 1 } }
                compose.onNodeWithText(approve).performScrollTo().assertIsNotEnabled()
                val row = records().single()
                assertEquals(setOf(CapabilityRegistry.TARGETS_LIST), row.scope.capabilityIds)
                assertEquals(setOf(id), row.scope.targetIds)
                assertFalse(row.scope.mayCreateSessions)
                assertNotEquals(graph.appApiOwner, row.caller)
                assertEquals(listOf(id), graph.assistantTasks.listComputers().items.filter { it.delegationId == row.id }.map { it.instanceId })
                scenario.recreate(); compose.waitForIdle()
                compose.onNodeWithText(approve).performScrollTo().assertIsNotEnabled()
                assertEquals(1, records().size)
            }
            ActivityScenario.launch<AssistantDelegationActivity>(intent).use {
                waitForReview()
                compose.onNodeWithText(approve).performScrollTo().assertIsNotEnabled()
                assertEquals(1, records().size)
            }
        } finally {
            assertTrue(id.startsWith("assistant-ui-"))
            graph.disconnectTarget(id)
            records().forEach { row ->
                assertNotNull(row.revokedAt)
                assertTrue(graph.assistantDelegations.deleteRevoked(graph.appApiOwner, row.id, row.revision))
            }
        }
    }
}
