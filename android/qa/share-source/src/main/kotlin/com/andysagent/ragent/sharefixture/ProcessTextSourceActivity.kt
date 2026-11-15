package com.andysagent.ragent.sharefixture

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.Selection
import android.text.Spannable
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.io.File

/** A different UID's real startActivityForResult and editable selection. Synthetic QA data only. */
class ProcessTextSourceActivity : Activity() {
    private lateinit var editor: TextView
    private lateinit var status: TextView
    private lateinit var material: String
    private lateinit var token: String
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        material = intent.getStringExtra("material") ?: "Synthetic selected material"
        token = intent.getStringExtra("token") ?: "manual"
        val nativeReadOnly = intent.getBooleanExtra("nativeMenu", false) && intent.getBooleanExtra("readOnly", false)
        editor = (if (nativeReadOnly) TextView(this).apply { setTextIsSelectable(true) } else EditText(this)).apply {
            id = R.id.selected_material
            setText(state?.getString("editor") ?: "Before: $material :After")
            Selection.setSelection(text as Spannable, 8, 8 + material.length)
        }
        status = TextView(this).apply { text = state?.getString("status") ?: "Waiting for selection result" }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            fitsSystemWindows = true
            addView(TextView(this@ProcessTextSourceActivity).apply { text = "Synthetic selection source (separate UID)" })
            addView(editor); addView(status)
        })
        if (state == null && !intent.getBooleanExtra("nativeMenu", false)) {
            val destination = if (intent.getBooleanExtra("qa", false)) "com.andysagent.ragent.ProcessTextQaActivity"
                else "com.andysagent.ragent.ProcessTextActivity"
            val request = Intent(Intent.ACTION_PROCESS_TEXT).setType("text/plain")
                .setComponent(ComponentName("com.agentoncloud.android", destination))
                .putExtra(Intent.EXTRA_PROCESS_TEXT, material as CharSequence)
                .putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, intent.getBooleanExtra("readOnly", false))
                .putExtra("autoStart", true).putExtra("callerBinding", "forged")
                .putExtra("EXTRA_TARGET_DEVICE_ID", "forged").putExtra("ragent.internal.draftId", "forged")
            @Suppress("DEPRECATION")
            startActivityForResult(request, REQUEST)
        }
    }
    @Deprecated("Native QA Activity Result consumer")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST) return
        val replacement = data?.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
        if (resultCode == RESULT_OK && replacement != null && !intent.getBooleanExtra("readOnly", false)) {
            (editor.text as Editable).replace(editor.selectionStart, editor.selectionEnd, replacement)
        }
        status.text = "Returned: $resultCode\nSource: ${editor.text}"
        File(filesDir, "selection-result.json").writeText(JSONObject().apply {
            put("token", token); put("senderUid", android.os.Process.myUid()); put("resultCode", resultCode)
            put("replacement", replacement ?: JSONObject.NULL); put("sourceText", editor.text.toString())
            put("extraKeys", data?.extras?.keySet()?.toList()?.sorted()?.joinToString(",") ?: "")
        }.toString())
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("editor", editor.text.toString()); outState.putString("status", status.text.toString())
        super.onSaveInstanceState(outState)
    }
    companion object { private const val REQUEST = 71 }
}
