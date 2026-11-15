package com.andysagent.ragent.core.appapi

import org.junit.Test
import kotlin.test.*

class CallerGrantContractsTest {
    private val identity = InstalledCallerIdentity("example.client", 10100, 99, setOf("a".repeat(64), "b".repeat(64)))
    private fun row() = PersistedCallerGrant("00000000-0000-0000-0000-000000000000", identity,
        CallerGrant(identity.binding, setOf(CapabilityRegistry.TASKS_GET), setOf("pc"), 1000, sessionIds = setOf("session")),
        "account", 100, 100)
    @Test fun bindingIsCanonicalForTheEntireSignerSet() {
        assertEquals(identity.binding, identity.copy(currentSignerSha256 = linkedSetOf("b".repeat(64), "a".repeat(64))).binding)
        assertNotEquals(identity.binding, identity.copy(currentSignerSha256 = setOf("a".repeat(64))).binding)
    }
    @Test fun packageUidReinstallAndCurrentSignerChangesNeverInheritBinding() {
        listOf(identity.copy(packageName = "example.other"), identity.copy(uid = 10101),
            identity.copy(firstInstalledAt = 100), identity.copy(currentSignerSha256 = setOf("c".repeat(64))))
            .forEach { assertNotEquals(identity.binding, it.binding) }
    }
    @Test fun malformedIdentityCannotBecomeAnOwnerBinding() {
        listOf(identity.copy(packageName = "ragent:internal-owner"), identity.copy(uid = 0),
            identity.copy(firstInstalledAt = 0), identity.copy(currentSignerSha256 = emptySet()),
            identity.copy(currentSignerSha256 = setOf("fake"))).forEach { assertFailsWith<IllegalArgumentException> { it.binding } }
    }
    @Test fun recordKeepsExactScopeAndRejectsForgedBinding() {
        validateGrantRecord(row())
        assertFailsWith<IllegalArgumentException> { validateGrantRecord(row().copy(grant = row().grant.copy(callerBinding = "owner"))) }
    }
    @Test fun lifetimeAndRevocationOrderingAreBounded() {
        val row = row()
        validateGrantRecord(row.copy(grant = row.grant.copy(expiresAt = row.createdAt + CALLER_GRANT_MAX_LIFETIME_MS)))
        assertFailsWith<IllegalArgumentException> { validateGrantRecord(row.copy(grant = row.grant.copy(expiresAt = row.createdAt))) }
        assertFailsWith<IllegalArgumentException> { validateGrantRecord(row.copy(grant = row.grant.copy(expiresAt = row.createdAt + CALLER_GRANT_MAX_LIFETIME_MS + 1))) }
        assertFailsWith<IllegalArgumentException> { validateGrantRecord(row.copy(revokedAt = 101)) }
    }
    @Test fun unknownVersionAndEmptyOrExcessiveScopeFailClosed() {
        assertFailsWith<IllegalArgumentException> { validateGrantRecord(row().copy(version = 2)) }
        assertFailsWith<IllegalArgumentException> { validateGrantRecord(row().copy(grant = row().grant.copy(targetIds = emptySet()))) }
        assertFailsWith<IllegalArgumentException> { validateGrantRecord(row().copy(grant = row().grant.copy(sessionIds = (1..257).map { "s$it" }.toSet()))) }
    }
}
