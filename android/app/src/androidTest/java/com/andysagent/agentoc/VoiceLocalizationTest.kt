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
    fun cloudRecognitionStatusAndFailureMessagesAreLocalizedForEveryRagentUiLocale() {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        listOf("en", "zh-CN", "zh-TW", "ja", "ko", "fr", "es").forEach { tag ->
            val localized = base.createConfigurationContext(
                Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(tag)) },
            ).resources
            assertFalse(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_unavailable).isBlank())
            assertFalse(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_quota_exceeded).isBlank())
            assertFalse(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_sign_in_required).isBlank())
            assertFalse(tag, localized.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_recording_invalid).isBlank())
        }
    }

    @Test
    fun cloudVoiceDisclosureNamesRecipientRetentionAndDraftHandlingInEveryRagentUiLocale() {
        val base = InstrumentationRegistry.getInstrumentation().targetContext
        val expectedDisclosure = mapOf(
            "en" to listOf("Ragent Accounts", "OpenAI", "does not store", "90 days", "not used to train", "five years", "draft only"),
            "zh-CN" to listOf("Ragent Accounts", "OpenAI", "存入数据库", "90 天", "不会用于训练", "五年", "草稿"),
            "zh-TW" to listOf("Ragent Accounts", "OpenAI", "不會將", "90 天", "不會用於訓練", "五年", "草稿"),
            "ja" to listOf("Ragent Accounts", "OpenAI", "データベースに保存しません", "90日間", "トレーニング", "5年間", "下書き"),
            "ko" to listOf("Ragent Accounts", "OpenAI", "데이터베이스에 저장하지 않지만", "90일간", "학습", "5년간", "초안"),
            "fr" to listOf("Ragent Accounts", "OpenAI", "ne stocke ni", "90 jours", "ne sont pas utilisées pour entraîner", "cinq ans", "brouillon"),
            "es" to listOf("Ragent Accounts", "OpenAI", "no guarda", "90 días", "no se utilizan para entrenar", "cinco años", "borrador"),
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
