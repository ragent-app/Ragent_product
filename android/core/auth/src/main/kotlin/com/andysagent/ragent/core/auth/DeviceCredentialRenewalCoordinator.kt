package com.andysagent.ragent.core.auth

/** Shared production sequence; every publication uses the same fixed-target fence. */
class DeviceCredentialRenewalCoordinator(
    private val renewal: DeviceCredentialRenewal,
    private val pairing: PairingAuthenticator,
) {
    suspend fun renew(instanceId: String, endpoint: String, deviceName: String, guard: PairingWriteGuard) {
        try {
            renewal.renew(instanceId, endpoint, guard)
        } catch (upgrade: DeviceAuthorityUpgradeRequired) {
            pairing.joinWithAccountSession(endpoint, deviceName, selectTarget = false,
                writeGuard = guard, renewExistingDeviceId = upgrade.deviceId)
            // The upgrade publishes no intermediate credential or role change.
            // A new signature rechecks the actual still-active PC enrollment.
            renewal.renew(instanceId, endpoint, guard)
        }
    }
}
