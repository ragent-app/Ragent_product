package com.andysagent.ragent.core.appapi

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.junit.*
import org.junit.Assert.*
import java.util.UUID

class AssistantDelegationJournalTest {
    private lateinit var context: Context
    private lateinit var name: String
    private lateinit var db: AssistantDelegationDatabase
    private val owner = VerifiedCaller("owner")
    private var current = CallerGrantContext("account-a", setOf("pc-a", "pc-b"))
    private var time = 1000L
    private fun open() = Room.databaseBuilder(context, AssistantDelegationDatabase::class.java, name).build()
    private fun store() = RoomAssistantDelegationStore(db, owner, { current }, now = { time })
    private fun scope() = AssistantDelegationScope(AssistantTaskCapabilities.ids, setOf("pc-b"), 10_000,
        sessionIds = setOf("session-1"), projectIds = setOf("project-1"))
    private suspend fun rejects(code: ApiErrorCode = ApiErrorCode.PERMISSION_DENIED, action: suspend () -> Unit) {
        try { action(); fail("Expected $code") } catch (error: AppApiException) { assertEquals(code, error.error.code) }
    }
    @Before fun setup() {
        context = ApplicationProvider.getApplicationContext()
        name = "assistant-delegation-test-${UUID.randomUUID()}.db"; db = open()
    }
    @After fun cleanup() { db.close(); assertTrue(name.startsWith("assistant-delegation-test-")); context.deleteDatabase(name) }
    @Test fun defaultEmptyOwnerConsentColdReopenAndExplicitRevocation() = runBlocking {
        assertTrue(store().activeDelegations().isEmpty())
        val row = store().approve(owner, scope(), store().reviewContext(owner))
        db.close(); db = open()
        assertEquals(row, store().requireActive(row.id))
        assertEquals(scope(), row.scope)
        val revoked = store().revoke(owner, row.id, row.revision)
        db.close(); db = open()
        assertTrue(store().activeDelegations().isEmpty()); assertEquals(revoked, store().list(owner).single())
        rejects { store().requireActive(row.id) }
        assertTrue(store().deleteRevoked(owner, row.id, revoked.revision))
    }
    @Test fun ownerForgeryAndChangedReviewCannotApprove() = runBlocking {
        val reviewed = current
        rejects { store().approve(VerifiedCaller("android-appfunctions:trusted:forged"), scope(), reviewed) }
        current = current.copy(accountBinding = "account-b")
        rejects(ApiErrorCode.REVISION_CONFLICT) { store().approve(owner, scope(), reviewed) }
        current = reviewed.copy(pairedTargetIds = setOf("pc-a"))
        rejects(ApiErrorCode.REVISION_CONFLICT) { store().approve(owner, scope(), reviewed) }
        assertTrue(store().list(owner).isEmpty())
    }
    @Test fun scopeValidationDoesNotTurnEmptyRestrictionsIntoAllResources() = runBlocking {
        listOf(scope().copy(capabilityIds = emptySet()), scope().copy(targetIds = emptySet()),
            scope().copy(sessionIds = emptySet()), scope().copy(projectIds = emptySet()),
            scope().copy(capabilityIds = setOf(SessionCapabilities.GET)),
            scope().copy(expiresAt = time), scope().copy(expiresAt = time + CALLER_GRANT_MAX_LIFETIME_MS + 1)).forEach {
            rejects(ApiErrorCode.INVALID_ARGUMENT) { store().approve(owner, it, current) }
        }
        rejects { store().approve(owner, scope().copy(targetIds = setOf("unpaired")), current) }
        assertTrue(store().list(owner).isEmpty())
    }
    @Test fun expiryAccountChangeAndUnpairCannotResurrectAcrossColdReopen() = runBlocking {
        val original = current
        val expired = store().approve(owner, scope(), current)
        time = expired.scope.expiresAt; assertTrue(store().activeDelegations().isEmpty())
        time = 1000; db.close(); db = open(); rejects { store().requireActive(expired.id) }
        val moved = store().approve(owner, scope(), current)
        current = current.copy(accountBinding = "account-b"); assertTrue(store().activeDelegations().isEmpty())
        current = original; rejects { store().requireActive(moved.id) }
        val unpaired = store().approve(owner, scope(), current)
        current = current.copy(pairedTargetIds = setOf("pc-a")); assertTrue(store().activeDelegations().isEmpty())
        current = original; rejects { store().requireActive(unpaired.id) }
    }
    @Test fun reconsentHasNewPrincipalAndRevokeUsesReviewedRevision() = runBlocking {
        val old = store().approve(owner, scope(), current)
        val fresh = store().approve(owner, scope(), current)
        assertNotEquals(old.caller, fresh.caller)
        store().revoke(owner, old.id, 0)
        rejects(ApiErrorCode.REVISION_CONFLICT) { store().revoke(owner, old.id, 0) }
        assertEquals(fresh, store().requireActive(fresh.id))
        assertFalse(store().deleteRevoked(owner, fresh.id, 0))
    }
    @Test fun capabilityTargetSessionAndProjectRemainOneGrantIntersection() = runBlocking {
        val row = store().approve(owner, scope(), current)
        val authorizer = GrantAuthorizer(owner.binding, { store().activeDelegations().map { it.grant() } }, { time })
        authorizer.require(row.caller, CapabilityRegistry.TASKS_GET, "pc-b", "session-1", "project-1")
        rejects { authorizer.require(row.caller, CapabilityRegistry.TASKS_GET, "pc-a", "session-1", "project-1") }
        rejects { authorizer.require(row.caller, CapabilityRegistry.TASKS_GET, "pc-b", "session-2", "project-1") }
        rejects { authorizer.require(row.caller, CapabilityRegistry.TASKS_GET, "pc-b", "session-1", "project-2") }
        rejects { authorizer.require(row.caller, CapabilityRegistry.TASKS_GET, "pc-b", null, "project-1") }
        rejects { authorizer.require(VerifiedCaller("forged"), CapabilityRegistry.TASKS_GET, "pc-b", "session-1", "project-1") }
    }
    @Test fun corruptStateFailsClosedAndOwnerLogoutStillDurablyDisablesIt() = runBlocking {
        val row = store().approve(owner, scope(), current)
        val payload = AppApiJson.encodeToString(row.copy(id = UUID.randomUUID().toString()))
        assertEquals(1, db.delegations().replace(row.id, 0, false, payload, 0))
        rejects { store().activeDelegations() }
        store().revokeAll(owner)
        db.close(); db = open()
        assertTrue(db.delegations().get(row.id)!!.revoked)
        rejects { store().activeDelegations() }
    }
    @Test fun explicitTargetRemovalAndLogoutAreDurable() = runBlocking {
        val row = store().approve(owner, scope(), current)
        store().revokeForTarget(owner, "pc-a"); assertEquals(row, store().requireActive(row.id))
        store().revokeForTarget(owner, "pc-b"); rejects { store().requireActive(row.id) }
        val fresh = store().approve(owner, scope(), current); store().revokeAll(owner)
        db.close(); db = open(); rejects { store().requireActive(fresh.id) }
    }
}
