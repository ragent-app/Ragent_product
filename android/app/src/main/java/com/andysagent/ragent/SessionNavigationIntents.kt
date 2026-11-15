package com.andysagent.ragent

import android.content.Intent
import com.andysagent.ragent.core.appapi.*

/** Public input is navigation only. In particular, extras cannot answer or approve anything. */
internal fun readSessionNavigation(intent: Intent): SessionNavigationRequest? {
    if (intent.data?.scheme in setOf("ragent", "riollant", "ragent") && intent.data?.host == "session") {
        if (intent.action != Intent.ACTION_VIEW) throw AppApiException(ApiError(ApiErrorCode.INVALID_ARGUMENT, "Invalid link action"))
        return parseSessionNavigationUri(intent.data.toString())
    }
    if (!intent.hasExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_SESSION_ID)) return null
    val version = intent.getStringExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_VERSION)
    if (version != null && version != "1") throw AppApiException(ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Unknown notification contract"))
    val target = intent.getStringExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_INSTANCE_ID)
    if (version != null && target.isNullOrEmpty()) throw AppApiException(ApiError(ApiErrorCode.INVALID_ARGUMENT, "Missing source computer"))
    return SessionNavigationRequest(
        intent.getStringExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_SESSION_ID).orEmpty(), target,
        intent.getStringExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_KIND).orEmpty(),
        intent.getStringExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_AWAITING_KEY).orEmpty(),
        intent.getStringExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_EVENT_ID).orEmpty(),
    ).validated()
}
