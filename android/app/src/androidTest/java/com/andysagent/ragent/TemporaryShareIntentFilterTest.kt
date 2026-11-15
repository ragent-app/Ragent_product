package com.andysagent.ragent

import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TemporaryShareIntentFilterTest {
    @Test
    fun onePublicRouterAcceptsTextAndSingleOrMultipleFiles() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val supportedMimeTypes = listOf(
            "text/plain",
            "text/html",
            "text/csv",
            "image/png",
            "video/mp4",
            "application/pdf",
            "application/octet-stream",
            "application/zip",
        )
        val shareTypes = listOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)
            .flatMap { action -> supportedMimeTypes.map { mimeType -> action to mimeType } }

        shareTypes.forEach { (action, mimeType) ->
            val intent = Intent(action).setType(mimeType)
            val resolved = context.packageManager.queryIntentActivities(intent, 0)
            assertTrue(
                "$action $mimeType must route to ShareRouterActivity",
                resolved.any { it.activityInfo.name == ShareRouterActivity::class.java.name },
            )
            assertEquals("$action $mimeType should expose a single Ragent route", 1,
                resolved.count { it.activityInfo.packageName == context.packageName })
            assertTrue("private workflow receivers must not be competing public targets",
                resolved.none { it.activityInfo.name == TemporaryShareReceiverActivity::class.java.name ||
                    it.activityInfo.name == ShareReceiverActivity::class.java.name })
        }
    }
}
