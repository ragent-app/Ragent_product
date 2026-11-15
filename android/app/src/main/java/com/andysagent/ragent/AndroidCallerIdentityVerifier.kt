package com.andysagent.ragent

import android.content.Context
import android.content.pm.PackageManager
import android.os.Binder
import android.os.Build
import com.andysagent.ragent.core.appapi.*
import java.security.MessageDigest

/** Capture on the Binder thread before launching a coroutine or clearing identity. */
internal class AndroidCallerIdentityVerifier(private val context: Context) {
    fun captureBinderCaller(packageHint: String? = null): InstalledCallerIdentity {
        val uid = Binder.getCallingUid()
        val packages = context.packageManager.getPackagesForUid(uid)?.toSet().orEmpty()
        if (packages.size != 1 || (packageHint != null && packageHint !in packages)) denied()
        return installed(packages.single()).also { if (it.uid != uid) denied() }
    }
    /** For owner display/consent; this alone does not authorize a foreign Binder call. */
    @Suppress("DEPRECATION")
    fun installed(packageName: String): InstalledCallerIdentity {
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val info = try { context.packageManager.getPackageInfo(packageName, flags) }
            catch (_: PackageManager.NameNotFoundException) { denied() }
        // Binder cannot distinguish packages in a shared UID. Do not silently attest just one.
        if (info.sharedUserId != null) denied()
        val signers = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        val hashes = signers?.map { signature -> MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
            .joinToString("") { "%02x".format(it.toInt() and 255) } }?.toSet().orEmpty()
        return InstalledCallerIdentity(info.packageName, info.applicationInfo?.uid ?: denied(), info.firstInstallTime, hashes)
            .also { try { it.validate() } catch (_: IllegalArgumentException) { denied() } }
    }
    fun isCurrent(identity: InstalledCallerIdentity): Boolean = try { installed(identity.packageName) == identity }
        catch (_: AppApiException) { false }
    private fun denied(): Nothing = throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Caller installation cannot be verified"))
}
