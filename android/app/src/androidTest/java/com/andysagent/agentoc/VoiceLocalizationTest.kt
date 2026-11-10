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
            "en" to listOf("Ragent Accounts", "ElevenLabs", "does not store", "90 days", "improve its services", "five years", "draft only"),
            "zh-CN" to listOf("Ragent Accounts", "ElevenLabs", "存入数据库", "90 天", "改进服务", "五年", "草稿"),
            "zh-TW" to listOf("Ragent Accounts", "ElevenLabs", "不會將", "90 天", "改善服務", "五年", "草稿"),
            "ja" to listOf("Ragent Accounts", "ElevenLabs", "データベースに保存しません", "90日間", "サービス改善", "5年間", "下書き"),
            "ko" to listOf("Ragent Accounts", "ElevenLabs", "데이터베이스에 저장하지 않지만", "90일간", "서비스 개선", "5년간", "초안"),
            "fr" to listOf("Ragent Accounts", "ElevenLabs", "ne stocke ni", "90 jours", "améliorer ses services", "cinq ans", "brouillon"),
            "es" to listOf("Ragent Accounts", "ElevenLabs", "no guarda", "90 días", "mejorar sus servicios", "cinco años", "borrador"),
        )
        expectedDisclosure.forEach { (tag, markers) ->
            val localized = base.createConfigurationContext(
                Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) },
            ).resources
            val disclosure = localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_upload_disclosure)
            markers.forEach { marker -> assertTrue("$tag disclosure missing '$marker': $disclosure", disclosure.contains(marker, ignoreCase = true)) }
            assertTrue(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_consent_accept).isNotBlank())
            assertTrue(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_consent_revoke).isNotBlank())
        }
    }
}
