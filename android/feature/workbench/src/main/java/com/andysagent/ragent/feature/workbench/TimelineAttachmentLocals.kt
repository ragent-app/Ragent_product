package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.UriHandler

/** Scoped by the host to the currently displayed conversation. */
val LocalTimelineUriHandler = staticCompositionLocalOf<UriHandler?> { null }
