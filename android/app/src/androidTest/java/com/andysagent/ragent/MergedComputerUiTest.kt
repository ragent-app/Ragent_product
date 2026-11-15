package com.andysagent.ragent

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.model.RemoteTarget
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.protocol.TargetSummary
import com.andysagent.ragent.core.protocol.TargetSummarySessionCounts
import com.andysagent.ragent.feature.workbench.WorkbenchEvent
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.Locale

/** Merge regression: synthetic summaries/aliases, no real Accounts or PC requests. */
class MergedComputerUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val events = mutableListOf<WorkbenchEvent>()
    private val targets = listOf(
        RemoteTarget("office", "Office computer", ""),
        RemoteTarget("home", "Home computer", ""),
    )

    private fun show(destination: AgentoDestination, dark: Boolean) {
        val context = rule.activity.createConfigurationContext(
            Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.ENGLISH) },
        )
        rule.setContent {
            CompositionLocalProvider(LocalContext provides context) {
                RagentTheme(darkTheme = dark, motionPreference = MotionPreference.None) {
                    WorkbenchScreen(
                        WorkbenchUiState(
                            destination = destination,
                            connection = AgentConnectionStatus.Connected,
                            activeRemoteTargetId = "office",
                            remoteTargets = targets,
                            backgroundTargetSummaries = listOf(TargetSummary(
                                targetId = "home", instanceId = "home", generatedAt = "2026-10-12T00:00:00Z",
                                sessions = TargetSummarySessionCounts(total = 12, active = 2),
                            )),
                        ),
                        onEvent = { events += it },
                    )
                }
            }
        }
        rule.waitForIdle()
    }

    private fun capture(name: String) {
        val output = File(rule.activity.getExternalFilesDir(null), "merge-qa/$name.png")
        output.parentFile!!.mkdirs()
        output.outputStream().use {
            assertTrue(rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it))
        }
    }

    private fun checkSummary(dark: Boolean) {
        show(AgentoDestination.Home, dark)
        rule.onNodeWithContentDescription("Background computer Home computer").assertIsDisplayed()
        rule.onNodeWithText("2 active · 12 sessions", useUnmergedTree = true).assertIsDisplayed()
        capture("home-summary-${if (dark) "dark" else "light"}")
        assertTrue("Background summary must not switch the selected computer", events.none { it is WorkbenchEvent.SelectRemoteTarget })
    }
    @Test fun summaryIsVisibleWithAnEmptyPrimaryLight() = checkSummary(false)
    @Test fun summaryIsVisibleWithAnEmptyPrimaryDark() = checkSummary(true)

    private fun checkPicker(dark: Boolean) {
        show(AgentoDestination.Sessions, dark)
        rule.onNodeWithContentDescription("Device selector Office computer").assertIsDisplayed()
        capture("computer-selector-${if (dark) "dark" else "light"}")
        rule.onNodeWithContentDescription("Device selector Office computer").performClick()
        rule.onNodeWithText("Home computer").performClick()
        assertTrue(events.contains(WorkbenchEvent.SelectRemoteTarget("home")))
    }
    @Test fun pickerUsesActiveAliasAndEmitsExplicitTargetLight() = checkPicker(false)
    @Test fun pickerUsesActiveAliasAndEmitsExplicitTargetDark() = checkPicker(true)
}
