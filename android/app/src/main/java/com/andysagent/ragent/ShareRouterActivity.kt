package com.andysagent.ragent

import android.content.Intent
import android.app.Activity
import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import com.andysagent.ragent.feature.appapi.ShareRoutePreview
import com.andysagent.ragent.feature.appapi.ShareRouteScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The single public Sharesheet receiver; private workflows are selected explicitly inside the app. */
class ShareRouterActivity : ComponentActivity() {
    private var preview by mutableStateOf<ShareRoutePreview?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) {
            finish()
            return
        }
        enableEdgeToEdge()
        val config = (application as RagentApplication).runtime.configStore
        setContent {
            AppApiSurfaceTheme(config) {
                ShareRouteScreen(
                    onSaveToTask = { openTarget(ShareReceiverActivity::class.java) },
                    onSendToTemporaryComputer = { openTarget(TemporaryShareReceiverActivity::class.java) },
                    onClose = ::finish,
                    preview = preview,
                )
            }
        }
        lifecycleScope.launch {
            val parsed = withContext(Dispatchers.Default) { createShareRoutePreview(intent) }
            if (!isFinishing && !isDestroyed) preview = parsed
        }
    }

    private fun openTarget(target: Class<out ComponentActivity>) {
        val routed = createShareTargetIntent(this, intent, target)
        startActivity(routed)
        finish()
    }
}

internal fun createShareTargetIntent(context: Context, source: Intent, target: Class<out Activity>): Intent =
    Intent(source).setClass(context, target)

internal fun createShareRoutePreview(source: Intent): ShareRoutePreview? =
    runCatching { readSharedCapture(source) }.getOrNull()?.let { capture ->
        ShareRoutePreview(
            title = capture.input?.title?.take(512),
            text = capture.input?.sharedText?.take(1_024),
            attachmentCount = capture.content.size,
        )
    }
