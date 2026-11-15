package com.andysagent.ragent

import android.content.ClipData
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareRouterDispatchTest {
    @Test
    fun temporaryRoutePreservesMaterialAndUriReadGrant() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val uri = Uri.parse("content://share-source.example/item/1")
        val incoming = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, "Shared material")
            .putExtra(Intent.EXTRA_STREAM, uri)
        incoming.clipData = ClipData.newRawUri("shared", uri)
        incoming.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

        val routed = createShareTargetIntent(context, incoming, TemporaryShareReceiverActivity::class.java)

        assertEquals(Intent.ACTION_SEND, routed.action)
        assertEquals("text/plain", routed.type)
        assertEquals("Shared material", routed.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
        assertEquals(uri, IntentCompat.getParcelableExtra(routed, Intent.EXTRA_STREAM, Uri::class.java))
        assertEquals(1, routed.clipData?.itemCount)
        assertEquals(uri, routed.clipData?.getItemAt(0)?.uri)
        assertEquals(ComponentName(context, TemporaryShareReceiverActivity::class.java), routed.component)
        assertTrue(routed.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    }

    @Test
    fun multipleFileRoutePreservesOrderedStreamsClipDataAndGrantFlags() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val first = Uri.parse("content://share-source.example/document/1")
        val second = Uri.parse("content://share-source.example/document/2")
        val incoming = Intent(Intent.ACTION_SEND_MULTIPLE)
            .setType("application/pdf")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(first, second))
            .putExtra(Intent.EXTRA_TEXT, "Review these documents")
        incoming.clipData = ClipData.newRawUri("documents", first).apply {
            addItem(ClipData.Item(second))
        }
        incoming.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

        val routed = createShareTargetIntent(context, incoming, TemporaryShareReceiverActivity::class.java)
        val streams = IntentCompat.getParcelableArrayListExtra(routed, Intent.EXTRA_STREAM, Uri::class.java)

        assertEquals(Intent.ACTION_SEND_MULTIPLE, routed.action)
        assertEquals("application/pdf", routed.type)
        assertEquals("Review these documents", routed.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
        assertEquals(listOf(first, second), streams)
        assertNotNull(routed.clipData)
        assertEquals(2, routed.clipData?.itemCount)
        assertEquals(first, routed.clipData?.getItemAt(0)?.uri)
        assertEquals(second, routed.clipData?.getItemAt(1)?.uri)
        assertTrue(routed.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertEquals(ComponentName(context, TemporaryShareReceiverActivity::class.java), routed.component)
    }

    @Test
    fun taskRouteUsesPrivateCaptureEditorDestination() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val incoming = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Shared material")

        val routed = createShareTargetIntent(context, incoming, ShareReceiverActivity::class.java)

        assertEquals(ComponentName(context, ShareReceiverActivity::class.java), routed.component)
        assertEquals("Shared material", routed.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
    }

    @Test
    fun routePreviewSummarizesValidatedTextAndDistinctUrisWithoutOpeningProviders() {
        val first = Uri.parse("content://unavailable-provider.example/item/1")
        val second = Uri.parse("content://unavailable-provider.example/item/2")
        val incoming = Intent(Intent.ACTION_SEND_MULTIPLE)
            .setType("application/octet-stream")
            .putExtra(Intent.EXTRA_TEXT, "Inspect the attached dump")
            .putExtra(Intent.EXTRA_TITLE, "Crash report")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(first, second))
        incoming.clipData = ClipData.newRawUri("files", first).apply { addItem(ClipData.Item(second)) }
        incoming.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

        val preview = createShareRoutePreview(incoming)

        assertEquals("Crash report", preview?.title)
        assertEquals("Inspect the attached dump", preview?.text)
        assertEquals(2, preview?.attachmentCount)
        assertEquals(null, createShareRoutePreview(Intent("unrelated.action")))
    }
}
