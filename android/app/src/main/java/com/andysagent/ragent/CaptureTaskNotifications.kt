package com.andysagent.ragent

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.andysagent.ragent.feature.appapi.R

/** Navigation only: no PC effects and no callback authority. Never covers the returning source. */
internal fun showSavedCapture(context: Context, draftId: String, destination: Intent) {
    val title = context.getString(R.string.api_selection_task_saved)
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled() || (Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)) {
        Toast.makeText(context, context.getString(R.string.api_selection_task_saved_inbox), Toast.LENGTH_LONG).show()
        return
    }
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CAPTURE_TASK_CHANNEL, title, NotificationManager.IMPORTANCE_DEFAULT))
    val intent = Intent(destination).setAction("ragent.capture.viewSaved")
        .setData(Uri.parse("ragent-internal://capture/$draftId"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
    val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val notification = NotificationCompat.Builder(context, CAPTURE_TASK_CHANNEL)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle(title).setContentText(context.getString(R.string.api_selection_task_saved_inbox))
        .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true).build()
    try { manager.notify("capture-$draftId", 1, notification) }
    catch (_: SecurityException) { // Permission can be revoked after availability was checked.
        Toast.makeText(context, context.getString(R.string.api_selection_task_saved_inbox), Toast.LENGTH_LONG).show()
    }
}

internal const val CAPTURE_TASK_CHANNEL = "ragent.capture.savedTasks"
