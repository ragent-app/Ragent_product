package com.andysagent.ragent.feature.workbench

import org.junit.Assert.*
import org.junit.Test

class WorkbenchDestinationStateTest {
    private val values = mapOf(
        DestinationVisitIdentity to listOf("visit-1"),
        "${DestinationStatePrefix}projects-index-scroll" to listOf(6, 120),
        "implicit-hash-1" to listOf(true),
    )

    @Test fun restoringTheSameVisitKeepsItsCompleteState() {
        assertEquals(values - DestinationVisitIdentity, destinationVisitSeed(values, "visit-1"))
    }

    @Test fun aNewVisitOnlySeedsPortablePageState() {
        assertEquals(mapOf("${DestinationStatePrefix}projects-index-scroll" to listOf(6, 120)),
            destinationVisitSeed(values, "visit-2"))
    }

    @Test fun previousVisitsImplicitKeysDoNotAccumulate() {
        val next = destinationVisitSeed(values, "visit-2")!! + mapOf(
            DestinationVisitIdentity to listOf("visit-2"), "implicit-hash-2" to listOf(false),
        )
        assertEquals(destinationVisitSeed(values, "visit-2"), destinationVisitSeed(next, "visit-3"))
    }

    @Test fun noSnapshotUsesNormalInitialState() {
        assertNull(destinationVisitSeed(null, "visit-1"))
    }
}
