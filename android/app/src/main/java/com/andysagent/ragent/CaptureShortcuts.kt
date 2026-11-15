package com.andysagent.ragent

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.PersistableBundle
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import com.andysagent.ragent.core.appapi.ApiErrorCode
import com.andysagent.ragent.core.datastore.ComputerDirectory
import com.andysagent.ragent.core.datastore.LinkedComputer
import com.andysagent.ragent.feature.appapi.CaptureInitialTarget
import com.andysagent.ragent.feature.appapi.CapturePinResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.security.MessageDigest

/** A shortcut is a target hint, never a caller identity or submission grant. */
internal object CaptureShortcutIds {
    const val PREFIX = "ragent.capture.pc."
    const val CATEGORY = "com.agentoncloud.android.category.CAPTURE_PC"
    // Intent.EXTRA_SHORTCUT_ID was added in API 29; the same wire key also
    // carries our explicit launcher hint on API 26-28. No newer API is called.
    const val EXTRA_ID = "android.intent.extra.shortcut.ID"
    fun forTarget(id: String): String = PREFIX + MessageDigest.getInstance("SHA-256")
        .digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    fun resolve(id: String, directory: ComputerDirectory): CaptureInitialTarget {
        val target = directory.computers.singleOrNull { forTarget(it.instanceId) == id }
        return if (target == null) CaptureInitialTarget(requireSelection = true, error = ApiErrorCode.TARGET_NOT_FOUND)
        else CaptureInitialTarget(target.instanceId)
    }
}

/** Owns only this feature's IDs; other launcher shortcuts are left in place. */
internal class CaptureShortcutPublisher(private val context: Context) {
    private val lock = Mutex()
    private var publishedDirectory: String? = null
    fun reportOpened(id: String) {
        ShortcutManagerCompat.reportShortcutUsed(context, id)
    }
    private fun shortcut(target: LinkedComputer, rank: Int = 0): ShortcutInfoCompat {
        val id = CaptureShortcutIds.forTarget(target.instanceId)
        val label = target.label.trim().ifBlank { target.instanceId }.take(100)
        return ShortcutInfoCompat.Builder(context, id)
            .setShortLabel(label).setLongLabel(context.getString(R.string.capture_shortcut_target, label))
            .setIcon(CaptureShortcutIcon.create(target))
            .setActivity(ComponentName(context, MainActivity::class.java))
            .setIntent(Intent(context, NewCaptureActivity::class.java).setAction(Intent.ACTION_VIEW)
                .putExtra(CaptureShortcutIds.EXTRA_ID, id))
            .setCategories(setOf(CaptureShortcutIds.CATEGORY)).setLongLived(true).setRank(rank)
            .setExtras(PersistableBundle().apply { putInt("captureShortcutVersion", CaptureShortcutIcon.VERSION) }).build()
    }

    suspend fun synchronize(directory: ComputerDirectory): Boolean = withContext(Dispatchers.IO) { lock.withLock {
        val fingerprint = "${CaptureShortcutIcon.VERSION}\u0002" + directory.computers.sortedBy { it.instanceId }.joinToString("\u0000") {
            "${it.instanceId}\u0001${it.label}\u0001${it.platform}\u0001${it.lastSelectedAt}"
        } + "\u0002${directory.appApiRouting.defaultShareTargetId}\u0002${context.resources.configuration.locales.toLanguageTags()}"
        if (fingerprint == publishedDirectory) return@withLock true
        val all = ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_DYNAMIC or
            ShortcutManagerCompat.FLAG_MATCH_PINNED or ShortcutManagerCompat.FLAG_MATCH_CACHED)
        val own = all.filter { it.id.startsWith(CaptureShortcutIds.PREFIX) }
        val valid = directory.computers.associateBy { CaptureShortcutIds.forTarget(it.instanceId) }
        val removed = own.filter { it.id !in valid }.map { it.id }.distinct()
        if (removed.isNotEmpty()) {
            ShortcutManagerCompat.disableShortcuts(context, removed, context.getString(R.string.capture_shortcut_removed))
            ShortcutManagerCompat.removeLongLivedShortcuts(context, removed)
        }
        val disabledValid = own.filter { !it.isEnabled && it.id in valid }.map { it.id }
        if (disabledValid.isNotEmpty()) ShortcutManagerCompat.enableShortcuts(context, disabledValid.map { shortcut(valid.getValue(it)) })
        val otherDynamic = ShortcutManagerCompat.getDynamicShortcuts(context).count { !it.id.startsWith(CaptureShortcutIds.PREFIX) }
        val staticCount = ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_MANIFEST).size
        val budget = (ShortcutManagerCompat.getMaxShortcutCountPerActivity(context) - staticCount - otherDynamic).coerceIn(0, 3)
        val ranked = directory.computers.sortedWith(compareByDescending<LinkedComputer> {
            it.instanceId == directory.appApiRouting.defaultShareTargetId
        }.thenByDescending { it.lastSelectedAt }.thenBy { it.instanceId }).take(budget)
        val desired = ranked.map { CaptureShortcutIds.forTarget(it.instanceId) }.toSet()
        val retainedOutsideRanking = own.filter { (it.isPinned || it.isCached) && it.id !in desired }
            .mapNotNull { valid[it.id] }.distinctBy { it.instanceId }
        val updated = retainedOutsideRanking.isEmpty() || ShortcutManagerCompat.updateShortcuts(context, retainedOutsideRanking.map { shortcut(it) })
        val evicted = own.filter { it.isDynamic && it.id !in desired && it.id in valid }.map { it.id }
        if (evicted.isNotEmpty()) ShortcutManagerCompat.removeDynamicShortcuts(context, evicted)
        val added = ranked.isEmpty() || ShortcutManagerCompat.addDynamicShortcuts(context,
            ranked.mapIndexed { index, target -> shortcut(target, index) })
        (updated && added).also { if (it) publishedDirectory = fingerprint }
    } }

    suspend fun pin(targetId: String, directory: suspend () -> ComputerDirectory): CapturePinResult = withContext(Dispatchers.Main) { lock.withLock {
        val target = directory().computers.firstOrNull { it.instanceId == targetId }
            ?: throw com.andysagent.ragent.core.appapi.AppApiException(com.andysagent.ragent.core.appapi.ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Computer was unpaired"))
        if (!ShortcutManagerCompat.isRequestPinShortcutSupported(context)) CapturePinResult.UNSUPPORTED
        else if (ShortcutManagerCompat.requestPinShortcut(context, shortcut(target), null)) CapturePinResult.REQUESTED
        else CapturePinResult.FAILED
    } }
}
