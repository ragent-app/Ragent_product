package com.andysagent.ragent.feature.organization.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.andysagent.ragent.core.designsystem.RagentTheme

/** Explicit debug-only entry point; the demo itself uses only its local projection. */
class OrganizationDemoActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val theme = intent.getStringExtra("theme").takeIf { it == "light" || it == "dark" } ?: "system"
        setContent {
            RagentTheme(themeVariant = theme) {
                OrganizationDemoScreen(onBack = ::finish)
            }
        }
    }
}
