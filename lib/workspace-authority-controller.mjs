import { performance } from 'node:perf_hooks';
import { BINDING_AUTHORITY_TTL_MS } from './binding-authority.mjs';

function denied(code = 'workspace_authority_required', statusCode = 401) {
  return Object.assign(new Error('Current workspace authorization is required'), { code, statusCode });
}
function valid(input) {
  return input && [input.ownerAccountId, input.accountId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(value))
    && input.ownerAccountId !== input.accountId && /^iag_[A-Za-z0-9_-]{16,128}$/.test(input.grantId || '')
    && typeof input.revision === 'string' && /^[1-9][0-9]{0,18}$/.test(input.revision)
    && BigInt(input.revision) <= 9223372036854775807n;
}
const keyOf = input => JSON.stringify([input.ownerAccountId, input.accountId, input.grantId, input.revision]);

/** Short-lived verified member proofs; no client input can create a proof. */
export function createWorkspaceAuthorityController({ query, clock = Date.now, monotonicNow = () => performance.now(),
  onInvalidate = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, refreshAfterMs = 10_000 } = {}) {
  if (typeof query !== 'function' || !Number.isFinite(refreshAfterMs) || refreshAfterMs <= 0) throw new TypeError('A workspace status reader is required');
  const proofs = new Map(), pending = new Map(), epochs = new Map();
  let stopped = false;
  const notify = (input, reason) => { try { Promise.resolve(onInvalidate({ ...input, reason })).catch(() => {}); } catch {} };
  function invalidate(input, reason = 'workspace-invalidated') {
    if (!valid(input)) return;
    const key = keyOf(input), previous = proofs.get(key);
    epochs.set(key, (epochs.get(key) || 0) + 1);
    if (previous) { clearTimer(previous.expiryTimer); clearTimer(previous.refreshTimer); proofs.delete(key); }
    notify(input, reason);
  }
  function allows(input) {
    if (stopped || !valid(input)) return false;
    const proof = proofs.get(keyOf(input));
    if (!proof) return false;
    if (clock() >= proof.expiresAt || monotonicNow() >= proof.deadline) {
      invalidate(input, 'workspace-expired'); return false;
    }
    return true;
  }
  function schedule(input, proof, delay = refreshAfterMs) {
    proof.refreshTimer = setTimer(() => {
      if (stopped || proofs.get(keyOf(input)) !== proof) return;
      void refresh(input).catch(() => {
        if (allows(input) && proofs.get(keyOf(input)) === proof) schedule(input, proof, Math.min(refreshAfterMs, 2_000));
      });
    }, delay);
    proof.refreshTimer?.unref?.();
  }
  async function refresh(input) {
    if (stopped || !valid(input)) throw denied();
    const key = keyOf(input);
    if (pending.has(key)) return pending.get(key);
    const epoch = epochs.get(key) || 0, startedMono = monotonicNow();
    const operation = (async () => {
      const receipt = await query({ ownerAccountId: input.ownerAccountId, accountId: input.accountId, grantId: input.grantId });
      if (stopped || epoch !== (epochs.get(key) || 0)) throw denied('workspace_authority_superseded');
      const now = clock(), mono = monotonicNow();
      if (receipt?.ownerAccountId !== input.ownerAccountId || receipt?.accountId !== input.accountId || receipt?.grantId !== input.grantId
        || receipt.authorityProtocol !== 1 || !['active', 'inactive'].includes(receipt.state)
        || typeof receipt.revision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(receipt.revision)
        || BigInt(receipt.revision) > 9223372036854775807n
        || !Number.isSafeInteger(receipt.checkedAt) || receipt.checkedAt > now || !Number.isSafeInteger(receipt.expiresAt)
        || receipt.expiresAt <= now || receipt.expiresAt > receipt.checkedAt + BINDING_AUTHORITY_TTL_MS
        || mono >= startedMono + BINDING_AUTHORITY_TTL_MS) throw denied('workspace_authority_assertion_invalid', 502);
      if (receipt.state !== 'active' || receipt.revision !== input.revision) {
        invalidate(input, receipt.state === 'inactive' ? 'workspace-inactive' : 'workspace-generation-changed');
        throw denied('workspace_authority_superseded');
      }
      const old = proofs.get(key);
      if (old) { clearTimer(old.expiryTimer); clearTimer(old.refreshTimer); }
      const proof = { expiresAt: receipt.expiresAt,
        deadline: Math.min(startedMono + BINDING_AUTHORITY_TTL_MS, mono + receipt.expiresAt - now) };
      proof.expiryTimer = setTimer(() => { if (proofs.get(key) === proof) invalidate(input, 'workspace-expired'); },
        Math.max(0, proof.deadline - mono));
      proof.expiryTimer?.unref?.(); proofs.set(key, proof); schedule(input, proof);
      return { ...input, expiresAt: proof.expiresAt };
    })();
    pending.set(key, operation);
    try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  async function authorize(input) {
    if (!allows(input)) await refresh(input);
    if (!allows(input)) throw denied();
    return { ...input, expiresAt: proofs.get(keyOf(input)).expiresAt };
  }
  function stop() {
    if (stopped) return; stopped = true;
    for (const [key, proof] of proofs) { clearTimer(proof.expiryTimer); clearTimer(proof.refreshTimer); proofs.delete(key); }
  }
  return Object.freeze({ authorize, allows, refresh, invalidate, stop });
}
