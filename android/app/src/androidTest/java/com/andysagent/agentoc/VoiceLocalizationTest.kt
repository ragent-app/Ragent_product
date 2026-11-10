package com.andysagent.agentoc

import android.content.res.Configuration
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

@RunWith(AndroidJUnit4::class)
class VoiceLocalizationTest {
    @Test
    fun phoneRecognitionStatusAndFailureMessagesAreLocalizedForEveryRagentUiLocale() {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        listOf("en", "zh-CN", "zh-TW", "ja", "ko", "fr", "es").forEach { tag ->
            val localized = base.createConfigurationContext(
                Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) },
            ).resources
            assertFalse(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_phone_ready).isBlank())
            assertFalse(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_phone_native_language_unsupported).isBlank())
            assertFalse(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_error_language_unsupported).isBlank())
            assertFalse(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_error_language_pack_missing).isBlank())
        }
    }
}
