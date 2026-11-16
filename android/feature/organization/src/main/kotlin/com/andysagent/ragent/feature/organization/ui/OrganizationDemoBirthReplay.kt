package com.andysagent.ragent.feature.organization.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf

/** Only the debug activity creates a controller; normal app sessions always provide null. */
class OrganizationDemoBirthReplay {
    var sequence by mutableIntStateOf(0)
        private set
    private var consumed = 0

    fun request() { sequence += 1 }
    fun discardPending() { consumed = sequence }
    fun consume(request: Int): Boolean {
        if (request <= consumed || request != sequence) return false
        consumed = request
        return true
    }
}

val LocalOrganizationDemoBirthReplay = staticCompositionLocalOf<OrganizationDemoBirthReplay?> { null }
