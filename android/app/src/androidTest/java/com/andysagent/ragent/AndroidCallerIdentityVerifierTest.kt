package com.andysagent.ragent

import android.content.Context
import android.os.Process
import androidx.test.core.app.ApplicationProvider
import com.andysagent.ragent.core.appapi.*
import org.junit.Test
import org.junit.Assert.*

class AndroidCallerIdentityVerifierTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    @Test fun localBinderFallbackUsesActualProcessUidAndInstalledSigners() {
        val verifier = AndroidCallerIdentityVerifier(context)
        val caller = verifier.captureBinderCaller(context.packageName)
        assertEquals(Process.myUid(), caller.uid)
        assertEquals(context.packageName, caller.packageName)
        assertTrue(caller.currentSignerSha256.isNotEmpty())
        assertTrue(verifier.isCurrent(caller))
        assertNotEquals("ragent:internal-owner", caller.binding)
    }
    @Test fun foreignPackageHintCannotReplaceTheCapturedBinderUid() {
        try { AndroidCallerIdentityVerifier(context).captureBinderCaller("com.agentoncloud.android.sharefixture"); fail("Forged hint accepted") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.PERMISSION_DENIED, error.error.code) }
    }
    @Test fun currentInstallationRejectsForgedUidCertificateAndReinstallTime() {
        val verifier = AndroidCallerIdentityVerifier(context)
        val actual = verifier.installed(context.packageName)
        listOf(actual.copy(uid = actual.uid + 1), actual.copy(firstInstalledAt = actual.firstInstalledAt + 1),
            actual.copy(currentSignerSha256 = setOf("0".repeat(64))), actual.copy(packageName = "missing.qa.caller"))
            .forEach { assertFalse(verifier.isCurrent(it)) }
    }
}
