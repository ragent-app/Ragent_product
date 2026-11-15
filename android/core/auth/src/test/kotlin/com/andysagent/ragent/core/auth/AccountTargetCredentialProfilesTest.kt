package com.andysagent.ragent.core.auth

import kotlinx.coroutines.flow.MutableStateFlow
import kotlin.test.*

class AccountTargetCredentialProfilesTest {
    private class Credentials : CredentialStore {
        val tokens = mutableMapOf<String,String>()
        val metadata = mutableMapOf<String,StoredCredential>()
        override val credential = MutableStateFlow<StoredCredential?>(null)
        override fun read() = error("Unscoped read")
        override fun write(token:String, expiresAt:String?, scope:String?) = error("Unscoped write")
        override fun clear() = error("Unscoped clear")
        override fun read(instanceId:String) = metadata[instanceId]
        override fun readToken(instanceId:String) = tokens[instanceId]
        override fun write(instanceId:String,token:String,expiresAt:String?,scope:String?) {
            tokens[instanceId]=token;metadata[instanceId]=StoredCredential(expiresAt,scope)
        }
        override fun clear(instanceId:String) {tokens.remove(instanceId);metadata.remove(instanceId)}
        private val profileRecords = mutableMapOf<Pair<String?,String>,Pair<String,StoredCredential>>()
        override fun readAccountProfile(accountId:String?,instanceId:String) = profileRecords[accountId to instanceId]?.second
        override fun readAccountProfileToken(accountId:String?,instanceId:String) = profileRecords[accountId to instanceId]?.first
        override fun writeAccountProfile(accountId:String?,instanceId:String,token:String,expiresAt:String?,scope:String?) {

            profileRecords[accountId to instanceId] = token to StoredCredential(expiresAt,scope)
        }
        override fun clearAccountProfile(accountId:String?,instanceId:String) { profileRecords.remove(accountId to instanceId) }
        override fun clearAccountProfiles(accountId:String?) {
            profileRecords.keys.filter { it.first == accountId }.forEach { profileRecords.remove(it) }
        }

    }
    private class Secrets : P2PSecretStore {
        val values = mutableMapOf<String,StoredP2PConfig>()
        override fun read():StoredP2PConfig? = error("Unscoped read")
        override fun write(config:StoredP2PConfig) = error("Unscoped write")
        override fun clear() = error("Unscoped clear")
        override fun read(instanceId:String) = values[instanceId]
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
    @Test fun sameTargetCredentialsAreRestoredOnlyForTheirOriginalAccount() {
        val credentials=Credentials();val secrets=Secrets();val profiles=AccountTargetCredentialProfiles(credentials,secrets)
        credentials.write("inst_same","token-a","expiry-a","scope-a")
        secrets.write("inst_same",StoredP2PConfig("https://signal","room-a","secret-a"))
        profiles.archive("acct_a",listOf("inst_same"));profiles.clearActive(listOf("inst_same"))
        profiles.restore("acct_b",listOf("inst_same"));assertNull(credentials.readToken("inst_same"));assertNull(secrets.read("inst_same"))
        credentials.write("inst_same","token-b",null,"scope-b")
        secrets.write("inst_same",StoredP2PConfig("https://signal","room-b","secret-b"))
        profiles.archive("acct_b",listOf("inst_same"));profiles.clearActive(listOf("inst_same"))
        profiles.restore("acct_a",listOf("inst_same"))
        assertEquals("token-a",credentials.readToken("inst_same"));assertEquals("expiry-a",credentials.read("inst_same")?.expiresAt)
        assertEquals("secret-a",secrets.read("inst_same")?.secret)
        profiles.restore("acct_b",listOf("inst_same"))
        assertEquals("token-b",credentials.readToken("inst_same"));assertEquals("secret-b",secrets.read("inst_same")?.secret)
    }
    @Test fun localArchiveIsDistinctAndRevokedActiveCredentialsReplaceOldArchive() {
        val credentials=Credentials();val profiles=AccountTargetCredentialProfiles(credentials,Secrets())
        credentials.write("inst_one","local",null,null);profiles.archive(null,listOf("inst_one"))
        profiles.restore("acct_a",listOf("inst_one"));assertNull(credentials.readToken("inst_one"))
        profiles.restore(null,listOf("inst_one"));assertEquals("local",credentials.readToken("inst_one"))
        profiles.clearActive(listOf("inst_one"));profiles.archive(null,listOf("inst_one"))
        profiles.restore(null,listOf("inst_one"));assertNull(credentials.readToken("inst_one"))
    }

    @Test fun archivesAreNotVirtualInstancesAndCannotBeOverwrittenByAnInstanceId() {
        val credentials=Credentials();val secrets=Secrets();val profiles=AccountTargetCredentialProfiles(credentials,secrets)
        credentials.write("inst_one","token-a",null,"owner")
        secrets.write("inst_one",StoredP2PConfig("https://signal","room-a","secret-a"))
        profiles.archive("acct_a",listOf("inst_one"))
        assertEquals(setOf("inst_one"),credentials.tokens.keys)
        assertEquals(setOf("inst_one"),secrets.values.keys)
        val oldAlias="profile_"+java.security.MessageDigest.getInstance("SHA-256")
            .digest("acct_a\u0000inst_one".toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
        credentials.write(oldAlias,"different-device",null,"other")
        secrets.write(oldAlias,StoredP2PConfig("https://signal","other","other-secret"))
        profiles.clearActive(listOf("inst_one"));profiles.restore("acct_a",listOf("inst_one"))
        assertEquals("token-a",credentials.readToken("inst_one"))
        assertEquals("secret-a",secrets.read("inst_one")?.secret)
        assertEquals("different-device",credentials.readToken(oldAlias))
    }

    @Test fun purgeIncludesOrphanedTargetsAndPreservesOtherOwnersAndActiveSlots() {
        val credentials=Credentials();val secrets=Secrets();val profiles=AccountTargetCredentialProfiles(credentials,secrets)
        for (owner in listOf("acct_a","acct_b",null)) {
            for (id in listOf("same","removed-from-directory")) {
                credentials.write(id,"token-$owner",null,"owner")
                secrets.write(id,StoredP2PConfig("https://signal",id,"secret-$owner"))
            }
            profiles.archive(owner,listOf("same","removed-from-directory"))
        }
        credentials.write("active","active-token",null,"owner")
        profiles.purge("acct_a")
        for (id in listOf("same","removed-from-directory")) {
            assertNull(credentials.readAccountProfileToken("acct_a",id));assertNull(secrets.readAccountProfile("acct_a",id))
            assertEquals("token-acct_b",credentials.readAccountProfileToken("acct_b",id))
            assertEquals("secret-acct_b",secrets.readAccountProfile("acct_b",id)?.secret)
            assertEquals("token-null",credentials.readAccountProfileToken(null,id))
        }
        assertEquals("active-token",credentials.readToken("active"))
    }

    @Test fun localOwnerCannotAliasAnAccountNamedLocal() {
        val credentials=Credentials();val profiles=AccountTargetCredentialProfiles(credentials,Secrets())
        credentials.write("same","local-token",null,null);profiles.archive(null,listOf("same"))
        credentials.write("same","account-token",null,null);profiles.archive("local",listOf("same"))
        profiles.restore(null,listOf("same"));assertEquals("local-token",credentials.readToken("same"))
        profiles.restore("local",listOf("same"));assertEquals("account-token",credentials.readToken("same"))
        profiles.purge(null);profiles.restore("local",listOf("same"))
        assertEquals("account-token",credentials.readToken("same"))
    }

    @Test fun unsupportedLegacyStoresFailWithoutClearingUnscopedCredentials() {
        val credentials=FakeCredentialStore();credentials.write("keep-token",null,"owner")
        val profiles=AccountTargetCredentialProfiles(credentials,Secrets())
        assertFailsWith<UnsupportedOperationException> { profiles.archive("acct_a",listOf("target")) }
        assertEquals("keep-token",credentials.lastToken)
    }
}
