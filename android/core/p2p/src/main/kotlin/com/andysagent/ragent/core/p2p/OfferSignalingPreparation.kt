package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/** Prepare independently, but never publish an offer before the room is joined. */
internal suspend fun prepareOfferAndSignaling(
    openSignaling: suspend () -> Unit,
    createOffer: suspend () -> String,
): String = coroutineScope {
    val signaling = async { openSignaling() }
    val offer = async { createOffer() }
    signaling.await()
    offer.await()
}
