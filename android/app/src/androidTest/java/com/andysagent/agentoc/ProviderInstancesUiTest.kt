package com.andysagent.agentoc

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiResponse
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.feature.workbench.*
import kotlinx.serialization.json.*
import java.io.File
import java.util.Locale
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Production UI + production ViewModel/repository, with isolated per-instance API fixtures. */
class ProviderInstancesUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val dark get() = InstrumentationRegistry.getArguments().getString("dark") == "true"
    private val requests = mutableListOf<Pair<String, ApiRequest>>()
    private var failWrite = false
    private var failOfficeProviderRead = false
    private val names = mutableMapOf("office" to "团队模型", "studio" to "团队模型")
    private val deleted = mutableSetOf<String>()
    private lateinit var vm: WebParityViewModel

    private fun repo(id: String) = WebParityRepository { request ->
        requests += id to request
        if (id == "offline") error("offline fixture")
        if (id == "office" && failOfficeProviderRead && request.method == "GET" && request.path == "/api/native-providers")
            return@WebParityRepository ApiResponse(403, """{"error":"Owner access required"}""")
        if (request.method != "GET" && failWrite) error("暂时无法保存，请重试")
        if (request.method == "PATCH" && request.path.endsWith("/$id-shared")) {
            names[id] = Json.parseToJsonElement(request.body!!).jsonObject["displayName"]!!.jsonPrimitive.content
        }
        if (request.method == "DELETE") deleted += id
        val body = when {
            request.path == "/api/native-providers" -> {
                val shared = if (id in deleted) "" else """{"id":"$id-shared","syncId":"team","displayName":"${names[id]}","agentType":"codex","authType":"api-key","credentialOk":true,"credentialFingerprint":"fixture","baseUrl":"https://api.example.test/v1","quota":null},"""
                """{"providers":[$shared{"id":"$id-login","syncId":"login","displayName":"Codex 登录","agentType":"codex","authType":"oauth","credentialOk":true,"quota":null}]}"""
            }
            request.path == "/api/harnesses" -> """{"harnesses":[{"id":"codex","name":"Codex","installed":true,"supportedOnPlatform":true,"providerProtocols":["openai-responses"]}]}"""
            else -> "{}"
        }
        ApiResponse(200, body)
    }

    private fun show(connectionStates: Map<String, RuntimeConnectionState> = emptyMap()) {
        rule.runOnUiThread {
            vm = WebParityViewModel(repo("foreground"),
                providerInstancesProvider = { listOf(ProviderInstance("office", "办公室电脑"), ProviderInstance("studio", "工作室电脑"), ProviderInstance("offline", "离线笔记本")) },
                providerRepositoryFactory = ::repo)
        }
        val context = instrumentation.targetContext
        val config = Configuration(context.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) }
        val localized = context.createConfigurationContext(config)
        rule.setContent {
            val state by vm.state.collectAsState()
            CompositionLocalProvider(LocalContext provides localized, LocalConfiguration provides config) {
                AgentocTheme(darkTheme = dark) {
                    WebParitySurface(WebParityPage.ModelProviders, state, vm::onEvent, onBack = {},
                        targetConnectionStates = connectionStates,
                        targetId = "foreground", targetLabel = "当前工作电脑", connectionAvailable = false)
                }
            }
        }
        rule.waitUntil(10_000) { vm.state.value.providerInstances.size == 3 && !vm.state.value.refreshing }
    }

    private fun select(id: String) {
        rule.onNodeWithTag("provider-instance-selector").performClick()
        rule.onNodeWithTag("provider-instance-$id").performClick()
        rule.waitUntil(10_000) { vm.state.value.providerTargetId == id && !vm.state.value.refreshing }
    }

    private fun capture(name: String) {
        rule.waitForIdle()
        val file = File(instrumentation.targetContext.getExternalFilesDir(null), "provider-instances/$name-$dark.png")
        file.parentFile?.mkdirs()
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }

    @Test fun overviewMergesSharedConfigAndKeepsOfflineUnknown() {
        show()
        rule.onNodeWithTag("provider-group-shared:codex:team").assertIsDisplayed()
        rule.onNodeWithText("已确认 2 个实例的配置一致").assertIsDisplayed()
        rule.onNodeWithText("尚未确认：离线笔记本").assertIsDisplayed()
        assertEquals(3, accountProviderGroups(vm.state.value.providerInstances).size)
        capture("account-overview")
        rule.onNodeWithTag("provider-instance-selector").performClick()
        capture("instance-selector")
        rule.onNodeWithTag("provider-instance-offline").performClick()
        rule.onNodeWithText("暂时无法读取模型提供商配置，实例可达状态尚未确认。").assertIsDisplayed()
        rule.onNodeWithTag("provider-delete-offline-shared").assertDoesNotExist()
        capture("unreachable-instance")
    }

    @Test fun connectedTargetWithForbiddenProviderReadShowsConnectedAndPermissionFailure() {
        failOfficeProviderRead = true
        show(mapOf("office" to RuntimeConnectionState.Connected))
        requests.clear()
        select("office")
        rule.onNodeWithText("实例连接正常，但模型提供商配置读取失败。").assertIsDisplayed()
        rule.onNodeWithText("HTTP 403：当前会话没有管理模型提供商配置的权限。").assertIsDisplayed()
        assertFalse(vm.state.value.providerInstances.single { it.instance.id == "office" }.available)
        assertEquals(ProviderInstanceFailureKind.Forbidden,
            vm.state.value.providerInstances.single { it.instance.id == "office" }.failure?.kind)
        val providerReads = requests.filter { it.second.path == "/api/native-providers" }
        assertTrue(providerReads.any { it.first == "office" })
        assertTrue(providerReads.none { it.first == "foreground" })
        capture("connected-provider-forbidden")
    }

    @Test fun editingStaysOnSelectedInstanceAndFailurePreservesInput() {
        show(); select("studio")
        rule.onNodeWithTag("provider-edit-studio-shared").performScrollTo().performClick()
        rule.onNodeWithTag("provider-name").performTextReplacement("工作室专用模型")
        capture("edit-scope")
        rule.runOnIdle { failWrite = true; vm.onEvent(WebParityEvent.TargetChanged("office")) }
        rule.onNodeWithTag("provider-save").performClick()
        rule.waitUntil(10_000) { vm.state.value.error != null && !vm.state.value.actionInProgress }
        rule.onNodeWithTag("provider-name").assertTextContains("工作室专用模型")
        rule.runOnIdle { failWrite = false }
        rule.onNodeWithTag("provider-save").performClick()
        rule.waitUntil(10_000) { vm.state.value.providerSavedTarget == "工作室电脑" && !vm.state.value.refreshing }
        rule.onNodeWithTag("provider-name").assertDoesNotExist()
        assertEquals("团队模型", names["office"])
        assertEquals("工作室专用模型", names["studio"])
        assertTrue(requests.filter { it.second.method == "PATCH" }.all { it.first == "studio" })
        capture("saved-on-instance")
        rule.onNodeWithTag("provider-instance-selector").performClick()
        rule.onNodeWithTag("provider-instance-all").performClick()
        rule.waitUntil(10_000) { !vm.state.value.refreshing }
        rule.onNodeWithText("2 个实例的配置不一致").assertIsDisplayed()
        capture("configuration-difference")
    }

    @Test fun deleteExplainsPropagationAndTargetsSelectedInstance() {
        show(); select("studio")
        rule.onNodeWithTag("provider-delete-studio-shared").performScrollTo().performClick()
        rule.onNodeWithText("从 工作室电脑 删除，此删除操作会通过账号同步传播到其他实例。").assertIsDisplayed()
        capture("delete-scope")
        rule.onNodeWithTag("provider-delete-confirm").performClick()
        rule.waitUntil(10_000) { vm.state.value.providerSavedTarget != null && !vm.state.value.refreshing }
        assertEquals(setOf("studio"), deleted)
        assertTrue(requests.filter { it.second.method == "DELETE" }.all { it.first == "studio" })
        assertTrue(requests.none { it.first == "foreground" })
    }
}
