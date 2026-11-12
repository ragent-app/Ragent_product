package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.model.RuntimeCatalog
import com.andysagent.agentoc.core.model.RuntimeToolOption
import com.andysagent.agentoc.core.model.RuntimeModelOption
import com.andysagent.agentoc.feature.workbench.accounts.GoogleAccountStatus
import com.andysagent.agentoc.feature.workbench.accounts.GoogleAccountUiState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

class DemoEnvironmentTest {
    @Test fun `full reviewer mode keeps automatic demo identity without restricted catalog`() {
        val active = GoogleAccountUiState(accountId = "acct_demo_" + "a".repeat(48),
            accountSessionResolved = true, status = GoogleAccountStatus.SignedIn, demoAccessMode = "full")
        assertTrue(active.isDemoAccount)
        assertFalse(active.isRestrictedDemoAccount)
        val catalog = RuntimeCatalog(tools = listOf(RuntimeToolOption("claude", "Claude")))
        assertSame(catalog, restrictDemoRuntimeCatalog(catalog, active.isRestrictedDemoAccount))
        assertFalse(active.copy(demoAccessMode = "unknown").isRestrictedDemoAccount)
        assertFalse(active.copy(accountSessionResolved = false).isDemoAccount)
        assertFalse(active.copy(accountId = "acct_google_fixture").isDemoAccount)
    }

    @Test fun `account provider does not select a restricted environment`() {
        val account = GoogleAccountUiState(accountId = "acct_demo_" + "a".repeat(48))
        assertFalse(account.isRestrictedDemoAccount)
        val active = account.copy(accountSessionResolved = true, status = GoogleAccountStatus.SignedIn)
        assertFalse(active.isRestrictedDemoAccount)
        assertFalse(active.copy(accountId = "acct_google_fixture").isRestrictedDemoAccount)
        assertFalse(active.copy(accountId = "acct_demo_invalid").isRestrictedDemoAccount)
    }

    @Test fun `demo filters stale catalogs without manufacturing available models`() {
        val value = RuntimeCatalog(tools = listOf(
            RuntimeToolOption("codex", "Codex", models = listOf(RuntimeModelOption("gpt-5.6-luna@demo", "Luna"), RuntimeModelOption("gpt-6-astra", "Astra"))),
            RuntimeToolOption("claude", "Claude"),
        ))
        assertSame(value, restrictDemoRuntimeCatalog(value, false))
        val demo = restrictDemoRuntimeCatalog(value, true)
        assertEquals(listOf("codex"), demo.tools.map { it.id })
        assertEquals(listOf("gpt-5.6-luna@demo"), demo.tools.single().models.map { it.id })
        assertEquals(2, value.tools.size)
        assertTrue(restrictDemoRuntimeCatalog(RuntimeCatalog(), true).tools.isEmpty())
    }

    @Test fun `demo hides unavailable harnesses and nonofficial providers while Google stays unchanged`() {
        val value = WebParityUiState(
            harnesses = listOf(WebHarness("codex", "Codex", installed = true), WebHarness("claude", "Claude", installed = true)),
            providers = listOf(WebProvider("official", "Demo", "", true, authType = "oauth"), WebProvider("gateway", "Gateway", "", true)),
            availableTools = listOf("codex", "claude"),
        )
        assertSame(value, restrictDemoParityState(value, false))
        val demo = restrictDemoParityState(value, true)
        assertEquals(listOf("codex"), demo.harnesses.map { it.id })
        assertEquals(listOf("official"), demo.providers.map { it.id })
        assertEquals(listOf("codex"), demo.availableTools)
        assertTrue(restrictDemoParityState(value.copy(harnesses = listOf(WebHarness("codex", "Codex"))), true).harnesses.isEmpty())
    }
}
