package com.andysagent.ragent

import android.content.Intent
import android.text.SpannableString
import android.net.Uri
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.feature.appapi.CaptureSelectionMode
import org.junit.Assert.*
import org.junit.Test

class ProcessTextIntakeTest {
    private fun request() = Intent(Intent.ACTION_PROCESS_TEXT).setType("text/plain")
        .putExtra(Intent.EXTRA_PROCESS_TEXT, SpannableString("Selected https://example.com/a") as CharSequence)
    @Test fun typedSelectionPreservesMaterialButNeverTrustsRoutingCallerOrAutosubmit() {
        val intent = request().putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, false)
            .putExtra("autoStart", true).putExtra("callerBinding", "forged").putExtra("EXTRA_TARGET_DEVICE_ID", "forged")
            .putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, "forged")
        val entry = readSelectedCapture(intent, "generated", true)
        assertEquals("generated", entry.id); assertNull(entry.shortcutId); assertTrue(entry.content.isEmpty())
        assertEquals(CaptureSelectionMode.REPLACEABLE, entry.selectionMode)
        assertEquals(CaptureSource.PROCESS_TEXT, entry.input!!.source)
        assertEquals(false, entry.input!!.selectionReadOnly)
        assertEquals(listOf("https://example.com/a"), entry.input!!.sourceUrls)
    }
    @Test fun missingReadonlyAndAbsentLiveCallerAlwaysUseReadonly() {
        assertEquals(CaptureSelectionMode.READ_ONLY, readSelectedCapture(request(), hasReturnChannel = true).selectionMode)
        assertEquals(CaptureSelectionMode.READ_ONLY, readSelectedCapture(request().putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, false)).selectionMode)
        assertEquals(CaptureSelectionMode.READ_ONLY, readSelectedCapture(request().putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true), hasReturnChannel = true).selectionMode)
    }
    @Test fun invalidTypesEmptyOversizeAndFilePayloadAreRejected() {
        val invalid = listOf(request().putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, "false"),
            request().putExtra(Intent.EXTRA_PROCESS_TEXT, 4), request().putExtra(Intent.EXTRA_PROCESS_TEXT, " "),
            request().putExtra(Intent.EXTRA_PROCESS_TEXT, "中".repeat(17_000)),
            request().putExtra(Intent.EXTRA_STREAM, Uri.parse("content://fixture/file")), request().setDataAndType(Uri.parse("content://fixture/file"), "text/plain"))
        invalid.forEach { intent ->
            try { readSelectedCapture(intent); fail("Invalid payload was accepted") }
            catch (failure: AppApiException) { assertEquals(ApiErrorCode.INVALID_ARGUMENT, failure.error.code) }
        }
        try { readSelectedCapture(request().setType("text/html")); fail("Unsupported type was accepted") }
        catch (failure: AppApiException) { assertEquals(ApiErrorCode.CAPABILITY_UNSUPPORTED, failure.error.code) }
    }
}
