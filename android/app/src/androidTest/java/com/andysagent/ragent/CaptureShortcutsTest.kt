package com.andysagent.ragent

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.datastore.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** Android framework publication, separate launcher/share intents, and actual saved drafts. */
class CaptureShortcutsTest {
    private val app get() = ApplicationProvider.getApplicationContext<RagentApplication>()
    private fun shortcuts() = ShortcutManagerCompat.getDynamicShortcuts(app)
    private fun saved(source: String): CaptureDraft? = runBlocking {
        app.runtime.captureDrafts.observe(app.runtime.appApiOwner).first().singleOrNull { it.input.sharedText == source }
    }
    private suspend fun awaitDraft(source: String): CaptureDraft = kotlinx.coroutines.withTimeout(5000) {
        while (true) {
            saved(source)?.let { return@withTimeout it }
            kotlinx.coroutines.delay(10)
        }
        error("Unreachable")
    }

    @Test fun publisherUsesStableIdsPreservesOtherShortcutsAndRemovesUnpairedTargets() = runBlocking {
        val original = app.runtime.configStore.directory.first()
        val publisher = CaptureShortcutPublisher(app)
        val otherId = "shortcut-qa-${UUID.randomUUID()}"
        val other = ShortcutInfoCompat.Builder(app, otherId).setShortLabel("Synthetic existing shortcut")
            .setIntent(Intent(app, NewCaptureActivity::class.java).setAction(Intent.ACTION_VIEW)).build()
        val computers = (1..5).map { LinkedComputer("shortcut-qa-pc-$it", "", "Same name", lastSelectedAt = it.toLong()) }
        val directory = ComputerDirectory(computers, computers.first().instanceId,
            AppApiRoutingPreferences(defaultShareTargetId = computers[1].instanceId))
        try {
            assertTrue(ShortcutManagerCompat.addDynamicShortcuts(app, listOf(other)))
            assertTrue(publisher.synchronize(directory))
            val own = shortcuts().filter { it.id.startsWith(CaptureShortcutIds.PREFIX) }
            assertEquals(3, own.size); assertTrue(shortcuts().any { it.id == otherId })
            assertEquals(CaptureShortcutIds.forTarget(computers[1].instanceId), own.minBy { it.rank }.id)
            val picked = own.first { it.id == CaptureShortcutIds.forTarget(computers[1].instanceId) }
            assertEquals(CaptureShortcutIds.CATEGORY, picked.categories!!.single())
            assertEquals(CaptureShortcutIcon.VERSION, picked.extras!!.getInt("captureShortcutVersion"))
            assertEquals(NewCaptureActivity::class.java.name, picked.intent.component!!.className)
            assertEquals(Intent.ACTION_VIEW, picked.intent.action)
            assertEquals(picked.id, picked.intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID))
            assertFalse(picked.intent.hasExtra(Intent.EXTRA_TEXT))
            val renamed = directory.copy(computers = computers.map { if (it.instanceId == computers[1].instanceId) it.copy(label = "Renamed workstation") else it })
            assertTrue(publisher.synchronize(renamed))
            assertEquals("Renamed workstation", shortcuts().single { it.id == picked.id }.shortLabel.toString())
            assertEquals(computers[1].instanceId, CaptureShortcutIds.resolve(picked.id, renamed).targetId)
            val unpaired = renamed.copy(computers = renamed.computers.filterNot { it.instanceId == computers[1].instanceId })
            assertTrue(publisher.synchronize(unpaired)); assertFalse(shortcuts().any { it.id == picked.id })
            val missing = CaptureShortcutIds.resolve(picked.id, unpaired)
            assertNull(missing.targetId); assertTrue(missing.requireSelection); assertEquals(ApiErrorCode.TARGET_NOT_FOUND, missing.error)
            assertTrue(shortcuts().any { it.id == otherId })
        } finally {
            ShortcutManagerCompat.removeDynamicShortcuts(app, listOf(otherId))
            assertTrue(CaptureShortcutPublisher(app).synchronize(original))
        }
    }

    @Test fun launcherMetadataAndPublishedIntentOpenAnEmptyDraftWithoutSubmission() = runBlocking {
        @Suppress("DEPRECATION")
        val main = app.packageManager.getActivityInfo(ComponentName(app, MainActivity::class.java), PackageManager.GET_META_DATA)
        val resource = main.metaData.getInt("android.app.shortcuts")
        assertTrue(resource != 0)
        val parser = app.resources.getXml(resource)
        val names = mutableListOf<String>(); var receiver: String? = null
        parser.use { while (it.next() != org.xmlpull.v1.XmlPullParser.END_DOCUMENT) {
            if (it.eventType == org.xmlpull.v1.XmlPullParser.START_TAG) {
                names += it.name
                if (it.name == "share-target") receiver = it.getAttributeValue("http://schemas.android.com/apk/res/android", "targetClass")
            }
        } }
        assertTrue("shortcut" in names); assertTrue("share-target" in names)
        assertEquals(ShareRouterActivity::class.java.name, receiver)
        val directory = app.runtime.configStore.directory.first()
        val target = directory.computers.firstOrNull()
        val draftsBefore = app.runtime.captureDrafts.observe(app.runtime.appApiOwner).first().map { it.draftId }.toSet()
        var draft: CaptureDraft? = null
        try {
            val intent = Intent(app, NewCaptureActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra("autoStart", true)
            target?.let { intent.putExtra(Intent.EXTRA_SHORTCUT_ID, CaptureShortcutIds.forTarget(it.instanceId)) }
            ActivityScenario.launch<NewCaptureActivity>(intent).use {
                draft = kotlinx.coroutines.withTimeout(5000) {
                    app.runtime.captureDrafts.observe(app.runtime.appApiOwner).first { rows -> rows.any { row -> row.draftId !in draftsBefore } }
                        .single { row -> row.draftId !in draftsBefore }
                }
                assertEquals(target?.instanceId, draft!!.targetInstanceId); assertEquals("", draft!!.input.sharedText)
                assertNull(draft!!.operationId)
                it.recreate(); assertEquals(draft, app.runtime.captureDrafts.get(draft!!.draftId, app.runtime.appApiOwner))
            }
        } finally { draft?.let { app.runtime.captureDrafts.get(it.draftId, app.runtime.appApiOwner)?.let { row ->
            app.runtime.captureDrafts.delete(row.draftId, app.runtime.appApiOwner, row.revision)
        } } }
    }

    @Test fun unknownShareShortcutRetainsTextAndRequiresChoiceAcrossRecreation() = runBlocking {
        val source = "Unknown shortcut ${UUID.randomUUID()} https://example.com/source"
        var draft: CaptureDraft? = null
        try {
            assertNull(readCaptureShortcutId(Intent()))
            assertEquals("", readCaptureShortcutId(Intent().putExtra(Intent.EXTRA_SHORTCUT_ID, 7)))
            assertEquals("", readCaptureShortcutId(Intent().putExtra(Intent.EXTRA_SHORTCUT_ID, "x".repeat(257))))
            val intent = Intent(app, ShareReceiverActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, source).putExtra(Intent.EXTRA_SHORTCUT_ID, "unknown")
                .putExtra("EXTRA_TARGET_DEVICE_ID", "forged").putExtra("autoStart", true)
            ActivityScenario.launch<ShareReceiverActivity>(intent).use { scenario ->
                draft = awaitDraft(source)
                assertNull(draft!!.targetInstanceId); assertTrue(draft!!.requireTargetSelection)
                assertNull(draft!!.operationId); assertEquals(1, draft!!.input.sourceUrls.size)
                scenario.recreate(); assertEquals(draft, saved(source))
            }
        } finally { draft?.let { app.runtime.captureDrafts.get(it.draftId, app.runtime.appApiOwner)?.let { row ->
            app.runtime.captureDrafts.delete(row.draftId, app.runtime.appApiOwner, row.revision)
        } } }
    }

    @Test fun warmShareRetainsBothPayloadsWithoutReusingThePreviousDraft() = runBlocking {
        val firstText = "First warm share ${UUID.randomUUID()}"
        val secondText = "Second warm share ${UUID.randomUUID()}"
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        var original: CaptureDraft? = null
        var next: CaptureDraft? = null
        var nextActivity: android.app.Activity? = null
        val first = Intent(app, ShareReceiverActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, firstText).putExtra(Intent.EXTRA_SHORTCUT_ID, "first-unknown")
        try {
            ActivityScenario.launch<ShareReceiverActivity>(first).use { scenario ->
                original = awaitDraft(firstText)
                val monitor = instrumentation.addMonitor(FreshShareReceiverActivity::class.java.name, null, false)
                try {
                    val second = Intent(app, ShareReceiverActivity::class.java).setAction(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_TEXT, secondText).putExtra(Intent.EXTRA_SHORTCUT_ID, "second-unknown")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    scenario.onActivity { it.startActivity(second) }
                    nextActivity = instrumentation.waitForMonitorWithTimeout(monitor, 5000)
                    assertNotNull(nextActivity)
                    next = awaitDraft(secondText)
                    assertNotEquals(original!!.draftId, next!!.draftId)
                    assertTrue(next!!.requireTargetSelection); assertNull(next!!.targetInstanceId); assertNull(next!!.operationId)
                    assertEquals(original, saved(firstText))
                } finally { instrumentation.removeMonitor(monitor) }
            }
        } finally {
            nextActivity?.let { activity -> instrumentation.runOnMainSync { activity.finish() } }
            listOfNotNull(original, next).forEach { draft ->
                app.runtime.captureDrafts.get(draft.draftId, app.runtime.appApiOwner)?.let { row ->
                    app.runtime.captureDrafts.delete(row.draftId, app.runtime.appApiOwner, row.revision)
                }
            }
        }
    }

    @Test fun warmLauncherDoesNotReusePreviousDraftOrIgnoreNewTargetHint() = runBlocking {
        val directory = app.runtime.configStore.directory.first()
        val target = directory.computers.firstOrNull()
        val before = app.runtime.captureDrafts.observe(app.runtime.appApiOwner).first().map { it.draftId }.toSet()
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        var original: CaptureDraft? = null
        var next: CaptureDraft? = null
        var nextActivity: android.app.Activity? = null
        val first = Intent(app, NewCaptureActivity::class.java).setAction(Intent.ACTION_VIEW)
            .putExtra(Intent.EXTRA_SHORTCUT_ID, target?.let { CaptureShortcutIds.forTarget(it.instanceId) } ?: "original-unknown")
        try {
            ActivityScenario.launch<NewCaptureActivity>(first).use { scenario ->
                original = kotlinx.coroutines.withTimeout(5000) {
                    app.runtime.captureDrafts.observe(app.runtime.appApiOwner).first { rows -> rows.any { it.draftId !in before } }
                        .single { it.draftId !in before }
                }
                val monitor = instrumentation.addMonitor(FreshCaptureActivity::class.java.name, null, false)
                try {
                    // ActivityScenario mutates launch flags; copying its Intent would
                    // inherit CLEAR_TASK and conceal real launcher task reuse.
                    val second = Intent(app, NewCaptureActivity::class.java).setAction(Intent.ACTION_VIEW)
                        .putExtra(Intent.EXTRA_SHORTCUT_ID, "next-unknown")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    scenario.onActivity { it.startActivity(second) }
                    nextActivity = instrumentation.waitForMonitorWithTimeout(monitor, 5000)
                    assertNotNull("A second launcher intake must get its own Activity", nextActivity)
                    next = kotlinx.coroutines.withTimeout(5000) {
                        app.runtime.captureDrafts.observe(app.runtime.appApiOwner).first { rows ->
                            rows.any { it.draftId !in before && it.draftId != original!!.draftId }
                        }.single { it.draftId !in before && it.draftId != original!!.draftId }
                    }
                    assertNotEquals(original!!.draftId, next!!.draftId)
                    assertTrue(next!!.requireTargetSelection); assertNull(next!!.targetInstanceId)
                    assertNull(next!!.operationId)
                    assertEquals(original, app.runtime.captureDrafts.get(original!!.draftId, app.runtime.appApiOwner))
                } finally { instrumentation.removeMonitor(monitor) }
            }
        } finally {
            nextActivity?.let { activity -> instrumentation.runOnMainSync { activity.finish() } }
            listOfNotNull(original, next).forEach { draft ->
                app.runtime.captureDrafts.get(draft.draftId, app.runtime.appApiOwner)?.let { row ->
                    app.runtime.captureDrafts.delete(row.draftId, app.runtime.appApiOwner, row.revision)
                }
            }
        }
    }
}
