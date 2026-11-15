package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.domain.SessionMetadataSnapshot
import kotlinx.coroutines.test.runTest
import kotlin.test.*

class SessionCapabilitiesTest {
    private val caller = VerifiedCaller("external")
    private fun row(id: String, project: String? = "a", title: String = "Title $id") =
        SessionMetadataSnapshot(id, title, project, "idle", "2026-10-11T00:00:00Z")
    private class Target : SessionReadTarget {
        var rows = listOf<SessionMetadataSnapshot>()
        var onRead: suspend () -> Unit = {}
        var reads = 0
        var wrongId = false
        override suspend fun list(): List<SessionMetadataSnapshot> { reads++; onRead(); return rows }
        override suspend fun get(sessionId: String): SessionMetadataSnapshot? {
            reads++; onRead(); return if (wrongId) rows.firstOrNull() else rows.find { it.sessionId == sessionId }
        }
    }
    private inner class Fixture {
        val target = Target().apply { rows = listOf(row("1"), row("2", "b"), row("3", null)) }
        var paired = true
        var time = 100L
        var storageFailure = false
        var grants = listOf(CallerGrant(caller.binding, SessionCapabilities.descriptors.map { it.id }.toSet(),
            setOf("pc"), 1000, projectIds = setOf("a")))
        var leases = 0
        val api = SessionApiCoordinator(
            { TargetDirectorySnapshot(if (paired) listOf(ApiTarget("pc", "PC")) else emptyList()) },
            GrantAuthorizer("owner", { if (storageFailure) apiFailure(ApiErrorCode.INTERNAL_ERROR, "Broken storage") else grants }, { time }),
            object : TargetSessionAccess {
                override suspend fun <T> withTarget(instanceId: String, block: suspend (SessionReadTarget) -> T): T {
                    assertEquals("pc", instanceId); leases++; return block(target)
                }
            }, { time },
        )
    }
    private suspend fun denies(code: ApiErrorCode, action: suspend () -> Any?) {
        assertEquals(code, assertFailsWith<AppApiException> { action() }.error.code)
    }
    @Test fun listFiltersActualProjectWithoutCreationPermission() = runTest {
        val f = Fixture(); val page = f.api.list(SessionQuery("pc"), caller)
        assertEquals(listOf("1"), page.items.map { it.sessionId }); assertNull(page.nextCursor)
        assertEquals(100L, page.observedAt); assertEquals(1, f.leases)
        assertFalse(f.grants.single().mayCreateSessions)
    }
    @Test fun sessionOnlyScopeAndProjectMustComeFromSameRecord() = runTest {
        val f = Fixture(); f.grants = listOf(
            f.grants.single().copy(sessionIds = setOf("2")),
            f.grants.single().copy(sessionIds = setOf("1"), projectIds = setOf("b")))
        assertTrue(f.api.list(SessionQuery("pc"), caller).items.isEmpty())
        denies(ApiErrorCode.PERMISSION_DENIED) { f.api.get("pc", "2", caller) }
    }
    @Test fun searchDoesNotExposeUnauthorizedMatchesOrCounts() = runTest {
        val f = Fixture(); f.target.rows = listOf(row("1", title = "中文 report"), row("2", "b", "Secret report"))
        assertEquals(listOf("1"), f.api.list(SessionQuery("pc", query = "REPORT"), caller, true).items.map { it.sessionId })
        assertTrue(f.api.list(SessionQuery("pc", query = "Secret"), caller, true).items.isEmpty())
    }
    @Test fun getUsesExactObservedProjectAndSessionScope() = runTest {
        val f = Fixture(); assertEquals("a", f.api.get("pc", "1", caller).projectId)
        denies(ApiErrorCode.PERMISSION_DENIED) { f.api.get("pc", "2", caller) }
        denies(ApiErrorCode.PERMISSION_DENIED) { f.api.get("pc", "3", caller) }
    }
    @Test fun noGrantOrWrongTargetDoesNotAcquireLease() = runTest {
        val f = Fixture(); f.grants = emptyList()
        denies(ApiErrorCode.PERMISSION_DENIED) { f.api.list(SessionQuery("pc"), caller) }
        denies(ApiErrorCode.PERMISSION_DENIED) { f.api.get("pc", "1", caller) }
        denies(ApiErrorCode.TARGET_NOT_FOUND) { f.api.list(SessionQuery("another"), caller) }
        assertEquals(0, f.leases)
    }
    @Test fun sessionDeniedBeforeReadEvenWithProjectGrant() = runTest {
        val f = Fixture(); f.grants = listOf(f.grants.single().copy(sessionIds = setOf("allowed")))
        denies(ApiErrorCode.PERMISSION_DENIED) { f.api.get("pc", "1", caller) }
        assertEquals(0, f.target.reads)
    }
    @Test fun readCapabilitiesAreIndependent() = runTest {
        val f = Fixture(); f.grants = listOf(f.grants.single().copy(capabilityIds = setOf(SessionCapabilities.LIST)))
        assertEquals(1, f.api.list(SessionQuery("pc"), caller).items.size)
        denies(ApiErrorCode.PERMISSION_DENIED) { f.api.list(SessionQuery("pc", query = "Title"), caller, true) }
        denies(ApiErrorCode.PERMISSION_DENIED) { f.api.get("pc", "1", caller) }
    }
    @Test fun revokedDuringReadCannotReturnEmptySuccess() = runTest {
        val f = Fixture(); f.target.onRead = { f.grants = emptyList() }
        denies(ApiErrorCode.PERMISSION_DENIED) { f.api.list(SessionQuery("pc"), caller) }
        assertEquals(1, f.target.reads)
    }
    @Test fun expiryDuringDetailReadRejectsNewMetadata() = runTest {
        val f = Fixture(); f.target.onRead = { f.time = 1000 }
        denies(ApiErrorCode.PERMISSION_DENIED) { f.api.get("pc", "1", caller) }
    }
    @Test fun unpairedDuringListRejectsData() = runTest {
        val f = Fixture(); f.target.onRead = { f.paired = false }
        denies(ApiErrorCode.TARGET_NOT_FOUND) { f.api.list(SessionQuery("pc"), caller) }
    }
    @Test fun storageFailureIsNotAnEmptyAuthorizedList() = runTest {
        val f = Fixture(); f.storageFailure = true
        denies(ApiErrorCode.INTERNAL_ERROR) { f.api.list(SessionQuery("pc"), caller) }
        assertEquals(0, f.leases)
    }
    @Test fun cursorBindsCallerComputerCapabilityQueryAndAuthorizedProjection() = runTest {
        val f = Fixture(); f.target.rows = listOf(row("1"), row("2"), row("3"))
        val first = f.api.list(SessionQuery("pc", limit = 1), caller)
        assertEquals(listOf("2"), f.api.list(SessionQuery("pc", limit = 1, cursor = first.nextCursor), caller).items.map { it.sessionId })
        denies(ApiErrorCode.REVISION_CONFLICT) { f.api.list(SessionQuery("pc", cursor = first.nextCursor, query = "Title"), caller, true) }
        val other = VerifiedCaller("other"); f.grants += f.grants.single().copy(callerBinding = other.binding)
        denies(ApiErrorCode.REVISION_CONFLICT) { f.api.list(SessionQuery("pc", cursor = first.nextCursor), other) }
        f.target.rows = f.target.rows.map { it.copy(title = "New title") }
        denies(ApiErrorCode.REVISION_CONFLICT) { f.api.list(SessionQuery("pc", cursor = first.nextCursor), caller) }
    }
    @Test fun authorizationNarrowingInvalidatesContinuation() = runTest {
        val f = Fixture(); f.grants = listOf(f.grants.single().copy(projectIds = null))
        val first = f.api.list(SessionQuery("pc", limit = 1), caller)
        f.grants = listOf(f.grants.single().copy(projectIds = setOf("a")))
        denies(ApiErrorCode.REVISION_CONFLICT) { f.api.list(SessionQuery("pc", cursor = first.nextCursor), caller) }
    }
    @Test fun unauthorizedChangesDoNotAffectVisibleCursor() = runTest {
        val f = Fixture(); f.target.rows = listOf(row("1"), row("2"), row("secret", "b"))
        val first = f.api.list(SessionQuery("pc", limit = 1), caller)
        f.target.rows = f.target.rows.map { if (it.projectId == "b") it.copy(title = "Secret changed") else it }
        assertEquals(listOf("2"), f.api.list(SessionQuery("pc", cursor = first.nextCursor), caller).items.map { it.sessionId })
    }
    @Test fun invalidQueryCursorOrBudgetNeverReachesPc() = runTest {
        val f = Fixture()
        for (request in listOf(SessionQuery("pc", limit = 33), SessionQuery("\n"), SessionQuery("pc", cursor = "x".repeat(129)), SessionQuery("pc", query = "wrong")))
            denies(ApiErrorCode.INVALID_ARGUMENT) { f.api.list(request, caller) }
        for (query in listOf("", " ", "x".repeat(257), "a\nb"))
            denies(ApiErrorCode.INVALID_ARGUMENT) { f.api.list(SessionQuery("pc", query = query), caller, true) }
        assertEquals(0, f.leases)
    }
    @Test fun malformedCursorAndDuplicateOrOversizedSnapshotFail() = runTest {
        val f = Fixture()
        denies(ApiErrorCode.INVALID_ARGUMENT) { f.api.list(SessionQuery("pc", cursor = "bad"), caller) }
        f.target.rows = listOf(row("1"), row("1"))
        denies(ApiErrorCode.RESOURCE_LIMIT) { f.api.list(SessionQuery("pc"), caller) }
        f.target.rows = (0..2048).map { row("$it") }
        denies(ApiErrorCode.RESOURCE_LIMIT) { f.api.list(SessionQuery("pc"), caller) }
    }
    @Test fun wrongDetailIdentityAndMissingResourceFail() = runTest {
        val f = Fixture(); f.target.wrongId = true
        denies(ApiErrorCode.RESULT_UNKNOWN) { f.api.get("pc", "other", caller) }
        f.target.wrongId = false
        denies(ApiErrorCode.RESOURCE_NOT_FOUND) { f.api.get("pc", "missing", caller) }
    }
    @Test fun boundedTitleAndOwnerReadPreserveObservedMetadata() = runTest {
        val f = Fixture(); f.target.rows = listOf(row("1", title = "x".repeat(600)))
        val item = f.api.get("pc", "1", VerifiedCaller("owner"))
        assertEquals(512, item.title.length); assertTrue(item.titleTruncated)
        assertEquals("2026-10-11T00:00:00Z", item.updatedAt)
        f.target.rows = listOf(row("1", title = "x".repeat(511) + "🙂"))
        val unicode = f.api.get("pc", "1", VerifiedCaller("owner"))
        assertEquals(511, unicode.title.length); assertFalse(unicode.title.last().isHighSurrogate()); assertTrue(unicode.titleTruncated)
    }
    @Test fun deliveryRecheckRejectsRevokedSnapshot() = runTest {
        val f = Fixture(); val page = f.api.list(SessionQuery("pc"), caller); f.grants = emptyList()
        denies(ApiErrorCode.PERMISSION_DENIED) { f.api.checkAccess(caller, SessionCapabilities.LIST, "pc", page.items) }
    }
    @Test fun projectFilterDoesNotExpandAuthorization() = runTest {
        val f = Fixture(); assertTrue(f.api.list(SessionQuery("pc", projectId = "b"), caller).items.isEmpty())
        assertEquals(listOf("1"), f.api.list(SessionQuery("pc", projectId = "a"), caller).items.map { it.sessionId })
    }
}
