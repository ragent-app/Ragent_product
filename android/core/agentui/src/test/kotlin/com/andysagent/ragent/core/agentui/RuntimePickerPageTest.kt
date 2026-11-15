package com.andysagent.ragent.core.agentui

import com.andysagent.ragent.core.model.RuntimeCatalog
import com.andysagent.ragent.core.model.RuntimeModelOption
import com.andysagent.ragent.core.model.RuntimeProviderOption
import com.andysagent.ragent.core.model.RuntimeToolOption
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.ObjectInputStream
import java.io.ObjectOutputStream
import org.junit.Assert.*
import org.junit.Test

class RuntimePickerPageTest {
    private val strings = RuntimePickerStrings("Runtime", "Provider", "Model", "Back runtime", "Back provider", "No providers", "No models", "Loading")
    private val catalog = RuntimeCatalog(listOf(
        RuntimeToolOption("tool", "Tool", providers = listOf(RuntimeProviderOption("a", "Account A"), RuntimeProviderOption("b", "Account B")),
            models = listOf(RuntimeModelOption("m-a", "Model A", "a"), RuntimeModelOption("m-b", "Model B", "b"))),
        RuntimeToolOption("direct", "Direct", models = listOf(RuntimeModelOption("direct-model", "Direct model"))),
    ))
    private fun page(level: RuntimePickerLevel, tool: String = "tool", provider: String? = "a", model: String? = "m-a",
        loading: Boolean = false, error: String? = null, source: RuntimeCatalog = catalog) =
        runtimePickerPage(level, source, tool, provider, model, "Tool · Model A", strings, loading, error)

    @Test fun `only model leaves have a selected state`() {
        assertTrue(page(RuntimePickerLevel.Tools).choices.none { it.selected })
        assertTrue(page(RuntimePickerLevel.Providers).choices.none { it.selected })
        assertEquals(listOf(RuntimePickerChoice("m-a", "Model A", selected = true)), page(RuntimePickerLevel.Models).choices)
        assertFalse(page(RuntimePickerLevel.Models, provider = "b").choices.single().selected)
    }

    @Test fun `each route owns its title context and model list`() {
        val outgoing = page(RuntimePickerLevel.Models)
        val next = page(RuntimePickerLevel.Models, provider = "b", model = null)
        assertEquals("Tool · Account A", outgoing.context)
        assertEquals(listOf("Model A"), outgoing.choices.map { it.label })
        assertEquals("Tool · Account B", next.context)
        assertEquals(listOf("Model B"), next.choices.map { it.label })
        assertNotEquals(outgoing.route, next.route)
        assertEquals(page(RuntimePickerLevel.Tools).route, page(RuntimePickerLevel.Tools, tool = "direct").route)
    }

    @Test fun `page is a copied presentation snapshot not a mutable catalog view`() {
        val models = mutableListOf(RuntimeModelOption("before", "Before", "a"))
        val source = RuntimeCatalog(listOf(catalog.tools.first().copy(models = models)))
        val outgoing = page(RuntimePickerLevel.Models, source = source)
        models.clear()
        models += RuntimeModelOption("after", "After", "a")
        assertEquals(listOf("Before"), outgoing.choices.map { it.label })
        assertEquals(listOf("After"), page(RuntimePickerLevel.Models, source = source).choices.map { it.label })
    }

    @Test fun `async content updates do not create another navigation route`() {
        val loaded = page(RuntimePickerLevel.Models)
        val pending = page(RuntimePickerLevel.Models, loading = true)
        val failed = page(RuntimePickerLevel.Models, error = "Offline")
        assertEquals(loaded.route, pending.route)
        assertEquals(loaded.route, failed.route)
        assertTrue(pending.choices.isEmpty())
        assertEquals("Loading", pending.status)
        assertFalse(pending.statusIsError)
        assertEquals("Offline", failed.status)
        assertTrue(failed.statusIsError)
    }

    @Test fun `provider-backed empty catalog still returns to provider layer`() {
        val source = RuntimeCatalog(listOf(catalog.tools.first().copy(providers = emptyList(), models = emptyList(), providerSelectionRequired = true)))
        assertEquals("No providers", page(RuntimePickerLevel.Providers, source = source).status)
        assertEquals(RuntimePickerLevel.Providers, page(RuntimePickerLevel.Models, source = source).navigateUp)
        assertEquals("Back provider", page(RuntimePickerLevel.Models, source = source).navigateUpDescription)
    }

    @Test fun `provider-less model layer returns directly to runtime`() {
        val result = page(RuntimePickerLevel.Models, tool = "direct", provider = null, model = null)
        assertEquals(RuntimePickerLevel.Tools, result.navigateUp)
        assertEquals("Direct", result.context)
        assertEquals(listOf("Direct model"), result.choices.map { it.label })
    }

    @Test fun `scroll identity survives Bundle-compatible serialization without delimiter collisions`() {
        val route = RuntimePickerRoute(RuntimePickerLevel.Models, "tool:account", "provider")
        assertNotEquals(route, RuntimePickerRoute(RuntimePickerLevel.Models, "tool", "account:provider"))
        val buffer = ByteArrayOutputStream()
        ObjectOutputStream(buffer).use { it.writeObject(route) }
        val restored = ObjectInputStream(ByteArrayInputStream(buffer.toByteArray())).use { it.readObject() }
        assertEquals(route, restored)
    }
}
