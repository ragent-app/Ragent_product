package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.navigation.AgentoBottomNavigation
import com.andysagent.ragent.core.navigation.AgentoDestination
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.Locale

class AdaptiveNavigationUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private lateinit var labels: Map<AgentoDestination, String>

    private fun show(locale: Locale, scale: Float, width: Int, create: Boolean = false) {
        val context = android.view.ContextThemeWrapper(rule.activity, 0).apply {
            applyOverrideConfiguration(Configuration(rule.activity.resources.configuration).apply { setLocale(locale) })
        }
        labels = AgentoDestination.entries.associateWith { context.getString(it.labelRes) }
        rule.setContent {
            val density = LocalDensity.current
            var selected by remember { mutableStateOf(if (create) AgentoDestination.Sessions else AgentoDestination.Settings) }
            CompositionLocalProvider(LocalContext provides context,
                LocalDensity provides Density(density.density, scale)) {
                RagentTheme(darkTheme = true, motionPreference = MotionPreference.None) {
                    Box(Modifier.width(width.dp)) {
                        AgentoBottomNavigation(selected, { selected = it },
                            onCreateProject = if (create) ({}) else null)
                    }
                }
            }
        }
    }

    @Test fun largeFrenchNavigationUsesIconsWithFullNamesAndLargeTargets() {
        show(Locale.FRENCH, 2f, 320)
        labels.values.forEach { rule.onNodeWithText(it).assertDoesNotExist() }
        labels.forEach { (_, label) ->
            rule.onNodeWithContentDescription(label).assertIsDisplayed()
                .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
                .performTouchInput { click() }.assertIsSelected()
        }
    }

    @Test fun narrowFrenchNavigationWithCreationActionDoesNotTruncateLabels() {
        show(Locale.FRENCH, 1.5f, 320, create = true)
        labels.values.forEach { rule.onNodeWithText(it).assertDoesNotExist() }
        labels.values.forEach { rule.onNodeWithContentDescription(it).assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp) }
    }

    @Test fun ordinaryEnglishNavigationKeepsLabelsAndEvenSelectionClearance() {
        show(Locale.ENGLISH, 1f, 411)
        labels.values.forEach { rule.onNodeWithText(it).assertIsDisplayed() }
        fun shell() = rule.onNodeWithTag("bottom-navigation-shell").getUnclippedBoundsInRoot()
        val lens = rule.onNodeWithTag("bottom-navigation-selection")
        rule.onNodeWithContentDescription(labels.getValue(AgentoDestination.Sessions)).performTouchInput { click() }
        // Chat and Settings have different centred shell bounds. Compare each
        // lens with its current shell, not a cached pre-navigation rectangle.
        val left = lens.getUnclippedBoundsInRoot().left - shell().left
        rule.onNodeWithContentDescription(labels.getValue(AgentoDestination.Settings)).performTouchInput { click() }
        val right = shell().right - lens.getUnclippedBoundsInRoot().right
        assertEquals(left.value, right.value, 1f)
        assertEquals(4f, left.value, 1f)
    }
}
