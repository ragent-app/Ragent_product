import { createHash, randomBytes } from 'node:crypto';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';

const text = value => typeof value === 'string' ? value.trim() : '';
const id = value => /^[A-Za-z0-9_-]{8,160}$/.test(text(value));
const fingerprint = value => /^[a-f0-9]{64}$/.test(text(value));
const stamp = value => Number.isFinite(Date.parse(value || '')) ? Date.parse(value) : NaN;
const deny = () => Object.assign(new Error('Instance access authorization is unavailable.'), {
  code: 'instance_access_unavailable', statusCode: 403,
});

function grants(draft) {
  if (!Array.isArray(draft.instanceAccessGrants)) draft.instanceAccessGrants = [];
  return draft.instanceAccessGrants;
}

function activeAccount(draft, accountId) {
  const account = (draft.accounts || []).find(item => item.accountId === accountId);
  return account && !account.disabledAt && !account.deletedAt && !account.deletionRequestedAt && !account.deletionJobId;
}

// Binding history detects an unbind/rebind even if wall-clock timestamps and
// keys happen to repeat. The PostgreSQL authority revision separately fences
// assertions when grants change.
function bindingHistoryFingerprint(draft, instanceId) {
  const counts = { bind: 0, unbind: 0, bind_rollback: 0 };
  for (const event of draft.bindingHistory || []) {
    if (event.instanceId === instanceId && Object.hasOwn(counts, event.action)) counts[event.action]++;
  }
  return createHash('sha256').update(JSON.stringify([counts.bind, counts.unbind, counts.bind_rollback])).digest('hex');
}

function currentBinding(draft, instanceId, ownerAccountId) {
  const binding = (draft.instanceBindings || []).find(item => item.instanceId === instanceId);
  if (!binding || binding.revokedAt || binding.accountId !== ownerAccountId
    || !fingerprint(binding.instanceKeyFingerprint) || !Number.isFinite(stamp(binding.boundAt))
    || !activeAccount(draft, ownerAccountId)) throw deny();
  try {
    if (createInstancePublicKeyFingerprint(binding.instancePublicKey) !== binding.instanceKeyFingerprint) throw deny();
  } catch { throw deny(); }
  return binding;
}

/**
 * Internal transactional mutation. The caller must first verify the owner's
 * account session and the target instance's proof; IDs alone are not proof.
 * The grant records one exact owner binding and never rewrites that binding.
 */
export function issueInstanceAccessGrant(draft, { instanceId, ownerAccountId, accountId, requestId, now = Date.now() }) {
  instanceId = text(instanceId); ownerAccountId = text(ownerAccountId); accountId = text(accountId); requestId = text(requestId);
  if (![instanceId, ownerAccountId, accountId].every(id) || !/^[A-Za-z0-9_-]{16,128}$/.test(requestId) || ownerAccountId === accountId
    || !Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 || !activeAccount(draft, accountId)) throw deny();
  const binding = currentBinding(draft, instanceId, ownerAccountId);
  const replay = grants(draft).find(item => item.requestId === requestId);
  if (replay) {
    if (replay.instanceId !== instanceId || replay.ownerAccountId !== ownerAccountId || replay.accountId !== accountId
      || (!replay.revokedAt && !isInstanceAccessGrantActive(draft, replay, { instanceId, accountId }))) throw deny();
    return { grant: replay, created: false };
  }
  const prior = grants(draft).find(item => item.instanceId === instanceId && item.accountId === accountId && !item.revokedAt);
  if (prior) {
    if (isInstanceAccessGrantActive(draft, prior, { instanceId, accountId })) {
      throw Object.assign(new Error('Instance access is already granted.'), { code: 'instance_access_already_granted', statusCode: 409 });
    }
    // Stale authorizations cannot follow a new owner binding. A fresh explicit
    // grant replaces the stale record, never revives it.
    prior.revokedAt = new Date(now).toISOString();
  }
  const grant = { grantId: `iag_${randomBytes(24).toString('base64url')}`, requestId, instanceId,
    ownerAccountId, accountId, bindingKeyFingerprint: binding.instanceKeyFingerprint,
    bindingBoundAt: new Date(stamp(binding.boundAt)).toISOString(),
    bindingHistoryFingerprint: bindingHistoryFingerprint(draft, instanceId), scope: 'workspace',
    createdAt: new Date(now).toISOString(), revokedAt: '' };
  grants(draft).push(grant);
  return { grant, created: true };
}

/** Test the current binding and both account states on every use. */
export function isInstanceAccessGrantActive(draft, grant, { instanceId, accountId }) {
  grant = grants(draft).find(item => item.grantId === grant?.grantId);
  if (!grant || grant.revokedAt || grant.scope !== 'workspace' || grant.instanceId !== instanceId
    || grant.accountId !== accountId || grant.ownerAccountId === accountId
    || !id(grant.grantId) || !/^[A-Za-z0-9_-]{16,128}$/.test(grant.requestId || '') || !id(grant.ownerAccountId) || !id(accountId) || !id(instanceId)
    || !fingerprint(grant.bindingKeyFingerprint) || !fingerprint(grant.bindingHistoryFingerprint)
    || !Number.isFinite(stamp(grant.bindingBoundAt))
    || !activeAccount(draft, accountId)) return false;
  try {
    const binding = currentBinding(draft, instanceId, grant.ownerAccountId);
    return binding.instanceKeyFingerprint === grant.bindingKeyFingerprint
      && stamp(binding.boundAt) === stamp(grant.bindingBoundAt)
      && bindingHistoryFingerprint(draft, instanceId) === grant.bindingHistoryFingerprint;
  } catch { return false; }
}

/** Resolve an exact workspace relationship; never turn member access into ownership. */
export function resolveInstanceWorkspaceAccess(draft, { instanceId, accountId }) {
  if (!id(instanceId) || !id(accountId)) return null;
  const binding = (draft.instanceBindings || []).find(item => item.instanceId === instanceId && !item.revokedAt);
  if (!binding || !activeAccount(draft, accountId) || !activeAccount(draft, binding.accountId)) return null;
  if (binding.accountId === accountId) return { kind: 'owner', binding };
  const grant = (draft.instanceAccessGrants || []).find(item => item.instanceId === instanceId && item.accountId === accountId
    && isInstanceAccessGrantActive(draft, item, { instanceId, accountId }));
  return grant ? { kind: 'workspace', binding, grant } : null;
}

/** The authenticated owner may revoke; a repeated revoke is idempotent. */
export function revokeInstanceAccessGrant(draft, { grantId, ownerAccountId, now = Date.now() }) {
  grantId = text(grantId); ownerAccountId = text(ownerAccountId);
  if (!id(grantId) || !id(ownerAccountId) || !Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw deny();
  const grant = grants(draft).find(item => item.grantId === grantId && item.ownerAccountId === ownerAccountId);
  if (!grant) throw deny();
  const binding = currentBinding(draft, grant.instanceId, ownerAccountId);
  if (binding.instanceKeyFingerprint !== grant.bindingKeyFingerprint
    || stamp(binding.boundAt) !== stamp(grant.bindingBoundAt)
    || bindingHistoryFingerprint(draft, grant.instanceId) !== grant.bindingHistoryFingerprint) throw deny();
  if (!grant.revokedAt) grant.revokedAt = new Date(now).toISOString();
  return { grantId, revokedAt: grant.revokedAt };
}
