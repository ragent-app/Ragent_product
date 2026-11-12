import { createHash, createHmac, randomBytes, createPublicKey, verify } from 'crypto';

import { TRUSTED_DEVICES_FILE, P2P_SIGNALING_URL } from '../lib/config.mjs';
import { createConnectivityPolicy, normalizeConnectivityPolicy } from '../lib/connectivity-policy.mjs';
import { createConnectivityCandidates, normalizeConnectivityCandidate } from '../lib/connectivity-candidate.mjs';
import { createP2PRoomId } from '../lib/p2p-signal-protocol.mjs';
import {
  buildDeviceAuthMessageV3,
  createDevicePublicKeyFingerprint,
  normalizeDevicePublicKey,
  verifyDeviceAuthSignature,
} from '../lib/device-auth-protocol.mjs';
import {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signAccountJoinIntentProof,
} from '../lib/instance-identity.mjs';
import { createSerialTaskQueue, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { authorizeDeviceBinding, assertDeviceBindingNow, notifyDeviceBindingRevoked, notifyDeviceBindingAuthorized } from '../lib/binding-authority-runtime.mjs';

const DEFAULT_INVITATION_TTL_MS = 2 * 60 * 1000;
const MIN_INVITATION_TTL_MS = 30 * 1000;
const MAX_INVITATION_TTL_MS = 10 * 60 * 1000;
// Preserve the reviewed short-lived device capability contract. A reconnect
// repair must not silently turn a 15-minute bearer into a 30-day credential.
const DEFAULT_DEVICE_TOKEN_TTL_MS = 15 * 60 * 1000;
const RENDEZVOUS_CREDENTIAL_OVERLAP_MS = 60 * 1000;
const runTrustedDeviceMutation = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWorkspaceAccess(value) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'grantId,ownerAccountId'
    || typeof value.ownerAccountId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(value.ownerAccountId)
    || typeof value.grantId !== 'string' || !/^iag_[A-Za-z0-9_-]{16,128}$/.test(value.grantId)) return { invalid: true };
  return { ownerAccountId: value.ownerAccountId, grantId: value.grantId };
}
const sameWorkspaceAccess = (a, b) => JSON.stringify(normalizeWorkspaceAccess(a) || null) === JSON.stringify(normalizeWorkspaceAccess(b) || null);

function normalizeDeviceAlias(value) {
  return trimString(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 64);
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix, bytes = 12) {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

function hashSecret(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

/**
 * Derive a deterministic per-device P2P room secret from the instance secret
 * and deviceId. Neither the invitation token nor a plaintext secret is stored
 * in the device record — the server can re-derive the same secret at any time.
 * The client receives this secret once during redeem and caches it.
 */
export function deriveDeviceP2PSecret(instanceSecret, deviceId) {
  return createHmac('sha256', String(instanceSecret || ''))
    .update(`agentoc-p2p-device-secret-v1:${String(deviceId || '')}`)
    .digest('hex');
}

function normalizeEndpoint(value) {
  const trimmed = trimString(value).replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function normalizeState(value) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    instanceId: trimString(state.instanceId) || createId('rli', 10),
    instanceSecret: trimString(state.instanceSecret) || createId('ris', 20),
    createdAt: trimString(state.createdAt) || nowIso(),
    invitations: Array.isArray(state.invitations)
      ? state.invitations.map((entry) => ({
          id: trimString(entry?.id),
          tokenHash: trimString(entry?.tokenHash),
          shortCodeHash: trimString(entry?.shortCodeHash),
          accountHandoffAccountId: trimString(entry?.accountHandoffAccountId),
          endpoint: normalizeEndpoint(entry?.endpoint),
          connectivity: normalizeConnectivityPolicy(entry?.connectivity, entry?.endpoint),
          candidates: Array.isArray(entry?.candidates)
            ? entry.candidates.map(normalizeConnectivityCandidate).filter(Boolean)
            : [],
          createdAt: trimString(entry?.createdAt),
          expiresAt: trimString(entry?.expiresAt),
          usedAt: trimString(entry?.usedAt),
          deviceId: trimString(entry?.deviceId),
          claimIntentId: trimString(entry?.claimIntentId),
        })).filter((entry) => entry.id && entry.tokenHash && entry.expiresAt)
      : [],
    devices: Array.isArray(state.devices)
      ? state.devices.map((entry) => ({
          id: trimString(entry?.id),
          tokenHash: trimString(entry?.tokenHash),
          // Records written before the explicit lifecycle fields are already
          // trusted devices; only newly redeemed v2/v3 records set provisional.
          status: trimString(entry?.status) || 'legacy_trusted',
          // 连接 bootstrap 只记录授权来源，不决定 transport。老记录没有该
          // 字段时按 qr-scan 处理（fail-closed，不能把历史设备误判成账号加入）。
          enrollmentKind: ['account-claim', 'account-join'].includes(trimString(entry?.enrollmentKind))
            ? trimString(entry.enrollmentKind)
            : 'qr-scan',
          accountId: trimString(entry?.accountId),
          ...(entry?.workspaceAccess != null ? { workspaceAccess: normalizeWorkspaceAccess(entry.workspaceAccess) } : {}),
          bindingAuthorityRevision: trimString(entry?.bindingAuthorityRevision),
          enrollmentId: trimString(entry?.enrollmentId),
          deviceName: trimString(entry?.deviceName),
          computerAlias: normalizeDeviceAlias(entry?.computerAlias),
          platform: trimString(entry?.platform),
          publicEndpoint: normalizeEndpoint(entry?.publicEndpoint),
          devicePublicKey: trimString(entry?.devicePublicKey),
          entryUrl: normalizeEndpoint(entry?.entryUrl),
          authVersion: Number.isFinite(Number(entry?.authVersion)) ? Number(entry.authVersion) : undefined,
          keyAlgorithm: trimString(entry?.keyAlgorithm),
          keyRotatedAt: trimString(entry?.keyRotatedAt),
          keyRotationCount: Number.isFinite(Number(entry?.keyRotationCount))
            ? Math.max(0, Math.floor(Number(entry.keyRotationCount)))
            : 0,
          createdAt: trimString(entry?.createdAt),
          boundAt: trimString(entry?.boundAt),
          lastSeenAt: trimString(entry?.lastSeenAt),
          temporaryExpiresAt: trimString(entry?.temporaryExpiresAt),
          revokedAt: trimString(entry?.revokedAt),
          expiresAt: trimString(entry?.expiresAt),
        })).filter((entry) => entry.id && (entry.tokenHash || entry.devicePublicKey))
      : [],
    challenges: Array.isArray(state.challenges)
      ? state.challenges.map((entry) => ({
          challengeId: trimString(entry?.challengeId),
          deviceId: trimString(entry?.deviceId),
          nonceHash: trimString(entry?.nonceHash),
          message: trimString(entry?.message),
          createdAt: trimString(entry?.createdAt),
          usedAt: trimString(entry?.usedAt),
          issuedAt: trimString(entry?.issuedAt),
          expiresAt: trimString(entry?.expiresAt),
          audience: trimString(entry?.audience),
          instanceId: trimString(entry?.instanceId),
        })).filter((entry) => entry.challengeId && entry.deviceId)
      : [],
    authTokens: Array.isArray(state.authTokens)
      ? state.authTokens.map((entry) => ({
          tokenHash: trimString(entry?.tokenHash),
          deviceId: trimString(entry?.deviceId),
          kind: trimString(entry?.kind) || 'bound',
          scope: trimString(entry?.scope) || 'device-access',
          bindingAuthorityRevision: trimString(entry?.bindingAuthorityRevision),
          createdAt: trimString(entry?.createdAt),
          expiresAt: trimString(entry?.expiresAt),
          retiredAt: trimString(entry?.retiredAt),
        })).filter((entry) => entry.tokenHash && entry.deviceId)
      : [],
    accountJoinIntents: Array.isArray(state.accountJoinIntents)
      ? state.accountJoinIntents.map((entry) => ({
          intentId: trimString(entry?.intentId),
          instanceId: trimString(entry?.instanceId),
          deviceId: trimString(entry?.deviceId),
          devicePublicKey: trimString(entry?.devicePublicKey),
          devicePublicKeyFingerprint: trimString(entry?.devicePublicKeyFingerprint),
          renewExistingDeviceId: trimString(entry?.renewExistingDeviceId),
          renewExistingEnrollmentId: trimString(entry?.renewExistingEnrollmentId),
          deviceName: trimString(entry?.deviceName),
          computerAlias: normalizeDeviceAlias(entry?.computerAlias),
          platform: trimString(entry?.platform),
          publicEndpoint: normalizeEndpoint(entry?.publicEndpoint),
          nonceHash: trimString(entry?.nonceHash),
          issuedAt: trimString(entry?.issuedAt),
          createdAt: trimString(entry?.createdAt),
          expiresAt: trimString(entry?.expiresAt),
          status: trimString(entry?.status) || 'pending',
          accountId: trimString(entry?.accountId),
          ...(entry?.workspaceAccess != null ? { workspaceAccess: normalizeWorkspaceAccess(entry.workspaceAccess) } : {}),
          bindingAuthorityRevision: trimString(entry?.bindingAuthorityRevision),
          completionRequestId: trimString(entry?.completionRequestId),
          completedAt: trimString(entry?.completedAt),
          completionCredentialVersion: entry?.completionCredentialVersion === 1 ? 1 : 0,
          completionCredentialIssuedAt: trimString(entry?.completionCredentialIssuedAt),
          completionCredentialExpiresAt: trimString(entry?.completionCredentialExpiresAt),
          centralRegisteredAt: trimString(entry?.centralRegisteredAt),
          accountClaimInvitationId: trimString(entry?.accountClaimInvitationId),
          accountClaimTokenHash: trimString(entry?.accountClaimTokenHash),
        })).filter((entry) => entry.intentId && entry.deviceId && entry.devicePublicKey && entry.expiresAt)
      : [],
  };
}

export async function loadState() {
  return normalizeState(await readJson(TRUSTED_DEVICES_FILE, null));
}

async function mutateState(mutator) {
  return runTrustedDeviceMutation(async () => {
    const draft = await loadState();
    const result = await mutator(draft);
    await writeJsonAtomic(TRUSTED_DEVICES_FILE, normalizeState(draft));
    return result;
  });
}

function publicDevice(device) {
  return {
    id: device.id,
    status: device.status,
    enrollmentKind: device.enrollmentKind || 'qr-scan',
    accountId: device.accountId || undefined,
    ...(device.workspaceAccess ? { workspaceAccess: device.workspaceAccess } : {}),
    ...(device.bindingAuthorityRevision ? { bindingAuthorityRevision: device.bindingAuthorityRevision } : {}),
    boundAt: device.boundAt || undefined,
    temporaryExpiresAt: device.temporaryExpiresAt || undefined,
    deviceName: device.deviceName,
    platform: device.platform,
    devicePublicKey: device.devicePublicKey || undefined,
    entryUrl: device.entryUrl || undefined,
    authVersion: device.authVersion,
    keyAlgorithm: device.keyAlgorithm,
    keyRotatedAt: device.keyRotatedAt || undefined,
    keyRotationCount: device.keyRotationCount || undefined,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
  };
}

function isBoundDevice(device) {
  return device?.status === 'bound' || device?.status === 'legacy_trusted';
}

// A device installation can be re-enrolled after an earlier local record was
// revoked (for example after a phone reinstall). Keep the audit record, but
// never let its position in the JSON array shadow the live replacement.
function deviceRecordTimestamp(device) {
  for (const value of [device?.lastSeenAt, device?.boundAt, device?.createdAt]) {
    const timestamp = Date.parse(trimString(value));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function selectTrustedDeviceRecord(devices, deviceId, { activeOnly = false } = {}) {
  const matches = (Array.isArray(devices) ? devices : [])
    .filter((entry) => entry?.id === deviceId);
  const active = matches.filter((entry) => !entry.revokedAt);
  const eligible = active.length > 0 ? active : (activeOnly ? [] : matches);
  return eligible.reduce((selected, entry) => (
    !selected || deviceRecordTimestamp(entry) >= deviceRecordTimestamp(selected) ? entry : selected
  ), null);
}

function publicAccountJoinIntent(intent) {
  return {
    intentId: intent.intentId,
    instanceId: intent.instanceId,
    deviceId: intent.deviceId,
    devicePublicKey: intent.devicePublicKey,
    devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint,
    deviceName: intent.deviceName,
    computerAlias: normalizeDeviceAlias(intent.computerAlias),
    platform: intent.platform,
    publicEndpoint: intent.publicEndpoint || undefined,
    nonce: intent.nonce,
    issuedAt: intent.issuedAt,
    expiresAt: intent.expiresAt,
    status: intent.status,
    centralRegisteredAt: intent.centralRegisteredAt,
  };
}

export async function createTrustedDeviceAccountIntent({
  devicePublicKey,
  deviceName = 'Android device',
  computerAlias = '',
  platform = 'android',
  publicEndpoint = '',
  accountClaimToken = '',
  renewExistingDeviceId = '',
} = {}) {
  const normalized = normalizeDevicePublicKey(devicePublicKey);
  if (!normalized) {
    const error = new Error('A valid device public key is required');
    error.statusCode = 400;
    throw error;
  }
  const identity = await loadOrCreateInstanceIdentity();
  const intentId = createId('rji');
  const renewalDeviceId = trimString(renewExistingDeviceId);
  const deviceId = renewalDeviceId || createId('rdev');
  const nonce = randomBytes(24).toString('base64url');
  const issuedAt = nowIso();
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const devicePublicKeyFingerprint = createDevicePublicKeyFingerprint(normalized.publicKey);
  const normalizedPublicEndpoint = normalizeEndpoint(publicEndpoint);
  const normalizedClaimToken = trimString(accountClaimToken);
  const normalizedComputerAlias = normalizeDeviceAlias(computerAlias);
  const signature = signAccountJoinIntentProof(identity, {
    intentId,
    deviceId,
    devicePublicKeyFingerprint,
    nonce,
    issuedAt,
    audience: 'agentoc-account-join',
    publicEndpoint: normalizedPublicEndpoint,
  }).signature;
  await mutateState((draft) => {
    let renewalEnrollmentId = '';
    if (renewalDeviceId) {
      const existing = selectTrustedDeviceRecord(draft.devices, renewalDeviceId, { activeOnly: true });
      if (!existing || !isBoundDevice(existing)
        || createDevicePublicKeyFingerprint(existing.devicePublicKey) !== devicePublicKeyFingerprint) {
        throw Object.assign(new Error('Existing device enrollment is unavailable'), { statusCode: 403, code: 'device_enrollment_revoked' });
      }
      existing.enrollmentId ||= createId('enrollment');
      renewalEnrollmentId = existing.enrollmentId;
    }
    draft.accountJoinIntents = draft.accountJoinIntents.filter((entry) => {
      const expiry = Date.parse(entry.expiresAt || '');
      return entry.status === 'completed' || (Number.isFinite(expiry) && expiry > Date.now());
    });
    let accountClaimInvitationId = '';
    if (normalizedClaimToken) {
      const invitation = draft.invitations.find((entry) => entry.tokenHash === hashSecret(normalizedClaimToken));
      const expiry = Date.parse(invitation?.expiresAt || '');
      if (!invitation || invitation.usedAt || invitation.claimIntentId
        || !Number.isFinite(expiry) || expiry <= Date.now()) {
        const error = new Error('Account-claim code is expired, already used, or invalid');
        error.code = 'account_claim_invalid';
        error.statusCode = 410;
        throw error;
      }
      // Reserve the one-time code before the intent is sent to Accounts. The
      // code is consumed only after Accounts returns the bound assertion.
      invitation.claimIntentId = intentId;
      accountClaimInvitationId = invitation.id;
    }
    draft.accountJoinIntents.push({
      intentId,
      instanceId: identity.instanceId,
      deviceId,
      devicePublicKey: normalized.publicKey,
      devicePublicKeyFingerprint,
      renewExistingDeviceId: renewalDeviceId,
      renewExistingEnrollmentId: renewalEnrollmentId,
      deviceName: trimString(deviceName).slice(0, 64) || 'Android device',
      computerAlias: normalizedComputerAlias,
      platform: trimString(platform).slice(0, 32) || 'android',
      publicEndpoint: normalizedPublicEndpoint,
      nonceHash: hashSecret(nonce),
      issuedAt,
      createdAt: issuedAt,
      expiresAt,
      status: 'pending',
      accountId: '',
      completionRequestId: '',
      completedAt: '',
      accountClaimInvitationId,
    });
  });
  return {
    intentId,
    instance: publicInstanceIdentity(identity),
    deviceId,
    devicePublicKey: normalized.publicKey,
    devicePublicKeyFingerprint,
    deviceName: trimString(deviceName).slice(0, 64) || 'Android device',
    computerAlias: normalizedComputerAlias,
    platform: trimString(platform).slice(0, 32) || 'android',
    publicEndpoint: normalizedPublicEndpoint,
    nonce,
    issuedAt,
    expiresAt,
    signature,
  };
}

export async function markTrustedDeviceAccountIntentRegistered(intentId) {
  const normalizedIntentId = trimString(intentId);
  return mutateState((draft) => {
    const intent = draft.accountJoinIntents.find((entry) => entry.intentId === normalizedIntentId);
    if (!intent) {
      const error = new Error('Account join intent not found');
      error.statusCode = 404;
      throw error;
    }
    intent.centralRegisteredAt = nowIso();
    return publicAccountJoinIntent(intent);
  });
}

/** Release a QR claim reservation if Accounts rejected intent registration. */
export async function releaseTrustedDeviceAccountClaim(intentId) {
  const normalizedIntentId = trimString(intentId);
  if (!normalizedIntentId) return;
  return mutateState((draft) => {
    const intent = draft.accountJoinIntents.find((entry) => entry.intentId === normalizedIntentId);
    if (!intent || intent.status === 'completed') return;
    const invitationId = trimString(intent.accountClaimInvitationId);
    const invitation = draft.invitations.find((entry) => entry.id === invitationId);
    if (invitation?.claimIntentId === normalizedIntentId && !invitation.usedAt) {
      invitation.claimIntentId = '';
    }
    draft.accountJoinIntents = draft.accountJoinIntents.filter((entry) => entry.intentId !== normalizedIntentId);
  });
}

export async function getTrustedDeviceAccountIntent(intentId) {
  const normalizedIntentId = trimString(intentId);
  const state = await loadState();
  const intent = state.accountJoinIntents.find((entry) => entry.intentId === normalizedIntentId);
  return intent ? publicAccountJoinIntent(intent) : null;
}

export async function hasTrustedDeviceAccountClaimTicket(tokenHash) {
  const normalizedHash = trimString(tokenHash);
  if (!normalizedHash) return false;
  const state = await loadState();
  return state.invitations.some((entry) => entry.tokenHash === normalizedHash
    && !entry.usedAt && !entry.claimIntentId
    && Date.parse(entry.expiresAt || '') > Date.now());
}

export async function hasPendingTrustedDeviceAccountClaimTicket() {
  const state = await loadState();
  return state.invitations.some((entry) => !entry.usedAt && !entry.claimIntentId
    && Date.parse(entry.expiresAt || '') > Date.now());
}

/** Explicit account unbinding cancels every outstanding local ordinary QR. */
export async function invalidatePendingTrustedDeviceInvitations() {
  return mutateState((draft) => {
    const now = Date.now();
    let invalidated = 0;
    for (const invitation of draft.invitations) {
      if (!invitation.usedAt && Date.parse(invitation.expiresAt || '') > now) {
        invitation.expiresAt = new Date(now).toISOString();
        invitation.accountHandoffAccountId = '';
        invalidated++;
      }
    }
    return invalidated;
  });
}

export async function getLocalAccountPairingInvitation(invitationId) {
  const state = await loadState();
  const invitation = state.invitations.find((entry) => entry.id === invitationId);
  return invitation ? { id: invitation.id, tokenHash: invitation.tokenHash,
    expiresAt: invitation.expiresAt, usedAt: invitation.usedAt, accountHandoffAccountId: invitation.accountHandoffAccountId } : null;
}

export async function listPendingAccountPairingInvitations() {
  const state = await loadState();
  return state.invitations.filter((entry) => entry.accountHandoffAccountId && !entry.usedAt
    && Date.parse(entry.expiresAt) > Date.now()).map(({ id, expiresAt, accountHandoffAccountId }) => ({ id, expiresAt, accountHandoffAccountId }));
}

export async function consumeLocalAccountPairingInvitation(invitationId) {
  return mutateState((draft) => {
    const invitation = draft.invitations.find((entry) => entry.id === invitationId);
    if (!invitation) throw new Error('Account pairing invitation not found');
    invitation.usedAt ||= new Date().toISOString();
  });
}

function deriveAccountCompletionCredential(state, intent) {
  // Only the protected instance secret can reproduce the original bearer.
  // No plaintext bearer is retained in the intent or token table.
  return `rda_${createHmac('sha256', state.instanceSecret)
    .update('agentoc-account-completion-credential-v1:')
    .update(JSON.stringify([
      state.instanceId, intent.intentId, intent.accountId,
      intent.completionRequestId, intent.deviceId, intent.devicePublicKeyFingerprint,
      intent.completionCredentialIssuedAt, intent.completionCredentialExpiresAt,
    ])).digest('hex')}`;
}

function replayAccountCompletionCredential(state, intent, device) {
  const issuedAtMs = Date.parse(intent.completionCredentialIssuedAt || '');
  const expiresAtMs = Date.parse(intent.completionCredentialExpiresAt || '');
  const token = intent.completionCredentialVersion === 1
    ? deriveAccountCompletionCredential(state, intent) : '';
  // The active hash is also the generation fence. A newer join retires it;
  // account convergence or explicit revoke removes it. Replays never recreate
  // it; separately issued credentials may coexist under the existing policy.
  const retained = state.authTokens.find(entry => entry.deviceId === intent.deviceId
    && entry.tokenHash === hashSecret(token) && entry.kind === 'bound'
    && entry.scope === 'device-access' && !entry.retiredAt
    && entry.createdAt === intent.completionCredentialIssuedAt
    && entry.expiresAt === intent.completionCredentialExpiresAt);
  if (!token || !device || device.revokedAt || !isBoundDevice(device)
    || device.accountId !== intent.accountId || !retained
    || !sameWorkspaceAccess(device.workspaceAccess, intent.workspaceAccess)
    || (intent.bindingAuthorityRevision && (device.bindingAuthorityRevision !== intent.bindingAuthorityRevision
      || retained.bindingAuthorityRevision !== intent.bindingAuthorityRevision))
    || !Number.isFinite(issuedAtMs) || issuedAtMs > Date.now()
    || expiresAtMs - issuedAtMs !== DEFAULT_DEVICE_TOKEN_TTL_MS
    || expiresAtMs <= Date.now()) {
    // Older random credentials cannot be recovered safely. Preserve any
    // still-live credential and require a fresh Accounts-authorized intent.
    const error = new Error('Account completion is no longer replayable; a fresh authorized join is required');
    error.code = 'owner_auth_native_replay';
    error.statusCode = 409;
    throw error;
  }
  return { token, expiresAt: intent.completionCredentialExpiresAt, scope: 'device-access' };
}

export async function completeTrustedDeviceAccountIntent({
  intentId,
  deviceSignature,
  accountId,
  requestId,
  intent: remoteIntent = null,
  // The only production callers set this after completeOwnerAccountJoinIntent
  // verifies the Accounts assertion for this exact instance, intent, device,
  // key fingerprint, and idempotency request. Never accept this from HTTP.
  verifiedAccountCompletion = false,
  bindingAuthorityRevision = '',
  workspaceAccess,
} = {}) {
  const normalizedIntentId = trimString(intentId);
  const normalizedAccountId = trimString(accountId);
  const normalizedRequestId = trimString(requestId);
  if (!normalizedIntentId || !normalizedAccountId || !normalizedRequestId) {
    const error = new Error('intentId, accountId, and requestId are required');
    error.statusCode = 400;
    throw error;
  }
  const workspace = normalizeWorkspaceAccess(workspaceAccess);
  if ((workspace && (workspace.invalid || verifiedAccountCompletion !== true || !bindingAuthorityRevision))
    || (bindingAuthorityRevision && verifiedAccountCompletion !== true)) {
    throw Object.assign(new Error('Verified Accounts authority is required'), { code: 'owner_auth_authority_required', statusCode: 403 });
  }
  const authorityDevice = { id: trimString(remoteIntent?.deviceId), accountId: normalizedAccountId, bindingAuthorityRevision,
    ...(workspace ? { workspaceAccess: workspace } : {}) };
  await authorizeDeviceBinding(authorityDevice);
  const result = await mutateState((draft) => {
    assertDeviceBindingNow(authorityDevice);
    let intent = draft.accountJoinIntents.find((entry) => entry.intentId === normalizedIntentId);
    if (!intent && remoteIntent && trimString(remoteIntent.intentId) === normalizedIntentId) {
      intent = {
        intentId: normalizedIntentId,
        deviceId: trimString(remoteIntent.deviceId),
        devicePublicKey: trimString(remoteIntent.devicePublicKey),
        devicePublicKeyFingerprint: trimString(remoteIntent.devicePublicKeyFingerprint),
        deviceName: trimString(remoteIntent.deviceName) || 'Android device',
        computerAlias: normalizeDeviceAlias(remoteIntent.computerAlias),
        platform: trimString(remoteIntent.platform) || 'android',
        createdAt: nowIso(),
        expiresAt: trimString(remoteIntent.expiresAt),
        status: 'pending',
        accountId: '',
        completionRequestId: '',
        accountClaimTokenHash: trimString(remoteIntent.accountClaimTokenHash),
      };
      draft.accountJoinIntents.push(intent);
    }
    if (!intent || Date.parse(intent.expiresAt || '') <= Date.now()) {
      const error = new Error('Account join intent is expired or unknown');
      error.code = 'owner_auth_account_intent_expired';
      error.statusCode = 410;
      throw error;
    }
    if (!intent.accountClaimInvitationId && trimString(intent.accountClaimTokenHash)) {
      const invitation = draft.invitations.find((entry) => entry.tokenHash === intent.accountClaimTokenHash
        && !entry.usedAt && !entry.claimIntentId
        && Date.parse(entry.expiresAt || '') > Date.now());
      if (!invitation) {
        const error = new Error('Account-claim ticket does not belong to this instance or is expired');
        error.code = 'account_claim_invalid';
        error.statusCode = 410;
        throw error;
      }
      invitation.claimIntentId = normalizedIntentId;
      intent.accountClaimInvitationId = invitation.id;
    }
    if (intent.accountId && intent.accountId !== normalizedAccountId) {
      const error = new Error('Account join intent account mismatch');
      error.code = 'owner_auth_binding_mismatch';
      error.statusCode = 403;
      throw error;
    }
    if (!['pending', 'completed'].includes(intent.status)) {
      const error = new Error('Account join intent is not in a completable state');
      error.code = 'owner_auth_native_replay';
      error.statusCode = 409;
      throw error;
    }
    const alreadyCompleted = intent.status === 'completed';
    if (alreadyCompleted && !sameWorkspaceAccess(intent.workspaceAccess, workspace)) {
      throw Object.assign(new Error('Original workspace authority no longer matches'), { code: 'owner_auth_native_replay', statusCode: 409 });
    }
    if (alreadyCompleted && intent.bindingAuthorityRevision !== bindingAuthorityRevision) {
      throw Object.assign(new Error('Original binding authority no longer matches'), { code: 'owner_auth_native_replay', statusCode: 409 });
    }
    if (alreadyCompleted && intent.completionRequestId !== normalizedRequestId) {
      const error = new Error('Account join intent was already completed');
      error.code = 'owner_auth_native_replay';
      error.statusCode = 409;
      throw error;
    }
    // Accounts performs the authoritative device-signature check against the
    // nonce frozen in its intent record before returning the join assertion.
    // The local state stores only the nonce hash, so it cannot reproduce that
    // signature message after a restart.
    const deviceKey = normalizeDevicePublicKey(intent.devicePublicKey);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    let device = selectTrustedDeviceRecord(draft.devices, intent.deviceId, { activeOnly: true });
    // The renewal restriction is in the protected local intent, not a value
    // supplied by the completion request. Recheck after the Accounts round trip
    // so a local revoke/key replacement during it cannot be undone by recovery.
    if (intent.renewExistingDeviceId && (!device || !isBoundDevice(device)
      || device.accountId !== normalizedAccountId
      || !intent.renewExistingEnrollmentId || device.enrollmentId !== intent.renewExistingEnrollmentId
      || createDevicePublicKeyFingerprint(device.devicePublicKey) !== intent.devicePublicKeyFingerprint)) {
      throw Object.assign(new Error('Existing device enrollment was revoked or replaced'), { statusCode: 403, code: 'device_enrollment_revoked' });
    }
    if (bindingAuthorityRevision && device?.bindingAuthorityRevision
      && BigInt(device.bindingAuthorityRevision) > BigInt(bindingAuthorityRevision)) {
      throw Object.assign(new Error('Device binding authority was superseded'), { code: 'owner_auth_native_replay', statusCode: 409 });
    }
    // A same-key, same-authority rendezvous is a renewal. Its predecessor can
    // finish requests briefly, but cannot be replayed as a completion result.
    const canOverlapCredential = verifiedAccountCompletion === true && device
      && isBoundDevice(device) && device.accountId === normalizedAccountId
      && device.bindingAuthorityRevision === bindingAuthorityRevision
      && sameWorkspaceAccess(device.workspaceAccess, workspace)
      && Boolean(device.devicePublicKey)
      && createDevicePublicKeyFingerprint(device.devicePublicKey) === intent.devicePublicKeyFingerprint;
    let keyRotated = false;
    if (device && device.accountId && device.accountId !== normalizedAccountId) {
      const error = new Error('Device is already bound to another account');
      error.code = 'owner_auth_binding_mismatch';
      error.statusCode = 403;
      throw error;
    }
    if (device && (!device.devicePublicKey
      || createDevicePublicKeyFingerprint(device.devicePublicKey) !== intent.devicePublicKeyFingerprint)) {
      // Android Keystore keys are installation-scoped. A reinstall or a
      // system-led key reset can therefore present a new key for the same
      // device identity. Reconcile it only after Accounts has authenticated
      // this exact pending join. A completed intent is replay-only and must
      // never be allowed to replace a newer key.
      const eligibleForKeyRotation = verifiedAccountCompletion === true
        && !alreadyCompleted
        && device.enrollmentKind === 'account-join'
        && device.accountId === normalizedAccountId;
      if (!eligibleForKeyRotation) {
        const error = new Error('Device public key does not match the account join intent');
        error.code = 'owner_auth_device_mismatch';
        error.statusCode = 403;
        throw error;
      }
      device.devicePublicKey = intent.devicePublicKey;
      device.keyAlgorithm = deviceKey?.algorithm;
      device.deviceName = intent.deviceName;
      device.platform = intent.platform;
      device.authVersion = 3;
      device.keyRotatedAt = now;
      device.keyRotationCount = Math.max(0, Math.floor(Number(device.keyRotationCount) || 0)) + 1;
      keyRotated = true;
    }
    if (alreadyCompleted) {
      const credential = replayAccountCompletionCredential(draft, intent, device);
      return { device: publicDevice(device), credential, keyRotated: false };
    }
    if (!device) {
      device = {
        id: intent.deviceId,
        tokenHash: '',
        status: 'bound',
        // 未扫码同账号加入的设备：bootstrap 连接模式判定依据。
        enrollmentKind: 'account-join',
        accountId: normalizedAccountId,
        ...(workspace ? { workspaceAccess: workspace } : {}),
        bindingAuthorityRevision,
        deviceName: intent.deviceName,
        platform: intent.platform,
        devicePublicKey: intent.devicePublicKey,
        authVersion: 3,
        keyAlgorithm: deviceKey?.algorithm,
        keyRotatedAt: '',
        keyRotationCount: 0,
        createdAt: now,
        boundAt: now,
        lastSeenAt: now,
        temporaryExpiresAt: '',
        revokedAt: '',
        expiresAt: '',
      };
      draft.devices.push(device);
    } else {
      device.status = 'bound';
      device.accountId = normalizedAccountId;
      device.workspaceAccess = workspace;
      device.bindingAuthorityRevision = bindingAuthorityRevision;
      device.boundAt = device.boundAt || now;
      device.lastSeenAt = now;
      device.temporaryExpiresAt = '';
      device.expiresAt = '';
    }
    intent.status = 'completed';
    intent.accountId = normalizedAccountId;
    intent.workspaceAccess = workspace;
    intent.bindingAuthorityRevision = bindingAuthorityRevision;
    intent.completionRequestId = normalizedRequestId;
    intent.completedAt = now;
    intent.completionCredentialVersion = 1;
    intent.completionCredentialIssuedAt = now;
    const expiresAt = new Date(nowMs + DEFAULT_DEVICE_TOKEN_TTL_MS).toISOString();
    intent.completionCredentialExpiresAt = expiresAt;
    const token = deriveAccountCompletionCredential(draft, intent);
    draft.authTokens = (draft.authTokens || []).flatMap((entry) => {
      if (entry.deviceId !== device.id) return [entry];
      const expiry = Date.parse(entry.expiresAt || '');
      const retired = entry.retiredAt ? Date.parse(entry.retiredAt) : Infinity;
      if (!canOverlapCredential || entry.kind !== 'bound' || entry.scope !== 'device-access'
        || entry.bindingAuthorityRevision !== bindingAuthorityRevision
        || !Number.isFinite(expiry) || expiry <= nowMs || !(retired > nowMs)) return [];
      return [{ ...entry, retiredAt: new Date(Math.min(expiry, retired, nowMs + RENDEZVOUS_CREDENTIAL_OVERLAP_MS)).toISOString() }];
    });
    draft.authTokens.push({
      tokenHash: hashSecret(token),
      deviceId: device.id,
      kind: 'bound',
      bindingAuthorityRevision,
      scope: 'device-access',
      createdAt: now,
      expiresAt,
    });
    const invitationId = trimString(intent.accountClaimInvitationId);
    if (invitationId && !alreadyCompleted) {
      const invitation = draft.invitations.find((entry) => entry.id === invitationId);
      const expiry = Date.parse(invitation?.expiresAt || '');
      if (!invitation || invitation.usedAt !== '' || invitation.claimIntentId !== normalizedIntentId
        || !Number.isFinite(expiry) || expiry <= Date.now()) {
        const error = new Error('Account-claim code is expired, already used, or invalid');
        error.code = 'account_claim_invalid';
        error.statusCode = 410;
        throw error;
      }
      invitation.usedAt = now;
      invitation.deviceId = device.id;
      invitation.claimIntentId = '';
    }
    return {
      device: publicDevice(device),
      credential: { token, expiresAt, scope: 'device-access' },
      keyRotated,
    };
  });
  if (workspace) await authorizeDeviceBinding(result.device);
  notifyDeviceBindingAuthorized(result.device.id); return result;
}

export async function createTrustedDeviceInvitation(options = {}) {
  const requestedTtlMs = Number(options.ttlMs);
  const ttlMs = Number.isFinite(requestedTtlMs)
    ? Math.min(MAX_INVITATION_TTL_MS, Math.max(MIN_INVITATION_TTL_MS, Math.floor(requestedTtlMs)))
    : DEFAULT_INVITATION_TTL_MS;
  // 192 bits of entropy, base64url encoded instead of hex so the QR carries
  // 16 fewer modules' worth of text without weakening the invitation.
  const token = `rpi_${randomBytes(24).toString('base64url')}`;
  const shortCode = randomBytes(4).toString('hex').toUpperCase();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const identity = await loadOrCreateInstanceIdentity();
  const protocolVersion = 3;
  return mutateState((draft) => {
    draft.invitations = draft.invitations.filter((entry) => {
      const expiry = Date.parse(entry.expiresAt || '');
      return entry.usedAt || (Number.isFinite(expiry) && expiry > Date.now());
    });
    const invitation = {
      id: createId('rpinv'),
      tokenHash: hashSecret(token),
      shortCodeHash: hashSecret(shortCode),
      accountHandoffAccountId: trimString(options.accountHandoffAccountId),
      endpoint: '',
      createdAt,
      expiresAt,
      usedAt: '',
      deviceId: '',
    };
    draft.invitations.push(invitation);
    const pairingUri = new URL('agentoc://pair');
    pairingUri.searchParams.set('v', String(protocolVersion));
    // This QR is an account-claim ticket only. It deliberately contains no
    // endpoint, signaling address, room, or transport metadata.
    // The account rendezvous and the instance poller use the durable Ed25519
    // identity id. Older trusted-device state may still carry the retired
    // local invitation id (rli_*), so never put that legacy id in a v3 QR.
    pairingUri.searchParams.set('i', identity.instanceId);
    pairingUri.searchParams.set('t', token);
    pairingUri.searchParams.set('x', expiresAt);
    // The endpoint-less account rendezvous must be able to authenticate the
    // target before it has an Accounts binding. Public identity is safe to
    // carry in the QR; the one-time token remains the bearer claim ticket.
    pairingUri.searchParams.set('p', identity.publicKey);
    pairingUri.searchParams.set('f', identity.keyFingerprint);
    return {
      id: invitation.id,
      instanceId: identity.instanceId,
      instance: publicInstanceIdentity(identity),
      endpoint: '',
      token,
      shortCode,
      createdAt,
      expiresAt,
      pairingUri: pairingUri.toString(),
    };
  });
}

export async function redeemTrustedDeviceInvitation(secret, options = {}) {
  const normalizedSecret = trimString(secret);
  if (!normalizedSecret) {
    const error = new Error('Pairing token or short code is required');
    error.statusCode = 400;
    throw error;
  }
  const deviceName = trimString(options.deviceName) || 'Android device';
  const platform = trimString(options.platform) || 'android';
  const rawDevicePublicKey = trimString(options.devicePublicKey);
  if (!rawDevicePublicKey) {
    const error = new Error('devicePublicKey is required');
    error.statusCode = 400;
    throw error;
  }

  // Normalize and validate the device public key (accepts PEM or base64 SPKI DER).
  const normalizedKey = normalizeDevicePublicKey(rawDevicePublicKey);

  const authVersion = Number(options.authVersion) || undefined;

  // Only auth versions 2 and 3 are supported.
  if (authVersion !== undefined && authVersion !== 2 && authVersion !== 3) {
    const error = new Error('Unsupported authVersion; only 2 and 3 are accepted');
    error.statusCode = 400;
    throw error;
  }

  // v2/v3 require a valid, normalizable public key.
  if ((authVersion === 2 || authVersion === 3) && !normalizedKey) {
    const error = new Error('Invalid devicePublicKey');
    error.statusCode = 400;
    throw error;
  }

  return mutateState((draft) => {
    const secretHash = hashSecret(normalizedSecret);
    const normalizedShortCodeHash = hashSecret(normalizedSecret.toUpperCase());
    const invitation = draft.invitations.find((entry) => (
      entry.tokenHash === secretHash || entry.shortCodeHash === normalizedShortCodeHash
    ));
    if (!invitation) {
      const error = new Error('Pairing invitation not found');
      error.statusCode = 404;
      throw error;
    }
    if (invitation.usedAt) {
      // 幂等重试（扫码响应丢失后恢复，ADR-0001 redemption-boundary idempotent）：
      // 同一邀请 + 同一设备公钥 → 返回既有设备而非 409。公钥不同 → 409。
      // normalizeState 持久化时对 devicePublicKey 做了 trimString，比较前同样 trim。
      const retryPublicKey = trimString(normalizedKey ? normalizedKey.publicKey : rawDevicePublicKey);
      const existing = draft.devices.find((entry) => (
        entry.id === invitation.deviceId
        && !entry.revokedAt
        && entry.devicePublicKey === retryPublicKey
      ));
      if (!existing) {
        const error = new Error('Pairing invitation already used');
        error.statusCode = 409;
        throw error;
      }
      const connectivity = invitation.connectivity || normalizeConnectivityPolicy(null, invitation.endpoint);
      let deviceP2P = null;
      if (connectivity?.p2p?.enabled && isBoundDevice(existing)) {
        const deviceP2PSecret = deriveDeviceP2PSecret(draft.instanceSecret, existing.id);
        deviceP2P = {
          roomId: createP2PRoomId(deviceP2PSecret),
          secret: deviceP2PSecret,
          signalingEndpoint: connectivity?.p2p?.signalingEndpoint || '',
        };
      }
      let credential;
      if (authVersion === 3 || authVersion === 2) {
        if (isBoundDevice(existing)) {
          // A used invitation is still an idempotent recovery boundary, but it
          // must never downgrade a device that already completed Google
          // convergence. Re-issue only a short-lived device credential.
          const accessToken = `rda_${randomBytes(32).toString('hex')}`;
          const accessExpiresAt = new Date(Date.now() + DEFAULT_DEVICE_TOKEN_TTL_MS).toISOString();
          draft.authTokens = (draft.authTokens || []).filter((entry) => entry.deviceId !== existing.id);
          draft.authTokens.push({
            tokenHash: hashSecret(accessToken),
            deviceId: existing.id,
            kind: 'bound',
            scope: 'device-access',
            createdAt: nowIso(),
            expiresAt: accessExpiresAt,
          });
          existing.lastSeenAt = nowIso();
          credential = {
            type: 'Bearer',
            token: accessToken,
            expiresAt: accessExpiresAt,
            scope: 'device-access',
          };
        } else {
          // A new device remains provisional until Google identity convergence.
          const provisionalToken = `rdp_${randomBytes(32).toString('hex')}`;
          existing.status = 'provisional';
          existing.temporaryExpiresAt = invitation.expiresAt;
          existing.expiresAt = invitation.expiresAt;
          draft.authTokens = (draft.authTokens || []).filter((entry) => entry.deviceId !== existing.id);
          draft.authTokens.push({
            tokenHash: hashSecret(provisionalToken),
            deviceId: existing.id,
            kind: 'provisional',
            scope: 'provisional-google',
            createdAt: nowIso(),
            expiresAt: invitation.expiresAt,
          });
          credential = {
            type: 'Bearer',
            token: provisionalToken,
            expiresAt: invitation.expiresAt,
            scope: 'provisional-google',
          };
        }
      } else {
        // legacy：首次响应的 rdt_ 明文无法恢复，为同一设备重新签发一个。
        const freshToken = `rdt_${randomBytes(32).toString('hex')}`;
        existing.tokenHash = hashSecret(freshToken);
        credential = { type: 'Bearer', token: freshToken };
      }
      return {
        instanceId: draft.instanceId,
        endpoint: invitation.endpoint,
        connectivity,
        device: publicDevice(existing),
        credential,
        deviceP2P,
      };
    }
    const expiresAtMs = Date.parse(invitation.expiresAt || '');
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      const error = new Error('Pairing invitation expired');
      error.statusCode = 410;
      throw error;
    }

    // v3/v2 start as provisional credentials. They are promoted only after the
    // Google ID token has been verified and Accounts has returned an assertion.
    // Legacy (no authVersion): rdt_ bearer with 24h expiry, raw key stored as-is.
    let deviceToken = '';
    let credential;
    let deviceAuthVersion;
    let deviceKeyAlgorithm;
    const storedPublicKey = normalizedKey ? normalizedKey.publicKey : rawDevicePublicKey;

    if (authVersion === 3 || authVersion === 2) {
      deviceAuthVersion = authVersion;
      deviceKeyAlgorithm = normalizedKey.algorithm;
      deviceToken = `rdp_${randomBytes(32).toString('hex')}`;
      credential = {
        type: 'Bearer',
        token: deviceToken,
        expiresAt: invitation.expiresAt,
        scope: 'provisional-google',
      };
    } else {
      // Legacy: no authVersion specified. Issue rdt_ bearer with persisted expiry.
      // Store normalized key if available, otherwise store raw key as-is.
      deviceToken = `rdt_${randomBytes(32).toString('hex')}`;
      deviceAuthVersion = undefined;
      deviceKeyAlgorithm = normalizedKey ? normalizedKey.algorithm : undefined;
      credential = { type: 'Bearer', token: deviceToken };
    }

    const provisionalDevice = authVersion === 3 || authVersion === 2;
    const device = {
      id: createId('rdev'),
      tokenHash: deviceToken ? hashSecret(deviceToken) : '',
      status: provisionalDevice ? 'provisional' : 'legacy_trusted',
      // v3 QR is an account-claim challenge, not a general trusted-device
      // pairing path. Legacy invitations retain qr-scan for compatibility.
      enrollmentKind: provisionalDevice ? 'account-claim' : 'qr-scan',
      accountId: '',
      deviceName,
      platform,
      devicePublicKey: storedPublicKey,
      authVersion: deviceAuthVersion,
      keyAlgorithm: deviceKeyAlgorithm,
      createdAt: nowIso(),
      boundAt: '',
      lastSeenAt: nowIso(),
      temporaryExpiresAt: provisionalDevice ? invitation.expiresAt : '',
      revokedAt: '',
      // Legacy devices get a 24h expiry so it is enforceable.
      expiresAt: deviceToken ? invitation.expiresAt : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    draft.devices.push(device);
    if (provisionalDevice) {
      draft.authTokens = (draft.authTokens || []).filter((entry) => entry.deviceId !== device.id);
      draft.authTokens.push({
        tokenHash: hashSecret(deviceToken),
        deviceId: device.id,
        kind: 'provisional',
        scope: 'provisional-google',
        createdAt: device.createdAt,
        expiresAt: device.expiresAt,
      });
    }
    invitation.usedAt = nowIso();
    invitation.deviceId = device.id;
    const connectivity = invitation.connectivity || normalizeConnectivityPolicy(null, invitation.endpoint);
    const p2pEnabled = connectivity?.p2p?.enabled;
    const signalingEndpoint = connectivity?.p2p?.signalingEndpoint;
    let deviceP2P = null;
    if (p2pEnabled && isBoundDevice(device)) {
      const deviceP2PSecret = deriveDeviceP2PSecret(draft.instanceSecret, device.id);
      const deviceP2PRoomId = createP2PRoomId(deviceP2PSecret);
      deviceP2P = {
        roomId: deviceP2PRoomId,
        secret: deviceP2PSecret,
        signalingEndpoint: signalingEndpoint || '',
      };
    }
    return {
      instanceId: draft.instanceId,
      endpoint: invitation.endpoint,
      connectivity,
      device: publicDevice(device),
      credential,
      deviceP2P,
    };
  });
}

export async function authenticateTrustedDeviceToken(token) {
  const normalizedToken = trimString(token);
  if (!normalizedToken.startsWith('rdt_')
    && !normalizedToken.startsWith('rda_')
    && !normalizedToken.startsWith('rdp_')) return null;
  const state = await loadState();
  const tokenHash = hashSecret(normalizedToken);

  if (normalizedToken.startsWith('rda_') || normalizedToken.startsWith('rdp_')) {
    const authToken = state.authTokens.find((entry) => entry.tokenHash === tokenHash);
    if (!authToken) return null;
    const originalExpiry = Date.parse(authToken.expiresAt || '');
    const retirementExpiry = authToken.retiredAt ? Date.parse(authToken.retiredAt) : Infinity;
    const expiresAtMs = Math.min(originalExpiry, retirementExpiry);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
    const device = state.devices.find((entry) => entry.id === authToken.deviceId && !entry.revokedAt);
    if (!device) return null;
    const provisional = authToken.kind === 'provisional'
      || device.status === 'provisional'
      || device.status === 'temporary_connected';
    if (normalizedToken.startsWith('rdp_') && !['provisional', 'bound'].includes(authToken.kind)) return null;
    let authority = null;
    if (!provisional) {
      try { authority = await authorizeDeviceBinding(device, { credential: true, tokenRevision: authToken.bindingAuthorityRevision }); }
      catch { return null; }
    }
    if (expiresAtMs <= Date.now()) return null;
    return {
      role: provisional ? 'visitor' : 'owner',
      principalId: device.id,
      principalKind: provisional ? 'provisional_device' : 'trusted_device',
      deviceId: device.id,
      deviceName: device.deviceName,
      ...(authority ? { accountId: authority.accountId, bindingAuthorityRevision: authority.revision,
        ...(authority.workspaceAccess ? { workspaceAccess: authority.workspaceAccess } : {}) } : {}),
      authMethod: provisional ? 'provisional_pairing' : 'trusted_device_challenge',
      scope: provisional ? 'provisional-google' : 'device-access',
      expiry: expiresAtMs,
    };
  }

  // rdt_ legacy bearer token.
  const device = state.devices.find((entry) => entry.tokenHash === tokenHash && !entry.revokedAt);
  if (!device) return null;
  // Enforce persisted expiresAt for legacy devices.
  if (device.expiresAt) {
    const deviceExpiryMs = Date.parse(device.expiresAt);
    if (Number.isFinite(deviceExpiryMs) && deviceExpiryMs <= Date.now()) return null;
  }
  // A legacy bearer never inherits a newly enrolled device's authority.
  // Fresh account authentication issues a separate generation-stamped rda_.
  let authority;
  try { authority = await authorizeDeviceBinding(device, { credential: true, tokenRevision: '' }); }
  catch { return null; }
  return {
    role: 'owner',
    principalId: device.id,
    principalKind: 'trusted_device',
    deviceId: device.id,
    deviceName: device.deviceName,
    ...(authority ? { accountId: authority.accountId, bindingAuthorityRevision: authority.revision } : {}),
    authMethod: 'trusted_device_token',
    scope: 'device-access',
    expiry: Date.now() + (24 * 60 * 60 * 1000),
  };
}

export async function listTrustedDevices() {
  const state = await loadState();
  return {
    instanceId: state.instanceId,
    devices: state.devices.map(publicDevice),
  };
}

export async function getTrustedDeviceInstanceId() {
  return mutateState((draft) => draft.instanceId);
}

export async function promoteTrustedDevice(deviceId, accountId) {
  const normalizedDeviceId = trimString(deviceId);
  const normalizedAccountId = trimString(accountId);
  if (!normalizedDeviceId || !normalizedAccountId) {
    const error = new Error('deviceId and accountId are required');
    error.statusCode = 400;
    throw error;
  }
  return mutateState((draft) => {
    const device = draft.devices.find((entry) => entry.id === normalizedDeviceId && !entry.revokedAt);
    if (!device) {
      const error = new Error('Trusted device not found');
      error.statusCode = 404;
      throw error;
    }
    if (isBoundDevice(device) && device.accountId && device.accountId !== normalizedAccountId) {
      const error = new Error('Device account does not match the bound account');
      error.code = 'owner_auth_binding_mismatch';
      error.statusCode = 403;
      throw error;
    }
    const now = nowIso();
    device.status = 'bound';
    device.accountId = normalizedAccountId;
    device.boundAt = device.boundAt || now;
    device.temporaryExpiresAt = '';
    device.expiresAt = '';
    device.lastSeenAt = now;
    // The provisional bearer is a one-purpose bridge. Remove every prior
    // credential before issueTrustedDeviceCredential creates the replacement;
    // changing rdp_ metadata in place would leave the old bearer usable.
    draft.authTokens = (draft.authTokens || []).filter((entry) => entry.deviceId !== normalizedDeviceId);
    return publicDevice(device);
  });
}

// Complete the local half of native account convergence in one state mutation.
// The Accounts call happens before this function, so callers must retain a
// retry/compensation record until this mutation and credential issuance both
// succeed. Keeping the two local writes together avoids a bound device with no
// replacement credential when the second write fails.
export async function convergeTrustedDevice(deviceId, accountId, { bindingAuthorityRevision = '' } = {}) {
  const normalizedDeviceId = trimString(deviceId);
  const normalizedAccountId = trimString(accountId);
  if (!normalizedDeviceId || !normalizedAccountId) {
    const error = new Error('deviceId and accountId are required');
    error.statusCode = 400;
    throw error;
  }
  const authorityDevice = { accountId: normalizedAccountId, bindingAuthorityRevision };
  await authorizeDeviceBinding(authorityDevice);
  const result = await mutateState((draft) => {
    assertDeviceBindingNow(authorityDevice);
    const device = draft.devices.find((entry) => entry.id === normalizedDeviceId && !entry.revokedAt);
    if (!device) {
      const error = new Error('Trusted device not found');
      error.code = 'trusted_device_convergence_failed';
      error.statusCode = 404;
      throw error;
    }
    if (isBoundDevice(device) && device.accountId && device.accountId !== normalizedAccountId) {
      const error = new Error('Device account does not match the bound account');
      error.code = 'owner_auth_binding_mismatch';
      error.statusCode = 403;
      throw error;
    }
    const now = nowIso();
    device.status = 'bound';
    device.accountId = normalizedAccountId;
    if (bindingAuthorityRevision && device.bindingAuthorityRevision
      && BigInt(device.bindingAuthorityRevision) > BigInt(bindingAuthorityRevision)) {
      throw Object.assign(new Error('Device binding authority was superseded'), { code: 'owner_auth_authority_superseded', statusCode: 409 });
    }
    device.bindingAuthorityRevision = bindingAuthorityRevision;
    device.boundAt = device.boundAt || now;
    device.temporaryExpiresAt = '';
    device.expiresAt = '';
    device.lastSeenAt = now;
    draft.authTokens = (draft.authTokens || []).filter((entry) => entry.deviceId !== normalizedDeviceId);
    const token = `rda_${randomBytes(32).toString('hex')}`;
    const expiresAt = new Date(Date.now() + DEFAULT_DEVICE_TOKEN_TTL_MS).toISOString();
    draft.authTokens.push({
      tokenHash: hashSecret(token),
      deviceId: normalizedDeviceId,
      kind: 'bound',
      bindingAuthorityRevision,
      scope: 'device-access',
      createdAt: now,
      expiresAt,
    });
    return {
      device: publicDevice(device),
      credential: { token, expiresAt, scope: 'device-access' },
    };
  });
  notifyDeviceBindingAuthorized(normalizedDeviceId); return result;
}

export async function issueTrustedDeviceCredential(deviceId) {
  const normalizedDeviceId = trimString(deviceId);
  await authorizeDeviceBinding(await getTrustedDeviceStatus(normalizedDeviceId));
  return mutateState((draft) => {
    const device = draft.devices.find((entry) => entry.id === normalizedDeviceId && !entry.revokedAt);
    if (!device || !isBoundDevice(device)) {
      const error = new Error('Bound trusted device not found');
      error.code = 'device_not_bound';
      error.statusCode = 403;
      throw error;
    }
    assertDeviceBindingNow(device);
    const token = `rda_${randomBytes(32).toString('hex')}`;
    const expiresAt = new Date(Date.now() + DEFAULT_DEVICE_TOKEN_TTL_MS).toISOString();
    const nowMs = Date.now();
    draft.authTokens = (draft.authTokens || []).filter((entry) => {
      if (entry.deviceId !== normalizedDeviceId) return true;
      const expiry = Date.parse(entry.expiresAt || '');
      return Number.isFinite(expiry) && expiry > nowMs;
    });
    draft.authTokens.push({
      tokenHash: hashSecret(token),
      deviceId: normalizedDeviceId,
      kind: 'bound',
      bindingAuthorityRevision: device.bindingAuthorityRevision,
      scope: 'device-access',
      createdAt: nowIso(),
      expiresAt,
    });
    return { token, expiresAt, scope: 'device-access' };
  });
}

export async function getTrustedDeviceStatus(deviceId) {
  const normalizedDeviceId = trimString(deviceId);
  if (!normalizedDeviceId) return null;
  const state = await loadState();
  const device = selectTrustedDeviceRecord(state.devices, normalizedDeviceId);
  return device ? publicDevice(device) : null;
}

// 配对成功时公钥已随设备记录写入。同步/入口切换只应从这一信任清单取键，
// 绝不接受浏览器手填或请求体携带的公钥。
export async function getTrustedDevicePublicKey(deviceId) {
  const normalizedDeviceId = trimString(deviceId);
  if (!normalizedDeviceId) return null;
  const state = await loadState();
  const device = selectTrustedDeviceRecord(state.devices, normalizedDeviceId, { activeOnly: true });
  return device?.devicePublicKey || null;
}

// bootstrap contract 的 webrtc 候选只携带 roomId 与信令端点；P2P secret 仍
// 只在 redeem 响应发放一次，由客户端本地保存，不在契约中重复下发。
export async function getTrustedDeviceP2PRoom(deviceId) {
  const normalizedDeviceId = trimString(deviceId);
  if (!normalizedDeviceId) return null;
  const state = await loadState();
  const device = selectTrustedDeviceRecord(state.devices, normalizedDeviceId, { activeOnly: true });
  if (!device) return null;
  if (isBoundDevice(device)) await authorizeDeviceBinding(device);
  const roomSecret = deriveDeviceP2PSecret(state.instanceSecret, device.id);
  return { roomId: createP2PRoomId(roomSecret) };
}

// Rendezvous is the only short-lived path that may return the room secret to
// the already authenticated phone. It is never part of the signed bootstrap
// contract or the durable trusted-device record.
export async function getTrustedDeviceP2PAccess(deviceId) {
  const normalizedDeviceId = trimString(deviceId);
  if (!normalizedDeviceId) return null;
  const state = await loadState();
  const device = selectTrustedDeviceRecord(state.devices, normalizedDeviceId, { activeOnly: true });
  if (!device) return null;
  if (isBoundDevice(device)) await authorizeDeviceBinding(device);
  const secret = deriveDeviceP2PSecret(state.instanceSecret, device.id);
  return {
    roomId: createP2PRoomId(secret),
    secret,
  };
}

export async function revokeTrustedDevice(deviceId) {
  const normalizedDeviceId = trimString(deviceId);
  const result = await mutateState((draft) => {
    const requested = draft.devices.filter((entry) => entry.id === normalizedDeviceId);
    if (requested.length === 0) {
      const error = new Error('Trusted device not found');
      error.statusCode = 404;
      throw error;
    }
    // Historical account joins could create several IDs for one installation
    // key. Revoking that phone must not leave a second enrollment usable by
    // key-based renewal. Keep audit records and revoke their credentials too.
    const fingerprints = new Set(requested.map(entry => createDevicePublicKeyFingerprint(entry.devicePublicKey)).filter(Boolean));
    const devices = draft.devices.filter(entry => entry.id === normalizedDeviceId
      || fingerprints.has(createDevicePublicKeyFingerprint(entry.devicePublicKey)));
    const revokedIds = new Set(devices.map(entry => entry.id));
    const now = nowIso();
    for (const device of devices) {
      if (!device.revokedAt) device.revokedAt = now;
    }
    draft.authTokens = (draft.authTokens || []).filter((entry) => !revokedIds.has(entry.deviceId));
    // Purge pending (unused) challenges for the device.
    if (draft.challenges) {
      draft.challenges = draft.challenges.filter((entry) => (
        !revokedIds.has(entry.deviceId) || entry.usedAt
      ));
    }
    return { device: publicDevice(selectTrustedDeviceRecord(draft.devices, normalizedDeviceId)), revokedIds: [...revokedIds] };
  });
  for (const id of result.revokedIds) notifyDeviceBindingRevoked(id);
  return result.device;
}

// 登记/更新设备入口地址（入口切换 M3：A 侧切换面板据此列出可切换设备并生成 jumpUrl）
// 空字符串 = 清除登记；非 http(s) 或格式非法 → 400（normalizeEndpoint 归一化尾斜杠/去 query）
export async function updateTrustedDeviceEntryUrl(deviceId, entryUrl) {
  const normalizedDeviceId = trimString(deviceId);
  const rawEntryUrl = trimString(entryUrl);
  const normalizedEntryUrl = normalizeEndpoint(rawEntryUrl);
  if (rawEntryUrl && !normalizedEntryUrl) {
    const error = new Error('A valid http(s) entry URL is required');
    error.statusCode = 400;
    throw error;
  }
  return mutateState((draft) => {
    const device = selectTrustedDeviceRecord(draft.devices, normalizedDeviceId, { activeOnly: true });
    if (!device) {
      const error = new Error('Trusted device not found');
      error.statusCode = 404;
      throw error;
    }
    device.entryUrl = normalizedEntryUrl;
    return publicDevice(device);
  });
}

export async function createTrustedDeviceAuthChallenge(deviceId, options = {}) {
  const normalizedDeviceId = trimString(deviceId);
  const audience = trimString(options.audience) || 'agentoc-device-access';
  const publicKey = trimString(options.devicePublicKey);
  const fingerprint = publicKey ? createDevicePublicKeyFingerprint(publicKey) : '';
  if (publicKey && (!normalizeDevicePublicKey(publicKey) || !fingerprint)) {
    throw Object.assign(new Error('Invalid device public key'), { statusCode: 400, code: 'invalid_device_public_key' });
  }
  // Older invitation state retains rli_*. New key-based renewal binds the
  // durable inst_* identity used by Accounts and signed connection bootstrap.
  const renewalInstanceId = publicKey ? (await loadOrCreateInstanceIdentity()).instanceId : '';

  return mutateState((draft) => {
    // A phone can lose its expired bearer without losing its installation key.
    // Resolve only an existing active enrollment; this route never enrolls or
    // upgrades authority. The normal signature verification still gates minting.
    const matches = draft.devices.filter((entry) => !entry.revokedAt
      && (normalizedDeviceId ? entry.id === normalizedDeviceId : Boolean(fingerprint))
      && (!fingerprint || createDevicePublicKeyFingerprint(entry.devicePublicKey) === fingerprint));
    const device = matches.reduce((selected, entry) => (
      !selected || deviceRecordTimestamp(entry) >= deviceRecordTimestamp(selected) ? entry : selected
    ), null);
    if (!device) {
      const error = new Error('Trusted device not found');
      error.statusCode = 404;
      throw error;
    }
    if (!isBoundDevice(device)) {
      const error = new Error('Google identity is required before device authentication');
      error.code = 'google_required';
      error.statusCode = 403;
      throw error;
    }

    // Sweep expired challenges for all devices.
    if (draft.challenges) {
      draft.challenges = draft.challenges.filter((entry) => {
        if (entry.usedAt) return false;
        const expiry = Date.parse(entry.expiresAt || '');
        return Number.isFinite(expiry) && expiry > Date.now();
      });
    } else {
      draft.challenges = [];
    }

    const challengeId = createId('rdac');
    const nonce = createId('nonce', 16);
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();
    const instanceId = renewalInstanceId || draft.instanceId;
    const message = buildDeviceAuthMessageV3({
      instanceId,
      deviceId: device.id,
      challengeId,
      nonce,
      issuedAt,
      audience,
    });

    // Per-device pending challenge limit = 5 (drop oldest unused when exceeded).
    const deviceChallenges = draft.challenges
      .filter((entry) => entry.deviceId === device.id && !entry.usedAt)
      .sort((a, b) => {
        const aTime = Date.parse(a.createdAt || '');
        const bTime = Date.parse(b.createdAt || '');
        return (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
      });
    while (deviceChallenges.length >= 5) {
      const oldest = deviceChallenges.shift();
      const idx = draft.challenges.findIndex((entry) => entry.challengeId === oldest.challengeId);
      if (idx !== -1) draft.challenges.splice(idx, 1);
    }

    const challenge = {
      challengeId,
      deviceId: device.id,
      nonceHash: hashSecret(nonce),
      message,
      createdAt: issuedAt,
      usedAt: '',
      issuedAt,
      expiresAt,
      audience,
      instanceId,
    };
    draft.challenges.push(challenge);

    return {
      challengeId,
      deviceId: device.id,
      nonce,
      message,
      issuedAt,
      expiresAt,
      audience,
      instanceId,
    };
  });
}

export async function verifyTrustedDeviceAuthChallenge({
  deviceId,
  challengeId,
  nonce,
  signature,
} = {}) {
  const normalizedDeviceId = trimString(deviceId);
  const normalizedChallengeId = trimString(challengeId);
  const normalizedNonce = trimString(nonce);
  const normalizedSignature = trimString(signature);

  if (!normalizedDeviceId || !normalizedChallengeId || !normalizedNonce || !normalizedSignature) {
    const error = new Error('deviceId, challengeId, nonce, and signature are required');
    error.statusCode = 400;
    throw error;
  }

  // Verify an intact, unused challenge before any network authority lookup.
  // Recheck under the mutation lock before consuming it or issuing a token.
  const preState = await loadState();
  const preChallenge = preState.challenges.find(item => item.challengeId === normalizedChallengeId && item.deviceId === normalizedDeviceId);
  const preDevice = preState.devices.find(item => item.id === normalizedDeviceId && !item.revokedAt);
  if (preDevice && preChallenge && !preChallenge.usedAt && Date.parse(preChallenge.expiresAt || '') > Date.now()
    && preChallenge.nonceHash === hashSecret(normalizedNonce)
    && verifyDeviceAuthSignature({ publicKey: preDevice.devicePublicKey, algorithm: preDevice.keyAlgorithm || 'ed25519',
      message: preChallenge.message, signature: normalizedSignature })) await authorizeDeviceBinding(preDevice);
  return mutateState((draft) => {
    if (!draft.challenges) draft.challenges = [];

    // Find the challenge first (before sweeping), so expired challenges
    // can be reported as 410 rather than disappearing as 404.
    const challenge = draft.challenges.find((entry) => (
      entry.challengeId === normalizedChallengeId
      && entry.deviceId === normalizedDeviceId
    ));
    if (!challenge) {
      const error = new Error('Challenge not found');
      error.statusCode = 404;
      throw error;
    }

    // Check expiry (before sweeping, so the challenge is still present).
    const expiresAtMs = Date.parse(challenge.expiresAt || '');
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      const error = new Error('Challenge expired');
      error.statusCode = 410;
      throw error;
    }

    if (challenge.nonceHash !== hashSecret(normalizedNonce)) {
      const error = new Error('Nonce mismatch');
      error.statusCode = 401;
      throw error;
    }
    if (challenge.usedAt) {
      const error = new Error('Challenge already used');
      error.statusCode = 401;
      throw error;
    }

    const device = draft.devices.find((entry) => entry.id === normalizedDeviceId && !entry.revokedAt);
    if (!device) {
      const error = new Error('Trusted device not found or revoked');
      error.statusCode = 404;
      throw error;
    }

    // Algorithm-agnostic signature verification against the registered public key.
    if (!verifyDeviceAuthSignature({
      publicKey: device.devicePublicKey,
      algorithm: device.keyAlgorithm || 'ed25519',
      message: challenge.message,
      signature: normalizedSignature,
    })) {
      const error = new Error('Invalid signature');
      error.statusCode = 401;
      throw error;
    }

    assertDeviceBindingNow(device);
    challenge.usedAt = nowIso();
    device.lastSeenAt = nowIso();

    const credentialToken = `rda_${randomBytes(32).toString('hex')}`;
    const credentialExpiresAt = new Date(Date.now() + DEFAULT_DEVICE_TOKEN_TTL_MS).toISOString();
    draft.authTokens = (draft.authTokens || []).filter((entry) => {
      const expiry = Date.parse(entry.expiresAt || '');
      return Number.isFinite(expiry) && expiry > Date.now();
    });
    draft.authTokens.push({
      tokenHash: hashSecret(credentialToken),
      deviceId: device.id,
      kind: 'bound',
      scope: 'device-access',
      bindingAuthorityRevision: device.bindingAuthorityRevision,
      createdAt: nowIso(),
      expiresAt: credentialExpiresAt,
    });
    return {
      verified: true,
      deviceId: device.id,
      credential: {
        type: 'Bearer',
        token: credentialToken,
        expiresAt: credentialExpiresAt,
        scope: 'device-access',
      },
      // Fresh proof also replaces material cleared on a prior 401. Without
      // this, the phone could renew HTTP auth but could not build a TURN carrier.
      deviceP2P: trimString(P2P_SIGNALING_URL) ? (() => {
        const secret = deriveDeviceP2PSecret(draft.instanceSecret, device.id);
        return { roomId: createP2PRoomId(secret), secret, signalingEndpoint: trimString(P2P_SIGNALING_URL) };
      })() : null,
      // ADR-0001（2026-08-17 修订）：鉴权后的连接模式必须来自服务端签发的
      // bootstrap contract；这里只给发现提示，契约本体在专用端点获取。
      bootstrap: {
        endpoint: '/api/device-auth/bootstrap',
        contractVersion: 2,
      },
    };
  });
}
