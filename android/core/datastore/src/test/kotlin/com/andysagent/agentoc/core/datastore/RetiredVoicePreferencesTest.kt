package com.andysagent.agentoc.core.datastore

import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class RetiredVoicePreferencesTest {
    @Test fun removesAllRetiredVoiceChoicesWithoutAffectingAccountOrOtherSettings() {
        val phone = booleanPreferencesKey("phone_local_voice_enabled")
        val language = stringPreferencesKey("voice_recognition_language")
        val chatA = stringPreferencesKey("chat_voice_choice_abc")
        val chatB = stringPreferencesKey("chat_voice_choice_def")
        val account = stringPreferencesKey("account_id")
        val unrelated = stringPreferencesKey("chat_voice_other")
        val prefs = mutablePreferencesOf(phone to true, language to "ko", chatA to "phone",
            chatB to "computer:device", account to "account", unrelated to "keep")
        removeRetiredVoicePreferences(prefs)
        assertNull(prefs[phone]); assertNull(prefs[language]); assertNull(prefs[chatA]); assertNull(prefs[chatB])
        assertEquals("account", prefs[account]); assertEquals("keep", prefs[unrelated])
        removeRetiredVoicePreferences(prefs)
        assertEquals("account", prefs[account])
    }
}
