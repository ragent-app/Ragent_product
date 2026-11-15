package com.andysagent.ragent.core.datastore

import androidx.datastore.preferences.core.*
import kotlin.test.*

class AccountDirectoryProfilesTest {
    @Test fun directoryOwnerSurvivesLossOfAccountCredentialMetadataUntilCleanup() {
        val prefs=mutablePreferencesOf()
        AccountDirectoryProfiles.switch(prefs,null,"acct_a")
        assertEquals("acct_a",AccountDirectoryProfiles.owner(prefs,null))
        AccountDirectoryProfiles.switch(prefs,null,null)
        assertNull(AccountDirectoryProfiles.owner(prefs,"stale_account"))
    }

    private val computers = stringPreferencesKey("linked_computers")
    private val active = stringPreferencesKey("active_target_id")
    @Test fun localAndTwoAccountsRestoreOnlyTheirOwnDirectoryAndSelection() {
        val prefs = mutablePreferencesOf(computers to "local-machines", active to "local")
        AccountDirectoryProfiles.switch(prefs, null, "acct_a")
        assertNull(prefs[computers])
        prefs[computers] = "account-a-machines"; prefs[active] = "a"
        AccountDirectoryProfiles.switch(prefs, "acct_a", "acct_b")
        assertNull(prefs[computers]); assertNull(prefs[active])
        prefs[computers] = "account-b-machines"; prefs[active] = "b"
        AccountDirectoryProfiles.switch(prefs, "acct_b", null)
        assertEquals("local-machines", prefs[computers]); assertEquals("local", prefs[active])
        AccountDirectoryProfiles.switch(prefs, null, "acct_a")
        assertEquals("account-a-machines", prefs[computers]); assertEquals("a", prefs[active])
        AccountDirectoryProfiles.switch(prefs, "acct_a", "acct_b")
        assertEquals("account-b-machines", prefs[computers]); assertEquals("b", prefs[active])
    }
    @Test fun renewalKeepsDirectoryAndMalformedArchiveCannotEraseCurrentState() {
        val prefs = mutablePreferencesOf(computers to "existing")
        AccountDirectoryProfiles.switch(prefs, "acct_a", "acct_a")
        assertEquals("existing", prefs[computers])
        prefs[stringPreferencesKey("account_directory_profiles_v1")] = "invalid-json"
        assertFails { AccountDirectoryProfiles.switch(prefs, "acct_a", "acct_b") }
        assertEquals("existing", prefs[computers])
    }
    @Test fun archiveExcludesCredentialsAndExpiresPendingJoins() {
        val token = stringPreferencesKey("bearer_token")
        val pending = stringPreferencesKey("pending_join_nonce")
        val prefs = mutablePreferencesOf(computers to "machines", token to "never-archive-me", pending to "old-join")
        AccountDirectoryProfiles.switch(prefs, null, "acct_a")
        assertFalse(prefs[stringPreferencesKey("account_directory_profiles_v1")]!!.contains("never-archive-me"))
        assertEquals("never-archive-me", prefs[token]); assertNull(prefs[pending])
    }
}
