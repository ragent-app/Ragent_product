package com.andysagent.ragent.sharefixture

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import com.agentoncloud.android.api.AppApiWire
import com.agentoncloud.android.api.PublicConsentRequest
import com.agentoncloud.android.sdk.RagentConsentContract

/** Standalone different-UID client for the production consent entry. Synthetic scopes only. */
class CallerConsentSourceActivity : Activity() {
    private lateinit var status: TextView
    private val contract = RagentConsentContract()
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        status = TextView(this).apply { text = state?.getString("status") ?: "Consent client ready: ${intent.getStringExtra("token")}" }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; fitsSystemWindows = true
            addView(status)
            addView(Button(this@CallerConsentSourceActivity).apply {
                text = "Request Ragent access"
                setOnClickListener {
                    // Valid requests use the real SDK contract; malformed probes still reach the production validator.
                    val request = runCatching {
                        contract.createIntent(this@CallerConsentSourceActivity, AppApiWire.decode<PublicConsentRequest>(requireNotNull(intent.getStringExtra("request"))))
                    }.getOrElse { Intent("com.agentoncloud.android.action.REQUEST_API_ACCESS")
                        .setComponent(ComponentName("com.agentoncloud.android", "com.andysagent.ragent.CallerConsentActivity"))
                        .putExtra("ragent.api.consent.request.v1", intent.getStringExtra("request")) }
                    request
                        .putExtra("callerPackage", "forged.owner").putExtra("callerBinding", "ragent:internal-owner")
                        .putExtra("autoApprove", true)
                    val options = if (android.os.Build.VERSION.SDK_INT >= 34)
                        android.app.ActivityOptions.makeBasic().setShareIdentityEnabled(true).toBundle() else null
                    @Suppress("DEPRECATION") startActivityForResult(request, 81, options)
                }
            })
        })
    }
    @Deprecated("Native Activity Result QA client")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != 81) return
        status.text = "Consent returned: $resultCode"
        File(filesDir, "caller-consent-result.json").writeText(JSONObject().apply {
            put("uid", android.os.Process.myUid()); put("token", intent.getStringExtra("token"))
            put("resultCode", resultCode); put("receipt", data?.getStringExtra("ragent.api.consent.receipt.v1"))
            put("error", data?.getStringExtra("ragent.api.consent.error.v1"))
            put("extraKeys", data?.extras?.keySet()?.sorted()?.joinToString(",") ?: "")
            val parsed = contract.parseResult(resultCode, data)
            put("sdkReceipt", parsed.receipt?.let { AppApiWire.encode(it) })
            put("sdkError", parsed.errorCode)
        }.toString())
    }
    override fun onSaveInstanceState(outState: Bundle) { outState.putString("status", status.text.toString()); super.onSaveInstanceState(outState) }
}
