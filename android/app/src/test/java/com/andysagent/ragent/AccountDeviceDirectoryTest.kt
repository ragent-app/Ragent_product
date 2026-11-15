package com.andysagent.ragent

import com.andysagent.ragent.core.datastore.LinkedComputer
import com.andysagent.ragent.core.domain.AccountDirectoryDevice
import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.model.RemoteTarget
import com.andysagent.ragent.core.model.RemoteTargetAccessState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountDeviceDirectoryTest {
    @Test fun `offline account computer skips setup without local pairing or rendezvous keys`() {
        val offline = AccountDirectoryDevice(deviceId = "pc", instanceId = "pc", alias = "Offline PC",
            deviceKind = "computer", endpoint = null)
        assertEquals(com.andysagent.ragent.feature.workbench.AccountComputerLookup.Available,
            accountComputerLookupFor(listOf(offline)))
    }

    @Test fun `phones and revoked computers do not skip setup`() {
        val phone = AccountDirectoryDevice(deviceId = "phone", instanceId = "phone", alias = "Phone",
            deviceKind = "phone", endpoint = null)
        val revoked = phone.copy(deviceId = "pc", instanceId = "pc", deviceKind = "computer", unboundAt = "2026-11-01")
        for (devices in listOf(emptyList(), listOf(phone), listOf(revoked), listOf(phone, revoked))) {
            assertEquals(com.andysagent.ragent.feature.workbench.AccountComputerLookup.Empty,
                accountComputerLookupFor(devices))
        }
    }

    @Test
    fun `signed out device surface falls back to the session computer directory`() {
        val targets = deviceSurfaceTargets(
            hasVerifiedAccountSession = false,
            accountTargets = emptyList(),
            localTargets = emptyList(),
            sessionComputers = listOf(
                Computer(
                    id = "workstation",
                    name = "Workstation",
                    platform = "Linux",
                    endpoint = "https://workstation.example.test",
                    connected = true,
                ),
            ),
        )

        assertEquals(listOf("workstation"), targets.map { it.instanceId })
        assertEquals("Workstation", targets.single().label)
        assertEquals(RemoteTargetAccessState.Connected, targets.single().accessState)
    }

    @Test
    fun `signed in device surface does not fall back to session computer records`() {
        val accountTarget = RemoteTarget(
            instanceId = "office",
            label = "Office PC",
            endpoint = "https://office.example.test",
        )

        val targets = deviceSurfaceTargets(
            hasVerifiedAccountSession = true,
            accountTargets = listOf(accountTarget),
            localTargets = emptyList(),
            sessionComputers = listOf(Computer("stale", "Stale computer", connected = true)),
        )

        assertEquals(listOf("office"), targets.map { it.instanceId })
    }

    @Test
    fun `signed in views only use computer records returned by Accounts`() {
        val devices = listOf(
            AccountDirectoryDevice(
                deviceId = "rdev_office",
                instanceId = "office",
                alias = "Office PC",
                deviceKind = "computer",
                endpoint = "https://office.example.test",
                lastSeenAt = "2026-08-25T08:00:00Z",
                instancePublicKey = "office-public-key",
                instanceKeyFingerprint = "office-fingerprint",
            ),
            AccountDirectoryDevice(
                deviceId = "adev_phone",
                instanceId = "phone",
                alias = "Pixel",
                deviceKind = "phone",
                endpoint = null,
            ),
            AccountDirectoryDevice(
                deviceId = "rdev_old",
                instanceId = "old-computer",
                alias = "Old laptop",
                deviceKind = "computer",
                endpoint = "https://old.example.test",
                unboundAt = "2026-08-24T08:00:00Z",
            ),
        )
        val staleLocalTarget = LinkedComputer(
            instanceId = "not-in-account",
            endpoint = "https://stale.example.test",
            label = "Fake cached computer",
        )

        val targets = devices.toRemoteTargets(listOf(staleLocalTarget))

        assertEquals(listOf("office", "old-computer"), targets.map { it.instanceId })
        assertFalse(targets.any { it.label == "Fake cached computer" })
        assertEquals(RemoteTargetAccessState.NeedsPairing, targets.first().accessState)
        assertEquals(RemoteTargetAccessState.Revoked, targets.last().accessState)
        assertEquals(listOf("office"), devices.toDiscoverableComputers().map { it.instanceId })
        assertTrue(devices.toDiscoverableComputers().first().canTakeOver)
        assertEquals("office-public-key", devices.toDiscoverableComputers().first().instancePublicKey)
        assertEquals("office-fingerprint", devices.toDiscoverableComputers().first().instanceKeyFingerprint)
    }

    @Test
    fun `computer without endpoint remains discoverable for TURN rendezvous`() {
        val computers = listOf(
            AccountDirectoryDevice(
                deviceId = "rdev_local",
                instanceId = "local-ragent",
                alias = "This Ragent",
                deviceKind = "computer",
                endpoint = null,
                instancePublicKey = "local-public-key",
                instanceKeyFingerprint = "local-fingerprint",
            ),
            AccountDirectoryDevice(
                deviceId = "rdev_legacy",
                instanceId = "legacy-ragent",
                alias = "Legacy Ragent",
                deviceKind = "computer",
                endpoint = "https://legacy.example.test",
            ),
        )

        val discovered = computers.toDiscoverableComputers()

        assertEquals(listOf("local-ragent"), discovered.map { it.instanceId })
        assertTrue(discovered.single().connectionEndpoint == null)
        assertEquals("local-public-key", discovered.single().instancePublicKey)
        assertEquals("local-fingerprint", discovered.single().instanceKeyFingerprint)
    }

    @Test
    fun `endpointless account computer keeps the linked connection status`() {
        val device = AccountDirectoryDevice(
            deviceId = "rdev_local",
            instanceId = "local-ragent",
            alias = "This Ragent",
            deviceKind = "computer",
            endpoint = null,
            instancePublicKey = "local-public-key",
            instanceKeyFingerprint = "local-fingerprint",
        )
        val linked = LinkedComputer(
            instanceId = "local-ragent",
            endpoint = "",
            label = "This Ragent",
            accessState = RemoteTargetAccessState.Connected.name,
        )
        val target = listOf(device).toRemoteTargets(listOf(linked)).single()
        assertEquals(RemoteTargetAccessState.Connected, target.accessState)
        assertTrue(target.linkedToPhone)
    }

    @Test
    fun `computer with endpoint still enters rendezvous when phone needs pairing`() {
        val target = LinkedComputer(
            instanceId = "oracle",
            endpoint = "https://oracle.example.test",
            label = "Oracle",
            accessState = RemoteTargetAccessState.NeedsPairing.name,
        )

        assertFalse(shouldUseExistingComputerTarget(target))
    }

    @Test
    fun `linked target with endpoint can reuse its existing connection`() {
        val target = LinkedComputer(
            instanceId = "oracle",
            endpoint = "https://oracle.example.test",
            label = "Oracle",
            accessState = RemoteTargetAccessState.Connected.name,
        )

        assertTrue(shouldUseExistingComputerTarget(target))
    }

    @Test
    fun `account directory always renews rendezvous for a cached connected target`() {
        val target = LinkedComputer(
            instanceId = "msi",
            endpoint = "https://app.agentoncloud.com",
            label = "MSI",
            accessState = RemoteTargetAccessState.Connected.name,
        )

        assertFalse(shouldUseExistingComputerTarget(target, accountDirectoryMode = true))
    }
}
