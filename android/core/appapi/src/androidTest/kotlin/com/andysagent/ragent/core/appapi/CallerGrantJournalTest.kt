package com.andysagent.ragent.core.appapi

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.junit.*
import org.junit.Assert.*
import java.util.UUID

/** Real Room transactions and restart; platform attestation is independently tested in app. */
class CallerGrantJournalTest {
    @get:Rule val migration = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), AppApiDatabase::class.java)
    private lateinit var context: Context
    private lateinit var name: String
    private lateinit var db: AppApiDatabase
    private val owner = VerifiedCaller("owner")
    private val identity = InstalledCallerIdentity("example.client", 10021, 1, setOf("a".repeat(64)))
    private val external get() = VerifiedCaller(identity.binding)
    private var timestamp = 100L
    private var current = CallerGrantContext("account-credential-a", setOf("pc-a", "pc-b"))
    private var installed = true
    private fun open() = Room.databaseBuilder(context, AppApiDatabase::class.java, name)
        .addMigrations(AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).build()
    private fun store() = RoomCallerGrantStore(db, owner, { current }, { installed }, now = { timestamp })
    private fun grant() = CallerGrant(identity.binding, setOf(CapabilityRegistry.TASKS_GET), setOf("pc-a"), 1000,
        sessionIds = setOf("session-a"), projectIds = setOf("project-a"))
    private suspend fun denies(code: ApiErrorCode = ApiErrorCode.PERMISSION_DENIED, action: suspend () -> Unit) {
        try { action(); fail("Expected $code") } catch (error: AppApiException) { assertEquals(code, error.error.code) }
    }
    @Before fun setup() {
        context = ApplicationProvider.getApplicationContext()
        name = "caller-grant-test-${UUID.randomUUID()}.db"; db = open()
    }
    @After fun cleanup() { db.close(); assertTrue(name.startsWith("caller-grant-test-")); context.deleteDatabase(name) }

    @Test fun coldReopenRetainsScopeAndExplicitRevocation() = runBlocking {
        val approved = store().approve(owner, identity, grant())
        db.close(); db = open()
        assertEquals(approved, store().list(owner).single())
        assertEquals(listOf(grant()), store().activeGrants())
        val revoked = store().revoke(owner, approved.grantId, 0)
        assertEquals(1L, revoked.revision); assertNotNull(revoked.revokedAt)
        db.close(); db = open()
        assertTrue(store().activeGrants().isEmpty())
        assertEquals(revoked, store().list(owner).single())
        assertTrue(store().deleteRevoked(owner, revoked.grantId, revoked.revision))
    }
    @Test fun ownerConsentSnapshotCannotAuthorizeUnderChangedAccountOrPairing() = runBlocking {
        val reviewed = store().reviewContext(owner)
        current = current.copy(accountBinding = "account-new")
        denies(ApiErrorCode.REVISION_CONFLICT) { store().approve(owner, identity, grant(), expectedContext = reviewed) }
        assertTrue(store().list(owner).isEmpty())
        current = reviewed.copy(pairedTargetIds = setOf("pc-a"))
        denies(ApiErrorCode.REVISION_CONFLICT) { store().approve(owner, identity, grant(), expectedContext = reviewed) }
        current = reviewed
        assertEquals(grant(), store().approve(owner, identity, grant(), expectedContext = reviewed).grant)
        denies { store().reviewContext(external) }
    }
    @Test fun capabilitiesTargetsSessionProjectAndCreationRightsRemainIntersected() = runBlocking {
        store().approve(owner, identity, grant())
        val authorization = GrantAuthorizer(owner.binding, { store().activeGrants() }, { timestamp })
        authorization.require(external, CapabilityRegistry.TASKS_GET, "pc-a", "session-a", "project-a")
        denies { authorization.require(external, CapabilityRegistry.TASKS_GET, "pc-b", "session-a", "project-a") }
        denies { authorization.require(external, CapabilityRegistry.TASKS_GET, "pc-a", "session-b", "project-a") }
        denies { authorization.require(external, CapabilityRegistry.TASKS_GET, "pc-a", "session-a", "project-b") }
        denies { authorization.require(external, CapabilityRegistry.TASKS_COMMIT, "pc-a", "session-a", "project-a") }
        denies { authorization.require(external, CapabilityRegistry.TASKS_GET, "pc-a", null, null) }
        denies { authorization.require(VerifiedCaller("other"), CapabilityRegistry.TASKS_GET, "pc-a", "session-a", null) }
        assertEquals(listOf("pc-a"), authorization.authorizedTargets(external, CapabilityRegistry.TASKS_GET,
            listOf(ApiTarget("pc-a", "A"), ApiTarget("pc-b", "B"))).map { it.instanceId })
    }
    @Test fun externalOwnerForgeryUnknownCapabilitiesAndOversizedLifetimeCannotApprove() = runBlocking {
        denies { store().approve(external, identity, grant()) }
        denies(ApiErrorCode.INVALID_ARGUMENT) { store().approve(owner, identity, grant().copy(callerBinding = owner.binding)) }
        denies(ApiErrorCode.CAPABILITY_UNSUPPORTED) { store().approve(owner, identity, grant().copy(capabilityIds = setOf("unknown"))) }
        denies(ApiErrorCode.INVALID_ARGUMENT) { store().approve(owner, identity, grant().copy(expiresAt = timestamp + CALLER_GRANT_MAX_LIFETIME_MS + 1)) }
        denies { store().approve(owner, identity, grant().copy(targetIds = setOf("pc-unpaired"))) }
        installed = false; denies { store().approve(owner, identity, grant()) }
        assertTrue(store().list(owner).isEmpty())
    }
    @Test fun expiryAccountChangeAndInstallationChangePersistRevocationWithoutResurrection() = runBlocking {
        val expired = store().approve(owner, identity, grant())
        timestamp = 1000; assertTrue(store().activeGrants().isEmpty())
        timestamp = 100; assertNotNull(store().list(owner).single().revokedAt)
        assertTrue(store().activeGrants().isEmpty())
        store().deleteRevoked(owner, expired.grantId, 1)
        store().approve(owner, identity, grant())
        current = current.copy(accountBinding = "account-credential-b")
        assertTrue(store().activeGrants().isEmpty()); current = current.copy(accountBinding = "account-credential-a")
        assertTrue(store().activeGrants().isEmpty())
        store().approve(owner, identity, grant()); installed = false
        assertTrue(store().activeGrants().isEmpty()); installed = true
        assertTrue(store().activeGrants().isEmpty())
    }
    @Test fun unpairAndExplicitLogoutRevocationCannotReviveAfterTargetOrAccountReturns() = runBlocking {
        store().approve(owner, identity, grant())
        current = current.copy(pairedTargetIds = setOf("pc-b")); assertTrue(store().activeGrants().isEmpty())
        current = current.copy(pairedTargetIds = setOf("pc-a", "pc-b")); assertTrue(store().activeGrants().isEmpty())
        store().approve(owner, identity, grant()); store().revokeForTarget(owner, "pc-a")
        assertTrue(store().activeGrants().isEmpty())
        store().approve(owner, identity, grant()); store().revokeAll(owner)
        db.close(); db = open(); assertTrue(store().activeGrants().isEmpty())
    }
    @Test fun staleConcurrentRevocationAndHistoryDeleteCannotOverrideCurrentRevision() = runBlocking {
        val approved = store().approve(owner, identity, grant())
        val results = (1..2).map { async { runCatching { store().revoke(owner, approved.grantId, 0) } } }.awaitAll()
        assertEquals(1, results.count { it.isSuccess })
        assertEquals(ApiErrorCode.REVISION_CONFLICT, (results.single { it.isFailure }.exceptionOrNull() as AppApiException).error.code)
        assertFalse(store().deleteRevoked(owner, approved.grantId, 0))
        denies { store().deleteRevoked(external, approved.grantId, 1) }
        assertTrue(store().activeGrants().isEmpty())
    }
    @Test fun corruptOrMismatchedAuthorizationIsNeverTreatedAsAnEmptyHealthyStore() = runBlocking {
        val row = store().approve(owner, identity, grant())
        db.openHelper.writableDatabase.execSQL("UPDATE api_caller_grants SET payload = ? WHERE grantId = ?", arrayOf("{}", row.grantId))
        denies { store().activeGrants() }; denies { store().list(owner) }
    }
    @Test fun corruptGrantCannotBlockOwnerUnpairOrLogoutAndRemainsDiagnosable() = runBlocking {
        val row = store().approve(owner, identity, grant())
        db.openHelper.writableDatabase.execSQL("UPDATE api_caller_grants SET payload = ? WHERE grantId = ?", arrayOf("{}", row.grantId))
        store().revokeForTarget(owner, "pc-a"); store().revokeAll(owner)
        assertTrue(db.callerGrants().get(row.grantId)!!.revoked)
        assertEquals("{}", db.callerGrants().get(row.grantId)!!.payload)
        denies { store().activeGrants() }; denies { store().approve(owner, identity, grant()) }
    }
    @Test fun quotaRetainsActiveGrantsAndRequiresExplicitRevokedHistoryClear() = runBlocking {
        val base = store().approve(owner, identity, grant())
        repeat(255) {
            val copy = base.copy(grantId = UUID.randomUUID().toString())
            db.callerGrants().insert(CallerGrantEntity(copy.grantId, copy.grant.callerBinding, 0, false, copy.grant.expiresAt, AppApiJson.encodeToString(copy)))
        }
        denies(ApiErrorCode.RESOURCE_LIMIT) { store().approve(owner, identity, grant()) }
        assertFalse(store().deleteRevoked(owner, base.grantId, 0))
        store().revoke(owner, base.grantId, 0); assertTrue(store().deleteRevoked(owner, base.grantId, 1))
        store().approve(owner, identity, grant()); assertEquals(256, store().activeGrants().size)
    }
    @Test fun v4MigrationRetainsExistingOperationsAndStartsWithoutExternalAuthority() = runBlocking {
        db.close(); context.deleteDatabase(name)
        val digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        val resource = CaptureResource("legacy-resource", owner.binding, "source.txt", "text/plain", 1,
            declaredSize = 3, state = CaptureResourceState.READY, revision = 1, sizeBytes = 3, sha256 = digest)
        val draft = CaptureDraft("legacy-draft", owner.binding, 1, input = CaptureInput("Original", resources = listOf(resource.reference())))
        val manifest = ResultExportManifest(1, "pc-a", "session", "request", "run", "final",
            listOf(ResultExportResource("text", "output.txt", "text/plain", true, 3, digest)), 3, 65536,
            "2099-01-01T00:00:00Z", "b".repeat(64))
        val operation = TaskOperation("existing-op", "owner", "hash", "prep", "pc-a", TaskRequest("existing-op", "Original", TaskRuntime("tool")),
            "create", "request", 1, 1000, stage = OperationStage.ACCEPTED, sessionId = "session", runId = "run", resultExport = manifest)
        val output = ResultOutput("legacy-output", operation.operationId, owner.binding, manifest, "text", 1, 1,
            state = ResultOutputState.READY, revision = 1, receivedBytes = 3, prefixSha256 = digest, verifiedAt = 1)
        migration.createDatabase(name, 4).use { old ->
            old.execSQL("INSERT INTO api_operations VALUES (?, ?, ?, ?, ?)", arrayOf(operation.operationId, operation.preparationId,
                operation.callerBinding, 0, AppApiJson.encodeToString(operation)))
            old.execSQL("INSERT INTO capture_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?)", arrayOf(draft.draftId, owner.binding,
                1, 1, 0, null, null, AppApiJson.encodeToString(draft)))
            old.execSQL("INSERT INTO capture_resources VALUES (?, ?, ?, ?, ?)", arrayOf(resource.resourceId, owner.binding,
                "READY", 1, AppApiJson.encodeToString(resource)))
            old.execSQL("INSERT INTO capture_resource_bindings VALUES (?, ?, ?)", arrayOf("draft:${draft.draftId}", resource.resourceId, owner.binding))
            old.execSQL("INSERT INTO result_outputs VALUES (?, ?, ?, ?, ?, ?, ?, ?)", arrayOf(output.downloadId, operation.operationId,
                owner.binding, "READY", 1, 3, 1, AppApiJson.encodeToString(output)))
        }
        migration.runMigrationsAndValidate(name, 5, true, AppApiDatabase.MIGRATION_4_5).close()
        db = open()
        assertEquals(operation, RoomOperationStore(db).get(operation.operationId))
        assertEquals(draft, RoomCaptureDraftStore(db).get(draft.draftId, owner))
        assertEquals(resource, db.resources().get(resource.resourceId, owner.binding)!!.decodeResource())
        assertEquals(1, db.resources().references(resource.resourceId))
        assertEquals(output, db.outputs().get(output.downloadId)!!.decodeOutput())
        assertTrue(store().activeGrants().isEmpty())
    }
}
