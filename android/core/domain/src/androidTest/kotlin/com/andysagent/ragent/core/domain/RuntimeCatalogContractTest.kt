package com.andysagent.ragent.core.domain

import com.andysagent.ragent.core.model.RuntimeCatalogStatus
import com.andysagent.ragent.core.protocol.RagentProtocol
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RuntimeCatalogContractTest {
    @Test
    fun parsesProviderScopedCatalogMetadataWithoutUpstreamErrorText() {
        val element = RagentProtocol.json.parseToJsonElement(
            """
            {
              "providerProfileId": "provider-a",
              "catalogVersion": "catalog-123",
              "fetchedAt": "2026-08-27T00:00:00.000Z",
              "expiresAt": 1787788800000,
              "source": "stale-cache",
              "status": "stale",
              "error": {"code": "upstream_timeout", "message": "redacted"},
              "models": [{"id": "gpt-5@provider-a"}]
            }
            """.trimIndent(),
        )

        val metadata = parseRuntimeCatalogMetadata(element)

        assertEquals(RuntimeCatalogStatus.Stale, metadata.status)
        assertEquals("provider-a", metadata.providerProfileId)
        assertEquals("catalog-123", metadata.catalogVersion)
        assertEquals("stale-cache", metadata.source)
        assertEquals("upstream_timeout", metadata.errorCode)
        assertEquals(1, metadata.modelCount)
    }

    @Test
    fun missingCatalogMetadataDerivesFreshOrUnavailableStateFromModelCount() {
        val fresh = parseRuntimeCatalogMetadata(null, "provider-a", fallbackModelCount = 2)
        val unavailable = parseRuntimeCatalogMetadata(null, "provider-b")

        assertEquals(RuntimeCatalogStatus.Fresh, fresh.status)
        assertEquals(2, fresh.modelCount)
        assertEquals(RuntimeCatalogStatus.Unavailable, unavailable.status)
        assertEquals("provider-b", unavailable.providerProfileId)
        assertNull(unavailable.catalogVersion)
    }

    @Test
    fun malformedOptionalMetadataDoesNotBreakCatalogProjection() {
        val element = RagentProtocol.json.parseToJsonElement(
            """
            {
              "providerProfileId": "provider-a",
              "status": "fresh",
              "models": "not-an-array",
              "expiresAt": {"value": 1},
              "error": "upstream text must not be parsed as an object"
            }
            """.trimIndent(),
        )

        val metadata = parseRuntimeCatalogMetadata(element, fallbackModelCount = 3)

        assertEquals(RuntimeCatalogStatus.Fresh, metadata.status)
        assertEquals(3, metadata.modelCount)
        assertNull(metadata.expiresAt)
        assertNull(metadata.errorCode)

        val empty = parseRuntimeCatalogMetadata(
            RagentProtocol.json.parseToJsonElement("""{"status":"fresh","models":[]}"""),
        )
        assertEquals(RuntimeCatalogStatus.Empty, empty.status)
        assertEquals(0, empty.modelCount)
    }
}
