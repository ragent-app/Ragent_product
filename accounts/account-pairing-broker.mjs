import { verify } from 'node:crypto';
import { accountPairingHash, buildAccountPairingProof } from '../lib/account-pairing-protocol.mjs';
import { buildAccountSessionMessage, normalizeDevicePublicKey, verifyDeviceAuthSignature } from '../lib/device-auth-protocol.mjs';

const fail = (suffix, statusCode = 400) => { const e = new Error('Account pairing request rejected');
  e.code = `account_pairing_${suffix}`; e.statusCode = statusCode; throw e; };
const stamp = (b) => JSON.stringify([b.accountId, b.instanceKeyFingerprint, b.boundAt]);
const aad = (r) => JSON.stringify(['ragent-account-pairing-session-v1', r.instanceId, r.invitationId, r.claim?.transactionId]);
const projection = (r) => ({ instanceId: r.instanceId, invitationId: r.invitationId, status: r.status, expiresAt: r.expiresAt });

// Ordinary pairing only. The transaction callback issues the phone's own
// session and stores its encrypted delivery in the same database commit.
export function createAccountPairingBroker({ store, cipher, issueSession, clock = Date.now }) {
  if (!store?.mutate || !cipher?.seal || !cipher?.open || typeof issueSession !== 'function') throw new TypeError('Account pairing dependencies required');
  async function transaction(fn) {
    const result = await store.mutate(async (draft) => {
      draft.accountPairingExchanges ??= [];
      for (const r of draft.accountPairingExchanges) {
        r.observedAt = Math.max(r.observedAt, clock());
        const b = draft.instanceBindings?.find((x) => x.instanceId === r.instanceId && !x.revokedAt);
        if (!b || stamp(b) !== r.bindingStamp) r.status = 'REVOKED';
        if (r.observedAt >= r.expiresAt) r.status = 'EXPIRED';
        if (['REVOKED', 'EXPIRED'].includes(r.status)) r.sealedSession = null;
        r.nonces = r.nonces.filter((n) => n.expiresAt > r.observedAt);
      }
      draft.accountPairingExchanges = draft.accountPairingExchanges.filter((r) => r.observedAt < r.expiresAt + 600_000);
      const working = structuredClone(draft);
      try { const value = await fn(working, clock()); Object.assign(draft, working); return { value }; }
      catch (error) { return { error }; }
    });
    if (result.error) throw result.error;
    return result.value;
  }
  function binding(draft, instanceId) {
    const b = draft.instanceBindings?.find((x) => x.instanceId === instanceId && !x.revokedAt);
    if (!b?.accountId || !b.instancePublicKey || !b.instanceKeyFingerprint) fail('source_unbound', 403);
    return b;
  }
  function proof(action, input, publicKey, algorithm, r, now) {
    if (Math.abs(now - input.issuedAt) > 30_000) fail('proof_expired', 401);
    let valid = false;
    try { valid = verify(algorithm === 'ed25519' ? null : 'sha256', Buffer.from(buildAccountPairingProof(action, input)),
      publicKey, Buffer.from(input.signature || '', 'base64url')); } catch {}
    if (!valid) fail('proof_invalid', 401);
    const hash = accountPairingHash(input.nonce);
    if (r.nonces.some((x) => x.hash === hash)) fail('proof_replayed', 409);
    if (r.nonces.length >= 256) fail('capacity', 429);
    r.nonces.push({ hash, expiresAt: input.issuedAt + 30_000 });
  }
  function record(draft, input) {
    const r = draft.accountPairingExchanges.find((x) => x.instanceId === input.instanceId && x.invitationId === input.invitationId);
    if (!r) fail('not_found', 404);
    if (['REVOKED', 'EXPIRED'].includes(r.status)) fail('inactive', 410);
    return r;
  }
  function desktop(action, input, draft, r, now) {
    const b = binding(draft, r.instanceId);
    if (stamp(b) !== r.bindingStamp) fail('binding_changed', 403);
    proof(action, input, b.instancePublicKey, 'ed25519', r, Math.max(now, r.observedAt));
  }
  return {
    register: (input) => transaction((draft, now) => {
      const b = binding(draft, input.instanceId);
      const { tokenHash, expiresAt } = input.payload || {};
      if (!/^[a-f0-9]{64}$/.test(tokenHash || '') || !Number.isSafeInteger(expiresAt)
        || expiresAt <= now || expiresAt > now + 120_000) fail('invitation_invalid');
      let r = draft.accountPairingExchanges.find((x) => x.invitationId === input.invitationId);
      if (r && ['REVOKED', 'EXPIRED'].includes(r.status)) fail('inactive', 410);
      if (r && (r.instanceId !== input.instanceId || r.tokenHash !== tokenHash || r.expiresAt !== expiresAt
        || r.bindingStamp !== stamp(b))) fail('invitation_conflict', 409);
      if (!r) {
        if (draft.accountPairingExchanges.length >= 10_000
          || draft.accountPairingExchanges.filter((x) => x.instanceId === input.instanceId).length >= 32) fail('capacity', 429);
        r = { instanceId: input.instanceId, invitationId: input.invitationId, accountId: b.accountId,
          bindingStamp: stamp(b), tokenHash, expiresAt, observedAt: now, status: 'PENDING', nonces: [], claim: null, sealedSession: null };
        desktop('register', input, draft, r, now);
        draft.accountPairingExchanges.push(r);
      } else desktop('register', input, draft, r, now);
      return projection(r);
    }),
    claim: (input) => transaction((draft, now) => {
      const r = record(draft, input); const p = input.payload;
      if (typeof p?.token !== 'string' || accountPairingHash(p.token) !== r.tokenHash) fail('ticket_invalid', 401);
      const c = draft.accountSessionChallenges?.find((x) => x.transactionId === p.transactionId && x.requestId === p.requestId);
      if (!c || c.consumedAt || Date.parse(c.expiresAt) <= now) fail('challenge_inactive', 410);
      const key = normalizeDevicePublicKey(c.publicKey);
      if (!key || !verifyDeviceAuthSignature({ publicKey: key.publicKey, algorithm: key.algorithm,
        message: buildAccountSessionMessage({ transactionId: c.transactionId, requestId: c.requestId,
          deviceId: c.deviceId, publicKeyFingerprint: c.publicKeyFingerprint, nonce: c.nonce }), signature: p.deviceSignature })) fail('device_proof_invalid', 401);
      proof('claim', input, key.publicKey, key.algorithm, r, Math.max(now, r.observedAt));
      if (r.claim && (r.claim.transactionId !== c.transactionId || r.claim.requestId !== c.requestId)) fail('already_claimed', 409);
      if (!r.claim) { r.claim = { transactionId: c.transactionId, requestId: c.requestId, deviceId: c.deviceId,
        publicKey: key.publicKey, publicKeyFingerprint: c.publicKeyFingerprint, nonce: c.nonce, deviceSignature: p.deviceSignature };
        r.status = 'CLAIMED'; }
      return projection(r);
    }),
    inbox: (input) => transaction((draft, now) => {
      const r = record(draft, input); desktop('inbox', input, draft, r, now);
      return { ...projection(r), claim: r.claim };
    }),
    approve: (input) => transaction(async (draft, now) => {
      const r = record(draft, input); desktop('approve', input, draft, r, now);
      if (!r.claim) fail('not_claimed', 409);
      if (!r.sealedSession) {
        const session = await issueSession({ transactionId: r.claim.transactionId, requestId: r.claim.requestId,
          signature: r.claim.deviceSignature, desktopProof: input.payload?.desktopProof }, draft);
        r.sealedSession = cipher.seal(JSON.stringify(session), aad(r)); r.status = 'APPROVED';
      }
      return projection(r);
    }),
    result: (input) => transaction((draft, now) => {
      const r = record(draft, input);
      if (!r.claim) fail('not_claimed', 409);
      const key = normalizeDevicePublicKey(r.claim.publicKey);
      proof('result', input, key.publicKey, key.algorithm, r, Math.max(now, r.observedAt));
      return { ...projection(r), session: r.sealedSession ? JSON.parse(cipher.open(r.sealedSession, aad(r))) : null };
    }),
    revoke: (input) => transaction((draft, now) => {
      const r = record(draft, input); desktop('revoke', input, draft, r, now);
      r.status = 'REVOKED'; r.sealedSession = null; return projection(r);
    }),
  };
}
