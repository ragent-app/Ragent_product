package com.andysagent.agentoc

import android.content.res.Configuration
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    @Test
    fun cloudVoiceDisclosureNamesRecipientRetentionAndDraftHandlingInEveryRagentUiLocale() {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val expectedDisclosure = mapOf(
            "en" to listOf("Ragent Accounts", "ElevenLabs", "does not persist", "may retain", "draft only"),
            "zh-CN" to listOf("Ragent Accounts", "ElevenLabs", "不会持久保存", "可能", "草稿"),
            "zh-TW" to listOf("Ragent Accounts", "ElevenLabs", "不會持久保存", "可能", "草稿"),
            "ja" to listOf("Ragent Accounts", "ElevenLabs", "永続保存しません", "保持する場合があります", "下書き"),
            "ko" to listOf("Ragent Accounts", "ElevenLabs", "영구 저장하지 않지만", "보관할 수 있습니다", "초안"),
            "fr" to listOf("Ragent Accounts", "ElevenLabs", "ne conserve pas durablement", "peut les conserver", "brouillon"),
            "es" to listOf("Ragent Accounts", "ElevenLabs", "no conserva", "puede conservarlos", "borrador"),
        )
        expectedDisclosure.forEach { (tag, markers) ->
            val localized = base.createConfigurationContext(
                Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) },
            ).resources
            val disclosure = localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_upload_disclosure)
            markers.forEach { marker -> assertTrue("$tag disclosure missing '$marker': $disclosure", disclosure.contains(marker, ignoreCase = true)) }
        }
    }
}
