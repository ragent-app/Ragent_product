package com.andysagent.ragent.core.agentui

import com.andysagent.ragent.core.model.RuntimeCatalog
import com.andysagent.ragent.core.model.RuntimeModelOption
import com.andysagent.ragent.core.model.RuntimeToolOption
import org.junit.Assert.*
import org.junit.Test

class ComposerRuntimeIdentityTest {
    private val catalog = RuntimeCatalog(listOf(RuntimeToolOption("codex", "Codex", models = listOf(
        RuntimeModelOption("shared", "Personal model", "personal", true),
        RuntimeModelOption("shared", "Work model", "work", false),
    ))))

    @Test fun `lookup qualifies same model id by provider`() {
        val choice = composerRuntimeIdentity(catalog, "codex", "work", "shared")
        assertEquals("Work model", choice.label)
        assertFalse(choice.supportsFast)
        assertFalse(choice.matches("codex", "personal", "shared"))
        assertFalse(choice.matches("other", "work", "shared"))
        assertTrue(choice.matches("codex", "work", "shared"))
    }

    @Test fun `provider refresh cannot erase committed display or create a live choice`() {
        val choice = composerRuntimeIdentity(catalog, "codex", "personal", "shared")
        val replaced = catalog.copy(tools = catalog.tools.map { it.copy(models = it.models.filter { m -> m.provider == "work" }) })
        assertEquals(choice, composerRuntimeIdentity(replaced, "codex", "personal", "shared", choice))
        assertEquals(listOf("work"), replaced.tools.single().models.map { it.provider })
        assertEquals("Work model", composerRuntimeIdentity(replaced, "codex", "work", "shared", choice).label)
        assertEquals("Codex", composerRuntimeIdentity(replaced, "codex", null, null, choice).label)
    }

    @Test fun `closed presentation accepts fresh metadata only for its exact identity`() {
        val choice = composerRuntimeIdentity(catalog, "codex", "personal", "shared")
        val refreshed = catalog.copy(tools = listOf(catalog.tools.single().copy(models = listOf(
            RuntimeModelOption("shared", "Renamed personal", "personal", false),
        ))))
        val updated = composerRuntimeIdentity(refreshed, "codex", "personal", "shared", choice)
        assertEquals("Renamed personal", updated.label)
        assertFalse(updated.supportsFast)
    }

    @Test fun `leaf marker compares committed identity not browsing path or bare model id`() {
        val committed = composerRuntimeIdentity(catalog, "codex", "personal", "shared")
        val strings = RuntimePickerStrings("Runtime", "Provider", "Model", "Back", "Back", "Empty", "Empty", "Loading")
        fun page(provider: String, level: RuntimePickerLevel = RuntimePickerLevel.Models) = runtimePickerPage(
            level, catalog, "codex", provider, null, committed.description, strings, committedIdentity = committed,
        )
        assertTrue(page("personal").choices.single().selected)
        assertFalse(page("work").choices.single().selected)
        assertTrue(page("personal", RuntimePickerLevel.Tools).choices.none { it.selected })
        assertTrue(page("personal", RuntimePickerLevel.Providers).choices.none { it.selected })
    }
}
