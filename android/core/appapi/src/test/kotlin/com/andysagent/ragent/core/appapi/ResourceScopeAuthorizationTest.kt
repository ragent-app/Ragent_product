package com.andysagent.ragent.core.appapi

import kotlinx.coroutines.test.runTest
import kotlin.test.*

class ResourceScopeAuthorizationTest {
    private val caller = VerifiedCaller("external")
    private val cap = CapabilityRegistry.TASKS_COMMIT
    private fun grant() = CallerGrant(caller.binding, setOf(cap), setOf("pc"), 1000,
        sessionIds = setOf("session"), projectIds = setOf("project"), mayCreateSessions = true)
    @Test fun nullProjectNeverSatisfiesProjectRestriction() = runTest {
        val auth = GrantAuthorizer("owner", { listOf(grant()) }, { 1 })
        for (session in listOf("session", null)) {
            assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
                auth.require(caller, cap, "pc", session, null)
            }.error.code)
            auth.require(caller, cap, "pc", session, "project")
        }
    }
    @Test fun verificationPolicyNeverCombinesRightsFromSeparateGrants() = runTest {
        val auth = GrantAuthorizer("owner", { listOf(grant(), grant().copy(projectIds = null, sessionIds = setOf("other"), mayCreateSessions = false)) }, { 1 })
        assertTrue(auth.requiresProjectVerification(caller, cap, "pc", "session", null))
        assertTrue(auth.requiresProjectVerification(caller, cap, "pc", null, null))
        assertFalse(auth.requiresProjectVerification(caller, cap, "pc", "other", null))
    }
    @Test fun unrestrictedGrantStillVerifiesExplicitForeignProjectClaims() = runTest {
        val auth = GrantAuthorizer("owner", { listOf(grant().copy(projectIds = null)) }, { 1 })
        assertFalse(auth.requiresProjectVerification(caller, cap, "pc", "session", null))
        assertTrue(auth.requiresProjectVerification(caller, cap, "pc", "session", "project"))
        assertFalse(auth.requiresProjectVerification(VerifiedCaller("owner"), cap, "pc", "session", "project"))
    }
    @Test fun expiredOrRevokedRecordsCannotProvideUnrestrictedBypass() = runTest {
        var grants = listOf(grant().copy(projectIds = null, expiresAt = 2))
        val auth = GrantAuthorizer("owner", { grants }, { 2 })
        assertTrue(auth.requiresProjectVerification(caller, cap, "pc", "session", null))
        grants = emptyList()
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            auth.require(caller, cap, "pc", "session", "project")
        }.error.code)
    }
}
