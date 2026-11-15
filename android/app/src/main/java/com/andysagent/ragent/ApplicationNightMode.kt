package com.andysagent.ragent

import android.app.UiModeManager
import com.andysagent.ragent.core.model.AppTheme

/** Application-only resource override, never the device-wide night mode. */
internal fun applicationNightMode(theme: AppTheme): Int = when (theme) {
    AppTheme.Dark, AppTheme.Oled, AppTheme.Amber -> UiModeManager.MODE_NIGHT_YES
    AppTheme.Light -> UiModeManager.MODE_NIGHT_NO
    // In setApplicationNightMode (unlike setNightMode), AUTO clears the fixed
    // package override to UI_MODE_NIGHT_UNDEFINED, inheriting the system config.
    AppTheme.System, AppTheme.Monet -> UiModeManager.MODE_NIGHT_AUTO
}
