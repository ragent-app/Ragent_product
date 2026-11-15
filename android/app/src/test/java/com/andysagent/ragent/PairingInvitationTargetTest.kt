package com.andysagent.ragent

import com.andysagent.ragent.core.protocol.parsePairingUri
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class PairingInvitationTargetTest {
    @Test
    fun `endpointless v3 invitation preserves computer identity`() {
        val fingerprint = "a".repeat(64)
        val invitation = parsePairingUri(
            "ragent://pair?v=3&i=inst_target&t=rpi_fixture&x=2099-01-01T00%3A00%3A00Z" +
                "&p=target-public-key&f=$fingerprint",
        )

        val target = pairingTargetFromInvitation(invitation)

        assertNotNull(target)
        assertEquals("inst_target", target.instanceId)
        assertEquals("target-public-key", target.publicKey)
        assertEquals(fingerprint, target.keyFingerprint)
    }

    @Test
    fun `endpoint invitation does not create account rendezvous target`() {
        val invitation = parsePairingUri(
            "ragent://pair?v=3&i=inst_target&e=https%3A%2F%2Fexample.test" +
                "&t=rpi_fixture&x=2099-01-01T00%3A00%3A00Z",
        )

        assertNull(pairingTargetFromInvitation(invitation))
    }
}
