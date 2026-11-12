package com.andysagent.agentoc.feature.workbench

import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiResponse
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.domain.AccountDirectoryDevice
import com.andysagent.agentoc.core.protocol.AgentocProtocol
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.buildJsonArray

/** Pages that exist as first-class surfaces in the Web workbench. */
enum class WebParityPage(val title: String) {
    Agents("Agents & apps"),
    Connectors("Connectors"),
    ModelProviders("Model providers"),
    Harnesses("Harnesses"),
    Devices("Manage devices"),
    Files("Workspace files"),
    Triggers("Scheduled work"),
    Usage("Usage"),
}

data class WebAgent(
    val id: String,
    val name: String,
    val tool: String,
    val builtin: Boolean,
    val description: String,
    val welcomeMessage: String = "",
    val skills: List<String> = emptyList(),
    val perMessageSystemPrompt: JsonObject? = null,
    val templateContext: JsonObject? = null,
    val collaborationPolicy: JsonObject? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
)

data class WebConnector(
    val id: String,
    val name: String,
    val detail: String,
    val ready: Boolean,
    val entryUrl: String = "",
    val allowEmbed: Boolean = false,
    val description: String = "",
    val surfaceType: String = "",
)

data class WebMcpServer(
    val family: String,
    val name: String,
    val detail: String,
    val providerId: String = "",
    val authState: String = "unknown",
)

data class WebMcpOAuthJob(val id: String, val providerId: String, val serverName: String, val url: String, val state: String, val mobileCallbackSupported: Boolean = false, val callbackSubmitted: Boolean = false)
data class WebCodexSkill(val id: String, val providerId: String, val name: String, val enabled: Boolean, val desiredEnabled: Boolean)
data class WebCodexApp(val id: String, val providerId: String, val name: String, val runtime: String, val configuration: String, val accessible: Boolean?)
data class WebCodexPluginPreference(val providerId: String, val desiredEnabled: Boolean)
data class WebCodexSyncState(val providerId: String, val status: String, val mode: String = "approved-auto")

data class WebProvider(
    val id: String,
    val name: String,
    val detail: String,
    val ready: Boolean,
    val agentType: String = "codex",
    val authType: String = "api-key",
    val baseUrl: String = "",
    val defaultModel: String = "",
    val protocol: String = "responses",
    val enabled: Boolean = true,
    val quota: String = "",
    val quotaSnapshot: JsonObject? = null,
    val modelCount: Int = 0,
    val hasRefreshToken: Boolean = false,
    val syncId: String = "",
    val credentialFingerprint: String = "",
    val modelPolicyIdentity: String = "",
    val quotaPolicyIdentity: String = "",
)

data class WebHarness(
    val id: String,
    val name: String,
    val version: String = "",
    val installed: Boolean = false,
    val commandAvailable: Boolean = false,
    val supportedOnPlatform: Boolean = true,
    val installationSource: String = "",
    val providerProtocols: List<String>? = null,
    val globallyInstalled: Boolean = false,
)

data class WebHarnessTarget(
    val instanceId: String,
    val label: String,
    val available: Boolean = true,
    val detail: String = "",
    val installedHarnessIds: Set<String> = emptySet(),
    val supportedHarnessIds: Set<String>? = null,
)

data class WebHarnessTargetSnapshot(
    val target: WebHarnessTarget,
    val harnesses: List<WebHarness> = emptyList(),
)

data class WebHarnessMutationResult(
    val instanceId: String,
    val label: String,
    val success: Boolean,
    val error: String? = null,
)

enum class WebHarnessOperation { Install, Upgrade, Uninstall }

data class WebDevice(
    val id: String,
    val instanceId: String = "",
    val name: String,
    val platform: String,
    val status: String,
    val revocable: Boolean,
    val accountOwned: Boolean = false,
    val enrollmentKind: String = "",
    val authVersion: Int? = null,
    val keyAlgorithm: String = "",
    val createdAt: String = "",
    val lastSeenAt: String = "",
    val entryUrl: String = "",
)

data class WebFile(
    val path: String,
    val directory: Boolean,
    val size: String,
)

data class WebFilePayload(
    val name: String,
    val mimeType: String,
    val bytes: ByteArray,
)

/** A directory node exposed by the remote project-location browser. */
data class ProjectFolderLocation(
    val name: String,
    val path: String,
)

/** Direct children only: clients navigate one folder at a time. */
data class ProjectFolderListing(
    val path: String,
    val parent: String?,
    val children: List<ProjectFolderLocation>,
)

/**
 * Project folders live on the connected computer, never on Android storage.
 * This small contract keeps the Compose picker independent from the transport.
 */
class ProjectFolderBrowser(
    val loadRoots: suspend () -> List<ProjectFolderLocation>,
    val loadDirectory: suspend (String) -> ProjectFolderListing,
)

data class WebTrigger(
    val id: String,
    val title: String,
    val text: String,
    val scheduledAt: String,
    val status: String,
    val enabled: Boolean,
    val sessionId: String = "",
    val tool: String = "",
    val model: String = "",
    val effort: String = "",
    val thinking: Boolean = false,
    val deliveryAttempts: Int = 0,
    val nextAttemptAt: String = "",
    val runId: String = "",
    val lastError: String = "",
)

@Immutable
data class WebParityUiState(
    val page: WebParityPage? = null,
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val actionInProgress: Boolean = false,
    val fileReadInProgress: Boolean = false,
    val folderReadInProgress: Boolean = false,
    val error: String? = null,
    val statusMessage: String? = null,
    val agents: List<WebAgent> = emptyList(),
    val availableTools: List<String> = emptyList(),
    val connectors: List<WebConnector> = emptyList(),
    val mcpServers: List<WebMcpServer> = emptyList(),
    val mcpOAuthJob: WebMcpOAuthJob? = null,
    val codexSkills: List<WebCodexSkill> = emptyList(),
    val codexApps: List<WebCodexApp> = emptyList(),
    val codexPluginPreference: WebCodexPluginPreference? = null,
    val codexSyncState: WebCodexSyncState? = null,
    val codexManagementProviderId: String? = null,
    val providers: List<WebProvider> = emptyList(),
    val harnesses: List<WebHarness> = emptyList(),
    val providerHarnessesLoaded: Boolean = false,
    val providerCrossInstance: Boolean = false,
    val providerInstances: List<ProviderInstanceSnapshot> = emptyList(),
    val providerTargetId: String? = null,
    val providerSavedTarget: String? = null,
    val harnessTargets: List<WebHarnessTarget> = emptyList(),
    val devices: List<WebDevice> = emptyList(),
    val files: List<WebFile> = emptyList(),
    val fileContent: String? = null,
    val selectedFile: String? = null,
    val fileDirectory: String = "",
    val filePayload: WebFilePayload? = null,
    val triggers: List<WebTrigger> = emptyList(),
    val usageSummary: String? = null,
    val usage: JsonObject? = null,
    /** Current chat context for web-parity pages such as scheduled work. */
    val openSessionId: String? = null,
    /** One-time request to reveal a session created from a web-parity action. */
    val pendingOpenSessionId: String? = null,
    val triggerTool: String = "codex",
    val triggerModel: String? = null,
    val triggerEffort: String? = null,
    val triggerThinking: Boolean = false,
    val externalUrl: String? = null,
    val providerOAuthJob: ProviderOAuthJob? = null,
    val providerOAuthTargetLabel: String? = null,
    val providerOAuthPolling: Boolean = false,
    val providerRotationEnabled: Boolean = false,
    val providerRotationIds: List<String> = emptyList(),
)

sealed interface WebParityEvent {
    data class SelectProviderInstance(val id: String?) : WebParityEvent
    data class RetryProviderInstance(val id: String) : WebParityEvent
    data class OpenPage(val page: WebParityPage) : WebParityEvent
    data object Refresh : WebParityEvent
    data class RefreshAfterReconnect(val targetId: String) : WebParityEvent
    data class TargetChanged(val targetId: String?) : WebParityEvent
    data class CreateAgent(
        val name: String,
        val systemPrompt: String,
        val tool: String,
        val welcomeMessage: String = "",
        val skills: List<String> = emptyList(),
        val perMessageSystemPrompt: JsonObject? = null,
        val templateContext: JsonObject? = null,
        val collaborationPolicy: JsonObject? = null,
    ) : WebParityEvent
    data class UpdateAgent(
        val id: String,
        val name: String,
        val systemPrompt: String,
        val tool: String,
        val welcomeMessage: String,
        val skills: List<String>,
        val perMessageSystemPrompt: JsonObject? = null,
        val templateContext: JsonObject? = null,
        val collaborationPolicy: JsonObject? = null,
    ) : WebParityEvent
    data class DeleteAgent(val id: String) : WebParityEvent
    data class StartAgent(val id: String, val projectId: String? = null) : WebParityEvent
    data class AddMcpServer(val family: String, val name: String, val commandOrUrl: String, val providerId: String = "", val args: List<String> = emptyList()) : WebParityEvent
    data class DeleteMcpServer(val family: String, val name: String, val providerId: String = "") : WebParityEvent
    data class StartMcpOAuth(val providerId: String, val serverName: String) : WebParityEvent
    data class SubmitMcpOAuthCallback(val callbackUrl: String) : WebParityEvent
    data object CheckMcpOAuth : WebParityEvent
    data object ClearMcpOAuth : WebParityEvent
    data class SetCodexSkill(val sessionId: String, val skill: WebCodexSkill, val enabled: Boolean) : WebParityEvent
    data class SetCodexPluginPreference(val providerId: String, val enabled: Boolean) : WebParityEvent
    data class RefreshCodexSync(val providerId: String) : WebParityEvent
    data class SetCodexSyncPolicy(val providerId: String, val mode: String) : WebParityEvent
    data class SelectCodexManagementProvider(val providerId: String) : WebParityEvent
    data class StartConnectorOAuth(val id: String) : WebParityEvent
    data class DisconnectConnector(val id: String) : WebParityEvent
    data class RevokeDevice(val id: String) : WebParityEvent
    data class RenameDevice(val id: String, val name: String) : WebParityEvent
    data class OpenFile(val path: String, val sessionId: String? = null) : WebParityEvent
    data class OpenDirectory(val path: String) : WebParityEvent
    data object ParentDirectory : WebParityEvent
    data object CloseFile : WebParityEvent
    data class CreateTrigger(
        val title: String,
        val text: String,
        val delayMinutes: String,
        val sessionId: String?,
        val tool: String = "codex",
        val model: String? = null,
        val effort: String? = null,
        val thinking: Boolean = false,
    ) : WebParityEvent
    data class ToggleTrigger(val id: String, val enabled: Boolean) : WebParityEvent
    data class UpdateTrigger(
        val id: String,
        val title: String,
        val text: String,
        val delayMinutes: String,
        val sessionId: String?,
        val tool: String,
        val model: String?,
        val effort: String?,
        val thinking: Boolean,
    ) : WebParityEvent
    data class RetryTrigger(val id: String) : WebParityEvent
    data class DeleteTrigger(val id: String) : WebParityEvent
    data class CreateProviderApiKey(
        val agentType: String,
        val displayName: String,
        val baseUrl: String,
        val apiKey: String,
        val defaultModel: String,
        val protocol: String,
    ) : WebParityEvent
    data class StartProviderOAuth(val agentType: String, val displayName: String, val providerId: String? = null) : WebParityEvent
    data object CheckProviderOAuth : WebParityEvent
    data object OpenProviderOAuth : WebParityEvent
    data object ProviderOAuthBrowserFailed : WebParityEvent
    data class SubmitProviderOAuthCredential(val credential: String) : WebParityEvent
    data object CancelProviderOAuth : WebParityEvent
    data class ToggleProviderRotation(val enabled: Boolean) : WebParityEvent
    data class ToggleProviderRotationProvider(val id: String, val selected: Boolean) : WebParityEvent
    data class DeleteProvider(val id: String) : WebParityEvent
    data class UpdateProvider(
        val id: String,
        val displayName: String,
        val baseUrl: String,
        val apiKey: String,
        val defaultModel: String,
        val protocol: String,
        val enabled: Boolean,
    ) : WebParityEvent
    data class RefreshProviderQuota(val id: String) : WebParityEvent
    data class InstallHarness(val id: String, val targetInstanceIds: List<String> = emptyList()) : WebParityEvent
    data class UpgradeHarness(val id: String, val targetInstanceIds: List<String> = emptyList()) : WebParityEvent
    data class UninstallHarness(val id: String, val targetInstanceIds: List<String> = emptyList()) : WebParityEvent
    data object ClearExternalUrl : WebParityEvent
}

/**
 * Thin owner-scoped API projection for the parts of the Web UI that are not
 * session timeline data. It deliberately uses the existing transport and
 * keeps response parsing tolerant of newer server fields.
 */
class WebParityRepository(private val execute: suspend (ApiRequest) -> ApiResponse) {
    constructor(transport: AgentoCTransport) : this({ request -> transport.execute(request) })
    suspend fun load(page: WebParityPage, sessionId: String? = null, codexProviderId: String? = null): WebParitySnapshot = when (page) {
        WebParityPage.Agents -> WebParitySnapshot(agents = loadAgents(), availableTools = loadTools())
        WebParityPage.Connectors -> loadConnectors(sessionId, codexProviderId)
        WebParityPage.ModelProviders -> {
            val providers = loadProviders()
            val harnesses = try { loadHarnesses() } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }
            WebParitySnapshot(providers = providers, harnesses = harnesses.orEmpty(), providerHarnessesLoaded = harnesses != null)
        }
        WebParityPage.Harnesses -> WebParitySnapshot(harnesses = loadHarnesses())
        // Device management is an Accounts directory concern. A target runtime
        // must never be used as a fallback for this page.
        WebParityPage.Devices -> WebParitySnapshot()
        WebParityPage.Files -> WebParitySnapshot(files = loadFiles())
        WebParityPage.Triggers -> WebParitySnapshot(triggers = loadTriggers())
        WebParityPage.Usage -> WebParitySnapshot(usage = loadUsage())
    }

    suspend fun createAgent(name: String, systemPrompt: String, tool: String, welcomeMessage: String, skills: List<String>, perMessageSystemPrompt: JsonObject? = null, templateContext: JsonObject? = null, collaborationPolicy: JsonObject? = null) {
        request("POST", "/api/agents", jsonObject {
            put("name", name.trim().ifBlank { "Untitled Agent" })
            put("systemPrompt", systemPrompt.trim())
            put("tool", tool.trim().ifBlank { "codex" })
            put("welcomeMessage", welcomeMessage.trim())
            put("skills", buildJsonArray { skills.map(String::trim).filter(String::isNotEmpty).distinct().forEach { add(JsonPrimitive(it)) } })
            put("perMessageSystemPrompt", perMessageSystemPrompt ?: JsonNull)
            put("templateContext", templateContext ?: JsonNull)
            put("collaborationPolicy", collaborationPolicy ?: JsonNull)
        })
    }

    suspend fun updateAgent(id: String, name: String, systemPrompt: String, tool: String, welcomeMessage: String, skills: List<String>, perMessageSystemPrompt: JsonObject? = null, templateContext: JsonObject? = null, collaborationPolicy: JsonObject? = null) {
        request("PATCH", "/api/agents/${path(id)}", jsonObject {
            put("name", name.trim().ifBlank { "Untitled Agent" })
            put("systemPrompt", systemPrompt.trim())
            put("tool", tool.trim().ifBlank { "codex" })
            put("welcomeMessage", welcomeMessage.trim())
            put("skills", buildJsonArray { skills.map(String::trim).filter(String::isNotEmpty).distinct().forEach { add(JsonPrimitive(it)) } })
            put("perMessageSystemPrompt", perMessageSystemPrompt ?: JsonNull)
            put("templateContext", templateContext ?: JsonNull)
            put("collaborationPolicy", collaborationPolicy ?: JsonNull)
        })
    }

    suspend fun deleteAgent(id: String) { request("DELETE", "/api/agents/${path(id)}") }

    suspend fun createProviderApiKey(
        agentType: String,
        displayName: String,
        baseUrl: String,
        apiKey: String,
        defaultModel: String,
        protocol: String,
    ) {
        request("POST", "/api/native-providers", jsonObject {
            put("agentType", agentType)
            put("displayName", displayName.trim())
            put("baseUrl", baseUrl.trim())
            put("apiKey", apiKey.trim())
            put("defaultModel", defaultModel.trim())
            if (agentType != "claude" && agentType != "agy") put("protocol", protocol)
        })
    }

    suspend fun startProviderOAuth(agentType: String, displayName: String, providerId: String? = null): ProviderOAuthJob {
        val root = request("POST", "/api/native-provider-oauth/jobs", jsonObject {
            put("agentType", agentType)
            put("displayName", displayName.trim())
            providerId?.let { put("providerId", it); put("replaceExisting", true) }
        })
        return parseProviderOAuthJob(root["job"]?.jsonObject ?: error("OAuth job did not start"))
    }

    suspend fun loadProviderOAuthJob(jobId: String): ProviderOAuthJob =
        parseProviderOAuthJob(request("GET", "/api/native-provider-oauth/jobs/${path(jobId)}")["job"]?.jsonObject
            ?: error("OAuth job could not be read")).also { require(it.id == jobId) { "Provider login job changed" } }

    suspend fun submitProviderOAuthCredential(jobId: String, credential: String) {
        require(credential.trim().isNotEmpty()) { "Credential is required" }
        request("POST", "/api/native-provider-oauth/jobs/${path(jobId)}/input", jsonObject {
            put("credential", credential.trim())
        })
    }

    suspend fun loadProviderRotation(): Pair<Boolean, List<String>> {
        val rotation = request("GET", "/api/native-providers/agy/rotation")["rotation"]?.jsonObject
        return (rotation?.boolean("enabled") ?: false) to rotation?.get("providerIds")?.jsonArray.orEmpty()
            .mapNotNull { it.jsonPrimitive.contentOrNull }
    }

    suspend fun updateProviderRotation(enabled: Boolean, providerIds: List<String>) {
        request("PATCH", "/api/native-providers/agy/rotation", jsonObject {
            put("enabled", enabled)
            put("providerIds", buildJsonArray { providerIds.forEach { add(JsonPrimitive(it)) } })
        })
    }

    suspend fun cancelProviderOAuth(jobId: String) { request("DELETE", "/api/native-provider-oauth/jobs/${path(jobId)}") }

    suspend fun startAgent(id: String, projectId: String?): String {
        val agent = loadAgents().firstOrNull { it.id == id } ?: error("Agent not found")
        val body = jsonObject {
            put("name", agent.name)
            put("tool", agent.tool.ifBlank { "codex" })
            put("templateId", agent.id)
            put("folder", "~")
            projectId?.takeIf { it.isNotBlank() }?.let { put("projectId", it) }
        }
        val root = request("POST", "/api/sessions", body)
        return root["session"]?.jsonObject?.string("id") ?: error("Session response did not include an id")
    }

    suspend fun addMcpServer(family: String, name: String, commandOrUrl: String, providerId: String = "", args: List<String> = emptyList()) {
        val route = if (family == "claude") "/api/claude/mcp-servers" else {
            require(providerId.isNotBlank()) { "Select a Codex account" }
            "/api/providers/${path(providerId)}/codex/mcp-servers"
        }
        val body = jsonObject {
            put("name", name.trim())
            val value = commandOrUrl.trim()
            if (value.startsWith("http://", ignoreCase = true) || value.startsWith("https://", ignoreCase = true)) put("url", value)
            else {
                put("command", value)
                if (family == "codex" && args.isNotEmpty()) put("args", buildJsonArray { args.forEach { add(JsonPrimitive(it)) } })
            }
        }
        request("POST", route, body)
    }

    suspend fun deleteMcpServer(family: String, name: String, providerId: String = "") {
        val route = if (family == "claude") "/api/claude/mcp-servers" else {
            require(providerId.isNotBlank()) { "Select a Codex account" }
            "/api/providers/${path(providerId)}/codex/mcp-servers"
        }
        request("DELETE", "$route/${path(name)}")
    }

    suspend fun startMcpOAuth(providerId: String, serverName: String): WebMcpOAuthJob {
        require(providerId.isNotBlank()) { "Select a Codex account" }
        val result = request("POST", "/api/providers/${path(providerId)}/codex/mcp-servers/${path(serverName)}/oauth")
        val url = result.string("authorizationUrl") ?: error("Authorization URL was not returned")
        require(url.startsWith("https://") || url.startsWith("http://")) { "Invalid authorization URL" }
        return WebMcpOAuthJob(result.string("id") ?: error("Authorization job was not returned"), providerId, serverName, url, result.string("state") ?: "pending", result.boolean("mobileCallbackSupported"))
    }

    suspend fun checkMcpOAuth(job: WebMcpOAuthJob): WebMcpOAuthJob {
        val route = "/api/providers/${path(job.providerId)}/codex/mcp-servers/${path(job.serverName)}/oauth/${path(job.id)}"
        val result = request("GET", route)
        return job.copy(state = result.string("state") ?: "unknown")
    }

    suspend fun cancelMcpOAuth(job: WebMcpOAuthJob) {
        request("DELETE", "/api/providers/${path(job.providerId)}/codex/mcp-servers/${path(job.serverName)}/oauth/${path(job.id)}")
    }

    suspend fun submitMcpOAuthCallback(job: WebMcpOAuthJob, callbackUrl: String) {
        val route = "/api/providers/${path(job.providerId)}/codex/mcp-servers/${path(job.serverName)}/oauth/${path(job.id)}"
        request("POST", route, jsonObject { put("callbackUrl", callbackUrl) })
    }

    suspend fun setCodexSkill(sessionId: String, skill: WebCodexSkill, enabled: Boolean) {
        request("POST", "/api/sessions/${path(sessionId)}/harness-capabilities/skills", jsonObject {
            put("providerProfileId", skill.providerId); put("id", skill.id); put("enabled", enabled)
        })
    }

    suspend fun setCodexPluginPreference(providerId: String, enabled: Boolean) {
        request("POST", "/api/providers/${path(providerId)}/codex/plugin-preference", jsonObject { put("enabled", enabled) })
    }

    suspend fun refreshCodexSync(providerId: String) {
        request("POST", "/api/providers/${path(providerId)}/codex/capability-sync")
    }

    suspend fun setCodexSyncPolicy(providerId: String, mode: String) {
        require(mode in setOf("approved-auto", "manual", "disabled"))
        request("POST", "/api/providers/${path(providerId)}/codex/capability-sync-policy", jsonObject { put("mode", mode) })
    }

    suspend fun startConnectorOAuth(id: String): String {
        val route = when {
            id.contains("github", ignoreCase = true) -> "/api/connectors/github/authorize"
            id.contains("google", ignoreCase = true) || id.contains("calendar", ignoreCase = true) -> "/api/connectors/calendar/google/authorize"
            else -> error("This connector does not expose an OAuth flow")
        }
        return request("POST", route, jsonObject {})["authUrl"]?.jsonPrimitive?.contentOrNull
            ?: error("Connector authorization URL was not returned")
    }

    suspend fun disconnectConnector(id: String) {
        val route = when {
            id.contains("github", ignoreCase = true) -> "/api/connectors/github/disconnect"
            else -> error("This connector cannot be disconnected from Android yet")
        }
        request("POST", route)
    }

    suspend fun loadFile(path: String, sessionId: String? = null): WebFilePayload {
        val scope = sessionId?.takeIf(String::isNotBlank)?.let { "sessionId=${path(it)}" } ?: "workspace=~"
        val response = execute(ApiRequest("GET", "/api/workspace-files/content?$scope&path=${path(path)}"))
        if (!response.isSuccessful) error("File could not be opened")
        val bytes = response.bodyBytes ?: response.body.toByteArray(Charsets.UTF_8)
        val mimeType = response.headers.entries.firstOrNull { it.key.equals("Content-Type", ignoreCase = true) }
            ?.value?.substringBefore(';')?.trim().orEmpty().ifBlank { "application/octet-stream" }
        val name = response.headers.entries.firstOrNull { it.key.equals("Content-Disposition", ignoreCase = true) }
            ?.value?.substringAfter("filename=", "")?.trim(' ', '"')?.takeIf { it.isNotBlank() }
            ?: path.substringAfterLast('/').ifBlank { "download" }
        return WebFilePayload(name, mimeType, bytes)
    }

    suspend fun loadProjectFolderRoots(): List<ProjectFolderLocation> {
        val root = browseRequest("/api/browse?roots=1")
        return root["roots"]?.jsonArray.orEmpty().mapNotNull { value ->
            val item = value.jsonObject
            val path = item.string("path") ?: return@mapNotNull null
            ProjectFolderLocation(
                name = item.string("name")?.takeIf(String::isNotBlank) ?: path,
                path = path,
            )
        }
    }

    suspend fun loadProjectFolderDirectory(path: String): ProjectFolderListing {
        val root = browseRequest("/api/browse?path=${path(path)}&mode=directories")
        return ProjectFolderListing(
            path = root.string("path")?.takeIf(String::isNotBlank) ?: path,
            parent = root.string("parent")?.takeIf(String::isNotBlank),
            children = root["children"]?.jsonArray.orEmpty().mapNotNull { value ->
                val item = value.jsonObject
                val childPath = item.string("path") ?: return@mapNotNull null
                ProjectFolderLocation(
                    name = item.string("name")?.takeIf(String::isNotBlank) ?: childPath,
                    path = childPath,
                )
            },
        )
    }

    suspend fun createTrigger(
        title: String,
        text: String,
        delayMinutes: String,
        sessionId: String?,
        tool: String,
        model: String?,
        effort: String?,
        thinking: Boolean,
    ) {
        val validSessionId = sessionId?.trim().orEmpty()
        require(validSessionId.isNotBlank()) { "Open a session before scheduling follow-up work" }
        val minutes = delayMinutes.toLongOrNull()?.coerceAtLeast(1) ?: 30L
        request("POST", "/api/triggers", jsonObject {
            put("title", title.trim())
            put("text", text.trim())
            put("scheduledAt", Instant.now().plus(minutes, ChronoUnit.MINUTES).toString())
            put("sessionId", validSessionId)
            put("tool", tool.trim().ifBlank { "codex" })
            model?.trim()?.takeIf { it.isNotBlank() }?.let { put("model", it) }
            effort?.trim()?.takeIf { it.isNotBlank() }?.let { put("effort", it) }
            put("thinking", thinking)
            put("enabled", true)
        })
    }

    suspend fun updateTrigger(
        id: String,
        enabled: Boolean? = null,
        title: String? = null,
        text: String? = null,
        scheduledAt: String? = null,
        sessionId: String? = null,
        tool: String? = null,
        model: String? = null,
        effort: String? = null,
        thinking: Boolean? = null,
    ) {
        request("PATCH", "/api/triggers/${path(id)}", jsonObject {
            enabled?.let { put("enabled", it) }
            title?.let { put("title", it.trim()) }
            text?.let { put("text", it.trim()) }
            scheduledAt?.let { put("scheduledAt", it) }
            sessionId?.let { put("sessionId", it.trim()) }
            tool?.let { put("tool", it.trim()) }
            model?.let { put("model", it.trim()) }
            effort?.let { put("effort", it.trim()) }
            thinking?.let { put("thinking", it) }
        })
    }

    suspend fun deleteTrigger(id: String) { request("DELETE", "/api/triggers/${path(id)}") }

    suspend fun deleteProvider(id: String) { request("DELETE", "/api/native-providers/${path(id)}") }

    suspend fun updateProvider(
        id: String,
        displayName: String,
        baseUrl: String,
        apiKey: String,
        defaultModel: String,
        protocol: String,
        enabled: Boolean,
    ) {
        request("PATCH", "/api/native-providers/${path(id)}", jsonObject {
            put("displayName", displayName.trim())
            put("baseUrl", baseUrl.trim())
            put("defaultModel", defaultModel.trim())
            put("protocol", protocol)
            put("enabled", enabled)
            apiKey.trim().takeIf { it.isNotEmpty() }?.let { put("apiKey", it) }
        })
    }

    suspend fun refreshProviderQuota(id: String) {
        request("POST", "/api/native-providers/${path(id)}/quota/refresh")
    }

    suspend fun loadHarnesses(): List<WebHarness> = parseWebHarnesses(request("GET", "/api/harnesses"))

    suspend fun installHarness(id: String) {
        request("POST", "/api/harnesses/${path(id)}/install", jsonObject {})
    }

    suspend fun upgradeHarness(id: String, version: String? = null) {
        request("POST", "/api/harnesses/${path(id)}/upgrade", jsonObject {
            version?.trim()?.takeIf { it.isNotEmpty() }?.let { put("version", it) }
        })
    }

    suspend fun uninstallHarness(id: String) {
        request("POST", "/api/harnesses/${path(id)}/uninstall", jsonObject {})
    }

    private suspend fun loadAgents(): List<WebAgent> = request("GET", "/api/agents")["agents"]?.jsonArray.orEmpty().mapNotNull { value ->
        val item = value.jsonObject
        item.string("id")?.let { id ->
            WebAgent(
                id = id,
                name = item.string("name") ?: "Untitled Agent",
                tool = item.string("tool") ?: "codex",
                builtin = item.boolean("builtin"),
                description = item.string("systemPrompt") ?: "",
                welcomeMessage = item.string("welcomeMessage") ?: "",
                skills = item["skills"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull },
                perMessageSystemPrompt = item["perMessageSystemPrompt"] as? JsonObject,
                templateContext = item["templateContext"] as? JsonObject,
                collaborationPolicy = item["collaborationPolicy"] as? JsonObject,
                createdAt = item.string("createdAt") ?: "",
                updatedAt = item.string("updatedAt") ?: "",
            )
        }
    }

    private suspend fun loadTools(): List<String> = request("GET", "/api/tools")["tools"]?.jsonArray.orEmpty()
        .mapNotNull { value ->
            val item = value.jsonObject
            item.string("id") ?: item.string("name")
        }
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .distinct()

    private suspend fun loadConnectors(sessionId: String?, selectedProviderId: String?): WebParitySnapshot {
        val surfaces = runCatching { request("GET", "/api/connectors/surfaces")["surfaces"]?.jsonArray.orEmpty() }.getOrDefault(emptyList())
        val connectors = surfaces.mapNotNull { value ->
            val item = value.jsonObject
            val id = item.string("connectorId") ?: item.string("id") ?: return@mapNotNull null
            val surface = item["surface"]?.jsonObject
            WebConnector(
                id,
                item.string("title") ?: id,
                surface?.string("capabilityState") ?: item.string("status") ?: "Not connected",
                surface?.string("capabilityState") == "ready",
                item.string("entryUrl") ?: "",
                item["allowEmbed"]?.jsonPrimitive?.booleanOrNull ?: false,
                item.string("description") ?: "",
                item.string("surfaceType") ?: "",
            )
        }.toMutableList()
        val statusRoutes = listOf("calendar/google", "gmail", "drive", "github", "mail")
        for (route in statusRoutes) {
            val root = runCatching { request("GET", "/api/connectors/$route/status") }.getOrNull() ?: continue
            val id = route.substringBefore('/').replaceFirstChar { it.uppercase() }
            val ready = root.boolean("connected") || root.boolean("bound") || root.boolean("authorized") || root.string("status") == "ready"
            if (connectors.none { it.id.equals(route.substringBefore('/'), ignoreCase = true) }) {
                connectors += WebConnector(route, id, root.string("status") ?: if (ready) "Connected" else "Not connected", ready)
            }
        }
        val providers = try { loadProviders() } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { emptyList() }
        val catalog = sessionId?.takeIf(String::isNotBlank)?.let { session ->
            try { request("GET", "/api/sessions/${path(session)}/harness-capabilities?tool=codex") }
            catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }
        }
        val sessionProvider = catalog?.string("providerProfileId").orEmpty()
        val codexProviders = providers.filter { it.agentType == "codex" }
        val provider = selectedProviderId?.takeIf { selected -> codexProviders.any { it.id == selected } }
            ?: sessionProvider.takeIf { session -> codexProviders.any { it.id == session } }
            ?: codexProviders.firstOrNull()?.id.orEmpty()
        val skills = catalog?.takeIf { provider == sessionProvider }?.let {
            it["items"]?.jsonArray.orEmpty().mapNotNull { value ->
                val item = value as? JsonObject ?: return@mapNotNull null
                val state = item["state"] as? JsonObject
                if (provider.isBlank() || item.string("kind") != "skill" || item.string("source") != "codex" || state?.boolean("manageable") != true) return@mapNotNull null
                val id = item.string("id") ?: return@mapNotNull null
                val name = item.string("title") ?: return@mapNotNull null
                val enabled = (item["enabled"] as? JsonPrimitive)?.booleanOrNull != false
                val desired = when (state?.string("desiredConfiguration")) { "enabled" -> true; "disabled" -> false; else -> enabled }
                WebCodexSkill(id, provider, name, enabled, desired)
            }
        }.orEmpty()
        val apps = catalog?.takeIf { provider == sessionProvider }?.get("items")?.jsonArray.orEmpty().mapNotNull { value ->
            val item = value as? JsonObject ?: return@mapNotNull null
            if (provider.isBlank() || item.string("kind") != "app" || item.string("source") != "codex") return@mapNotNull null
            val id = item.string("id") ?: return@mapNotNull null
            val name = item.string("title") ?: return@mapNotNull null
            val appState = item["state"] as? JsonObject
            WebCodexApp(id, provider, name, appState?.string("runtime") ?: "unknown",
                appState?.string("configuration") ?: "unknown", (appState?.get("accessible") as? JsonPrimitive)?.booleanOrNull)
        }
        val mcpAuth = catalog?.takeIf { provider == sessionProvider }?.get("items")?.jsonArray.orEmpty().mapNotNull { value ->
            val item = value as? JsonObject ?: return@mapNotNull null
            if (item.string("kind") != "mcp" || item.string("source") != "codex") return@mapNotNull null
            val name = item.string("title") ?: return@mapNotNull null
            name to ((item["state"] as? JsonObject)?.string("authorization") ?: "unknown")
        }.toMap()
        val servers = loadMcpServers(providers).map { server ->
            if (provider.isNotBlank() && server.providerId == provider && server.family == "codex") server.copy(authState = mcpAuth[server.name] ?: "unknown") else server
        }
        val pluginPreference = if (provider.isBlank()) null else try {
            val preference = request("GET", "/api/providers/${path(provider)}/codex/plugin-preference")
            (preference["desiredEnabled"] as? JsonPrimitive)?.booleanOrNull?.let { WebCodexPluginPreference(provider, it) }
        } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }
        val syncState = if (pluginPreference == null) null else try {
            val root = request("GET", "/api/providers/${path(provider)}/codex/capability-sync")
            val sync = root["sync"] as? JsonObject
            val mode = root.string("mode")?.takeIf { it in setOf("approved-auto", "manual", "disabled") } ?: "approved-auto"
            WebCodexSyncState(provider, sync?.string("status") ?: "unchecked", mode)
        } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }
        return WebParitySnapshot(connectors = connectors, mcpServers = servers, providers = providers, codexSkills = skills, codexApps = apps, codexPluginPreference = pluginPreference, codexSyncState = syncState)
    }

    private suspend fun loadMcpServers(providers: List<WebProvider>): List<WebMcpServer> = buildList {
        val routes = listOf(Triple("claude", "", "/api/claude/mcp-servers")) + providers.filter { it.agentType == "codex" }.map {
            Triple("codex", it.id, "/api/providers/${path(it.id)}/codex/mcp-servers")
        }
        for ((family, providerId, route) in routes) {
            val root = runCatching { request("GET", route) }.getOrNull() ?: continue
            root["servers"]?.jsonArray.orEmpty().forEach { value ->
                val item = value.jsonObject
                val name = item.string("name") ?: return@forEach
                val transport = item["transport"]?.jsonObject
                val detail = transport?.string("type") ?: transport?.string("url") ?: transport?.string("command") ?: item.string("command") ?: "Configured"
                add(WebMcpServer(family, name, detail, providerId))
            }
        }
    }

    private suspend fun loadProviders(): List<WebProvider> = request("GET", "/api/native-providers")["providers"]?.jsonArray.orEmpty().mapNotNull { value ->
        val item = value.jsonObject
        val id = item.string("id") ?: return@mapNotNull null
        // Hosts may still return legacy scalar or JSON-encoded policy values.
        val rawModelPolicy = item["modelPolicy"]
        val modelPolicy = when (rawModelPolicy) {
            is JsonObject -> rawModelPolicy
            is JsonPrimitive -> if (rawModelPolicy.isString) runCatching {
                AgentocProtocol.json.parseToJsonElement(rawModelPolicy.content) as? JsonObject
            }.getOrNull() else null
            else -> null
        }
        val legacyModelPolicy = (rawModelPolicy as? JsonPrimitive)?.takeIf { it.isString }?.content
        val quota = item["quota"] ?: try { request("GET", "/api/native-providers/${path(id)}/quota")["quota"] } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }
        WebProvider(
            id = id,
            name = item.string("displayName") ?: id,
            detail = listOfNotNull(item.string("agentType"), item.string("authType"), item.string("baseUrl")).joinToString(" · "),
            ready = item.boolean("credentialOk"),
            agentType = item.string("agentType") ?: "codex",
            authType = item.string("authType") ?: "api-key",
            baseUrl = item.string("baseUrl") ?: "",
            defaultModel = modelPolicy?.string("defaultModel") ?: item.string("defaultModel") ?: legacyModelPolicy.orEmpty(),
            protocol = item.string("protocol") ?: "responses",
            enabled = (item["enabled"] as? JsonPrimitive)?.booleanOrNull ?: true,
            quota = (quota as? JsonPrimitive)?.contentOrNull.orEmpty(),
            quotaSnapshot = quota as? JsonObject,
            modelCount = item.int("modelCount") ?: 0,
            hasRefreshToken = item.boolean("hasRefreshToken"),
            syncId = item.string("syncId").orEmpty(),
            credentialFingerprint = item.string("credentialFingerprint").orEmpty(),
            modelPolicyIdentity = item["modelPolicy"]?.toString().orEmpty(),
            quotaPolicyIdentity = item["quotaPolicy"]?.toString().orEmpty(),
        )
    }

    suspend fun loadWorkspaceFiles(directory: String = ""): List<WebFile> = loadFiles(directory)

    private suspend fun loadFiles(directory: String = ""): List<WebFile> {
        val query = if (directory.isBlank()) "" else "&path=${path(directory)}"
        val root = request("GET", "/api/workspace-files?workspace=~$query")
        return buildList {
            root["directories"]?.jsonArray.orEmpty().forEach { value ->
                val item = value.jsonObject
                item.string("path")?.let { add(WebFile(it, true, "")) }
            }
            root["files"]?.jsonArray.orEmpty().forEach { value ->
                val item = value.jsonObject
                item.string("path")?.let { add(WebFile(it, false, item.string("size") ?: "")) }
            }
        }
    }

    private suspend fun loadTriggers(): List<WebTrigger> = request("GET", "/api/triggers")["triggers"]?.jsonArray.orEmpty().mapNotNull { value ->
        val item = value.jsonObject
        val id = item.string("id") ?: return@mapNotNull null
        WebTrigger(
            id = id,
            title = item.string("title") ?: "Scheduled work",
            text = item.string("text") ?: "",
            scheduledAt = item.string("scheduledAt") ?: "",
            status = item.string("status") ?: "pending",
            enabled = item.boolean("enabled"),
            sessionId = item.string("sessionId") ?: "",
            tool = item.string("tool") ?: "",
            model = item.string("model") ?: "",
            effort = item.string("effort") ?: "",
            thinking = item.boolean("thinking"),
            deliveryAttempts = item.int("deliveryAttempts") ?: 0,
            nextAttemptAt = item.string("nextAttemptAt") ?: "",
            runId = item.string("runId") ?: "",
            lastError = item.string("lastError") ?: "",
        )
    }

    private suspend fun loadTextSummary(path: String): String = request("GET", path).entries.joinToString("\n") { (key, value) -> "$key: ${value.display()}" }

    private suspend fun loadUsage(): JsonObject = request("GET", "/api/usage/summary?days=7&top=10")

    private suspend fun request(method: String, path: String, body: JsonObject? = null): JsonObject {
        val response = execute(ApiRequest(method, path, body?.toString()))
        val root = runCatching { AgentocProtocol.json.parseToJsonElement(response.body).jsonObject }.getOrNull()
        if (!response.isSuccessful) throw ApiException(
            statusCode = response.statusCode,
            code = root?.string("code"),
            message = root?.string("error")?.takeIf { it.isNotBlank() } ?: "Request failed (HTTP ${response.statusCode})",
            retryable = response.statusCode == 408 || response.statusCode == 409 || response.statusCode == 429 || response.statusCode >= 500,
            headers = response.headers,
        )
        val validRoot = root ?: error("Invalid response from $path")
        return validRoot
    }

    private suspend fun browseRequest(path: String): JsonObject {
        val response = execute(ApiRequest("GET", path))
        val root = runCatching { AgentocProtocol.json.parseToJsonElement(response.body).jsonObject }
            .getOrElse { error("Invalid response from $path") }
        if (!response.isSuccessful) error(root.string("error") ?: "Folder browser request failed")
        return root
    }

    private fun jsonObject(builder: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject(builder)
    private fun path(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}

/** Shared tolerant parser used by the single-target and multi-target views. */
fun parseWebHarnesses(payload: JsonObject): List<WebHarness> = payload["harnesses"]?.jsonArray.orEmpty()
    .mapNotNull { value ->
        val item = value.jsonObject
        val id = item.string("id") ?: return@mapNotNull null
        WebHarness(
            id = id,
            name = item.string("name") ?: id,
            version = item.string("harnessVersion") ?: item.string("version") ?: "",
            installed = item.boolean("installed") || item.boolean("available"),
            commandAvailable = item.boolean("commandAvailable"),
            supportedOnPlatform = item.boolean("supportedOnPlatform"),
            installationSource = item.string("installationSource") ?: "",
            providerProtocols = (item["providerProtocols"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull },
            globallyInstalled = item.boolean("globallyInstalled"),
        )
    }

fun parseWebHarnesses(payload: String): List<WebHarness> = runCatching {
    parseWebHarnesses(AgentocProtocol.json.parseToJsonElement(payload).jsonObject)
}.getOrDefault(emptyList())

data class WebParitySnapshot(
    val agents: List<WebAgent> = emptyList(),
    val availableTools: List<String> = emptyList(),
    val connectors: List<WebConnector> = emptyList(),
    val mcpServers: List<WebMcpServer> = emptyList(),
    val codexSkills: List<WebCodexSkill> = emptyList(),
    val codexApps: List<WebCodexApp> = emptyList(),
    val codexPluginPreference: WebCodexPluginPreference? = null,
    val codexSyncState: WebCodexSyncState? = null,
    val providers: List<WebProvider> = emptyList(),
    val harnesses: List<WebHarness> = emptyList(),
    val providerHarnessesLoaded: Boolean = false,
    val harnessTargets: List<WebHarnessTarget> = emptyList(),
    val devices: List<WebDevice> = emptyList(),
    val files: List<WebFile> = emptyList(),
    val triggers: List<WebTrigger> = emptyList(),
    val usageSummary: String? = null,
    val usage: JsonObject? = null,
)

class WebParityViewModel(
    private val repository: WebParityRepository,
    private val accountDevicesProvider: (suspend () -> List<AccountDirectoryDevice>?)? = null,
    private val accountDeviceRevoker: (suspend (String) -> Unit)? = null,
    private val accountDeviceRenamer: (suspend (String, String) -> Unit)? = null,
    private val harnessTargetsProvider: (suspend () -> List<WebHarnessTargetSnapshot>)? = null,
    private val harnessMutation: (suspend (String, WebHarnessOperation, List<String>) -> List<WebHarnessMutationResult>)? = null,
    private val currentTargetIdProvider: (suspend () -> String?)? = null,
    private val onRuntimeCatalogChanged: (() -> Unit)? = null,
    private val providerInstancesProvider: (suspend () -> List<ProviderInstance>)? = null,
    private val providerRepositoryFactory: ((String) -> WebParityRepository)? = null,
) : ViewModel() {
    private val mutableState = MutableStateFlow(WebParityUiState(
        providerCrossInstance = providerInstancesProvider != null && providerRepositoryFactory != null,
    ))
    val state: StateFlow<WebParityUiState> = mutableState.asStateFlow()
    private var providerOAuthRepository: WebParityRepository? = null
    private var providerOAuthMonitor: Job? = null
    private var providerOAuthOpenedJobId: String? = null
    private var pageRefreshJob: Job? = null
    private var pageRefreshGeneration = 0L
    private var mcpOAuthGeneration = 0L
    private var mcpOAuthTargetId: String? = null
    private var mcpOAuthStartPending = false
    private var mcpCallbackSubmitting = false
    private var hasLoadedPage = false
    private var loadedPageTargetId: String? = null
    private var pageTargetId: String? = null
    private var fileReadJob: Job? = null
    private var folderReadJob: Job? = null
    private var fileReadGeneration = 0L
    private var folderReadGeneration = 0L

    suspend fun loadProjectFolderRoots(): List<ProjectFolderLocation> = repository.loadProjectFolderRoots()

    suspend fun loadProjectFolderDirectory(path: String): ProjectFolderListing =
        repository.loadProjectFolderDirectory(path)

    fun onEvent(event: WebParityEvent) {
        val providerRepository = if (providerRepositoryFactory == null) repository
            else mutableState.value.providerTargetId?.let(providerRepositoryFactory)
        val providerAction = event is WebParityEvent.CreateProviderApiKey || event is WebParityEvent.StartProviderOAuth ||
            event is WebParityEvent.UpdateProvider || event is WebParityEvent.DeleteProvider ||
            event is WebParityEvent.RefreshProviderQuota || event is WebParityEvent.ToggleProviderRotation ||
            event is WebParityEvent.ToggleProviderRotationProvider
        if (providerAction && (providerRepository == null || mutableState.value.actionInProgress ||
                (providerRepositoryFactory != null && mutableState.value.providerInstances.none {
                    it.instance.id == mutableState.value.providerTargetId && it.available
                }))) return
        when (event) {
            is WebParityEvent.RetryProviderInstance -> {
                if (!mutableState.value.actionInProgress && mutableState.value.providerInstances.any { it.instance.id == event.id })
                    refreshProviderInstances(event.id)
            }
            is WebParityEvent.SelectProviderInstance -> {
                if (mutableState.value.actionInProgress || mutableState.value.providerOAuthJob?.terminal == false) return
                if (event.id != null && mutableState.value.providerInstances.none { it.instance.id == event.id }) return
                mutableState.update { it.copy(providerTargetId = event.id, providerSavedTarget = null,
                    providerOAuthJob = null, externalUrl = null, error = null).withProviderSelection() }
                refresh(WebParityPage.ModelProviders)
            }
            is WebParityEvent.OpenPage -> {
                if (mutableState.value.page != event.page) invalidateFileReads()
                refresh(event.page)
            }
            WebParityEvent.Refresh -> mutableState.value.page?.let { refresh(it, preserveTargetId = loadedPageTargetId) }
            is WebParityEvent.RefreshAfterReconnect -> mutableState.value.page?.let {
                refresh(it, preserveTargetId = event.targetId)
            }
            is WebParityEvent.TargetChanged -> {
                if (mutableState.value.page == WebParityPage.ModelProviders && providerRepositoryFactory != null) return
                if (pageTargetId != null && pageTargetId != event.targetId) {
                    ++mcpOAuthGeneration
                    val wasStartingOAuth = mcpOAuthStartPending
                    mcpOAuthStartPending = false
                    ++pageRefreshGeneration
                    pageRefreshJob?.cancel()
                    if (providerRepositoryFactory == null) providerOAuthMonitor?.cancel()
                    invalidateFileReads()
                    loadedPageTargetId = null
                    hasLoadedPage = false
                    pageTargetId = null
                    val old = mutableState.value
                    mutableState.value = if (providerRepositoryFactory == null) WebParityUiState(page = old.page)
                        else WebParityUiState(page = old.page, providerCrossInstance = true,
                            providerInstances = old.providerInstances, providerTargetId = old.providerTargetId,
                            providerOAuthJob = old.providerOAuthJob, providerOAuthPolling = old.providerOAuthPolling,
                            providerOAuthTargetLabel = old.providerOAuthTargetLabel,
                            actionInProgress = if (wasStartingOAuth) false else old.actionInProgress)
                }
            }
            is WebParityEvent.CreateAgent -> mutate { repository.createAgent(event.name, event.systemPrompt, event.tool, event.welcomeMessage, event.skills, event.perMessageSystemPrompt, event.templateContext, event.collaborationPolicy) }
            is WebParityEvent.UpdateAgent -> mutate { repository.updateAgent(event.id, event.name, event.systemPrompt, event.tool, event.welcomeMessage, event.skills, event.perMessageSystemPrompt, event.templateContext, event.collaborationPolicy) }
            is WebParityEvent.DeleteAgent -> mutate { repository.deleteAgent(event.id) }
            is WebParityEvent.StartAgent -> viewModelScope.launch {
                mutableState.update { it.copy(actionInProgress = true, error = null) }
                runCatching { repository.startAgent(event.id, event.projectId) }
                    .onSuccess { id ->
                        mutableState.update {
                            it.copy(
                                actionInProgress = false,
                                openSessionId = id,
                                pendingOpenSessionId = id,
                                statusMessage = "Agent session created",
                            )
                        }
                    }
                    .onFailure { error -> mutableState.update { it.copy(actionInProgress = false, error = error.message ?: "Agent session could not be created") } }
            }
            is WebParityEvent.AddMcpServer -> mutate { repository.addMcpServer(event.family, event.name, event.commandOrUrl, event.providerId, event.args) }
            is WebParityEvent.DeleteMcpServer -> mutate { repository.deleteMcpServer(event.family, event.name, event.providerId) }
            is WebParityEvent.StartMcpOAuth -> viewModelScope.launch {
                val generation = ++mcpOAuthGeneration
                val targetId = currentTargetIdProvider?.invoke()
                mcpOAuthStartPending = true
                mutableState.update { it.copy(actionInProgress = true, error = null, mcpOAuthJob = null) }
                try {
                    val job = repository.startMcpOAuth(event.providerId, event.serverName)
                    if (generation != mcpOAuthGeneration || targetId != currentTargetIdProvider?.invoke()) {
                        if (generation == mcpOAuthGeneration) {
                            mcpOAuthStartPending = false
                            mutableState.update { it.copy(actionInProgress = false) }
                        }
                        cancelAbandonedMcpOAuth(job, targetId)
                        return@launch
                    }
                    mcpOAuthStartPending = false
                    mcpOAuthTargetId = targetId
                    mutableState.update { it.copy(actionInProgress = false, mcpOAuthJob = job) }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    if (generation == mcpOAuthGeneration && targetId == currentTargetIdProvider?.invoke()) {
                        mcpOAuthStartPending = false
                        mutableState.update { it.copy(actionInProgress = false, error = error.message ?: "Authorization could not be started") }
                    }
                }
            }
            WebParityEvent.CheckMcpOAuth -> mutableState.value.mcpOAuthJob?.let { current -> viewModelScope.launch {
                val generation = mcpOAuthGeneration
                val targetId = currentTargetIdProvider?.invoke()
                try {
                    val job = repository.checkMcpOAuth(current)
                    if (generation != mcpOAuthGeneration || targetId != currentTargetIdProvider?.invoke() || mutableState.value.mcpOAuthJob?.id != job.id) return@launch
                    mutableState.update { state ->
                        if (state.mcpOAuthJob?.id == job.id) state.copy(mcpOAuthJob = job.copy(callbackSubmitted = state.mcpOAuthJob?.callbackSubmitted == true)) else state
                    }
                    if (job.state == "connected" && mutableState.value.page == WebParityPage.Connectors) refresh(WebParityPage.Connectors)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    if (generation == mcpOAuthGeneration && targetId == currentTargetIdProvider?.invoke() && mutableState.value.mcpOAuthJob?.id == current.id)
                        mutableState.update { it.copy(error = error.message ?: "Authorization status could not be checked") }
                }
            } }
            is WebParityEvent.SubmitMcpOAuthCallback -> mutableState.value.mcpOAuthJob?.takeIf { !mcpCallbackSubmitting && it.mobileCallbackSupported && !it.callbackSubmitted && it.state == "pending" }?.let { current ->
                mcpCallbackSubmitting = true
                viewModelScope.launch {
                val generation = mcpOAuthGeneration
                val targetId = currentTargetIdProvider?.invoke()
                mutableState.update { it.copy(error = null) }
                try {
                    repository.submitMcpOAuthCallback(current, event.callbackUrl.trim())
                    if (generation == mcpOAuthGeneration && targetId == currentTargetIdProvider?.invoke() && mutableState.value.mcpOAuthJob?.id == current.id) {
                        mutableState.update { state -> state.copy(mcpOAuthJob = state.mcpOAuthJob?.copy(callbackSubmitted = true)) }
                        onEvent(WebParityEvent.CheckMcpOAuth)
                    }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    if (generation == mcpOAuthGeneration && targetId == currentTargetIdProvider?.invoke() && mutableState.value.mcpOAuthJob?.id == current.id)
                        mutableState.update { it.copy(error = error.message ?: "Callback could not be submitted") }
                }
                finally { mcpCallbackSubmitting = false }
            } }
            WebParityEvent.ClearMcpOAuth -> {
                ++mcpOAuthGeneration
                mcpOAuthStartPending = false
                val job = mutableState.value.mcpOAuthJob
                mcpOAuthTargetId = null
                mutableState.update { it.copy(mcpOAuthJob = null) }
                if (job?.state in listOf("pending", "completed_unverified")) viewModelScope.launch {
                    try { repository.cancelMcpOAuth(job!!) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: Exception) { mutableState.update { it.copy(error = error.message ?: "Authorization could not be cancelled") } }
                }
            }
            is WebParityEvent.SetCodexSkill -> mutate { repository.setCodexSkill(event.sessionId, event.skill, event.enabled) }
            is WebParityEvent.SetCodexPluginPreference -> if (mutableState.value.codexPluginPreference?.providerId == event.providerId) {
                mutate { repository.setCodexPluginPreference(event.providerId, event.enabled) }
            }
            is WebParityEvent.RefreshCodexSync -> if (mutableState.value.codexSyncState?.providerId == event.providerId) {
                mutate { repository.refreshCodexSync(event.providerId) }
            }
            is WebParityEvent.SetCodexSyncPolicy -> if (mutableState.value.codexSyncState?.providerId == event.providerId) {
                mutate { repository.setCodexSyncPolicy(event.providerId, event.mode) }
            }
            is WebParityEvent.SelectCodexManagementProvider -> if (mutableState.value.providers.any { it.id == event.providerId && it.agentType == "codex" }) {
                val abandonedJob = mutableState.value.mcpOAuthJob
                val targetId = mcpOAuthTargetId
                mcpOAuthTargetId = null
                ++mcpOAuthGeneration
                val wasStartingOAuth = mcpOAuthStartPending
                mcpOAuthStartPending = false
                mutableState.update { it.copy(codexManagementProviderId = event.providerId, codexPluginPreference = null,
                    codexSyncState = null, codexSkills = emptyList(), codexApps = emptyList(), mcpOAuthJob = null,
                    actionInProgress = if (wasStartingOAuth) false else it.actionInProgress) }
                abandonedJob?.let { cancelAbandonedMcpOAuth(it, targetId) }
                refresh(WebParityPage.Connectors)
            }
            is WebParityEvent.StartConnectorOAuth -> viewModelScope.launch {
                mutableState.update { it.copy(actionInProgress = true, error = null, externalUrl = null) }
                runCatching { repository.startConnectorOAuth(event.id) }
                    .onSuccess { url -> mutableState.update { it.copy(actionInProgress = false, externalUrl = url, statusMessage = "Connector login opened") } }
                    .onFailure { error -> mutableState.update { it.copy(actionInProgress = false, error = error.message ?: "Connector login failed") } }
            }
            is WebParityEvent.DisconnectConnector -> mutate { repository.disconnectConnector(event.id) }
            is WebParityEvent.RevokeDevice -> {
                val accountDevice = mutableState.value.devices.firstOrNull { it.id == event.id && it.accountOwned }
                if (accountDevice != null && accountDeviceRevoker != null) {
                    mutate { accountDeviceRevoker(accountDevice.id) }
                } else {
                    mutableState.update { it.copy(error = "Account device actions require a verified account session.") }
                }
            }
            is WebParityEvent.RenameDevice -> {
                val accountDevice = mutableState.value.devices.firstOrNull { it.id == event.id && it.accountOwned }
                if (accountDevice != null && accountDeviceRenamer != null) {
                    mutate { accountDeviceRenamer(accountDevice.id, event.name) }
                } else {
                    mutableState.update { it.copy(error = "Only account devices can be renamed.") }
                }
            }
            is WebParityEvent.OpenFile -> {
                val generation = ++fileReadGeneration
                fileReadJob?.cancel()
                fileReadJob = viewModelScope.launch {
                    mutableState.update { it.copy(fileReadInProgress = true, selectedFile = event.path, filePayload = null, fileContent = null, error = null) }
                    try {
                        val payload = repository.loadFile(event.path, event.sessionId)
                        currentCoroutineContext().ensureActive()
                        if (generation == fileReadGeneration) mutableState.update {
                            it.copy(fileReadInProgress = false, filePayload = payload,
                                fileContent = payload.bytes.toString(Charsets.UTF_8).takeIf { payload.mimeType.startsWith("text/") || payload.mimeType == "application/json" }, statusMessage = "File loaded")
                        }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: Exception) {
                        if (generation == fileReadGeneration) mutableState.update { it.copy(fileReadInProgress = false, error = error.message ?: "File could not be opened") }
                    }
                }
            }
            is WebParityEvent.OpenDirectory -> openDirectory(event.path)
            WebParityEvent.ParentDirectory -> {
                val current = mutableState.value.fileDirectory.trim('/')
                openDirectory(current.substringBeforeLast('/', ""))
            }
            WebParityEvent.CloseFile -> {
                ++fileReadGeneration
                fileReadJob?.cancel(); fileReadJob = null
                mutableState.update { it.copy(selectedFile = null, fileContent = null, filePayload = null,
                    fileReadInProgress = false) }
            }
            is WebParityEvent.CreateTrigger -> mutate {
                repository.createTrigger(
                    title = event.title,
                    text = event.text,
                    delayMinutes = event.delayMinutes,
                    sessionId = event.sessionId ?: mutableState.value.openSessionId,
                    tool = event.tool,
                    model = event.model,
                    effort = event.effort,
                    thinking = event.thinking,
                )
            }
            is WebParityEvent.ToggleTrigger -> mutate { repository.updateTrigger(event.id, enabled = event.enabled) }
            is WebParityEvent.UpdateTrigger -> mutate {
                val minutes = event.delayMinutes.toLongOrNull()?.coerceAtLeast(1) ?: 30L
                repository.updateTrigger(
                    id = event.id,
                    title = event.title,
                    text = event.text,
                    scheduledAt = Instant.now().plus(minutes, ChronoUnit.MINUTES).toString(),
                    sessionId = event.sessionId,
                    tool = event.tool,
                    model = event.model,
                    effort = event.effort,
                    thinking = event.thinking,
                )
            }
            is WebParityEvent.RetryTrigger -> mutate { repository.updateTrigger(event.id, enabled = true) }
            is WebParityEvent.DeleteTrigger -> mutate { repository.deleteTrigger(event.id) }
            is WebParityEvent.CreateProviderApiKey -> mutateProvider {
                providerRepository!!.createProviderApiKey(event.agentType, event.displayName, event.baseUrl, event.apiKey, event.defaultModel, event.protocol)
            }
            is WebParityEvent.StartProviderOAuth -> {
                if (mutableState.value.actionInProgress || mutableState.value.providerOAuthJob?.terminal == false) return
                mutableState.update { it.copy(actionInProgress = true, error = null, externalUrl = null,
                    providerOAuthTargetLabel = it.providerInstances.firstOrNull { target -> target.instance.id == it.providerTargetId }?.instance?.label) }
                viewModelScope.launch {
                    try {
                        providerOAuthRepository = providerRepository
                        val job = providerRepository!!.startProviderOAuth(event.agentType, event.displayName, event.providerId)
                        mutableState.update { it.copy(actionInProgress = false, providerOAuthJob = job, statusMessage = "Waiting for official login") }
                        monitorProviderOAuth(job.id)
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: Exception) { mutableState.update { it.copy(actionInProgress = false, error = error.message ?: "Provider login failed") } }
                }
            }
            WebParityEvent.CheckProviderOAuth -> mutableState.value.providerOAuthJob?.takeUnless { it.terminal }?.let { monitorProviderOAuth(it.id) }
            WebParityEvent.OpenProviderOAuth -> mutableState.value.providerOAuthJob?.takeIf { it.canOpenBrowser }?.let { job ->
                mutableState.update { it.copy(externalUrl = job.url, error = null) }
            }
            WebParityEvent.ProviderOAuthBrowserFailed -> mutableState.update { it.copy(error = "Unable to open the official page. Use Open login page to retry.") }
            is WebParityEvent.SubmitProviderOAuthCredential -> viewModelScope.launch {
                val job = mutableState.value.providerOAuthJob ?: return@launch
                if (!job.requiresInput || job.terminal || mutableState.value.actionInProgress) return@launch
                mutableState.update { it.copy(actionInProgress = true, error = null) }
                try {
                    (providerOAuthRepository ?: repository).submitProviderOAuthCredential(job.id, event.credential)
                    mutableState.update { it.copy(actionInProgress = false, providerOAuthJob = job.copy(requiresInput = false), statusMessage = "Credential submitted; checking saved provider") }
                    monitorProviderOAuth(job.id)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) { mutableState.update { it.copy(actionInProgress = false, error = error.message ?: "Credential submission failed") } }
            }
            WebParityEvent.CancelProviderOAuth -> viewModelScope.launch {
                val job = mutableState.value.providerOAuthJob ?: return@launch
                if (job.terminal) {
                    mutableState.update { it.copy(providerOAuthJob = null, externalUrl = null) }
                    return@launch
                }
                providerOAuthMonitor?.cancel()
                mutableState.update { it.copy(providerOAuthPolling = false) }
                try {
                    (providerOAuthRepository ?: repository).cancelProviderOAuth(job.id)
                    // DELETE may race a completed save: read back rather than falsely claiming cancellation.
                    monitorProviderOAuth(job.id)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) { mutableState.update { it.copy(error = "Cancellation is unconfirmed. Check login status before starting another login.") } }
            }
            is WebParityEvent.ToggleProviderRotation -> mutateProvider {
                providerRepository!!.updateProviderRotation(event.enabled, mutableState.value.providerRotationIds)
            }
            is WebParityEvent.ToggleProviderRotationProvider -> {
                val ids = mutableState.value.providerRotationIds.toMutableSet().apply {
                    if (event.selected) add(event.id) else remove(event.id)
                }.toList()
                val enabled = mutableState.value.providerRotationEnabled
                mutateProvider { providerRepository!!.updateProviderRotation(enabled, ids) }
            }
            is WebParityEvent.DeleteProvider -> mutateProvider { providerRepository!!.deleteProvider(event.id) }
            is WebParityEvent.UpdateProvider -> mutateProvider {
                providerRepository!!.updateProvider(event.id, event.displayName, event.baseUrl, event.apiKey, event.defaultModel, event.protocol, event.enabled)
            }
            is WebParityEvent.RefreshProviderQuota -> mutateProvider { providerRepository!!.refreshProviderQuota(event.id) }
            is WebParityEvent.InstallHarness -> mutateHarness(event.id, WebHarnessOperation.Install, event.targetInstanceIds)
            is WebParityEvent.UpgradeHarness -> mutateHarness(event.id, WebHarnessOperation.Upgrade, event.targetInstanceIds)
            is WebParityEvent.UninstallHarness -> mutateHarness(event.id, WebHarnessOperation.Uninstall, event.targetInstanceIds)
            WebParityEvent.ClearExternalUrl -> mutableState.update { it.copy(externalUrl = null) }
        }
    }

    private fun invalidateFileReads() {
        ++fileReadGeneration; ++folderReadGeneration
        fileReadJob?.cancel(); fileReadJob = null
        folderReadJob?.cancel(); folderReadJob = null
        mutableState.update { it.copy(fileReadInProgress = false, folderReadInProgress = false) }
    }

    private fun openDirectory(path: String) {
        val generation = ++folderReadGeneration
        folderReadJob?.cancel()
        folderReadJob = viewModelScope.launch {
            mutableState.update { it.copy(folderReadInProgress = true, error = null) }
            try {
                val files = repository.loadWorkspaceFiles(path)
                currentCoroutineContext().ensureActive()
                if (generation == folderReadGeneration) mutableState.update {
                    it.copy(folderReadInProgress = false, files = files, fileDirectory = path.trim('/'), statusMessage = "Folder loaded")
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (generation == folderReadGeneration) mutableState.update { it.copy(folderReadInProgress = false, error = error.message ?: "Folder could not be opened") }
            }
        }
    }

    fun consumePendingOpenSession(): String? {
        val sessionId = mutableState.value.pendingOpenSessionId
        if (sessionId != null) {
            mutableState.update { it.copy(pendingOpenSessionId = null) }
        }
        return sessionId
    }

    fun setOpenSessionId(sessionId: String?) {
        val next = sessionId?.takeIf(String::isNotBlank)
        val changed = mutableState.value.openSessionId != next
        val abandonedJob = if (changed) mutableState.value.mcpOAuthJob else null
        val targetId = mcpOAuthTargetId
        val wasStartingOAuth = changed && mcpOAuthStartPending
        if (changed) {
            ++mcpOAuthGeneration
            mcpOAuthStartPending = false
            mcpOAuthTargetId = null
        }
        mutableState.update { it.copy(openSessionId = next, codexSkills = if (changed) emptyList() else it.codexSkills, codexApps = if (changed) emptyList() else it.codexApps,
            codexPluginPreference = if (changed) null else it.codexPluginPreference, codexSyncState = if (changed) null else it.codexSyncState,
            codexManagementProviderId = if (changed && next != null) null else it.codexManagementProviderId,
            mcpOAuthJob = if (changed) null else it.mcpOAuthJob,
            actionInProgress = if (wasStartingOAuth) false else it.actionInProgress) }
        abandonedJob?.let { cancelAbandonedMcpOAuth(it, targetId) }
        if (changed && mutableState.value.page == WebParityPage.Connectors) refresh(WebParityPage.Connectors)
    }

    private fun cancelAbandonedMcpOAuth(job: WebMcpOAuthJob, targetId: String?) {
        if (job.state !in listOf("pending", "completed_unverified")) return
        viewModelScope.launch {
            // Never send an old job's cancellation to a different machine.
            if (targetId != currentTargetIdProvider?.invoke()) return@launch
            try { repository.cancelMcpOAuth(job) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* The job expires on the original host. */ }
        }
    }

    fun setTriggerRuntime(tool: String, model: String?, effort: String?, thinking: Boolean = false) {
        mutableState.update {
            it.copy(
                triggerTool = tool.trim().ifBlank { "codex" },
                triggerModel = model?.takeIf(String::isNotBlank),
                triggerEffort = effort?.takeIf(String::isNotBlank),
                triggerThinking = thinking,
            )
        }
    }

    private fun monitorProviderOAuth(id: String) {
        providerOAuthMonitor?.cancel()
        providerOAuthMonitor = viewModelScope.launch {
            var opened = providerOAuthOpenedJobId == id
            mutableState.update { it.copy(providerOAuthPolling = true, error = null) }
            try {
                repeat(600) {
                    val job = (providerOAuthRepository ?: repository).loadProviderOAuthJob(id)
                    if (mutableState.value.providerOAuthJob?.id != id) return@launch
                    val open = job.canOpenBrowser && !opened
                    if (open) { opened = true; providerOAuthOpenedJobId = id }
                    mutableState.update { it.copy(providerOAuthJob = job,
                        externalUrl = if (open) job.url else it.externalUrl,
                        statusMessage = when (job.state) {
                            "completed" -> "Official account saved on the connected computer"
                            "failed" -> "Official login failed"
                            "cancelled" -> "Official login cancelled"
                            "finalizing" -> "Saving provider on the connected computer"
                            else -> "Waiting for official login"
                        }, error = job.error.takeIf { job.state == "failed" }) }
                    if (job.terminal) {
                        mutableState.update { it.copy(externalUrl = null) }
                        if (job.state == "completed") {
                            if (mutableState.value.page == WebParityPage.ModelProviders) refresh(WebParityPage.ModelProviders)
                            onRuntimeCatalogChanged?.invoke()
                        }
                        return@launch
                    }
                    delay(1000)
                }
                mutableState.update { it.copy(error = "Login status is not confirmed. Check status to continue; no new login was started.") }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutableState.update { it.copy(error = "Login status could not be checked. Check status after reconnecting; no new login was started.") } }
            finally { mutableState.update { it.copy(providerOAuthPolling = false) } }
        }
    }

    private fun refresh(page: WebParityPage, preserveTargetId: String? = null) {
        if (page == WebParityPage.ModelProviders && providerInstancesProvider != null && providerRepositoryFactory != null) {
            refreshProviderInstances()
            return
        }
        val generation = ++pageRefreshGeneration
        pageRefreshJob?.cancel()
        pageRefreshJob = viewModelScope.launch {
            val requestedTarget = currentTargetIdProvider?.invoke()
            currentCoroutineContext().ensureActive()
            if (generation != pageRefreshGeneration) return@launch
            val preserve = hasLoadedPage && requestedTarget == loadedPageTargetId &&
                (preserveTargetId == null || preserveTargetId == requestedTarget) && mutableState.value.page == page
            if (!preserve) hasLoadedPage = false
            pageTargetId = requestedTarget
            val directory = if (preserve && page == WebParityPage.Files) mutableState.value.fileDirectory else ""
            val directoryGeneration = folderReadGeneration
            mutableState.update {
                if (preserve) return@update it.copy(error = null, refreshing = true)
                it.copy(
                    page = page,
                    loading = true,
                    refreshing = false,
                    error = null,
                    statusMessage = null,
                    agents = emptyList(),
                    connectors = emptyList(),
                    mcpServers = emptyList(),
                    mcpOAuthJob = null,
                    codexSkills = emptyList(),
                    codexApps = emptyList(),
                    codexPluginPreference = null,
                    codexSyncState = null,
                    providers = emptyList(),
                    harnesses = emptyList(),
                    harnessTargets = emptyList(),
                    devices = emptyList(),
                    files = emptyList(),
                    fileContent = null,
                    filePayload = null,
                    selectedFile = null,
                    triggers = emptyList(),
                    usageSummary = null,
                    usage = null,
                )
            }
            runCatching {
                if (page == WebParityPage.Devices && accountDevicesProvider != null) {
                    val accountDevices = accountDevicesProvider.invoke()
                    WebParitySnapshot(
                        devices = accountDevices.orEmpty()
                            .filter { isComputerDevice(it.deviceKind) }
                            .map(::toWebDevice),
                    )
                } else if (page == WebParityPage.Harnesses && harnessTargetsProvider != null) {
                    val targets = harnessTargetsProvider.invoke()
                    val activeTargetId = currentTargetIdProvider?.invoke()
                    val active = targets.firstOrNull { it.target.instanceId == activeTargetId && it.target.available }
                        ?: targets.firstOrNull { it.target.available }
                    WebParitySnapshot(
                        harnesses = active?.harnesses.orEmpty(),
                        harnessTargets = targets.map { it.target },
                    )
                } else if (page == WebParityPage.Files && directory.isNotBlank()) {
                    WebParitySnapshot(files = repository.loadWorkspaceFiles(directory))
                } else {
                    repository.load(page, mutableState.value.openSessionId, mutableState.value.codexManagementProviderId)
                }
            }
                .onSuccess { snapshot ->
                    if (generation != pageRefreshGeneration) return@onSuccess
                    val rotation = if (page == WebParityPage.ModelProviders) runCatching { repository.loadProviderRotation() }.getOrNull() else null
                    currentCoroutineContext().ensureActive()
                    val currentTarget = currentTargetIdProvider?.invoke()
                    currentCoroutineContext().ensureActive()
                    if (generation == pageRefreshGeneration && mutableState.value.page == page && currentTarget == requestedTarget) {
                        loadedPageTargetId = requestedTarget
                        hasLoadedPage = true
                        mutableState.update {
                            // A reconnect may finish after the user navigates to
                            // another folder. Never apply the old folder listing
                            // to the newly selected directory.
                            val merged = if (preserve && page == WebParityPage.Files &&
                                (it.fileDirectory != directory || folderReadGeneration != directoryGeneration)) it
                                else it.merge(page, snapshot)
                            merged.copy(loading = false, refreshing = false, providerRotationEnabled = rotation?.first ?: merged.providerRotationEnabled,
                                providerRotationIds = rotation?.second ?: merged.providerRotationIds)
                        }
                    }
                }
                .onFailure { error ->
                    if (error is CancellationException) throw error
                    currentCoroutineContext().ensureActive()
                    if (generation == pageRefreshGeneration && mutableState.value.page == page) {
                        mutableState.update { it.copy(loading = false, refreshing = false, error = error.message ?: "Web feature could not be loaded") }
                    }
                }
        }
    }

    private fun toWebDevice(device: AccountDirectoryDevice): WebDevice = WebDevice(
        id = device.deviceId,
        instanceId = device.instanceId,
        name = device.alias.ifBlank { device.deviceId },
        platform = device.deviceKind,
        status = if (device.unboundAt.isNullOrBlank()) "Trusted" else "Revoked",
        revocable = device.unboundAt.isNullOrBlank(),
        accountOwned = true,
        createdAt = device.boundAt.orEmpty(),
        lastSeenAt = device.lastSeenAt.orEmpty(),
    )

    private fun WebParityUiState.withProviderSelection(): WebParityUiState {
        val selected = providerInstances.firstOrNull { it.instance.id == providerTargetId }
        return copy(providers = selected?.snapshot?.providers.orEmpty(),
            harnesses = selected?.snapshot?.harnesses.orEmpty(),
            providerHarnessesLoaded = selected?.snapshot?.providerHarnessesLoaded == true,
            providerRotationEnabled = selected?.rotation?.first == true,
            providerRotationIds = selected?.rotation?.second.orEmpty())
    }

    private fun refreshProviderInstances(onlyInstanceId: String? = null) {
        val generation = ++pageRefreshGeneration
        pageRefreshJob?.cancel()
        pageRefreshJob = viewModelScope.launch {
            mutableState.update { it.copy(page = WebParityPage.ModelProviders, providerCrossInstance = true,
                loading = false, refreshing = true, error = null, providerInstances = it.providerInstances.map { target ->
                    target.copy(loading = onlyInstanceId == null || onlyInstanceId == target.instance.id)
                }) }
            try {
                val targets = providerInstancesProvider!!.invoke().distinctBy { it.id }
                if (generation != pageRefreshGeneration) return@launch
                mutableState.update { old -> old.copy(providerInstances = targets.map { target ->
                    // Retain last-known rows while refreshing, but never call them freshly confirmed.
                    old.providerInstances.firstOrNull { it.instance.id == target.id }?.copy(instance = target,
                        loading = onlyInstanceId == null || onlyInstanceId == target.id)
                        ?: ProviderInstanceSnapshot(target, loading = onlyInstanceId == null || onlyInstanceId == target.id)
                }, providerTargetId = old.providerTargetId?.takeIf { id -> targets.any { it.id == id } }) }
                coroutineScope {
                    targets.filter { onlyInstanceId == null || it.id == onlyInstanceId }.map { target -> async {
                        val result = try {
                            val bound = providerRepositoryFactory!!.invoke(target.id)
                            val snapshot = bound.load(WebParityPage.ModelProviders)
                            val rotation = try { bound.loadProviderRotation() } catch (cancelled: CancellationException) { throw cancelled }
                                catch (_: Exception) { null }
                            ProviderInstanceSnapshot(target, loading = false, available = true, snapshot = snapshot, rotation = rotation)
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (error: Exception) {
                            ProviderInstanceSnapshot(target, loading = false,
                                failure = ProviderInstanceFailure.from(error))
                        }
                        if (generation == pageRefreshGeneration && mutableState.value.page == WebParityPage.ModelProviders) {
                            mutableState.update { old -> old.copy(providerInstances = old.providerInstances.map {
                                if (it.instance.id == target.id) result else it
                            }).withProviderSelection() }
                        }
                    } }.awaitAll()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutableState.update { old -> old.copy(error = error.message ?: "Unable to load instances",
                providerInstances = old.providerInstances.map { target ->
                    if (onlyInstanceId == null || onlyInstanceId == target.instance.id) target.copy(available = false, loading = false) else target
                }).withProviderSelection() } }
            finally { if (generation == pageRefreshGeneration) mutableState.update { it.copy(refreshing = false) } }
        }
    }

    private fun mutateProvider(action: suspend () -> Unit) {
        val target = mutableState.value.providerInstances.firstOrNull { it.instance.id == mutableState.value.providerTargetId }?.instance
        mutableState.update { it.copy(actionInProgress = true, error = null, providerSavedTarget = null) }
        viewModelScope.launch {
            try {
                action()
                mutableState.update { it.copy(actionInProgress = false, providerSavedTarget = target?.label) }
                onRuntimeCatalogChanged?.invoke()
                refresh(WebParityPage.ModelProviders)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutableState.update { it.copy(actionInProgress = false, error = error.message ?: "Action failed") } }
        }
    }

    private fun mutate(action: suspend () -> Unit) {
        viewModelScope.launch {
            mutableState.update { it.copy(actionInProgress = true, error = null, statusMessage = null) }
            runCatching { action() }
                .onSuccess {
                    mutableState.update { it.copy(actionInProgress = false, statusMessage = "Saved") }
                    mutableState.value.page?.let { refresh(it, preserveTargetId = loadedPageTargetId) }
                }
                .onFailure { error -> mutableState.update { it.copy(actionInProgress = false, error = error.message ?: "Action failed") } }
        }
    }

    private fun WebParityUiState.merge(page: WebParityPage, snapshot: WebParitySnapshot): WebParityUiState = when (page) {
        WebParityPage.Agents -> copy(agents = snapshot.agents, availableTools = snapshot.availableTools)
        WebParityPage.Connectors -> copy(connectors = snapshot.connectors, mcpServers = snapshot.mcpServers, providers = snapshot.providers, codexSkills = snapshot.codexSkills, codexApps = snapshot.codexApps, codexPluginPreference = snapshot.codexPluginPreference, codexSyncState = snapshot.codexSyncState)
        WebParityPage.ModelProviders -> copy(providers = snapshot.providers, harnesses = snapshot.harnesses, providerHarnessesLoaded = snapshot.providerHarnessesLoaded)
        WebParityPage.Harnesses -> copy(harnesses = snapshot.harnesses, harnessTargets = snapshot.harnessTargets)
        WebParityPage.Devices -> copy(devices = snapshot.devices)
        WebParityPage.Files -> copy(files = snapshot.files)
        WebParityPage.Triggers -> copy(triggers = snapshot.triggers)
        WebParityPage.Usage -> copy(usageSummary = snapshot.usageSummary, usage = snapshot.usage)
    }

    private fun mutateHarness(id: String, operation: WebHarnessOperation, targetInstanceIds: List<String>) {
        viewModelScope.launch {
            mutableState.update { it.copy(actionInProgress = true, error = null, statusMessage = null) }
            runCatching {
                if (harnessMutation != null) {
                    harnessMutation.invoke(id, operation, targetInstanceIds)
                } else {
                    when (operation) {
                        WebHarnessOperation.Install -> repository.installHarness(id)
                        WebHarnessOperation.Upgrade -> repository.upgradeHarness(id)
                        WebHarnessOperation.Uninstall -> repository.uninstallHarness(id)
                    }
                    emptyList()
                }
            }.onSuccess { results ->
                val failed = results.count { !it.success }
                val message = if (results.isEmpty()) {
                    "Harness ${operation.name.lowercase()} completed"
                } else if (failed == 0) {
                    "Harness ${operation.name.lowercase()} completed on ${results.size} device(s)"
                } else {
                    "Harness ${operation.name.lowercase()} completed on ${results.size - failed}/${results.size} device(s)"
                }
                mutableState.update { it.copy(actionInProgress = false, statusMessage = message) }
                onRuntimeCatalogChanged?.invoke()
                mutableState.value.page?.let { refresh(it, preserveTargetId = loadedPageTargetId) }
            }.onFailure { error ->
                mutableState.update { it.copy(actionInProgress = false, error = error.message ?: "Harness action failed") }
            }
        }
    }
}

class WebParityViewModelFactory(
    private val transport: AgentoCTransport,
    private val accountDevicesProvider: (suspend () -> List<AccountDirectoryDevice>?)? = null,
    private val accountDeviceRevoker: (suspend (String) -> Unit)? = null,
    private val accountDeviceRenamer: (suspend (String, String) -> Unit)? = null,
    private val harnessTargetsProvider: (suspend () -> List<WebHarnessTargetSnapshot>)? = null,
    private val harnessMutation: (suspend (String, WebHarnessOperation, List<String>) -> List<WebHarnessMutationResult>)? = null,
    private val currentTargetIdProvider: (suspend () -> String?)? = null,
    private val onRuntimeCatalogChanged: (() -> Unit)? = null,
    private val providerInstancesProvider: (suspend () -> List<ProviderInstance>)? = null,
    private val providerRepositoryFactory: ((String) -> WebParityRepository)? = null,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = WebParityViewModel(
        WebParityRepository(transport),
        accountDevicesProvider,
        accountDeviceRevoker,
        accountDeviceRenamer,
        harnessTargetsProvider,
        harnessMutation,
        currentTargetIdProvider,
        onRuntimeCatalogChanged,
        providerInstancesProvider,
        providerRepositoryFactory,
    ) as T
}

private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull
private fun JsonObject.boolean(key: String): Boolean = (this[key] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull() ?: false
private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.contentOrNull?.toLongOrNull()

private fun isComputerDevice(platform: String): Boolean = platform.trim().lowercase() !in setOf(
    "phone",
    "android",
    "mobile",
    "tablet",
)
private fun JsonElement.display(): String = when (this) {
    is JsonPrimitive -> contentOrNull ?: toString()
    else -> toString()
}
