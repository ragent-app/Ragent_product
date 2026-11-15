package com.andysagent.ragent.core.appapi

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.*
import org.junit.Assert.*
import java.util.UUID

class BackgroundDeliveryJournalTest {
    @get:Rule val migration = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), AppApiDatabase::class.java)
    private lateinit var context: Context
    private lateinit var name: String
    private lateinit var db: AppApiDatabase
    private val owner = VerifiedCaller("owner")
    private var authority = CallerGrantContext("account", setOf("pc"))
    private var time = 100L
    private val original = TaskOperation("operation", "owner", "fingerprint", "preparation", "pc",
        TaskRequest("operation", "Synthetic background consent", TaskRuntime("codex"), targetInstanceId = "pc"),
        "create", "message", 1, 1000, messageProtocolVersion = 1)
    private fun open() = Room.databaseBuilder(context, AppApiDatabase::class.java, name)
        .addMigrations(AppApiDatabase.MIGRATION_1_2, AppApiDatabase.MIGRATION_2_3, AppApiDatabase.MIGRATION_3_4,
            AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).build()
    private fun store() = RoomBackgroundDeliveryStore(db, owner, { authority }, { time })
    @Before fun setup() = runBlocking<Unit> {
        context = ApplicationProvider.getApplicationContext(); name = "background-test-${UUID.randomUUID()}.db"
        db = open(); RoomOperationStore(db).insert(original); Unit
    }
    @After fun cleanup() { db.close(); assertTrue(name.startsWith("background-test-")); context.deleteDatabase(name) }
    private suspend fun denied(code: ApiErrorCode, block: suspend () -> Unit) {
        try { block(); fail("Expected $code") } catch (failure: AppApiException) { assertEquals(code, failure.error.code) }
    }

    @Test fun explicitConsentSurvivesReopenWithoutChangingTheOperation() = runBlocking<Unit> {
        val review = store().review(original.operationId, owner)
        assertTrue(store().list(owner).isEmpty())
        val consent = store().approve(review, owner)
        db.close(); db = open()
        assertEquals(consent, store().load(consent.consentId, owner))
        assertEquals(original, RoomOperationStore(db).get(original.operationId))
        assertEquals(original.deadlineAt, consent.deadlineAt)
    }

    @Test fun stoppedTicketCannotBeRevivedByAStaleReviewOrNewConsent() = runBlocking<Unit> {
        val review = store().review(original.operationId, owner)
        val first = store().approve(review, owner)
        store().revoke(first.consentId, owner)
        denied(ApiErrorCode.REVISION_CONFLICT) { store().approve(review, owner) }
        val second = store().approve(store().review(original.operationId, owner), owner)
        assertNotEquals(first.consentId, second.consentId)
        assertEquals(first.deadlineAt, second.deadlineAt)
        denied(ApiErrorCode.PERMISSION_DENIED) { store().requireActive(first.consentId, original, owner) }
        store().requireActive(second.consentId, original, owner)
        store().revoke(first.consentId, owner) // A stale notification cannot stop a newly reviewed ticket.
        store().requireActive(second.consentId, original, owner)
    }

    @Test fun expiryIsDurableEvenWhenTheClockLaterMovesBack() = runBlocking<Unit> {
        val consent = store().approve(store().review(original.operationId, owner), owner)
        time = original.deadlineAt
        denied(ApiErrorCode.REQUEST_EXPIRED) { store().requireActive(consent.consentId, original, owner) }
        db.close(); db = open(); time = 100
        assertEquals(BackgroundDeliveryConsent.EXPIRED, store().list(owner).single().state)
        denied(ApiErrorCode.REQUEST_EXPIRED) { store().requireActive(consent.consentId, original, owner) }
    }

    @Test fun changedAccountOrUnpairCannotReviveConsentAfterRestoringTheOldContext() = runBlocking<Unit> {
        for (changed in listOf(CallerGrantContext("other", setOf("pc")), CallerGrantContext("account", emptySet()))) {
            val consent = store().approve(store().review(original.operationId, owner), owner)
            authority = changed
            denied(ApiErrorCode.PERMISSION_DENIED) { store().requireActive(consent.consentId, original, owner) }
            authority = CallerGrantContext("account", setOf("pc"))
            denied(ApiErrorCode.PERMISSION_DENIED) { store().requireActive(consent.consentId, original, owner) }
        }
    }

    @Test fun foreignCallerAndChangedReviewedTaskCannotApprove() = runBlocking<Unit> {
        denied(ApiErrorCode.PERMISSION_DENIED) { store().review(original.operationId, VerifiedCaller("foreign")) }
        val review = store().review(original.operationId, owner)
        denied(ApiErrorCode.PERMISSION_DENIED) { store().approve(review, VerifiedCaller("foreign")) }
        assertTrue(RoomOperationStore(db).replace(original.copy(stage = OperationStage.CONNECTING, revision = 1), 0))
        denied(ApiErrorCode.REVISION_CONFLICT) { store().approve(review, owner) }
        assertTrue(store().list(owner).isEmpty())
    }

    @Test fun consentCannotBeUsedForAnotherPreparationOrDeadline() = runBlocking<Unit> {
        val consent = store().approve(store().review(original.operationId, owner), owner)
        for (operation in listOf(original.copy(preparationId = "other"), original.copy(targetInstanceId = "other"),
                original.copy(deadlineAt = 2000), original.copy(originalFingerprint = "other"))) {
            denied(ApiErrorCode.PERMISSION_DENIED) { store().requireActive(consent.consentId, operation, owner) }
        }
        store().requireActive(consent.consentId, original, owner)
    }

    @Test fun revokingTargetAndClearingHistoryCannotDeleteAnActiveConsent() = runBlocking<Unit> {
        val consent = store().approve(store().review(original.operationId, owner), owner)
        store().clearStopped(owner); assertEquals(1, store().list(owner).size)
        store().revokeAll(owner, "other"); store().requireActive(consent.consentId, original, owner)
        store().revokeAll(owner, "pc")
        assertEquals(BackgroundDeliveryConsent.REVOKED, store().list(owner).single().state)
        store().clearStopped(owner); assertTrue(store().list(owner).isEmpty())
        assertEquals(original, RoomOperationStore(db).get(original.operationId))
    }

    @Test fun dismissedHistoryRetainsRevocationRevisionAgainstOldReviewReplay() = runBlocking<Unit> {
        val oldReview = store().review(original.operationId, owner)
        val old = store().approve(oldReview, owner)
        store().revoke(old.consentId, owner); store().clearStopped(owner)
        assertTrue(store().list(owner).isEmpty())
        db.close(); db = open()
        denied(ApiErrorCode.REVISION_CONFLICT) { store().approve(oldReview, owner) }
        denied(ApiErrorCode.PERMISSION_DENIED) { store().requireActive(old.consentId, original, owner) }
        val current = store().approve(store().review(original.operationId, owner), owner)
        assertNotEquals(old.consentId, current.consentId)
        assertTrue(current.revision > old.revision)
        store().requireActive(current.consentId, original, owner)
    }

    @Test fun restoringDismissedOperationStillHonorsVisibleRecordCapacity() = runBlocking<Unit> {
        val consent = store().approve(store().review(original.operationId, owner), owner)
        store().revoke(consent.consentId, owner); store().clearStopped(owner)
        for (index in 0 until 256) {
            val other = original.copy(operationId = "operation-$index", preparationId = "preparation-$index",
                request = original.request.copy(operationId = "operation-$index"))
            assertTrue(RoomOperationStore(db).insert(other))
            store().approve(store().review(other.operationId, owner), owner)
        }
        assertEquals(256, store().list(owner).size)
        denied(ApiErrorCode.RESOURCE_LIMIT) { store().approve(store().review(original.operationId, owner), owner) }
        store().revokeAll(owner); store().clearStopped(owner)
        assertTrue(store().list(owner).isEmpty())
        store().approve(store().review(original.operationId, owner), owner)
    }

    @Test fun migrationSixToSevenDoesNotGrantExistingOperationsBackgroundAuthority() = runBlocking<Unit> {
        db.close(); context.deleteDatabase(name)
        migration.createDatabase(name, 6).use { old ->
            old.execSQL("INSERT INTO api_operations VALUES ('old', 'old-prep', 'owner', 7, 'retained-payload')")
        }
        migration.runMigrationsAndValidate(name, 7, true, AppApiDatabase.MIGRATION_6_7).close()
        db = open()
        assertEquals("retained-payload", db.operations().get("old")!!.payload)
        assertTrue(db.backgroundDeliveries().list().isEmpty())
    }
}
