package com.andysagent.ragent.core.appapi

import org.junit.Test
import kotlin.test.*

class CallerConsentContractsTest {
    private val identity = InstalledCallerIdentity("example.agent", 10011, 1, setOf("a".repeat(64)))
    private val request = CallerConsentRequest(setOf(CapabilityRegistry.TARGETS_LIST, CapabilityRegistry.TASKS_COMMIT),
        setOf("pc-a", "pc-b"), setOf("session"), setOf("project"), true, 1000)
    @Test fun narrowedConsentRetainsResourceScopeAndNeverWidensPermission() {
        val grant = request.narrow(identity, setOf(CapabilityRegistry.TARGETS_LIST), setOf("pc-b"), false, 500, 100)
        assertEquals(setOf("pc-b"), grant.targetIds); assertFalse(grant.mayCreateSessions)
        assertEquals(request.sessionIds, grant.sessionIds); assertEquals(request.projectIds, grant.projectIds)
        assertEquals(600L, grant.expiresAt); assertEquals(identity.binding, grant.callerBinding)
        assertFailsWith<IllegalArgumentException> { request.narrow(identity, setOf("unknown"), setOf("pc-b"), false, 500, 100) }
        assertFailsWith<IllegalArgumentException> { request.narrow(identity, request.capabilityIds, setOf("pc-other"), false, 500, 100) }
        assertFailsWith<IllegalArgumentException> { request.narrow(identity, request.capabilityIds, request.targetIds, false, 1001, 100) }
        assertFailsWith<IllegalArgumentException> { request.copy(mayCreateSessions = false).narrow(identity, request.capabilityIds, request.targetIds, true, 500, 100) }
    }
    @Test fun unsupportedVersionsOversizedInputAndForgedIdentityFieldsAreRejected() {
        assertFails { request.copy(version = 2).validate() }
        assertFails { request.copy(targetIds = setOf("pc\nother")).validate() }
        assertFails { request.copy(targetIds = (1..17).map { "pc-$it" }.toSet()).validate() }
        assertFails { request.copy(lifetimeMs = CALLER_GRANT_MAX_LIFETIME_MS + 1).validate() }
        assertFails { CallerConsentContract.decode(" ".repeat(CallerConsentContract.MAX_REQUEST_BYTES + 1)) }
        assertFails { CallerConsentContract.decode("""{"capabilityIds":["ragent.targets.list"],"targetIds":["pc-a"],"callerBinding":"owner"}""") }
        assertFails { request.narrow(identity, emptySet(), request.targetIds, false, 1, 0) }
        assertFails { request.narrow(identity, request.capabilityIds, emptySet(), false, 1, 0) }
    }
    @Test fun firstClientCanRequestOwnerSelectionWithoutKnowingPairedComputerIds() {
        val choice = request.copy(targetIds = emptySet())
        choice.validate()
        assertEquals(setOf("chosen"), choice.narrow(identity, choice.capabilityIds, setOf("chosen"), false, 500, 100).targetIds)
        assertFails { choice.narrow(identity, choice.capabilityIds, (1..17).map { "pc-$it" }.toSet(), false, 500, 100) }
    }
}
