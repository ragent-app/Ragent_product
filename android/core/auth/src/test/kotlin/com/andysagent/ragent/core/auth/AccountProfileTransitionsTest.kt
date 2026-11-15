package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.datastore.AccountProfileTransition
import com.andysagent.ragent.core.datastore.AccountProfileDirectoryState
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.test.*

class AccountProfileTransitionsTest {
    private class Tokens : CredentialStore {
        val values=mutableMapOf<String,String>(); val metadata=mutableMapOf<String,StoredCredential>()
        var failWrite:String?=null;var failAnyWrite=false
        override val credential=MutableStateFlow<StoredCredential?>(null)
        override fun read():StoredCredential?=error("Unscoped")
        override fun write(token:String,expiresAt:String?,scope:String?)=error("Unscoped")
        override fun clear()=error("Unscoped")
        override fun read(instanceId:String)=metadata[instanceId]
        override fun readToken(instanceId:String)=values[instanceId]
        override fun write(instanceId:String,token:String,expiresAt:String?,scope:String?) {
            if(failAnyWrite || instanceId==failWrite) error("Persist failed")
            values[instanceId]=token;metadata[instanceId]=StoredCredential(expiresAt,scope)
        }
        override fun clear(instanceId:String) {values.remove(instanceId);metadata.remove(instanceId)}
        private val profileRecords = mutableMapOf<Pair<String?,String>,Pair<String,StoredCredential>>()
        override fun readAccountProfile(accountId:String?,instanceId:String) = profileRecords[accountId to instanceId]?.second
        override fun readAccountProfileToken(accountId:String?,instanceId:String) = profileRecords[accountId to instanceId]?.first
        override fun writeAccountProfile(accountId:String?,instanceId:String,token:String,expiresAt:String?,scope:String?) {
            if (failAnyWrite) error("Persist failed")
            profileRecords[accountId to instanceId] = token to StoredCredential(expiresAt,scope)
        }
        override fun clearAccountProfile(accountId:String?,instanceId:String) { profileRecords.remove(accountId to instanceId) }
        override fun clearAccountProfiles(accountId:String?) {
            profileRecords.keys.filter { it.first == accountId }.forEach { profileRecords.remove(it) }
        }

    }
    private class Secrets : P2PSecretStore {
        val values=mutableMapOf<String,StoredP2PConfig>()
        override fun read():StoredP2PConfig?=error("Unscoped")
        override fun write(config:StoredP2PConfig)=error("Unscoped")
        override fun clear()=error("Unscoped")
        override fun read(instanceId:String)=values[instanceId]
        override fun write(instanceId:String,config:StoredP2PConfig) {values[instanceId]=config}
        override fun clear(instanceId:String) {values.remove(instanceId)}
        private val profileRecords = mutableMapOf<Pair<String?,String>,StoredP2PConfig>()
        override fun readAccountProfile(accountId:String?,instanceId:String) = profileRecords[accountId to instanceId]
        override fun writeAccountProfile(accountId:String?,instanceId:String,config:StoredP2PConfig) { profileRecords[accountId to instanceId] = config }
        override fun clearAccountProfile(accountId:String?,instanceId:String) { profileRecords.remove(accountId to instanceId) }
        override fun clearAccountProfiles(accountId:String?) {
            profileRecords.keys.filter { it.first == accountId }.forEach { profileRecords.remove(it) }
        }

    }
    private class RootToken : AccountCredentialStore {
        var token:String?="rac_a"
        override fun readToken()=token
        override fun writeToken(token:String) {this.token=token}
        override fun clear() {token=null}
    }
    private class State : AccountProfileTransitionStore {
        var raw:String?=null
        var current=AccountProfileDirectoryState("acct_a","acct_a",listOf("same","a"))
        var failClear=false
        override suspend fun read()=raw?.let {Json.decodeFromString<AccountProfileTransition>(it)}
        override suspend fun write(value:AccountProfileTransition) {check(raw==null);raw=Json.encodeToString(value)}
        override suspend fun clear(id:String) {
            if(failClear) error("Journal clear failed")
            check(read()?.id==id);raw=null
        }
        override suspend fun state()=current
        override suspend fun clearAccountSession() {current=AccountProfileDirectoryState(null,null,listOf("local"))}
    }
    private class Fixture {
        val tokens=Tokens();val secrets=Secrets();val account=RootToken();val state=State()
        val profiles=AccountTargetCredentialProfiles(tokens,secrets)
        init {
            seed(null,listOf("local"),"local")
            seed("acct_b",listOf("same","b"),"b")
            active(listOf("same","a"),"a")
        }
        private fun active(ids:List<String>,suffix:String) {ids.forEach {
            tokens.write(it,"rda_${it}_$suffix","2099-01-01T00:00:00Z","owner")
            secrets.write(it,StoredP2PConfig("https://signal",it,"secret_${it}_$suffix"))
        }}
        private fun seed(owner:String?,ids:List<String>,suffix:String) {active(ids,suffix);profiles.archive(owner,ids);profiles.clearActive(ids)}
        fun coordinator()=AccountProfileTransitions(state,account,profiles) {"transition_fixture"}
        fun login()=AccountDirectoryChange("acct_b",accountTokenFingerprint("rac_b"),false)
        fun commitLogin() {account.writeToken("rac_b");state.current=AccountProfileDirectoryState("acct_b","acct_b",listOf("same","b"))}
    }

    @Test fun archiveFailureCannotCreateAnIntentOrClearActiveCredentials()=runBlocking {
        val f=Fixture();f.tokens.failAnyWrite=true
        assertFailsWith<IllegalStateException> {f.coordinator().begin(f.login())}
        assertNull(f.state.raw);assertEquals("rda_same_a",f.tokens.readToken("same"))
        assertEquals("acct_a",f.state.current.sessionAccountId)
    }
    @Test fun interruptedBeforeDirectoryCommitAbortsLoginWithoutLosingOriginalArchive()=runBlocking {
        val f=Fixture();f.coordinator().begin(f.login())
        assertFalse(f.state.raw!!.contains("rac_b"));assertFalse(f.state.raw!!.contains("secret_"))
        f.profiles.clearActive(listOf("same"))
        f.coordinator().recover()
        assertNull(f.account.token);assertNull(f.state.current.profileAccountId);assertNull(f.state.raw)
        assertEquals("rda_local_local",f.tokens.readToken("local"));assertNull(f.tokens.readToken("same"))
        f.profiles.restore("acct_a",listOf("same","a"))
        assertEquals("rda_same_a",f.tokens.readToken("same"))
    }
    @Test fun tokenPersistedWithoutItsMatchingDirectoryNeverBecomesAnActiveLogin()=runBlocking {
        val f=Fixture();f.coordinator().begin(f.login());f.account.writeToken("rac_b")
        f.coordinator().recover()
        assertNull(f.account.token);assertNull(f.state.current.sessionAccountId)
        assertEquals("rda_local_local",f.tokens.readToken("local"))
    }
    @Test fun committedLoginRepairsMixedActiveSlotsForOnlyTheNewAccount()=runBlocking {
        val f=Fixture();f.coordinator().begin(f.login());f.commitLogin()
        f.coordinator().recover()
        assertEquals("rac_b",f.account.token);assertNull(f.state.raw)
        assertEquals("rda_same_b",f.tokens.readToken("same"));assertNull(f.tokens.readToken("a"))
        assertEquals("secret_same_b",f.secrets.read("same")?.secret)
        f.tokens.write("same","rda_refreshed",null,"owner")
        f.coordinator().recover();assertEquals("rda_refreshed",f.tokens.readToken("same"))
    }
    @Test fun interruptedLogoutIsCompletedInsteadOfRevivingOldAuthority()=runBlocking {
        val f=Fixture();f.coordinator().begin(AccountDirectoryChange(null,null,false))
        f.coordinator().recover()
        assertNull(f.account.token);assertNull(f.state.current.sessionAccountId);assertNull(f.tokens.readToken("same"))
        assertEquals("rda_local_local",f.tokens.readToken("local"))
    }
    @Test fun failedRestoreRetainsTheJournalAndCanRepairOnANewCoordinator()=runBlocking {
        val f=Fixture();f.coordinator().begin(f.login());f.commitLogin();f.tokens.failWrite="b"
        assertFailsWith<IllegalStateException> {f.coordinator().recover()};assertNotNull(f.state.raw)
        f.tokens.failWrite=null;f.coordinator().recover()
        assertNull(f.state.raw);assertEquals("rda_b_b",f.tokens.readToken("b"))
    }
    @Test fun failedJournalClearCanRetryAndPendingIntentCannotOverwriteItsOnlyArchive()=runBlocking {
        val f=Fixture();f.coordinator().begin(f.login());f.profiles.clearActive(listOf("same","a"))
        assertFailsWith<IllegalStateException> {f.coordinator().begin(f.login())}
        f.commitLogin();f.state.failClear=true
        assertFailsWith<IllegalStateException> {f.coordinator().recover()};assertNotNull(f.state.raw)
        f.state.failClear=false;f.coordinator().recover();assertNull(f.state.raw)
        f.profiles.restore("acct_a",listOf("same"));assertEquals("rda_same_a",f.tokens.readToken("same"))
    }
    @Test fun mismatchedPersistedBearerCannotClaimACommittedDirectory()=runBlocking {
        val f=Fixture();f.coordinator().begin(f.login());f.commitLogin();f.account.writeToken("rac_other")
        f.coordinator().recover();assertNull(f.account.token);assertNull(f.state.current.profileAccountId)
    }
}
