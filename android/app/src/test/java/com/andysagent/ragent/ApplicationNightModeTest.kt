package com.andysagent.ragent

import android.app.UiModeManager
import com.andysagent.ragent.core.model.AppTheme
import kotlin.test.Test
import kotlin.test.assertEquals

class ApplicationNightModeTest {
    @Test fun allDarkPalettesUseNightResources() {
        listOf(AppTheme.Dark, AppTheme.Oled, AppTheme.Amber).forEach {
            assertEquals(UiModeManager.MODE_NIGHT_YES, applicationNightMode(it))
        }
    }

    @Test fun lightUsesDayResources() {
        assertEquals(UiModeManager.MODE_NIGHT_NO, applicationNightMode(AppTheme.Light))
    }

    @Test fun systemAndDynamicPalettesClearFixedOverride() {
        listOf(AppTheme.System, AppTheme.Monet).forEach {
            assertEquals(UiModeManager.MODE_NIGHT_AUTO, applicationNightMode(it))
        }
    }
}
