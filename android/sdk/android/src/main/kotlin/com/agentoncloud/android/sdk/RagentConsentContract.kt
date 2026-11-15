package com.agentoncloud.android.sdk

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.result.contract.ActivityResultContract
import com.agentoncloud.android.api.*

data class ConsentOutcome(val receipt: PublicConsentReceipt? = null, val errorCode: String? = null)

/** Register from a foreground Activity; the result is a reference, never a transferable credential. */
class RagentConsentContract : ActivityResultContract<PublicConsentRequest, ConsentOutcome>() {
    override fun createIntent(context: Context, input: PublicConsentRequest): Intent {
        require(input.version == 1 && input.lifetimeMs in 1..(30L * 24 * 60 * 60 * 1000))
        require(input.capabilityIds.isNotEmpty() && input.capabilityIds.size <= 32 && input.targetIds.size <= 16)
        require(input.sessionIds?.size?.let { it <= 32 } != false)
        require(input.projectIds?.size?.let { it <= 32 } != false)
        (input.capabilityIds + input.targetIds + input.sessionIds.orEmpty() + input.projectIds.orEmpty()).forEach(AppApiWire::identifier)
        val payload = AppApiWire.encode(input)
        require(payload.toByteArray(Charsets.UTF_8).size <= 24 * 1024)
        return Intent("com.agentoncloud.android.action.REQUEST_API_ACCESS")
            .setClassName(AppApiWire.PACKAGE, "com.andysagent.ragent.CallerConsentActivity")
            .putExtra("ragent.api.consent.request.v1", payload)
    }
    override fun parseResult(resultCode: Int, intent: Intent?): ConsentOutcome {
        if (resultCode != Activity.RESULT_OK) return ConsentOutcome(errorCode = intent?.getStringExtra("ragent.api.consent.error.v1"))
        return try {
            val receipt = AppApiWire.decode<PublicConsentReceipt>(requireNotNull(intent?.getStringExtra("ragent.api.consent.receipt.v1")))
            require(receipt.version == 1 && receipt.capabilityIds.isNotEmpty() && receipt.targetIds.isNotEmpty())
            ConsentOutcome(receipt)
        } catch (_: Exception) { ConsentOutcome(errorCode = "RESULT_UNKNOWN") }
    }
}
