package com.andysagent.ragent

import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.Process
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.model.AppLanguage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.UUID

/** Standalone sender APK UID -> exported app Activity -> Resolver -> private Room/files. */
class CaptureFileShareActivityTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val app get() = ApplicationProvider.getApplicationContext<RagentApplication>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun uri(name: String) = Uri.parse("content://com.agentoncloud.android.sharefixture.share-fixture/$name")
    private fun send(material: String, names: List<String>, deny: Boolean = false, mimeType: String? = null, html: String? = null) {
        val materialArg = android.util.Base64.encodeToString(material.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
        val namesArg = android.util.Base64.encodeToString(names.joinToString(",").toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
        val htmlArg = html?.let { android.util.Base64.encodeToString(it.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP) }
        val namesExtra = namesArg.takeIf { names.isNotEmpty() }?.let { " --es namesBase64 $it" } ?: ""
        val command = "am start -n com.agentoncloud.android.sharefixture/com.andysagent.ragent.sharefixture.ShareSourceFixtureActivity " +
            "--ez chooser true --ez denyGrant $deny$namesExtra" +
            (materialArg.takeIf(String::isNotEmpty)?.let { " --es materialBase64 $it" } ?: " --ez omitText true") +
            (mimeType?.let { " --es mimeType $it" } ?: "") + (htmlArg?.let { " --es htmlBase64 $it" } ?: "")
        instrumentation.uiAutomation.executeShellCommand(command).use { descriptor ->
            ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() }
        }
        val device = UiDevice.getInstance(instrumentation)
        // MagicOS can show a first-use Honor Share guide above the actual chooser.
        // Back dismisses only that transient guide and leaves the user's settings unchanged.
        if (device.currentPackageName == "com.hihonor.android.instantshare") device.pressBack()
        val shareTargetLabel = app.packageManager
            .getActivityInfo(android.content.ComponentName(app, ShareRouterActivity::class.java), 0)
            .loadLabel(app.packageManager)
            .toString()
        val shareTarget = By.text(shareTargetLabel)
        // AOSP's chooser initially shows only ranked targets. Expand the sheet so
        // lower-ranked, but still resolvable, apps such as Ragent are discoverable.
        if (!device.hasObject(shareTarget)) {
            device.swipe(
                (device.displayWidth * 0.5f).toInt(),
                (device.displayHeight * 0.94f).toInt(),
                (device.displayWidth * 0.5f).toInt(),
                (device.displayHeight * 0.58f).toInt(),
                24,
            )
            device.waitForIdle()
        }
        // OEM Sharesheets may place less-frequently-used app targets off-screen in a
        // horizontally scrolling row. Search by the manifest-localized activity label.
        for (attempt in 0 until 5) {
            if (device.hasObject(shareTarget)) break
            val y = (device.displayHeight * 0.84f).toInt()
            device.swipe((device.displayWidth * 0.92f).toInt(), y, (device.displayWidth * 0.12f).toInt(), y, 24)
            if (attempt < 4) device.waitForIdle()
        }
        check(device.wait(Until.hasObject(shareTarget), 3_000)) {
            "Ragent share target '$shareTargetLabel' missing from Android Sharesheet"
        }
        device.findObject(shareTarget).click()
        compose.waitUntil(10_000) { router() != null }
        // ActivityLifecycleMonitorRegistry observes RESUMED before DataStore
        // restores the AppApiSurfaceTheme; wait for actual route content.
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("share-route-task").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("share-route-task").performClick()
        compose.waitUntil(10_000) { receiver() != null }
    }
    private fun receiver(): ShareReceiverActivity? {
        var result: ShareReceiverActivity? = null
        instrumentation.runOnMainSync { result = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
            .filterIsInstance<ShareReceiverActivity>().firstOrNull() }
        return result
    }
    private fun router(): ShareRouterActivity? {
        var result: ShareRouterActivity? = null
        instrumentation.runOnMainSync { result = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
            .filterIsInstance<ShareRouterActivity>().firstOrNull() }
        return result
    }
    private fun saved(material: String): CaptureDraft? = runBlocking {
        app.runtime.captureDrafts.observe(app.runtime.appApiOwner).first().singleOrNull { it.input.sharedText == material }
    }
    private suspend fun cleanup(material: String) {
        receiver()?.let { activity -> instrumentation.runOnMainSync { activity.finish() } }
        val graph = app.runtime
        saved(material)?.let { draft ->
            if (draft.operationId == null) graph.captureDrafts.delete(draft.draftId, graph.appApiOwner, draft.revision)
            (draft.input.resources.map { it.resourceId } + draft.input.imports.map { it.resourceId }).forEach { id ->
                graph.captureResources.get(id, graph.appApiOwner)?.let { graph.captureResources.delete(id, graph.appApiOwner, it.revision) }
            }
        }
    }

    @Test fun externalHtmlShareKeepsPlainTextAndSourceUrl() = runBlocking {
        val graph = app.runtime; val language = graph.configStore.appLanguage.first()
        val token = "Html ${UUID.randomUUID()}"
        val url = "https://example.org/${UUID.randomUUID()}"
        val html = "<p>Read <b>$token</b> <a href=\"$url\">source</a></p>"
        val expected = "Read $token source $url"
        try {
            graph.configStore.setAppLanguage(AppLanguage.English)
            send(expected, emptyList(), mimeType = "text/html", html = html)
            val saveFailure = runCatching { compose.waitUntil(10_000) { saved(expected) != null } }.exceptionOrNull()
            if (saveFailure != null) {
                val drafts = graph.captureDrafts.observe(graph.appApiOwner).first().map {
                    "${it.draftId}:${it.input.sharedText}:${it.input.sourceUrls}"
                }
                val active = receiver()
                throw AssertionError("HTML share was routed but no matching draft was persisted; " +
                    "activity=${active?.javaClass?.simpleName}; intent=${active?.intent?.action}/${active?.intent?.type}; " +
                    "text=${active?.intent?.getCharSequenceExtra(Intent.EXTRA_TEXT)}; drafts=$drafts", saveFailure)
            }
            val draft = saved(expected)!!
            assertEquals(expected, draft.input.sharedText)
            assertEquals(listOf(url), draft.input.sourceUrls)
            assertTrue(draft.input.resources.isEmpty())
            assertNull(draft.operationId)
            compose.onNodeWithText("Save to a task").assertDoesNotExist()
        } finally { cleanup(expected); graph.configStore.setAppLanguage(language) }
    }

    @Test fun externalMixedFileGrantCopiesOnceAndPrivateDraftSurvivesRotationAndGrantExpiry() = runBlocking {
        val graph = app.runtime; val oldLanguage = graph.configStore.appLanguage.first()
        val material = "Synthetic mixed share ${UUID.randomUUID()} https://example.com/reference"
        try {
            graph.configStore.setAppLanguage(AppLanguage.English)
            send(material, listOf("first.csv", "second.png", "unknown.csv"))
            val intakeFailure = runCatching {
                compose.waitUntil(10_000) { saved(material)?.let { it.input.resources.size == 3 && it.input.imports.isEmpty() } == true }
            }.exceptionOrNull()
            if (intakeFailure != null) {
                val drafts = graph.captureDrafts.observe(graph.appApiOwner).first()
                    .map { draft -> "${draft.draftId}:text=${draft.input.sharedText};resources=${draft.input.resources.map { it.originalName }};imports=${draft.input.imports.map { it.resourceId to it.error }}" }
                val active = receiver()
                val grants = listOf("first.csv", "second.png", "unknown.csv").associateWith { name ->
                    app.checkUriPermission(uri(name), Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                throw AssertionError("Share intake diagnostic: drafts=$drafts; activity=${active?.javaClass?.simpleName}; " +
                    "intent=${active?.intent?.action}/${active?.intent?.type}/${active?.intent?.flags}; " +
                    "text=${active?.intent?.getCharSequenceExtra(Intent.EXTRA_TEXT)}; " +
                    "streams=${active?.intent?.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.size}; " +
                    "clip=${(0 until (active?.intent?.clipData?.itemCount ?: 0)).map { active!!.intent.clipData!!.getItemAt(it).uri }}; grants=$grants", intakeFailure)
            }
            val directory = graph.configStore.directory.first()
            val default = directory.appApiRouting.defaultShareTargetId
            val expectedTarget = default?.takeIf { id -> directory.computers.any { it.instanceId == id } }
                ?: directory.computers.singleOrNull()?.instanceId.takeIf { default == null }
            // Intake finishes copying before the normal routing autosave. Snapshot after both.
            if (directory.appApiRouting.readable && expectedTarget != null) {
                compose.waitUntil(5000) { saved(material)?.targetInstanceId == expectedTarget }
            }
            val draft = saved(material)!!
            assertNotEquals(Process.myUid(), receiver()!!.intent.getIntExtra("fixtureSenderUid", Process.myUid()))
            assertNotEquals("forged", draft.draftId); assertEquals(graph.appApiOwner.binding, draft.callerBinding)
            assertNull(draft.operationId); assertEquals(1, draft.input.sourceUrls.size)
            assertEquals(listOf("first.csv", "second.png", "unknown.csv"), draft.input.resources.map { it.originalName })
            for (ref in draft.input.resources) {
                assertArrayEquals(fixtureBytes(ref.originalName), graph.captureResources.read(ref, graph.appApiOwner))
            }
            assertFalse(AppApiJson.encodeToString(draft).contains("content://"))
            assertEquals(PackageManager.PERMISSION_GRANTED, app.checkUriPermission(uri("first.csv"), Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION))
            compose.onNodeWithText("first.csv").performScrollTo().assertIsDisplayed()
            File(app.cacheDir, "appapi-capture-external-files.png").outputStream().use {
                assertTrue(compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it))
            }
            val activity = receiver()!!
            instrumentation.runOnMainSync { activity.recreate() }
            compose.waitUntil(5000) { receiver()?.let { it !== activity } == true }
            assertEquals(draft, saved(material))
            compose.onNodeWithContentDescription("Close").assertIsDisplayed().performClick()
            compose.waitUntil(5000) { receiver() == null }
            compose.waitUntil(5000) {
                app.checkUriPermission(uri("first.csv"), Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_DENIED
            }
            ActivityScenario.launch<ShareDraftActivity>(Intent(app, ShareDraftActivity::class.java).putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, draft.draftId)).use {
                compose.onNodeWithText("first.csv").performScrollTo().assertIsDisplayed()
                assertEquals(draft, saved(material)); assertNull(saved(material)!!.operationId)
                graph.captureResources.validate(draft.input.resources, graph.appApiOwner)
            }
        } finally { cleanup(material); graph.configStore.setAppLanguage(oldLanguage) }
    }

    @Test fun missingGrantIsBlockedUnlessChooserActuallyGrantsUriAccess() = runBlocking {
        val graph = app.runtime; val language = graph.configStore.appLanguage.first()
        val material = "Synthetic denied share ${UUID.randomUUID()}"
        try {
            graph.configStore.setAppLanguage(AppLanguage.English)
            send(material, listOf("first.csv"), deny = true)
            val hasReadGrant = app.checkUriPermission(
                uri("first.csv"), Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION,
            ) == PackageManager.PERMISSION_GRANTED
            if (hasReadGrant) {
                // Some OEM chooser implementations issue a URI grant to the selected target
                // even though the source fixture omitted the grant flag. Import is valid only
                // because the receiver can prove that permission at read time.
                compose.waitUntil(10_000) { saved(material)?.input?.resources?.singleOrNull()?.originalName == "first.csv" }
                val draft = saved(material)!!
                assertArrayEquals(fixtureBytes("first.csv"), graph.captureResources.read(draft.input.resources.single(), graph.appApiOwner))
                assertTrue(draft.input.imports.isEmpty())
                assertNull(draft.operationId)
            } else {
                compose.waitUntil(10_000) { saved(material)?.input?.imports?.singleOrNull()?.error != null }
                val draft = saved(material)!!
                assertTrue(draft.input.resources.isEmpty())
                assertEquals(ApiErrorCode.PERMISSION_DENIED, draft.input.imports.single().error)
                assertNull(draft.operationId)
                try { draft.copy(instruction = "Analyze", targetInstanceId = "pc", runtime = TaskRuntime("codex")).freezeForSubmission(2); fail("Missing file must block freeze") }
                catch (failure: AppApiException) { assertEquals(ApiErrorCode.INVALID_ARGUMENT, failure.error.code) }
                compose.onNodeWithText("This file was not saved. Share it again, or explicitly remove it before submitting.").performScrollTo().assertIsDisplayed()
                compose.onNodeWithText("Remove incomplete file: Shared file 1").performScrollTo().performClick()
                compose.waitUntil(5000) { saved(material)?.input?.imports?.isEmpty() == true }
                assertTrue(saved(material)!!.input.resources.isEmpty()); assertNull(saved(material)!!.operationId)
            }
        } finally { cleanup(material); graph.configStore.setAppLanguage(language) }
    }

    @Test fun failingOneSourcePreservesOtherFilesAndSelfProviderCannotBeImportedWithUserPrefix() = runBlocking {
        val graph = app.runtime
        val material = "Synthetic partial share ${UUID.randomUUID()}"
        try {
            send(material, listOf("first.csv", "missing.csv", "lie.csv", "oversized.csv"))
            compose.waitUntil(10_000) { saved(material)?.let { it.input.resources.size == 1 && it.input.imports.size == 3 && it.input.imports.all { slot -> slot.error != null } } == true }
            val draft = saved(material)!!
            assertEquals("first.csv", draft.input.resources.single().originalName)
            assertEquals(listOf(ApiErrorCode.RESOURCE_NOT_FOUND, ApiErrorCode.INVALID_ARGUMENT, ApiErrorCode.INVALID_ARGUMENT), draft.input.imports.map { it.error })
            assertArrayEquals(fixtureBytes("first.csv"), graph.captureResources.read(draft.input.resources.single(), graph.appApiOwner))
            assertNull(draft.operationId)
            for (authority in listOf("${app.packageName}.files", "0@${app.packageName}.files")) {
                try { graph.captureResources.importContent(Uri.parse("content://$authority/shared/forged.csv"), graph.appApiOwner); fail("Self provider must not bridge private data") }
                catch (failure: AppApiException) { assertEquals(ApiErrorCode.INVALID_ARGUMENT, failure.error.code) }
            }
        } finally { cleanup(material) }
    }
    private fun fixtureBytes(name: String) = if (name == "second.png") android.util.Base64.decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=", android.util.Base64.DEFAULT)
        else "a,b\n1,2\n合成分享文件\n".toByteArray()
}
