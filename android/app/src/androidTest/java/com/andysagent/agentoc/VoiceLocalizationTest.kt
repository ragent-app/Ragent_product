package com.andysagent.agentoc

import android.content.res.Configuration
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

@RunWith(AndroidJUnit4::class)
class VoiceLocalizationTest {
    @Test
    fun voiceLanguageAndFailureMessagesAreLocalizedForEveryRagentUiLocale() {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val expected = mapOf(
            "en" to "Speech language",
            "zh-CN" to "识别语言",
            "zh-TW" to "辨識語言",
            "ja" to "音声認識の言語",
            "ko" to "인식 언어",
            "fr" to "Langue de reconnaissance",
            "es" to "Idioma de reconocimiento",
        )
        expected.forEach { (tag, sectionLabel) ->
            val localized = base.createConfigurationContext(
                Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) },
            ).resources
            assertEquals(tag, sectionLabel, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_language_section))
            assertFalse(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_language_search).isBlank())
            assertFalse(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_language_no_results).isBlank())
            assertFalse(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_error_language_unsupported).isBlank())
        }
    }
}
