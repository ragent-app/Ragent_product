package com.andysagent.ragent

import android.graphics.Color as AndroidColor
import android.graphics.Bitmap
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.GoogleSignInGuideScreen
import com.andysagent.ragent.feature.workbench.GoogleSignInRequest
import com.andysagent.ragent.feature.workbench.GoogleSignInSuccessAction
import com.andysagent.ragent.feature.workbench.GoogleSignInSuccessScreen
import com.andysagent.ragent.feature.workbench.ConnectionMethodsScreen
import com.andysagent.ragent.feature.workbench.WelcomeScreen
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WelcomeScreenshotTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Before
    fun setUp() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.executeShellCommand("cmd statusbar collapse").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        automation.executeShellCommand("input keyevent KEYCODE_WAKEUP").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        automation.executeShellCommand("wm dismiss-keyguard").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        SystemClock.sleep(250)
    }

    private fun capture(
        name: String,
        dark: Boolean = false,
        fontScale: Float = 1f,
        showSignInGuide: Boolean = false,
        showSignInConfirmation: Boolean = false,
        showSignInSuccess: Boolean = false,
        signedInWithoutComputer: Boolean = false,
        showConnectionMethods: Boolean = false,
        successAction: GoogleSignInSuccessAction = GoogleSignInSuccessAction.ConnectComputer,
    ) {
        val systemBarStyle = if (dark) {
            SystemBarStyle.dark(AndroidColor.TRANSPARENT)
        } else {
            SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
        }
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            composeRule.activity.enableEdgeToEdge(
                statusBarStyle = systemBarStyle,
                navigationBarStyle = systemBarStyle,
            )
        }
        composeRule.setContent {
            RagentTheme(darkTheme = dark) {
                val density = LocalDensity.current
                CompositionLocalProvider(
                    LocalDensity provides Density(density.density, fontScale),
                ) {
                    WelcomeCapture(
                        showSignInGuide = showSignInGuide,
                        showSignInConfirmation = showSignInConfirmation,
                        showSignInSuccess = showSignInSuccess,
                        signedInWithoutComputer = signedInWithoutComputer,
                        showConnectionMethods = showConnectionMethods,
                        successAction = successAction,
                    )
                }
            }
        }
        composeRule.waitForIdle()
        SystemClock.sleep(600)
        val bitmap = takeNonBlankScreenshot(dark)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val outputDir = File(context.getExternalFilesDir(null), "welcome-screenshots").apply { mkdirs() }
        val captureSuffix = InstrumentationRegistry.getArguments().getString("captureSuffix")
            ?.takeIf { it.matches(Regex("[a-zA-Z0-9._-]+")) }
        val outputName = listOfNotNull(name, captureSuffix).joinToString("-")
        val targetFile = File(outputDir, "$outputName.png")
        FileOutputStream(targetFile).use { stream ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        }
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.executeShellCommand("mkdir -p /data/local/tmp/welcome-screenshots").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        automation.executeShellCommand("cp ${targetFile.absolutePath} /data/local/tmp/welcome-screenshots/$outputName.png").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
        automation.executeShellCommand("chmod 666 /data/local/tmp/welcome-screenshots/$outputName.png").use { command ->
            FileInputStream(command.fileDescriptor).use { it.readBytes() }
        }
    }

    private fun takeNonBlankScreenshot(dark: Boolean): Bitmap {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        repeat(15) {
            val bitmap = automation.takeScreenshot()
            if (hasVisibleContent(bitmap, dark)) return bitmap
            bitmap.recycle()
            SystemClock.sleep(300)
        }
        // If detection fails, still take a screenshot rather than throwing
        return automation.takeScreenshot()
    }

    private fun hasVisibleContent(bitmap: Bitmap, dark: Boolean): Boolean {
        var contentSamples = 0
        val startY = bitmap.height / 10
        val endY = bitmap.height * 9 / 10
        for (y in startY until endY step 8) {
            for (x in 0 until bitmap.width step 8) {
                val pixel = bitmap.getPixel(x, y)
                val r = android.graphics.Color.red(pixel)
                val g = android.graphics.Color.green(pixel)
                val b = android.graphics.Color.blue(pixel)
                if (dark) {
                    if (r > 35 || g > 35 || b > 35) {
                        contentSamples += 1
                        if (contentSamples >= 40) return true
                    }
                } else {
                    if ((r < 235 || g < 235 || b < 235) && (r > 15 || g > 15 || b > 15)) {
                        contentSamples += 1
                        if (contentSamples >= 40) return true
                    }
                }
            }
        }
        return false
    }

    @Test
    fun captureLight() = capture("welcome-v2-light")

    @Test
    fun captureDark() = capture("welcome-v2-dark", dark = true)

    @Test
    fun captureLightSignInGuide() = capture(
        name = "welcome-v3-light-sign-in-guide",
        showSignInGuide = true,
    )

    @Test
    fun captureDarkSignInGuide() = capture(
        name = "welcome-v3-dark-sign-in-guide",
        dark = true,
        showSignInGuide = true,
    )

    @Test
    fun captureFontScale130SignInGuide() = capture(
        name = "welcome-v3-font-130-sign-in-guide",
        fontScale = 1.3f,
        showSignInGuide = true,
    )

    @Test
    fun captureDarkSignInConfirmation() = capture(
        name = "welcome-v3-dark-sign-in-confirmation",
        dark = true,
        showSignInGuide = true,
        showSignInConfirmation = true,
    )

    @Test
    fun captureLightSignInSuccessConnect() = capture(
        name = "welcome-v4-light-sign-in-success-connect",
        showSignInSuccess = true,
    )

    @Test
    fun captureDarkSignInSuccessEnterApp() = capture(
        name = "welcome-v4-dark-sign-in-success-enter-app",
        dark = true,
        showSignInSuccess = true,
        successAction = GoogleSignInSuccessAction.EnterApp,
    )

    @Test
    fun captureFontScale130() = capture("welcome-v2-font-130", fontScale = 1.3f)

    @Test
    fun captureSignedInWithoutComputer() = capture(
        name = "welcome-v5-light-signed-in-without-computer",
        signedInWithoutComputer = true,
    )

    @Test
    fun captureConnectionMethods() = capture(
        name = "welcome-v5-dark-connection-methods",
        dark = true,
        showConnectionMethods = true,
    )
}

@Composable
private fun WelcomeCapture(
    showSignInGuide: Boolean = false,
    showSignInConfirmation: Boolean = false,
    showSignInSuccess: Boolean = false,
    signedInWithoutComputer: Boolean = false,
    showConnectionMethods: Boolean = false,
    successAction: GoogleSignInSuccessAction = GoogleSignInSuccessAction.ConnectComputer,
) {
    if (showSignInSuccess) {
        GoogleSignInSuccessScreen(
            action = successAction,
            onAction = {},
        )
    } else if (showConnectionMethods) {
        ConnectionMethodsScreen(onBack = {})
    } else if (showSignInGuide) {
        GoogleSignInGuideScreen(
            onContinue = {},
            onBack = {},
        )
    } else {
        WelcomeScreen(
            onConnectComputer = {},
            onScanPairing = {},
            signedIn = signedInWithoutComputer,
        )
    }
    if (showSignInConfirmation) {
        GoogleSignInConfirmationDialog(
            request = GoogleSignInRequest.PairComputer,
            onConfirm = {},
            onDismiss = {},
        )
    }
}
