package com.andysagent.ragent

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.ragent.core.appapi.*
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionNavigationIntakeTest {
    @Test fun canonicalLinkIgnoresForgedCommandAndNotificationExtras() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("ragent://session/shared-session?instanceId=pc-b"))
            .putExtra("autoStart", true).putExtra("approve", true)
            .putExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_INSTANCE_ID, "pc-a")
        assertEquals(SessionNavigationRequest("shared-session", "pc-b"), readSessionNavigation(intent))
    }
    @Test fun legacyNotificationRetainsMissingTargetForExplicitChoice() {
        val intent = Intent().putExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_SESSION_ID, "s1")
        assertNull(readSessionNavigation(intent)!!.targetInstanceId)
    }
    @Test fun futureAndIncompleteVersionedNotificationsAreRejected() {
        val intent = Intent().putExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_SESSION_ID, "s1")
        for ((version, code) in listOf("1" to ApiErrorCode.INVALID_ARGUMENT, "2" to ApiErrorCode.CAPABILITY_UNSUPPORTED)) {
            intent.putExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_VERSION, version)
            try { readSessionNavigation(intent); fail("Must reject") }
            catch (failure: AppApiException) { assertEquals(code, failure.error.code) }
        }
    }
    @Test fun duplicateAndCommandQueryParametersAreRejected() {
        for (uri in listOf("ragent://session/s1?instanceId=a&instanceId=b", "ragent://session/s1?instanceId=a&approve=true")) {
            try { readSessionNavigation(Intent(Intent.ACTION_VIEW, Uri.parse(uri))); fail("Must reject") }
            catch (failure: AppApiException) { assertEquals(ApiErrorCode.INVALID_ARGUMENT, failure.error.code) }
        }
    }
}
