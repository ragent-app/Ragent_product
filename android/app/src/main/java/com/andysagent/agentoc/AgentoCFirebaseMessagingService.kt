package com.andysagent.agentoc

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import com.andysagent.agentoc.core.appapi.SessionNavigationRequest
import java.security.MessageDigest
import kotlin.math.max

class AgentoCFirebaseMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        scope.launch {
            runCatching { (application as AgentoCApplication).runtime.registerFcmToken(token) }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val title = message.notification?.title ?: data["title"] ?: "Ragent"
        val body = message.notification?.body ?: data["body"] ?: "Ragent needs your attention"
        Publisher(this).publish(data, title, body, message.sentTime)
    }

    internal class Publisher(private val context: Context) {
        private val lifecyclePreferences = context.getSharedPreferences(LIFECYCLE_PREFERENCES, Context.MODE_PRIVATE)

        fun publish(
            data: Map<String, String>,
            title: String,
            body: String,
            sentTimeMillis: Long = System.currentTimeMillis(),
        ) {
            val kind = data["kind"].orEmpty()
            val awaitingKey = data["awaitingKey"].orEmpty()
            val eventId = data["eventId"].orEmpty()
            val sessionId = data["sessionId"].orEmpty()
            val runId = data["runId"].orEmpty()
            if (runId.length > MAX_RUN_ID_LENGTH || runId.any { it.code < 0x20 }) return
            val version = data["notificationContractVersion"]
            if (version != null && version != "1") return
            val target = data["instanceId"]
            if (version != null && target.isNullOrEmpty()) return
            val request = runCatching { SessionNavigationRequest(sessionId, target, kind, awaitingKey, eventId).validated() }.getOrNull() ?: return
            val effectiveSentTime = sentTimeMillis.takeIf { it > 0L } ?: System.currentTimeMillis()
            if (!acceptLifecycleEvent(target, sessionId, kind, runId, effectiveSentTime)) return
            val channelId = channelFor(kind)
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                action = Intent.ACTION_VIEW
                setData(Uri.parse("agentoc-internal://notification/${request.identity()}"))
                putExtra(EXTRA_NOTIFICATION_SESSION_ID, sessionId)
                putExtra(EXTRA_NOTIFICATION_INSTANCE_ID, target)
                putExtra(EXTRA_NOTIFICATION_VERSION, version)
                putExtra(EXTRA_NOTIFICATION_KIND, kind)
                putExtra(EXTRA_NOTIFICATION_AWAITING_KEY, awaitingKey)
                putExtra(EXTRA_NOTIFICATION_EVENT_ID, eventId)
                putExtra(EXTRA_NOTIFICATION_RUN_ID, runId)
            }
            val identity = request.identity()
            val pendingIntent = PendingIntent.getActivity(
                context,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            ensureChannel(channelId)
            val notification = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .addExtras(Bundle().apply {
                    putString(EXTRA_NOTIFICATION_INSTANCE_ID, target)
                    putString(EXTRA_NOTIFICATION_SESSION_ID, sessionId)
                    putString(EXTRA_NOTIFICATION_RUN_ID, runId)
                    putString(EXTRA_NOTIFICATION_EVENT_ID, eventId)
                })
                .build()
            // A terminal run supersedes that run's "waiting for you" cards;
            // a session-wide terminal push supersedes all of them.
            if (kind.lowercase() in TERMINAL_NOTIFICATION_KINDS) {
                cancelAttentionNotifications(context, target, sessionId, runId)
            }
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            try {
                NotificationManagerCompat.from(context).notify(identity, 1, notification)
            } catch (_: SecurityException) {
                // Permission can be revoked between the check and publication.
            }
        }

        private fun ensureChannel(channelId: String) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    channelId,
                    if (channelId == ATTENTION_CHANNEL_ID) "Needs attention" else "Run updates",
                    if (channelId == ATTENTION_CHANNEL_ID) NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT,
                ),
            )
        }

        private fun channelFor(kind: String?): String =
            if (kind?.lowercase().orEmpty() in ATTENTION_NOTIFICATION_KINDS) ATTENTION_CHANNEL_ID
            else RUN_CHANNEL_ID

        /**
         * FCM may deliver messages out of order. Remember terminal runs so a
         * delayed approval push cannot recreate an actionable notification
         * after its run has ended. The timestamp fence covers legacy messages
         * that do not carry a run id.
         */
        private fun acceptLifecycleEvent(
            target: String?,
            sessionId: String,
            kind: String,
            runId: String,
            sentAt: Long,
        ): Boolean {
            val normalizedKind = kind.lowercase()
            val isTerminal = normalizedKind in TERMINAL_NOTIFICATION_KINDS
            if (!isTerminal && normalizedKind !in ATTENTION_NOTIFICATION_KINDS) return true
            // Source-less legacy pushes are ambiguous across paired computers;
            // never let one machine's lifecycle fence suppress another's.
            if (target.isNullOrBlank()) return true
            val key = lifecycleKey(target.orEmpty(), sessionId)
            synchronized(LIFECYCLE_LOCK) {
                val lastSessionTerminalAt = lifecyclePreferences.getLong("session-terminal-at:$key", 0L)
                val lastAnyRunTerminalAt = lifecyclePreferences.getLong("any-run-terminal-at:$key", 0L)
                val terminalRuns = lifecyclePreferences.getString("terminal-runs:$key", "")
                    .orEmpty().split('\n').filter(String::isNotBlank)
                if (!isTerminal) {
                    if (runId.isNotBlank() && runId in terminalRuns) return false
                    if (lastSessionTerminalAt > 0L && sentAt <= lastSessionTerminalAt) return false
                    if (runId.isBlank() && lastAnyRunTerminalAt > 0L && sentAt <= lastAnyRunTerminalAt) return false
                    return true
                }
                // Run-specific terminal events must not be ordered against a
                // different run in the same session. FCM can deliver those in
                // either order, and each event only retires its own run.
                if (runId.isBlank() && lastSessionTerminalAt > sentAt) return false
                val nextRuns = if (runId.isBlank()) terminalRuns else
                    (terminalRuns.filterNot { it == runId } + runId).takeLast(MAX_RECORDED_TERMINAL_RUNS)
                val editor = lifecyclePreferences.edit()
                    .putLong("recorded-at:$key", max(lifecyclePreferences.getLong("recorded-at:$key", 0L), sentAt))
                    .putLong("any-run-terminal-at:$key", max(lastAnyRunTerminalAt, sentAt))
                    .putString("terminal-runs:$key", nextRuns.joinToString("\n"))
                if (runId.isBlank()) {
                    editor.putLong("session-terminal-at:$key", max(lastSessionTerminalAt, sentAt))
                }
                editor.commit()
                pruneLifecycleRecords()
                return true
            }
        }

        private fun pruneLifecycleRecords() {
            val oldest = lifecyclePreferences.all.entries
                .filter { it.key.startsWith("recorded-at:") && it.value is Long }
                .sortedBy { (it.value as Long) }
                .drop(MAX_RECORDED_SESSIONS)
            if (oldest.isEmpty()) return
            val editor = lifecyclePreferences.edit()
            oldest.forEach { entry ->
                val key = entry.key.removePrefix("recorded-at:")
                editor.remove(entry.key).remove("terminal-runs:$key")
                    .remove("session-terminal-at:$key").remove("any-run-terminal-at:$key")
            }
            editor.commit()
        }

        internal fun cancelAttentionNotifications(
            context: Context,
            target: String?,
            sessionId: String,
            runId: String? = null,
            eventId: String? = null,
            notificationTag: String? = null,
        ) {
            if (target.isNullOrBlank() || sessionId.isBlank()) return
            context.getSystemService(NotificationManager::class.java).activeNotifications
                .filter { statusBarNotification ->
                    val extras = statusBarNotification.notification.extras
                    val notificationRunId = extras.getString(EXTRA_NOTIFICATION_RUN_ID).orEmpty()
                    val identityMatches = when {
                        !runId.isNullOrBlank() -> notificationRunId.isBlank() || notificationRunId == runId
                        !eventId.isNullOrBlank() -> extras.getString(EXTRA_NOTIFICATION_EVENT_ID) == eventId ||
                            statusBarNotification.tag == notificationTag
                        !notificationTag.isNullOrBlank() -> statusBarNotification.tag == notificationTag
                        else -> true
                    }
                    statusBarNotification.notification.channelId == ATTENTION_CHANNEL_ID &&
                        extras.getString(EXTRA_NOTIFICATION_INSTANCE_ID) == target &&
                        extras.getString(EXTRA_NOTIFICATION_SESSION_ID) == sessionId &&
                        identityMatches
                }
                .forEach { NotificationManagerCompat.from(context).cancel(it.tag, it.id) }
        }

        private fun lifecycleKey(target: String, sessionId: String): String = MessageDigest
            .getInstance("SHA-256")
            .digest("$target\u0000$sessionId".toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }

    companion object {
        const val RUN_CHANNEL_ID = "agentoc-run-events"
        const val ATTENTION_CHANNEL_ID = "agentoc-attention"
        const val EXTRA_NOTIFICATION_SESSION_ID = "notification_session_id"
        const val EXTRA_NOTIFICATION_KIND = "notification_kind"
        const val EXTRA_NOTIFICATION_AWAITING_KEY = "notification_awaiting_key"
        const val EXTRA_NOTIFICATION_EVENT_ID = "notification_event_id"
        const val EXTRA_NOTIFICATION_RUN_ID = "notification_run_id"
        const val EXTRA_NOTIFICATION_INSTANCE_ID = "notification_instance_id"
        const val EXTRA_NOTIFICATION_VERSION = "notification_contract_version"
        private const val LIFECYCLE_PREFERENCES = "fcm-notification-lifecycle-v1"
        private const val MAX_RECORDED_TERMINAL_RUNS = 128
        private const val MAX_RECORDED_SESSIONS = 256
        private const val MAX_RUN_ID_LENGTH = 256
        private val LIFECYCLE_LOCK = Any()
        private val TERMINAL_NOTIFICATION_KINDS = setOf("completion", "failure", "failed", "error", "cancelled", "canceled", "run_completed", "run_finished", "run_failed", "run_cancelled")
        private val ATTENTION_NOTIFICATION_KINDS = setOf("attention", "approval", "question", "plan", "danger", "answer", "permission")

        /**
         * Source-bound identity; event IDs remain scoped to the source PC and session.
         * Legacy source-less notifications are isolated and require explicit target choice.
         */
        fun notificationIdentity(
            sessionId: String,
            kind: String?,
            awaitingKey: String?,
            eventId: String?,
            targetInstanceId: String? = null,
        ): String {
            return SessionNavigationRequest(sessionId, targetInstanceId, kind.orEmpty(), awaitingKey.orEmpty(), eventId.orEmpty()).identity()
        }
    }
}
