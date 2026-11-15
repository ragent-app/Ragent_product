package com.andysagent.ragent

import android.app.Application
import com.andysagent.ragent.core.auth.AndroidTemporaryControlClaimJournal
import com.andysagent.ragent.core.auth.DeviceIdentityStore
import com.andysagent.ragent.core.auth.TemporaryCarrierConnector
import com.andysagent.ragent.core.auth.TemporaryControlPairingClient
import com.andysagent.ragent.core.auth.TemporaryControlTransport
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.p2p.P2PSessionFactory
import com.andysagent.ragent.core.p2p.WebRTCDataChannelTransport
import com.andysagent.ragent.core.protocol.TemporaryControlProtocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** Short-lived control never creates an account device or persists an Owner credential. */
internal class TemporaryControlRuntime(application: Application, broker: RagentTransport,
    private val identity: DeviceIdentityStore, private val scope: CoroutineScope,
    private val nowMs: () -> Long = System::currentTimeMillis) {
    private val journal = AndroidTemporaryControlClaimJournal(application)
    private val pairing = TemporaryControlPairingClient(broker, identity, journal, nowMs)
    @Volatile private var activeTransport: TemporaryControlTransport? = null
    private val carrier = TemporaryCarrierConnector(P2PSessionFactory { WebRTCDataChannelTransport(it, application) }, scope, nowMs,
        onRecoveryRequired = { _, _ -> activeTransport?.carrierLost() })

    data class Connected(val instanceId: String, val transport: TemporaryControlTransport)

    suspend fun connect(raw: String): Connected {
        val ticket = requireNotNull(TemporaryControlProtocol.parseIfControl(raw, nowMs()))
        val instanceId = ticket.envelope.invitation.instanceId
        val previous = journal.read(instanceId)
        if (previous != null && previous.ticket != ticket) { carrier.stop(instanceId); journal.clear(instanceId) }
        pairing.claim(raw)
        var grant: TemporaryControlProtocol.VerifiedGrant? = null
        while (grant == null && nowMs() < ticket.envelope.invitation.claimExpiresAt) {
            grant = try { pairing.poll(instanceId) } catch (error: ApiException) {
                if (!error.retryable || error.statusCode == 429) throw error
                null
            }
            if (grant == null) delay(1_000)
        }
        val confirmed = requireNotNull(grant ?: runCatching { pairing.poll(instanceId) }.getOrNull()) { "Temporary control confirmation expired" }
        while (nowMs() < confirmed.expiresAt) {
            try {
                pairing.startConnection(instanceId)
                val connection = pairing.pollConnection(instanceId)
                if (connection != null) {
                    carrier.connect(connection)
                    val transport = TemporaryControlTransport(carrier, connection, confirmed, identity, scope, nowMs,
                        recover = {
                            check(pairing.poll(instanceId) == confirmed) { "Temporary control grant changed" }
                            try { carrier.connect(connection) }
                            catch (cancelled: CancellationException) { throw cancelled }
                            catch (_: Exception) {
                                throw ApiException(0, "temporary_control_disconnected", "Temporary computer is disconnected", retryable = true)
                            }
                        })
                    activeTransport = transport
                    if (carrier.session(connection) == null) transport.carrierLost()
                    return Connected(instanceId, transport)
                }
            } catch (error: ApiException) {
                if (!error.retryable || error.statusCode == 429) throw error
            }
            delay(1_000)
        }
        carrier.stop(instanceId)
        error("Temporary control expired before the computer connected")
    }
}
