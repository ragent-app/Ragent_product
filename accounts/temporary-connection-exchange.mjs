// Broker-private encrypted connection delivery; the PC remains the signing and runtime authority.
import { temporaryHash, temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';
import { temporaryCanonicalJson } from '../lib/temporary-pairing-broker-protocol.mjs';
import { verifyTemporaryAccessCredential } from '../lib/temporary-device-access.mjs';
import { temporaryConnectionRequestId, verifyTemporaryConnectionRequest,
  verifyTemporaryConnectionDelivery } from '../lib/temporary-connection-delivery.mjs';

const fail = (suffix, status = 409) => { throw temporaryPairingError(`temporary_broker_connection_${suffix}`, status); };
const aad = (r) => JSON.stringify(['ragent-temporary-connection-v1', r.instanceId, r.invitationId,
  r.claim.requestId, r.connection.request.payload.connectionRequestId]);
const facts = (r, now) => ({ envelope: r.envelope,
  grant: { ...r.completion.payload.result, devicePublicKey: r.claim.devicePublicKey },
  credential: r.completion.payload.accessCredential,
  expectedInstance: { instanceId: r.instanceId, keyFingerprint: r.envelope.invitation.instanceKeyFingerprint }, now });

export function requireTemporaryConnectionCompletion(r, now) {
  if (r.status !== 'COMPLETED' || !r.completion?.payload?.accessCredential) fail('not_completed');
  const f = facts(r, now);
  verifyTemporaryAccessCredential(f.credential, f);
  return f;
}

export function createTemporaryConnectionExchange(cipher) {
  return {
    validate(r, now) {
      if (!r.connection) return;
      try {
        const c = r.connection; const f = facts(r, now);
        if (c.version !== 1 || Object.keys(c).some((k) => !['version', 'request', 'delivery'].includes(k))) fail('store_invalid', 503);
        verifyTemporaryConnectionRequest(c.request, f);
        if (c.delivery && (!/^[a-f0-9]{64}$/.test(c.delivery.payloadDigest || '')
          || !Number.isSafeInteger(c.delivery.expiresAt) || c.delivery.expiresAt > f.credential.expires_at
          || c.delivery.expiresAt <= c.request.issuedAt || !c.delivery.sealed
          || Object.keys(c.delivery).sort().join(',') !== 'expiresAt,payloadDigest,sealed')) fail('store_invalid', 503);
      } catch { fail('store_invalid', 503); }
    },
    request(r, input, now) {
      const f = requireTemporaryConnectionCompletion(r, now);
      const connectionRequestId = verifyTemporaryConnectionRequest(input, f);
      if (r.connection && r.connection.request.payload.connectionRequestId !== connectionRequestId) fail('request_conflict');
      if (!r.connection) r.connection = { version: 1, request: structuredClone(input), delivery: null };
      return { connectionRequestId, connectionStatus: r.connection.delivery ? 'READY' : 'PENDING' };
    },
    inbox(r) {
      if (!r.connection) return null;
      let available = false;
      if (r.connection.delivery) {
        try { cipher.open(r.connection.delivery.sealed, aad(r)); available = true; } catch {}
      }
      return { request: structuredClone(r.connection.request), published: available,
        payloadDigest: r.connection.delivery?.payloadDigest || null, expiresAt: r.connection.delivery?.expiresAt || null };
    },
    publish(r, input, now) {
      const f = requireTemporaryConnectionCompletion(r, now);
      if (!r.connection) fail('not_requested');
      const connectionRequestId = r.connection.request.payload.connectionRequestId;
      const result = verifyTemporaryConnectionDelivery(input, { ...f, connectionRequestId });
      if (!r.turn || result.bootstrap.turn.connectionId !== r.turn.connectionId) fail('lease_invalid', 403);
      const payloadDigest = temporaryHash(temporaryCanonicalJson(input.payload));
      if (r.connection.delivery && r.connection.delivery.payloadDigest !== payloadDigest) fail('result_conflict');
      // Compute encryption before mutating state; exact re-publication also repairs a rotated broker key.
      const sealed = cipher.seal(JSON.stringify(input), aad(r));
      r.connection.delivery = { sealed, payloadDigest, expiresAt: Date.parse(result.bootstrap.expiresAt) };
      return { connectionRequestId, connectionStatus: 'READY' };
    },
    result(r, input, now) {
      const f = requireTemporaryConnectionCompletion(r, now);
      const connectionRequestId = temporaryConnectionRequestId(input.payload);
      if (!r.connection || r.connection.request.payload.connectionRequestId !== connectionRequestId) fail('not_found', 404);
      const delivery = r.connection.delivery;
      if (!delivery) return { connectionRequestId, connectionStatus: 'PENDING', connection: null };
      if (delivery.expiresAt <= now) fail('expired', 410);
      let value;
      try { value = JSON.parse(cipher.open(delivery.sealed, aad(r))); }
      catch { fail('unavailable', 503); }
      verifyTemporaryConnectionDelivery(value, { ...f, connectionRequestId });
      if (temporaryHash(temporaryCanonicalJson(value.payload)) !== delivery.payloadDigest) fail('store_invalid', 503);
      return { connectionRequestId, connectionStatus: 'READY', connection: value };
    },
  };
}
