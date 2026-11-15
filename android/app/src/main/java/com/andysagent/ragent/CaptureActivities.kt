package com.andysagent.ragent

import android.content.Intent
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.text.Html
import android.text.Spanned
import android.text.style.URLSpan
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.core.content.IntentCompat
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.feature.appapi.*
import java.util.UUID
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

internal class OwnerCaptureWorkflow(private val graph: AndroidRuntimeGraph, private val content: Map<String, Uri> = emptyMap(),
    private val shortcutId: String? = null, private val context: Context? = null) : CaptureWorkflowPort {
    override val caller = graph.appApiOwner
    override val drafts = graph.captureDrafts
    override val directory = graph.configStore.directory
    override val supportsIntake = true
    override suspend fun checkIntakeSupport(targetId: String): Boolean =
        try { graph.withTargetRuntime(targetId) { target ->
            val response = target.transport.execute(com.andysagent.ragent.core.network.ApiRequest(
                "GET", "/api/intake/capabilities"))
            if (!response.isSuccessful) {
                if (response.statusCode in setOf(404, 501)) false
                else throw intakeApiFailure(com.andysagent.ragent.core.network.ApiException(
                    response.statusCode, null, "Intake capability check failed"))
            } else if (response.body.length > 4096) false
            else IntakeJson.decodeFromString<IntakeCapabilities>(response.body).supportsSmartShare
        } } catch (failure: com.andysagent.ragent.core.network.ApiException) {
            if (failure.statusCode in setOf(404, 501)) false else throw intakeApiFailure(failure)
        } catch (_: kotlinx.serialization.SerializationException) { false }
    override suspend fun prepareIntake(input: IntakeInput, runtime: TaskRuntime): IntakeDecision =
        try { graph.withTargetRuntime(input.targetInstanceId) { target ->
            val body = IntakeJson.encodeToString(IntakePrepareRequest(input, runtime))
            val response = target.transport.execute(com.andysagent.ragent.core.network.ApiRequest(
                "POST", "/api/intake/prepare", body))
            if (!response.isSuccessful) throw AppApiException(ApiError(ApiErrorCode.TARGET_OFFLINE, "Intake preparation failed", true))
            IntakeJson.decodeFromString<IntakeDecision>(response.body)
        } } catch (failure: com.andysagent.ragent.core.network.ApiException) {
            throw intakeApiFailure(failure)
        }
    override suspend fun ensureIntakeProject(request: IntakeEnsureRequest): IntakeProjectReceipt =
        try { graph.withTargetRuntime(request.input.targetInstanceId) { target ->
            val response = target.transport.execute(com.andysagent.ragent.core.network.ApiRequest(
                "POST", "/api/intake/ensure-project", IntakeJson.encodeToString(request)))
            if (!response.isSuccessful) throw AppApiException(ApiError(ApiErrorCode.TARGET_OFFLINE, "Project creation failed", true))
            IntakeJson.decodeFromString<IntakeProjectReceipt>(response.body)
        } } catch (failure: com.andysagent.ragent.core.network.ApiException) {
            throw intakeApiFailure(failure)
        }
    private fun intakeApiFailure(failure: com.andysagent.ragent.core.network.ApiException): AppApiException {
        val code = when (failure.statusCode) {
            404, 501 -> ApiErrorCode.CAPABILITY_UNSUPPORTED
            0, 408, in 500..599 -> ApiErrorCode.TARGET_OFFLINE
            401, 403 -> ApiErrorCode.AUTHENTICATION_REQUIRED
            409 -> ApiErrorCode.REVISION_CONFLICT
            429 -> ApiErrorCode.RATE_LIMITED
            else -> ApiErrorCode.INTERNAL_ERROR
        }
        return AppApiException(ApiError(code, failure.message, failure.retryable))
    }
    override suspend fun catalog(targetId: String) = graph.withTargetRuntime(targetId) { it.sessions.loadRuntimeCatalog() }
    override suspend fun models(targetId: String, tool: String, provider: String) = graph.withTargetRuntime(targetId) { it.sessions.loadRuntimeModels(tool, provider) }
    override suspend fun rememberRuntime(targetId: String, runtime: TaskRuntime) = graph.configStore.rememberShareRuntime(targetId,
        com.andysagent.ragent.core.datastore.ShareRuntimeSelection(runtime.tool, runtime.providerProfile, requireNotNull(runtime.model)))
    override suspend fun prepare(request: TaskRequest) = graph.appApi.prepare(request, caller)
    override suspend fun commit(preparationId: String, onProgress: (TaskUploadProgress) -> Unit) =
        graph.appApi.commit(preparationId, caller, onProgress)
    override suspend fun operation(operationId: String) = graph.appApi.get(operationId, caller)
    override suspend fun reconcile(operationId: String) = graph.appApi.reconcile(operationId, caller)
    override suspend fun cancelSubmission(operationId: String) = graph.appApi.cancelSubmission(operationId, caller)
    override suspend fun readResult(operationId: String) = graph.appApi.readResult(operationId, caller)
    override suspend fun initialTarget(): CaptureInitialTarget {
        val selectedShortcut = shortcutId ?: return CaptureInitialTarget()
        graph.appApi.listTargets(caller) // Wait for directory migration/initialization.
        return CaptureShortcutIds.resolve(selectedShortcut, directory.first()).also { hint ->
            if (hint.targetId != null) runCatching { graph.captureShortcuts.reportOpened(selectedShortcut) }
        }
    }
    override suspend fun pinTarget(targetId: String): CapturePinResult {
        return graph.captureShortcuts.pin(targetId) { directory.first() }
    }
    override suspend fun checkConnection(targetId: String): CaptureConnectionStatus = try {
        graph.withTargetRuntime(targetId) { runtime ->
            val response = runtime.transport.execute(com.andysagent.ragent.core.network.ApiRequest("GET", "/healthz"))
            if (directory.first().computers.none { it.instanceId == targetId }) CaptureConnectionStatus.UNPAIRED
            else if (runtime.transport.connectionState.value != com.andysagent.ragent.core.model.RuntimeConnectionState.Connected)
                CaptureConnectionStatus.UNKNOWN
            else if (response.statusCode in 500..599) CaptureConnectionStatus.SERVICE_UNAVAILABLE
            else if (response.statusCode in setOf(401, 403)) CaptureConnectionStatus.AUTHENTICATION_REQUIRED
            else if (response.statusCode != 200 || response.body.length > 1024 * 1024) CaptureConnectionStatus.UNKNOWN
            else {
                val body = org.json.JSONObject(response.body)
                if (body.opt("ok") == true && body.opt("status") == "ready") CaptureConnectionStatus.AVAILABLE
                else if (body.opt("ok") == false && body.opt("status") == "degraded") CaptureConnectionStatus.SERVICE_UNAVAILABLE
                else CaptureConnectionStatus.UNKNOWN
            }
        }
    } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
    catch (failure: AppApiException) {
        when (failure.error.code) {
            ApiErrorCode.TARGET_OFFLINE -> CaptureConnectionStatus.UNREACHABLE
            ApiErrorCode.AUTHENTICATION_REQUIRED -> CaptureConnectionStatus.AUTHENTICATION_REQUIRED
            ApiErrorCode.TARGET_NOT_FOUND -> CaptureConnectionStatus.UNPAIRED
            else -> CaptureConnectionStatus.UNKNOWN
        }
    } catch (failure: com.andysagent.ragent.core.network.ApiException) {
        when (failure.statusCode) {
            401, 403 -> CaptureConnectionStatus.AUTHENTICATION_REQUIRED
            in 500..599 -> CaptureConnectionStatus.SERVICE_UNAVAILABLE
            0, 408 -> CaptureConnectionStatus.UNREACHABLE
            else -> CaptureConnectionStatus.UNKNOWN
        }
    } catch (_: java.io.IOException) { CaptureConnectionStatus.UNREACHABLE
    } catch (_: Exception) { CaptureConnectionStatus.UNKNOWN
    }
    override val supportsBackgroundDelivery: Boolean get() = context != null
    override suspend fun scheduleBackgroundDelivery(operationId: String): String {
        val appContext = context ?: throw AppApiException(ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Background delivery is unavailable"))
        if (!BackgroundDeliveryJobs.notificationsAvailable(appContext))
            throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Enable Ragent notifications before scheduling background delivery"))
        val draft = withContext(kotlinx.coroutines.Dispatchers.IO) {
            graph.captureDrafts.getByOperationId(operationId, caller)
        } ?: throw AppApiException(ApiError(ApiErrorCode.RESOURCE_NOT_FOUND, "The original task draft is unavailable"))
        val previous = graph.backgroundDeliveryConsents.forOperation(operationId, caller)
        val consent = if (previous?.state == BackgroundDeliveryConsent.AUTHORIZED) previous else {
            previous?.let { BackgroundDeliveryJobs.cancel(appContext, it.consentId) }
            val review = graph.backgroundDeliveryConsents.review(operationId, caller)
            if (draft.operationId != review.operation.operationId || draft.preparationId != review.operation.preparationId ||
                draft.targetInstanceId != review.operation.targetInstanceId) {
                throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "The original task draft no longer matches"))
            }
            graph.backgroundDeliveryConsents.approve(review, caller)
        }
        if (draft.operationId != consent.operationId || draft.targetInstanceId != consent.targetInstanceId ||
            draft.preparationId != consent.preparationId) {
            throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "The original task draft no longer matches"))
        }
        if (BackgroundDeliveryJobs.schedule(appContext, consent.consentId, draft.draftId)) return consent.consentId
        graph.backgroundDeliveryConsents.revoke(consent.consentId, caller)
        BackgroundDeliveryJobs.cancel(appContext, consent.consentId)
        throw AppApiException(ApiError(ApiErrorCode.INTERNAL_ERROR, "Android could not schedule background delivery", true))
    }
    override suspend fun restoreInputs(draft: CaptureDraft) = graph.captureImports.restore(draft.draftId, caller)
    override suspend fun importInputs(draft: CaptureDraft, onProgress: (CaptureImportProgress) -> Unit,
        onUpdated: (CaptureDraft) -> Unit) =
        graph.captureImports.consume(draft.draftId, caller, source = { resourceId, maxBytes ->
            val uri = content[resourceId] ?: throw AppApiException(ApiError(ApiErrorCode.RESOURCE_NOT_FOUND, "Source permission is no longer available"))
            graph.captureResources.importContent(uri, caller, resourceId, maxBytes, onProgress)
        }, onUpdated = onUpdated)
}

/** Human share intake. Extras cannot select a caller, saved draft, target or submit action. */
open class ShareReceiverActivity : CaptureEditorActivity() {
    override fun intake(savedInstanceState: Bundle?): CaptureEntry {
        val id = savedInstanceState?.getString(SAVED_DRAFT_ID) ?: UUID.randomUUID().toString()
        return try { readSharedCapture(intent, id) }
        catch (failure: AppApiException) { CaptureEntry(id, error = failure.error.code) }
        catch (_: Exception) { CaptureEntry(id, error = ApiErrorCode.INVALID_ARGUMENT) }
    }
}

/** Only owner navigation may reopen persisted drafts. */
class ShareDraftActivity : CaptureEditorActivity() {
    override fun intake(savedInstanceState: Bundle?): CaptureEntry {
        val id = savedInstanceState?.getString(SAVED_DRAFT_ID) ?: intent.getStringExtra(EXTRA_DRAFT_ID).orEmpty()
        return if (Regex("[A-Za-z0-9_-]{1,64}").matches(id)) CaptureEntry(id)
            else CaptureEntry(UUID.randomUUID().toString(), error = ApiErrorCode.INVALID_ARGUMENT)
    }
    companion object { const val EXTRA_DRAFT_ID = "ragent.internal.draftId" }
}

data class CaptureEntry(val id: String, val input: CaptureInput? = null, val error: ApiErrorCode? = null,
    val content: Map<String, Uri> = emptyMap(), val shortcutId: String? = null,
    val selectionMode: CaptureSelectionMode = CaptureSelectionMode.NONE)

/** Standard Activity preserves the source's return channel; persisted drafts cannot recreate it. */
open class ProcessTextActivity : CaptureEditorActivity() {
    protected open fun savedTaskIntent(draft: CaptureDraft): Intent = Intent(this, ShareDraftActivity::class.java)
        .putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, draft.draftId)
    override fun intake(savedInstanceState: Bundle?): CaptureEntry {
        val id = savedInstanceState?.getString(SAVED_DRAFT_ID) ?: UUID.randomUUID().toString()
        return try { readSelectedCapture(intent, id, callingActivity != null) }
        catch (failure: AppApiException) { CaptureEntry(id, error = failure.error.code) }
        catch (_: Exception) { CaptureEntry(id, error = ApiErrorCode.INVALID_ARGUMENT) }
    }
    override fun finishCapture(state: CaptureUiState, localizedContext: Context) {
        val text = state.replacementText
        if (text != null && state.selectionMode == CaptureSelectionMode.REPLACEABLE && callingActivity != null) {
            setResult(RESULT_OK, Intent().putExtra(Intent.EXTRA_PROCESS_TEXT, text))
        } else {
            setResult(RESULT_CANCELED)
            if (state.viewSavedTask) state.draft?.let { draft ->
                // Starting another Activity here prevents the source resuming and
                // delays its Activity Result. Offer navigation without covering it.
                showSavedCapture(localizedContext, draft.draftId, savedTaskIntent(draft))
            }
        }
        finish()
    }
}

/** Launcher shortcuts open an empty draft; they never impersonate a share payload. */
open class NewCaptureActivity : CaptureEditorActivity() {
    override fun intake(savedInstanceState: Bundle?): CaptureEntry {
        val id = savedInstanceState?.getString(SAVED_DRAFT_ID) ?: UUID.randomUUID().toString()
        return if (intent.action == Intent.ACTION_VIEW) CaptureEntry(id, CaptureInput(), shortcutId = readCaptureShortcutId(intent))
            else CaptureEntry(id, error = ApiErrorCode.INVALID_ARGUMENT)
    }
}

/** Standard, non-exported reentry destinations cannot recursively deliver to the public singleTop activity. */
class FreshCaptureActivity : NewCaptureActivity()
class FreshShareReceiverActivity : ShareReceiverActivity()

abstract class CaptureEditorActivity : ComponentActivity() {
    protected abstract fun intake(savedInstanceState: Bundle?): CaptureEntry
    protected open fun workflowPort(graph: AndroidRuntimeGraph, entry: CaptureEntry): CaptureWorkflowPort =
        OwnerCaptureWorkflow(graph, entry.content, entry.shortcutId, applicationContext)
    protected open fun finishCapture(state: CaptureUiState, localizedContext: Context) { finish() }
    private var model: CaptureViewModel? = null
    private lateinit var entry: CaptureEntry
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // NEW_TASK can bring an existing intake task back because Intent identity
        // ignores extras. Preserve its editor and open the new payload separately.
        // A distinct standard component avoids singleTop's delivery optimization
        // (which runs even with MULTIPLE_TASK and would recurse back here).
        val destination = when (this) {
            is NewCaptureActivity -> FreshCaptureActivity::class.java
            is ShareReceiverActivity -> FreshShareReceiverActivity::class.java
            else -> return
        }
        val fresh = Intent(intent).setClass(this, destination).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK or
                (intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(fresh)
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        entry = intake(savedInstanceState)
        val graph = (application as RagentApplication).runtime
        val restored = savedInstanceState?.getString(SAVED_DRAFT_PAYLOAD)?.let { payload ->
            if (payload.toByteArray(Charsets.UTF_8).size > 160 * 1024) null
            else runCatching { AppApiJson.decodeFromString<CaptureDraft>(payload) }.getOrNull()
        }
        val factory = captureFactory { CaptureViewModel(workflowPort(graph, entry), entry.id, entry.input, entry.error,
            restoredDraft = restored, selectionMode = entry.selectionMode) }
        setContent {
            AppApiSurfaceTheme(graph.configStore) {
                val viewModel: CaptureViewModel = viewModel(factory = factory)
                model = viewModel
                val state by viewModel.state.collectAsStateWithLifecycle()
                val localizedContext = LocalContext.current
                BackHandler { viewModel.onEvent(CaptureEvent.SaveAndClose) }
                LaunchedEffect(state.close) { if (state.close) finishCapture(state, localizedContext) }
                CaptureScreen(state, { event ->
                    if (event == CaptureEvent.OpenRoutingSettings) startActivity(Intent(this, AppApiSettingsActivity::class.java))
                    else if (event == CaptureEvent.ViewOutputs) {
                        if (state.selectionMode == CaptureSelectionMode.NONE && !state.busy && state.operation?.stage == OperationStage.ACCEPTED)
                            startActivity(Intent(this, ResultOutputsActivity::class.java)
                                .putExtra(ResultOutputsActivity.EXTRA_OPERATION_ID, state.operation!!.operationId))
                    }
                    else viewModel.onEvent(event)
                })
            }
        }
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(SAVED_DRAFT_ID, model?.state?.value?.draft?.draftId ?: entry.id)
        model?.state?.value?.takeIf { it.dirty && it.draft?.operationId == null }?.draft?.let { draft ->
            val payload = AppApiJson.encodeToString(draft)
            if (payload.toByteArray(Charsets.UTF_8).size <= 160 * 1024) outState.putString(SAVED_DRAFT_PAYLOAD, payload)
        }
        super.onSaveInstanceState(outState)
    }
    override fun onStop() {
        model?.saveEdits()
        super.onStop()
    }
    companion object {
        const val SAVED_DRAFT_ID = "ragent.savedDraftId"
        const val SAVED_DRAFT_PAYLOAD = "ragent.unsavedDraft"
    }
}

class DraftInboxActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as RagentApplication).runtime
        val factory = captureFactory { DraftInboxViewModel(OwnerCaptureWorkflow(graph)) }
        setContent {
            AppApiSurfaceTheme(graph.configStore) {
                val model: DraftInboxViewModel = viewModel(factory = factory)
                val state by model.state.collectAsStateWithLifecycle()
                DraftInboxScreen(state, { id -> startActivity(Intent(this, ShareDraftActivity::class.java).putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, id)) }, model::delete, model::reload, ::finish)
            }
        }
    }
}

private inline fun <reified M : ViewModel> captureFactory(crossinline create: () -> M): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass == M::class.java)
        @Suppress("UNCHECKED_CAST") return create() as T
    }
}

/** Parsing performs no resolver I/O and trusts no caller/target/confirmation extras. */
internal fun readSharedCapture(intent: Intent, draftId: String = UUID.randomUUID().toString()): CaptureEntry {
    if (intent.action !in setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE) || intent.type.isNullOrBlank()
        || !Regex("[A-Za-z0-9!#$&^_.+*-]+/[A-Za-z0-9!#$&^_.+*-]+").matches(intent.type!!)) {
        throw AppApiException(ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Unsupported share type"))
    }
    val clip = intent.clipData
    if ((clip?.itemCount ?: 0) > 16 || (0 until (clip?.itemCount ?: 0)).any { clip!!.getItemAt(it).intent != null }) {
        throw AppApiException(ApiError(ApiErrorCode.INVALID_ARGUMENT, "Invalid shared items"))
    }
    val extraUris = if (intent.action == Intent.ACTION_SEND_MULTIPLE)
        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.toList() ?: emptyList()
        else listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
    if (extraUris.size > 16 || (intent.hasExtra(Intent.EXTRA_STREAM) && extraUris.isEmpty())) {
        throw AppApiException(ApiError(ApiErrorCode.INVALID_ARGUMENT, "Invalid shared file list"))
    }
    val uris = (extraUris + (0 until (clip?.itemCount ?: 0)).mapNotNull { clip!!.getItemAt(it).uri }).distinct()
    if (uris.size > 16 || uris.any { it.scheme != "content" || it.authority.isNullOrBlank() }) {
        throw AppApiException(ApiError(ApiErrorCode.INVALID_ARGUMENT, "Only granted content files may be shared"))
    }
    val parts = buildList {
        intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.takeIf(String::isNotBlank)?.let(::add)
        for (index in 0 until (clip?.itemCount ?: 0)) {
            clip!!.getItemAt(index).text?.toString()?.takeIf { it.isNotBlank() && it !in this }?.let(::add)
        }
        if (isEmpty()) intent.getCharSequenceExtra(Intent.EXTRA_HTML_TEXT)?.toString()
            ?.takeIf(String::isNotBlank)?.let { add(sharedHtmlFallback(it)) }
    }
    val title = intent.getCharSequenceExtra(Intent.EXTRA_TITLE) ?: intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)
    val text = parts.joinToString("\n\n")
    val input = if (text.isNotBlank()) captureSharedText(text, title)
        else if (uris.isNotEmpty()) CaptureInput(title = title?.toString()?.take(512), source = CaptureSource.SHARE)
        else throw AppApiException(ApiError(ApiErrorCode.INVALID_ARGUMENT, "Share contains no material"))
    val content = uris.associateBy { UUID.randomUUID().toString() }
    return CaptureEntry(draftId, input.copy(imports = content.keys.map { CaptureImportSlot(it) }), content = content,
        shortcutId = readCaptureShortcutId(intent))
}

private fun sharedHtmlFallback(html: String): String {
    if (html.length > 256 * 1024) {
        throw AppApiException(ApiError(ApiErrorCode.INVALID_ARGUMENT, "Shared HTML exceeds limits"))
    }
    val rendered = Html.fromHtml(html, Html.FROM_HTML_MODE_COMPACT)
    val text = rendered.toString().replace('\u00a0', ' ').trim()
    val links = (rendered as? Spanned)?.getSpans(0, rendered.length, URLSpan::class.java)
        .orEmpty()
        .map(URLSpan::getURL)
        .filter { it.startsWith("https://", ignoreCase = true) || it.startsWith("http://", ignoreCase = true) }
        .distinct()
        .filterNot(text::contains)
    return (listOf(text).filter(String::isNotBlank) + links).joinToString("\n\n")
}

/** A present malformed ID is an unresolved explicit hint, not an ordinary share. */
internal fun readCaptureShortcutId(intent: Intent): String? = if (!intent.hasExtra(CaptureShortcutIds.EXTRA_ID)) null
    else runCatching { intent.getStringExtra(CaptureShortcutIds.EXTRA_ID) }.getOrNull()?.takeIf { it.length <= 256 } ?: ""

/** Only text and the typed read-only flag are material. No I/O, routing or submission. */
@Suppress("DEPRECATION")
internal fun readSelectedCapture(intent: Intent, draftId: String = UUID.randomUUID().toString(), hasReturnChannel: Boolean = false): CaptureEntry {
    if (intent.action != Intent.ACTION_PROCESS_TEXT || intent.type != "text/plain") {
        throw AppApiException(ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Unsupported selected-text input"))
    }
    val flag = if (intent.hasExtra(Intent.EXTRA_PROCESS_TEXT_READONLY)) intent.extras?.get(Intent.EXTRA_PROCESS_TEXT_READONLY) else true
    if (flag !is Boolean || intent.hasExtra(Intent.EXTRA_STREAM) || intent.data != null || (intent.clipData?.itemCount ?: 0) > 16 ||
        intent.clipData?.let { clip -> (0 until clip.itemCount).any { clip.getItemAt(it).uri != null || clip.getItemAt(it).intent != null } } == true) {
        throw AppApiException(ApiError(ApiErrorCode.INVALID_ARGUMENT, "Invalid selected-text payload"))
    }
    val readOnly = flag || !hasReturnChannel
    val input = captureSharedText(intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)).copy(
        source = CaptureSource.PROCESS_TEXT, selectionReadOnly = readOnly)
    return CaptureEntry(draftId, input, selectionMode = if (readOnly) CaptureSelectionMode.READ_ONLY else CaptureSelectionMode.REPLACEABLE)
}
