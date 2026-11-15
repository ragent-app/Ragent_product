package com.andysagent.ragent

import android.Manifest
import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BackgroundDeliveryPlatformBoundaryTest {
    @Test fun installedPermissionsAndComponentMatchTheActualSdkPath() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val permissions = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions.orEmpty().toSet()
        assertFalse("Unused Android14 FGS data-sync permission is still declared",
            "android.permission.FOREGROUND_SERVICE_DATA_SYNC" in permissions)
        assertTrue("Legacy delivery needs the base FGS permission", Manifest.permission.FOREGROUND_SERVICE in permissions)
        assertFalse("Computer connection should not require a connected-device FGS permission",
            "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" in permissions)
        val info = context.packageManager.getServiceInfo(
            ComponentName(context, BackgroundDeliveryForegroundService::class.java), PackageManager.MATCH_DISABLED_COMPONENTS)
        assertFalse(info.exported)
        assertEquals("Legacy component resource must select the right platform path", Build.VERSION.SDK_INT <= 33, info.enabled)
        assertTrue("UIDT permission missing", "android.permission.RUN_USER_INITIATED_JOBS" in permissions)
    }

    @Test fun modernPlatformCannotStartTheDisabledLegacyService() {
        assumeTrue(Build.VERSION.SDK_INT >= 34)
        val context = ApplicationProvider.getApplicationContext<Context>()
        ActivityScenario.launch<AppApiSettingsActivity>(Intent(context, AppApiSettingsActivity::class.java)).use { scenario ->
            scenario.onActivity { activity ->
                assertNull("A modern device started the legacy service",
                    activity.startService(Intent(activity, BackgroundDeliveryForegroundService::class.java)))
            }
        }
        assertFalse(context.getSystemService(ActivityManager::class.java).getRunningServices(64).any {
            it.service?.className == BackgroundDeliveryForegroundService::class.java.name
        })
    }
}
