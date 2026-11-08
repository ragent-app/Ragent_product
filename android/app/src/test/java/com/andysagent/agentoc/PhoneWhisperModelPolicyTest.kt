package com.andysagent.agentoc

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PhoneWhisperModelPolicyTest {
    @Test
    fun prefersFastModelForLowRamDevices() {
        assertTrue(shouldUseTinyPhoneWhisperModel(isLowRamDevice = true, totalRamBytes = 16L shl 30, processorCount = 16))
    }

    @Test
    fun prefersFastModelWhenMemoryIsBelowEightGiB() {
        assertTrue(shouldUseTinyPhoneWhisperModel(isLowRamDevice = false, totalRamBytes = (8L shl 30) - 1, processorCount = 12))
    }

    @Test
    fun prefersFastModelOnEightCorePhones() {
        assertTrue(shouldUseTinyPhoneWhisperModel(isLowRamDevice = false, totalRamBytes = 12L shl 30, processorCount = 8))
    }

    @Test
    fun allowsAccuracyModelOnlyOnHighMemoryHighCoreDevices() {
        assertFalse(shouldUseTinyPhoneWhisperModel(isLowRamDevice = false, totalRamBytes = 8L shl 30, processorCount = 12))
    }
}
