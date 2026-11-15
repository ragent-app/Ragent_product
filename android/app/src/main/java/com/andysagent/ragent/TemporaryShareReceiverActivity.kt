package com.andysagent.ragent

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import com.andysagent.ragent.core.auth.TemporaryTextStage
import com.andysagent.ragent.core.auth.StagedTemporaryAttachment
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.feature.appapi.TemporaryShareScreen
import com.andysagent.ragent.feature.appapi.TemporaryShareRuntime
import com.andysagent.ragent.feature.appapi.TemporaryShareTarget
import com.andysagent.ragent.feature.appapi.TemporaryShareUiState
import com.andysagent.ragent.feature.appapi.R as AppApiR
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.text.DateFormat
import java.util.Date
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Explicit human share target. It never forwards Intent extras as authority or selects a PC from them. */
class TemporaryShareReceiverActivity : ComponentActivity() {
    private var uiState by mutableStateOf(TemporaryShareUiState())
    private var stagedAttachments = emptyList<StagedTemporaryAttachment>()
    private var sharedUris = emptyList<Uri>()
    private var connectionJob: Job? = null
    private var submitJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as RagentApplication).runtime
        val input = runCatching { readSharedCapture(intent) }.getOrNull()
        sharedUris = input?.content?.values?.toList().orEmpty()
        val restoredOperationId = savedInstanceState?.getString("temporary.operationId")
        val restoredTargetId = savedInstanceState?.getString("temporary.instanceId")
        uiState = TemporaryShareUiState(
            sharedText = input?.input?.sharedText.orEmpty(),
            filesPresent = sharedUris.isNotEmpty(),
            instruction = savedInstanceState?.getString("temporary.instruction").orEmpty(),
            operationId = restoredOperationId,
            selectedInstanceId = restoredTargetId,
            selectedRuntimeId = savedInstanceState?.getString("temporary.runtimeId"),
            error = if (input == null) getString(AppApiR.string.temporary_share_invalid) else null,
        )
        setContent {
            AppApiSurfaceTheme(graph.configStore) {
                TemporaryShareScreen(uiState,
                    onInstruction = { uiState = uiState.copy(instruction = it.take(4_096), error = null) },
                    onSelectTarget = { selectTarget(graph.temporaryAccess, it) },
                    onSelectRuntime = ::selectRuntime,
                    onSubmit = { submit(graph.temporaryAccess) },
                    onCheckResult = { checkResult(graph.temporaryAccess) },
                    onCancel = ::cancelSubmit,
                    onClose = ::finish,
                    onOpenApp = { startActivity(Intent(this, MainActivity::class.java)) })
            }
        }
        if (sharedUris.isNotEmpty() && restoredOperationId == null) {
            lifecycleScope.launch {
                val names = withContext(Dispatchers.IO) { sharedUris.mapIndexed { index, uri -> displayName(uri, index) } }
                uiState = uiState.copy(attachmentNames = names)
            }
        }
        val preferredTargetId = restoredTargetId
        connectionJob = lifecycleScope.launch {
            val targets = withContext(Dispatchers.IO) { graph.temporaryAccess.recoverableTargets() }
            val selected = preferredTargetId?.takeIf { id -> targets.any { it.instanceId == id } }
                ?: targets.singleOrNull()?.instanceId
            uiState = uiState.copy(targets = targets.map(::shareTarget), selectedInstanceId = selected)
            if (selected != null) connectTarget(graph.temporaryAccess, selected)
        }
    }

    private fun selectTarget(temporary: TemporaryAccessRuntime, instanceId: String) {
        if (uiState.busy || uiState.operationId != null || uiState.targets.none { it.instanceId == instanceId }) return
        connectionJob?.cancel()
        uiState = uiState.copy(selectedInstanceId = instanceId, selectedRuntimeId = null,
            runtimes = emptyList(), ready = false, error = null)
        connectionJob = lifecycleScope.launch { connectTarget(temporary, instanceId) }
    }

    private suspend fun connectTarget(temporary: TemporaryAccessRuntime, instanceId: String) {
        if (uiState.selectedInstanceId != instanceId) return
        uiState = uiState.copy(busy = true, ready = false, error = null)
        var phase = "wait_until_ready"
        try {
            withContext(Dispatchers.IO) { temporary.waitUntilReady(instanceId) }
            if (uiState.selectedInstanceId != instanceId) return
            val snapshot = temporary.snapshot.value.takeIf { it.instanceId == instanceId }
            phase = "recover_previous_operation"
            val recoverable = if (uiState.operationId == null && !uiState.filesPresent && uiState.sharedText.isNotBlank())
                withContext(Dispatchers.IO) { existingForSameMaterial(temporary, uiState.sharedText, instanceId) }
            else null
            val saved = uiState.operationId?.let { id -> withContext(Dispatchers.IO) {
                temporary.pendingText(instanceId).firstOrNull { it.operationId == id }
            } }
            if (saved != null) stagedAttachments = saved.attachments
            phase = "list_runtimes"
            val runtimes = withContext(Dispatchers.IO) { temporary.listRuntimes(instanceId) }
                .map { TemporaryShareRuntime(it.id, it.name, it.ready) }
            val preferredRuntimeId = saved?.tool ?: recoverable?.tool ?: uiState.selectedRuntimeId
            val selectedRuntimeId = preferredRuntimeId?.takeIf { id -> runtimes.any { it.id == id && it.ready } }
                ?: runtimes.singleOrNull { it.ready }?.id
            val expiry = snapshot?.expiresAt?.let { DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it)) }
            uiState = uiState.copy(targets = temporary.recoverableTargets().map(::shareTarget),
                runtimes = runtimes, selectedRuntimeId = selectedRuntimeId,
                ready = temporary.available(instanceId), busy = false,
                computerLabel = snapshot?.keyFingerprint?.let { "Computer · ${it.take(8)}" } ?: instanceId,
                expiryLabel = expiry, operationId = uiState.operationId ?: recoverable?.operationId,
                instruction = recoverable?.text?.substringBefore("\n\nShared content:\n") ?: uiState.instruction,
                attachmentNames = saved?.attachments?.map { it.originalName } ?: uiState.attachmentNames,
                runId = (saved ?: recoverable)?.runId)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            Log.w("Ragent.TempShare", "connect_failed phase=$phase type=${error::class.java.simpleName} " +
                "code=${(error as? ApiException)?.code.orEmpty()}")
            if (uiState.selectedInstanceId == instanceId)
                uiState = uiState.copy(busy = false, ready = false,
                    targets = temporary.recoverableTargets().map(::shareTarget),
                    error = getString(when {
                        error is ApiException && error.code == "temporary_route_denied" ->
                            AppApiR.string.temporary_share_upgrade_pc
                        error is ApiException && error.code == "temporary_broker_turn_quota_exceeded" ->
                            AppApiR.string.temporary_share_turn_quota_exceeded
                        else -> AppApiR.string.temporary_share_connect_failed
                    }))
        }
    }

    private fun shareTarget(snapshot: TemporaryAccessRuntime.Snapshot): TemporaryShareTarget {
        val instanceId = requireNotNull(snapshot.instanceId)
        val expiry = snapshot.expiresAt?.let { DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it)) }.orEmpty()
        val label = snapshot.keyFingerprint?.let { "Computer · ${it.take(8)}" } ?: instanceId
        return TemporaryShareTarget(instanceId, label, expiry, snapshot.stage == TemporaryAccessRuntime.Stage.Ready)
    }

    private fun submit(temporary: TemporaryAccessRuntime) {
        val instanceId = uiState.selectedInstanceId ?: return
        val selectedRuntimeId = uiState.selectedRuntimeId
        if (uiState.operationId == null && selectedRuntimeId == null) return
        if (uiState.busy || !uiState.ready || uiState.runId != null ||
            (uiState.filesPresent && sharedUris.isEmpty() && stagedAttachments.isEmpty())) return
        val instruction = uiState.instruction.trim()
        val text = uiState.sharedText
        if (uiState.operationId == null && (instruction.isBlank() ||
                (text.isBlank() && sharedUris.isEmpty() && stagedAttachments.isEmpty()))) return
        uiState = uiState.copy(busy = true, cancellable = uiState.operationId != null, transferFileName = null,
            transferProgress = null, error = null)
        submitJob = lifecycleScope.launch {
            val stagedDuringSubmit = CopyOnWriteArrayList<StagedTemporaryAttachment>()
            var operationDurable = uiState.operationId != null
            var fileReadFailed = false
            try {
                val id = uiState.operationId ?: withContext(Dispatchers.IO) {
                    val runtimeId = requireNotNull(selectedRuntimeId)
                    val shareText = if (text.isBlank()) instruction else "$instruction\n\nShared content:\n$text"
                    val existingText = if (sharedUris.isEmpty())
                        existingForSameMaterial(temporary, text, instanceId, runtimeId) else null
                    if (existingText != null) {
                        operationDurable = true
                        return@withContext existingText.operationId
                    }
                    if (sharedUris.isNotEmpty()) {
                        try {
                            stageSharedFiles(temporary, sharedUris, stagedDuringSubmit)
                        } catch (error: Exception) {
                            fileReadFailed = true
                            throw error
                        }
                    }
                    stagedAttachments = stagedDuringSubmit.toList()
                    val existingFiles = findRecoverableTemporaryFileShare(
                        temporary.pendingText(instanceId), instanceId, shareText, stagedAttachments,
                        System.currentTimeMillis(), runtimeId)
                    if (existingFiles != null) {
                        stagedDuringSubmit.forEach { staged -> temporary.discardStagedAttachment(staged.stageId) }
                        stagedDuringSubmit.clear()
                        stagedAttachments = existingFiles.attachments
                        operationDurable = true
                        existingFiles.operationId
                    } else temporary.createText(shareText, tool = runtimeId, attachments = stagedAttachments,
                        instanceId = instanceId).operationId.also { operationDurable = true }
                }.also { uiState = uiState.copy(operationId = it) }
                uiState = uiState.copy(cancellable = true)
                var lastProgressPercent = -1
                val result = withContext(Dispatchers.IO) {
                    temporary.resumeText(id, instanceId) { name, sent, total ->
                        val percent = (sent.toDouble() / total.toDouble() * 100).toInt().coerceIn(0, 100)
                        if (sent == total || percent >= lastProgressPercent + 5) {
                            lastProgressPercent = percent
                            runOnUiThread {
                                if (!isFinishing && !isDestroyed) uiState = uiState.copy(
                                    transferFileName = name,
                                    transferProgress = percent / 100f)
                            }
                        }
                    }
                }
                submitJob = null
                uiState = uiState.copy(busy = false,
                    cancellable = false, transferFileName = null, transferProgress = null,
                    runId = result.runId.takeIf { result.stage == TemporaryTextStage.Accepted },
                    error = if (result.stage == TemporaryTextStage.Accepted) null
                        else getString(AppApiR.string.temporary_share_check_hint))
            } catch (cancelled: CancellationException) {
                submitJob = null
                if (!operationDurable) stagedDuringSubmit.forEach { staged ->
                    runCatching { temporary.discardStagedAttachment(staged.stageId) }
                }
                if (!isFinishing && !isDestroyed) uiState = uiState.copy(busy = false, cancellable = false,
                    transferFileName = null, transferProgress = null,
                    error = getString(AppApiR.string.temporary_share_cancelled))
                throw cancelled
            }
            catch (_: Exception) {
                submitJob = null
                if (!operationDurable) stagedDuringSubmit.forEach { staged ->
                    runCatching { temporary.discardStagedAttachment(staged.stageId) }
                }
                uiState = uiState.copy(busy = false,
                    cancellable = false, transferFileName = null, transferProgress = null,
                    error = getString(if (fileReadFailed) AppApiR.string.temporary_share_file_read_failed
                        else AppApiR.string.temporary_share_request_unknown))
            }
        }
    }

    private fun cancelSubmit() {
        val job = submitJob?.takeIf { it.isActive } ?: return
        job.cancel()
        uiState = uiState.copy(busy = false, cancellable = false, transferFileName = null,
            transferProgress = null, error = getString(AppApiR.string.temporary_share_cancelled))
    }

    private fun stageSharedFiles(
        temporary: TemporaryAccessRuntime,
        uris: List<Uri>,
        stagedForCleanup: MutableList<StagedTemporaryAttachment>,
    ): List<StagedTemporaryAttachment> {
        val staged = mutableListOf<StagedTemporaryAttachment>()
        try {
            uris.forEachIndexed { index, uri ->
                val id = UUID.randomUUID().toString().replace("-", "").lowercase()
                val stageId = "tast_$id"
                val requestId = "file_$id"
                val name = displayName(uri, index)
                val mimeType = mimeType(uri)
                val stream = contentResolver.openInputStream(uri)
                    ?: error("The shared file is no longer readable")
                val attachment = stream.use { temporary.stageAttachment(stageId, requestId, name, mimeType, it) }
                staged += attachment
                stagedForCleanup += attachment
                require(staged.sumOf { it.sizeBytes } <= 100L * 1024 * 1024) {
                    "Shared files exceed the batch limit"
                }
            }
            return staged
        } catch (error: Throwable) {
            staged.forEach { runCatching { temporary.discardStagedAttachment(it.stageId) } }
            throw error
        }
    }

    private fun displayName(uri: Uri, index: Int): String {
        val fromProvider = runCatching {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        }.getOrNull()
        val safe = (fromProvider ?: uri.lastPathSegment ?: "Shared file ${index + 1}")
            .substringAfterLast('/').substringAfterLast('\\').replace('\u0000', ' ').trim()
        return safe.take(255).ifBlank { "Shared file ${index + 1}" }
    }

    private fun mimeType(uri: Uri): String {
        val candidate = contentResolver.getType(uri)?.substringBefore(';')?.lowercase()
        return candidate?.takeIf { it.matches(Regex("^[A-Za-z0-9!#$&^_.+-]{1,127}/[A-Za-z0-9!#$&^_.+-]{1,127}$")) }
            ?: "application/octet-stream"
    }

    private fun checkResult(temporary: TemporaryAccessRuntime) {
        val id = uiState.operationId ?: return
        val instanceId = uiState.selectedInstanceId ?: return
        if (uiState.busy || !uiState.ready) return
        uiState = uiState.copy(busy = true, error = null)
        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) { temporary.readTextResult(id, instanceId) }
                uiState = uiState.copy(busy = false,
                    resultState = result["state"]?.jsonPrimitive?.content,
                    resultText = result["text"]?.jsonPrimitive?.contentOrNull,
                    resultTruncated = result["textTruncated"]?.jsonPrimitive?.content == "true")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                uiState = uiState.copy(busy = false,
                    error = getString(AppApiR.string.temporary_share_result_failed))
            }
        }
    }

    private fun selectRuntime(runtimeId: String) {
        if (uiState.busy || uiState.operationId != null || uiState.runtimes.none { it.id == runtimeId && it.ready }) return
        uiState = uiState.copy(selectedRuntimeId = runtimeId, error = null)
    }

    private fun existingForSameMaterial(temporary: TemporaryAccessRuntime, material: String,
        instanceId: String, runtimeId: String? = null) =
        temporary.pendingText(instanceId).asSequence()
            .filter { it.expiresAt > System.currentTimeMillis() &&
                (runtimeId == null || it.tool == runtimeId) && it.text.endsWith("\n\nShared content:\n$material") }
            .maxByOrNull { it.createdAt }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("temporary.instruction", uiState.instruction)
        uiState.operationId?.let { outState.putString("temporary.operationId", it) }
        uiState.selectedInstanceId?.let { outState.putString("temporary.instanceId", it) }
        uiState.selectedRuntimeId?.let { outState.putString("temporary.runtimeId", it) }
        super.onSaveInstanceState(outState)
    }
}
