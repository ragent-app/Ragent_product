@file:OptIn(androidx.appfunctions.ExperimentalAppFunctionsApi::class)

package com.andysagent.ragent

import android.content.ComponentName
import android.content.pm.PackageManager
import android.os.Build
import androidx.appfunctions.*
import androidx.appfunctions.metadata.*
import androidx.test.core.app.ApplicationProvider
import androidx.test.filters.SdkSuppress
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.datastore.LinkedComputer
import com.andysagent.ragent.integration.appfunctions.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** Real system discovery/execute, real graph and Room; synthetic target never connects to a PC. */
class AppFunctionsPlatformTest {
    private val app get() = ApplicationProvider.getApplicationContext<RagentApplication>()
    private val serviceName = "com.andysagent.ragent.integration.appfunctions.RagentAppFunctionService"

    @Test fun generatedServiceIsPermissionProtectedAndOnlyEnabledOnSupportedPlatform() {
        @Suppress("DEPRECATION")
        val service = app.packageManager.getServiceInfo(ComponentName(app, serviceName), PackageManager.MATCH_DISABLED_COMPONENTS)
        assertTrue(service.exported)
        assertEquals("android.permission.BIND_APP_FUNCTION_SERVICE", service.permission)
        assertEquals(Build.VERSION.SDK_INT >= 36, service.enabled)
        assertTrue(app is AssistantAppFunctionsHost)
        if (Build.VERSION.SDK_INT >= 36) {
            val metadata = app.packageManager.getProperty(
                "android.app.appfunctions.app_metadata", app.packageName
            )
            assertTrue("AppFunctions app metadata must resolve to an XML resource", metadata.resourceId != 0)
            assertEquals("xml", app.resources.getResourceTypeName(metadata.resourceId))
            assertEquals("app_metadata", app.resources.getResourceEntryName(metadata.resourceId))
        }
    }

    private suspend fun metadata(): Map<String, AppFunctionMetadata> = withTimeout(60_000) {
        val manager = requireNotNull(AppFunctionManager.getInstance(app))
        var found: List<AppFunctionMetadata>
        do {
            found = manager.searchAppFunctions(AppFunctionSearchSpec(packageNames = setOf(app.packageName)))
            if (found.size != 7) delay(250)
        } while (found.size != 7)
        found.associateBy { it.id.substringAfterLast('#') }
    }

    private suspend fun invoke(function: AppFunctionMetadata, configure: AppFunctionData.Builder.() -> Unit = {}): ExecuteAppFunctionResponse =
        withTimeout(20_000) {
            val input = AppFunctionData.Builder(function.parameters, function.components).apply(configure).build()
            requireNotNull(AppFunctionManager.getInstance(app)).executeAppFunction(ExecuteAppFunctionRequest(app.packageName, function.id, input))
        }

    private inline fun <reified T : Any> ExecuteAppFunctionResponse.value(): T {
        assertTrue("Expected platform success, got $this", this is ExecuteAppFunctionResponse.Success)
        return (this as ExecuteAppFunctionResponse.Success).returnValue
            .getAppFunctionData(ExecuteAppFunctionResponse.Success.PROPERTY_RETURN_VALUE)!!.deserialize(T::class.java)
    }

    private fun ExecuteAppFunctionResponse.error(type: Class<out AppFunctionException>, code: String) {
        assertTrue("Expected platform error, got $this", this is ExecuteAppFunctionResponse.Error)
        val error = (this as ExecuteAppFunctionResponse.Error).error
        assertTrue("Wrong error class: ${error.javaClass}", type.isInstance(error))
        assertEquals(code, error.message)
    }

    @Test @SdkSuppress(minSdkVersion = 36)
    fun systemIndexesTypedToolsAndEnforcesBusinessBounds() = runBlocking {
        val functions = metadata()
        assertEquals(setOf("listComputers", "prepareTask", "submitPreparedTask", "getTaskSubmission",
            "reconcileTaskSubmission", "cancelUnsubmittedTask", "readTaskResult"), functions.keys)
        functions.values.forEach {
            assertEquals(app.packageName, it.packageName)
            assertEquals(AppFunctionMetadata.ACCESS_LEVEL_ANDROID_TRUSTED, it.accessLevel)
            assertTrue(it.isCompatEnforcementEnabled)
            assertTrue(it.description.isNotBlank())
        }
        val list = functions.getValue("listComputers")
        val page = invoke(list).value<FunctionComputerPage>()
        val graph = app.runtime
        val expected = graph.assistantTasks.listComputers()
        assertEquals(expected.items.map { it.delegationId to it.instanceId }, page.computers.map { it.delegationId to it.instanceId })
        invoke(list) { setInt("pageSize", 33) }.error(AppFunctionInvalidArgumentException::class.java, "INVALID_ARGUMENT")
        invoke(functions.getValue("getTaskSubmission")) {
            setString("delegationId", UUID.randomUUID().toString()); setString("operationId", "unknown")
        }.error(AppFunctionDeniedException::class.java, "PERMISSION_DENIED")
    }

    @Test @SdkSuppress(minSdkVersion = 36)
    fun systemPrepareQueryCancelAndRevocationUseOnePersistentOperation() = runBlocking {
        val graph = app.runtime
        val id = "appfunctions-platform-${UUID.randomUUID()}"
        graph.configStore.upsertComputer(LinkedComputer(id, "", "Synthetic AppFunctions PC", autoConnect = false))
        graph.appApi.listTargets(graph.appApiOwner)
        try {
            val functions = metadata()
            val row = graph.assistantDelegations.approve(graph.appApiOwner,
                AssistantDelegationScope(AssistantTaskCapabilities.ids, setOf(id), System.currentTimeMillis() + 600_000, mayCreateSessions = true),
                graph.assistantDelegations.reviewContext(graph.appApiOwner))
            val delegationId = row.id
            val page = invoke(functions.getValue("listComputers")).value<FunctionComputerPage>()
            assertEquals(listOf(id), page.computers.filter { it.delegationId == delegationId }.map { it.instanceId })
            val prepare = functions.getValue("prepareTask")
            val taskMetadata = prepare.parameters.single { it.name == "task" }.dataType
            val objectType = when (taskMetadata) {
                is AppFunctionObjectTypeMetadata -> taskMetadata
                is AppFunctionReferenceTypeMetadata -> prepare.components.dataTypes.getValue(taskMetadata.referenceDataType) as AppFunctionObjectTypeMetadata
                else -> error("Unexpected task schema $taskMetadata")
            }
            val input = FunctionTaskInput("test-request-${UUID.randomUUID()}", id, "仅准备任务，不执行 PC 工作", "codex",
                sharedText = "网页材料 🧪", sourceUrls = listOf("https://example.com/article"))
            suspend fun prepareTask(task: FunctionTaskInput): ExecuteAppFunctionResponse = invoke(prepare) {
                setString("delegationId", delegationId)
                setAppFunctionData("task", AppFunctionData.serialize(objectType, prepare.components, task))
            }
            val prepared = prepareTask(input).value<FunctionPreparedTask>()
            assertEquals(id, prepared.targetInstanceId)
            assertEquals("PREPARED", prepared.submissionStage)
            assertEquals(prepared, prepareTask(input).value<FunctionPreparedTask>())
            prepareTask(input.copy(instruction = "Changed parameters")).error(AppFunctionElementAlreadyExistsException::class.java, "REVISION_CONFLICT")
            val get = functions.getValue("getTaskSubmission")
            suspend fun query(function: AppFunctionMetadata): ExecuteAppFunctionResponse = invoke(function) {
                setString("delegationId", delegationId); setString("operationId", prepared.operationId)
            }
            val status = query(get).value<FunctionTaskStatus>()
            assertEquals("PREPARED", status.submissionStage)
            assertNull(status.sessionId); assertNull(status.runId)
            assertEquals(status, query(functions.getValue("reconcileTaskSubmission")).value<FunctionTaskStatus>())
            query(functions.getValue("readTaskResult")).error(AppFunctionInvalidArgumentException::class.java, "INVALID_ARGUMENT")
            val cancelled = query(functions.getValue("cancelUnsubmittedTask")).value<FunctionTaskStatus>()
            assertEquals("CANCELLED", cancelled.submissionStage)
            invoke(functions.getValue("submitPreparedTask")) {
                setString("delegationId", delegationId); setString("preparationId", prepared.preparationId)
            }.error(AppFunctionCancelledException::class.java, "CANCELLED")
            graph.assistantDelegations.revoke(graph.appApiOwner, delegationId, row.revision)
            query(get).error(AppFunctionDeniedException::class.java, "PERMISSION_DENIED")
            assertFalse(invoke(functions.getValue("listComputers")).value<FunctionComputerPage>().computers.any { it.delegationId == delegationId })
        } finally {
            graph.disconnectTarget(id)
            graph.assistantDelegations.list(graph.appApiOwner).filter { id in it.scope.targetIds }.forEach {
                assertNotNull(it.revokedAt)
                assertTrue(graph.assistantDelegations.deleteRevoked(graph.appApiOwner, it.id, it.revision))
            }
        }
    }
}
