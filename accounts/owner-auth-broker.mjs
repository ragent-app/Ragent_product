// Accounts 侧 owner 身份 broker 的纯业务层。
// HTTP/UI 层只负责：以 tx + bootstrap 打开受控 Accounts 页面、用 GIS 提交 ID token、
// 再把 opaque grant 回跳给实例。本模块不接触 Google client secret 或 refresh token。
import { createHash, randomBytes } from 'node:crypto';
import { createRendezvousInboxWait } from './rendezvous-inbox-wait.mjs';
import {
  buildAccountJoinIntentProofMessage,
  buildInstanceProofMessage,
  buildInstanceAccessGrantMessage,
  buildOwnerAuthDeviceMessage,
  buildProviderSyncPeerMessage,
  buildAccountRendezvousPollMessage,
  buildNativeOwnerAuthMessage,
  buildNativeOwnerAuthRollbackMessage,
  buildBindingAuthorityProofMessage,
  buildAccountFileUploadQuotaMessage,
  buildTargetRuntimeAuthorizationMessage,
  buildOwnerAuthPollMessage,
  createInstancePublicKeyFingerprint,
  verifyInstanceProofSignature,
} from '../lib/instance-proof-protocol.mjs';
import { compareSyncVersions, normalizeAccountSyncCatalogEntry } from '../lib/account-sync.mjs';
import {
  buildAccountJoinIntentMessage,
  buildAccountCredentialRefreshMessage,
  buildAccountSessionMessage,
  buildDesktopAccountSessionAuthorization,
  createDevicePublicKeyFingerprint,
  normalizeDevicePublicKey,
  verifyDeviceAuthSignature,
} from '../lib/device-auth-protocol.mjs';
import {
  TURN_AUTHORIZATION_POLICY_VERSION,
  createTurnConnectionId,
  evaluateTurnConnectionAuthorization,
  normalizeTurnDeviceKind,
  publicTurnAuthorization,
} from '../lib/turn-authorization.mjs';
import { getTurnConnectionLeases, resolveAccountEntitlement, effectiveDeviceKind,
  isActiveTurnConnectionLease, activeTurnConnectionState, ACCOUNT_FILE_UPLOAD_POLICY_VERSION,
  resolveAccountFileUploadLimits } from './turn-lease-policy.mjs';
import { prepareTurnHandoff, commitTurnHandoff, expireTurnHandoffs } from './turn-handoff-policy.mjs';
import { issueTurnBrokerCapability } from '../lib/turn-broker-capability.mjs';
import { assertAccountNotDeleting } from './account-deletion-policy.mjs';
import { issueInstanceAccessGrant, revokeInstanceAccessGrant } from './instance-access-grants.mjs';
import { isTurnLeaseId, matchesTurnLeasePair, createTurnOperationRequestId, canAdmitTurnLeaseId, pruneTurnLeases,
  turnLeaseObservedAt, turnLeasePairClock } from '../lib/turn-lease-identity.mjs';
import {
  createTargetRuntimeGrantClaims,
  TARGET_RUNTIME_GRANT_AUDIENCE,
  TARGET_RUNTIME_GRANT_TTL_MS,
} from '../lib/target-runtime-grant.mjs';
import { classifyTargetRuntimeRequest, normalizeTargetRuntimePath } from '../lib/target-runtime-policy.mjs';
import { createRendezvousResultWaiters, rendezvousResultWaitMs, waitForRendezvousResultTick,
  RENDEZVOUS_RESULT_CHECKPOINT_MS } from './rendezvous-result-waiters.mjs';

// Account selection and verification in an external phone browser can take
// several minutes. The one-use login transaction has its own preparation window.
export const OWNER_AUTH_TRANSACTION_TTL_MS = 15 * 60 * 1000;
export const OWNER_AUTH_PROOF_SKEW_MS = 2 * 60 * 1000;
export const OWNER_AUTH_POLL_AUDIENCE = 'agentoc-owner-auth-poll';
export const OWNER_AUTH_POLL_ASSERTION_TTL_MS = 60 * 1000;
export const OWNER_AUTH_POLL_RETRY_AFTER_MS = 2000;
export const ACCOUNT_SESSION_CHALLENGE_TTL_MS = 15 * 60 * 1000;
export const ACCOUNT_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;
export const ACCOUNT_SESSION_ACTIVITY_PERSIST_INTERVAL_MS = 60_000;
export const ACCOUNT_JOIN_GRANT_TTL_MS = 60 * 1000;
export const ACCOUNT_RENDEZVOUS_TTL_MS = 2 * 60 * 1000;
export const ACCOUNT_RENDEZVOUS_RESULT_TTL_MS = 5 * 60 * 1000;
export const ACCOUNT_RENDEZVOUS_ACTIVITY_PERSIST_INTERVAL_MS = 5 * 60 * 1000;
export const ACCOUNT_FILE_UPLOAD_RESERVATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACCOUNT_CREDENTIAL_REFRESH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TARGET_RUNTIME_AUTH_SKEW_MS = 2 * 60 * 1000;
const TARGET_RUNTIME_AUTH_MAX_LIFETIME_MS = 5 * 60 * 1000;

const DELIVERY_MODES = new Set(['browser_callback', 'instance_poll']);

/** Revocation releases only this account's leases for the exact computer. */
export function releaseRevokedInstanceTurnConnections(draft, { accountId, instanceId, nowMs }) {
  if (!accountId || !instanceId || !Number.isFinite(nowMs)) throw new TypeError('Revoked computer identity and time are required');
  let released = 0;
  for (const lease of getTurnConnectionLeases(draft)) {
    if (lease.accountId !== accountId || lease.instanceId !== instanceId || !isActiveTurnConnectionLease(lease, nowMs)) continue;
    const now = new Date(Math.max(nowMs, turnLeaseObservedAt(lease))).toISOString();
    lease.status = 'released';
    lease.updatedAt = now;
    lease.releasedAt = now;
    lease.releaseReason = 'computer-unbound';
    released++;
  }
  return released;
}

// Terminal completions (or their redeemed pre-015 grants) are durable links.
// A pending request, bare target ID or key/name similarity is not one.
function completedTurnPhoneLinks(draft, accountId) {
  const tuple = item => JSON.stringify([item.intentId, item.instanceId, item.deviceId]);
  const grants = new Map();
  for (const grant of getAccountJoinGrants(draft)) {
    if (grant.accountId !== accountId || !trimString(grant.accountDeviceId) || !trimString(grant.redeemedAt)) continue;
    const key = tuple(grant), previous = grants.get(key);
    if (!previous || String(grant.redeemedAt || grant.createdAt) > String(previous.redeemedAt || previous.createdAt)) grants.set(key, grant);
  }
  const links = new Map();
  for (const intent of getAccountJoinIntents(draft)) {
    if (intent.accountId !== accountId || !['completed', 'rendezvous_completed'].includes(intent.status)) continue;
    const phoneId = trimString(intent.accountDeviceId) || trimString(grants.get(tuple(intent))?.accountDeviceId);
    if (!phoneId) continue;
    const key = JSON.stringify([intent.instanceId, intent.deviceId]);
    if (!links.has(key)) links.set(key, []);
    links.get(key).push({ phoneId, intent });
  }
  return links;
}

function isOwnedPhoneTurnLease(lease, accountId, deviceId, links) {
  if (lease.accountId !== accountId || effectiveDeviceKind(lease) !== 'phone') return false;
  const quotaId = trimString(lease.quotaDeviceId);
  if (quotaId === deviceId) return true;
  if (quotaId && quotaId !== lease.deviceId) return false;
  const phoneIds = new Set((links.get(JSON.stringify([lease.instanceId, lease.deviceId])) || []).map(link => link.phoneId));
  return lease.deviceId === deviceId || (phoneIds.size === 1 && phoneIds.has(deviceId));
}

function releaseRevokedPhoneTurnConnections(draft, { accountId, deviceId, nowMs }) {
  const links = completedTurnPhoneLinks(draft, accountId);
  let released = 0;
  for (const lease of getTurnConnectionLeases(draft)) {
    if (!isActiveTurnConnectionLease(lease, nowMs) || !isOwnedPhoneTurnLease(lease, accountId, deviceId, links)) continue;
    const now = new Date(Math.max(nowMs, turnLeaseObservedAt(lease))).toISOString();
    lease.status = 'released';
    lease.updatedAt = now;
    lease.releasedAt = now;
    lease.releaseReason = 'phone-revoked';
    released++;
  }
  return released;
}

function normalizeLegacyTurnQuotaPhones(draft, accountId, nowMs) {
  const links = completedTurnPhoneLinks(draft, accountId);
  const activePhones = new Set(getAccountDevices(draft).filter(phone => phone.accountId === accountId && !phone.revokedAt)
    .map(phone => phone.deviceId));
  for (const lease of getTurnConnectionLeases(draft)) {
    if (lease.accountId !== accountId || effectiveDeviceKind(lease) !== 'phone' || !isActiveTurnConnectionLease(lease, nowMs)) continue;
    const quotaId = trimString(lease.quotaDeviceId);
    if (quotaId && quotaId !== lease.deviceId) continue;
    const phoneIds = new Set((links.get(JSON.stringify([lease.instanceId, lease.deviceId])) || []).map(link => link.phoneId));
    if (phoneIds.size !== 1) continue;
    const [phoneId] = phoneIds;
    if (activePhones.has(phoneId)) lease.quotaDeviceId = phoneId;
  }
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso(clock) {
  return new Date(clock());
}

function makeId(prefix, bytes = 24) {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

function hashSecret(value) {
  return createHash('sha256')
    .update(String(value || ''))
    .digest('hex');
}

function getTargetRuntimeAuthorizations(draft) {
  if (!Array.isArray(draft.targetRuntimeAuthorizations)) draft.targetRuntimeAuthorizations = [];
  return draft.targetRuntimeAuthorizations;
}

function makeAccountCredential() {
  return `rac_${randomBytes(32).toString('base64url')}`;
}

function makeAccountJoinGrant() {
  return `rajg_${randomBytes(32).toString('base64url')}`;
}

function isProtocolField(value, { min = 1, max = 256 } = {}) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length >= min
    && value.length <= max
    && !/[\r\n]/.test(value)
    && /^[\x21-\x7e]+$/.test(value);
}

function normalizeAccountFileUploadQuotaInput(input, operation, clock) {
  const instanceInput = input?.instance && typeof input.instance === 'object' ? input.instance : {};
  const instanceId = trimString(instanceInput.instanceId);
  const publicKey = trimString(instanceInput.publicKey);
  const keyFingerprint = trimString(instanceInput.keyFingerprint);
  const accountId = trimString(input?.accountId);
  const requestId = trimString(input?.requestId);
  const quotaBatchId = trimString(input?.quotaBatchId);
  const sizeBytes = Number(input?.sizeBytes);
  const sha256 = trimString(input?.sha256).toLowerCase();
  const issuedAt = trimString(input?.issuedAt);
  const issuedMs = Date.parse(issuedAt);
  if (!isProtocolField(instanceId, { min: 8, max: 160 }) || !publicKey
    || !/^[a-f0-9]{64}$/.test(keyFingerprint) || !isProtocolField(accountId, { min: 8, max: 160 })
    || !isProtocolField(requestId, { min: 1, max: 200 })
    || !isProtocolField(quotaBatchId, { min: 1, max: 200 }) || !Number.isSafeInteger(sizeBytes)
    || sizeBytes <= 0 || !/^[a-f0-9]{64}$/.test(sha256)
    || !issuedMs || !isProtocolField(issuedAt, { min: 20, max: 64 })
    || trimString(input?.audience) !== 'agentoc-account-file-upload') {
    throw createError('account_file_upload_request_invalid', 'Invalid account file upload quota request.', 400);
  }
  if (Math.abs(clock() - issuedMs) > OWNER_AUTH_PROOF_SKEW_MS) {
    throw createError('owner_auth_proof_expired', 'Account file upload quota proof is expired.', 401);
  }
  if (createInstancePublicKeyFingerprint(publicKey) !== keyFingerprint) {
    throw createError('owner_auth_instance_invalid', 'Instance key fingerprint does not match.', 401);
  }
  const message = buildAccountFileUploadQuotaMessage({ instanceId, accountId, operation, requestId,
    quotaBatchId, sizeBytes, sha256, issuedAt });
  if (!verifyInstanceProofSignature({ publicKey, message, signature: input?.signature })) {
    throw createError('owner_auth_proof_invalid', 'Invalid account file upload quota signature.', 401);
  }
  return { instance: { instanceId, publicKey, keyFingerprint }, accountId, requestId, quotaBatchId, sizeBytes, sha256 };
}

function hasCredentialScope(credential, scope) {
  return trimString(credential?.scope).split(/\s+/).includes(scope);
}

// The Accounts page is a top-level navigation. Browsers may retry or restore
// that GET after the first response, so the same bootstrap must be able to
// reconstruct the same desktop handoff without storing bearer values in the
// durable transaction record. A different bootstrap still fails closed.
export function deriveDesktopReplayValues({ transactionId, bootstrap, deliveryMode = 'browser_callback' } = {}) {
  const txId = trimString(transactionId);
  const secret = trimString(bootstrap);
  if (!txId || !secret) return { desktopState: '', phoneTicket: '', deliveryGrant: '' };
  const derive = (kind, prefix) => `${prefix}_${createHash('sha256')
    .update(`agentoc-owner-auth-desktop-v2\n${kind}\n${txId}\n${secret}`)
    .digest('base64url')}`;
  return {
    desktopState: derive('desktop-state', 'state'),
    phoneTicket: derive('phone-ticket', 'opt'),
    deliveryGrant: deliveryMode === 'instance_poll' ? '' : derive('delivery-grant', 'grant'),
  };
}

function createError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizePurpose(value) {
  const purpose = trimString(value);
  return ['bind', 'login'].includes(purpose) ? purpose : '';
}

function normalizeDeliveryMode(value) {
  const mode = trimString(value);
  return DELIVERY_MODES.has(mode) ? mode : '';
}

const NATIVE_OWNER_AUTH_AUDIENCE = 'agentoc-owner-auth-native';
const NATIVE_OWNER_AUTH_PROOF_SKEW_MS = 2 * 60 * 1000;

function normalizeReturnUrl(value, { allowInsecure = false } = {}) {
  try {
    const parsed = new URL(trimString(value));
    if (parsed.username || parsed.password || parsed.hash) return '';
    if (parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:')) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function getTransactions(draft) {
  if (!Array.isArray(draft.ownerAuthTransactions)) draft.ownerAuthTransactions = [];
  return draft.ownerAuthTransactions;
}

function pruneTransactions(draft, now) {
  const cutoff = now - OWNER_AUTH_TRANSACTION_TTL_MS;
  draft.ownerAuthTransactions = getTransactions(draft).filter(
    (item) => Number.isFinite(Date.parse(item?.createdAt || '')) && Date.parse(item.createdAt) > cutoff
      && Number.isFinite(Date.parse(item?.expiresAt || '')) && Date.parse(item.expiresAt) > now,
  );
  return draft.ownerAuthTransactions;
}

function getInstanceBindings(draft) {
  if (!Array.isArray(draft.instanceBindings)) draft.instanceBindings = [];
  return draft.instanceBindings;
}

// Endpoint publication is optional.  A computer is rendezvous-discoverable
// when its persisted instance key can still be verified independently of any
// network address.
function hasRendezvousIdentity(binding) {
  const publicKey = trimString(binding?.instancePublicKey);
  const keyFingerprint = trimString(binding?.instanceKeyFingerprint);
  if (!publicKey || !/^[a-f0-9]{64}$/.test(keyFingerprint)) return false;
  try {
    return createInstancePublicKeyFingerprint(publicKey) === keyFingerprint;
  } catch {
    return false;
  }
}

function getDevices(draft) {
  if (!Array.isArray(draft.devices)) draft.devices = [];
  return draft.devices;
}

function getBindingHistory(draft) {
  if (!Array.isArray(draft.bindingHistory)) draft.bindingHistory = [];
  return draft.bindingHistory;
}

function getNativeAuthRequests(draft) {
  if (!Array.isArray(draft.nativeAuthRequests)) draft.nativeAuthRequests = [];
  return draft.nativeAuthRequests;
}

function getAccountJoinIntents(draft) {
  if (!Array.isArray(draft.accountJoinIntents)) draft.accountJoinIntents = [];
  return draft.accountJoinIntents;
}

function getAccountFileUploads(draft) {
  if (!Array.isArray(draft.accountFileUploads)) draft.accountFileUploads = [];
  return draft.accountFileUploads;
}

function accountFileUploadUsage(draft, accountId, quotaBatchId, nowMs) {
  let usedBytes = 0;
  let reservedBytes = 0;
  for (const item of getAccountFileUploads(draft)) {
    if (item.accountId !== accountId || item.quotaBatchId !== quotaBatchId) continue;
    if (item.status === 'committed') usedBytes += Number(item.sizeBytes) || 0;
    else if (item.status === 'reserved' && Date.parse(item.reservedUntil || '') > nowMs) reservedBytes += Number(item.sizeBytes) || 0;
  }
  if (!Number.isSafeInteger(usedBytes) || !Number.isSafeInteger(reservedBytes)) {
    throw createError('account_file_usage_unavailable', 'Account file usage is invalid.', 503);
  }
  return { usedBytes, reservedBytes };
}

function publicRendezvousIntent(intent) {
  return {
    intentId: intent.intentId,
    instanceId: intent.instanceId,
    instance: intent.instance,
    instancePublicKey: intent.instance?.publicKey || '',
    instanceKeyFingerprint: intent.instance?.keyFingerprint || '',
    deviceId: intent.deviceId,
    devicePublicKey: intent.devicePublicKey,
    devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint,
    deviceName: intent.deviceAlias || 'Android device',
    computerAlias: normalizeDeviceAlias(intent.computerAlias),
    platform: intent.platform || 'android',
    publicEndpoint: intent.publicEndpoint || '',
    nonce: intent.nonce || intent.rendezvousNonce || '',
    issuedAt: intent.issuedAt,
    expiresAt: intent.expiresAt,
    status: intent.status,
    requestId: intent.rendezvousRequestId || '',
    accountClaimTokenHash: intent.accountClaimTokenHash || '',
  };
}

function publicRendezvousResult(intent) {
  return {
    requestId: intent.rendezvousRequestId || '',
    intentId: intent.intentId,
    status: intent.status,
    result: intent.rendezvousResult || null,
    expiresAt: intent.expiresAt,
  };
}

function getAccountDevices(draft) {
  if (!Array.isArray(draft.accountDevices)) draft.accountDevices = [];
  return draft.accountDevices;
}

function getAccountDeviceKeys(draft) {
  if (!Array.isArray(draft.accountDeviceKeys)) draft.accountDeviceKeys = [];
  return draft.accountDeviceKeys;
}

function getAccountCredentials(draft) {
  if (!Array.isArray(draft.accountCredentials)) draft.accountCredentials = [];
  return draft.accountCredentials;
}

function getAccountSessionChallenges(draft) {
  if (!Array.isArray(draft.accountSessionChallenges)) draft.accountSessionChallenges = [];
  return draft.accountSessionChallenges;
}

function getAccountCredentialRefreshes(draft) {
  if (!Array.isArray(draft.accountCredentialRefreshes)) draft.accountCredentialRefreshes = [];
  return draft.accountCredentialRefreshes;
}

function getAccountJoinGrants(draft) {
  if (!Array.isArray(draft.accountJoinGrants)) draft.accountJoinGrants = [];
  return draft.accountJoinGrants;
}

// The completed intent remains the durable phone-to-target authorization link.
// Its cached credential/bootstrap response is unusable after the intent's own
// expiry (all result/completion endpoints reject that boundary).
export function pruneExpiredRendezvousResults(intents, nowMs) {
  if (!Array.isArray(intents) || !Number.isFinite(nowMs)) throw new TypeError('Invalid rendezvous retention input');
  let cleared = 0;
  for (const intent of intents) {
    if (!intent || intent.rendezvousResult == null) continue;
    const expiresMs = Date.parse(intent.expiresAt || '');
    if (!Number.isFinite(expiresMs) || expiresMs > nowMs) continue;
    intent.rendezvousResult = null;
    cleared++;
  }
  return cleared;
}

function pruneAccountSessionRecords(draft, nowMs) {
  pruneExpiredRendezvousResults(getAccountJoinIntents(draft), nowMs);
  draft.accountSessionChallenges = getAccountSessionChallenges(draft).filter((item) => {
    const expiresMs = Date.parse(item?.expiresAt || '');
    return Number.isFinite(expiresMs) && expiresMs > nowMs;
  });
  draft.accountCredentialRefreshes = getAccountCredentialRefreshes(draft).filter((item) => {
    const createdMs = Date.parse(item?.createdAt || '');
    return Number.isFinite(createdMs) && createdMs > nowMs - ACCOUNT_CREDENTIAL_REFRESH_RETENTION_MS;
  });
  // Keep redeemed/expired grants briefly for idempotent target completion, but
  // do not let the table become an unbounded activity log.
  draft.accountJoinGrants = getAccountJoinGrants(draft).filter((item) => {
    const expiresMs = Date.parse(item?.expiresAt || '');
    return Number.isFinite(expiresMs) && expiresMs > nowMs - OWNER_AUTH_TRANSACTION_TTL_MS;
  });
}

function getAccountSyncCatalog(draft) {
  if (!Array.isArray(draft.accountSyncCatalog)) draft.accountSyncCatalog = [];
  return draft.accountSyncCatalog;
}

function registeredDeviceCount(draft, accountId, deviceKind) {
  if (deviceKind === 'computer') {
    return getInstanceBindings(draft).filter((item) => item.accountId === accountId && !item.revokedAt).length;
  }
  return getDevices(draft).filter((item) => item.accountId === accountId
    && !item.unboundAt
    && effectiveDeviceKind(item) === deviceKind).length;
}

function activeAccountPhoneSessionIds(draft, accountId, nowMs) {
  const devices = new Map(getAccountDevices(draft)
    .filter((item) => item.accountId === accountId && !item.revokedAt && !item.unboundAt)
    .map((item) => [item.deviceId, item]));
  const keys = new Map(getAccountDeviceKeys(draft)
    .filter((item) => item.accountId === accountId && !item.revokedAt)
    .map((item) => [item.keyId, item]));
  const active = new Set();
  for (const credential of getAccountCredentials(draft)) {
    const expiresAt = Date.parse(credential?.expiresAt || '');
    if (credential?.accountId !== accountId || credential.revokedAt || !hasCredentialScope(credential, 'account-directory')
      || !Number.isFinite(expiresAt) || expiresAt <= nowMs) continue;
    const device = devices.get(credential.deviceId);
    const key = keys.get(credential.keyId);
    if (!device || !key || key.accountId !== accountId || key.deviceId !== device.deviceId) continue;
    active.add(device.deviceId);
  }
  return active;
}

function releaseInactiveAccountPhoneLeases(draft, accountId, nowMs) {
  const activePhones = activeAccountPhoneSessionIds(draft, accountId, nowMs);
  const links = completedTurnPhoneLinks(draft, accountId);
  let released = 0;
  for (const lease of getTurnConnectionLeases(draft)) {
    if (lease.accountId !== accountId || effectiveDeviceKind(lease) !== 'phone'
      || !isActiveTurnConnectionLease(lease, nowMs)) continue;
    let phoneId = trimString(lease.quotaDeviceId);
    if (!/^adev_[A-Za-z0-9_-]+$/.test(phoneId)) {
      const linkedIds = new Set((links.get(JSON.stringify([lease.instanceId, lease.deviceId])) || []).map((link) => link.phoneId));
      if (linkedIds.size !== 1) continue;
      phoneId = [...linkedIds][0];
    }
    if (activePhones.has(phoneId)) continue;
    const now = new Date(Math.max(nowMs, turnLeaseObservedAt(lease))).toISOString();
    Object.assign(lease, { status: 'released', updatedAt: now, releasedAt: now, releaseReason: 'account-session-inactive' });
    released++;
  }
  return released;
}

function activeAccountTurnConnectionState(draft, accountId, nowMs, options = {}) {
  releaseInactiveAccountPhoneLeases(draft, accountId, nowMs);
  return activeTurnConnectionState(draft, accountId, nowMs, options);
}

function entitlementClaims(draft, accountId, nowMs, deviceKind = '', resolveEntitlement = resolveAccountEntitlement) {
  const entitlement = resolveEntitlement(draft, accountId, nowMs);
  return {
    plan: entitlement.plan,
    limits: entitlement.limits,
    ...(deviceKind ? { deviceKind } : {}),
    ...(entitlement.expiresAt ? { planExpiresAt: entitlement.expiresAt } : {}),
  };
}

function normalizeDeviceAlias(value) {
  return trimString(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 64);
}

function publicEndpointFromReturnUrl(value, { allowInsecure = false } = {}) {
  try {
    const parsed = new URL(trimString(value));
    if ((parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:'))
      || parsed.username || parsed.password || parsed.hash) return '';
    const suffix = '/api/auth/google/complete';
    if (!parsed.pathname.endsWith(suffix)) return '';
    parsed.pathname = parsed.pathname.slice(0, -suffix.length).replace(/\/+$/, '');
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

// A claimed instance may publish its canonical endpoint in its signed join
// intent.  This is intentionally stricter than the local QR invitation URL:
// Accounts will later return it from the cross-device directory, so only a
// clean HTTPS origin (or an HTTPS origin with a configured base path) is safe
// to retain there.
function normalizeClaimPublicEndpoint(value) {
  try {
    const parsed = new URL(trimString(value));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) return '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

// Re-enrollment is new authority from a signed-in phone and a fresh local QR.
// A revoked binding, another account/key, or an old intent alone is insufficient.
function accountBindingTime(value) { return value instanceof Date ? value.getTime() : Date.parse(value); }
function freshAccountQrReenrollment(binding, intent, accountId, now) {
  return Boolean(binding?.revokedAt && binding.accountId === accountId
    && /^[a-f0-9]{64}$/.test(trimString(intent?.accountClaimTokenHash))
    && trimString(binding.instancePublicKey) && trimString(binding.instanceKeyFingerprint)
    && trimString(binding.instancePublicKey) === trimString(intent?.instance?.publicKey)
    && binding.instanceKeyFingerprint === intent?.instance?.keyFingerprint
    && accountBindingTime(intent.createdAt) > accountBindingTime(binding.revokedAt)
    && accountBindingTime(intent.expiresAt) > now);
}

function upsertInstanceBinding(draft, {
  instanceId,
  accountId,
  provider,
  deviceAlias,
  instancePublicKey = '',
  instanceKeyFingerprint = '',
  publicEndpoint = '',
  now,
}) {
  const bindings = getInstanceBindings(draft);
  const existing = bindings.find((item) => item.instanceId === instanceId);
  if (existing) {
    existing.accountId = accountId;
    existing.provider = provider;
    existing.deviceAlias = deviceAlias;
    if (instancePublicKey) existing.instancePublicKey = instancePublicKey;
    if (instanceKeyFingerprint) existing.instanceKeyFingerprint = instanceKeyFingerprint;
    if (publicEndpoint) existing.publicEndpoint = publicEndpoint;
    existing.boundAt = now;
    existing.lastSeenAt = now;
    existing.revokedAt = '';
  } else {
    bindings.push({
      instanceId,
      accountId,
      provider,
      deviceAlias,
      ...(instancePublicKey ? { instancePublicKey } : {}),
      ...(instanceKeyFingerprint ? { instanceKeyFingerprint } : {}),
      publicEndpoint,
      boundAt: now,
      lastSeenAt: now,
      revokedAt: '',
    });
  }
}

function upsertDevice(draft, {
  deviceId,
  instanceId,
  accountId,
  alias,
  devicePublicKeyFingerprint = '',
  deviceKind = '',
  now,
}) {
  const devices = getDevices(draft);
  const existing = devices.find((item) => item.deviceId === deviceId);
  if (existing) {
    existing.instanceId = instanceId;
    existing.accountId = accountId;
    if (alias !== undefined) existing.alias = alias;
    if (devicePublicKeyFingerprint) existing.devicePublicKeyFingerprint = devicePublicKeyFingerprint;
    if (deviceKind) existing.deviceKind = deviceKind;
    existing.lastSeenAt = now;
    existing.unboundAt = '';
  } else {
    devices.push({
      deviceId,
      instanceId,
      accountId,
      alias: alias || '',
      devicePublicKeyFingerprint,
      deviceKind,
      lastSeenAt: now,
      unboundAt: '',
      createdAt: now,
    });
  }
}

function recordBindingEvent(draft, { instanceId, accountId, action, now }) {
  getBindingHistory(draft).push({ instanceId, accountId, action, occurredAt: now });
}

// bind 完成 → 记录实例绑定/设备/历史；login 完成 → 只刷新设备 lastSeenAt。
function recordCompletedBinding(draft, record, accountId, clock, { allowInsecureReturnUrl = false } = {}) {
  const now = nowIso(clock);
  const alias = normalizeDeviceAlias(record.alias);
  if (record.purpose === 'bind') {
    upsertInstanceBinding(draft, {
      instanceId: record.instance.instanceId,
      accountId,
      provider: (draft.accounts || []).find(account => account.accountId === accountId)?.provider || 'google',
      deviceAlias: alias,
      instancePublicKey: record.instance.publicKey,
      instanceKeyFingerprint: record.instance.keyFingerprint,
      publicEndpoint: publicEndpointFromReturnUrl(record.returnUrl, { allowInsecure: allowInsecureReturnUrl }),
      now,
    });
    upsertDevice(draft, {
      deviceId: record.instance.instanceId,
      instanceId: record.instance.instanceId,
      accountId,
      alias,
      deviceKind: 'computer',
      now,
    });
    recordBindingEvent(draft, { instanceId: record.instance.instanceId, accountId, action: 'bind', now });
  } else {
    upsertDevice(draft, {
      deviceId: record.instance.instanceId,
      instanceId: record.instance.instanceId,
      accountId,
      deviceKind: 'computer',
      now,
    });
  }
}

function validateNativeInstance(input, { requestId, purpose, deviceId, deviceAlias, clock, rollback = false }) {
  const instance = input?.instance && typeof input.instance === 'object' ? input.instance : {};
  const instanceId = trimString(instance.instanceId);
  const algorithm = trimString(instance.algorithm).toLowerCase();
  const publicKey = trimString(instance.publicKey);
  const keyFingerprint = trimString(instance.keyFingerprint);
  const devicePublicKeyFingerprint = trimString(input?.device?.devicePublicKeyFingerprint);
  const issuedAt = trimString(input?.issuedAt);
  const issuedMs = Date.parse(issuedAt);
  const audience = trimString(input?.audience);
  if (!instanceId || !publicKey || !keyFingerprint || !requestId || !deviceId
    || !/^[a-f0-9]{64}$/.test(devicePublicKeyFingerprint) || !issuedMs
    || audience !== (rollback ? 'agentoc-owner-auth-native-rollback' : NATIVE_OWNER_AUTH_AUDIENCE)) {
    throw createError('owner_auth_native_request_invalid', 'Invalid native owner authentication request.', 400);
  }
  if (Math.abs(clock() - issuedMs) > NATIVE_OWNER_AUTH_PROOF_SKEW_MS) {
    throw createError('owner_auth_proof_expired', 'Native instance proof is expired.', 401);
  }
  if (createInstancePublicKeyFingerprint(publicKey) !== keyFingerprint) {
    throw createError('owner_auth_instance_invalid', 'Instance key fingerprint does not match.', 401);
  }
  const accountId = trimString(input?.accountId), expectedRevision = input?.expectedRevision,
    expectedCompletionId = input?.expectedCompletionId;
  if (rollback && (!accountId || accountId.length > 160 || typeof expectedRevision !== 'string'
    || !/^[1-9][0-9]{0,18}$/.test(expectedRevision) || BigInt(expectedRevision) > 9223372036854775807n
    || typeof expectedCompletionId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(expectedCompletionId)
    || BigInt(expectedCompletionId) > 9223372036854775807n)) {
    throw createError('owner_auth_native_request_invalid', 'Original account and binding revision are required.', 400);
  }
  const message = (rollback ? buildNativeOwnerAuthRollbackMessage : buildNativeOwnerAuthMessage)({
    instanceId,
    requestId,
    purpose,
    deviceId,
    devicePublicKeyFingerprint,
    deviceAlias,
    issuedAt,
    audience,
    ...(rollback ? { accountId, expectedRevision, expectedCompletionId } : {}),
  });
  if (!verifyInstanceProofSignature({ publicKey, message, signature: input?.signature })) {
    throw createError('owner_auth_proof_invalid', 'Invalid native instance proof.', 401);
  }
  return { instanceId, publicKey, keyFingerprint, devicePublicKeyFingerprint };
}

function validateAccountJoinInstance(input, { intentId, deviceId, devicePublicKeyFingerprint, nonce, clock }) {
  const instance = input?.instance && typeof input.instance === 'object' ? input.instance : {};
  const instanceId = trimString(instance.instanceId);
  const publicKey = trimString(instance.publicKey);
  const keyFingerprint = trimString(instance.keyFingerprint);
  const issuedAt = trimString(input?.issuedAt);
  const issuedMs = Date.parse(issuedAt);
  const audience = trimString(input?.audience);
  const requestedPublicEndpoint = trimString(input?.publicEndpoint);
  const publicEndpoint = normalizeClaimPublicEndpoint(requestedPublicEndpoint);
  if (!isProtocolField(instanceId, { min: 8, max: 160 }) || !publicKey || !/^[a-f0-9]{64}$/.test(keyFingerprint)
    || !isProtocolField(intentId, { min: 8, max: 128 }) || !isProtocolField(deviceId, { min: 8, max: 160 })
    || !/^[a-f0-9]{64}$/.test(devicePublicKeyFingerprint) || !trimString(nonce) || !issuedMs
    || !isProtocolField(nonce, { min: 16, max: 256 }) || !isProtocolField(issuedAt, { min: 20, max: 64 })
    || audience !== 'agentoc-account-join' || (requestedPublicEndpoint && !publicEndpoint)) {
    throw createError('owner_auth_native_request_invalid', 'Invalid account join intent proof.', 400);
  }
  if (Math.abs(clock() - issuedMs) > NATIVE_OWNER_AUTH_PROOF_SKEW_MS) {
    throw createError('owner_auth_proof_expired', 'Account join intent proof is expired.', 401);
  }
  if (createInstancePublicKeyFingerprint(publicKey) !== keyFingerprint) {
    throw createError('owner_auth_instance_invalid', 'Instance key fingerprint does not match.', 401);
  }
  const message = buildAccountJoinIntentProofMessage({
    instanceId,
    intentId,
    deviceId,
    devicePublicKeyFingerprint,
    nonce,
    issuedAt,
    audience,
    publicEndpoint,
  });
  if (!verifyInstanceProofSignature({ publicKey, message, signature: input?.signature })) {
    throw createError('owner_auth_proof_invalid', 'Invalid account join intent proof.', 401);
  }
  return { instanceId, publicKey, keyFingerprint, devicePublicKeyFingerprint, issuedAt, publicEndpoint };
}

function publicTransaction(record) {
  return {
    transactionId: record.id,
    purpose: record.purpose,
    nonce: record.nonce,
    expiresAt: record.expiresAt,
  };
}

function validateInstance(input, { transactionId, purpose, returnUrl, clock, audience = '' }) {
  const instance = input?.instance && typeof input.instance === 'object' ? input.instance : {};
  const instanceId = trimString(instance.instanceId);
  const publicKey = trimString(instance.publicKey);
  const keyFingerprint = trimString(instance.keyFingerprint);
  const issuedAt = trimString(input?.issuedAt);
  const issuedMs = Date.parse(issuedAt);
  if (!instanceId || !publicKey || !keyFingerprint || !issuedMs) {
    throw createError('owner_auth_instance_invalid', 'Missing instance proof material.');
  }
  if (Math.abs(clock() - issuedMs) > OWNER_AUTH_PROOF_SKEW_MS) {
    throw createError('owner_auth_proof_expired', 'Instance proof is expired.', 401);
  }
  if (createInstancePublicKeyFingerprint(publicKey) !== keyFingerprint) {
    throw createError('owner_auth_instance_invalid', 'Instance key fingerprint does not match.', 401);
  }
  const message = buildInstanceProofMessage({
    instanceId,
    transactionId,
    purpose,
    returnUrl,
    issuedAt,
    audience: audience || trimString(input?.audience) || 'agentoc-owner-auth',
  });
  if (!verifyInstanceProofSignature({ publicKey, message, signature: input?.signature })) {
    throw createError('owner_auth_proof_invalid', 'Invalid instance proof.', 401);
  }
  return { instanceId, publicKey, keyFingerprint };
}

function validateDeviceOpInstance(input, { transactionId, purpose, clock }) {
  const instance = input?.instance && typeof input.instance === 'object' ? input.instance : {};
  const instanceId = trimString(instance.instanceId);
  const publicKey = trimString(instance.publicKey);
  const keyFingerprint = trimString(instance.keyFingerprint);
  const issuedAt = trimString(input?.issuedAt);
  const issuedMs = Date.parse(issuedAt);
  const audience = trimString(input?.audience);
  const requestedPublicEndpoint = trimString(input?.publicEndpoint);
  const publicEndpoint = normalizeClaimPublicEndpoint(requestedPublicEndpoint);
  const endpointMatchesCanonical = requestedPublicEndpoint === publicEndpoint;
  if (!instanceId || !publicKey || !keyFingerprint || !trimString(transactionId)
    || !['devices', 'history', 'unbind', 'publish-endpoint', 'publish-identity', 'turn-reserve', 'turn-release', 'turn-handoff-commit'].includes(purpose)
    || !issuedMs || audience !== 'agentoc-owner-auth-device') {
    throw createError('owner_auth_request_invalid', 'Invalid device management request.', 400);
  }
  if (purpose === 'publish-endpoint' && (!requestedPublicEndpoint || !endpointMatchesCanonical)) {
    throw createError('owner_auth_endpoint_invalid', 'A canonical HTTPS public endpoint is required.', 400);
  }
  if (purpose !== 'publish-endpoint' && requestedPublicEndpoint) {
    throw createError('owner_auth_request_invalid', 'Unexpected public endpoint.', 400);
  }
  if (Math.abs(clock() - issuedMs) > OWNER_AUTH_PROOF_SKEW_MS) {
    throw createError('owner_auth_proof_expired', 'Instance proof is expired.', 401);
  }
  if (createInstancePublicKeyFingerprint(publicKey) !== keyFingerprint) {
    throw createError('owner_auth_instance_invalid', 'Instance key fingerprint does not match.', 401);
  }
  const message = buildOwnerAuthDeviceMessage({
    instanceId,
    transactionId,
    purpose,
    issuedAt,
    publicEndpoint,
    audience,
  });
  if (!verifyInstanceProofSignature({ publicKey, message, signature: input?.signature })) {
    throw createError('owner_auth_proof_invalid', 'Invalid device management proof.', 401);
  }
  return { instanceId, publicKey, keyFingerprint, publicEndpoint };
}

function validateProviderSyncPeer(input, { requestId, targetInstanceId, clock }) {
  const instance = input?.instance && typeof input.instance === 'object' ? input.instance : {};
  const instanceId = trimString(instance.instanceId);
  const publicKey = trimString(instance.publicKey);
  const keyFingerprint = trimString(instance.keyFingerprint);
  const issuedAt = trimString(input?.issuedAt);
  const proofTargetInstanceId = trimString(input?.targetInstanceId);
  const proofRequestId = trimString(input?.requestId);
  const issuedMs = Date.parse(issuedAt);
  const audience = trimString(input?.audience);
  if (!instanceId || !publicKey || !keyFingerprint || !requestId || proofRequestId !== requestId
    || !targetInstanceId || proofTargetInstanceId !== targetInstanceId || !issuedMs
    || audience !== 'agentoc-provider-sync') {
    throw createError('provider_sync_auth_invalid', 'Invalid provider sync peer proof.', 400);
  }
  if (Math.abs(clock() - issuedMs) > OWNER_AUTH_PROOF_SKEW_MS) {
    throw createError('provider_sync_auth_expired', 'Provider sync peer proof is expired.', 401);
  }
  if (createInstancePublicKeyFingerprint(publicKey) !== keyFingerprint) {
    throw createError('provider_sync_auth_invalid', 'Provider sync instance key fingerprint does not match.', 401);
  }
  const message = buildProviderSyncPeerMessage({
    instanceId,
    requestId,
    targetInstanceId,
    issuedAt,
    audience,
  });
  if (!verifyInstanceProofSignature({ publicKey, message, signature: input?.signature })) {
    throw createError('provider_sync_auth_invalid', 'Invalid provider sync peer signature.', 401);
  }
  return { instanceId, publicKey, keyFingerprint, issuedAt };
}

function validateAccountSyncCatalogPublisher(input, { accountId, clock }) {
  const requestId = trimString(input?.requestId || input?.sourceProof?.requestId);
  const targetInstanceId = `account:${accountId}`;
  const instance = input?.sourceProof?.instance && typeof input.sourceProof.instance === 'object'
    ? input.sourceProof.instance
    : {};
  const instanceId = trimString(instance.instanceId);
  const publicKey = trimString(instance.publicKey);
  const keyFingerprint = trimString(instance.keyFingerprint);
  const issuedAt = trimString(input?.sourceProof?.issuedAt);
  const issuedMs = Date.parse(issuedAt);
  const audience = trimString(input?.sourceProof?.audience);
  const proofRequestId = trimString(input?.sourceProof?.requestId);
  const proofTargetInstanceId = trimString(input?.sourceProof?.targetInstanceId);
  if (!instanceId || !publicKey || !keyFingerprint || !requestId || proofRequestId !== requestId
    || proofTargetInstanceId !== targetInstanceId || !issuedMs || audience !== 'agentoc-account-sync-catalog') {
    throw createError('account_sync_auth_invalid', 'Invalid account sync catalog proof.', 400);
  }
  if (Math.abs(clock() - issuedMs) > OWNER_AUTH_PROOF_SKEW_MS) {
    throw createError('account_sync_auth_expired', 'Account sync catalog proof is expired.', 401);
  }
  if (createInstancePublicKeyFingerprint(publicKey) !== keyFingerprint) {
    throw createError('account_sync_auth_invalid', 'Account sync instance key fingerprint does not match.', 401);
  }
  const message = buildProviderSyncPeerMessage({
    instanceId,
    requestId,
    targetInstanceId,
    issuedAt,
    audience,
  });
  if (!verifyInstanceProofSignature({
    publicKey,
    message,
    signature: input?.sourceProof?.signature,
  })) {
    throw createError('account_sync_auth_invalid', 'Invalid account sync catalog signature.', 401);
  }
  return { instanceId, publicKey, keyFingerprint };
}

// instance_poll 领取 proof：canonical message 绑定 requestId、deliveryMode 与
// 请求路径，不复用含 returnUrl 的浏览器回调消息。校验顺序按契约 §5 fail closed。
function validatePollProof(input, { record, requestPath, clock }) {
  const instance = input?.instance && typeof input.instance === 'object' ? input.instance : {};
  const instanceId = trimString(instance.instanceId);
  const algorithm = trimString(instance.algorithm).toLowerCase();
  const publicKey = trimString(instance.publicKey);
  const keyFingerprint = trimString(instance.keyFingerprint);
  const requestId = trimString(input?.requestId);
  const purpose = normalizePurpose(input?.purpose);
  const deliveryMode = normalizeDeliveryMode(input?.deliveryMode);
  const issuedAt = trimString(input?.issuedAt);
  const issuedMs = Date.parse(issuedAt);
  const audience = trimString(input?.audience);
  if (!instanceId || algorithm !== 'ed25519' || !publicKey || !keyFingerprint || !requestId || !purpose || !issuedMs) {
    throw createError('owner_auth_request_invalid', 'Invalid instance poll redeem request.', 400);
  }
  if (audience !== OWNER_AUTH_POLL_AUDIENCE
    || purpose !== record.purpose
    || deliveryMode !== 'instance_poll'
    || deliveryMode !== (normalizeDeliveryMode(record.deliveryMode) || 'browser_callback')) {
    throw createError('owner_auth_request_invalid', 'Instance poll redeem context does not match the transaction.', 400);
  }
  if (Math.abs(clock() - issuedMs) > OWNER_AUTH_PROOF_SKEW_MS) {
    throw createError('owner_auth_proof_expired', 'Instance poll proof is expired.', 401);
  }
  if (createInstancePublicKeyFingerprint(publicKey) !== keyFingerprint) {
    throw createError('owner_auth_instance_invalid', 'Instance key fingerprint does not match.', 401);
  }
  const message = buildOwnerAuthPollMessage({
    instanceId,
    transactionId: record.id,
    requestId,
    purpose,
    deliveryMode,
    issuedAt,
    requestPath,
    audience,
  });
  if (!verifyInstanceProofSignature({ publicKey, message, signature: input?.signature })) {
    throw createError('owner_auth_proof_invalid', 'Invalid instance poll proof.', 401);
  }
  if (instanceId !== record.instance.instanceId || keyFingerprint !== record.instance.keyFingerprint) {
    throw createError('owner_auth_instance_mismatch', 'Poll grant belongs to a different instance.', 403);
  }
  return { instanceId, requestId };
}

// store 只需提供 mutate(async draft => result)，方便接到 file store 或 PostgreSQL store。
// verifyGoogleCredential({ idToken, nonce }) 必须完成 Google ID token 签名/aud/iss/exp 验证，
// resolveAccount({ draft, googleIdentity }) 需返回稳定的 Accounts accountId。
export function createOwnerAuthBroker({
  store,
  verifyGoogleCredential,
  verifyNativeGoogleCredential = verifyGoogleCredential,
  demoAccountAuth = null,
  resolveEntitlement = resolveAccountEntitlement,
  resolveAccount: resolveAccountImpl,
  signAssertion,
  signTurnBrokerCapability,
  clock = () => Date.now(),
  allowInsecureReturnUrl = false,
  issuer = 'agentoc-accounts',
  audit = () => {},
  rendezvousResultWaiters = createRendezvousResultWaiters(),
} = {}) {
  if (!store?.mutate) throw new Error('Owner auth broker requires a mutable store');
  if (typeof verifyGoogleCredential !== 'function') throw new Error('Owner auth broker requires Google verification');
  if (typeof verifyNativeGoogleCredential !== 'function') throw new Error('Owner auth broker requires native Google verification');
  if (typeof resolveAccountImpl !== 'function') throw new Error('Owner auth broker requires account resolution');
  if (typeof signAssertion !== 'function') throw new Error('Owner auth broker requires assertion signing');
  const resolveAccount = async input => {
    const account = await resolveAccountImpl(input);
    assertAccountNotDeleting(input.draft, trimString(account?.accountId || account?.id));
    return account;
  };

  function authorityMutation(mutator, finalize) {
    if (typeof store.mutateWithAuthority === 'function') return store.mutateWithAuthority(mutator, finalize);
    if (typeof store.readInstanceAuthority === 'function') {
      throw createError('owner_auth_authority_unavailable', 'Binding authority finalization is unavailable.', 503);
    }
    // Development/file stores keep the legacy contract. They cannot advertise
    // the signed authority protocol or manufacture a revision for a client.
    return store.mutate(async draft => finalize(await mutator(draft), null, draft));
  }

  function authorityCompletion(kind, operationId, { instance, accountId, sourceNonce, deviceId = '', deviceFingerprint = '' }) {
    return { kind, operationId, instanceId: instance.instanceId, accountId, keyFingerprint: instance.keyFingerprint,
      sourceDigest: hashSecret(JSON.stringify(['agentoc-binding-completion-v1', kind, operationId,
        instance.instanceId, instance.keyFingerprint, accountId, sourceNonce, deviceId, deviceFingerprint])) };
  }

  async function finalizeBoundAssertion(pending, authority) {
    const revision = authority
      ? await authority[pending.fresh ? 'recordCompletion' : 'readCompletion'](pending.completion) : '';
    const completion = authority && pending.completion.kind === 'native'
      ? await authority.readCompletionIdentity(pending.completion) : null;
    const assertion = await signAssertion({ ...pending.claims, ...(revision ? { bindingAuthorityRevision: revision } : {}),
      ...(completion ? { nativeCompletionId: completion.completionId } : {}) });
    return { assertion, ...pending.response };
  }

  function browserCompletion(record) {
    return authorityCompletion('browser', record.id, { instance: record.instance, accountId: record.accountId,
      sourceNonce: [record.nonce, record.bootstrapHash, record.purpose, record.deliveryMode || 'browser_callback', record.returnUrl || ''] });
  }

  function nativeCompletion(instance, accountId, requestId, deviceId, deviceFingerprint) {
    return authorityCompletion('native', requestId, { instance, accountId, sourceNonce: requestId, deviceId, deviceFingerprint });
  }

  async function finalizeBrowserCompletion(pending, authority) {
    if (authority) await authority.recordCompletion(pending.completion);
    return pending.response;
  }

  async function finalizePollAssertion(pending, authority, legacyDraft) {
    if (!pending.completion) return pending.response;
    const revision = authority ? await authority.readCompletion(pending.completion) : '';
    if (pending.cachedAssertion) return { assertion: pending.cachedAssertion, ...pending.response };
    const assertion = await signAssertion({ ...pending.claims, ...(revision ? { bindingAuthorityRevision: revision } : {}) });
    if (authority) await authority.cacheOwnerPollAssertion({ ...pending.cache, assertion });
    else getTransactions(legacyDraft).find(item => item.id === pending.cache.transactionId).pollAssertion = assertion;
    return { assertion, ...pending.response };
  }

  async function readBindingAuthority(input) {
    const instanceId = trimString(input?.instance?.instanceId), publicKey = trimString(input?.instance?.publicKey),
      keyFingerprint = trimString(input?.instance?.keyFingerprint), accountId = trimString(input?.accountId),
      requestId = trimString(input?.requestId), nonce = trimString(input?.nonce), issuedAt = trimString(input?.issuedAt),
      audience = trimString(input?.audience);
    if (![instanceId, accountId, requestId].every(value => isProtocolField(value, { min: 1, max: 160 }))
      || !isProtocolField(nonce, { min: 24, max: 128 }) || !/^[A-Za-z0-9_-]+$/.test(nonce)
      || !isProtocolField(issuedAt, { min: 20, max: 64 }) || !Number.isFinite(Date.parse(issuedAt))
      || audience !== 'agentoc-binding-authority' || !/^[a-f0-9]{64}$/.test(keyFingerprint) || !publicKey || publicKey.length > 4096) {
      throw createError('owner_auth_authority_request_invalid', 'Invalid binding authority request.', 400);
    }
    const nowSeconds = Math.floor(clock() / 1000);
    if (Math.abs(clock() - Date.parse(issuedAt)) > OWNER_AUTH_PROOF_SKEW_MS) {
      throw createError('owner_auth_proof_expired', 'Binding authority proof is expired.', 401);
    }
    let keyMatches = false;
    try { keyMatches = createInstancePublicKeyFingerprint(publicKey) === keyFingerprint; } catch {}
    if (!keyMatches || !verifyInstanceProofSignature({ publicKey,
      message: buildBindingAuthorityProofMessage({ instanceId, keyFingerprint, requestId, accountId, nonce, issuedAt, audience }),
      signature: input?.signature })) {
      throw createError('owner_auth_proof_invalid', 'Invalid binding authority proof.', 401);
    }
    if (typeof store.readInstanceAuthority !== 'function') {
      throw createError('owner_auth_authority_unavailable', 'Durable binding authority is unavailable.', 503);
    }
    // This one coherent read bypasses the snapshot mutation queue. No device
    // timestamp write or unsigned directory result can create this authority.
    const authority = await store.readInstanceAuthority(instanceId);
    const binding = authority?.binding, revision = authority?.revision;
    if (authority?.instanceId !== instanceId || (binding && binding.instanceId !== instanceId)
      || typeof revision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(revision)
      || BigInt(revision) > 9223372036854775807n || (binding && revision === '0')) {
      throw createError('owner_auth_authority_unavailable', 'Durable binding revision is unavailable.', 503);
    }
    const state = !binding ? 'missing'
      : binding.accountId !== accountId || binding.instanceKeyFingerprint !== keyFingerprint ? 'mismatch'
        : binding.revokedAt ? 'revoked' : 'active';
    const expiresAt = new Date((nowSeconds + 30) * 1000).toISOString();
    const claims = { iss: trimString(issuer) || 'agentoc-accounts', aud: instanceId, sub: accountId,
      purpose: 'binding_authority', tx: requestId, nonce, instanceKeyFingerprint: keyFingerprint,
      bindingAuthorityRevision: revision, bindingAuthorityState: state, authorityProtocol: 1,
      jti: makeId('authority'), iat: nowSeconds, exp: nowSeconds + 30 };
    const assertion = await signAssertion(claims);
    if (clock() >= (nowSeconds + 30) * 1000) {
      throw createError('owner_auth_authority_expired', 'Binding authority read expired before delivery.', 503);
    }
    return { assertion, expiresAt };
  }

  async function start(input) {
    const transactionId = trimString(input?.transactionId);
    const purpose = normalizePurpose(input?.purpose);
    // instance_poll 事务没有 returnUrl（实例不可公网访问）；browser_callback
    // 事务维持强制 returnUrl 校验。模式必须显式落在事务记录里。
    const requestedMode = normalizeDeliveryMode(input?.deliveryMode) || 'browser_callback';
    const returnUrl = requestedMode === 'browser_callback'
      ? normalizeReturnUrl(input?.returnUrl, { allowInsecure: allowInsecureReturnUrl })
      : '';
    if (!transactionId || !purpose || (requestedMode === 'browser_callback' && !returnUrl)) {
      throw createError('owner_auth_request_invalid', 'Invalid owner auth transaction request.');
    }
    const instance = validateInstance(input, {
      transactionId,
      purpose,
      returnUrl,
      clock,
      ...(requestedMode === 'instance_poll' ? { audience: OWNER_AUTH_POLL_AUDIENCE } : {}),
    });
    const deviceAlias = normalizeDeviceAlias(input?.alias);
    const bootstrap = makeId('ob');
    const nonce = makeId('nonce');
    const createdAt = nowIso(clock);
    const expiresAt = new Date(clock() + OWNER_AUTH_TRANSACTION_TTL_MS).toISOString();
    const result = await store.mutate(async (draft) => {
      const transactions = pruneTransactions(draft, clock());
      if (transactions.some((item) => item.id === transactionId)) {
        throw createError('owner_auth_transaction_exists', 'Owner auth transaction already exists.', 409);
      }
      transactions.push({
        id: transactionId,
        purpose,
        deliveryMode: requestedMode,
        ...(requestedMode === 'browser_callback' ? { returnUrl } : {}),
        instance,
        alias: deviceAlias,
        nonce,
        bootstrapHash: hashSecret(bootstrap),
        browserStartedAt: '',
        desktopStartedAt: '',
        desktopStateHash: '',
        phoneTicketHash: '',
        phoneStartedAt: '',
        phoneStateHash: '',
        completedAt: '',
        redeemedAt: '',
        grantHash: '',
        accountId: '',
        pollRedeemedAt: '',
        pollRequestId: '',
        pollAssertion: '',
        createdAt,
        expiresAt,
      });
      return { transactionId, bootstrap, expiresAt, deliveryMode: requestedMode };
    });
    audit({ event: 'transaction.created', transactionId, purpose, deliveryMode: requestedMode });
    return result;
  }

  async function beginBrowser({ transactionId, bootstrap, browserState }) {
    const txId = trimString(transactionId);
    const normalizedBrowserState = trimString(browserState);
    return store.mutate(async (draft) => {
      const record = pruneTransactions(draft, clock()).find((item) => item.id === txId);
      if (!record || !normalizedBrowserState || hashSecret(bootstrap) !== record.bootstrapHash) {
        throw createError('owner_auth_transaction_invalid', 'Invalid or expired owner auth transaction.', 410);
      }
      if (record.browserStartedAt) {
        throw createError('owner_auth_browser_replayed', 'Owner auth browser start was already used.', 409);
      }
      record.browserStartedAt = nowIso(clock);
      record.browserStateHash = hashSecret(normalizedBrowserState);
      return publicTransaction(record);
    });
  }

  // 电脑只作为结果接收端：同一 bootstrap 的桌面页打开可幂等恢复，手机
  // ticket 仍只允许被手机消费一次。ticket 是二维码/手动链接中的 bearer 值，
  // 落盘时只存摘要。
  async function beginDesktop({ transactionId, bootstrap, desktopState }) {
    const txId = trimString(transactionId);
    const normalizedDesktopState = trimString(desktopState);
    return store.mutate(async (draft) => {
      const record = pruneTransactions(draft, clock()).find((item) => item.id === txId);
      if (!record || !normalizedDesktopState || hashSecret(bootstrap) !== record.bootstrapHash) {
        throw createError('owner_auth_transaction_invalid', 'Invalid or expired owner auth transaction.', 410);
      }
      // instance_poll 事务不签发 delivery grant —— 结果由实例主动领取，浏览器
      // 永远拿不到任何可兑换材料（契约 §9 零凭据规则）。
      const pollMode = (normalizeDeliveryMode(record.deliveryMode) || 'browser_callback') === 'instance_poll';
      const replayValues = deriveDesktopReplayValues({
        transactionId: record.id,
        bootstrap,
        deliveryMode: record.deliveryMode,
      });
      if (!replayValues.desktopState || normalizedDesktopState !== replayValues.desktopState) {
        throw createError('owner_auth_desktop_state_invalid', 'Invalid or expired desktop sign-in state.', 410);
      }
      if (record.desktopStartedAt) {
        // Reopening the exact authorization URL is safe and idempotent: the
        // bootstrap is already the transaction bearer, and the derived
        // handoff values are never persisted in plaintext.
        if (record.phoneTicketHash !== hashSecret(replayValues.phoneTicket)
          || (!pollMode && record.grantHash !== hashSecret(replayValues.deliveryGrant))) {
          throw createError('owner_auth_desktop_replayed', 'Owner auth desktop start was already used.', 409);
        }
        return {
          ...publicTransaction(record),
          phoneTicket: replayValues.phoneTicket,
          ...(replayValues.deliveryGrant ? { deliveryGrant: replayValues.deliveryGrant } : {}),
        };
      }
      const phoneTicket = replayValues.phoneTicket;
      const deliveryGrant = replayValues.deliveryGrant;
      record.desktopStartedAt = nowIso(clock);
      record.desktopStateHash = hashSecret(normalizedDesktopState);
      record.phoneTicketHash = hashSecret(phoneTicket);
      // Grant 的明文只交给最初打开电脑接收页的浏览器；broker 持久化层仍只保留摘要。
      if (deliveryGrant) record.grantHash = hashSecret(deliveryGrant);
      return { ...publicTransaction(record), phoneTicket, ...(deliveryGrant ? { deliveryGrant } : {}) };
    });
  }

  // 手机 ticket 必须从已创建的电脑页面取得，且只允许启动一个手机授权页面。
  async function beginPhone({ transactionId, phoneTicket, phoneState }) {
    const txId = trimString(transactionId);
    const normalizedPhoneState = trimString(phoneState);
    const result = await store.mutate(async (draft) => {
      const record = pruneTransactions(draft, clock()).find((item) => item.id === txId);
      if (!record?.desktopStartedAt || !normalizedPhoneState || hashSecret(phoneTicket) !== record.phoneTicketHash) {
        throw createError('owner_auth_phone_ticket_invalid', 'Invalid or expired phone sign-in link.', 410);
      }
      if (record.completedAt || record.redeemedAt) {
        throw createError('owner_auth_phone_replayed', 'Phone sign-in link was already used.', 409);
      }
      if (record.phoneStartedAt) {
        if (record.phoneStateHash !== hashSecret(normalizedPhoneState)) {
          throw createError('owner_auth_phone_replayed', 'Phone sign-in link was already used.', 409);
        }
        return publicTransaction(record);
      }
      record.phoneStartedAt = nowIso(clock);
      record.phoneStateHash = hashSecret(normalizedPhoneState);
      return publicTransaction(record);
    });
    audit({ event: 'phone.session_started', transactionId: txId });
    return result;
  }

  async function completeGoogleCredential({ transactionId, idToken, browserState }) {
    const txId = trimString(transactionId);
    const normalizedBrowserState = trimString(browserState);
    const result = await authorityMutation(async (draft) => {
      const record = pruneTransactions(draft, clock()).find((item) => item.id === txId);
      if (!record?.browserStartedAt || hashSecret(normalizedBrowserState) !== record.browserStateHash) {
        throw createError('owner_auth_transaction_invalid', 'Invalid or expired owner auth transaction.', 410);
      }
      if (record.completedAt || record.redeemedAt) {
        throw createError('owner_auth_transaction_replayed', 'Owner auth transaction was already completed.', 409);
      }
      const googleIdentity = await verifyGoogleCredential({ idToken: trimString(idToken), nonce: record.nonce });
      const account = await resolveAccount({ draft, googleIdentity });
      const accountId = trimString(account?.accountId || account?.id);
      if (!accountId) throw createError('owner_auth_account_invalid', 'Unable to resolve Account identity.', 502);
      const grant = makeId('grant');
      record.accountId = accountId;
      recordCompletedBinding(draft, record, accountId, clock, { allowInsecureReturnUrl });
      record.grantHash = hashSecret(grant);
      record.completedAt = nowIso(clock);
      return { completion: browserCompletion(record), response: {
        returnUrl: record.returnUrl,
        transactionId: record.id,
        grant,
        expiresAt: record.expiresAt,
      } };
    }, finalizeBrowserCompletion);
    audit({ event: 'credential.completed', transactionId: txId, channel: 'desktop' });
    return result;
  }

  async function completePhoneDemoCredential(input) {
    if (!demoAccountAuth || demoAccountAuth.instanceAccess !== 'account') {
      throw createError('owner_auth_demo_unavailable', 'Demo instance sign-in is unavailable.', 403);
    }
    if (input?.idToken) throw createError('owner_auth_request_invalid', 'Mixed sign-in methods.', 400);
    const demoIdentity = await demoAccountAuth.verify({ username: input?.username, password: input?.password });
    return completePhoneCredential(input, { demoIdentity });
  }

  async function completePhoneGoogleCredential(input) {
    return completePhoneCredential(input);
  }

  async function completePhoneCredential({ transactionId, idToken, phoneState }, { demoIdentity = null } = {}) {
    const txId = trimString(transactionId);
    const normalizedPhoneState = trimString(phoneState);
    const result = await authorityMutation(async (draft) => {
      const record = pruneTransactions(draft, clock()).find((item) => item.id === txId);
      if (!record?.phoneStartedAt || hashSecret(normalizedPhoneState) !== record.phoneStateHash) {
        throw createError('owner_auth_phone_state_invalid', 'Invalid or expired phone sign-in state.', 410);
      }
      if (record.completedAt || record.redeemedAt) {
        throw createError('owner_auth_transaction_replayed', 'Owner auth transaction was already completed.', 409);
      }
      let accountId;
      if (demoIdentity) {
        accountId = demoIdentity.accountId;
        if (!Array.isArray(draft.accounts)) draft.accounts = [];
        if (!draft.accounts.some(account => account.accountId === accountId)) {
          draft.accounts.push({ accountId, provider: 'demo', providerSubject: demoIdentity.username, createdAt: nowIso(clock) });
        }
        demoAccountAuth.assertAccount(draft, accountId);
      } else {
        const googleIdentity = await verifyGoogleCredential({ idToken: trimString(idToken), nonce: record.nonce });
        const account = await resolveAccount({ draft, googleIdentity });
        accountId = trimString(account?.accountId || account?.id);
      }
      // grantHash 只属于 browser_callback（beginDesktop 签发）；poll 事务没有
      // grant，完成判定不依赖它。
      const requiresGrant = (normalizeDeliveryMode(record.deliveryMode) || 'browser_callback') === 'browser_callback';
      if (!accountId || (requiresGrant && !record.grantHash))
        throw createError('owner_auth_account_invalid', 'Unable to resolve Account identity.', 502);
      if (demoIdentity && record.purpose === 'bind') {
        const existing = getInstanceBindings(draft).find((binding) => binding.instanceId === record.instance.instanceId && !binding.revokedAt);
        if (existing && existing.accountId !== accountId) {
          throw createError('owner_auth_demo_binding_conflict', 'Test sign-in cannot replace an existing owner binding.', 409);
        }
      }
      record.accountId = accountId;
      recordCompletedBinding(draft, record, accountId, clock, { allowInsecureReturnUrl });
      record.completedAt = nowIso(clock);
      // 不把 grant 返回手机；只能由持有电脑 state cookie 的状态端点领取。
      return { completion: browserCompletion(record), response: { transactionId: record.id, expiresAt: record.expiresAt } };
    }, finalizeBrowserCompletion);
    audit({ event: 'credential.completed', transactionId: txId, channel: 'phone' });
    return result;
  }

  async function getDesktopStatus({ transactionId, desktopState }) {
    const txId = trimString(transactionId);
    const normalizedDesktopState = trimString(desktopState);
    return store.mutate(async (draft) => {
      const record = pruneTransactions(draft, clock()).find((item) => item.id === txId);
      if (!record?.desktopStartedAt || hashSecret(normalizedDesktopState) !== record.desktopStateHash) {
        throw createError('owner_auth_desktop_state_invalid', 'Invalid or expired desktop sign-in state.', 410);
      }
      const pollMode = (normalizeDeliveryMode(record.deliveryMode) || 'browser_callback') === 'instance_poll';
      if (!record.completedAt || record.redeemedAt) {
        return {
          status: 'pending',
          expiresAt: record.expiresAt,
          ...(pollMode ? { deliveryMode: 'instance_poll' } : {}),
        };
      }
      // poll 模式下浏览器只是等待页：不返回 returnUrl，也没有可领取的 grant。
      if (pollMode) {
        return { status: 'completed', expiresAt: record.expiresAt, deliveryMode: 'instance_poll' };
      }
      return {
        status: 'completed',
        transactionId: record.id,
        returnUrl: record.returnUrl,
        expiresAt: record.expiresAt,
      };
    });
  }

  async function redeem(input) {
    const transactionId = trimString(input?.transactionId);
    const grant = trimString(input?.grant);
    const result = await authorityMutation(async (draft) => {
      const record = pruneTransactions(draft, clock()).find((item) => item.id === transactionId);
      if (!record?.completedAt || record.redeemedAt || hashSecret(grant) !== record.grantHash) {
        throw createError('owner_auth_grant_invalid', 'Invalid or already redeemed owner auth grant.', 410);
      }
      const instance = validateInstance(input, {
        transactionId: record.id,
        purpose: record.purpose,
        returnUrl: record.returnUrl,
        clock,
      });
      if (
        instance.instanceId !== record.instance.instanceId ||
        instance.keyFingerprint !== record.instance.keyFingerprint
      ) {
        throw createError('owner_auth_instance_mismatch', 'Grant belongs to a different instance.', 403);
      }
      record.redeemedAt = nowIso(clock);
      const nowSeconds = Math.floor(clock() / 1000);
      const claims = {
        iss: trimString(issuer) || 'agentoc-accounts',
        aud: record.instance.instanceId,
        sub: record.accountId,
        provider: (draft.accounts || []).find(account => account.accountId === record.accountId)?.provider || 'google',
        ...entitlementClaims(draft, record.accountId, clock(), 'computer', resolveEntitlement),
        purpose: record.purpose,
        tx: record.id,
        jti: makeId('assertion'),
        iat: nowSeconds,
        exp: nowSeconds + 60,
      };
      return { fresh: false, completion: browserCompletion(record), claims,
        response: { expiresAt: new Date((nowSeconds + 60) * 1000).toISOString() } };
    }, finalizeBoundAssertion);
    audit({ event: 'assertion.redeemed', transactionId, purpose: trimString(input?.purpose) });
    return result;
  }

  // instance_poll 领取：只有创建事务的原实例能用独立 audience 的 proof 领取
  // 完成断言。pending 可重复返回；completed 在 60 秒保留窗口内按 requestId
  // 幂等重放同一断言。断言只出现在本方法的返回值中，不进入审计或日志。
  async function instanceRedeem(input, { requestPath = '' } = {}) {
    const transactionId = trimString(input?.transactionId);
    const result = await authorityMutation(async (draft) => {
      const record = pruneTransactions(draft, clock()).find((item) => item.id === transactionId);
      if (!record) {
        throw createError('owner_auth_transaction_invalid', 'Invalid or expired owner auth transaction.', 410);
      }
      const recordMode = normalizeDeliveryMode(record.deliveryMode) || 'browser_callback';
      if (recordMode !== 'instance_poll') {
        throw createError('owner_auth_delivery_mode_mismatch', 'Transaction is not delivered by instance polling.', 409);
      }
      const { requestId } = validatePollProof(input, { record, requestPath, clock });
      if (!record.completedAt) {
        return { response: {
          status: 'pending',
          expiresAt: record.expiresAt,
          retryAfterMs: OWNER_AUTH_POLL_RETRY_AFTER_MS,
        } };
      }
      if (record.pollRedeemedAt && record.pollRequestId && record.pollRequestId !== requestId) {
        throw createError('owner_auth_request_id_conflict', 'Transaction was already claimed by another request.', 409);
      }
      if (record.pollAssertion) {
        const expiresMs = Date.parse(record.pollExpiresAt || '');
        if (Number.isFinite(expiresMs) && expiresMs > clock()) {
          return { completion: browserCompletion(record), cachedAssertion: record.pollAssertion,
            response: { status: 'completed', expiresAt: record.pollExpiresAt } };
        }
        throw createError('owner_auth_assertion_expired', 'Instance poll assertion is no longer available.', 410);
      }
      const nowSeconds = Math.floor(clock() / 1000);
      const expiresAt = new Date((nowSeconds + Math.floor(OWNER_AUTH_POLL_ASSERTION_TTL_MS / 1000)) * 1000).toISOString();
      const claims = {
        iss: trimString(issuer) || 'agentoc-accounts',
        aud: record.instance.instanceId,
        sub: record.accountId,
        provider: (draft.accounts || []).find(account => account.accountId === record.accountId)?.provider || 'google',
        ...entitlementClaims(draft, record.accountId, clock(), 'computer', resolveEntitlement),
        purpose: record.purpose,
        tx: record.id,
        jti: makeId('assertion'),
        iat: nowSeconds,
        exp: nowSeconds + Math.floor(OWNER_AUTH_POLL_ASSERTION_TTL_MS / 1000),
      };
      // 断言只短时保存在事务记录里，供响应丢失后的同 requestId 重放；
      // 窗口过后不再可领取，事务 TTL 统一清理。
      record.pollExpiresAt = expiresAt;
      record.pollRedeemedAt = nowIso(clock);
      record.pollRequestId = requestId;
      return { completion: browserCompletion(record), claims,
        cache: { transactionId: record.id, requestId, instanceId: record.instance.instanceId, accountId: record.accountId },
        response: { status: 'completed', expiresAt } };
    }, finalizePollAssertion);
    audit({ event: 'instance_poll.redeemed', transactionId, result: result.status });
    return result;
  }

  // Native Android owner auth is the central convergence boundary. Google
  // verification, account resolution, instance binding, device lastSeen, and
  // the audit event all happen in one store.mutate() transaction.
  async function completeNativeCredential(input) {
    const requestId = trimString(input?.requestId);
    const purpose = 'native';
    const device = input?.device && typeof input.device === 'object' ? input.device : {};
    const deviceId = trimString(device.deviceId);
    const devicePublicKeyFingerprint = trimString(device.devicePublicKeyFingerprint);
    const deviceAlias = normalizeDeviceAlias(device.alias);
    const instance = validateNativeInstance(input, {
      requestId,
      purpose,
      deviceId,
      devicePublicKeyFingerprint,
      deviceAlias,
      clock,
    });
    if (!trimString(input?.idToken)) {
      throw createError('owner_auth_request_invalid', 'Missing Google ID token.', 400);
    }
    const result = await authorityMutation(async (draft) => {
      const googleIdentity = await verifyNativeGoogleCredential({ idToken: trimString(input.idToken) });
      const account = await resolveAccount({
        draft,
        googleIdentity: {
          ...googleIdentity,
          providerSubject: trimString(googleIdentity?.providerSubject || googleIdentity?.sub),
        },
      });
      const accountId = trimString(account?.accountId || account?.id);
      if (!accountId) throw createError('owner_auth_account_invalid', 'Unable to resolve Account identity.', 502);
      const requests = getNativeAuthRequests(draft);
      let prior = requests.find((item) => item.requestId === requestId);
      if (prior?.status === 'rolled_back') {
        requests.splice(requests.indexOf(prior), 1);
        prior = null;
      }
      if (prior && (prior.instanceId !== instance.instanceId || prior.deviceId !== deviceId || prior.accountId !== accountId)) {
        throw createError('owner_auth_native_replay', 'Native owner authentication request was already used.', 409);
      }
      const bindings = getInstanceBindings(draft);
      const binding = bindings.find((item) => item.instanceId === instance.instanceId);
      if (binding?.revokedAt) {
        throw createError('owner_auth_binding_revoked', 'This instance binding has been revoked.', 403);
      }
      if (binding && binding.accountId !== accountId) {
        throw createError('owner_auth_binding_mismatch', 'Google account does not match the bound owner.', 403);
      }
      const existingDevice = getDevices(draft).find((item) => item.deviceId === deviceId);
      if (prior && (!existingDevice || existingDevice.unboundAt
        || existingDevice.devicePublicKeyFingerprint !== devicePublicKeyFingerprint)) {
        throw createError('owner_auth_device_revoked', 'The original device authorization is no longer active.', 403);
      }
      if (existingDevice && (existingDevice.instanceId !== instance.instanceId
        || (existingDevice.accountId && existingDevice.accountId !== accountId))) {
        throw createError('owner_auth_device_mismatch', 'Device is already registered to another instance or account.', 403);
      }
      if (existingDevice?.deviceKind && existingDevice.deviceKind !== 'phone') {
        throw createError('owner_auth_device_mismatch', 'Device identity is already registered as a computer.', 403);
      }
      const previousBinding = binding ? { ...binding } : null;
      const previousDevice = existingDevice ? { ...existingDevice } : null;
      const now = nowIso(clock);
      const action = prior || binding ? 'login' : 'bind';
      if (!binding) {
        upsertInstanceBinding(draft, {
          instanceId: instance.instanceId,
          accountId,
          provider: 'google',
          deviceAlias,
          instancePublicKey: instance.publicKey,
          instanceKeyFingerprint: instance.keyFingerprint,
          now,
        });
        recordBindingEvent(draft, { instanceId: instance.instanceId, accountId, action: 'bind', now });
      } else {
        if (deviceAlias) binding.deviceAlias = deviceAlias;
        // Re-authentication is also the repair path for bindings created by
        // older releases, which did not persist the instance identity. Keep
        // the directory's target proof complete for phone rendezvous.
        binding.instancePublicKey = instance.publicKey;
        binding.instanceKeyFingerprint = instance.keyFingerprint;
      }
      upsertDevice(draft, {
        deviceId,
        instanceId: instance.instanceId,
        accountId,
        alias: deviceAlias || undefined,
        devicePublicKeyFingerprint,
        deviceKind: 'phone',
        now,
      });
      if (!prior) {
        requests.push({
          requestId,
          instanceId: instance.instanceId,
          deviceId,
          accountId,
          completedAt: now,
          status: 'completed',
          bindingCreated: !previousBinding,
          deviceCreated: !previousDevice,
          previousBinding,
          previousDevice,
        });
      }
      const claims = {
        iss: trimString(issuer) || 'agentoc-accounts',
        aud: instance.instanceId,
        sub: accountId,
        ...entitlementClaims(draft, accountId, clock(), 'phone', resolveEntitlement),
        purpose,
        tx: requestId,
        deviceId,
        devicePublicKeyFingerprint,
        jti: makeId('assertion'),
        iat: Math.floor(clock() / 1000),
        exp: Math.floor(clock() / 1000) + 60,
      };
      return { fresh: !prior, completion: nativeCompletion(instance, accountId, requestId, deviceId, devicePublicKeyFingerprint), claims,
        response: {
        expiresAt: new Date((Math.floor(clock() / 1000) + 60) * 1000).toISOString(),
        deviceState: 'bound',
        deviceId,
        lastSeenAt: now,
        action,
      } };
    }, finalizeBoundAssertion);
    audit({
      event: 'native.owner_auth.completed',
      action: result.action,
      result: 'ok',
      requestId,
      instanceId: instance.instanceId,
      deviceId: result.deviceId,
      lastSeenAt: result.lastSeenAt,
    });
    const { action, ...publicResult } = result;
    return { ...publicResult, action };
  }

  function assertDemoAccount(draft, accountId, instanceId = '') {
    assertAccountNotDeleting(draft, accountId);
    if (accountId?.startsWith('acct_demo_') || (draft.accounts || []).some(a => a.accountId === accountId && a.provider === 'demo')) {
      if (!demoAccountAuth) throw createError('owner_auth_demo_unavailable', 'Demo account is unavailable.', 403);
      demoAccountAuth.assertAccount(draft, accountId, instanceId);
    }
  }

  function accountSessionKeyId(accountId, normalizedKey) {
    // A demo login must not occupy or replace the normal Google device-key row.
    return accountId.startsWith('acct_demo_')
      ? `adk_demo_${hashSecret(`${accountId}:${normalizedKey.keyId}`)}` : normalizedKey.keyId;
  }

  function authenticateAccountCredential(draft, rawCredential, scope, { touchActivity = true } = {}) {
    const token = trimString(rawCredential);
    if (!/^rac_[A-Za-z0-9_-]{32,}$/.test(token)) {
      throw createError('owner_auth_account_credential_invalid', 'Account session credential is invalid.', 401);
    }
    const credential = getAccountCredentials(draft).find((item) => item.tokenHash === hashSecret(token));
    const expiresMs = Date.parse(credential?.expiresAt || '');
    if (!credential || credential.revokedAt || !Number.isFinite(expiresMs) || expiresMs <= clock()) {
      throw createError('owner_auth_account_credential_expired', 'Account session credential is expired or revoked.', 401);
    }
    if (!hasCredentialScope(credential, scope)) {
      throw createError('owner_auth_account_credential_scope', 'Account session credential does not have this capability.', 403);
    }
    assertDemoAccount(draft, credential.accountId);
    const device = getAccountDevices(draft).find((item) => item.deviceId === credential.deviceId);
    const key = getAccountDeviceKeys(draft).find((item) => item.keyId === credential.keyId);
    if (!device || device.accountId !== credential.accountId || device.revokedAt
      || !key || key.accountId !== credential.accountId || key.deviceId !== credential.deviceId || key.revokedAt) {
      throw createError('owner_auth_account_device_revoked', 'The account device or its key has been revoked.', 403);
    }
    const normalizedKey = normalizeDevicePublicKey(key.publicKey);
    if (!normalizedKey || accountSessionKeyId(credential.accountId, normalizedKey) !== key.keyId || normalizedKey.publicKey !== key.publicKey
      || createDevicePublicKeyFingerprint(key.publicKey) !== key.fingerprint) {
      throw createError('owner_auth_account_device_invalid', 'The registered account device key is invalid.', 403);
    }
    // Presence is informational. Persist it at most once a minute rather
    // than rewriting the store for every directory, quota and result poll.
    // All credential/key/device revocation and expiry checks above still run
    // on every request; this does not cache authentication or extend authority.
    const nowMs = clock();
    const due = (value) => !Number.isFinite(Date.parse(value || ''))
      || nowMs - Date.parse(value) >= ACCOUNT_SESSION_ACTIVITY_PERSIST_INTERVAL_MS;
    if (touchActivity && due(credential.lastUsedAt)) credential.lastUsedAt = new Date(nowMs).toISOString();
    if (touchActivity && due(device.lastSeenAt)) device.lastSeenAt = new Date(nowMs).toISOString();
    return { credential, device, key, normalizedKey };
  }

  // Browser sign-in handoff for account sessions (non-GMS Android). The
  // tickets and the verified Google identity live only in this process: a
  // challenge is bounded, single-purpose state, and losing it to a restart
  // just means the user retries the login. Challenges themselves stay in the
  // store; only this handoff layer is ephemeral.
  const accountSessionBrowserTickets = new Map();
  const accountSessionBrowserVerified = new Map();
  // A lost HTTP reply must not force another Google login. Retain the issued
  // response only in RAM, for at most two minutes and never beyond the original
  // challenge. Recovery still requires the same phone proof and a live RAC/key.
  const accountSessionDeliveries = new Map();
  function forgetAccountSessionDelivery(id) {
    const entry = accountSessionDeliveries.get(id);
    if (entry) clearTimeout(entry.timer);
    accountSessionDeliveries.delete(id);
  }
  function rememberAccountSessionDelivery(id, result) {
    for (const [key, entry] of accountSessionDeliveries) if (entry.expiresAt <= clock()) forgetAccountSessionDelivery(key);
    forgetAccountSessionDelivery(id);
    while (accountSessionDeliveries.size >= 256) forgetAccountSessionDelivery(accountSessionDeliveries.keys().next().value);
    if (result.recoveryExpiresAt <= clock()) return;
    const entry = { result: structuredClone(result), expiresAt: result.recoveryExpiresAt, timer: null };
    entry.timer = setTimeout(() => {
      if (accountSessionDeliveries.get(id) === entry) forgetAccountSessionDelivery(id);
    }, Math.max(0, entry.expiresAt - clock()));
    entry.timer.unref?.();
    accountSessionDeliveries.set(id, entry);
  }

  async function createAccountSessionChallenge(input) {
    const requestId = trimString(input?.requestId);
    const device = input?.device && typeof input.device === 'object' ? input.device : {};
    const deviceId = trimString(device.deviceId);
    const normalizedKey = normalizeDevicePublicKey(device.publicKey);
    const deviceAlias = normalizeDeviceAlias(device.alias);
    const platform = trimString(device.platform).slice(0, 32);
    if (!isProtocolField(requestId, { min: 16, max: 128 })
      || !isProtocolField(deviceId, { min: 8, max: 160 }) || !normalizedKey) {
      throw createError('owner_auth_account_session_invalid', 'Invalid account session challenge request.', 400);
    }
    const result = await store.mutate(async (draft) => {
      pruneAccountSessionRecords(draft, clock());
      sweepAccountSessionBrowserState(clock());
      const challenges = getAccountSessionChallenges(draft);
      const existing = challenges.find((item) => item.requestId === requestId);
      if (existing) {
        if (existing.deviceId !== deviceId || existing.publicKey !== normalizedKey.publicKey
          || existing.publicKeyFingerprint !== createDevicePublicKeyFingerprint(normalizedKey.publicKey)
          || existing.deviceAlias !== deviceAlias || existing.platform !== platform) {
          throw createError('owner_auth_account_session_replay', 'Account session request ID was already used with different device material.', 409);
        }
        if (existing.consumedAt) {
          throw createError('owner_auth_account_session_consumed', 'Account session challenge was already completed.', 409);
        }
        // A restart drops the ephemeral handoff ticket; re-issue for the same
        // unconsumed challenge so a retrying client can still finish.
        let browserTicket = accountSessionBrowserTickets.get(existing.transactionId)?.ticket || '';
        if (!browserTicket) {
          browserTicket = makeId('obv');
          accountSessionBrowserTickets.set(existing.transactionId, { ticket: browserTicket, expiresMs: Date.parse(existing.expiresAt) });
        }
        return { ...existing, browserTicket, replayed: true };
      }
      const now = nowIso(clock);
      const record = {
        transactionId: makeId('oasc'),
        requestId,
        deviceId,
        publicKey: normalizedKey.publicKey,
        publicKeyFingerprint: createDevicePublicKeyFingerprint(normalizedKey.publicKey),
        deviceAlias,
        platform,
        nonce: makeId('nonce'),
        createdAt: now,
        expiresAt: new Date(clock() + ACCOUNT_SESSION_CHALLENGE_TTL_MS).toISOString(),
        consumedAt: '',
      };
      challenges.push(record);
      const browserTicket = makeId('obv');
      accountSessionBrowserTickets.set(record.transactionId, { ticket: browserTicket, expiresMs: Date.parse(record.expiresAt) });
      return { ...record, browserTicket, replayed: false };
    });
    audit({ event: 'account_session.challenge_created', transactionId: result.transactionId, deviceId: result.deviceId });
    return {
      contractVersion: 2,
      capabilities: { accountSessions: true, accountJoinGrants: true, browserSignIn: true },
      transactionId: result.transactionId,
      nonce: result.nonce,
      expiresAt: result.expiresAt,
      browserTicket: result.browserTicket,
      completionRecoveryWindowMs: 120_000,
    };
  }

  /** Drops ephemeral handoff entries whose challenge window has closed. */
  function sweepAccountSessionBrowserState(nowMs) {
    for (const [tx, entry] of accountSessionBrowserTickets) {
      if (!Number.isFinite(entry.expiresMs) || entry.expiresMs <= nowMs) accountSessionBrowserTickets.delete(tx);
    }
    for (const [tx, entry] of accountSessionBrowserVerified) {
      const verifiedMs = Date.parse(entry.verifiedAt || '');
      if (!Number.isFinite(verifiedMs) || verifiedMs + ACCOUNT_SESSION_CHALLENGE_TTL_MS <= nowMs) {
        accountSessionBrowserVerified.delete(tx);
      }
    }
  }

  /** Challenge material for the browser GIS sign-in page (nonce + expiry). */
  async function beginAccountSessionBrowserVerify({ transactionId, ticket } = {}) {
    const txId = trimString(transactionId);
    const normalizedTicket = trimString(ticket);
    if (!isProtocolField(txId, { min: 16, max: 128 }) || !normalizedTicket) {
      throw createError('owner_auth_account_session_invalid', 'Invalid browser verification request.', 400);
    }
    const entry = accountSessionBrowserTickets.get(txId);
    if (!entry || entry.ticket !== normalizedTicket || entry.expiresMs <= clock()) {
      throw createError('owner_auth_account_session_browser_ticket_invalid', 'Browser sign-in link is invalid or expired.', 410);
    }
    const challenge = await findAccountSessionChallenge(txId);
    if (!challenge || Date.parse(challenge.expiresAt || '') <= clock()) {
      throw createError('owner_auth_account_session_expired', 'Account session challenge is expired or unknown.', 410);
    }
    return { transactionId: txId, nonce: challenge.nonce, expiresAt: challenge.expiresAt };
  }

  /** Record that the browser page verified the Google identity for this challenge. */
  async function markAccountSessionBrowserVerified({ transactionId, idToken } = {}) {
    const txId = trimString(transactionId);
    const normalizedToken = trimString(idToken);
    if (!isProtocolField(txId, { min: 16, max: 128 }) || !normalizedToken) {
      throw createError('owner_auth_account_session_invalid', 'Invalid browser verification.', 400);
    }
    const challenge = await findAccountSessionChallenge(txId);
    if (!challenge || Date.parse(challenge.expiresAt || '') <= clock()) {
      throw createError('owner_auth_account_session_expired', 'Account session challenge is expired or unknown.', 410);
    }
    if (challenge.consumedAt) {
      throw createError('owner_auth_account_session_consumed', 'Account session challenge was already completed.', 409);
    }
    // The GIS button runs with the web client id; the challenge nonce binds
    // the token to this exact sign-in. Only the verified identity is kept —
    // the raw token never reaches the native client.
    const googleIdentity = await verifyGoogleCredential({ idToken: normalizedToken, nonce: challenge.nonce });
    const subject = trimString(googleIdentity?.providerSubject || googleIdentity?.sub);
    if (!subject) throw createError('owner_auth_account_invalid', 'Unable to resolve Google identity.', 502);
    accountSessionBrowserVerified.set(txId, {
      subject,
      email: trimString(googleIdentity?.email || ''),
      verifiedAt: nowIso(clock),
    });
    audit({ event: 'account_session.browser_verified', transactionId: txId });
    return { transactionId: txId };
  }

  /** Reads a live account-session challenge without mutating anything. */
  async function findAccountSessionChallenge(transactionId) {
    return store.mutate(async (draft) => {
      pruneAccountSessionRecords(draft, clock());
      return getAccountSessionChallenges(draft).find((item) => item.transactionId === transactionId) || null;
    });
  }

  async function completeDemoAccountSession(input) {
    if (!demoAccountAuth) throw createError('owner_auth_demo_unavailable', 'Demo account is unavailable.', 403);
    if (input?.idToken || input?.desktopProof) throw createError('owner_auth_account_session_invalid', 'Mixed sign-in methods.', 400);
    // Expensive password verification happens outside the store transaction.
    const demoIdentity = await demoAccountAuth.verify({ username: input?.username, password: input?.password });
    return completeAccountSession({ transactionId: input?.transactionId, requestId: input?.requestId,
      signature: input?.signature }, { demoIdentity });
  }

  async function completeAccountSession(input, { desktopAuthorization = false, demoIdentity = null, transaction = store.mutate.bind(store) } = {}) {
    const transactionId = trimString(input?.transactionId);
    const requestId = trimString(input?.requestId);
    const idToken = trimString(input?.idToken);
    // idToken is the native Credential Manager path; an empty idToken selects
    // the browser-verified handoff recorded on the challenge (non-GMS devices).
    if (!isProtocolField(transactionId, { min: 16, max: 128 })
      || !isProtocolField(requestId, { min: 16, max: 128 })
      || (desktopAuthorization ? !!idToken || !input?.desktopProof : !!input?.desktopProof)
      || !trimString(input?.signature)) {
      throw createError('owner_auth_account_session_invalid', 'Invalid account session completion.', 400);
    }
    const result = await transaction(async (draft) => {
      pruneAccountSessionRecords(draft, clock());
      const challenge = getAccountSessionChallenges(draft).find((item) => item.transactionId === transactionId);
      const expiresMs = Date.parse(challenge?.expiresAt || '');
      if (!challenge || !Number.isFinite(expiresMs) || expiresMs <= clock()) {
        throw createError('owner_auth_account_session_expired', 'Account session challenge is expired or unknown.', 410);
      }
      if (challenge.requestId !== requestId) {
        throw createError('owner_auth_account_session_replay', 'Account session completion request does not match its challenge.', 409);
      }
      const normalizedKey = normalizeDevicePublicKey(challenge.publicKey);
      if (!normalizedKey || createDevicePublicKeyFingerprint(normalizedKey.publicKey) !== challenge.publicKeyFingerprint
        || !verifyDeviceAuthSignature({
          publicKey: normalizedKey.publicKey,
          algorithm: normalizedKey.algorithm,
          message: buildAccountSessionMessage({
            transactionId, requestId, deviceId: challenge.deviceId,
            publicKeyFingerprint: challenge.publicKeyFingerprint, nonce: challenge.nonce,
          }),
          signature: input.signature,
        })) {
        throw createError('owner_auth_account_session_signature_invalid', 'Invalid account session device signature.', 401);
      }
      if (challenge.consumedAt) {
        const delivery = !desktopAuthorization && accountSessionDeliveries.get(transactionId);
        if (!delivery || delivery.expiresAt <= clock()) {
          forgetAccountSessionDelivery(transactionId);
          throw createError('owner_auth_account_session_consumed', 'Account session challenge was already completed.', 409);
        }
        const authenticated = authenticateAccountCredential(draft, delivery.result.rawCredential, 'account-directory');
        if (authenticated.device.deviceId !== challenge.deviceId || authenticated.key.fingerprint !== challenge.publicKeyFingerprint
          || authenticated.credential.credentialId !== delivery.result.credential.credentialId) {
          throw createError('owner_auth_account_session_signature_invalid', 'Account session delivery identity changed.', 401);
        }
        return { ...delivery.result, recovered: true };
      }
      let accountId;
      let googleIdentity;
      if (demoIdentity) {
        accountId = demoIdentity.accountId;
        if (!Array.isArray(draft.accounts)) draft.accounts = [];
        if (!draft.accounts.some(account => account.accountId === accountId)) {
          draft.accounts.push({ accountId, provider: 'demo', providerSubject: demoIdentity.username, createdAt: nowIso(clock) });
        }
        demoAccountAuth.assertAccount(draft, accountId);
      } else if (desktopAuthorization) {
        const proof = input.desktopProof;
        const instanceId = trimString(proof?.instanceId);
        const binding = getInstanceBindings(draft).find((entry) => entry.instanceId === instanceId && !entry.revokedAt);
        const issuedAt = trimString(proof?.issuedAt);
        const issuedMs = Date.parse(issuedAt);
        if (!binding?.accountId || !binding.instancePublicKey || !binding.instanceKeyFingerprint
          || binding.accountId !== trimString(proof?.accountId) || !Number.isFinite(issuedMs)
          || Math.abs(clock() - issuedMs) > 30_000
          || createInstancePublicKeyFingerprint(binding.instancePublicKey) !== binding.instanceKeyFingerprint
          || !verifyInstanceProofSignature({ publicKey: binding.instancePublicKey,
            message: buildDesktopAccountSessionAuthorization({ instanceId, accountId: binding.accountId,
              transactionId, requestId, deviceId: challenge.deviceId,
              publicKeyFingerprint: challenge.publicKeyFingerprint, nonce: challenge.nonce, issuedAt }),
            signature: proof.signature })) {
          throw createError('owner_auth_desktop_authorization_invalid', 'Desktop account authorization is invalid or expired.', 403);
        }
        accountId = binding.accountId;
        if (accountId.startsWith('acct_demo_') !== challenge.deviceId.startsWith('adev_demo_')) {
          throw createError('owner_auth_account_device_namespace_mismatch', 'Scan a fresh account-link code with an updated app.', 409);
        }
      } else {
        if (idToken) {
          googleIdentity = await verifyNativeGoogleCredential({ idToken, nonce: challenge.nonce });
        } else {
          const browserVerified = accountSessionBrowserVerified.get(transactionId) || null;
          if (!browserVerified?.subject) {
            throw createError('owner_auth_account_session_browser_pending', 'Finish Google sign-in in the browser to continue.', 409);
          }
          googleIdentity = { sub: browserVerified.subject, email: trimString(browserVerified.email) };
        }
        const account = await resolveAccount({ draft, googleIdentity: { ...googleIdentity,
          providerSubject: trimString(googleIdentity?.providerSubject || googleIdentity?.sub) } });
        accountId = trimString(account?.accountId || account?.id);
      }
      if (!accountId) throw createError('owner_auth_account_invalid', 'Unable to resolve Account identity.', 502);
      assertDemoAccount(draft, accountId);
      const devices = getAccountDevices(draft);
      const keys = getAccountDeviceKeys(draft);
      const credentials = getAccountCredentials(draft);
      const currentDevice = devices.find((item) => item.deviceId === challenge.deviceId);
      if (currentDevice && currentDevice.accountId !== accountId) {
        throw createError('owner_auth_account_device_mismatch', 'This Android installation belongs to another Account.', 403);
      }
      if (currentDevice?.revokedAt) {
        throw createError('owner_auth_account_device_revoked', 'This Android installation has been revoked.', 403);
      }
      const now = nowIso(clock);
      let accountDevice = currentDevice;
      if (!accountDevice) {
        accountDevice = {
          deviceId: challenge.deviceId, accountId, alias: challenge.deviceAlias, platform: challenge.platform,
          createdAt: now, lastSeenAt: now, unboundAt: '', revokedAt: '',
        };
        devices.push(accountDevice);
      } else {
        accountDevice.alias = challenge.deviceAlias || accountDevice.alias;
        accountDevice.platform = challenge.platform || accountDevice.platform;
        accountDevice.lastSeenAt = now;
        accountDevice.unboundAt = '';
      }
      let key = keys.find((item) => item.accountId === accountId
        && item.fingerprint === challenge.publicKeyFingerprint);
      if (key) {
        key.deviceId = challenge.deviceId;
        key.revokedAt = '';
      } else {
        // A new key for the same Android installation is an explicit Google
        // reauthentication/key-rotation event.  Retire old keys and RACs.
        for (const oldKey of keys.filter((item) => item.accountId === accountId
          && item.deviceId === challenge.deviceId && !item.revokedAt)) oldKey.revokedAt = now;
        for (const oldCredential of credentials.filter((item) => item.accountId === accountId
          && item.deviceId === challenge.deviceId && !item.revokedAt)) oldCredential.revokedAt = now;
        key = {
          keyId: accountSessionKeyId(accountId, normalizedKey), accountId, deviceId: challenge.deviceId,
          publicKey: normalizedKey.publicKey, fingerprint: challenge.publicKeyFingerprint, createdAt: now, revokedAt: '',
        };
        keys.push(key);
      }
      // A fresh Google exchange is a deliberate re-login; only one live RAC
      // is retained for this account-device to make loss/revocation decisive.
      for (const oldCredential of credentials.filter((item) => item.accountId === accountId
        && item.deviceId === challenge.deviceId && !item.revokedAt)) oldCredential.revokedAt = now;
      const rawCredential = makeAccountCredential();
      const expiresAt = new Date(clock() + ACCOUNT_CREDENTIAL_TTL_MS).toISOString();
      const credential = {
        credentialId: makeId('racid'), tokenHash: hashSecret(rawCredential), accountId,
        deviceId: challenge.deviceId, keyId: key.keyId, scope: 'account-directory',
        issuedAt: now, expiresAt, revokedAt: '', lastUsedAt: now,
      };
      credentials.push(credential);
      challenge.consumedAt = now;
      accountSessionBrowserTickets.delete(transactionId);
      accountSessionBrowserVerified.delete(transactionId);
      return {
        rawCredential, credential, accountId, deviceId: challenge.deviceId, keyFingerprint: key.fingerprint,
        email: trimString(googleIdentity?.email || ''),
        recoveryExpiresAt: Math.min(expiresMs, clock() + 120_000),
      };
    });
    if (!desktopAuthorization && !result.recovered) rememberAccountSessionDelivery(transactionId, result);
    audit({ event: result.recovered ? 'account_session.delivery_recovered' : 'account_session.completed', accountId: result.accountId, deviceId: result.deviceId });
    return {
      contractVersion: 2,
      capabilities: { accountSessions: true, accountJoinGrants: true },
      accountId: result.accountId,
      ...(result.accountId === demoAccountAuth?.accountId ? { demoAccessMode: demoAccountAuth.accessMode } : {}),
      deviceId: result.deviceId,
      keyFingerprint: result.keyFingerprint,
      email: result.email,
      credential: {
        type: 'Bearer', token: result.rawCredential, credentialId: result.credential.credentialId,
        scope: result.credential.scope, expiresAt: result.credential.expiresAt,
      },
    };
  }

  async function refreshAccountSession(input) {
    const credentialId = trimString(input?.credentialId);
    const deviceId = trimString(input?.deviceId);
    const requestId = trimString(input?.requestId);
    const issuedAt = trimString(input?.issuedAt);
    const nonce = trimString(input?.nonce);
    const issuedMs = Date.parse(issuedAt);
    if (!isProtocolField(credentialId, { min: 16, max: 128 }) || !isProtocolField(deviceId, { min: 8, max: 160 })
      || !isProtocolField(requestId, { min: 16, max: 128 }) || !isProtocolField(nonce, { min: 16, max: 256 })
      || !issuedMs || Math.abs(clock() - issuedMs) > NATIVE_OWNER_AUTH_PROOF_SKEW_MS || !trimString(input?.signature)) {
      throw createError('owner_auth_account_refresh_invalid', 'Invalid account session refresh request.', 400);
    }
    const result = await store.mutate(async (draft) => {
      pruneAccountSessionRecords(draft, clock());
      const credential = getAccountCredentials(draft).find((item) => item.credentialId === credentialId);
      if (!credential || credential.deviceId !== deviceId || credential.revokedAt) {
        throw createError('owner_auth_account_credential_expired', 'Account session credential is expired or revoked.', 401);
      }
      const expiresMs = Date.parse(credential.expiresAt || '');
      assertDemoAccount(draft, credential.accountId);
      if (!Number.isFinite(expiresMs) || expiresMs + ACCOUNT_CREDENTIAL_TTL_MS <= clock()) {
        throw createError('owner_auth_account_credential_expired', 'Account session can no longer be refreshed.', 401);
      }
      const device = getAccountDevices(draft).find((item) => item.deviceId === deviceId && item.accountId === credential.accountId);
      const key = getAccountDeviceKeys(draft).find((item) => item.keyId === credential.keyId);
      const normalizedKey = normalizeDevicePublicKey(key?.publicKey);
      if (!device || device.revokedAt || !key || key.revokedAt || !normalizedKey
        || !verifyDeviceAuthSignature({
          publicKey: normalizedKey.publicKey, algorithm: normalizedKey.algorithm,
          message: buildAccountCredentialRefreshMessage({ credentialId, deviceId, requestId, issuedAt, nonce }),
          signature: input.signature,
        })) {
        throw createError('owner_auth_account_refresh_signature_invalid', 'Invalid account session refresh signature.', 401);
      }
      const nonceHash = hashSecret(nonce);
      if (getAccountCredentialRefreshes(draft).some((item) => item.credentialId === credentialId
        && (item.requestId === requestId || item.nonceHash === nonceHash))) {
        throw createError('owner_auth_account_refresh_replayed', 'Account session refresh was already used.', 409);
      }
      const now = nowIso(clock);
      const rawCredential = makeAccountCredential();
      credential.tokenHash = hashSecret(rawCredential);
      credential.issuedAt = now;
      credential.expiresAt = new Date(clock() + ACCOUNT_CREDENTIAL_TTL_MS).toISOString();
      credential.lastUsedAt = now;
      device.lastSeenAt = now;
      getAccountCredentialRefreshes(draft).push({ credentialId, requestId, nonceHash, issuedAt, createdAt: now });
      return { rawCredential, credential: { ...credential }, accountId: credential.accountId, deviceId, keyFingerprint: key.fingerprint };
    });
    audit({ event: 'account_session.refreshed', accountId: result.accountId, deviceId: result.deviceId });
    return {
      contractVersion: 2,
      accountId: result.accountId,
      ...(result.accountId === demoAccountAuth?.accountId ? { demoAccessMode: demoAccountAuth.accessMode } : {}),
      deviceId: result.deviceId,
      keyFingerprint: result.keyFingerprint,
      credential: {
        type: 'Bearer', token: result.rawCredential, credentialId: result.credential.credentialId,
        scope: result.credential.scope, expiresAt: result.credential.expiresAt,
      },
    };
  }

  async function createAccountJoinIntent(input) {
    const intentId = trimString(input?.intentId);
    const nonce = trimString(input?.nonce);
    const device = input?.device && typeof input.device === 'object' ? input.device : {};
    const computerAlias = normalizeDeviceAlias(input?.computerAlias);
    const deviceId = trimString(device.deviceId);
    const devicePublicKey = normalizeDevicePublicKey(device.publicKey);
    const devicePublicKeyFingerprint = trimString(device.devicePublicKeyFingerprint);
    if (!intentId || intentId.length > 128 || !nonce || nonce.length > 256 || !deviceId
      || !devicePublicKey || devicePublicKeyFingerprint !== createDevicePublicKeyFingerprint(devicePublicKey.publicKey)) {
      throw createError('owner_auth_native_request_invalid', 'Invalid account join intent.', 400);
    }
    const instance = validateAccountJoinInstance(input, {
      intentId,
      deviceId,
      devicePublicKeyFingerprint,
      nonce,
      clock,
    });
    const now = nowIso(clock);
    const expiresAt = new Date(clock() + 2 * 60 * 1000).toISOString();
    const result = await store.mutate(async (draft) => {
      const intents = getAccountJoinIntents(draft);
      const existing = intents.find((item) => item.intentId === intentId);
      if (existing) {
        if (existing.instanceId !== instance.instanceId
          || existing.deviceId !== deviceId
          || existing.instance?.instanceId !== instance.instanceId
          || existing.instance?.keyFingerprint !== instance.keyFingerprint
          || existing.devicePublicKeyFingerprint !== devicePublicKeyFingerprint
          || existing.nonceHash !== hashSecret(nonce)
          || existing.issuedAt !== instance.issuedAt
          || trimString(existing.publicEndpoint) !== instance.publicEndpoint
          || normalizeDeviceAlias(existing.computerAlias) !== computerAlias) {
          throw createError('owner_auth_native_replay', 'Account join intent was already used by another device.', 409);
        }
        if (!['pending', 'completed'].includes(existing.status)
          || !Number.isFinite(Date.parse(existing.expiresAt || ''))
          || Date.parse(existing.expiresAt) <= clock()) {
          throw createError('owner_auth_account_intent_expired', 'Account join intent is expired or unknown.', 410);
        }
        return {
          intentId: existing.intentId,
          instanceId: existing.instanceId,
          deviceId: existing.deviceId,
          nonce,
          expiresAt: existing.expiresAt,
          issuedAt: existing.issuedAt,
          computerAlias: normalizeDeviceAlias(existing.computerAlias),
          replayed: true,
        };
      }
      intents.push({
        intentId,
        instanceId: instance.instanceId,
        instance: {
          instanceId: instance.instanceId,
          publicKey: instance.publicKey,
          keyFingerprint: instance.keyFingerprint,
        },
        deviceId,
        devicePublicKey: devicePublicKey.publicKey,
        devicePublicKeyFingerprint,
        deviceAlias: normalizeDeviceAlias(device.alias),
        computerAlias,
        platform: trimString(device.platform).slice(0, 32),
        publicEndpoint: instance.publicEndpoint,
        nonceHash: hashSecret(nonce),
        issuedAt: trimString(input.issuedAt),
        createdAt: now,
        expiresAt,
        status: 'pending',
        accountId: '',
        completionRequestId: '',
        completedAt: '',
      });
      return {
        intentId,
        instanceId: instance.instanceId,
        deviceId,
        nonce,
        issuedAt: trimString(input.issuedAt),
        expiresAt,
        computerAlias,
        replayed: false,
      };
    });
    audit({ event: 'account_join_intent.created', intentId, instanceId: result.instanceId, deviceId: result.deviceId });
    return result;
  }

  // Endpoint-less Android joins use the Accounts service as a short-lived
  // rendezvous queue. The target instance is selected from the account-owned
  // binding, never from caller-supplied public metadata.
  async function createAccountRendezvous(input, { credential: rawCredential = '' } = {}) {
    const requestId = trimString(input?.requestId);
    const targetInstanceId = trimString(input?.targetInstanceId);
    const accountClaimToken = trimString(input?.accountClaimToken);
    const targetInstance = input?.targetInstance && typeof input.targetInstance === 'object'
      ? input.targetInstance : {};
    const device = input?.device && typeof input.device === 'object' ? input.device : {};
    const computerAlias = normalizeDeviceAlias(input?.computerAlias);
    const deviceId = trimString(device.deviceId);
    const devicePublicKey = normalizeDevicePublicKey(device.publicKey);
    const devicePublicKeyFingerprint = trimString(device.devicePublicKeyFingerprint);
    if (!isProtocolField(requestId, { min: 16, max: 128 }) || !isProtocolField(targetInstanceId, { min: 8, max: 160 })
      || !isProtocolField(deviceId, { min: 8, max: 160 }) || !devicePublicKey
      || devicePublicKeyFingerprint !== createDevicePublicKeyFingerprint(devicePublicKey.publicKey)) {
      throw createError('owner_auth_rendezvous_invalid', 'Invalid account rendezvous request.', 400);
    }
    const token = trimString(rawCredential);
    const mutate = typeof store.mutateRendezvousCreation === 'function' && /^rac_[A-Za-z0-9_-]{32,}$/.test(token)
      ? mutator => store.mutateRendezvousCreation({ tokenHash: hashSecret(token), requestId }, mutator)
      : mutator => store.mutate(mutator);
    const result = await mutate(async (draft, scoped) => {
      const pruneAt = clock();
      scoped?.markPrune({ now: pruneAt, refreshBefore: pruneAt - ACCOUNT_CREDENTIAL_REFRESH_RETENTION_MS,
        grantsBefore: pruneAt - OWNER_AUTH_TRANSACTION_TTL_MS });
      pruneAccountSessionRecords(draft, pruneAt);
      const authenticated = authenticateAccountCredential(draft, rawCredential, 'account-directory');
      const existing = getAccountJoinIntents(draft).find((item) => item.rendezvousRequestId === requestId);
      assertDemoAccount(draft, authenticated.credential.accountId, targetInstanceId);
      if (existing) {
        if (existing.accountId !== authenticated.credential.accountId || existing.instanceId !== targetInstanceId
          || existing.deviceId !== deviceId || existing.devicePublicKeyFingerprint !== devicePublicKeyFingerprint
          || normalizeDeviceAlias(existing.computerAlias) !== computerAlias) {
          throw createError('owner_auth_rendezvous_replay', 'Rendezvous request was already used with different material.', 409);
        }
        return { intent: publicRendezvousIntent(existing), replayed: true };
      }
      const binding = getInstanceBindings(draft).find((item) => item.instanceId === targetInstanceId
        && item.accountId === authenticated.credential.accountId && !item.revokedAt);
      const targetPublicKey = trimString(binding?.instancePublicKey || targetInstance.publicKey);
      const targetKeyFingerprint = trimString(binding?.instanceKeyFingerprint || targetInstance.keyFingerprint);
      const claimHash = accountClaimToken ? hashSecret(accountClaimToken) : '';
      if (!binding && !claimHash) throw createError('owner_auth_binding_mismatch', 'Target computer is not bound to this account.', 403);
      if (!targetPublicKey || !targetKeyFingerprint
        || createInstancePublicKeyFingerprint(targetPublicKey) !== targetKeyFingerprint) {
        throw createError('owner_auth_rendezvous_target_unavailable', 'Target computer has not published rendezvous identity.', 503);
      }
      const now = nowIso(clock);
      const nonce = makeId('nonce');
      const intent = {
        intentId: makeId('rji'),
        rendezvousRequestId: requestId,
        instanceId: targetInstanceId,
        instance: { instanceId: targetInstanceId, publicKey: targetPublicKey, keyFingerprint: targetKeyFingerprint },
        deviceId,
        devicePublicKey: devicePublicKey.publicKey,
        devicePublicKeyFingerprint,
        deviceAlias: normalizeDeviceAlias(device.alias),
        computerAlias,
        platform: trimString(device.platform).slice(0, 32),
        publicEndpoint: '',
        nonce,
        nonceHash: hashSecret(nonce),
        issuedAt: now,
        createdAt: now,
        expiresAt: new Date(clock() + ACCOUNT_RENDEZVOUS_TTL_MS).toISOString(),
        status: 'rendezvous_pending',
        accountId: authenticated.credential.accountId,
        completionRequestId: '',
        completedAt: '',
        rendezvousNonce: nonce,
        accountClaimTokenHash: claimHash,
      };
      getAccountJoinIntents(draft).push(intent);
      return { intent: publicRendezvousIntent(intent), replayed: false };
    });
    return result;
  }

  function validateRendezvousPoll(input, intent) {
    const instance = input?.instance && typeof input.instance === 'object' ? input.instance : {};
    const instanceId = trimString(instance.instanceId);
    const requestId = trimString(input?.requestId);
    const issuedAt = trimString(input?.issuedAt);
    const audience = trimString(input?.audience);
    const issuedMs = Date.parse(issuedAt);
    if (!instanceId || !requestId || !issuedMs || audience !== 'agentoc-account-rendezvous-poll'
      || instanceId !== intent.instanceId || requestId !== intent.rendezvousRequestId
      || !trimString(instance.publicKey)
      || instance.keyFingerprint !== intent.instance.keyFingerprint
      || createInstancePublicKeyFingerprint(instance.publicKey) !== instance.keyFingerprint
      || Math.abs(clock() - issuedMs) > OWNER_AUTH_PROOF_SKEW_MS) {
      throw createError('owner_auth_rendezvous_proof_invalid', 'Invalid account rendezvous poll proof.', 401);
    }
    const message = buildAccountRendezvousPollMessage({ instanceId, requestId, issuedAt, audience });
    if (!verifyInstanceProofSignature({ publicKey: instance.publicKey, message, signature: input?.signature })) {
      throw createError('owner_auth_rendezvous_proof_invalid', 'Invalid account rendezvous poll signature.', 401);
    }
  }

  async function pollAccountRendezvous(input) {
    const requestId = trimString(input?.requestId);
    const result = await store.mutate(async (draft) => {
      const intent = getAccountJoinIntents(draft).find((item) => item.rendezvousRequestId === requestId);
      if (!intent || Date.parse(intent.expiresAt || '') <= clock()) throw createError('owner_auth_rendezvous_expired', 'Rendezvous request is expired or unknown.', 410);
      validateRendezvousPoll(input, intent);
      const grant = getAccountJoinGrants(draft).find((item) => item.intentId === intent.intentId && !item.redeemedAt
        && Date.parse(item.expiresAt || '') > clock());
      return { intent: publicRendezvousIntent(intent), grant: intent.rendezvousGrant ? { accountJoinGrant: intent.rendezvousGrant, expiresAt: grant?.expiresAt || '' } : null, result: publicRendezvousResult(intent) };
    });
    return result;
  }

  const inboxWait = createRendezvousInboxWait();

  async function pollAccountRendezvousInbox(input, { signal } = {}) {
    signal?.throwIfAborted();
    const instance = input?.instance && typeof input.instance === 'object' ? input.instance : {};
    const instanceId = trimString(instance.instanceId);
    const issuedAt = trimString(input?.issuedAt);
    const issuedMs = Date.parse(issuedAt);
    if (!isProtocolField(instanceId, { min: 8, max: 160 }) || !trimString(instance.publicKey) || !issuedMs
      || createInstancePublicKeyFingerprint(instance.publicKey) !== instance.keyFingerprint
      || trimString(input?.requestId) !== 'inbox'
      || trimString(input?.audience) !== 'agentoc-account-rendezvous-poll'
      || Math.abs(clock() - issuedMs) > OWNER_AUTH_PROOF_SKEW_MS) {
      throw createError('owner_auth_rendezvous_proof_invalid', 'Invalid account rendezvous inbox proof.', 401);
    }
    const message = buildAccountRendezvousPollMessage({ instanceId, requestId: 'inbox', issuedAt, audience: input.audience });
    if (!verifyInstanceProofSignature({ publicKey: instance.publicKey, message, signature: input?.signature })) {
      throw createError('owner_auth_rendezvous_proof_invalid', 'Invalid account rendezvous inbox signature.', 401);
    }
    const readState = (draft, requiredBinding, touchActivity) => {
      if (Math.abs(clock() - issuedMs) > OWNER_AUTH_PROOF_SKEW_MS) {
        throw createError('owner_auth_rendezvous_proof_invalid', 'Rendezvous inbox proof expired.', 401);
      }
      // A valid inbox proof proves that this bound computer still holds its
      // instance key. Treat it as activity even when the phone has not yet
      // offered a rendezvous intent, but never let a submitted key update a
      // differently bound instance.
      const binding = getInstanceBindings(draft).find((item) => item.instanceId === instanceId
        && !item.revokedAt
        && trimString(item.instancePublicKey) === trimString(instance.publicKey)
        && trimString(item.instanceKeyFingerprint) === trimString(instance.keyFingerprint));
      if (requiredBinding && (!binding || `${binding.accountId}\0${binding.boundAt}` !== requiredBinding)) {
        throw createError('owner_auth_binding_mismatch', 'Computer binding changed while waiting.', 403);
      }
      if (binding) {
        const account = (draft.accounts || []).find(item => item.accountId === binding.accountId);
        if (account?.deletionRequestedAt || account?.deletionJobId) {
          throw createError('account_deletion_pending', 'Account deletion is pending.', 410);
        }
        assertDemoAccount(draft, binding.accountId, instanceId);
        if (touchActivity && needsActivity(binding)) {
          const now = nowIso(clock);
          binding.lastSeenAt = now;
          const device = getDevices(draft).find((item) => item.instanceId === instanceId
            && item.accountId === binding.accountId && !item.unboundAt);
          if (device) device.lastSeenAt = now;
        }
      }
      const nowMs = clock();
      const grants = getAccountJoinGrants(draft);
      const availableGrant = (item) => item.rendezvousGrant ? grants.find((grant) => grant.intentId === item.intentId
        && grant.grantHash === hashSecret(item.rendezvousGrant) && !grant.redeemedAt
        && Date.parse(grant.expiresAt || '') > nowMs) : null;
      const intent = getAccountJoinIntents(draft).find((item) => item.instanceId === instanceId
        && ['rendezvous_pending', 'rendezvous_offered'].includes(item.status)
        && Date.parse(item.expiresAt || '') > nowMs
        // A phone may die between creating an intent and publishing its grant.
        // Only deliver actionable work. An ungranted pending intent (or an
        // expired offer) must not hide a newer, fully authorized reconnect.
        && availableGrant(item) && trimString(item.rendezvousDeviceSignature));
      const subjectId = binding ? `${binding.accountId}\0${binding.boundAt}` : null;
      if (!intent) return { value: { intent: null, grant: null }, subjectId };
      if (intent.instance?.keyFingerprint !== instance.keyFingerprint) {
        throw createError('owner_auth_rendezvous_proof_invalid', 'Rendezvous inbox belongs to another instance key.', 401);
      }
      const grant = availableGrant(intent);
      return { subjectId, value: {
        intent: publicRendezvousIntent(intent),
        grant: intent.rendezvousGrant && grant ? { accountJoinGrant: intent.rendezvousGrant, deviceSignature: intent.rendezvousDeviceSignature || '', expiresAt: grant.expiresAt } : null,
      } };
    };
    const needsActivity = binding => binding && (!Number.isFinite(Date.parse(binding.lastSeenAt || ''))
      || clock() - Date.parse(binding.lastSeenAt) >= ACCOUNT_RENDEZVOUS_ACTIVITY_PERSIST_INTERVAL_MS);
    const read = async (requiredBinding = null) => {
      signal?.throwIfAborted();
      if (typeof store.readAccountRendezvousInboxSnapshot === 'function') {
        const snapshot = await store.readAccountRendezvousInboxSnapshot({ instanceId, now: clock() });
        const result = readState(snapshot, requiredBinding, false);
        const binding = (snapshot.instanceBindings || []).find(item => item.instanceId === instanceId
          && !item.revokedAt && item.instanceKeyFingerprint === instance.keyFingerprint
          && trimString(item.instancePublicKey) === trimString(instance.publicKey));
        if (!needsActivity(binding)) { signal?.throwIfAborted(); return result; }
      }
      // Only the five-minute activity update enters the writer, never the wait.
      const result = await store.mutate(draft => readState(draft, requiredBinding, true));
      signal?.throwIfAborted();
      return result;
    };
    return inboxWait.poll({ instanceId, waitMs: input?.waitMs, signal, read });
  }

  async function completeAccountRendezvous(input) {
    const requestId = trimString(input?.requestId);
    const resultValue = input?.result && typeof input.result === 'object' ? input.result : null;
    if (!requestId || !resultValue) throw createError('owner_auth_rendezvous_invalid', 'Rendezvous result is required.', 400);
    const mutate = typeof store.mutateRendezvousResult === 'function'
      ? mutator => store.mutateRendezvousResult(requestId, mutator) : mutator => store.mutate(mutator);
    const result = await mutate(async (draft) => {
      const intent = getAccountJoinIntents(draft).find((item) => item.rendezvousRequestId === requestId);
      if (!intent || Date.parse(intent.expiresAt || '') <= clock()) throw createError('owner_auth_rendezvous_expired', 'Rendezvous request is expired or unknown.', 410);
      validateRendezvousPoll(input, intent);
      intent.rendezvousResult = resultValue;
      intent.status = 'rendezvous_completed';
      intent.completedAt = intent.completedAt || nowIso(clock);
      return publicRendezvousResult(intent);
    });
    // Wake only after the transaction has committed. The notification itself
    // contains neither credentials nor a cached result.
    rendezvousResultWaiters.notify(requestId);
    return result;
  }

  async function submitAccountRendezvousGrant(input, { credential: rawCredential = '' } = {}) {
    const requestId = trimString(input?.requestId);
    const accountJoinGrant = trimString(input?.accountJoinGrant);
    if (!requestId || !accountJoinGrant) throw createError('owner_auth_rendezvous_invalid', 'Account join grant is required.', 400);
    return store.mutate(async (draft) => {
      const authenticated = authenticateAccountCredential(draft, rawCredential, 'account-directory');
      const intent = getAccountJoinIntents(draft).find((item) => item.rendezvousRequestId === requestId
        && item.accountId === authenticated.credential.accountId);
      if (!intent || Date.parse(intent.expiresAt || '') <= clock()) throw createError('owner_auth_rendezvous_expired', 'Rendezvous request is expired or unknown.', 410);
      const grant = getAccountJoinGrants(draft).find((item) => item.intentId === intent.intentId
        && item.grantHash === hashSecret(accountJoinGrant)
        && item.accountId === authenticated.credential.accountId
        && item.accountDeviceId === authenticated.device.deviceId
        && item.keyFingerprint === authenticated.key.fingerprint);
      // Authorization already publishes the grant atomically. A fast computer
      // may redeem it before an older phone sends this redundant confirmation.
      // Acknowledge the exact completed grant without putting it back in inbox.
      if (grant?.redeemedAt && intent.completedAt && intent.accountDeviceId === grant.accountDeviceId) {
        return { ok: true, requestId };
      }
      if (grant?.redeemedAt || Date.parse(grant?.expiresAt || '') <= clock()
        || (intent.rendezvousGrant && intent.rendezvousGrant !== accountJoinGrant)) {
        throw createError('owner_auth_account_join_grant_invalid', 'Account join grant is invalid or expired.', 410);
      }
      if (!grant) throw createError('owner_auth_account_join_grant_invalid', 'Account join grant is invalid or expired.', 410);
      intent.rendezvousGrant = accountJoinGrant;
      intent.status = 'rendezvous_offered';
      return { ok: true, requestId };
    });
  }

  async function getAccountRendezvousResult(input, { credential: rawCredential = '', signal } = {}) {
    signal?.throwIfAborted();
    const waitMs = rendezvousResultWaitMs(input?.waitMs);
    const requestId = trimString(input?.requestId);
    const readResult = (draft, touchActivity) => {
      const authenticated = authenticateAccountCredential(draft, rawCredential, 'account-directory', { touchActivity });
      const intent = getAccountJoinIntents(draft).find((item) => item.rendezvousRequestId === requestId
        && item.accountId === authenticated.credential.accountId);
      if (!intent || Date.parse(intent.expiresAt || '') <= clock()) throw createError('owner_auth_rendezvous_expired', 'Rendezvous request is expired or unknown.', 410);
      return { value: publicRendezvousResult(intent),
        subjectId: `${authenticated.credential.accountId}\0${authenticated.credential.deviceId}` };
    };
    const read = async () => {
      signal?.throwIfAborted();
      if (typeof store.readAccountRendezvousSnapshot === 'function') {
        const token = trimString(rawCredential);
        if (!/^rac_[A-Za-z0-9_-]{32,}$/.test(token)) return readResult({}, false);
        const snapshot = await store.readAccountRendezvousSnapshot({ tokenHash: hashSecret(token),
          requestId: isProtocolField(requestId, { min: 16, max: 128 }) ? requestId : '' });
        signal?.throwIfAborted();
        return readResult(snapshot, false);
      }
      const value = await store.mutate(async (draft) => readResult(draft, true));
      signal?.throwIfAborted();
      return value;
    };
    const initial = await read();
    if (!waitMs) return initial.value;
    const response = value => ({ ...value, resultWaitVersion: 1 });
    if (initial.value.result != null) return response(initial.value);
    const budget = Math.min(waitMs, Date.parse(initial.value.expiresAt) - clock());
    if (budget <= 0) return response((await read()).value);
    const started = performance.now();
    const remaining = () => budget - (performance.now() - started);
    const waiter = rendezvousResultWaiters.subscribe({ requestId, subjectId: initial.subjectId,
      timeoutMs: Math.max(1, Math.floor(budget)), signal });
    try {
      const readAfterWait = async () => {
        const pendingBeforeRead = waiter.pending;
        const current = await read();
        // A notification (or deadline) may settle the waiter while this MVCC
        // snapshot is in flight. Read once after that transition, including at
        // later checkpoints. A waiter settles only once, so this cannot loop.
        return pendingBeforeRead && !waiter.pending ? read() : current;
      };
      // Close the commit-between-read-and-subscribe race before waiting.
      let current = await readAfterWait();
      while (current.value.result == null && remaining() > 0) {
        await waitForRendezvousResultTick(waiter, Math.min(RENDEZVOUS_RESULT_CHECKPOINT_MS, remaining()));
        signal?.throwIfAborted();
        // A different Accounts process may have committed. Every checkpoint
        // uses a fresh transaction; no connection or authorization spans wait.
        current = await readAfterWait();
        if (!waiter.pending) break;
      }
      return response(current.value);
    } finally { waiter.cancel(); }
  }

  function closeRendezvousResultWaiters() {
    rendezvousResultWaiters.close();
  }

  // Android spends rac_ only at Accounts.  The returned opaque grant is bound
  // to one target intent and can be handed to that target without turning it
  // into an Accounts-directory credential.
  async function authorizeAccountJoinIntent(input, { credential: rawCredential } = {}) {
    const intentId = trimString(input?.intentId);
    const requestId = trimString(input?.requestId);
    const deviceId = trimString(input?.deviceId);
    const devicePublicKeyFingerprint = trimString(input?.devicePublicKeyFingerprint);
    const nonce = trimString(input?.nonce);
    const issuedAt = trimString(input?.issuedAt);
    if (!isProtocolField(intentId, { min: 8, max: 128 }) || !isProtocolField(requestId, { min: 16, max: 128 })
      || !isProtocolField(deviceId, { min: 8, max: 160 }) || !/^[a-f0-9]{64}$/.test(devicePublicKeyFingerprint)
      || !isProtocolField(nonce, { min: 16, max: 256 }) || !isProtocolField(issuedAt, { min: 20, max: 64 })
      || !trimString(input?.deviceSignature)) {
      throw createError('owner_auth_account_join_authorize_invalid', 'Invalid account join authorization request.', 400);
    }
    const result = await store.mutate(async (draft) => {
      pruneAccountSessionRecords(draft, clock());
      const authenticated = authenticateAccountCredential(draft, rawCredential, 'account-directory');
      const intent = getAccountJoinIntents(draft).find((item) => item.intentId === intentId);
      const expiresMs = Date.parse(intent?.expiresAt || '');
      if (!intent || !['pending', 'rendezvous_pending', 'rendezvous_offered'].includes(intent.status)
        || !Number.isFinite(expiresMs) || expiresMs <= clock()) {
        throw createError('owner_auth_account_intent_expired', 'Account join intent is expired or unavailable.', 410);
      }
      if (intent.deviceId !== deviceId || intent.devicePublicKeyFingerprint !== devicePublicKeyFingerprint
        || intent.nonceHash !== hashSecret(nonce) || intent.issuedAt !== issuedAt
        || authenticated.credential.accountId !== authenticated.device.accountId
        || authenticated.key.fingerprint !== devicePublicKeyFingerprint) {
        throw createError('owner_auth_account_join_mismatch', 'Account session does not match this device join intent.', 403);
      }
      assertDemoAccount(draft, authenticated.credential.accountId, intent.instanceId);
      if (!verifyDeviceAuthSignature({
        publicKey: authenticated.key.publicKey,
        algorithm: authenticated.normalizedKey.algorithm,
        message: buildAccountJoinIntentMessage({
          instanceId: intent.instanceId, intentId, deviceId, devicePublicKeyFingerprint,
          nonce, issuedAt, audience: 'agentoc-account-join',
        }),
        signature: input.deviceSignature,
      })) {
        throw createError('owner_auth_device_signature_invalid', 'Invalid account join device signature.', 401);
      }
      const binding = getInstanceBindings(draft).find((item) => item.instanceId === intent.instanceId);
      // A QR-selected, yet-unbound computer is claimable only through this
      // credential-bound, signed, 60-second grant path.  An existing binding
      // must still belong to the same Account; no grant can transfer it.
      const reenrolling = freshAccountQrReenrollment(binding, intent, authenticated.credential.accountId, clock());
      if ((binding?.revokedAt && !reenrolling)
        || (binding && binding.accountId !== authenticated.credential.accountId)
        || (binding && accountBindingTime(intent.createdAt) < accountBindingTime(binding.boundAt))) {
        throw createError('owner_auth_binding_mismatch', 'The selected computer no longer belongs to this Account.', 403);
      }
      if (getAccountJoinGrants(draft).some((item) => item.accountId === authenticated.credential.accountId
        && item.requestId === requestId)) {
        throw createError('owner_auth_account_join_grant_replayed', 'Account join authorization request was already used.', 409);
      }
      const now = nowIso(clock);
      // Keep exactly one live grant for a target intent.  A lost response can
      // be recovered by making a new signed request without widening access.
      for (const grant of getAccountJoinGrants(draft).filter((item) => item.intentId === intentId
        && item.deviceId === deviceId && !item.redeemedAt)) grant.expiresAt = now;
      const rawGrant = makeAccountJoinGrant();
      const expiresAt = new Date(clock() + ACCOUNT_JOIN_GRANT_TTL_MS).toISOString();
      getAccountJoinGrants(draft).push({
        grantHash: hashSecret(rawGrant), accountId: authenticated.credential.accountId,
        instanceId: intent.instanceId, intentId, deviceId, accountDeviceId: authenticated.device.deviceId,
        keyFingerprint: devicePublicKeyFingerprint,
        claimInstance: !binding || reenrolling,
        publicEndpoint: intent.publicEndpoint || '',
        requestId, createdAt: now, expiresAt, redeemedAt: '',
      });
      if (intent.rendezvousRequestId) {
        intent.rendezvousGrant = rawGrant;
        intent.rendezvousDeviceSignature = trimString(input.deviceSignature);
        intent.status = 'rendezvous_offered';
      }
      return { rawGrant, expiresAt, accountId: authenticated.credential.accountId, instanceId: intent.instanceId, deviceId,
        rendezvousGrantSubmitted: Boolean(intent.rendezvousRequestId) };
    });
    if (result.rendezvousGrantSubmitted) inboxWait.notify(result.instanceId);
    audit({ event: 'account_join_grant.issued', intentId, instanceId: result.instanceId, deviceId: result.deviceId });
    return {
      contractVersion: 2,
      intentId,
      instanceId: result.instanceId,
      deviceId: result.deviceId,
      accountJoinGrant: result.rawGrant,
      expiresAt: result.expiresAt,
      rendezvousGrantSubmitted: result.rendezvousGrantSubmitted,
    };
  }

  async function completeAccountJoinIntent(input) {
    const intentId = trimString(input?.intentId);
    const requestId = trimString(input?.requestId);
    const device = input?.device && typeof input.device === 'object' ? input.device : {};
    const deviceId = trimString(device.deviceId);
    const devicePublicKeyFingerprint = trimString(device.devicePublicKeyFingerprint);
    const nonce = trimString(input?.nonce);
    const deviceIssuedAt = trimString(input?.deviceIssuedAt);
    const idToken = trimString(input?.idToken);
    const accountJoinGrant = trimString(input?.accountJoinGrant);
    if (!intentId || !requestId || !deviceId || !nonce || Boolean(idToken) === Boolean(accountJoinGrant)
      || !deviceIssuedAt || requestId.length < 16 || requestId.length > 128
      || !isProtocolField(deviceIssuedAt, { min: 20, max: 64 })
      || !/^[\x21-\x7e]+$/.test(requestId)) {
      throw createError('owner_auth_native_request_invalid', 'Invalid account join completion.', 400);
    }
    const instance = validateAccountJoinInstance(input, {
      intentId,
      deviceId,
      devicePublicKeyFingerprint,
      nonce,
      clock,
    });
    const result = await authorityMutation(async (draft) => {
      const intent = getAccountJoinIntents(draft).find((item) => item.intentId === intentId);
      const expiresMs = Date.parse(intent?.expiresAt || '');
      if (!intent || !Number.isFinite(expiresMs) || expiresMs <= clock()) {
        throw createError('owner_auth_account_intent_expired', 'Account join intent is expired or unknown.', 410);
      }
      if (intent.instanceId !== instance.instanceId || intent.deviceId !== deviceId
        || intent.devicePublicKeyFingerprint !== devicePublicKeyFingerprint
        || intent.nonceHash !== hashSecret(nonce)
        || intent.issuedAt !== deviceIssuedAt
        || trimString(intent.publicEndpoint) !== instance.publicEndpoint) {
        throw createError('owner_auth_native_replay', 'Account join intent does not match.', 409);
      }
      const storedInstance = intent.instance && typeof intent.instance === 'object' ? intent.instance : {};
      if (storedInstance.instanceId !== intent.instanceId
        || !trimString(storedInstance.publicKey)
        || storedInstance.keyFingerprint !== instance.keyFingerprint) {
        throw createError('owner_auth_instance_mismatch', 'Account join proof belongs to a different instance key.', 403);
      }
      const intentDeviceKey = normalizeDevicePublicKey(intent.devicePublicKey);
      if (!intentDeviceKey
        || createDevicePublicKeyFingerprint(intentDeviceKey.publicKey) !== intent.devicePublicKeyFingerprint
        || !verifyDeviceAuthSignature({
        publicKey: intent.devicePublicKey,
        algorithm: intentDeviceKey?.algorithm,
        message: buildAccountJoinIntentMessage({
          instanceId: intent.instanceId,
          intentId,
          deviceId: intent.deviceId,
          devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint,
          nonce,
          issuedAt: deviceIssuedAt,
          audience: 'agentoc-account-join',
        }),
        signature: input?.deviceSignature,
      })) {
        throw createError('owner_auth_device_signature_invalid', 'Invalid account join device signature.', 401);
      }
      const wasCompleted = intent.status === 'completed';
      if (!wasCompleted && !['pending', 'rendezvous_pending', 'rendezvous_offered'].includes(intent.status)) {
        throw createError('owner_auth_native_replay', 'Account join intent is not pending.', 409);
      }
      if (wasCompleted) {
        if (intent.completionRequestId !== requestId) {
          throw createError('owner_auth_native_replay', 'Account join intent was already completed.', 409);
        }
        if (!trimString(intent.accountId) || !intent.completedAt) {
          throw createError('owner_auth_account_invalid', 'Account join intent state is invalid.', 502);
        }
      } else {
        let accountId = '';
        let grant = null;
        if (accountJoinGrant) {
          grant = getAccountJoinGrants(draft).find((item) => item.grantHash === hashSecret(accountJoinGrant));
          const grantExpiresMs = Date.parse(grant?.expiresAt || '');
          if (!grant || grant.redeemedAt || !Number.isFinite(grantExpiresMs) || grantExpiresMs <= clock()
            || grant.intentId !== intentId || grant.instanceId !== intent.instanceId || grant.deviceId !== intent.deviceId
            || grant.keyFingerprint !== intent.devicePublicKeyFingerprint) {
            throw createError('owner_auth_account_join_grant_invalid', 'Account join grant is invalid, expired, or already used.', 410);
          }
          accountId = grant.accountId;
          assertDemoAccount(draft, accountId, instance.instanceId);
        } else {
          const googleIdentity = await verifyNativeGoogleCredential({ idToken });
          const account = await resolveAccount({
            draft,
            googleIdentity: {
              ...googleIdentity,
              providerSubject: trimString(googleIdentity?.providerSubject || googleIdentity?.sub),
            },
          });
          accountId = trimString(account?.accountId || account?.id);
        }
        if (!accountId) throw createError('owner_auth_account_invalid', 'Unable to resolve Account identity.', 502);
        let binding = getInstanceBindings(draft).find((item) => item.instanceId === instance.instanceId);
        const reenrolling = grant?.claimInstance && freshAccountQrReenrollment(binding, intent, accountId, clock())
          && accountBindingTime(grant.createdAt) > accountBindingTime(binding.revokedAt);
        if ((binding?.revokedAt && !reenrolling)
          || (binding && grant && accountBindingTime(grant.createdAt) < accountBindingTime(binding.boundAt))) {
          throw createError('owner_auth_binding_revoked', 'This instance binding has been revoked.', 403);
        }
        if (!binding || reenrolling) {
          if (!grant?.claimInstance) {
            throw createError('owner_auth_account_intent_not_ready', 'The target instance is not ready for account joining.', 409);
          }
          const claimEndpoint = normalizeClaimPublicEndpoint(grant.publicEndpoint);
          if (claimEndpoint !== trimString(intent.publicEndpoint)) {
            throw createError('owner_auth_account_join_grant_invalid', 'Account join claim endpoint does not match the signed intent.', 410);
          }
          const now = nowIso(clock);
          upsertInstanceBinding(draft, {
            instanceId: instance.instanceId,
            accountId,
            provider: 'account-session',
            deviceAlias: normalizeDeviceAlias(intent.computerAlias) || 'Ragent computer',
            instancePublicKey: instance.publicKey,
            instanceKeyFingerprint: instance.keyFingerprint,
            publicEndpoint: claimEndpoint,
            now,
          });
          upsertDevice(draft, {
            deviceId: instance.instanceId,
            instanceId: instance.instanceId,
            accountId,
            alias: normalizeDeviceAlias(intent.computerAlias) || 'Ragent computer',
            deviceKind: 'computer',
            now,
          });
          recordBindingEvent(draft, { instanceId: instance.instanceId, accountId, action: 'bind', now });
          binding = getInstanceBindings(draft).find((item) => item.instanceId === instance.instanceId);
        }
        if (binding.accountId !== accountId) {
          throw createError('owner_auth_binding_mismatch', 'Account does not match the target instance.', 403);
        }
        const now = nowIso(clock);
        if (grant) {
          const accountDevice = getAccountDevices(draft).find((item) => item.deviceId === grant.accountDeviceId);
          const accountKey = getAccountDeviceKeys(draft).find((item) => item.accountId === accountId
            && item.deviceId === grant.accountDeviceId && item.fingerprint === intent.devicePublicKeyFingerprint);
          if (!accountDevice || accountDevice.accountId !== accountId || accountDevice.revokedAt
            || !accountKey || accountKey.revokedAt) {
            throw createError('owner_auth_account_device_revoked', 'The account device is no longer authorized.', 403);
          }
          accountDevice.lastSeenAt = now;
          intent.accountDeviceId = accountDevice.deviceId;
          grant.redeemedAt = now;
          if (intent.rendezvousRequestId) {
            intent.rendezvousGrant = '';
            intent.rendezvousDeviceSignature = '';
          }
        } else {
          // Legacy Google completion preserves the existing target-coupled
          // device row.  v2 grants intentionally never write this table.
          const existingDevice = getDevices(draft).find((item) => item.deviceId === intent.deviceId);
          if (existingDevice && (
            (existingDevice.instanceId && existingDevice.instanceId !== intent.instanceId)
            || (existingDevice.accountId && existingDevice.accountId !== accountId)
            || (existingDevice.devicePublicKeyFingerprint
              && existingDevice.devicePublicKeyFingerprint !== intent.devicePublicKeyFingerprint)
          )) {
            throw createError('owner_auth_device_mismatch', 'Device is already registered to another instance, account, or key.', 403);
          }
          if (existingDevice?.deviceKind && existingDevice.deviceKind !== 'phone') {
            throw createError('owner_auth_device_mismatch', 'Device identity is already registered as a computer.', 403);
          }
          upsertDevice(draft, {
            deviceId: intent.deviceId,
            instanceId: intent.instanceId,
            accountId,
            alias: intent.deviceAlias,
            devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint,
            deviceKind: 'phone',
            now,
          });
        }
        intent.status = 'completed';
        intent.accountId = accountId;
        intent.completionRequestId = requestId;
        intent.completedAt = now;
      }
      const nowSeconds = Math.floor(clock() / 1000);
      const claims = {
        iss: trimString(issuer) || 'agentoc-accounts',
        aud: intent.instanceId,
        sub: intent.accountId,
        ...entitlementClaims(draft, intent.accountId, clock(), 'phone', resolveEntitlement),
        purpose: 'account_join',
        tx: requestId,
        intentId,
        deviceId: intent.deviceId,
        devicePublicKeyFingerprint: intent.devicePublicKeyFingerprint,
        jti: makeId('assertion'),
        iat: nowSeconds,
        exp: nowSeconds + 60,
      };
      return {
        claims, fresh: !wasCompleted,
        completion: authorityCompletion('account_join', intentId, { instance, accountId: intent.accountId,
          sourceNonce: [intent.nonceHash, requestId], deviceId: intent.deviceId, deviceFingerprint: intent.devicePublicKeyFingerprint }),
        response: { expiresAt: new Date((nowSeconds + 60) * 1000).toISOString(), deviceState: 'bound',
          deviceId: intent.deviceId, accountId: intent.accountId, lastSeenAt: intent.completedAt, replayed: wasCompleted },
      };
    }, finalizeBoundAssertion);
    audit({
      event: 'account_join_intent.completed',
      intentId,
      requestId,
      instanceId: result.deviceId ? instance.instanceId : '',
      deviceId: result.deviceId,
      result: 'ok',
    });
    return result;
  }

  // Compensating operation for the unavoidable cross-service window after
  // native complete commits at Accounts but before the instance finishes its
  // local device promotion. It is idempotent and only rolls back the exact
  // request's changes; a later successful request wins and is left intact.
  async function rollbackNativeCredential(input) {
    const requestId = trimString(input?.requestId);
    const device = input?.device && typeof input.device === 'object' ? input.device : {};
    const deviceId = trimString(device.deviceId);
    const deviceAlias = normalizeDeviceAlias(device.alias);
    const durableAuthority = typeof store.mutateWithAuthority === 'function' || typeof store.readInstanceAuthority === 'function';
    const rollbackProof = durableAuthority || input?.audience === 'agentoc-owner-auth-native-rollback';
    const instance = validateNativeInstance(input, {
      requestId,
      purpose: 'native',
      deviceId,
      deviceAlias,
      clock,
      rollback: rollbackProof,
    });
    const result = await authorityMutation(async (draft, authority) => {
      const requests = getNativeAuthRequests(draft);
      const record = requests.find((item) => item.requestId === requestId);
      if (!record || record.instanceId !== instance.instanceId || record.deviceId !== deviceId) {
        throw createError('owner_auth_native_request_invalid', 'Native owner authentication request was not found.', 404);
      }
      if (rollbackProof && record.accountId !== input.accountId) {
        throw createError('owner_auth_native_replay', 'Native rollback account does not match the original request.', 409);
      }
      if (record.status === 'rolled_back') return { response: { rolledBack: true, alreadyRolledBack: true } };
      const completion = nativeCompletion(instance, record.accountId, requestId, deviceId, instance.devicePublicKeyFingerprint);
      if (authority) {
        const retained = await authority.readCompletionIdentity(completion);
        if (retained.revision !== input.expectedRevision || retained.completionId !== input.expectedCompletionId) {
          throw createError('owner_auth_native_replay', 'Native rollback was superseded.', 409);
        }
        const activeDevice = getDevices(draft).find(item => item.deviceId === deviceId);
        if (!activeDevice || activeDevice.unboundAt || activeDevice.devicePublicKeyFingerprint !== instance.devicePublicKeyFingerprint) {
          throw createError('owner_auth_device_revoked', 'The original device authorization is no longer active.', 403);
        }
        // Legacy request timestamps are not a causal order. When another
        // completed request shares this instance, preserve its authority rather
        // than restoring an earlier snapshot whose ordering cannot be proven.
        if (requests.some(item => item.status !== 'rolled_back' && item.requestId !== requestId
          && item.instanceId === instance.instanceId)) return { response: { rolledBack: false, reason: 'superseded' } };
      }
      const superseded = requests.some((item) => item.status !== 'rolled_back'
        && item.requestId !== requestId
        && item.instanceId === instance.instanceId
        && item.deviceId === deviceId
        && Date.parse(item.completedAt || '') > Date.parse(record.completedAt || ''));
      if (superseded) return { response: { rolledBack: false, reason: 'superseded' } };

      const bindings = getInstanceBindings(draft);
      const devices = getDevices(draft);
      if (record.bindingCreated) {
        const index = bindings.findIndex((item) => item.instanceId === instance.instanceId
          && item.accountId === record.accountId);
        if (index !== -1) bindings.splice(index, 1);
        recordBindingEvent(draft, {
          instanceId: instance.instanceId,
          accountId: record.accountId,
          action: 'bind_rollback',
          now: nowIso(clock),
        });
      } else if (record.previousBinding) {
        const index = bindings.findIndex((item) => item.instanceId === instance.instanceId);
        if (index === -1) bindings.push({ ...record.previousBinding });
        else bindings[index] = { ...record.previousBinding };
      }
      const deviceIndex = devices.findIndex((item) => item.deviceId === deviceId);
      if (record.deviceCreated) {
        if (deviceIndex !== -1 && devices[deviceIndex].accountId === record.accountId) devices.splice(deviceIndex, 1);
      } else if (record.previousDevice) {
        if (deviceIndex === -1) devices.push({ ...record.previousDevice });
        else devices[deviceIndex] = { ...record.previousDevice };
      }
      record.status = 'rolled_back';
      record.rolledBackAt = nowIso(clock);
      return { completion, expectedRevision: input?.expectedRevision, expectedCompletionId: input?.expectedCompletionId,
        response: { rolledBack: true, alreadyRolledBack: false } };
    }, async (pending, authority) => {
      if (authority && pending.completion) await authority.forgetCompletion({ ...pending.completion,
        expectedRevision: pending.expectedRevision, expectedCompletionId: pending.expectedCompletionId });
      return pending.response;
    });
    audit({
      event: 'native.owner_auth.rolled_back',
      requestId,
      instanceId: instance.instanceId,
      deviceId,
      result: result.rolledBack ? 'ok' : 'superseded',
    });
    return result;
  }

  // 设备管理操作：实例签名（purpose=unbind/devices/history/
  // publish-endpoint/publish-identity）鉴权。
  // transactionId 是调用方生成的操作 id（一次性语义由调用方保证），
  // 该请求没有浏览器回调，因此不接受或要求 returnUrl。
  function normalizeDeviceOpInput(input, purpose, clock) {
    const instance = validateDeviceOpInstance(input, {
      transactionId: trimString(input?.transactionId),
      purpose,
      clock,
    });
    const accountId = trimString(input?.accountId);
    if (!accountId) throw createError('owner_auth_request_invalid', 'Missing account ID.', 400);
    return { instance, accountId, publicEndpoint: instance.publicEndpoint };
  }

  function validateTargetRuntimeAuthorizationInput(input, clock) {
    const instance = input?.instance && typeof input.instance === 'object' ? input.instance : {};
    const instanceId = trimString(instance.instanceId);
    const publicKey = trimString(instance.publicKey);
    const keyFingerprint = trimString(instance.keyFingerprint);
    const requestId = trimString(input?.requestId);
    const idempotencyKey = trimString(input?.idempotencyKey);
    const targetInstanceId = trimString(input?.targetInstanceId);
    const method = trimString(input?.method).toUpperCase();
    const path = trimString(input?.path);
    const operation = trimString(input?.operation);
    const resourceId = trimString(input?.resourceId);
    const expectedRevision = Number(input?.expectedRevision);
    const issuedAt = trimString(input?.issuedAt);
    const expiresAt = trimString(input?.expiresAt);
    const audience = trimString(input?.audience);
    const issuedMs = Date.parse(issuedAt);
    const expiresMs = Date.parse(expiresAt);
    const policy = classifyTargetRuntimeRequest(method, path);
    if (!instanceId || !publicKey || !keyFingerprint || !requestId || !idempotencyKey
      || !targetInstanceId || !resourceId || !Number.isSafeInteger(expectedRevision)
      || expectedRevision < 0 || audience !== TARGET_RUNTIME_GRANT_AUDIENCE
      || !policy || policy.method !== method || policy.operation !== operation
      || policy.path !== normalizeTargetRuntimePath(path) || !Number.isFinite(issuedMs)
      || !Number.isFinite(expiresMs)) {
      throw createError('target_runtime_authorization_invalid', 'Invalid target runtime authorization request.', 400);
    }
    if (Math.abs(clock() - issuedMs) > TARGET_RUNTIME_AUTH_SKEW_MS) {
      throw createError('target_runtime_authorization_expired', 'Target runtime authorization proof is expired.', 401);
    }
    if (expiresMs <= clock() || expiresMs - clock() > TARGET_RUNTIME_AUTH_MAX_LIFETIME_MS) {
      throw createError('target_runtime_authorization_expired', 'Target runtime authorization lifetime is invalid.', 409);
    }
    if (createInstancePublicKeyFingerprint(publicKey) !== keyFingerprint) {
      throw createError('target_runtime_authorization_invalid', 'Target runtime instance key fingerprint does not match.', 401);
    }
    const message = buildTargetRuntimeAuthorizationMessage({
      instanceId,
      requestId,
      targetInstanceId,
      idempotencyKey,
      method,
      path: policy.path,
      operation,
      resourceId,
      expectedRevision,
      expiresAt: new Date(expiresMs).toISOString(),
      issuedAt,
      audience,
    });
    if (!verifyInstanceProofSignature({ publicKey, message, signature: input?.signature })) {
      throw createError('target_runtime_authorization_invalid', 'Target runtime authorization proof is invalid.', 401);
    }
    return {
      instanceId,
      publicKey,
      keyFingerprint,
      requestId,
      idempotencyKey,
      targetInstanceId,
      method,
      path: policy.path,
      operation,
      resourceId,
      expectedRevision,
      issuedAt,
      expiresAt: new Date(expiresMs).toISOString(),
    };
  }

  // Exchange a source instance proof for a short-lived, exact target grant.
  // The returned bearer is never persisted. Only its claims and hash are kept
  // for idempotency and audit reconstruction after an Accounts restart.
  async function authorizeTargetRuntime(input) {
    const request = validateTargetRuntimeAuthorizationInput(input, clock);
    const result = await store.mutate(async (draft) => {
      const bindings = getInstanceBindings(draft);
      const sourceBinding = bindings.find((item) => item.instanceId === request.instanceId);
      if (!sourceBinding || sourceBinding.revokedAt) {
        throw createError('target_runtime_source_unbound', 'Source instance is not bound to this account.', 403);
      }
      if (!sourceBinding.instancePublicKey
        || trimString(sourceBinding.instancePublicKey) !== request.publicKey
        || sourceBinding.instanceKeyFingerprint !== request.keyFingerprint) {
        throw createError('target_runtime_source_mismatch', 'Source instance identity does not match its binding.', 403);
      }
      const targetBinding = bindings.find((item) => item.instanceId === request.targetInstanceId);
      if (!targetBinding || targetBinding.revokedAt || targetBinding.accountId !== sourceBinding.accountId) {
        throw createError('target_runtime_target_unavailable', 'Target instance is not available for this account.', 404);
      }
      let endpoint;
      try {
        const parsed = new URL(trimString(targetBinding.publicEndpoint));
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('invalid');
        endpoint = parsed.toString().replace(/\/$/, '');
      } catch {
        throw createError('target_runtime_target_unavailable', 'Target instance has no safe public endpoint.', 409);
      }

      const authorizations = getTargetRuntimeAuthorizations(draft);
      const now = clock();
      for (let index = authorizations.length - 1; index >= 0; index -= 1) {
        if (Date.parse(authorizations[index]?.expiresAt || '') <= now) authorizations.splice(index, 1);
      }
      const sameRequest = authorizations.find((item) => item.requestId === request.requestId);
      const sameIdempotency = authorizations.find((item) => item.sourceInstanceId === request.instanceId
        && item.idempotencyKey === request.idempotencyKey);
      const existing = sameRequest || sameIdempotency;
      if (existing) {
        const matches = existing.sourceInstanceId === request.instanceId
          && existing.targetInstanceId === request.targetInstanceId
          && existing.idempotencyKey === request.idempotencyKey
          && existing.method === request.method
          && existing.path === request.path
          && existing.operation === request.operation
          && existing.resourceId === request.resourceId
          && Number(existing.expectedRevision) === request.expectedRevision;
        if (!matches) throw createError('target_runtime_request_reused', 'Target runtime request binding was reused.', 409);
        const token = await signAssertion(existing.claims);
        return { token, endpoint, targetBinding, claims: existing.claims, replayed: true };
      }
      const claims = createTargetRuntimeGrantClaims({
        issuer,
        accountId: sourceBinding.accountId,
        sourceInstanceId: request.instanceId,
        targetInstanceId: request.targetInstanceId,
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        method: request.method,
        path: request.path,
        operation: request.operation,
        resourceId: request.resourceId,
        expectedRevision: request.expectedRevision,
        expiresAt: request.expiresAt,
        nowMs: now,
        ttlMs: Math.min(TARGET_RUNTIME_GRANT_TTL_MS, Date.parse(request.expiresAt) - now),
        jti: makeId('trg'),
      });
      const token = await signAssertion(claims);
      authorizations.push({
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        sourceInstanceId: request.instanceId,
        targetInstanceId: request.targetInstanceId,
        accountId: sourceBinding.accountId,
        method: request.method,
        path: request.path,
        operation: request.operation,
        resourceId: request.resourceId,
        expectedRevision: request.expectedRevision,
        issuedAt: request.issuedAt,
        expiresAt: claims.expiresAt,
        jti: claims.jti,
        grantHash: hashSecret(token),
        claims,
      });
      return { token, endpoint, targetBinding, claims, replayed: false };
    });
    audit({
      event: 'target_runtime.authorization_issued',
      requestId: result.claims.requestId,
      sourceInstanceId: result.claims.sourceInstanceId,
      targetInstanceId: result.claims.targetInstanceId,
      operation: result.claims.operation,
      replayed: result.replayed,
    });
    return {
      grant: result.token,
      target: {
        targetInstanceId: result.claims.targetInstanceId,
        endpoint: result.endpoint,
        label: normalizeDeviceAlias(result.targetBinding.deviceAlias) || result.claims.targetInstanceId,
        platform: trimString(result.targetBinding.platform),
      },
      expiresAt: result.claims.expiresAt,
      requestId: result.claims.requestId,
      idempotencyKey: result.claims.idempotencyKey,
    };
  }

  function assertBoundInstanceKey(binding, instance) {
    const publicKey = trimString(binding.instancePublicKey);
    const fingerprint = trimString(binding.instanceKeyFingerprint);
    if (publicKey || fingerprint) {
      const storedFingerprint = (() => {
        try { return publicKey ? createInstancePublicKeyFingerprint(publicKey) : ''; } catch { return ''; }
      })();
      if (!publicKey || !fingerprint || storedFingerprint !== fingerprint || fingerprint !== instance.keyFingerprint) {
        throw createError('owner_auth_instance_mismatch', 'Instance identity differs from its account binding.', 403);
      }
    } else if (instance.instanceId !== `inst_${instance.keyFingerprint.slice(0, 32)}`) {
      // Old canonical IDs already commit to the key. Arbitrary legacy IDs
      // without a retained key need a new authenticated enrollment instead.
      throw createError('owner_auth_instance_identity_missing', 'Account binding must be authenticated again.', 409);
    }
  }

  function assertBoundAccount(draft, instance, accountId) {
    const binding = getInstanceBindings(draft).find((item) => item.instanceId === instance.instanceId);
    if (!binding || binding.accountId !== accountId) {
      throw createError('owner_auth_instance_mismatch', 'Instance is not bound to this account.', 403);
    }
    assertBoundInstanceKey(binding, instance);
    if (binding.revokedAt) throw createError('owner_auth_already_unbound', 'This binding was already unbound.', 409);
    return binding;
  }

  // A remote account ID alone never authorizes a grant. The owning instance
  // signs the exact account, operation, request and its retained key.
  async function manageInstanceAccessGrant(input) {
    const instance = input?.instance && typeof input.instance === 'object' ? input.instance : {};
    const instanceId = trimString(instance.instanceId), publicKey = trimString(instance.publicKey);
    const keyFingerprint = trimString(instance.keyFingerprint), ownerAccountId = trimString(input?.ownerAccountId);
    const accountId = trimString(input?.accountId), operation = trimString(input?.operation);
    const grantId = trimString(input?.grantId), requestId = trimString(input?.requestId);
    const issuedAt = trimString(input?.issuedAt), audience = trimString(input?.audience);
    const issuedMs = Date.parse(issuedAt);
    if (![instanceId, ownerAccountId, accountId].every(value => /^[A-Za-z0-9_-]{8,160}$/.test(value))
      || !/^[a-f0-9]{64}$/.test(keyFingerprint) || !publicKey || publicKey.length > 4096
      || !['issue', 'revoke'].includes(operation) || !/^[A-Za-z0-9_-]{16,128}$/.test(requestId)
      || (operation === 'issue' ? Boolean(grantId) : !/^iag_[A-Za-z0-9_-]{16,128}$/.test(grantId))
      || audience !== 'agentoc-instance-access-grant' || !isProtocolField(issuedAt, { min: 20, max: 64 })
      || !Number.isFinite(issuedMs) || Math.abs(clock() - issuedMs) > OWNER_AUTH_PROOF_SKEW_MS) {
      throw createError('instance_access_proof_invalid', 'Invalid instance access authorization proof.', 400);
    }
    let keyMatches = false;
    try { keyMatches = createInstancePublicKeyFingerprint(publicKey) === keyFingerprint; } catch {}
    const message = buildInstanceAccessGrantMessage({ instanceId, keyFingerprint, ownerAccountId,
      accountId, operation, grantId, requestId, issuedAt, audience });
    if (!keyMatches || !verifyInstanceProofSignature({ publicKey, message, signature: input?.signature })) {
      throw createError('instance_access_proof_invalid', 'Invalid instance access authorization proof.', 401);
    }
    const result = await store.mutate(draft => {
      if (Math.abs(clock() - issuedMs) > OWNER_AUTH_PROOF_SKEW_MS) {
        throw createError('instance_access_proof_invalid', 'Instance access authorization proof expired.', 401);
      }
      assertAccountNotDeleting(draft, ownerAccountId);
      assertAccountNotDeleting(draft, accountId);
      assertBoundAccount(draft, { instanceId, publicKey, keyFingerprint }, ownerAccountId);
      if (operation === 'issue') {
        const issued = issueInstanceAccessGrant(draft, { instanceId, ownerAccountId, accountId, requestId, now: clock() });
        return { grantId: issued.grant.grantId, instanceId, accountId, scope: issued.grant.scope,
          created: issued.created, revokedAt: issued.grant.revokedAt || null };
      }
      const grant = (draft.instanceAccessGrants || []).find(item => item.grantId === grantId);
      if (!grant || grant.instanceId !== instanceId || grant.accountId !== accountId || grant.ownerAccountId !== ownerAccountId) {
        throw createError('instance_access_unavailable', 'Instance access authorization is unavailable.', 403);
      }
      return { ...revokeInstanceAccessGrant(draft, { grantId, ownerAccountId, now: clock() }), instanceId, accountId };
    });
    audit({ event: `instance_access.${operation}`, instanceId, ownerAccountId, accountId, grantId: result.grantId });
    return result;
  }

  function removeAccountComputerAssociation(draft, accountId, instanceId, now) {
    const intentIds = new Set(getAccountJoinIntents(draft).filter((item) => item.instanceId === instanceId).map((item) => item.intentId));
    const releasedConnections = releaseRevokedInstanceTurnConnections(draft, {
      accountId, instanceId, nowMs: new Date(now).getTime(),
    });
    draft.accountJoinGrants = getAccountJoinGrants(draft).filter((grant) => grant.instanceId !== instanceId && !intentIds.has(grant.intentId));
    draft.accountJoinIntents = getAccountJoinIntents(draft).filter((intent) => !intentIds.has(intent.intentId));
    draft.nativeAuthRequests = getNativeAuthRequests(draft).filter((request) => request.instanceId !== instanceId);
    draft.ownerAuthTransactions = getTransactions(draft).filter((transaction) => transaction.instance?.instanceId !== instanceId);
    draft.targetRuntimeAuthorizations = getTargetRuntimeAuthorizations(draft).filter((authorization) =>
      authorization.accountId !== accountId || (authorization.sourceInstanceId !== instanceId && authorization.targetInstanceId !== instanceId));
    if (Array.isArray(draft.accountPairingExchanges)) draft.accountPairingExchanges = draft.accountPairingExchanges
      .filter((exchange) => !(exchange.accountId === accountId && exchange.instanceId === instanceId));
    draft.devices = getDevices(draft).filter((device) => !(device.accountId === accountId && device.instanceId === instanceId));
    draft.instanceBindings = getInstanceBindings(draft).filter((binding) => !(binding.accountId === accountId && binding.instanceId === instanceId));
    return releasedConnections;
  }

  async function unbindInstance(input) {
    const { instance, accountId } = normalizeDeviceOpInput(input, 'unbind', clock);
    const result = await store.mutate(async (draft) => {
      const binding = getInstanceBindings(draft).find((item) => item.instanceId === instance.instanceId);
      if (!binding) throw createError('owner_auth_binding_missing', 'This instance has no Accounts binding.', 404);
      if (binding.accountId !== accountId) {
        throw createError('owner_auth_instance_mismatch', 'Instance is not bound to this account.', 403);
      }
      assertBoundInstanceKey(binding, instance);
      if (binding.revokedAt) {
        throw createError('owner_auth_already_unbound', 'This binding was already unbound.', 409);
      }
      const now = nowIso(clock);
      const releasedConnections = removeAccountComputerAssociation(draft, accountId, instance.instanceId, now);
      recordBindingEvent(draft, { instanceId: instance.instanceId, accountId, action: 'unbind', now });
      return { instanceId: instance.instanceId, accountId, unboundAt: now, releasedConnections };
    });
    audit({ event: 'device.unbound', instanceId: instance.instanceId, accountId });
    return result;
  }

  // A bound instance may refresh only its own canonical control-plane URL.
  // The instance proof is bound to the endpoint, so Accounts never accepts a
  // browser/phone supplied endpoint and never allows one instance to rewrite
  // another instance's directory entry.
  async function publishInstanceEndpoint(input) {
    const { instance, accountId, publicEndpoint } = normalizeDeviceOpInput(input, 'publish-endpoint', clock);
    const result = await store.mutate(async (draft) => {
      const binding = assertBoundAccount(draft, instance, accountId);
      if (binding.revokedAt) {
        throw createError('owner_auth_already_unbound', 'This binding was already unbound.', 409);
      }
      const now = nowIso(clock);
      const changed = binding.publicEndpoint !== publicEndpoint;
      binding.publicEndpoint = publicEndpoint;
      binding.instancePublicKey = instance.publicKey;
      binding.instanceKeyFingerprint = instance.keyFingerprint;
      return {
        instanceId: instance.instanceId,
        accountId,
        publicEndpoint,
        updatedAt: now,
        changed,
      };
    });
    audit({
      event: 'device.endpoint_published',
      instanceId: result.instanceId,
      accountId: result.accountId,
      changed: result.changed,
    });
    return result;
  }

  // Older bindings may have no endpoint and may predate persistence of the
  // instance key. Refreshing identity is independent from publishing an
  // address, so private computers can become rendezvous-discoverable too.
  async function publishInstanceIdentity(input) {
    const { instance, accountId } = normalizeDeviceOpInput(input, 'publish-identity', clock);
    const result = await store.mutate(async (draft) => {
      const binding = assertBoundAccount(draft, instance, accountId);
      if (binding.revokedAt) {
        throw createError('owner_auth_already_unbound', 'This binding was already unbound.', 409);
      }
      const now = nowIso(clock);
      const changed = binding.instancePublicKey !== instance.publicKey
        || binding.instanceKeyFingerprint !== instance.keyFingerprint;
      binding.instancePublicKey = instance.publicKey;
      binding.instanceKeyFingerprint = instance.keyFingerprint;
      return {
        instanceId: instance.instanceId,
        accountId,
        instancePublicKey: instance.publicKey,
        instanceKeyFingerprint: instance.keyFingerprint,
        updatedAt: now,
        changed,
      };
    });
    audit({
      event: 'device.identity_published',
      instanceId: result.instanceId,
      accountId: result.accountId,
      changed: result.changed,
    });
    return result;
  }

  function projectAccountDeviceDirectory(draft, accountId, { localInstanceId = '' } = {}) {
    const nowMs = clock();
    pruneUnrefreshableAccountPhoneSessions(draft, accountId, nowMs);
    const activePhoneIds = activeAccountPhoneSessionIds(draft, accountId, nowMs);
    const hasAccountSessionDevices = getAccountDevices(draft).some((item) => item.accountId === accountId);
    const phoneLinks = completedTurnPhoneLinks(draft, accountId);
    const isCurrentPhone = (device) => {
      if (!hasAccountSessionDevices) return true;
      if (activePhoneIds.has(device.deviceId)) return true;
      const linkedIds = new Set((phoneLinks.get(JSON.stringify([device.instanceId, device.deviceId])) || [])
        .map((link) => link.phoneId));
      return linkedIds.size === 1 && activePhoneIds.has([...linkedIds][0]);
    };
    const bindings = getInstanceBindings(draft);
    const devices = getDevices(draft)
      .filter((item) => item.accountId === accountId && !item.unboundAt
        && !bindings.find((binding) => binding.instanceId === item.instanceId)?.revokedAt
        && (effectiveDeviceKind(item) !== 'phone' || isCurrentPhone(item)))
      .map((device) => {
        const deviceBinding = bindings.find((item) => item.instanceId === device.instanceId);
        return {
          deviceId: device.deviceId,
          instanceId: device.instanceId,
          alias: device.alias || deviceBinding?.deviceAlias || '',
          sub: device.accountId,
          deviceKind: effectiveDeviceKind(device),
          endpoint: deviceBinding?.publicEndpoint || null,
          ...(deviceBinding?.instancePublicKey ? { instancePublicKey: deviceBinding.instancePublicKey } : {}),
          ...(deviceBinding?.instanceKeyFingerprint ? { instanceKeyFingerprint: deviceBinding.instanceKeyFingerprint } : {}),
          boundAt: deviceBinding?.boundAt || device.createdAt,
          unboundAt: device.unboundAt || deviceBinding?.revokedAt || null,
          lastSeenAt: device.lastSeenAt || deviceBinding?.lastSeenAt || deviceBinding?.boundAt || device.createdAt,
          ...(localInstanceId ? { source: device.instanceId === localInstanceId ? 'local' : 'remote' } : {}),
        };
      })
      .sort((a, b) => String(a.boundAt).localeCompare(String(b.boundAt)));
    const knownDeviceIds = new Set(devices.map((device) => device.deviceId));
    // Account-session phones have an `adev_` identity and intentionally do
    // not create a target-local trusted-device row. Include them directly so
    // the account directory includes only devices with a live login session.
    for (const accountDevice of getAccountDevices(draft)
      .filter((item) => item.accountId === accountId && !item.unboundAt && !item.revokedAt
        && activePhoneIds.has(item.deviceId))) {
      if (knownDeviceIds.has(accountDevice.deviceId)) continue;
      devices.push({
        deviceId: accountDevice.deviceId,
        instanceId: accountDevice.deviceId,
        alias: accountDevice.alias || 'Android device',
        sub: accountId,
        deviceKind: 'phone',
        endpoint: null,
        boundAt: accountDevice.createdAt || null,
        unboundAt: accountDevice.unboundAt || accountDevice.revokedAt || null,
        lastSeenAt: accountDevice.lastSeenAt || accountDevice.createdAt || null,
        ...(localInstanceId ? { source: accountDevice.deviceId === localInstanceId ? 'local' : 'remote' } : {}),
      });
    }
    // A v2 account-bound computer may have an instance binding before a
    // legacy trusted-device row exists. Project the binding as a computer so
    // account-based clients can still manage every bound endpoint.
    for (const binding of getInstanceBindings(draft)
      .filter((item) => item.accountId === accountId && !item.revokedAt)) {
      if (knownDeviceIds.has(binding.instanceId)) continue;
      devices.push({
        deviceId: binding.instanceId,
        instanceId: binding.instanceId,
        alias: binding.deviceAlias || 'Ragent computer',
        sub: accountId,
        deviceKind: 'computer',
        endpoint: binding.publicEndpoint || null,
        ...(binding.instancePublicKey ? { instancePublicKey: binding.instancePublicKey } : {}),
        ...(binding.instanceKeyFingerprint ? { instanceKeyFingerprint: binding.instanceKeyFingerprint } : {}),
        boundAt: binding.boundAt || null,
        unboundAt: binding.revokedAt || null,
        lastSeenAt: binding.lastSeenAt || binding.boundAt || null,
        ...(localInstanceId ? { source: binding.instanceId === localInstanceId ? 'local' : 'remote' } : {}),
      });
    }
    devices.sort((a, b) => String(a.boundAt).localeCompare(String(b.boundAt)));
    const syncCatalog = getAccountSyncCatalog(draft)
      .filter((entry) => entry.accountId === accountId)
      .map((entry) => ({
        scope: entry.scope,
        key: entry.key,
        version: entry.version,
        sourceInstanceId: entry.sourceInstanceId,
        ...(entry.deletedAt ? { deletedAt: entry.deletedAt } : {}),
      }))
      .sort((left, right) => `${left.scope}:${left.key}`.localeCompare(`${right.scope}:${right.key}`));
    const entitlement = resolveEntitlement(draft, accountId, clock());
    const registeredPhones = hasAccountSessionDevices
      ? activePhoneIds.size : registeredDeviceCount(draft, accountId, 'phone');
    const registeredComputers = registeredDeviceCount(draft, accountId, 'computer');
    const activeConnections = activeAccountTurnConnectionState(draft, accountId, nowMs);
    return {
      devices,
      syncCatalog,
      quota: {
        plan: entitlement.plan,
        limits: entitlement.limits,
        activePhones: activeConnections.activePhoneDeviceIds.length,
        activeComputers: activeConnections.activeInstanceIds.length,
        registeredPhones,
        registeredComputers,
        grandfathered: false,
      },
    };
  }

  async function listAccountDirectoryDevices({ credential: rawCredential = '' } = {}) {
    const result = await store.mutate(async (draft) => {
      const authenticated = authenticateAccountCredential(draft, rawCredential, 'account-directory');
      return projectAccountDeviceDirectory(draft, authenticated.credential.accountId);
    });
    audit({ event: 'account_directory.devices_listed', count: result.devices.length });
    return result;
  }

  // Account identity comes exclusively from the authenticated RAC, never a
  // query/body accountId. Read the same snapshot and policy as TURN admission.
  async function getAccountUsage({ credential: rawCredential = '' } = {}) {
    return store.mutate(async (draft) => {
      const authenticated = authenticateAccountCredential(draft, rawCredential, 'account-directory');
      const now = clock();
      const accountId = authenticated.credential.accountId;
      pruneUnrefreshableAccountPhoneSessions(draft, accountId, now);
      const entitlement = resolveEntitlement(draft, accountId, now);
      const active = activeAccountTurnConnectionState(draft, accountId, now);
      const used = { phones: active.activePhoneDeviceIds.length, computers: active.activeInstanceIds.length };
      return {
        contractVersion: 2,
        asOf: new Date(now).toISOString(),
        subscription: { plan: entitlement.plan, status: entitlement.status, source: entitlement.source, expiresAt: entitlement.expiresAt || null },
        turn: {
          policyVersion: TURN_AUTHORIZATION_POLICY_VERSION,
          counting: 'concurrent-logical-endpoints',
          limits: entitlement.limits,
          used,
          remaining: { phones: Math.max(0, entitlement.limits.phones - used.phones),
            computers: Math.max(0, entitlement.limits.computers - used.computers) },
          overLimit: { phones: used.phones > entitlement.limits.phones, computers: used.computers > entitlement.limits.computers },
          connections: { active: active.leases.length,
            reserved: active.leases.filter((lease) => lease.status === 'reserved').length,
            connected: active.leases.filter((lease) => lease.status === 'connected').length },
        },
      };
    });
  }

  async function authenticateAccountAsr({ credential: rawCredential = '' } = {}) {
    const token = trimString(rawCredential);
    if (typeof store.readAccountAsrSnapshot === 'function' && /^rac_[A-Za-z0-9_-]{32,}$/.test(token)) {
      const draft = await store.readAccountAsrSnapshot({ tokenHash: hashSecret(token) });
      const authenticated = authenticateAccountCredential(draft, token, 'account-directory', { touchActivity: false });
      const entitlement = resolveEntitlement(draft, authenticated.credential.accountId, clock());
      return { accountId: authenticated.credential.accountId, deviceId: authenticated.credential.deviceId,
        plan: entitlement.plan };
    }
    return store.mutate((draft) => {
      const authenticated = authenticateAccountCredential(draft, token, 'account-directory', { touchActivity: false });
      const entitlement = resolveEntitlement(draft, authenticated.credential.accountId, clock());
      return { accountId: authenticated.credential.accountId, deviceId: authenticated.credential.deviceId,
        plan: entitlement.plan };
    });
  }

  // A signed instance proof selects the bound account; this is a policy hint,
  // while every actual upload still requires its own atomic reservation.
  async function getAccountFileUploadPolicy(input) {
    const normalized = normalizeAccountFileUploadQuotaInput(input, 'policy', clock);
    return store.mutate((draft) => {
      assertBoundAccount(draft, normalized.instance, normalized.accountId);
      assertAccountNotDeleting(draft, normalized.accountId);
      assertDemoAccount(draft, normalized.accountId, normalized.instance.instanceId);
      const entitlement = resolveEntitlement(draft, normalized.accountId, clock());
      return { contractVersion: 2, policyVersion: ACCOUNT_FILE_UPLOAD_POLICY_VERSION,
        limits: resolveAccountFileUploadLimits(entitlement.plan) };
    });
  }

  async function reserveAccountFileUpload(input) {
    const normalized = normalizeAccountFileUploadQuotaInput(input, 'reserve', clock);
    const result = await store.mutate(async (draft) => {
      assertBoundAccount(draft, normalized.instance, normalized.accountId);
      assertAccountNotDeleting(draft, normalized.accountId);
      assertDemoAccount(draft, normalized.accountId, normalized.instance.instanceId);
      const now = clock();
      const entitlement = resolveEntitlement(draft, normalized.accountId, now);
      const limits = resolveAccountFileUploadLimits(entitlement.plan);
      if (normalized.sizeBytes > limits.maxFileBytes) {
        throw createError('account_file_upload_file_limit', 'This account plan limits each file to 50 MiB.', 413);
      }
      const rows = getAccountFileUploads(draft);
      let existing = rows.find((item) => item.accountId === normalized.accountId && item.requestId === normalized.requestId);
      if (existing && (existing.instanceId !== normalized.instance.instanceId
        || existing.quotaBatchId !== normalized.quotaBatchId
        || existing.sizeBytes !== normalized.sizeBytes || existing.sha256 !== normalized.sha256)) {
        throw createError('account_file_upload_identity_conflict', 'Upload identity was already used for different file data.', 409);
      }
      if (existing?.status === 'committed') {
        return { tracked: true, duplicate: true, limits,
          ...accountFileUploadUsage(draft, normalized.accountId, normalized.quotaBatchId, now) };
      }
      if (existing?.status === 'reserved' && Date.parse(existing.reservedUntil || '') > now) {
        return { tracked: true, duplicate: true, limits,
          ...accountFileUploadUsage(draft, normalized.accountId, normalized.quotaBatchId, now) };
      }
      const usage = accountFileUploadUsage(draft, normalized.accountId, normalized.quotaBatchId, now);
      if (!limits.unlimited && usage.usedBytes + usage.reservedBytes + normalized.sizeBytes > limits.maxTotalBytes) {
        throw createError('account_file_upload_total_limit', 'This message exceeds the 100 MiB attachment limit.', 429);
      }
      const timestamp = new Date(now).toISOString();
      if (existing) {
        Object.assign(existing, { quotaBatchId: normalized.quotaBatchId, status: 'reserved',
          reservedUntil: new Date(now + ACCOUNT_FILE_UPLOAD_RESERVATION_TTL_MS).toISOString(), updatedAt: timestamp });
      } else {
        existing = { accountId: normalized.accountId, requestId: normalized.requestId,
          instanceId: normalized.instance.instanceId, quotaBatchId: normalized.quotaBatchId,
          sizeBytes: normalized.sizeBytes, sha256: normalized.sha256,
          status: 'reserved', reservedUntil: new Date(now + ACCOUNT_FILE_UPLOAD_RESERVATION_TTL_MS).toISOString(),
          createdAt: timestamp, updatedAt: timestamp };
        rows.push(existing);
      }
      return { tracked: true, duplicate: false, limits,
        ...accountFileUploadUsage(draft, normalized.accountId, normalized.quotaBatchId, now) };
    });
    audit({ event: 'account_file_upload.reserved', accountId: normalized.accountId,
      instanceId: normalized.instance.instanceId, sizeBytes: normalized.sizeBytes, duplicate: result.duplicate });
    return { contractVersion: 2, policyVersion: ACCOUNT_FILE_UPLOAD_POLICY_VERSION, ...result };
  }

  async function completeAccountFileUpload(input) {
    const normalized = normalizeAccountFileUploadQuotaInput(input, 'complete', clock);
    const result = await store.mutate(async (draft) => {
      assertBoundAccount(draft, normalized.instance, normalized.accountId);
      assertAccountNotDeleting(draft, normalized.accountId);
      assertDemoAccount(draft, normalized.accountId, normalized.instance.instanceId);
      const now = clock();
      const entitlement = resolveEntitlement(draft, normalized.accountId, now);
      const limits = resolveAccountFileUploadLimits(entitlement.plan);
      const row = getAccountFileUploads(draft).find((item) => item.accountId === normalized.accountId
        && item.requestId === normalized.requestId);
      if (!row) return { tracked: false, limits,
        ...accountFileUploadUsage(draft, normalized.accountId, normalized.quotaBatchId, now) };
      if (row.instanceId !== normalized.instance.instanceId || row.quotaBatchId !== normalized.quotaBatchId
        || row.sizeBytes !== normalized.sizeBytes || row.sha256 !== normalized.sha256) {
        throw createError('account_file_upload_identity_conflict', 'Upload identity was already used for different file data.', 409);
      }
      if (row.status !== 'committed') {
        const usage = accountFileUploadUsage(draft, normalized.accountId, normalized.quotaBatchId, now);
        const activeReservation = Date.parse(row.reservedUntil || '') > now;
        const usedAfter = usage.usedBytes + Math.max(0, usage.reservedBytes - (activeReservation ? normalized.sizeBytes : 0))
          + normalized.sizeBytes;
        if (!limits.unlimited && (normalized.sizeBytes > limits.maxFileBytes || usedAfter > limits.maxTotalBytes)) {
          throw createError('account_file_upload_total_limit', 'This message exceeds the 100 MiB attachment limit.', 429);
        }
        row.status = 'committed';
        row.reservedUntil = '';
        row.updatedAt = new Date(now).toISOString();
      }
      return { tracked: true, limits,
        ...accountFileUploadUsage(draft, normalized.accountId, normalized.quotaBatchId, now) };
    });
    audit({ event: 'account_file_upload.completed', accountId: normalized.accountId,
      instanceId: normalized.instance.instanceId, sizeBytes: normalized.sizeBytes, tracked: result.tracked });
    return { contractVersion: 2, policyVersion: ACCOUNT_FILE_UPLOAD_POLICY_VERSION, ...result };
  }

  async function releaseAccountFileUpload(input) {
    const normalized = normalizeAccountFileUploadQuotaInput(input, 'release', clock);
    const result = await store.mutate(async (draft) => {
      assertBoundAccount(draft, normalized.instance, normalized.accountId);
      const now = clock();
      const row = getAccountFileUploads(draft).find((item) => item.accountId === normalized.accountId
        && item.requestId === normalized.requestId);
      const released = Boolean(row && row.instanceId === normalized.instance.instanceId && row.status === 'reserved'
        && row.quotaBatchId === normalized.quotaBatchId
        && row.sizeBytes === normalized.sizeBytes && row.sha256 === normalized.sha256);
      if (released) {
        row.reservedUntil = new Date(now).toISOString();
        row.updatedAt = new Date(now).toISOString();
      }
      return { released };
    });
    return { contractVersion: 2, policyVersion: ACCOUNT_FILE_UPLOAD_POLICY_VERSION, ...result };
  }

  async function listOwnTurnConnections({ credential = '', afterConnectionId = '', limit = 100 } = {}) {
    if ((afterConnectionId && (!isTurnLeaseId(afterConnectionId) || afterConnectionId !== trimString(afterConnectionId)))
      || !Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100) {
      throw createError('turn_phone_inventory_invalid', 'Invalid phone lease cursor or limit.', 400);
    }
    const inventory = (draft, nowMs = clock()) => {
      const authenticated = authenticateAccountCredential(draft, credential, 'account-directory');
      const { accountId, deviceId } = authenticated.credential;
      const links = completedTurnPhoneLinks(draft, accountId);
      const owned = getTurnConnectionLeases(draft).filter(lease => isActiveTurnConnectionLease(lease, nowMs)
        && isOwnedPhoneTurnLease(lease, accountId, deviceId, links));
      const pending = owned.filter(lease => isTurnLeaseId(lease.connectionId) && lease.connectionId > afterConnectionId)
        .sort((left, right) => left.connectionId < right.connectionId ? -1 : left.connectionId > right.connectionId ? 1 : 0);
      const page = pending.slice(0, Number(limit));
      return { contractVersion: 1, accountId, deviceId, asOf: new Date(nowMs).toISOString(),
        connections: page.map(lease => ({ connectionId: lease.connectionId, instanceId: lease.instanceId,
          deviceId: lease.deviceId, expiresAt: lease.expiresAt })),
        nextCursor: pending.length > page.length ? page.at(-1).connectionId : null,
        legacyConnections: owned.filter(lease => !isTurnLeaseId(lease.connectionId)).length };
    };
    const token = trimString(credential);
    if (typeof store.readPhoneTurnInventorySnapshot === 'function' && /^rac_[A-Za-z0-9_-]{32,}$/.test(token)) {
      const nowMs = clock();
      const draft = await store.readPhoneTurnInventorySnapshot({ tokenHash: hashSecret(token), now: nowMs });
      const before = JSON.stringify([draft.accountCredentials, draft.accountDevices]);
      const result = inventory(draft, nowMs);
      // Keep the existing presence-update semantics. The rare due update goes
      // through the authoritative writer and revalidates all credentials.
      if (before === JSON.stringify([draft.accountCredentials, draft.accountDevices])) return result;
    }
    return store.mutate(inventory);
  }

  async function releaseOwnTurnConnections({ credential = '', connectionIds, reason = 'client-release' } = {}) {
    if (!Array.isArray(connectionIds) || connectionIds.length < 1 || connectionIds.length > 100
      || connectionIds.some(id => typeof id !== 'string' || id !== trimString(id) || !isTurnLeaseId(id))
      || !['client-release', 'cold-process-recovery'].includes(reason)) {
      throw createError('turn_phone_release_invalid', 'One to one hundred exact reservation IDs and a valid reason are required.', 400);
    }
    const ids = new Set(connectionIds);
    const result = await store.mutate(draft => {
      const authenticated = authenticateAccountCredential(draft, credential, 'account-directory');
      const { accountId, deviceId } = authenticated.credential, nowMs = clock();
      const links = completedTurnPhoneLinks(draft, accountId);
      let releasedConnections = 0;
      for (const lease of getTurnConnectionLeases(draft)) {
        if (!ids.has(lease.connectionId) || !isActiveTurnConnectionLease(lease, nowMs)
          || !isOwnedPhoneTurnLease(lease, accountId, deviceId, links)) continue;
        const now = new Date(Math.max(nowMs, turnLeaseObservedAt(lease))).toISOString();
        Object.assign(lease, { status: 'released', updatedAt: now, releasedAt: now, releaseReason: reason });
        releasedConnections++;
      }
      return { contractVersion: 1, accountId, deviceId, processedConnections: ids.size, releasedConnections };
    });
    audit({ event: 'turn.phone_leases_released', accountId: result.accountId, deviceId: result.deviceId,
      count: result.releasedConnections, reason });
    return result;
  }

  async function renameAccountDirectoryDevice({ deviceId: rawDeviceId = '', alias: rawAlias = '', credential: rawCredential = '' } = {}) {
    const deviceId = trimString(rawDeviceId);
    const alias = normalizeDeviceAlias(rawAlias);
    if (!deviceId || !alias || /[\u0000-\u001f\u007f]/.test(alias)) {
      throw createError('owner_auth_account_device_alias_invalid', 'A valid device id and name are required.', 400);
    }
    const result = await store.mutate(async (draft) => {
      const authenticated = authenticateAccountCredential(draft, rawCredential, 'account-directory');
      const accountId = authenticated.credential.accountId;
      const phone = getAccountDevices(draft).find((item) => item.deviceId === deviceId && item.accountId === accountId);
      const binding = getInstanceBindings(draft).find((item) => item.instanceId === deviceId && item.accountId === accountId);
      const device = getDevices(draft).find((item) => item.deviceId === deviceId && item.accountId === accountId);
      if (!phone && !binding && !device) throw createError('owner_auth_account_device_not_found', 'Account device was not found.', 404);
      if (phone?.revokedAt || phone?.unboundAt || binding?.revokedAt || device?.unboundAt) {
        throw createError('owner_auth_account_device_inactive', 'This account device is no longer bound.', 409);
      }
      if (phone) phone.alias = alias;
      if (binding) binding.deviceAlias = alias;
      if (device) device.alias = alias;
      return { renamed: true, deviceId, alias };
    });
    audit({ event: 'account_directory.device_renamed', deviceId: result.deviceId });
    return result;
  }

  function removeAccountPhoneAssociation(draft, accountId, deviceId, now) {
    const credentialIds = new Set(getAccountCredentials(draft)
      .filter((item) => item.accountId === accountId && item.deviceId === deviceId).map((item) => item.credentialId));
    const linkedGrants = getAccountJoinGrants(draft)
      .filter((item) => item.accountId === accountId && item.accountDeviceId === deviceId);
    const grantIntentIds = new Set(linkedGrants.map((item) => item.intentId));
    const linkedIntents = getAccountJoinIntents(draft)
      .filter((item) => item.accountId === accountId && (item.accountDeviceId === deviceId || grantIntentIds.has(item.intentId)));
    const intentIds = new Set(linkedIntents.map((item) => item.intentId));
    const linkedLegacyDevices = new Set([...linkedIntents, ...linkedGrants]
      .map((item) => JSON.stringify([item.instanceId, item.deviceId])));
    const releasedConnections = releaseRevokedPhoneTurnConnections(draft, { accountId, deviceId, nowMs: new Date(now).getTime() });
    draft.accountJoinGrants = getAccountJoinGrants(draft).filter((grant) =>
      !(grant.accountId === accountId && grant.accountDeviceId === deviceId) && !intentIds.has(grant.intentId));
    draft.accountJoinIntents = getAccountJoinIntents(draft).filter((intent) => !intentIds.has(intent.intentId));
    draft.devices = getDevices(draft).filter((item) => item.accountId !== accountId
      || !linkedLegacyDevices.has(JSON.stringify([item.instanceId, item.deviceId])));
    draft.accountCredentialRefreshes = getAccountCredentialRefreshes(draft).filter((refresh) => !credentialIds.has(refresh.credentialId));
    draft.accountCredentials = getAccountCredentials(draft).filter((item) => !(item.accountId === accountId && item.deviceId === deviceId));
    draft.accountDeviceKeys = getAccountDeviceKeys(draft).filter((item) => !(item.accountId === accountId && item.deviceId === deviceId));
    draft.accountDevices = getAccountDevices(draft).filter((item) => !(item.accountId === accountId && item.deviceId === deviceId));
    draft.accountSessionChallenges = getAccountSessionChallenges(draft).filter((item) => item.deviceId !== deviceId);
    return releasedConnections;
  }

  function pruneUnrefreshableAccountPhoneSessions(draft, accountId, nowMs) {
    const devices = getAccountDevices(draft).filter((item) => item.accountId === accountId);
    const credentials = getAccountCredentials(draft);
    const keys = getAccountDeviceKeys(draft);
    let removed = 0;
    for (const device of devices) {
      const canRefresh = credentials.some((credential) => {
        if (credential?.accountId !== accountId || credential.deviceId !== device.deviceId || credential.revokedAt) return false;
        const expiresAt = Date.parse(credential.expiresAt || '');
        if (!Number.isFinite(expiresAt) || expiresAt + ACCOUNT_CREDENTIAL_TTL_MS <= nowMs) return false;
        const key = keys.find((item) => item.keyId === credential.keyId);
        return !device.revokedAt && !device.unboundAt && key && key.accountId === accountId
          && key.deviceId === device.deviceId && !key.revokedAt;
      });
      if (canRefresh) continue;
      removeAccountPhoneAssociation(draft, accountId, device.deviceId, new Date(nowMs).toISOString());
      removed++;
    }
    return removed;
  }

  async function logoutAccountSession({ credential: rawCredential = '' } = {}) {
    const result = await store.mutate(async (draft) => {
      const authenticated = authenticateAccountCredential(draft, rawCredential, 'account-directory');
      const now = nowIso(clock);
      const accountId = authenticated.credential.accountId;
      const deviceId = authenticated.device.deviceId;
      const releasedConnections = removeAccountPhoneAssociation(draft, accountId, deviceId, now);
      return {
        accountId,
        deviceId,
        credentialId: authenticated.credential.credentialId,
        unboundAt: now,
        releasedConnections,
      };
    });
    audit({
      event: 'account_session.logged_out',
      accountId: result.accountId,
      deviceId: result.deviceId,
      credentialId: result.credentialId,
    });
    return { contractVersion: 2, loggedOut: true, ...result };
  }

  async function revokeAccountDirectoryDevice({ deviceId: rawDeviceId = '', credential: rawCredential = '' } = {}) {
    const deviceId = trimString(rawDeviceId);
    if (!deviceId) throw createError('owner_auth_account_device_invalid', 'Account device id is required.', 400);
    const result = await store.mutate(async (draft) => {
      const authenticated = authenticateAccountCredential(draft, rawCredential, 'account-directory');
      const accountId = authenticated.credential.accountId;
      const now = nowIso(clock);
      const accountDevice = getAccountDevices(draft).find((item) => item.deviceId === deviceId
        && item.accountId === accountId);
      if (accountDevice) {
        const releasedConnections = removeAccountPhoneAssociation(draft, accountId, deviceId, now);
        return { revoked: true, deviceId, accountId, deviceKind: 'phone', revokedAt: now, releasedConnections };
      }
      const binding = getInstanceBindings(draft).find((item) => item.instanceId === deviceId
        && item.accountId === accountId);
      if (!binding) throw createError('owner_auth_account_device_not_found', 'Account device was not found.', 404);
      const releasedConnections = removeAccountComputerAssociation(draft, accountId, deviceId, now);
      if (!binding.revokedAt) recordBindingEvent(draft, { instanceId: deviceId, accountId, action: 'unbind', now });
      return { revoked: true, deviceId, accountId, deviceKind: 'computer', revokedAt: now, releasedConnections };
    });
    audit({ event: 'account_directory.device_revoked', deviceId: result.deviceId, accountId: result.accountId, deviceKind: result.deviceKind });
    return result;
  }

  async function listDevices(input) {
    const { instance, accountId } = normalizeDeviceOpInput(input, 'devices', clock);
    const result = await store.mutate(async (draft) => {
      assertBoundAccount(draft, instance, accountId);
      return projectAccountDeviceDirectory(draft, accountId, { localInstanceId: instance.instanceId });
    });
    audit({ event: 'devices.listed', instanceId: instance.instanceId, accountId, count: result.devices.length });
    return result;
  }

  function normalizeTurnConnectionInput(input, purpose) {
    const requestId = trimString(input?.requestId);
    const instance = validateDeviceOpInstance(input, {
      transactionId: requestId,
      purpose,
      clock,
    });
    const accountId = trimString(input?.accountId);
    const deviceId = trimString(input?.deviceId);
    const connectionId = trimString(input?.connectionId);
    const deviceKind = normalizeTurnDeviceKind(input?.deviceKind, 'phone');
    if (!accountId || !deviceId || !connectionId || !deviceKind) {
      throw createError('turn_connection_request_invalid', 'TURN connection identity is incomplete.', 400);
    }
    const expectedConnectionId = createTurnConnectionId({
      accountId,
      instanceId: instance.instanceId,
      deviceId,
    });
    const protocolVersion = input?.protocolVersion === 3 ? 3 : input?.protocolVersion === 2 ? 2 : 1;
    if (!expectedConnectionId || (protocolVersion >= 2
      ? !matchesTurnLeasePair(connectionId, expectedConnectionId) : expectedConnectionId !== connectionId)) {
      throw createError('turn_connection_identity_invalid', 'TURN connection identity is invalid.', 400);
    }
    const expectedRequestId = protocolVersion >= 2 ? createTurnOperationRequestId({ purpose, protocolVersion,
      accountId, instanceId: instance.instanceId, deviceId, deviceKind, connectionId,
      expiresAt: input?.expiresAt, reason: input?.reason }) : connectionId;
    if (requestId !== expectedRequestId) throw createError('turn_connection_proof_mismatch', 'TURN operation parameters differ from the signed proof.', 401);
    return { requestId, instance, accountId, deviceId, connectionId, deviceKind, protocolVersion };
  }

  function publicTurnLease(lease, authorization) {
    return {
      authorization: publicTurnAuthorization({ ...authorization, connectionId: lease.connectionId }),
      lease: {
        connectionId: lease.connectionId,
        accountId: lease.accountId,
        instanceId: lease.instanceId,
        deviceId: lease.deviceId,
        deviceKind: lease.deviceKind,
        status: lease.status,
        expiresAt: lease.expiresAt,
        ...(lease.handoffFrom ? { handoffFrom: lease.handoffFrom, handoffDeadline: lease.handoffDeadline,
          ...(lease.handoffCommittedAt ? { handoffCommittedAt: lease.handoffCommittedAt } : {}) } : {}),
      },
    };
  }

  function resolveTurnConnectionDevice(draft, { accountId, instanceId, deviceId, deviceKind }) {
    // Android v2 account joins deliberately do not create target-coupled rows
    // in `devices`. The completed intent (or, for pre-015 state, its redeemed
    // grant) is the durable link between rdev_ and the account phone adev_.
    if (deviceKind === 'phone') {
      const links = completedTurnPhoneLinks(draft, accountId).get(JSON.stringify([instanceId, deviceId])) || [];
      const phoneIds = new Set(links.map(link => link.phoneId));
      const activePhoneIds = activeAccountPhoneSessionIds(draft, accountId, clock());
      let linkedInactivePhone = false;
      // A historical incomplete link must not mask a later, valid completion
      // for the same fixed target/device. Each candidate still needs its own
      // durable phone link and a currently active account device.
      for (const { phoneId: accountDeviceId, intent } of links) {
        const accountDevice = accountDeviceId
          ? getAccountDevices(draft).find((entry) => entry.deviceId === accountDeviceId
            && entry.accountId === accountId && !entry.revokedAt)
          : null;
        if (phoneIds.size === 1 && accountDevice && activePhoneIds.has(accountDevice.deviceId)) {
          // Heal file-store snapshots created before migration 015. PostgreSQL
          // performs the same backfill in the migration itself.
          if (intent && !trimString(intent.accountDeviceId)) intent.accountDeviceId = accountDevice.deviceId;
          return { quotaDeviceId: accountDevice.deviceId };
        }
        if (phoneIds.size === 1 && accountDevice) linkedInactivePhone = true;
      }
      // A retained legacy row cannot override a known revoked/ambiguous link.
      if (linkedInactivePhone) {
        throw createError('turn_connection_phone_session_inactive', 'This phone no longer has an active account session.', 401);
      }
      if (links.length) throw createError('turn_connection_device_invalid', 'TURN device is not registered to this account.', 403);
    }
    const legacyDevice = getDevices(draft).find((entry) => entry.deviceId === deviceId);
    if (legacyDevice && legacyDevice.accountId === accountId && !legacyDevice.unboundAt
      && effectiveDeviceKind(legacyDevice) === deviceKind) {
      return { quotaDeviceId: deviceId };
    }

    throw createError('turn_connection_device_invalid', 'TURN device is not registered to this account.', 403);
  }

  async function reserveTurnConnection(input) {
    if (typeof signTurnBrokerCapability !== 'function') {
      throw createError('turn_broker_capability_unavailable', 'TURN capability signer is not configured.', 503);
    }
    const normalized = normalizeTurnConnectionInput(input, 'turn-reserve');
    const expiresMs = Date.parse(trimString(input?.expiresAt));
    if (!Number.isFinite(expiresMs) || expiresMs <= clock()) {
      throw createError('turn_connection_expiry_invalid', 'TURN connection expiry is invalid.', 400);
    }
    const result = await store.mutate(async (draft) => {
      assertBoundAccount(draft, normalized.instance, normalized.accountId);
      const nowMs = clock();
      pruneUnrefreshableAccountPhoneSessions(draft, normalized.accountId, nowMs);
      releaseInactiveAccountPhoneLeases(draft, normalized.accountId, nowMs);
      const { quotaDeviceId } = resolveTurnConnectionDevice(draft, {
        accountId: normalized.accountId,
        instanceId: normalized.instance.instanceId,
        deviceId: normalized.deviceId,
        deviceKind: normalized.deviceKind,
      });
      // Older snapshots stored the target rdev_ in quota_device_id. Recover
      // only uniquely completed, still-active account-phone associations.
      normalizeLegacyTurnQuotaPhones(draft, normalized.accountId, clock());
      const leases = pruneTurnLeases(getTurnConnectionLeases(draft), clock());
      draft.turnConnectionLeases = leases;
      const existing = leases.find((lease) => lease.connectionId === normalized.connectionId);
      expireTurnHandoffs(leases, clock());
      if (normalized.protocolVersion >= 2 && !existing && !canAdmitTurnLeaseId(normalized.connectionId, clock(), turnLeasePairClock(leases, normalized.connectionId, clock()))) {
        throw createError('turn_connection_generation_retired', 'TURN reservation admission window ended.', 409);
      }
      if (existing && (existing.accountId !== normalized.accountId
        || existing.instanceId !== normalized.instance.instanceId
        || existing.deviceId !== normalized.deviceId
        || existing.deviceKind !== normalized.deviceKind)) {
        throw createError('turn_connection_identity_conflict', 'TURN connection is bound to another identity.', 409);
      }
      const conflictingPair = leases.find((lease) => isActiveTurnConnectionLease(lease, clock())
        && lease.accountId === normalized.accountId
        && lease.instanceId === normalized.instance.instanceId
        && lease.deviceId === normalized.deviceId
        && lease.connectionId !== normalized.connectionId);
      if (conflictingPair && normalized.protocolVersion === 1) {
        throw createError('turn_connection_identity_conflict', 'The device pair already has an active TURN connection.', 409);
      }
      const active = activeAccountTurnConnectionState(draft, normalized.accountId, clock(), {
        excludeConnectionId: normalized.connectionId,
      });
      const entitlement = resolveEntitlement(draft, normalized.accountId, clock());
      const authorization = evaluateTurnConnectionAuthorization({
        accountId: normalized.accountId,
        instanceId: normalized.instance.instanceId,
        deviceId: normalized.deviceId,
        quotaDeviceId,
        accountPlan: entitlement.plan,
        deviceKind: normalized.deviceKind,
        limits: entitlement.limits,
        activeDeviceIds: normalized.deviceKind === 'phone'
          ? active.activePhoneDeviceIds
          : active.activeComputerDeviceIds,
        activeInstanceIds: active.activeInstanceIds,
        activePhones: active.activePhoneDeviceIds.length,
        activeComputers: active.activeInstanceIds.length,
        accountMatches: true,
        nowMs: clock(),
      });
      if (!authorization.authorized) {
        const error = createError(
          authorization.reasonCode,
          'TURN connection quota does not allow this device.',
          429,
        );
        error.details = publicTurnAuthorization(authorization);
        throw error;
      }
      if (normalized.protocolVersion >= 2) {
        const handoff = normalized.protocolVersion === 3
          ? /^handoff:(turn_[a-f0-9]{32}_[0-9]{13}_[a-f0-9]{32}):([0-9]{13})$/.exec(trimString(input?.reason)) : null;
        if (normalized.protocolVersion === 3 && !handoff) throw createError('turn_handoff_request_invalid', 'Invalid signed handoff request.', 400);
        if (existing && normalized.protocolVersion === 3 && existing.handoffFrom !== handoff[1]) {
          throw createError('turn_handoff_request_invalid', 'Handoff generation does not match.', 409);
        }
        if (existing && !isActiveTurnConnectionLease(existing, clock())) {
          throw createError('turn_connection_generation_retired', 'This TURN reservation has already ended.', 409);
        }
        // Sign before publishing or superseding any reservation. A signer
        // failure leaves the prior generation intact in the same transaction.
        // Repeating the exact ID can never move its original deadline.
        const deadline = existing ? Date.parse(existing.expiresAt) : Math.min(expiresMs, clock() + 30 * 60_000);
        const remaining = Math.floor((deadline - clock()) / 1000) * 1000;
        if (remaining < 1000) throw createError('turn_connection_expiry_invalid', 'TURN reservation has expired.', 409);
        let brokerCredential;
        try {
          brokerCredential = await issueTurnBrokerCapability({ signCapability: signTurnBrokerCapability, issuer,
            accountId: normalized.accountId, instanceId: normalized.instance.instanceId,
            deviceId: normalized.deviceId, connectionId: normalized.connectionId, nowMs: clock(), ttlMs: remaining });
        } catch (error) {
          if (error?.code?.startsWith('turn_broker_capability_')) throw error;
          throw createError('turn_broker_capability_unavailable', 'TURN capability could not be issued.', 503);
        }
        if (clock() >= deadline || Date.parse(brokerCredential.expiresAt) <= clock()
          || Date.parse(brokerCredential.expiresAt) > deadline) {
          throw createError('turn_broker_capability_expired', 'TURN capability expired before reservation completion.', 503);
        }
        if (!existing) {
          const now = new Date(turnLeasePairClock(leases, normalized.connectionId, clock())).toISOString();
          for (const previous of normalized.protocolVersion === 2 ? leases : []) {
            if (previous.accountId === normalized.accountId && previous.instanceId === normalized.instance.instanceId
              && previous.deviceKind === normalized.deviceKind
              && (previous.deviceId === normalized.deviceId || (normalized.deviceKind === 'phone' && previous.quotaDeviceId === quotaDeviceId))
              && isActiveTurnConnectionLease(previous, clock())) {
              const retiredAt = new Date(Math.max(Date.parse(now), turnLeaseObservedAt(previous))).toISOString();
              Object.assign(previous, { status: 'released', releasedAt: retiredAt, updatedAt: retiredAt, releaseReason: 'reservation-superseded' });
            }
          }
          const lease = { connectionId: normalized.connectionId, accountId: normalized.accountId,
            instanceId: normalized.instance.instanceId, deviceId: normalized.deviceId, deviceKind: normalized.deviceKind,
            quotaDeviceId, plan: authorization.plan, status: 'reserved', createdAt: now, updatedAt: now,
            expiresAt: new Date(deadline).toISOString(), releasedAt: '', releaseReason: '' };
          const reserved = handoff
            ? prepareTurnHandoff(leases, handoff[1], lease, clock(), new Date(Number(handoff[2])).toISOString())
            : (leases.push(lease), lease);
          return { ...publicTurnLease(reserved, authorization), brokerCredential };
        }
        existing.updatedAt = new Date(Math.max(clock(), turnLeaseObservedAt(existing))).toISOString();
        return { ...publicTurnLease(existing, authorization), brokerCredential };
      }
      const now = nowIso(clock);
      const lease = existing || {
        connectionId: normalized.connectionId,
        accountId: normalized.accountId,
        instanceId: normalized.instance.instanceId,
        deviceId: normalized.deviceId,
        deviceKind: normalized.deviceKind,
        plan: authorization.plan,
        status: 'reserved',
        createdAt: now,
        updatedAt: now,
        expiresAt: trimString(input.expiresAt),
        releasedAt: '',
      };
      lease.accountId = normalized.accountId;
      lease.instanceId = normalized.instance.instanceId;
      lease.deviceId = normalized.deviceId;
      lease.deviceKind = normalized.deviceKind;
      lease.quotaDeviceId = quotaDeviceId;
      lease.plan = authorization.plan;
      lease.status = 'reserved';
      lease.updatedAt = now;
      lease.expiresAt = trimString(input.expiresAt);
      lease.releasedAt = '';
      lease.releaseReason = '';
      if (!existing) leases.push(lease);
      return publicTurnLease(lease, authorization);
    });
    if (normalized.protocolVersion >= 2) {
      audit({ event: 'turn.connection.reserved', accountId: normalized.accountId,
        instanceId: normalized.instance.instanceId, deviceId: normalized.deviceId,
        connectionId: normalized.connectionId, plan: result.authorization.plan });
      return result;
    }
    try {
      const leaseExpiresAtMs = Date.parse(result.lease.expiresAt || '');
      const brokerCredential = await issueTurnBrokerCapability({
        signCapability: signTurnBrokerCapability,
        issuer,
        accountId: normalized.accountId,
        instanceId: normalized.instance.instanceId,
        deviceId: normalized.deviceId,
        connectionId: normalized.connectionId,
        nowMs: clock(),
        ttlMs: Math.max(1000, leaseExpiresAtMs - clock()),
      });
      audit({
        event: 'turn.connection.reserved',
        accountId: normalized.accountId,
        instanceId: normalized.instance.instanceId,
        deviceId: normalized.deviceId,
        connectionId: normalized.connectionId,
        plan: result.authorization.plan,
      });
      return { ...result, brokerCredential };
    } catch (error) {
      await store.mutate(async (draft) => {
        const lease = getTurnConnectionLeases(draft).find((entry) => (
          entry.connectionId === normalized.connectionId
          && entry.accountId === normalized.accountId
          && entry.instanceId === normalized.instance.instanceId
          && entry.deviceId === normalized.deviceId
          && isActiveTurnConnectionLease(entry, clock())
        ));
        if (lease) {
          const now = nowIso(clock);
          lease.status = 'released';
          lease.updatedAt = now;
          lease.releasedAt = now;
          lease.releaseReason = 'capability-signing-failed';
        }
      }).catch(() => {});
      if (error?.code?.startsWith('turn_broker_capability_')) throw error;
      throw createError('turn_broker_capability_unavailable', 'TURN capability could not be issued.', 503);
    }
  }

  async function releaseTurnConnection(input) {
    const normalized = normalizeTurnConnectionInput(input, 'turn-release');
    const result = await store.mutate(async (draft) => {
      assertBoundAccount(draft, normalized.instance, normalized.accountId);
      const lease = getTurnConnectionLeases(draft).find((entry) => (
        entry.connectionId === normalized.connectionId
        && entry.accountId === normalized.accountId
        && entry.instanceId === normalized.instance.instanceId
        && entry.deviceId === normalized.deviceId
      ));
      if (!lease || !isActiveTurnConnectionLease(lease, clock())) {
        return { released: false, connectionId: normalized.connectionId };
      }
      const now = normalized.protocolVersion >= 2 ? new Date(Math.max(clock(), turnLeaseObservedAt(lease))).toISOString() : nowIso(clock);
      lease.status = 'released';
      lease.updatedAt = now;
      lease.releasedAt = now;
      lease.releaseReason = trimString(input?.reason).slice(0, 128) || 'released';
      return { released: true, connectionId: normalized.connectionId, releasedAt: now };
    });
    audit({
      event: 'turn.connection.released',
      accountId: normalized.accountId,
      instanceId: normalized.instance.instanceId,
      deviceId: normalized.deviceId,
      connectionId: normalized.connectionId,
      released: result.released,
    });
    return result;
  }

  async function commitTurnConnectionHandoff(input) {
    const normalized = normalizeTurnConnectionInput(input, 'turn-handoff-commit');
    if (normalized.protocolVersion !== 3) throw createError('turn_handoff_request_invalid', 'Handoff protocol is required.', 400);
    return store.mutate(async (draft) => {
      assertBoundAccount(draft, normalized.instance, normalized.accountId);
      const now = clock();
      pruneUnrefreshableAccountPhoneSessions(draft, normalized.accountId, now);
      releaseInactiveAccountPhoneLeases(draft, normalized.accountId, now);
      resolveTurnConnectionDevice(draft, { ...normalized, instanceId: normalized.instance.instanceId });
      const leases = getTurnConnectionLeases(draft);
      const next = leases.find(lease => lease.connectionId === normalized.connectionId
        && lease.accountId === normalized.accountId && lease.instanceId === normalized.instance.instanceId
        && lease.deviceId === normalized.deviceId && lease.deviceKind === normalized.deviceKind);
      if (!next || !next.handoffFrom) throw createError('turn_handoff_commit_invalid', 'Handoff is unavailable.', 409);
      const old = leases.find(lease => lease.connectionId === next.handoffFrom);
      const observed = Math.max(clock(), turnLeaseObservedAt(next), old ? turnLeaseObservedAt(old) : 0);
      if (next.handoffCommittedAt && isActiveTurnConnectionLease(next, observed)) {
        return { committed: true, connectionId: next.connectionId, committedAt: next.handoffCommittedAt };
      }
      const committed = commitTurnHandoff(leases, normalized.connectionId, observed);
      return { committed: true, connectionId: committed.connectionId, committedAt: committed.handoffCommittedAt };
    });
  }

  async function authorizeProviderSync(input) {
    const requestId = trimString(input?.requestId);
    const targetInstanceId = trimString(input?.targetInstanceId);
    const source = validateProviderSyncPeer(input?.sourceProof, {
      requestId,
      targetInstanceId,
      clock,
    });
    const result = await store.mutate(async (draft) => {
      const bindings = getInstanceBindings(draft);
      const sourceBinding = bindings.find((item) => item.instanceId === source.instanceId && !item.revokedAt);
      const targetBinding = bindings.find((item) => item.instanceId === targetInstanceId && !item.revokedAt);
      if (!sourceBinding || !targetBinding) {
        throw createError('provider_sync_peer_unbound', 'Provider sync peer is not bound to this account.', 403);
      }
      if (sourceBinding.accountId !== targetBinding.accountId) {
        throw createError('provider_sync_account_mismatch', 'Provider sync peers belong to different accounts.', 403);
      }
      return {
        authorized: true,
        accountId: sourceBinding.accountId,
        sourceInstanceId: source.instanceId,
        sourcePublicKey: source.publicKey,
        targetInstanceId,
        expiresAt: new Date(clock() + 60 * 1000).toISOString(),
      };
    });
    audit({
      event: 'provider_sync.authorized',
      sourceInstanceId: result.sourceInstanceId,
      targetInstanceId: result.targetInstanceId,
    });
    return result;
  }

  async function publishAccountSyncCatalog(input) {
    const accountId = trimString(input?.accountId);
    if (!accountId) throw createError('account_sync_account_invalid', 'Account id is required.', 400);
    const source = validateAccountSyncCatalogPublisher(input, { accountId, clock });
    const entries = Array.isArray(input?.entries) ? input.entries : [];
    if (entries.length > 2048) throw createError('account_sync_catalog_too_large', 'Account sync catalog is too large.', 413);
    const result = await store.mutate(async (draft) => {
      const binding = getInstanceBindings(draft).find((item) => item.instanceId === source.instanceId && !item.revokedAt);
      if (!binding || binding.accountId !== accountId) {
        throw createError('account_sync_peer_unbound', 'Sync publisher is not bound to this account.', 403);
      }
      const catalog = getAccountSyncCatalog(draft);
      const accepted = [];
      const ignored = [];
      for (const rawEntry of entries) {
        let entry;
        try {
          entry = normalizeAccountSyncCatalogEntry(rawEntry, source.instanceId);
        } catch {
          throw createError('account_sync_catalog_invalid', 'Account sync catalog entry is invalid.', 400);
        }
        const identity = `${entry.scope}:${entry.key}`;
        const index = catalog.findIndex((item) => item.accountId === accountId
          && item.scope === entry.scope && item.key === entry.key);
        const prior = index >= 0 ? catalog[index] : null;
        if (!prior || compareSyncVersions(entry.version, prior.version) > 0) {
          const next = {
            accountId,
            scope: entry.scope,
            key: entry.key,
            version: entry.version,
            sourceInstanceId: source.instanceId,
            ...(entry.deletedAt ? { deletedAt: entry.deletedAt } : {}),
            updatedAt: nowIso(clock),
          };
          if (index >= 0) catalog[index] = next;
          else catalog.push(next);
          accepted.push(identity);
        } else {
          ignored.push(identity);
        }
      }
      return {
        accountId,
        accepted,
        ignored,
        catalog: catalog
          .filter((entry) => entry.accountId === accountId)
          .map((entry) => ({
            scope: entry.scope,
            key: entry.key,
            version: entry.version,
            sourceInstanceId: entry.sourceInstanceId,
            ...(entry.deletedAt ? { deletedAt: entry.deletedAt } : {}),
          }))
          .sort((left, right) => `${left.scope}:${left.key}`.localeCompare(`${right.scope}:${right.key}`)),
      };
    });
    audit({
      event: 'account_sync_catalog.published',
      accountId,
      sourceInstanceId: source.instanceId,
      accepted: result.accepted.length,
      ignored: result.ignored.length,
    });
    return result;
  }

  async function discoverInstances(input, { credential: rawCredential = '' } = {}) {
    const idToken = trimString(input?.idToken);
    const hasCredential = Boolean(trimString(rawCredential));
    if (hasCredential && idToken) {
      throw createError('owner_auth_credential_mode_conflict', 'Use either an account session credential or a Google ID token, not both.', 400);
    }
    if (!hasCredential && !idToken) throw createError('owner_auth_request_invalid', 'Missing account credential.', 400);
    const result = await store.mutate(async (draft) => {
      let accountId = '';
      if (hasCredential) {
        accountId = authenticateAccountCredential(draft, rawCredential, 'account-directory').credential.accountId;
      } else {
        const googleIdentity = await verifyNativeGoogleCredential({ idToken });
        const account = await resolveAccount({
          draft,
          googleIdentity: {
            ...googleIdentity,
            providerSubject: trimString(googleIdentity?.providerSubject || googleIdentity?.sub),
          },
        });
        accountId = trimString(account?.accountId || account?.id);
      }
      if (!accountId) throw createError('owner_auth_account_invalid', 'Unable to resolve Account identity.', 502);
      const bindings = getInstanceBindings(draft);
      const devices = getDevices(draft);
      const instances = bindings
        .filter((binding) => binding.accountId === accountId && !binding.revokedAt)
        .map((binding) => {
          const device = devices.find((entry) => entry.instanceId === binding.instanceId && entry.accountId === accountId);
          const rendezvousReady = hasRendezvousIdentity(binding);
          return {
            instanceId: binding.instanceId,
            alias: binding.deviceAlias || device?.alias || 'Ragent computer',
            endpoint: binding.publicEndpoint || null,
            ...(rendezvousReady ? {
              instancePublicKey: binding.instancePublicKey,
              instanceKeyFingerprint: binding.instanceKeyFingerprint,
            } : {}),
            boundAt: binding.boundAt || device?.createdAt || null,
            lastSeenAt: device?.lastSeenAt || binding.lastSeenAt || binding.boundAt || null,
            canTakeOver: rendezvousReady,
          };
        })
        .sort((left, right) => String(left.alias).localeCompare(String(right.alias)));
      if (accountId === demoAccountAuth?.accountId) {
        instances.sort((a, b) => Number(b.instanceId === demoAccountAuth.defaultInstanceId)
          - Number(a.instanceId === demoAccountAuth.defaultInstanceId));
      }
      const entitlement = resolveEntitlement(draft, accountId, clock());
      const activeConnections = activeAccountTurnConnectionState(draft, accountId, clock());
      return {
        contractVersion: hasCredential ? 2 : 1,
        capabilities: hasCredential ? { accountSessions: true, accountJoinGrants: true } : undefined,
        expiresAt: new Date(clock() + 60 * 1000).toISOString(),
        // This projection lets a client disable excess selections before it
        // asks targets to connect. The target still enforces the same policy
        // atomically while reserving its TURN connection.
        quota: {
          plan: entitlement.plan,
          limits: entitlement.limits,
          activeComputers: activeConnections.activeInstanceIds.length,
        },
        instances,
      };
    });
    audit({ event: 'instances.discovered', count: result.instances.length });
    return result;
  }

  async function listBindingHistory(input) {
    const { instance, accountId } = normalizeDeviceOpInput(input, 'history', clock);
    const result = await store.mutate(async (draft) => {
      assertBoundAccount(draft, instance, accountId);
      const entries = getBindingHistory(draft)
        .filter((item) => item.accountId === accountId)
        .map((item) => ({ instanceId: item.instanceId, action: item.action, occurredAt: item.occurredAt }))
        .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
      return { entries };
    });
    audit({ event: 'history.listed', instanceId: instance.instanceId, accountId, count: result.entries.length });
    return result;
  }

  return {
    canSignInDemoInstances: demoAccountAuth?.instanceAccess === 'account',
    // This reports policy availability, not the health of any target instance.
    demoSignInStatus: !demoAccountAuth ? 'unconfigured'
      : demoAccountAuth.instanceAccess === 'account' ? 'configured' : 'unavailable',
    start,
    readBindingAuthority,
    beginBrowser,
    beginDesktop,
    beginPhone,
    completeGoogleCredential,
    completePhoneGoogleCredential,
    completePhoneDemoCredential,
    getDesktopStatus,
    redeem,
    instanceRedeem,
    completeNativeCredential,
    createAccountSessionChallenge,
    beginAccountSessionBrowserVerify,
    markAccountSessionBrowserVerified,
    completeAccountSession,
    completeDemoAccountSession,
    completeDelegatedAccountSession: (input) => completeAccountSession(input, { desktopAuthorization: true }),
    completeDelegatedAccountSessionInTransaction: (input, draft) => completeAccountSession(input,
      { desktopAuthorization: true, transaction: (fn) => fn(draft) }),
    refreshAccountSession,
    createAccountJoinIntent,
    authorizeAccountJoinIntent,
    createAccountRendezvous,
    pollAccountRendezvous,
    pollAccountRendezvousInbox,
    closeRendezvousInboxWaiters: () => inboxWait.close(),
    completeAccountRendezvous,
    closeRendezvousResultWaiters,
    submitAccountRendezvousGrant,
    getAccountRendezvousResult,
    completeAccountJoinIntent,
    rollbackNativeCredential,
    unbindInstance,
    publishInstanceEndpoint,
    publishInstanceIdentity,
    listAccountDirectoryDevices,
    getAccountUsage,
    authenticateAccountAsr,
    getAccountFileUploadPolicy,
    reserveAccountFileUpload,
    completeAccountFileUpload,
    releaseAccountFileUpload,
    listOwnTurnConnections,
    releaseOwnTurnConnections,
    renameAccountDirectoryDevice,
    logoutAccountSession,
    revokeAccountDirectoryDevice,
    listDevices,
    reserveTurnConnection,
    commitTurnConnectionHandoff,
    releaseTurnConnection,
    authorizeProviderSync,
    authorizeTargetRuntime,
    publishAccountSyncCatalog,
    listBindingHistory,
    discoverInstances,
    manageInstanceAccessGrant,
  };
}
