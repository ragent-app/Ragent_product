// Accounts rendezvous for v2 temporary full control.  This is intentionally
// separate from temporary-pairing-broker.mjs: a v1 share record, receipt or
// credential must never become a ten-minute workbench-control grant.
import { timingSafeEqual } from 'node:crypto';
import { temporaryPairingError, temporaryHash } from '../lib/temporary-pairing-protocol.mjs';
import { normalizeTemporaryControlInvitation, temporaryControlInvitationDigest,
  verifyTemporaryControlClaim, verifyTemporaryControlInvitation } from '../lib/temporary-control-protocol.mjs';
import { verifyTemporaryControlAccessCredential } from '../lib/temporary-control-access.mjs';
import { temporaryControlRelayPrincipal, verifyTemporaryControlBrokerDeviceProof, verifyTemporaryControlBrokerInstanceProof } from '../lib/temporary-control-broker-protocol.mjs';
import { createTurnConnectionId, evaluateTurnConnectionAuthorization, publicTurnAuthorization } from '../lib/turn-authorization.mjs';
import { issueTurnBrokerCapability } from '../lib/turn-broker-capability.mjs';
import { getTurnConnectionLeases, resolveAccountEntitlement, activeTurnConnectionState } from './turn-lease-policy.mjs';
import { temporaryCanonicalJson } from '../lib/temporary-pairing-broker-protocol.mjs';

const fail = (suffix, status = 400) => { throw temporaryPairingError(`temporary_control_broker_${suffix}`, status); };
const terminal = (record) => record.status === 'REVOKED' || record.status === 'EXPIRED';
const bindingStamp = (value) => JSON.stringify([value.accountId, value.boundAt, value.instanceKeyFingerprint]);
const aad = (record) => JSON.stringify(['ragent-temporary-control-claim-v1', record.instanceId, record.invitationId, record.claim?.requestId || '']);
const connectionAad = (record) => JSON.stringify(['ragent-temporary-control-connection-v1', record.instanceId,
  record.invitationId, record.claim?.requestId || '', record.connection?.requestId || '']);
const requestIdPattern = /^rtr_[A-Za-z0-9_-]{24,64}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const projection = (record) => ({ invitationId: record.invitationId, instanceId: record.instanceId,
  status: record.status, claimExpiresAt: record.claimExpiresAt, accessExpiresAt: record.accessExpiresAt });

export function createTemporaryControlBroker({ store, cipher, clock = Date.now, issuer, signTurnBrokerCapability, resolveEntitlement = resolveAccountEntitlement }) {
  if (!store?.mutate || !cipher?.seal || !cipher?.open) throw new Error('Temporary control requires storage and claim encryption');
  async function transaction(action) {
    const outcome = await store.mutate(async (draft) => {
      if (draft.temporaryControlExchanges === undefined) draft.temporaryControlExchanges = [];
      if (!Array.isArray(draft.temporaryControlExchanges)) fail('store_invalid', 503);
      const observed = clock(); const previous = draft.temporaryControlClock ?? 0;
      if (!Number.isSafeInteger(observed) || observed < 0 || !Number.isSafeInteger(previous) || previous < 0) fail('clock_invalid', 503);
      const now = Math.max(observed, previous); draft.temporaryControlClock = now;
      for (const record of draft.temporaryControlExchanges) {
        // Older file-store releases could persist anonymous leases in the
        // account collection (Postgres rejected those at its FK). Preserve
        // their quota and revocation state while moving the exact lease.
        if (record.authorizationMode === 'anonymous' && record.turn && !record.turn.lease) {
          const index = draft.turnConnectionLeases?.findIndex((lease) => lease.connectionId === record.turn.connectionId
            && lease.accountId === record.accountId && lease.instanceId === record.instanceId && lease.deviceId === record.turn.deviceId) ?? -1;
          if (index >= 0) record.turn.lease = draft.turnConnectionLeases.splice(index, 1)[0];
        }
        const bound = draft.instanceBindings?.find((item) => item.instanceId === record.instanceId && !item.revokedAt);
        if (!terminal(record) && (record.authorizationMode === 'anonymous'
          ? !!bound : (!bound || bindingStamp(bound) !== record.bindingStamp))) {
          record.status = 'REVOKED'; record.sealedToken = null; record.completion = null;
        }
        if (!terminal(record) && now >= (record.status === 'ACTIVE' ? record.accessExpiresAt : record.claimExpiresAt)) {
          record.status = 'EXPIRED'; record.sealedToken = null; record.completion = null;
        }
        if (terminal(record)) { record.connection = null; if (record.turn) releaseLease(draft, record, now); }
        if (!Array.isArray(record.nonces)) fail('store_invalid', 503);
        record.nonces = record.nonces.filter((nonce) => nonce.expiresAt > now);
      }
      draft.temporaryControlExchanges = draft.temporaryControlExchanges
        .filter((record) => !terminal(record) || now < Math.max(record.claimExpiresAt, record.accessExpiresAt || 0) + 600_000);
      // Persist expiry and clock advancement even if the requested operation
      // is denied; a clock rollback must not resurrect a stale exchange.
      try { return { value: await action(draft, now) }; }
      catch (error) { return { error }; }
    });
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }
  function binding(draft, instanceId) {
    const value = draft.instanceBindings?.find((item) => item.instanceId === instanceId && !item.revokedAt);
    if (!value?.accountId || !value.instanceKeyFingerprint) fail('instance_unbound', 403);
    return value;
  }
  function record(draft, input) {
    const value = draft.temporaryControlExchanges.find((item) => item.invitationId === input?.invitationId && item.instanceId === input?.instanceId);
    if (!value) fail('not_found', 404);
    return value;
  }
  function consumeProof(value, proof) {
    if (value.nonces.some((nonce) => nonce.nonceHash === proof.nonceHash)) fail('proof_replayed', 409);
    if (value.nonces.length >= 512) fail('proof_capacity', 429);
    value.nonces.push(proof);
  }
  function instanceProof(action, input, draft, value, now) {
    if (value.authorizationMode !== 'anonymous') {
      const b = binding(draft, value.instanceId);
      if (bindingStamp(b) !== value.bindingStamp) fail('binding_mismatch', 403);
    }
    consumeProof(value, verifyTemporaryControlBrokerInstanceProof(action, input, value.envelope.publicKey, now));
  }
  function releaseLease(draft, value, now) {
    if (!value.turn) return;
    const lease = controlLeases(draft, value).find((entry) => entry.connectionId === value.turn?.connectionId
      && entry.accountId === value.accountId && entry.instanceId === value.instanceId && entry.deviceId === value.turn.deviceId);
    if (lease && lease.status !== 'released') Object.assign(lease, { status: 'released', updatedAt: new Date(now).toISOString(),
      releasedAt: new Date(now).toISOString(), releaseReason: 'temporary-control-inactive' });
  }
  function controlLeases(draft, value) {
    if (value.authorizationMode !== 'anonymous') return getTurnConnectionLeases(draft);
    // Account leases have an accounts(account_id) FK. Anonymous relay quota
    // belongs to the expiring exchange and must never create an account row.
    return draft.temporaryControlExchanges.filter((entry) => entry.authorizationMode === 'anonymous'
      && entry.accountId === value.accountId).map((entry) => entry.turn?.lease).filter(Boolean);
  }
  return {
    register(input) {
      return transaction((draft, now) => {
        const envelope = input?.payload?.envelope; const instanceId = input?.instanceId;
        const b = draft.instanceBindings?.find((item) => item.instanceId === instanceId && !item.revokedAt);
        const invitation = verifyTemporaryControlInvitation(envelope, { instanceId,
          keyFingerprint: b?.instanceKeyFingerprint || envelope?.invitation?.instanceKeyFingerprint });
        const proof = verifyTemporaryControlBrokerInstanceProof('register', input, envelope.publicKey, now);
        if (now < invitation.createdAt || now >= invitation.claimExpiresAt) fail('invitation_expired', 410);
        let value = draft.temporaryControlExchanges.find((item) => item.invitationId === invitation.invitationId);
        if (value) {
          if (value.instanceId !== invitation.instanceId || temporaryControlInvitationDigest(value.envelope.invitation) !== temporaryControlInvitationDigest(invitation)) fail('invitation_conflict', 409);
          if (value.authorizationMode === 'anonymous' ? !!b : (!b || bindingStamp(b) !== value.bindingStamp)) fail('binding_mismatch', 403);
          if (value.envelope.invitation.instanceKeyFingerprint !== invitation.instanceKeyFingerprint) fail('binding_mismatch', 403);
          consumeProof(value, proof);
          return projection(value);
        }
        if (draft.temporaryControlExchanges.length >= 10_000
          || draft.temporaryControlExchanges.filter((item) => item.instanceId === invitation.instanceId).length >= 256) fail('capacity', 429);
        value = { version: 1, invitationId: invitation.invitationId, instanceId: invitation.instanceId,
          accountId: b?.accountId || temporaryControlRelayPrincipal(instanceId, invitation.instanceKeyFingerprint),
          authorizationMode: b ? 'account' : 'anonymous', bindingStamp: b ? bindingStamp(b) : null,
          envelope: { invitation, publicKey: envelope.publicKey, signature: envelope.signature },
          claimExpiresAt: invitation.claimExpiresAt, accessExpiresAt: null, status: 'REGISTERED', claim: null,
          sealedToken: null, completion: null, nonces: [proof] };
        draft.temporaryControlExchanges.push(value);
        return projection(value);
      });
    },
    claim(input) {
      const device = verifyTemporaryControlClaim(input);
      return transaction((draft, now) => {
        const value = record(draft, input); const invitation = value.envelope.invitation;
        if (terminal(value)) fail('inactive', 410);
        if (now >= invitation.claimExpiresAt) { value.status = 'EXPIRED'; fail('invitation_expired', 410); }
        if (input.instanceId !== invitation.instanceId || input.invitationDigest !== temporaryControlInvitationDigest(invitation)
          || typeof input.token !== 'string' || !timingSafeEqual(Buffer.from(invitation.secretHash, 'hex'), Buffer.from(temporaryHash(input.token), 'hex'))) fail('ticket_invalid', 401);
        if (value.claim && (value.claim.requestId !== input.requestId || value.claim.deviceKeyFingerprint !== device.fingerprint)) fail('already_claimed', 409);
        if (!value.claim) {
          const claim = { instanceId: input.instanceId, invitationId: input.invitationId, invitationDigest: input.invitationDigest,
            requestId: input.requestId, devicePublicKey: device.publicKey, deviceKeyFingerprint: device.fingerprint,
            signature: input.signature };
          value.sealedToken = cipher.seal(input.token, JSON.stringify(['ragent-temporary-control-claim-v1', value.instanceId, value.invitationId, claim.requestId]));
          value.claim = claim; value.status = 'CLAIMED';
        }
        return projection(value);
      });
    },
    inbox(input) {
      return transaction((draft, now) => {
        const value = record(draft, input); instanceProof('inbox', input, draft, value, now);
        if (terminal(value)) fail('inactive', 410);
        let claim = null;
        if (value.status === 'CLAIMED' && value.claim) {
          try { claim = { ...value.claim, token: cipher.open(value.sealedToken, aad(value)) }; }
          catch { fail('claim_unavailable', 503); }
        }
        return { ...projection(value), claim, connectionRequestId: value.connection?.requestId || null,
          connectionPublished: !!value.connection?.sealed };
      });
    },
    complete(input) {
      return transaction((draft, now) => {
        const value = record(draft, input); instanceProof('complete', input, draft, value, now);
        if (terminal(value)) fail('inactive', 410);
        if (!value.claim || !['CLAIMED', 'ACTIVE'].includes(value.status)) fail('not_claimed', 409);
        const payload = input.payload; const grant = payload?.grant; const credential = payload?.accessCredential;
        if (!payload || Object.keys(payload).sort().join(',') !== 'accessCredential,grant'
          || !grant || Object.keys(grant).sort().join(',') !== 'deviceId,grantId,grantedAt'
          || !/^rtg_[A-Za-z0-9_-]{24,64}$/.test(grant.grantId) || !/^rdev_[A-Za-z0-9_-]{24,64}$/.test(grant.deviceId)
          || !Number.isSafeInteger(grant.grantedAt) || grant.grantedAt < value.envelope.invitation.createdAt || grant.grantedAt >= value.claimExpiresAt) fail('result_invalid');
        const accessExpiresAt = grant.grantedAt + value.envelope.invitation.accessDurationMs;
        const material = { claim: value.claim, grant, accessExpiresAt };
        verifyTemporaryControlAccessCredential(credential, { envelope: value.envelope, material,
          expectedInstance: { instanceId: value.instanceId, keyFingerprint: value.envelope.invitation.instanceKeyFingerprint }, now });
        if (value.completion && JSON.stringify(value.completion) !== JSON.stringify(payload)) fail('result_conflict', 409);
        value.completion = structuredClone(payload); value.accessExpiresAt = accessExpiresAt; value.status = 'ACTIVE'; value.sealedToken = null;
        return projection(value);
      });
    },
    result(input) {
      return transaction((draft, now) => {
        const value = record(draft, input);
        if (!value.claim || input.requestId !== value.claim.requestId) fail('not_found', 404);
        consumeProof(value, verifyTemporaryControlBrokerDeviceProof('result', input, value.claim.devicePublicKey, now));
        if (terminal(value)) fail('inactive', 410);
        return { ...projection(value), completion: value.status === 'ACTIVE' ? structuredClone(value.completion) : null };
      });
    },
    connect(input) {
      return transaction((draft, now) => {
        const value = record(draft, input);
        if (!value.claim || input.requestId !== value.claim.requestId) fail('not_found', 404);
        consumeProof(value, verifyTemporaryControlBrokerDeviceProof('connect', input, value.claim.devicePublicKey, now));
        if (terminal(value) || value.status !== 'ACTIVE' || !value.completion) fail('inactive', 410);
        if (!exact(input.payload, ['connectionRequestId']) || !requestIdPattern.test(input.payload.connectionRequestId)) fail('connection_invalid');
        if (value.connection && value.connection.requestId !== input.payload.connectionRequestId) fail('connection_conflict', 409);
        if (!value.connection) value.connection = { requestId: input.payload.connectionRequestId, sealed: null, digest: null };
        return { ...projection(value), connectionRequestId: value.connection.requestId,
          connectionStatus: value.connection.sealed ? 'READY' : 'PENDING' };
      });
    },
    'connection-publish'(input) {
      return transaction((draft, now) => {
        const value = record(draft, input); instanceProof('connection-publish', input, draft, value, now);
        if (terminal(value) || value.status !== 'ACTIVE' || !value.completion) fail('inactive', 410);
        const payload = input.payload; const connection = payload?.connection;
        if (!value.turn || !value.connection || !exact(payload, ['connectionRequestId', 'connection'])
          || payload.connectionRequestId !== value.connection.requestId || !connection || typeof connection !== 'object'
          || Array.isArray(connection) || connection.instanceId !== value.instanceId
          || connection.invitationId !== value.invitationId || connection.grantId !== value.completion.grant.grantId
          || connection.deviceId !== value.completion.grant.deviceId || connection.connectionId !== value.turn.connectionId
          || connection.connectionRequestId !== value.connection.requestId || !Number.isSafeInteger(connection.expiresAt)
          || connection.expiresAt <= now || connection.expiresAt > value.completion.accessCredential.expires_at
          || Buffer.byteLength(temporaryCanonicalJson(payload)) > 12 * 1024) fail('connection_invalid');
        const digest = temporaryHash(temporaryCanonicalJson(payload));
        if (value.connection.digest && value.connection.digest !== digest) fail('connection_conflict', 409);
        const signed = { instanceId: input.instanceId, invitationId: input.invitationId, requestId: input.requestId,
          issuedAt: input.issuedAt, nonce: input.nonce, payload, signature: input.signature };
        value.connection.sealed = cipher.seal(JSON.stringify(signed), connectionAad(value));
        value.connection.digest = digest;
        return { ...projection(value), connectionRequestId: value.connection.requestId, connectionStatus: 'READY' };
      });
    },
    'connection-result'(input) {
      return transaction((draft, now) => {
        const value = record(draft, input);
        if (!value.claim || input.requestId !== value.claim.requestId) fail('not_found', 404);
        consumeProof(value, verifyTemporaryControlBrokerDeviceProof('connection-result', input, value.claim.devicePublicKey, now));
        if (terminal(value) || value.status !== 'ACTIVE' || !value.completion) fail('inactive', 410);
        if (!exact(input.payload, ['connectionRequestId']) || !value.connection
          || input.payload.connectionRequestId !== value.connection.requestId) fail('not_found', 404);
        if (!value.connection.sealed) return { ...projection(value), connectionRequestId: value.connection.requestId,
          connectionStatus: 'PENDING', connection: null };
        let signed;
        try { signed = JSON.parse(cipher.open(value.connection.sealed, connectionAad(value))); }
        catch { fail('connection_unavailable', 503); }
        if (!exact(signed, ['instanceId', 'invitationId', 'requestId', 'issuedAt', 'nonce', 'payload', 'signature'])
          || signed.instanceId !== value.instanceId || signed.invitationId !== value.invitationId
          || signed.payload?.connectionRequestId !== value.connection.requestId) fail('connection_invalid', 503);
        verifyTemporaryControlBrokerInstanceProof('connection-publish', signed, value.envelope.publicKey, signed.issuedAt);
        if (temporaryHash(temporaryCanonicalJson(signed.payload)) !== value.connection.digest
          || signed.payload.connection.expiresAt <= now) fail('connection_inactive', 410);
        return { ...projection(value), connectionRequestId: value.connection.requestId, connectionStatus: 'READY', connection: signed };
      });
    },
    'turn-reserve'(input) {
      return transaction(async (draft, now) => {
        const value = record(draft, input); instanceProof('turn-reserve', input, draft, value, now);
        if (terminal(value) || value.status !== 'ACTIVE' || !value.completion) fail('inactive', 410);
        if (!input.payload || Object.keys(input.payload).length) fail('turn_request_invalid');
        const { grant, accessCredential: credential } = value.completion;
        verifyTemporaryControlAccessCredential(credential, { envelope: value.envelope,
          material: { claim: value.claim, grant, accessExpiresAt: value.accessExpiresAt },
          expectedInstance: { instanceId: value.instanceId, keyFingerprint: value.envelope.invitation.instanceKeyFingerprint }, now });
        const connectionId = createTurnConnectionId({ accountId: value.accountId, instanceId: value.instanceId, deviceId: grant.deviceId });
        const leases = controlLeases(draft, value);
        const existing = leases.find((entry) => entry.connectionId === connectionId);
        if (existing && (existing.accountId !== value.accountId || existing.instanceId !== value.instanceId
          || existing.deviceId !== grant.deviceId || existing.deviceKind !== 'phone')) fail('turn_identity_conflict', 409);
        const active = activeTurnConnectionState({ turnConnectionLeases: leases }, value.accountId, now, { excludeConnectionId: connectionId });
        const entitlement = value.authorizationMode === 'anonymous'
          ? { plan: 'free', limits: { phones: 1, computers: 1 } }
          : resolveEntitlement(draft, value.accountId, now);
        const quotaDeviceId = `temporary_${value.claim.deviceKeyFingerprint}`;
        const decision = evaluateTurnConnectionAuthorization({ accountId: value.accountId, instanceId: value.instanceId,
          deviceId: quotaDeviceId, deviceKind: 'phone', accountPlan: entitlement.plan, limits: entitlement.limits,
          activeDeviceIds: active.activePhoneDeviceIds, activeInstanceIds: active.activeInstanceIds,
          activePhones: active.activePhoneDeviceIds.length, activeComputers: active.activeInstanceIds.length, nowMs: now });
        if (!decision.authorized) fail('turn_quota_exceeded', 429);
        const brokerCredential = await issueTurnBrokerCapability({ signCapability: signTurnBrokerCapability, issuer,
          accountId: value.accountId, instanceId: value.instanceId, deviceId: grant.deviceId, connectionId, nowMs: now,
          temporaryGrant: { grantId: grant.grantId, invitationId: value.invitationId, accessExpiresAt: credential.expires_at } });
        if (Math.max(now, clock()) >= credential.expires_at) { value.status = 'EXPIRED'; value.completion = null;
          releaseLease(draft, value, Math.max(now, clock())); fail('inactive', 410); }
        const timestamp = new Date(now).toISOString();
        const lease = existing || { connectionId, accountId: value.accountId, instanceId: value.instanceId,
          deviceId: grant.deviceId, deviceKind: 'phone', createdAt: timestamp };
        Object.assign(lease, { quotaDeviceId, plan: entitlement.plan, status: 'reserved', updatedAt: timestamp,
          expiresAt: new Date(credential.expires_at).toISOString(), releasedAt: '', releaseReason: '' });
        if (!existing) leases.push(lease);
        value.turn = { connectionId, deviceId: grant.deviceId, grantId: grant.grantId,
          ...(value.authorizationMode === 'anonymous' ? { lease } : {}) };
        return { ...projection(value), authorization: publicTurnAuthorization({ ...decision, connectionId }),
          lease: structuredClone(lease), brokerCredential };
      });
    },
    revoke(input) {
      return transaction((draft, now) => {
        const value = record(draft, input); instanceProof('revoke', input, draft, value, now);
        if (!terminal(value)) { value.status = 'REVOKED'; value.sealedToken = null; value.completion = null; value.connection = null; releaseLease(draft, value, now); }
        return projection(value);
      });
    },
  };
}
