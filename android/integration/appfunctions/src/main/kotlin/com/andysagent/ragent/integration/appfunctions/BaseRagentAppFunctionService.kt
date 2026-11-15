@file:OptIn(androidx.appfunctions.ExperimentalAppFunctionsApi::class)

package com.andysagent.ragent.integration.appfunctions

import androidx.annotation.RequiresApi
import androidx.appfunctions.*
import androidx.appfunctions.metadata.AppFunctionMetadata
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Only the generated service is exported; the platform admits the trusted group first. */
@RequiresApi(36)
@AppFunctionServiceEntryPoint(serviceName = "RagentAppFunctionService", appFunctionXmlFileName = "ragent_appfunctions")
abstract class BaseRagentAppFunctionService : AppFunctionService() {
    private suspend fun <T> execute(block: suspend (AssistantTaskBridge) -> T): T = withContext(Dispatchers.IO) {
        try {
            val host = application as? AssistantAppFunctionsHost
                ?: throw AppFunctionAppUnknownException("INTERNAL_ERROR")
            block(host.assistantAppFunctions)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: AppApiException) {
            // Never return exception text, user instructions, identity bindings or private request keys.
            val code = error.error.code.name
            throw when (error.error.code) {
                ApiErrorCode.PERMISSION_DENIED, ApiErrorCode.AUTHENTICATION_REQUIRED -> AppFunctionDeniedException(code)
                ApiErrorCode.INVALID_ARGUMENT, ApiErrorCode.AMBIGUOUS_TARGET -> AppFunctionInvalidArgumentException(code)
                ApiErrorCode.TARGET_NOT_FOUND, ApiErrorCode.RESOURCE_NOT_FOUND -> AppFunctionElementNotFoundException(code)
                ApiErrorCode.RESOURCE_LIMIT, ApiErrorCode.RATE_LIMITED -> AppFunctionLimitExceededException(code)
                ApiErrorCode.REVISION_CONFLICT -> AppFunctionElementAlreadyExistsException(code)
                ApiErrorCode.CAPABILITY_UNSUPPORTED -> AppFunctionNotSupportedException(code)
                ApiErrorCode.CANCELLED -> AppFunctionCancelledException(code)
                else -> AppFunctionAppUnknownException(code)
            }
        } catch (error: AppFunctionException) { throw error }
        catch (_: Exception) { throw AppFunctionAppUnknownException("INTERNAL_ERROR") }
    }

    /**
     * Discover owner-authorized paired computers and delegation references. This does not prove online availability.
     * @param pageSize Optional page size, 1–32; omitted means 16.
     * @param cursor Prior nextCursor; restart discovery on REVISION_CONFLICT.
     */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    @AppFunctionAccessLevel(level = AppFunctionMetadata.ACCESS_LEVEL_ANDROID_TRUSTED, isCompatEnforcementEnabled = true)
    suspend fun listComputers(pageSize: Int? = null, cursor: String? = null): FunctionComputerPage = execute { bridge ->
        val page = bridge.listComputers(pageSize ?: 16, cursor)
        FunctionComputerPage(page.items.map { FunctionComputer(it.delegationId, it.instanceId, it.label) }, page.nextCursor, page.observedAt)
    }

    /**
     * Prepare one task without dispatching PC work. Use an explicit computer and an owner delegation.
     * @param delegationId Reference returned by computer discovery; never an Owner identity.
     * @param task Stable requestId, actual tool and explicit instructions/materials. Repeat identical input to recover a lost preparation.
     */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    @AppFunctionAccessLevel(level = AppFunctionMetadata.ACCESS_LEVEL_ANDROID_TRUSTED, isCompatEnforcementEnabled = true)
    suspend fun prepareTask(delegationId: String, task: FunctionTaskInput): FunctionPreparedTask = execute { bridge ->
        val p = bridge.prepare(delegationId, task.toCore())
        FunctionPreparedTask(p.delegationId, p.operationId, p.preparationId, p.targetInstanceId, p.deadlineAt, p.stage)
    }

    /**
     * Explicitly submit an original preparation to its frozen computer. ACCEPTED is not Run completion.
     * @param delegationId The preparation's delegation.
     * @param preparationId Original preparation reference. Do not create a new request to resolve response loss.
     */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    @AppFunctionAccessLevel(level = AppFunctionMetadata.ACCESS_LEVEL_ANDROID_TRUSTED, isCompatEnforcementEnabled = true)
    suspend fun submitPreparedTask(delegationId: String, preparationId: String): FunctionTaskStatus =
        execute { it.commit(delegationId, preparationId).toFunction() }

    /** Query a persisted submission without dispatching or polling the PC. */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    @AppFunctionAccessLevel(level = AppFunctionMetadata.ACCESS_LEVEL_ANDROID_TRUSTED, isCompatEnforcementEnabled = true)
    suspend fun getTaskSubmission(delegationId: String, operationId: String): FunctionTaskStatus =
        execute { it.get(delegationId, operationId).toFunction() }

    /** Check the original PC receipt after response loss. This is read-only and never resubmits work. */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    @AppFunctionAccessLevel(level = AppFunctionMetadata.ACCESS_LEVEL_ANDROID_TRUSTED, isCompatEnforcementEnabled = true)
    suspend fun reconcileTaskSubmission(delegationId: String, operationId: String): FunctionTaskStatus =
        execute { it.reconcile(delegationId, operationId).toFunction() }

    /** Cancel only a not-yet-dispatched submission. This does not stop an accepted PC Run. */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    @AppFunctionAccessLevel(level = AppFunctionMetadata.ACCESS_LEVEL_ANDROID_TRUSTED, isCompatEnforcementEnabled = true)
    suspend fun cancelUnsubmittedTask(delegationId: String, operationId: String): FunctionTaskStatus =
        execute { it.cancelSubmission(delegationId, operationId).toFunction() }

    /** Read the exact original task result. Report publication state, truncation and cache freshness separately. */
    @AppFunctionDeclaration(isDescribedByKDoc = true)
    @AppFunctionAccessLevel(level = AppFunctionMetadata.ACCESS_LEVEL_ANDROID_TRUSTED, isCompatEnforcementEnabled = true)
    suspend fun readTaskResult(delegationId: String, operationId: String): FunctionTaskResult = execute { bridge ->
        val r = bridge.readResult(delegationId, operationId)
        FunctionTaskResult(r.submission.toFunction(), r.resultState, r.text, r.textTruncated, r.finalRunId,
            r.artifacts.map { FunctionArtifact(it.assetId, it.name, it.mimeType, it.sizeBytes) }, r.hasAttachments, r.observedAt, r.cached)
    }
}
