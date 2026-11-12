// 主实例一侧的 Accounts owner-auth client。
// 它只保存本地一次性事务和最终 accountId 绑定；Google credential、OAuth client
// 与 token exchange 全部留在受控 Accounts 服务。
import { createHash, createPublicKey, randomBytes, verify } from 'crypto';
import { join } from 'path';
import {
  ACCOUNTS_ISSUER,
  ACCOUNTS_JWKS_URL,
  ACCOUNTS_URL,
  CONFIG_DIR,
  PUBLIC_BASE_URL,
  SECURE_COOKIES,
  P2P_SIGNALING_URL,
} from './config.mjs';
import { fetchBrokerJsonWithRetry } from './broker-fetch.mjs';
import { deliverAccountRendezvousResult } from './owner-auth-rendezvous-delivery.mjs';
import { createSerialTaskQueue, readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';
import {
  loadOrCreateInstanceIdentity,
  loadInstanceIdentity,
  publicInstanceIdentity,
  signWithInstanceIdentity,
  signInstanceProof,
  signProviderSyncPeerProof,
  signAccountJoinIntentProof,
  signNativeOwnerAuthProof,
  signNativeOwnerAuthRollbackProof,
  signBindingAuthorityProof,
  signOwnerAuthDeviceProof,
  signAccountFileUploadQuotaProof,
  signAccountRendezvousPollProof,
  signTargetRuntimeAuthorizationProof,
} from './instance-identity.mjs';
import { buildInstanceAccessGrantMessage } from './instance-proof-protocol.mjs';
import { createDevicePublicKeyFingerprint } from './device-auth-protocol.mjs';
import { BINDING_AUTHORITY_AUDIENCE, verifyBindingAuthorityAssertion } from './binding-authority.mjs';
import { WORKSPACE_AUTHORITY_AUDIENCE, verifyWorkspaceAuthorityAssertion } from './workspace-authority.mjs';
import { buildWorkspaceAuthorityProofMessage } from './instance-proof-protocol.mjs';
import { commitVerifiedOwnerBinding, invalidateLocalBindingAuthority, authorizeDeviceBinding } from './binding-authority-runtime.mjs';
import { classifyTargetRuntimeRequest, normalizeTargetRuntimePath } from './target-runtime-policy.mjs';
import { isTurnLeaseId, createTurnOperationRequestId } from './turn-lease-identity.mjs';
import {
  convergeTrustedDevice,
  getTrustedDevicePublicKey,
  getTrustedDeviceStatus,
  getTrustedDeviceP2PAccess,
  hasTrustedDeviceAccountClaimTicket,
  hasPendingTrustedDeviceAccountClaimTicket,
  invalidatePendingTrustedDeviceInvitations,
  completeTrustedDeviceAccountIntent,
} from '../chat/trusted-devices.mjs';
import {
  startOwnerAuthPoller,
  stopOwnerAuthPollers,
  getActiveOwnerAuthPollerCount,
  resumeOwnerAuthPollers,
} from './owner-auth-instance-poller.mjs';

export const OWNER_ACCOUNT_BINDING_FILE = join(CONFIG_DIR, 'owner-account-binding.json');
export const OWNER_ACCOUNT_TRANSACTIONS_FILE = join(CONFIG_DIR, 'owner-account-transactions.json');
export const OWNER_ACCOUNT_NATIVE_PENDING_FILE = join(CONFIG_DIR, 'owner-account-native-pending.json');
export const OWNER_ACCOUNT_NATIVE_JOURNAL_FILE = join(CONFIG_DIR, 'owner-account-native-journal.json');
export const OWNER_ACCOUNT_STATE_COOKIE = 'agentoc_owner_account_state';
export const OWNER_ACCOUNT_TRANSACTION_TTL_MS = 5 * 60 * 1000;
const OWNER_ACCOUNT_POLL_TRANSACTION_TTL_MS = 15 * 60 * 1000;
export const OWNER_ACCOUNT_NATIVE_JOURNAL_TTL_MS = 15 * 60 * 1000;
export const OWNER_AUTH_POLL_AUDIENCE = 'agentoc-owner-auth-poll';
export const OWNER_AUTH_DEVICE_AUDIENCE = 'agentoc-owner-auth-device';

const DELIVERY_MODES = new Set(['browser_callback', 'instance_poll']);

// 显式配置优先。绑定默认使用 instance_poll，因为绑定本身不需要浏览器
// 回到实例；登录仍可在有公网 HTTPS 地址时沿用 callback 兼容路径。
export function resolveOwnerAuthDeliveryMode(explicitMode = '', { purpose = '' } = {}) {
  const requested = trimString(explicitMode) || trimString(process.env.AGENTOC_OWNER_AUTH_DELIVERY_MODE) || 'auto';
  if (!['auto', ...DELIVERY_MODES].includes(requested)) {
    throw createError('owner_auth_request_invalid', 'Invalid owner auth delivery mode.');
  }
  if (requested !== 'auto') return requested;
  if (trimString(purpose) === 'bind') return 'instance_poll';
  return resolvePublicBaseUrl() ? 'browser_callback' : 'instance_poll';
}

const transactionQueue = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDeviceAlias(value) {
  return trimString(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 64);
}

function normalizeGoogleAccountProfile(value) {
  const source = value && typeof value === 'object' ? value : {};
  const displayName = trimString(source.displayName || source.name).slice(0, 160);
  const email = trimString(source.email).slice(0, 320);
  const photoUrl = trimString(source.photoUrl || source.picture);
  const safePhotoUrl = /^https:\/\//i.test(photoUrl) ? photoUrl.slice(0, 2048) : '';
  if (!displayName && !email && !safePhotoUrl) return null;
  return {
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    ...(safePhotoUrl ? { photoUrl: safePhotoUrl } : {}),
  };
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  const raw = trimString(value).replace(/-/g, '+').replace(/_/g, '/');
  if (!raw) return Buffer.alloc(0);
  return Buffer.from(raw.padEnd(Math.ceil(raw.length / 4) * 4, '='), 'base64');
}

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function createError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function normalizePurpose(value) {
  const purpose = trimString(value);
  return ['bind', 'login'].includes(purpose) ? purpose : '';
}

function normalizeHttpsUrl(value) {
  try {
    const parsed = new URL(trimString(value));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function normalizePublicEndpoint(value) {
  try {
    const parsed = new URL(trimString(value));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) return '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function resolveAccountsBaseUrl() {
  return normalizeHttpsUrl(ACCOUNTS_URL);
}

function resolvePublicBaseUrl() {
  return normalizeHttpsUrl(PUBLIC_BASE_URL);
}

function parseCookies(req) {
  const raw = trimString(req?.headers?.cookie);
  const cookies = new Map();
  for (const item of raw.split(';')) {
    const index = item.indexOf('=');
    if (index < 1) continue;
    cookies.set(item.slice(0, index).trim(), item.slice(index + 1).trim());
  }
  return cookies;
}

function makeStateCookie(transactionId, browserState, ttlMs = OWNER_ACCOUNT_TRANSACTION_TTL_MS) {
  const secure = SECURE_COOKIES ? '; Secure' : '';
  const value = `${encodeURIComponent(transactionId)}.${browserState}`;
  // The callback is a top-level navigation from the Accounts/Google flow.
  // Scope this short-lived cookie to the whole instance origin so browsers
  // retain it when the flow is opened from the account panel/new tab and then
  // redirected back to the callback endpoint.
  return `${OWNER_ACCOUNT_STATE_COOKIE}=${value}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

export function clearOwnerAccountStateCookie() {
  const secure = SECURE_COOKIES ? '; Secure' : '';
  return `${OWNER_ACCOUNT_STATE_COOKIE}=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0`;
}

function getStateCookie(req) {
  const raw = parseCookies(req).get(OWNER_ACCOUNT_STATE_COOKIE) || '';
  const index = raw.indexOf('.');
  if (index < 1) return null;
  try {
    return {
      transactionId: decodeURIComponent(raw.slice(0, index)),
      browserState: raw.slice(index + 1),
    };
  } catch {
    return null;
  }
}

function normalizeTransactions(value, now) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const entries = source.entries && typeof source.entries === 'object' && !Array.isArray(source.entries)
    ? source.entries
    : {};
  const retained = {};
  for (const [id, record] of Object.entries(entries)) {
    const createdAt = Date.parse(record?.createdAt || '');
    // Keep instance_poll terminal metadata for one additional TTL so the
    // security status endpoint can report expired/failed/completed after the
    // poll window closes. No credential is retained by this grace period.
    const isPollRecord = record?.deliveryMode === 'instance_poll';
    const retentionMs = isPollRecord ? OWNER_ACCOUNT_POLL_TRANSACTION_TTL_MS * 2 : OWNER_ACCOUNT_TRANSACTION_TTL_MS;
    if (!createdAt || now - createdAt > retentionMs) continue;
    retained[id] = record;
  }
  return { version: 1, entries: retained };
}

async function updateTransactions(mutator, { clock = Date.now } = {}) {
  return transactionQueue(async () => {
    const store = normalizeTransactions(await readJson(OWNER_ACCOUNT_TRANSACTIONS_FILE, null), clock());
    const result = await mutator(store);
    await writeJsonAtomic(OWNER_ACCOUNT_TRANSACTIONS_FILE, store, { mode: 0o600 });
    return result;
  });
}

async function readOwnerAccountTransaction(transactionId) {
  const store = await readJson(OWNER_ACCOUNT_TRANSACTIONS_FILE, null);
  const entries = store?.entries && typeof store.entries === 'object' ? store.entries : {};
  return entries[transactionId] || null;
}

async function updateOwnerAccountTransaction(transactionId, mutator, { clock = Date.now } = {}) {
  await updateTransactions((store) => {
    const record = store.entries[transactionId];
    if (record) mutator(record);
  }, { clock });
}

const NATIVE_JOURNAL_PHASES = new Set([
  'accounts_committed',
  'local_binding_persisted',
  'device_promoted',
  'credential_issued',
  'completed',
]);

function normalizeNativeJournal(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const phase = trimString(value.phase);
  const requestId = trimString(value.requestId);
  const deviceId = trimString(value.deviceId);
  const accountId = trimString(value.accountId);
  const updatedAt = trimString(value.updatedAt || value.createdAt);
  const updatedMs = Date.parse(updatedAt);
  const accountProfile = normalizeGoogleAccountProfile(value.accountProfile);
  if (!NATIVE_JOURNAL_PHASES.has(phase) || !requestId || !deviceId || !accountId
    || !Number.isFinite(updatedMs) || now - updatedMs > OWNER_ACCOUNT_NATIVE_JOURNAL_TTL_MS
    || ((value.bindingAuthorityRevision !== undefined || value.nativeCompletionId !== undefined)
      && (!isAuthorityCounter(value.bindingAuthorityRevision) || !isAuthorityCounter(value.nativeCompletionId)))) return null;
  return {
    version: 1,
    requestId,
    deviceId,
    accountId,
    ...(value.bindingAuthorityRevision ? { bindingAuthorityRevision: value.bindingAuthorityRevision } : {}),
    ...(value.nativeCompletionId ? { nativeCompletionId: value.nativeCompletionId } : {}),
    ...(accountProfile ? { accountProfile } : {}),
    deviceAlias: normalizeDeviceAlias(value.deviceAlias),
    action: trimString(value.action) || 'login',
    phase,
    updatedAt,
  };
}

async function writeNativeJournal(entry, { clock = Date.now } = {}) {
  const journal = normalizeNativeJournal({ ...entry, updatedAt: nowIso(clock) }, clock());
  if (!journal) throw createError('owner_auth_journal_invalid', 'Invalid native enrollment journal.', 500);
  await writeJsonAtomic(OWNER_ACCOUNT_NATIVE_JOURNAL_FILE, journal, { mode: 0o600 });
  return journal;
}

function brokerRetryAfterMs(response) {
  const value = trimString(response?.headers?.get?.('retry-after'));
  if (!value) return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
  const date = Number.isNaN(seconds) ? Date.parse(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 0;
  return delay > 0 ? Math.min(Math.ceil(delay), 2_147_483_647) : 0;
}

// Do not log a URL, request ID, query string, account, or credential. These
// fixed operation names make shared Accounts throttling diagnosable safely.
function brokerOperation(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return 'other'; }
  if (path.endsWith('/v1/owner-auth/rendezvous/inbox')) return 'rendezvous-inbox';
  if (path.endsWith('/v1/owner-auth/instances/authority')) return 'binding-authority';
  if (/\/v1\/owner-auth\/rendezvous\/[^/]+\/complete$/.test(path)) return 'rendezvous-result';
  if (/\/v1\/owner-auth\/account-intents\/[^/]+\/complete$/.test(path)) return 'join-completion';
  if (path.endsWith('/v1/owner-auth/turn/connections/reserve')) return 'turn-reservation';
  if (path.endsWith('/v1/owner-auth/turn/connections/release')) return 'turn-release';
  if (path.endsWith('/.well-known/jwks.json')) return 'signing-keys';
  return 'other';
}

async function fetchJson(fetchImpl, url, options, retryOptions = {}) {
  let response;
  try {
    // 传输层瞬断/单次挂死在 fetchBrokerJsonWithRetry 内部消化（每尝试超时 +
    // 有界重试）；重放字节相同的已签名请求，服务端按请求键去重。
    response = await fetchBrokerJsonWithRetry(fetchImpl, url, options, { timeoutMs: 12_000, ...retryOptions });
  } catch {
    throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    // 限流 429 响应没有结构化 code，必须单独识别；否则会被误报成
    // owner_auth_broker_rejected，掩盖“请求过快”这一真实原因。
    if (response.status === 429) {
      // Accounts uses 429 for an actual TURN entitlement limit as well as
      // HTTP rate limiting. Retrying the former cannot create capacity and
      // must not be presented to the user as a transient rate limit.
      if (body?.code === 'turn_connection_quota_exceeded') {
        throw createError('turn_connection_quota_exceeded', 'TURN connection quota does not allow this device.', 429);
      }
      const error = createError('owner_auth_broker_rate_limited',
        `Accounts service rate limited the ${brokerOperation(url)} request.`, 429);
      error.retryAfterMs = brokerRetryAfterMs(response);
      throw error;
    }
    const code = trimString(body?.code) || 'owner_auth_broker_rejected';
    throw createError(code, 'Accounts service rejected the owner authentication request.', response.status || 502);
  }
  return body || {};
}

// Accounts 可达是硬性前提；公网地址只属于 browser_callback（契约 §1）。
function ensureBrokerConfigured({ publicBaseUrl: requestedPublicBaseUrl = '', requirePublicUrl = true } = {}) {
  const accountsBaseUrl = resolveAccountsBaseUrl();
  const publicBaseUrl = normalizeHttpsUrl(requestedPublicBaseUrl) || resolvePublicBaseUrl();
  if (!accountsBaseUrl) throw createError('owner_auth_broker_not_configured', 'Accounts service is not configured on this instance.', 503);
  if (requirePublicUrl && !publicBaseUrl) {
    throw createError('owner_auth_public_url_required', 'A canonical HTTPS public URL is required for Google owner authentication.', 409);
  }
  return { accountsBaseUrl, publicBaseUrl };
}

function appendPath(baseUrl, pathname) {
  return `${baseUrl.replace(/\/$/, '')}${pathname}`;
}

function returnUrlFor(publicBaseUrl, transactionId) {
  const target = new URL(publicBaseUrl);
  target.pathname = `${target.pathname.replace(/\/+$/, '')}/api/auth/google/complete`;
  target.searchParams.set('tx', transactionId);
  return target.toString();
}

function buildProof(identity, { transactionId, purpose, returnUrl, deliveryMode = 'browser_callback', requestPath = '', requestId = '', clock }) {
  const issuedAt = new Date(clock()).toISOString();
  if (deliveryMode === 'instance_poll') {
    // poll 事务创建 proof 使用 poll audience 与不含 returnUrl 的 canonical
    // message（Accounts 端 validateInstance 按 audience 分支校验）。
    const proof = signInstanceProof(identity, {
      transactionId,
      purpose,
      returnUrl: '',
      issuedAt,
      audience: OWNER_AUTH_POLL_AUDIENCE,
    });
    return {
      transactionId,
      purpose,
      deliveryMode,
      instance: publicInstanceIdentity(identity),
      issuedAt,
      audience: OWNER_AUTH_POLL_AUDIENCE,
      signature: proof.signature,
    };
  }
  const proof = signInstanceProof(identity, {
    transactionId,
    purpose,
    returnUrl,
    issuedAt,
    audience: 'agentoc-owner-auth',
  });
  return {
    transactionId,
    purpose,
    deliveryMode,
    ...(requestPath && requestId ? { requestId } : {}),
    returnUrl,
    instance: publicInstanceIdentity(identity),
    issuedAt,
    audience: 'agentoc-owner-auth',
    signature: proof.signature,
  };
}

export async function authorizeProviderSyncPeer({
  sourceProof,
  targetInstanceId,
  fetchImpl = globalThis.fetch,
} = {}) {
  const target = trimString(targetInstanceId);
  if (!target || !sourceProof || typeof sourceProof !== 'object') {
    throw createError('provider_sync_auth_invalid', 'Provider sync peer proof is incomplete.', 400);
  }
  if (typeof fetchImpl !== 'function') {
    throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  }
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  return fetchJson(fetchImpl, appendPath(accountsBaseUrl, '/v1/owner-auth/provider-sync/authorize'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      requestId: trimString(sourceProof.requestId),
      targetInstanceId: target,
      sourceProof,
    }),
  });
}

// Exchange a signed local-instance proof for one exact, short-lived target
// command grant. The browser never receives the Accounts credential or signs
// this request itself; the instance identity remains the authorization actor.
export async function authorizeOwnerAccountTargetRuntime({
  targetInstanceId,
  requestId = `trq_${randomBytes(18).toString('base64url')}`,
  idempotencyKey = `tid_${randomBytes(18).toString('base64url')}`,
  method = 'GET',
  path,
  operation,
  resourceId,
  expectedRevision = 0,
  expiresAt = '',
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  const normalizedTarget = trimString(targetInstanceId);
  const normalizedRequest = trimString(requestId);
  const normalizedIdempotency = trimString(idempotencyKey);
  const normalizedMethod = trimString(method).toUpperCase();
  const normalizedPath = trimString(path);
  const normalizedOperation = trimString(operation);
  const normalizedResource = trimString(resourceId);
  const revision = Number(expectedRevision);
  const policy = classifyTargetRuntimeRequest(normalizedMethod, normalizedPath);
  if (!normalizedTarget || !normalizedRequest || !normalizedIdempotency || !normalizedResource
    || !policy || policy.method !== normalizedMethod || policy.operation !== normalizedOperation
    || policy.path !== normalizeTargetRuntimePath(normalizedPath)
    || !Number.isSafeInteger(revision) || revision < 0) {
    throw createError('target_runtime_authorization_invalid', 'Target runtime command is invalid.', 400);
  }
  if (typeof fetchImpl !== 'function') throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId) throw createError('owner_auth_not_bound', 'This instance has no Accounts binding.', 409);
  const identity = await loadOrCreateInstanceIdentity();
  const issuedAt = nowIso(clock);
  const expiresMs = Date.parse(trimString(expiresAt)) || (clock() + 60 * 1000);
  const canonicalExpiresAt = new Date(expiresMs).toISOString();
  const proof = signTargetRuntimeAuthorizationProof(identity, {
    requestId: normalizedRequest,
    targetInstanceId: normalizedTarget,
    idempotencyKey: normalizedIdempotency,
    method: normalizedMethod,
    path: policy.path,
    operation: normalizedOperation,
    resourceId: normalizedResource,
    expectedRevision: revision,
    expiresAt: canonicalExpiresAt,
    issuedAt,
    audience: 'agentoc-target-runtime',
  });
  const response = await fetchJson(fetchImpl, appendPath(accountsBaseUrl, '/v1/target-runtime/authorize'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      requestId: normalizedRequest,
      idempotencyKey: normalizedIdempotency,
      targetInstanceId: normalizedTarget,
      method: normalizedMethod,
      path: policy.path,
      operation: normalizedOperation,
      resourceId: normalizedResource,
      expectedRevision: revision,
      expiresAt: canonicalExpiresAt,
      issuedAt,
      audience: 'agentoc-target-runtime',
      instance: publicInstanceIdentity(identity),
      signature: proof.signature,
    }),
  });
  const responseTarget = response?.target;
  const responseExpiry = Date.parse(trimString(response?.expiresAt));
  const responseGrant = trimString(response?.grant);
  if (trimString(responseTarget?.targetInstanceId) !== normalizedTarget
    || !responseGrant || responseGrant.length > 16 * 1024 || responseGrant.split('.').length !== 3
    || !Number.isFinite(responseExpiry) || responseExpiry <= clock() || responseExpiry > clock() + 5 * 60 * 1000
    || trimString(response?.requestId) !== normalizedRequest
    || trimString(response?.idempotencyKey) !== normalizedIdempotency) {
    throw createError('target_runtime_authorization_response_invalid', 'Accounts service returned an invalid target runtime grant.', 502);
  }
  return response;
}

function assertBrokerAuthUrl(value, accountsBaseUrl) {
  try {
    const destination = new URL(trimString(value));
    const accounts = new URL(accountsBaseUrl);
    const issuer = normalizeHttpsUrl(ACCOUNTS_ISSUER);
    const issuerOrigin = issuer ? new URL(issuer).origin : '';
    // During an endpoint migration, the trusted issuer may still host the
    // browser transaction page while API requests use the new origin.
    if (destination.protocol !== 'https:' || destination.username || destination.password
      || ![accounts.origin, issuerOrigin].includes(destination.origin)) throw new Error('unexpected broker origin');
    return destination.toString();
  } catch {
    throw createError('owner_auth_broker_response_invalid', 'Accounts service returned an invalid authentication URL.', 502);
  }
}

function isAuthorityCounter(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

export function verifyAccountAssertion(token, jwks, {
  accountIssuer,
  instanceId,
  purpose,
  transactionId,
  deviceId = '',
  devicePublicKeyFingerprint = '',
  expectedIntentId = '',
  requireIssuedAt = false,
  clock,
}) {
  const parts = trimString(token).split('.');
  if (parts.length !== 3) throw createError('owner_auth_assertion_invalid', 'Invalid Accounts assertion.', 502);
  let header;
  let claims;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    claims = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  } catch {
    throw createError('owner_auth_assertion_invalid', 'Invalid Accounts assertion.', 502);
  }
  if (header?.alg !== 'EdDSA' || !trimString(header?.kid)) {
    throw createError('owner_auth_assertion_invalid', 'Invalid Accounts assertion.', 502);
  }
  const jwk = Array.isArray(jwks?.keys) ? jwks.keys.find((item) => trimString(item?.kid) === header.kid) : null;
  let valid = false;
  try {
    valid = Boolean(jwk)
      && verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'), createPublicKey({ key: jwk, format: 'jwk' }), base64UrlDecode(parts[2]));
  } catch {}
  const nowSeconds = Math.floor(clock() / 1000);
  const workspace = claims?.workspaceAccess;
  const workspaceInvalid = workspace !== undefined && (purpose !== 'account_join'
    || !workspace || typeof workspace !== 'object' || Array.isArray(workspace)
    || Object.keys(workspace).sort().join(',') !== 'grantId,ownerAccountId'
    || typeof workspace.ownerAccountId !== 'string' || typeof workspace.grantId !== 'string'
    || !/^[A-Za-z0-9_-]{8,160}$/.test(workspace.ownerAccountId || '')
    || !/^iag_[A-Za-z0-9_-]{16,128}$/.test(workspace.grantId || '')
    || workspace.ownerAccountId === trimString(claims.sub) || !isAuthorityCounter(claims.bindingAuthorityRevision));
  if (!valid
    || trimString(claims?.iss) !== accountIssuer
    || trimString(claims?.aud) !== instanceId
    || trimString(claims?.purpose) !== purpose
    || trimString(claims?.tx) !== transactionId
    || !trimString(claims?.sub)
    || workspaceInvalid
    || (claims?.provider !== undefined && !['google', 'demo', 'account-session'].includes(claims.provider))
    || (claims?.bindingAuthorityRevision !== undefined && !isAuthorityCounter(claims.bindingAuthorityRevision))
    || (claims?.nativeCompletionId !== undefined && (!isAuthorityCounter(claims.nativeCompletionId)
      || purpose !== 'native' || !isAuthorityCounter(claims.bindingAuthorityRevision)))
    || (purpose === 'native' && claims?.bindingAuthorityRevision !== undefined && !isAuthorityCounter(claims.nativeCompletionId))
    || (deviceId && trimString(claims?.deviceId) !== deviceId)
    || (devicePublicKeyFingerprint
      && trimString(claims?.devicePublicKeyFingerprint) !== devicePublicKeyFingerprint)
    || (expectedIntentId && trimString(claims?.intentId) !== expectedIntentId)
    || (requireIssuedAt && (!Number.isFinite(Number(claims?.iat))
      || Number(claims.iat) < nowSeconds - 120
      || Number(claims.iat) > nowSeconds + 120))
    || !Number.isFinite(Number(claims?.exp))
    || Number(claims.exp) <= nowSeconds
    || Number(claims.exp) > nowSeconds + 120) {
    throw createError('owner_auth_assertion_invalid', 'Invalid Accounts assertion.', 502);
  }
  const plan = ['free', 'plus', 'pro', 'test'].includes(trimString(claims.plan)) ? trimString(claims.plan) : 'free';
  const rawLimits = claims.limits && typeof claims.limits === 'object' ? claims.limits : {};
  const limits = {
    phones: Number.isInteger(Number(rawLimits.phones)) && Number(rawLimits.phones) > 0 ? Number(rawLimits.phones) : 1,
    computers: Number.isInteger(Number(rawLimits.computers)) && Number(rawLimits.computers) > 0 ? Number(rawLimits.computers) : 1,
    ...(plan === 'test' && rawLimits.unlimited === true ? { unlimited: true } : {}),
  };
  const deviceKind = ['phone', 'computer'].includes(trimString(claims.deviceKind))
    ? trimString(claims.deviceKind)
    : '';
  return {
    accountId: trimString(claims.sub),
    provider: claims.provider || 'google',
    ...(claims.bindingAuthorityRevision ? { bindingAuthorityRevision: claims.bindingAuthorityRevision } : {}),
    ...(claims.nativeCompletionId ? { nativeCompletionId: claims.nativeCompletionId } : {}),
    ...(workspace ? { workspaceAccess: { ownerAccountId: workspace.ownerAccountId, grantId: workspace.grantId } } : {}),
    expiresAt: new Date(Number(claims.exp) * 1000).toISOString(),
    plan,
    limits,
    ...(deviceKind ? { deviceKind } : {}),
    ...(trimString(claims.planExpiresAt) ? { planExpiresAt: trimString(claims.planExpiresAt) } : {}),
  };
}

export async function getOwnerAccountBinding() {
  const binding = await readJson(OWNER_ACCOUNT_BINDING_FILE, null);
  return binding && typeof binding === 'object' && trimString(binding.accountId) ? binding : null;
}

export async function queryOwnerAccountBindingAuthority({ accountId = '', fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const binding = await getOwnerAccountBinding();
  if (!binding || (accountId && accountId !== binding.accountId)) {
    throw createError('owner_auth_not_bound', 'The expected Accounts binding is unavailable.', 409);
  }
  const identity = await loadOrCreateInstanceIdentity(), startedAt = clock();
  const fields = { accountId: binding.accountId, requestId: `authority_${randomBytes(18).toString('base64url')}`,
    nonce: randomBytes(32).toString('base64url'), issuedAt: new Date(startedAt).toISOString(), audience: BINDING_AUTHORITY_AUDIENCE };
  const proof = signBindingAuthorityProof(identity, fields);
  const response = await fetchJson(fetchImpl, appendPath(accountsBaseUrl, '/v1/owner-auth/instances/authority'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...fields, instance: publicInstanceIdentity(identity), signature: proof.signature }),
  });
  const jwksUrl = normalizeHttpsUrl(ACCOUNTS_JWKS_URL) || appendPath(accountsBaseUrl, '/.well-known/jwks.json');
  const jwks = await fetchJson(fetchImpl, jwksUrl, { headers: { Accept: 'application/json' } });
  return verifyBindingAuthorityAssertion(response.assertion, jwks, { issuer: normalizeHttpsUrl(ACCOUNTS_ISSUER) || accountsBaseUrl,
    instanceId: identity.instanceId, keyFingerprint: identity.keyFingerprint, accountId: binding.accountId,
    requestId: fields.requestId, nonce: fields.nonce, startedAt, clock });
}

export async function queryWorkspaceAccountAuthority({ ownerAccountId, accountId, grantId,
  fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId || binding.accountId !== ownerAccountId || ownerAccountId === accountId
    || !/^[A-Za-z0-9_-]{8,160}$/.test(accountId || '') || !/^iag_[A-Za-z0-9_-]{16,128}$/.test(grantId || '')) {
    throw createError('owner_auth_not_bound', 'The expected workspace binding is unavailable.', 409);
  }
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const identity = await loadOrCreateInstanceIdentity(), startedAt = clock();
  const fields = { ownerAccountId, accountId, grantId, requestId: `workspace_${randomBytes(18).toString('base64url')}`,
    nonce: randomBytes(32).toString('base64url'), issuedAt: new Date(startedAt).toISOString(), audience: WORKSPACE_AUTHORITY_AUDIENCE };
  const signature = signWithInstanceIdentity(identity, buildWorkspaceAuthorityProofMessage({ ...fields,
    instanceId: identity.instanceId, keyFingerprint: identity.keyFingerprint }));
  const response = await fetchJson(fetchImpl, appendPath(accountsBaseUrl, '/v1/owner-auth/instances/workspace-authority'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...fields, instance: publicInstanceIdentity(identity), signature }),
  }, { attempts: 1, timeoutMs: 5_000 });
  const jwksUrl = normalizeHttpsUrl(ACCOUNTS_JWKS_URL) || appendPath(accountsBaseUrl, '/.well-known/jwks.json');
  const jwks = await fetchJson(fetchImpl, jwksUrl, { headers: { Accept: 'application/json' } }, { attempts: 1, timeoutMs: 5_000 });
  return verifyWorkspaceAuthorityAssertion(response.assertion, jwks, { issuer: normalizeHttpsUrl(ACCOUNTS_ISSUER) || accountsBaseUrl,
    instanceId: identity.instanceId, keyFingerprint: identity.keyFingerprint, ownerAccountId, accountId, grantId,
    requestId: fields.requestId, nonce: fields.nonce, startedAt, clock });
}

// Internal owner-instance operation. Any HTTP/UI caller must separately prove
// an owner session; possession of a member account ID is not authorization.
export async function manageOwnerInstanceAccess({ accountId, operation = 'issue', grantId = '',
  requestId = '', fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const member = trimString(accountId), action = trimString(operation), existingGrant = trimString(grantId);
  const request = trimString(requestId) || `iar_${randomBytes(24).toString('base64url')}`;
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(member) || !['issue', 'revoke'].includes(action)
    || !/^[A-Za-z0-9_-]{16,128}$/.test(request)
    || (action === 'issue' ? Boolean(existingGrant) : !/^iag_[A-Za-z0-9_-]{16,128}$/.test(existingGrant))) {
    throw createError('instance_access_request_invalid', 'Invalid instance access request.', 400);
  }
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const binding = await getOwnerAccountBinding();
  const identity = await loadInstanceIdentity();
  if (!binding?.accountId || !identity) throw createError('owner_auth_not_bound', 'This instance has no Accounts binding.', 409);
  if (binding.accountId === member) throw createError('instance_access_request_invalid', 'The owner already has access.', 400);
  const fields = { ownerAccountId: binding.accountId, accountId: member, operation: action,
    grantId: existingGrant, requestId: request, issuedAt: nowIso(clock), audience: 'agentoc-instance-access-grant' };
  const message = buildInstanceAccessGrantMessage({ ...fields, instanceId: identity.instanceId,
    keyFingerprint: identity.keyFingerprint });
  const result = await fetchJson(fetchImpl, appendPath(accountsBaseUrl, '/v1/owner-auth/instances/access-grants'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...fields, instance: publicInstanceIdentity(identity),
      signature: signWithInstanceIdentity(identity, message) }),
  });
  if (result.instanceId !== identity.instanceId || result.accountId !== member
    || !/^iag_[A-Za-z0-9_-]{16,128}$/.test(result.grantId || '')
    || (action === 'issue' && (result.scope !== 'workspace' || typeof result.created !== 'boolean'))
    || (action === 'revoke' && (result.grantId !== existingGrant || !Number.isFinite(Date.parse(result.revokedAt || ''))))) {
    throw createError('instance_access_response_invalid', 'Accounts returned an invalid instance access response.', 502);
  }
  return { ...result, requestId: request };
}

export function getOwnerAccountBrokerStatus() {
  const accountsBaseUrl = resolveAccountsBaseUrl();
  return {
    // Accounts itself is usable without an instance public URL: delivery mode
    // selection decides whether the transaction uses callback or polling.
    enabled: Boolean(accountsBaseUrl),
    configured: Boolean(accountsBaseUrl),
    mode: accountsBaseUrl ? 'accounts' : 'unconfigured',
    accountsUrl: accountsBaseUrl || '',
  };
}

export async function getDemoSignInStatus({ fetchImpl = globalThis.fetch } = {}) {
  const base = resolveAccountsBaseUrl();
  if (!base) return 'unconfigured';
  try {
    const response = await fetchImpl(appendPath(base, '/v1/owner-auth/demo-status'), {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return 'unavailable';
    const payload = await response.json();
    return ['configured', 'unconfigured', 'unavailable'].includes(payload?.status)
      ? payload.status : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

// 由 Google ID token 的 sub 派生 Accounts 账号 ID。
// 与 accounts/server.mjs createAccountResolver 的 acct_google_ 派生保持一致，
// 使原生绑定与浏览器流绑定在账号维度收敛到同一 accountId。
export function deriveGoogleOwnerAccountId(subject) {
  const sub = trimString(subject);
  if (!sub) return '';
  return `acct_google_${sha256(sub).slice(0, 32)}`;
}

function buildNativeRequestId() {
  return `oan_${randomBytes(18).toString('base64url')}`;
}

export async function completeOwnerAccountNativeAuth({
  idToken,
  deviceId,
  deviceAlias = '',
  accountProfile = null,
  requestId = buildNativeRequestId(),
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (!trimString(idToken) || !trimString(deviceId) || !trimString(requestId)) {
    throw createError('owner_auth_request_invalid', 'Invalid native owner authentication request.', 400);
  }
  if (typeof fetchImpl !== 'function') throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  // Native Google binding must not require a browser callback URL or a
  // transport endpoint. The connection bootstrap is issued only after the
  // account and device identity have converged.
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const identity = await loadOrCreateInstanceIdentity();
  const devicePublicKey = await getTrustedDevicePublicKey(deviceId);
  const devicePublicKeyFingerprint = createDevicePublicKeyFingerprint(devicePublicKey);
  if (!devicePublicKeyFingerprint) {
    throw createError('owner_auth_device_invalid', 'A registered device public key is required.', 400);
  }
  const issuedAt = nowIso(clock);
  const alias = normalizeDeviceAlias(deviceAlias);
  const proof = signNativeOwnerAuthProof(identity, {
    requestId,
    purpose: 'native',
    deviceId: trimString(deviceId),
    devicePublicKeyFingerprint,
    deviceAlias: alias,
    issuedAt,
    audience: 'agentoc-owner-auth-native',
  });
  const response = await fetchJson(fetchImpl, appendPath(accountsBaseUrl, '/v1/owner-auth/native/complete'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      requestId,
      purpose: 'native',
      device: { deviceId: trimString(deviceId), alias, devicePublicKeyFingerprint },
      idToken: trimString(idToken),
      issuedAt,
      audience: 'agentoc-owner-auth-native',
      instance: publicInstanceIdentity(identity),
      signature: proof.signature,
    }),
  });
  const jwksUrl = normalizeHttpsUrl(ACCOUNTS_JWKS_URL) || appendPath(accountsBaseUrl, '/.well-known/jwks.json');
  const jwks = await fetchJson(fetchImpl, jwksUrl, { headers: { Accept: 'application/json' } });
  const account = verifyAccountAssertion(response.assertion, jwks, {
    accountIssuer: normalizeHttpsUrl(ACCOUNTS_ISSUER) || accountsBaseUrl,
    instanceId: identity.instanceId,
    purpose: 'native',
    transactionId: requestId,
    deviceId: trimString(deviceId),
    devicePublicKeyFingerprint,
    clock,
  });
  const convergence = {
    requestId,
    deviceId: trimString(deviceId),
    deviceAlias: alias,
    accountId: account.accountId,
    ...(account.bindingAuthorityRevision ? { bindingAuthorityRevision: account.bindingAuthorityRevision } : {}),
    ...(account.nativeCompletionId ? { nativeCompletionId: account.nativeCompletionId } : {}),
    ...(normalizeGoogleAccountProfile(accountProfile) ? { accountProfile: normalizeGoogleAccountProfile(accountProfile) } : {}),
    plan: account.plan,
    limits: account.limits,
    ...(account.planExpiresAt ? { planExpiresAt: account.planExpiresAt } : {}),
    action: trimString(response.action) || 'login',
    createdAt: nowIso(clock),
  };
  // This marker is written before the local binding write. If the process or
  // filesystem fails after Accounts committed, the next retry can distinguish
  // an incomplete convergence from an ordinary invalid-token failure.
  try {
    await commitVerifiedOwnerBinding(account, identity, async () => {
      await writeNativeJournal({
        ...convergence,
        phase: 'accounts_committed',
      }, { clock });
      await writeJsonAtomic(OWNER_ACCOUNT_NATIVE_PENDING_FILE, convergence, { mode: 0o600 });
      const existingBinding = await getOwnerAccountBinding();
      await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE, {
        accountId: account.accountId,
        ...(account.bindingAuthorityRevision ? { bindingAuthorityRevision: account.bindingAuthorityRevision } : {}),
        provider: 'google',
        ...(convergence.accountProfile ? { accountProfile: convergence.accountProfile } : {}),
        boundAt: existingBinding?.boundAt || nowIso(clock),
        deviceAlias: alias,
        plan: account.plan,
        limits: account.limits,
        ...(account.planExpiresAt ? { planExpiresAt: account.planExpiresAt } : {}),
      }, { mode: 0o600 });
      await writeNativeJournal({
        ...convergence,
        phase: 'local_binding_persisted',
      }, { clock });
    });
  } catch (error) {
    error.nativeCompletion = convergence;
    throw error;
  }
  const publicResponse = { ...response };
  delete publicResponse.bindingAuthorityRevision; delete publicResponse.nativeCompletionId;
  return { ...publicResponse, accountId: account.accountId,
    ...(account.bindingAuthorityRevision ? { bindingAuthorityRevision: account.bindingAuthorityRevision } : {}),
    ...(account.nativeCompletionId ? { nativeCompletionId: account.nativeCompletionId } : {}) };
}

export async function registerOwnerAccountJoinIntent({
  intent,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!intent || !trimString(intent.intentId) || !trimString(intent.deviceId)
    || !trimString(intent.nonce) || !trimString(intent.signature)) {
    throw createError('owner_auth_request_invalid', 'Invalid account join intent.', 400);
  }
  if (typeof fetchImpl !== 'function') throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  // Account-join intent registration is an authenticated Accounts operation,
  // not a browser callback, so a private instance may register it as well.
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const response = await fetchJson(fetchImpl, appendPath(accountsBaseUrl, '/v1/owner-auth/account-intents'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      intentId: trimString(intent.intentId),
      nonce: trimString(intent.nonce),
      issuedAt: trimString(intent.issuedAt),
      audience: 'agentoc-account-join',
      instance: intent.instance,
      publicEndpoint: trimString(intent.publicEndpoint),
      computerAlias: normalizeDeviceAlias(intent.computerAlias),
      device: {
        deviceId: trimString(intent.deviceId),
        publicKey: trimString(intent.devicePublicKey),
        devicePublicKeyFingerprint: trimString(intent.devicePublicKeyFingerprint),
        alias: trimString(intent.deviceName),
        platform: trimString(intent.platform),
      },
      signature: trimString(intent.signature),
    }),
  });
  if (trimString(response.intentId) !== trimString(intent.intentId)
    || trimString(response.deviceId) !== trimString(intent.deviceId)) {
    throw createError('owner_auth_broker_response_invalid', 'Accounts service returned an invalid account join intent.', 502);
  }
  return response;
}

export async function completeOwnerAccountJoinIntent({
  intent,
  idToken,
  accountJoinGrant,
  deviceSignature,
  requestId,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  rendezvousExpiresAt = '',
  signal,
} = {}) {
  const normalizedRequestId = trimString(requestId);
  const normalizedIdToken = trimString(idToken);
  const normalizedAccountJoinGrant = trimString(accountJoinGrant);
  if (!intent || !trimString(intent.intentId) || !trimString(intent.deviceId)
    || Boolean(normalizedIdToken) === Boolean(normalizedAccountJoinGrant) || !trimString(deviceSignature)
    || normalizedRequestId.length < 16 || normalizedRequestId.length > 128
    || !/^[\x21-\x7e]+$/.test(normalizedRequestId)) {
    throw createError('owner_auth_request_invalid', 'Invalid account join completion.', 400);
  }
  if (typeof fetchImpl !== 'function') throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const identity = await loadOrCreateInstanceIdentity();
  const issuedAt = nowIso(clock);
  const proof = signAccountJoinIntentProof(identity, {
    intentId: trimString(intent.intentId),
    deviceId: trimString(intent.deviceId),
    devicePublicKeyFingerprint: trimString(intent.devicePublicKeyFingerprint),
    nonce: trimString(intent.nonce),
    issuedAt,
    audience: 'agentoc-account-join',
    publicEndpoint: trimString(intent.publicEndpoint),
  });
  const response = await fetchJson(
    fetchImpl,
    appendPath(accountsBaseUrl, `/v1/owner-auth/account-intents/${encodeURIComponent(intent.intentId)}/complete`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Idempotency-Key': normalizedRequestId,
      },
      body: JSON.stringify({
        nonce: trimString(intent.nonce),
        deviceIssuedAt: trimString(intent.issuedAt),
        device: {
          deviceId: trimString(intent.deviceId),
          devicePublicKeyFingerprint: trimString(intent.devicePublicKeyFingerprint),
        },
        deviceSignature: trimString(deviceSignature),
        publicEndpoint: trimString(intent.publicEndpoint),
        ...(normalizedIdToken ? { idToken: normalizedIdToken } : { accountJoinGrant: normalizedAccountJoinGrant }),
        issuedAt,
        audience: 'agentoc-account-join',
        instance: publicInstanceIdentity(identity),
        signature: proof.signature,
      }),
    },
  );
  const jwksUrl = normalizeHttpsUrl(ACCOUNTS_JWKS_URL) || appendPath(accountsBaseUrl, '/.well-known/jwks.json');
  // The grant is already consumed here. A rejected JWKS read must not strand
  // the rendezvous, and retrying this read cannot issue another credential.
  const readJwks = (readSignal) => fetchJson(fetchImpl, jwksUrl,
    { headers: { Accept: 'application/json' }, signal: readSignal });
  const jwks = rendezvousExpiresAt
    ? await deliverAccountRendezvousResult({ send: readJwks, expiresAt: rendezvousExpiresAt, clock, signal })
    : await readJwks(signal);
  const account = verifyAccountAssertion(response.assertion, jwks, {
    accountIssuer: normalizeHttpsUrl(ACCOUNTS_ISSUER) || accountsBaseUrl,
    instanceId: identity.instanceId,
    purpose: 'account_join',
    transactionId: normalizedRequestId,
    deviceId: trimString(intent.deviceId),
    devicePublicKeyFingerprint: trimString(intent.devicePublicKeyFingerprint),
    expectedIntentId: trimString(intent.intentId),
    clock,
  });
  // A successful completion assertion is signed for this exact target
  // instance.  Persist the account binding here so an explicitly claimed
  // computer remains claimed across restarts without ever receiving rac_.
  const ownerAuthority = account.workspaceAccess
    ? { ...account, accountId: account.workspaceAccess.ownerAccountId } : account;
  await commitVerifiedOwnerBinding(ownerAuthority, identity, async () => {
    const existingBinding = await getOwnerAccountBinding();
    if (account.workspaceAccess) {
      if (!existingBinding?.accountId || existingBinding.accountId !== account.workspaceAccess.ownerAccountId)
        throw createError('owner_auth_binding_mismatch', 'The shared workspace owner binding does not match.', 403);
      if (existingBinding.bindingAuthorityRevision !== account.bindingAuthorityRevision) {
        await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE, { ...existingBinding,
          bindingAuthorityRevision: account.bindingAuthorityRevision }, { mode: 0o600 });
      }
      return;
    }
    if (existingBinding?.accountId && existingBinding.accountId !== account.accountId) {
      throw createError('owner_auth_binding_mismatch', 'This instance is already bound to a different Account.', 403);
    }
    if (!existingBinding || account.bindingAuthorityRevision) {
      await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE, {
        ...(existingBinding || {}),
        accountId: account.accountId,
        provider: existingBinding?.provider || 'account-session',
        boundAt: existingBinding?.boundAt || nowIso(clock),
        ...(account.bindingAuthorityRevision ? { bindingAuthorityRevision: account.bindingAuthorityRevision } : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.limits ? { limits: account.limits } : {}),
        ...(account.planExpiresAt ? { planExpiresAt: account.planExpiresAt } : {}),
      }, { mode: 0o600 });
    }
  });
  const publicResponse = { ...response }; delete publicResponse.bindingAuthorityRevision; delete publicResponse.workspaceAccess;
  return { ...publicResponse, accountId: account.accountId,
    ...(account.workspaceAccess ? { workspaceAccess: account.workspaceAccess } : {}),
    ...(account.bindingAuthorityRevision ? { bindingAuthorityRevision: account.bindingAuthorityRevision } : {}) };
}

export async function clearOwnerAccountNativePending() {
  await Promise.all([
    writeJsonAtomic(OWNER_ACCOUNT_NATIVE_PENDING_FILE, {}, { mode: 0o600 }),
    writeJsonAtomic(OWNER_ACCOUNT_NATIVE_JOURNAL_FILE, {}, { mode: 0o600 }),
  ]);
}

export async function getOwnerAccountNativePending() {
  const journal = await getOwnerAccountNativeJournal();
  if (journal) return ['credential_issued', 'completed'].includes(journal.phase) ? null : journal;
  const pending = await readJson(OWNER_ACCOUNT_NATIVE_PENDING_FILE, null);
  // Compatibility for an older marker written before the journal existed.
  return normalizeNativeJournal({ ...pending, phase: pending?.phase || 'accounts_committed' });
}

export async function getOwnerAccountNativeJournal() {
  return normalizeNativeJournal(await readJson(OWNER_ACCOUNT_NATIVE_JOURNAL_FILE, null));
}

export async function markOwnerAccountNativeJournal(phase, fields = {}, { clock = Date.now } = {}) {
  if (!NATIVE_JOURNAL_PHASES.has(trimString(phase))) {
    throw createError('owner_auth_journal_invalid', 'Invalid native enrollment journal phase.', 500);
  }
  return writeNativeJournal({ ...fields, phase }, { clock });
}

export async function clearOwnerAccountNativeJournal() {
  await writeJsonAtomic(OWNER_ACCOUNT_NATIVE_JOURNAL_FILE, {}, { mode: 0o600 });
}

// Recover only the local half of a journaled convergence. This never calls
// Google or Accounts: the journal exists only after the Accounts assertion was
// verified, so a restart can safely finish local binding/promotion and let the
// client obtain a fresh rda_ through challenge/verify.
export async function recoverOwnerAccountNativePending({ clock = Date.now } = {}) {
  const journal = await getOwnerAccountNativeJournal();
  if (!journal || ['credential_issued', 'completed'].includes(journal.phase)) return { status: 'none' };

  const device = await getTrustedDeviceStatus(journal.deviceId);
  if (!device || device.revokedAt) return { status: 'pending', phase: journal.phase, reason: 'device_missing' };
  if (device.accountId && device.accountId !== journal.accountId) {
    return { status: 'pending', phase: journal.phase, reason: 'account_mismatch' };
  }

  const existingBinding = await getOwnerAccountBinding();
  if (existingBinding?.accountId && existingBinding.accountId !== journal.accountId) {
    return { status: 'pending', phase: journal.phase, reason: 'binding_mismatch' };
  }
  if (!existingBinding || (journal.bindingAuthorityRevision && existingBinding.bindingAuthorityRevision !== journal.bindingAuthorityRevision)) {
    const identity = await loadOrCreateInstanceIdentity();
    await commitVerifiedOwnerBinding(journal, identity, async () => {
      await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE, {
        ...(existingBinding || {}),
        accountId: journal.accountId,
        ...(journal.bindingAuthorityRevision ? { bindingAuthorityRevision: journal.bindingAuthorityRevision } : {}),
        provider: 'google',
        boundAt: existingBinding?.boundAt || nowIso(clock),
        deviceAlias: journal.deviceAlias,
        ...(journal.accountProfile ? { accountProfile: journal.accountProfile } : {}),
        ...(journal.plan ? { plan: journal.plan } : {}),
        ...(journal.limits ? { limits: journal.limits } : {}),
        ...(journal.planExpiresAt ? { planExpiresAt: journal.planExpiresAt } : {}),
      }, { mode: 0o600 });
    });
    await markOwnerAccountNativeJournal('local_binding_persisted', journal, { clock });
  }

  if (['accounts_committed', 'local_binding_persisted', 'device_promoted'].includes(journal.phase)) {
    await convergeTrustedDevice(journal.deviceId, journal.accountId, { bindingAuthorityRevision: journal.bindingAuthorityRevision });
    await markOwnerAccountNativeJournal('device_promoted', journal, { clock });
    await markOwnerAccountNativeJournal('credential_issued', journal, { clock });
  }
  return { status: 'recovered', phase: 'credential_issued', deviceId: journal.deviceId };
}

export async function clearOwnerAccountBinding() {
  invalidateLocalBindingAuthority();
  await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE, {}, { mode: 0o600 });
}

export async function rollbackOwnerAccountNativeAuth({
  requestId,
  deviceId,
  deviceAlias = '',
  accountId = '',
  bindingAuthorityRevision = '',
  nativeCompletionId = '',
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (!trimString(requestId) || !trimString(deviceId)) {
    throw createError('owner_auth_request_invalid', 'Invalid native owner authentication request.', 400);
  }
  if (typeof fetchImpl !== 'function') throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const identity = await loadOrCreateInstanceIdentity();
  const issuedAt = nowIso(clock);
  const alias = normalizeDeviceAlias(deviceAlias);
  const devicePublicKey = await getTrustedDevicePublicKey(deviceId);
  const devicePublicKeyFingerprint = createDevicePublicKeyFingerprint(devicePublicKey);
  if (!devicePublicKeyFingerprint) {
    throw createError('owner_auth_device_invalid', 'A registered device public key is required.', 400);
  }
  const versioned = Boolean(bindingAuthorityRevision || nativeCompletionId);
  if (versioned && (!trimString(accountId) || !isAuthorityCounter(bindingAuthorityRevision)
    || !isAuthorityCounter(nativeCompletionId))) {
    throw createError('owner_auth_request_invalid', 'Original native authorization is required.', 400);
  }
  const audience = versioned ? 'agentoc-owner-auth-native-rollback' : 'agentoc-owner-auth-native';
  const original = versioned ? { accountId: trimString(accountId), expectedRevision: bindingAuthorityRevision,
    expectedCompletionId: nativeCompletionId } : {};
  const proof = (versioned ? signNativeOwnerAuthRollbackProof : signNativeOwnerAuthProof)(identity, {
    requestId: trimString(requestId),
    purpose: 'native',
    deviceId: trimString(deviceId),
    devicePublicKeyFingerprint,
    deviceAlias: alias,
    issuedAt,
    audience,
    ...original,
  });
  return fetchJson(fetchImpl, appendPath(accountsBaseUrl, '/v1/owner-auth/native/rollback'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      requestId: trimString(requestId),
      device: { deviceId: trimString(deviceId), alias, devicePublicKeyFingerprint },
      issuedAt,
      audience,
      ...original,
      instance: publicInstanceIdentity(identity),
      signature: proof.signature,
    }),
  });
}

// 原生 ID token 端点（accounts 模式）的本机绑定写路径：
// 写入 owner-account-binding.json，与 completeOwnerAccountAuth 的 bind 写路径
// 保持同一 schema（{accountId, provider, boundAt, deviceAlias}）。
// 注意：本机验证 Google token 属冻结契约候选 A；Accounts 侧不会自动登记该设备，
// 因此「设备清单可见」受限于本地视图（见契约文档「未覆盖项」）。
export async function bindOwnerAccountFromGoogleIdentity({ sub, deviceAlias = '', clock = Date.now } = {}) {
  const accountId = deriveGoogleOwnerAccountId(sub);
  if (!accountId) throw createError('owner_auth_request_invalid', 'Missing Google account subject.');
  const identity = await loadOrCreateInstanceIdentity();
  await commitVerifiedOwnerBinding({ accountId }, identity, () => writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE, {
    accountId,
    provider: 'google',
    boundAt: nowIso(clock),
    deviceAlias: normalizeDeviceAlias(deviceAlias),
  }, { mode: 0o600 }));
  return getOwnerAccountBinding();
}

export async function startOwnerAccountAuth({
  purpose,
  alias = '',
  publicBaseUrl = '',
  deliveryMode = '',
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  const normalizedPurpose = normalizePurpose(purpose);
  if (!normalizedPurpose) throw createError('owner_auth_request_invalid', 'Invalid owner authentication purpose.');
  if (typeof fetchImpl !== 'function') throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  const mode = resolveOwnerAuthDeliveryMode(deliveryMode, { purpose: normalizedPurpose });
  // poll 模式不要求公网地址；显式 callback 无地址时在配置层 fail closed。
  const { accountsBaseUrl, publicBaseUrl: effectivePublicBaseUrl } = ensureBrokerConfigured({
    publicBaseUrl,
    requirePublicUrl: mode === 'browser_callback',
  });
  const transactionId = `otx_${randomBytes(24).toString('base64url')}`;
  const browserState = randomBytes(32).toString('base64url');
  const browserSessionHandoff = mode === 'instance_poll' && normalizedPurpose === 'login';
  const returnUrl = mode === 'browser_callback' ? returnUrlFor(effectivePublicBaseUrl, transactionId) : '';
  const requestId = mode === 'instance_poll' ? `opll_${randomBytes(24).toString('base64url')}` : '';
  const identity = await loadOrCreateInstanceIdentity();
  const normalizedAlias = normalizeDeviceAlias(alias);
  const proof = buildProof(identity, {
    transactionId,
    purpose: normalizedPurpose,
    returnUrl,
    deliveryMode: mode,
    clock,
  });
  await updateTransactions((store) => {
    store.entries[transactionId] = {
      transactionId,
      purpose: normalizedPurpose,
      alias: normalizedAlias,
      deliveryMode: mode,
      ...(mode === 'instance_poll' ? { requestId, pollState: 'polling', pollError: '' } : {}),
      ...(mode === 'browser_callback' ? { returnUrl } : {}),
      // Poll login still needs a short-lived opaque browser association so a
      // transaction id alone cannot cause an unauthenticated session handoff.
      browserStateHash: mode === 'browser_callback' || browserSessionHandoff ? sha256(browserState) : '',
      ...(browserSessionHandoff ? { sessionHandoffState: 'pending', sessionHandoffAt: '' } : {}),
      createdAt: nowIso(clock),
      expiresAt: '',
      redeemingAt: '',
    };
  }, { clock });
  try {
    const response = await fetchJson(fetchImpl, appendPath(accountsBaseUrl, '/v1/owner-auth/transactions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // The alias is presentation metadata, not part of the signed instance
      // proof. Keep it in the Accounts transaction request so the central
      // directory can persist the name chosen in the computer WebUI.
      body: JSON.stringify({
        ...proof,
        ...(normalizedPurpose === 'bind' ? { alias: normalizedAlias } : {}),
      }),
    });
    if (trimString(response.transactionId) !== transactionId) {
      throw createError('owner_auth_broker_response_invalid', 'Accounts service returned an invalid transaction.', 502);
    }
    await updateOwnerAccountTransaction(transactionId, (record) => {
      record.expiresAt = trimString(response.expiresAt);
    }, { clock });
    return {
      transactionId,
      authUrl: assertBrokerAuthUrl(response.authUrl, accountsBaseUrl),
      ...(mode === 'browser_callback' || browserSessionHandoff
        ? { stateCookie: makeStateCookie(transactionId, browserState,
          mode === 'instance_poll' ? OWNER_ACCOUNT_POLL_TRANSACTION_TTL_MS : OWNER_ACCOUNT_TRANSACTION_TTL_MS) }
        : {}),
      deliveryMode: mode,
      expiresAt: trimString(response.expiresAt),
    };
  } catch (error) {
    await updateTransactions((store) => { delete store.entries[transactionId]; }, { clock });
    throw error;
  }
}

async function reserveCompletion({ req, transactionId, grant, clock }) {
  const cookie = getStateCookie(req);
  return updateTransactions((store) => {
    const record = store.entries[transactionId];
    if (!record || !cookie || cookie.transactionId !== transactionId || sha256(cookie.browserState) !== record.browserStateHash) {
      throw createError('owner_auth_state_invalid', 'Google owner authentication state is invalid or expired.', 401);
    }
    if (record.redeemingAt) throw createError('owner_auth_state_replayed', 'Google owner authentication was already completed.', 409);
    if (!trimString(grant)) throw createError('owner_auth_grant_invalid', 'Missing Accounts owner authentication grant.', 400);
    record.redeemingAt = nowIso(clock);
    return record;
  }, { clock });
}

async function releaseCompletion(transactionId, { clock }) {
  await updateTransactions((store) => {
    if (store.entries[transactionId]) store.entries[transactionId].redeemingAt = '';
  }, { clock });
}

export async function completeOwnerAccountAuth({
  req,
  transactionId,
  grant,
  authSession,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  const txId = trimString(transactionId);
  if (!txId) throw createError('owner_auth_state_invalid', 'Google owner authentication state is invalid or expired.', 401);
  if (typeof fetchImpl !== 'function') throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  const { accountsBaseUrl } = ensureBrokerConfigured();
  const record = await reserveCompletion({ req, transactionId: txId, grant, clock });
  if (record.purpose === 'bind' && authSession?.role !== 'owner') {
    await releaseCompletion(txId, { clock });
    throw createError('owner_auth_owner_required', 'Owner access required.', 403);
  }
  try {
    const identity = await loadOrCreateInstanceIdentity();
    const proof = buildProof(identity, {
      transactionId: txId,
      purpose: record.purpose,
      returnUrl: record.returnUrl,
      clock,
    });
    const redeemed = await fetchJson(fetchImpl, appendPath(accountsBaseUrl, `/v1/owner-auth/transactions/${encodeURIComponent(txId)}/redeem`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...proof, grant: trimString(grant) }),
    });
    const jwksUrl = normalizeHttpsUrl(ACCOUNTS_JWKS_URL) || appendPath(accountsBaseUrl, '/.well-known/jwks.json');
    const jwks = await fetchJson(fetchImpl, jwksUrl, { headers: { Accept: 'application/json' } });
    const account = verifyAccountAssertion(redeemed.assertion, jwks, {
      accountIssuer: normalizeHttpsUrl(ACCOUNTS_ISSUER) || accountsBaseUrl,
      instanceId: publicInstanceIdentity(identity).instanceId,
      purpose: record.purpose,
      transactionId: txId,
      clock,
    });
    await commitVerifiedOwnerBinding(account, identity, async () => {
      if (record.purpose === 'bind') {
        await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE, {
          accountId: account.accountId,
          ...(account.bindingAuthorityRevision ? { bindingAuthorityRevision: account.bindingAuthorityRevision } : {}),
          provider: account.provider,
          boundAt: nowIso(clock),
          deviceAlias: record.alias,
          plan: account.plan,
          limits: account.limits,
          ...(account.planExpiresAt ? { planExpiresAt: account.planExpiresAt } : {}),
        }, { mode: 0o600 });
      } else {
        const binding = await getOwnerAccountBinding();
        if (!binding || binding.accountId !== account.accountId) {
          throw createError('owner_auth_binding_mismatch', 'Account is not the owner for this instance.', 403);
        }
        if (account.bindingAuthorityRevision) await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE,
          { ...binding, bindingAuthorityRevision: account.bindingAuthorityRevision }, { mode: 0o600 });
      }
    });
    if (record.purpose === 'bind') await publishOwnerAccountEndpoint({ fetchImpl, clock }).catch(() => {});
    await updateTransactions((store) => { delete store.entries[txId]; }, { clock });
    return { purpose: record.purpose, accountId: account.accountId,
      ...(account.bindingAuthorityRevision ? { bindingAuthorityRevision: account.bindingAuthorityRevision } : {}) };
  } catch (error) {
    await releaseCompletion(txId, { clock });
    throw error;
  }
}

// 设备管理操作：实例用一次性签名 proof（purpose=devices/history/unbind/
// publish-endpoint/publish-identity）调用
// Accounts 设备 API。与 start/redeem 一致，proof 全部放 POST body，
// 避免签名材料出现在 query/访问日志。未绑定实例直接拒绝。
async function deviceManagementOp({
  purpose,
  pathSuffix,
  publicEndpoint = '',
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function') throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const binding = await getOwnerAccountBinding();
  if (!binding) throw createError('owner_auth_not_bound', 'This instance has no Accounts binding.', 409);
  const identity = await loadOrCreateInstanceIdentity();
  const transactionId = `dop_${randomBytes(16).toString('base64url')}`;
  const normalizedPublicEndpoint = normalizePublicEndpoint(publicEndpoint);
  if (purpose === 'publish-endpoint' && !normalizedPublicEndpoint) {
    throw createError('owner_auth_endpoint_invalid', 'A canonical HTTPS public endpoint is required.', 409);
  }
  if (purpose !== 'publish-endpoint' && trimString(publicEndpoint)) {
    throw createError('owner_auth_request_invalid', 'Unexpected public endpoint.', 400);
  }
  // Device management is an instance-to-Accounts request. It has no browser
  // callback, so it must remain usable on ordinary private/local computers.
  const issuedAt = new Date(clock()).toISOString();
  const proof = signOwnerAuthDeviceProof(identity, {
    transactionId,
    purpose,
    publicEndpoint: normalizedPublicEndpoint,
    issuedAt,
    audience: OWNER_AUTH_DEVICE_AUDIENCE,
  });
  const endpoint = appendPath(accountsBaseUrl, `/v1/owner-auth/devices/${encodeURIComponent(binding.accountId)}${pathSuffix}`);
  const request = (body) => fetchJson(fetchImpl, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    return await request({
      transactionId,
      purpose,
      instance: publicInstanceIdentity(identity),
      issuedAt,
      audience: OWNER_AUTH_DEVICE_AUDIENCE,
      signature: proof.signature,
      accountId: binding.accountId,
      ...(normalizedPublicEndpoint ? { publicEndpoint: normalizedPublicEndpoint } : {}),
    });
  } catch (error) {
    // Accounts is released independently from the main service. During a
    // rolling upgrade, an older Accounts release rejects the new audience as
    // owner_auth_request_invalid but still accepts the previous callback-bound
    // proof. Retry only that precise compatibility signal; authentication,
    // binding, and transport errors must remain fail-closed.
    if (purpose === 'publish-endpoint' || purpose === 'publish-identity'
      || error?.code !== 'owner_auth_request_invalid'
      || process.env.AGENTOC_OWNER_AUTH_DEVICE_LEGACY_FALLBACK === '0') throw error;
    const legacyBaseUrl = resolvePublicBaseUrl() || accountsBaseUrl;
    const legacyReturnUrl = returnUrlFor(legacyBaseUrl, transactionId);
    const legacyProof = buildProof(identity, {
      transactionId,
      purpose,
      returnUrl: legacyReturnUrl,
      deliveryMode: 'browser_callback',
      clock,
    });
    return request({ ...legacyProof, accountId: binding.accountId });
  }
}

// Publish the local instance's canonical control-plane endpoint to the
// central Accounts directory. No-op for private/unconfigured instances or
// before the local instance has an Accounts binding.
export async function publishOwnerAccountEndpoint({
  publicBaseUrl = PUBLIC_BASE_URL,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  const endpoint = normalizePublicEndpoint(publicBaseUrl);
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId) return { published: false, reason: 'not-bound' };
  if (!endpoint) {
    // A private instance still needs its signed key in the Accounts directory
    // so phones can address it through TURN rendezvous.
    const identity = await publishOwnerAccountIdentity({ fetchImpl, clock });
    return { ...identity, published: false, identityPublished: true, reason: 'public-url-unconfigured' };
  }
  const result = await deviceManagementOp({
    purpose: 'publish-endpoint',
    pathSuffix: '/endpoint',
    publicEndpoint: endpoint,
    fetchImpl,
    clock,
  });
  return { published: true, ...result };
}

/** Publish only the local instance identity; no network address is retained. */
export async function publishOwnerAccountIdentity({
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId) return { published: false, reason: 'not-bound' };
  const result = await deviceManagementOp({
    purpose: 'publish-identity',
    pathSuffix: '/identity',
    fetchImpl,
    clock,
  });
  return { published: true, ...result };
}

async function turnConnectionOp({
  purpose,
  path,
  deviceId,
  deviceKind = 'phone',
  connectionId,
  expiresAt = '',
  reason = '',
  protocolVersion: requestedProtocolVersion = 0,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  signal,
} = {}) {
  const normalizedPurpose = trimString(purpose);
  const normalizedDeviceId = trimString(deviceId);
  const normalizedConnectionId = trimString(connectionId);
  if (!['turn-reserve', 'turn-release', 'turn-handoff-commit'].includes(normalizedPurpose)
    || !normalizedDeviceId || !normalizedConnectionId) {
    throw createError('turn_connection_request_invalid', 'TURN connection request is incomplete.', 400);
  }
  if (typeof fetchImpl !== 'function') {
    throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  }
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId) throw createError('owner_auth_not_bound', 'This instance has no Accounts binding.', 409);
  const identity = await loadOrCreateInstanceIdentity();
  const protocolVersion = isTurnLeaseId(normalizedConnectionId) ? (requestedProtocolVersion === 3 ? 3 : 2) : 1;
  if ((requestedProtocolVersion === 3 || normalizedPurpose === 'turn-handoff-commit') && protocolVersion !== 3) {
    throw createError('turn_handoff_request_invalid', 'A v3 lease identity is required.', 400);
  }
  const requestId = protocolVersion >= 2 ? createTurnOperationRequestId({ purpose: normalizedPurpose, protocolVersion,
    accountId: binding.accountId, instanceId: identity.instanceId, deviceId: normalizedDeviceId,
    deviceKind: trimString(deviceKind) || 'phone', connectionId: normalizedConnectionId, expiresAt, reason }) : normalizedConnectionId;
  const issuedAt = new Date(clock()).toISOString();
  const proof = signOwnerAuthDeviceProof(identity, {
    transactionId: requestId,
    purpose: normalizedPurpose,
    issuedAt,
    audience: OWNER_AUTH_DEVICE_AUDIENCE,
  });
  return fetchJson(fetchImpl, appendPath(accountsBaseUrl, path), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      requestId,
      protocolVersion,
      accountId: binding.accountId,
      deviceId: normalizedDeviceId,
      deviceKind: trimString(deviceKind) || 'phone',
      connectionId: normalizedConnectionId,
      ...(trimString(expiresAt) ? { expiresAt: trimString(expiresAt) } : {}),
      ...(trimString(reason) ? { reason: trimString(reason).slice(0, 128) } : {}),
      instance: publicInstanceIdentity(identity),
      issuedAt,
      audience: OWNER_AUTH_DEVICE_AUDIENCE,
      signature: proof.signature,
    }),
  });
}

async function accountFileUploadQuotaOperation(operation, {
  requestId, quotaBatchId, sizeBytes, sha256, expectedAccountId, workspacePrincipal,
  fetchImpl = globalThis.fetch, clock = Date.now,
} = {}) {
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId) return null;
  let accountId = binding.accountId, grantId = '';
  if (workspacePrincipal) {
    if (workspacePrincipal.principalKind !== 'trusted_device' || !workspacePrincipal.deviceId
      || workspacePrincipal.workspaceAccess?.ownerAccountId !== binding.accountId) {
      throw createError('instance_access_unavailable', 'Workspace account authorization is unavailable.', 403);
    }
    const authority = await authorizeDeviceBinding({ ...workspacePrincipal, id: workspacePrincipal.deviceId });
    if (!authority?.workspaceAccess || authority.accountId !== workspacePrincipal.accountId) {
      throw createError('instance_access_unavailable', 'Workspace account authorization is unavailable.', 403);
    }
    accountId = authority.accountId;
    grantId = authority.workspaceAccess.grantId;
  }
  if (expectedAccountId && accountId !== expectedAccountId) return null;
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const identity = await loadOrCreateInstanceIdentity();
  const issuedAt = new Date(clock()).toISOString();
  const fields = { accountId, ...(grantId ? { grantId } : {}), operation, requestId, quotaBatchId, sizeBytes,
    sha256: trimString(sha256).toLowerCase(), issuedAt, audience: 'agentoc-account-file-upload' };
  const proof = signAccountFileUploadQuotaProof(identity, fields);
  return fetchJson(fetchImpl, appendPath(accountsBaseUrl, `/v1/owner-auth/instances/uploads/${operation}`), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...fields, instance: publicInstanceIdentity(identity), signature: proof.signature }),
  }, operation === 'policy' ? { attempts: 1, timeoutMs: 3_000 } : {});
}

export async function getOwnerAccountFileUploadPolicy(options = {}) {
  // The policy transcript uses the existing signed quota-proof format, with
  // fixed placeholder file fields; no upload reservation is created.
  return accountFileUploadQuotaOperation('policy', { ...options,
    requestId: `policy_${randomBytes(18).toString('base64url')}`,
    quotaBatchId: 'policy', sizeBytes: 1, sha256: '0'.repeat(64) });
}

export async function reserveOwnerAccountFileUpload(options = {}) {
  return accountFileUploadQuotaOperation('reserve', options);
}

export async function completeOwnerAccountFileUpload(options = {}) {
  return accountFileUploadQuotaOperation('complete', options);
}

export async function releaseOwnerAccountFileUpload(options = {}) {
  return accountFileUploadQuotaOperation('release', options);
}

export async function reserveOwnerAccountTurnConnection(options = {}) {
  return turnConnectionOp({
    ...options,
    purpose: 'turn-reserve',
    path: '/v1/owner-auth/turn/connections/reserve',
  });
}

export async function releaseOwnerAccountTurnConnection(options = {}) {
  return turnConnectionOp({
    ...options,
    purpose: 'turn-release',
    path: '/v1/owner-auth/turn/connections/release',
  });
}

export async function commitOwnerAccountTurnHandoff(options = {}) {
  return turnConnectionOp({ ...options, protocolVersion: 3, purpose: 'turn-handoff-commit',
    path: '/v1/owner-auth/turn/connections/handoff/commit' });
}

// 查询当前账号绑定的设备清单（Accounts 侧 source=local|remote 视图）
export async function listOwnerAccountDevices(options = {}) {
  return deviceManagementOp({ purpose: 'devices', pathSuffix: '', ...options });
}

// 查询当前账号的绑定/解绑历史（按时间倒序）
export async function getOwnerAccountBindingHistory(options = {}) {
  return deviceManagementOp({ purpose: 'history', pathSuffix: '/history', ...options });
}

// A short-lived proof used by one bound computer to ask another bound
// computer to authenticate the peer through Accounts. The proof contains no
// provider data and is bound to the target instance id.
export async function createProviderSyncPeerProof({ targetInstanceId, requestId, clock = Date.now } = {}) {
  const normalizedTarget = trimString(targetInstanceId);
  const normalizedRequest = trimString(requestId) || `psync_${randomBytes(18).toString('base64url')}`;
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId) throw createError('owner_auth_not_bound', 'This instance has no Accounts binding.', 409);
  if (!normalizedTarget) throw createError('provider_sync_target_invalid', 'Target instance is required.', 400);
  const identity = await loadOrCreateInstanceIdentity();
  const issuedAt = new Date(clock()).toISOString();
  const proof = signProviderSyncPeerProof(identity, {
    requestId: normalizedRequest,
    targetInstanceId: normalizedTarget,
    issuedAt,
    audience: 'agentoc-provider-sync',
  });
  return {
    requestId: normalizedRequest,
    accountId: binding.accountId,
    targetInstanceId: normalizedTarget,
    issuedAt,
    audience: 'agentoc-provider-sync',
    instance: publicInstanceIdentity(identity),
    signature: proof.signature,
  };
}

export async function createAccountSyncCatalogProof({ requestId, clock = Date.now } = {}) {
  const normalizedRequest = trimString(requestId) || `async_${randomBytes(18).toString('base64url')}`;
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId) throw createError('owner_auth_not_bound', 'This instance has no Accounts binding.', 409);
  const identity = await loadOrCreateInstanceIdentity();
  const targetInstanceId = `account:${binding.accountId}`;
  const issuedAt = new Date(clock()).toISOString();
  const proof = signProviderSyncPeerProof(identity, {
    requestId: normalizedRequest,
    targetInstanceId,
    issuedAt,
    audience: 'agentoc-account-sync-catalog',
  });
  return {
    requestId: normalizedRequest,
    accountId: binding.accountId,
    targetInstanceId,
    issuedAt,
    audience: 'agentoc-account-sync-catalog',
    instance: publicInstanceIdentity(identity),
    signature: proof.signature,
  };
}

export async function publishOwnerAccountSyncCatalog({ entries = [], fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') throw createError('owner_auth_broker_unavailable', 'Accounts service is unavailable.', 503);
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId) throw createError('owner_auth_not_bound', 'This instance has no Accounts binding.', 409);
  const { accountsBaseUrl } = ensureBrokerConfigured({ requirePublicUrl: false });
  const sourceProof = await createAccountSyncCatalogProof({ clock });
  return fetchJson(fetchImpl, appendPath(accountsBaseUrl, `/v1/owner-auth/sync/catalog/${encodeURIComponent(binding.accountId)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sourceProof, entries }),
  });
}

// 解绑当前实例：Accounts 撤销 binding/device，本机同步清空本地绑定文件。
export async function unbindOwnerAccount(options = {}) {
  // Old QR consent must not survive revocation and become a new enrollment.
  await invalidatePendingTrustedDeviceInvitations();
  const result = await deviceManagementOp({ purpose: 'unbind', pathSuffix: '/unbind', ...options });
  await clearOwnerAccountBinding();
  return result;
}

// ---------- instance_poll：轮询完成、恢复与安全状态查询 ----------

async function fetchAccountsJwks(fetchImpl, accountsBaseUrl) {
  const jwksUrl = normalizeHttpsUrl(ACCOUNTS_JWKS_URL) || appendPath(accountsBaseUrl, '/.well-known/jwks.json');
  return fetchJson(fetchImpl, jwksUrl, { headers: { Accept: 'application/json' } });
}

function buildPollerDeps({ fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const accountsBaseUrl = resolveAccountsBaseUrl();
  return {
    fetchImpl,
    clock,
    accountsBaseUrl,
    readTransaction: (transactionId) => readOwnerAccountTransaction(transactionId),
    updateTransaction: (transactionId, mutator) => updateOwnerAccountTransaction(transactionId, mutator, { clock }),
    verifyAssertion: (assertion, { purpose, transactionId }) => verifyAccountAssertionFromAccounts(
      assertion,
      { purpose, transactionId, fetchImpl, clock, requireIssuedAt: true },
    ),
    writeBinding: async ({ purpose, accountId, provider, alias, plan, limits, planExpiresAt, bindingAuthorityRevision }) => {
      const identity = await loadOrCreateInstanceIdentity();
      await commitVerifiedOwnerBinding({ accountId, bindingAuthorityRevision }, identity, async () => {
        // 断言已验证；bind 写绑定文件，login 校验既有绑定（与 callback 路径一致）。
        if (purpose === 'bind') {
          await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE, {
            accountId,
            ...(bindingAuthorityRevision ? { bindingAuthorityRevision } : {}),
            provider: provider || 'google',
            boundAt: nowIso(clock),
            deviceAlias: normalizeDeviceAlias(alias),
            ...(plan ? { plan } : {}),
            ...(limits ? { limits } : {}),
            ...(planExpiresAt ? { planExpiresAt } : {}),
          }, { mode: 0o600 });
        } else {
          const binding = await getOwnerAccountBinding();
          if (!binding || binding.accountId !== accountId) {
            throw createError('owner_auth_binding_mismatch', 'Account is not the owner for this instance.', 403);
          }
          if (bindingAuthorityRevision) await writeJsonAtomic(OWNER_ACCOUNT_BINDING_FILE,
            { ...binding, bindingAuthorityRevision }, { mode: 0o600 });
        }
      });
    },
    listResumableTransactions: async () => {
      const now = clock();
      const store = normalizeTransactions(await readJson(OWNER_ACCOUNT_TRANSACTIONS_FILE, null), now);
      return Object.values(store.entries)
        .filter((record) => record.deliveryMode === 'instance_poll'
          && record.requestId
          && !['completed', 'failed', 'expired'].includes(trimString(record.pollState)))
        .map((record) => record.transactionId);
    },
  };
}

async function verifyAccountAssertionFromAccounts(assertion, {
  purpose,
  transactionId,
  fetchImpl,
  clock,
  requireIssuedAt = false,
}) {
  const accountsBaseUrl = resolveAccountsBaseUrl();
  if (!accountsBaseUrl) throw createError('owner_auth_broker_not_configured', 'Accounts service is not configured on this instance.', 503);
  const identity = await loadOrCreateInstanceIdentity();
  const jwks = await fetchAccountsJwks(fetchImpl, accountsBaseUrl);
  return verifyAccountAssertion(assertion, jwks, {
    accountIssuer: normalizeHttpsUrl(ACCOUNTS_ISSUER) || accountsBaseUrl,
    instanceId: publicInstanceIdentity(identity).instanceId,
    purpose,
    transactionId,
    requireIssuedAt,
    clock,
  });
}

// startOwnerAccountAuth 成功创建 poll 事务后调用：启动轮询器。
export function attachOwnerAuthPoller(transactionId, options = {}) {
  startOwnerAuthPoller(transactionId, buildPollerDeps(options));
}

// Polls the Accounts rendezvous inbox for the local instance. The
// caller supplies the final local bootstrap builder so this module remains
// independent from the chat connection service.
export async function pollOwnerAccountRendezvous({
  fetchImpl = globalThis.fetch,
  completeLocal = completeTrustedDeviceAccountIntent,
  readP2PAccess = getTrustedDeviceP2PAccess,
  buildBootstrap = null,
  startP2PHost = null,
  clock = Date.now,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof buildBootstrap !== 'function') return { handled: false, reason: 'unconfigured' };
  const accountsBaseUrl = resolveAccountsBaseUrl();
  if (!accountsBaseUrl) return { handled: false, reason: 'accounts-unconfigured' };
  // A signed phone can claim an unbound computer only through a live local
  // QR invitation. Poll while that invitation exists so its first account
  // binding can complete; idle unbound computers make no network request.
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId && !await hasPendingTrustedDeviceAccountClaimTicket()) return { handled: false, reason: 'not-bound' };
  const identity = await loadOrCreateInstanceIdentity();
  const issuedAt = nowIso(clock);
  const proof = signAccountRendezvousPollProof(identity, {
    requestId: 'inbox',
    issuedAt,
    audience: 'agentoc-account-rendezvous-poll',
  });
  const response = await fetchJson(fetchImpl, appendPath(accountsBaseUrl, '/v1/owner-auth/rendezvous/inbox'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      requestId: 'inbox', issuedAt, audience: 'agentoc-account-rendezvous-poll',
      instance: publicInstanceIdentity(identity), signature: proof.signature,
      waitMs: 10_000,
    }),
    signal,
  });
  const inboxWait = response?.inboxWaitVersion === 1 ? { inboxWaitVersion: 1 } : {};
  if (!response?.intent || !response?.grant?.accountJoinGrant || !response?.grant?.deviceSignature) return { handled: false, reason: 'pending', ...inboxWait };
  const intent = response.intent;
  if (!binding?.accountId && !trimString(intent.accountClaimTokenHash)) {
    return { handled: false, reason: 'claim-ticket-mismatch' };
  }
  if (trimString(intent.accountClaimTokenHash)) {
    // The instance accepts an endpoint-less claim only when the central
    // rendezvous ticket matches a still-live local one-time ticket.
    if (!await hasTrustedDeviceAccountClaimTicket(intent.accountClaimTokenHash)) {
      return { handled: false, reason: 'claim-ticket-mismatch' };
    }
  }
  const requestId = trimString(intent.requestId);
  const completed = await completeOwnerAccountJoinIntent({
    intent: { ...intent, publicEndpoint: '', nonce: intent.nonce },
    accountJoinGrant: response.grant.accountJoinGrant,
    deviceSignature: response.grant.deviceSignature,
    requestId,
    fetchImpl,
    clock,
    rendezvousExpiresAt: intent.expiresAt,
    signal,
  });
  const localInput = {
    intentId: intent.intentId,
    intent,
    deviceSignature: response.grant.deviceSignature,
    accountId: completed.accountId,
    bindingAuthorityRevision: completed.bindingAuthorityRevision,
    workspaceAccess: completed.workspaceAccess,
    requestId,
    verifiedAccountCompletion: true,
  };
  // completeTrustedDeviceAccountIntent checks authority before mutating local
  // state. Only an explicit Accounts 429 is retried; no other outcome is
  // replayed, and the already redeemed central grant is never requested again.
  const local = await deliverAccountRendezvousResult({
    expiresAt: intent.expiresAt, clock, signal,
    send: () => completeLocal(localInput),
  });
  // This is a read of the already bound device; it can encounter another
  // authority refresh after local completion. An explicit 429 must not discard
  // the credential that was just issued or restart the consumed grant.
  const p2p = await deliverAccountRendezvousResult({
    expiresAt: intent.expiresAt, clock, signal,
    send: () => readP2PAccess(intent.deviceId),
  });
  let bootstrap = null;
  let quotaDenied = false;
  try {
    bootstrap = await buildBootstrap({
      deviceId: intent.deviceId, rendezvousExpiresAt: intent.expiresAt, clock, signal,
    });
  } catch (error) {
    if (!['turn_connection_quota_exceeded', 'turn_quota_exceeded'].includes(error?.code)) throw error;
    quotaDenied = true;
  }
  let host = null;
  if (!quotaDenied && p2p && typeof startP2PHost === 'function') {
    // The local device binding and signed TURN contract already exist at this
    // point. Make the Host ready before Accounts tells the phone to connect;
    // a Host failure remains recoverable and must not undo account convergence.
    try {
      host = await startP2PHost({
        deviceId: intent.deviceId,
        p2p,
        bootstrap,
        iceServers: bootstrap?.turn?.iceServers || [],
        relayOnly: true,
        expiresAt: bootstrap?.turn?.expiresAt,
      });
    } catch (error) {
      host = { started: false, reason: 'startup-failed', error: error?.message || String(error) };
    }
  }
  const completionIssuedAt = nowIso(clock);
  const completionProof = signAccountRendezvousPollProof(identity, {
    requestId,
    issuedAt: completionIssuedAt,
    audience: 'agentoc-account-rendezvous-poll',
  });
  const completionUrl = appendPath(accountsBaseUrl, `/v1/owner-auth/rendezvous/${encodeURIComponent(requestId)}/complete`);
  const completionRequest = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      requestId, issuedAt: completionIssuedAt, audience: 'agentoc-account-rendezvous-poll',
      instance: publicInstanceIdentity(identity), signature: completionProof.signature,
      result: quotaDenied ? { error: { code: 'turn_connection_quota_exceeded' } } : {
        accountId: completed.accountId,
        deviceId: intent.deviceId,
        // `completeTrustedDeviceAccountIntent` returns the local credential
        // storage shape. Add the public protocol discriminator here instead
        // of leaking that internal shape into the rendezvous result.
        credential: { ...local.credential, type: 'Bearer' },
        bootstrap,
        p2p: p2p ? { signalingEndpoint: trimString(P2P_SIGNALING_URL), ...p2p } : null,
      },
    }),
  };
  // A 429 here rejects only the final publication. Keep the exact signed
  // payload and retry it within the original intent; the consumed grant,
  // local credential, reservation and Host setup must not run again.
  const result = await deliverAccountRendezvousResult({
    expiresAt: intent.expiresAt,
    clock,
    signal,
    send: (deliverySignal) => fetchJson(fetchImpl, completionUrl,
      { ...completionRequest, signal: deliverySignal }, { attempts: 1 }),
  });
  return { handled: true, requestId, host, result, ...inboxWait };
}

// 服务启动时恢复：重启前的 instance_poll 事务用原 requestId 继续轮询。
export async function recoverOwnerAuthPollers(options = {}) {
  return resumeOwnerAuthPollers(buildPollerDeps(options));
}

export { stopOwnerAuthPollers, getActiveOwnerAuthPollerCount };

function hasValidBrowserState(req, record) {
  const cookie = getStateCookie(req);
  return Boolean(record?.browserStateHash
    && cookie?.transactionId === record.transactionId
    && sha256(cookie.browserState) === record.browserStateHash);
}

function effectiveTransactionExpiryMs(record) {
  const persisted = Date.parse(record?.expiresAt || '');
  if (Number.isFinite(persisted)) return persisted;
  const created = Date.parse(record?.createdAt || '');
  const ttlMs = record?.deliveryMode === 'instance_poll'
    ? OWNER_ACCOUNT_POLL_TRANSACTION_TTL_MS : OWNER_ACCOUNT_TRANSACTION_TTL_MS;
  return Number.isFinite(created) ? created + ttlMs : NaN;
}

// The browser never receives an assertion or account identity. For poll login,
// this one-shot handoff only turns the already-verified local transaction into
// the normal owner session cookie.
export async function claimOwnerAccountPollSession({
  req,
  transactionId,
  issueSession,
  clock = Date.now,
} = {}) {
  const txId = trimString(transactionId);
  if (!txId || typeof issueSession !== 'function') {
    throw createError('owner_auth_request_invalid', 'Invalid owner session handoff request.', 400);
  }
  const claim = await updateTransactions((store) => {
    const record = store.entries[txId];
    if (!record || record.deliveryMode !== 'instance_poll' || record.purpose !== 'login'
      || !hasValidBrowserState(req, record)) {
      throw createError('owner_auth_state_invalid', 'Google owner authentication state is invalid or expired.', 401);
    }
    const expiresMs = effectiveTransactionExpiryMs(record);
    if (Number.isFinite(expiresMs) && expiresMs <= clock()) {
      record.pollState = 'expired';
      record.pollError = 'owner_auth_transaction_invalid';
      return { status: 'expired' };
    }
    const status = trimString(record.pollState) || 'pending';
    if (status !== 'completed') {
      return {
        status: ['pending', 'failed', 'expired'].includes(status) ? status : 'pending',
      };
    }
    const handoffState = trimString(record.sessionHandoffState) || 'pending';
    if (handoffState === 'issued') return { status: 'completed', alreadyIssued: true };
    if (handoffState === 'claimed') {
      const claimedMs = Date.parse(record.sessionHandoffAt || '');
      if (!Number.isFinite(claimedMs) || clock() - claimedMs < 30_000) {
        throw createError('owner_auth_session_handoff_busy', 'Owner session handoff is already in progress.', 409);
      }
    }
    record.sessionHandoffState = 'claimed';
    record.sessionHandoffAt = nowIso(clock);
    return { status: 'completed', claimAt: record.sessionHandoffAt,
      accountId: record.authorizedAccountId, bindingAuthorityRevision: record.bindingAuthorityRevision };
  }, { clock });

  if (!claim.claimAt || claim.alreadyIssued) return claim;
  try {
    await authorizeDeviceBinding({ accountId: claim.accountId, bindingAuthorityRevision: claim.bindingAuthorityRevision });
    const sessionToken = await issueSession({ role: 'owner', authMethod: 'google_accounts_poll',
      ...(claim.accountId ? { accountId: claim.accountId } : {}),
      ...(claim.bindingAuthorityRevision ? { bindingAuthorityRevision: claim.bindingAuthorityRevision } : {}) });
    if (!trimString(sessionToken)) throw new Error('Failed to issue owner session');
    await updateOwnerAccountTransaction(txId, (record) => {
      if (record.sessionHandoffState === 'claimed' && record.sessionHandoffAt === claim.claimAt) {
        record.sessionHandoffState = 'issued';
        record.sessionHandoffAt = nowIso(clock);
      }
    }, { clock });
    return { status: 'completed', sessionToken };
  } catch (error) {
    await updateOwnerAccountTransaction(txId, (record) => {
      if (record.sessionHandoffState === 'claimed' && record.sessionHandoffAt === claim.claimAt) {
        record.sessionHandoffState = 'pending';
        record.sessionHandoffAt = '';
      }
    }, { clock });
    throw error;
  }
}

// 安全状态查询（契约 §5.3）：只返回 status/expiresAt/deliveryMode，
// 不暴露 accountId、断言或任何可兑换材料。expiresAt 由 TTL 推导。
export async function getOwnerAccountTransactionStatus(transactionId, { req, clock = Date.now } = {}) {
  const txId = trimString(transactionId);
  if (!txId) return null;
  const record = await readOwnerAccountTransaction(txId);
  if (!record) return null;
  // Login status is bound to the browser that initiated the flow. Bind status
  // remains queryable by opaque transaction id for the authenticated bind UI.
  if (req && record.deliveryMode === 'instance_poll' && record.purpose === 'login'
    && !hasValidBrowserState(req, record)) return null;
  const expiresMs = effectiveTransactionExpiryMs(record);
  const expiresAt = Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : '';
  let pollState = trimString(record.pollState);
  const effectiveExpiresMs = expiresMs;
  if (record.deliveryMode === 'instance_poll'
    && (pollState === 'polling' || pollState === '')
    && Number.isFinite(effectiveExpiresMs)
    && effectiveExpiresMs <= clock()) {
    await updateOwnerAccountTransaction(txId, (current) => {
      const currentState = trimString(current.pollState);
      if (currentState === 'polling' || currentState === '') {
        current.pollState = 'expired';
        current.pollError = 'owner_auth_transaction_invalid';
      }
    }, { clock });
    pollState = 'expired';
  }
  const status = pollState === 'polling' || pollState === '' ? 'pending' : pollState;
  return {
    status: ['pending', 'completed', 'failed', 'expired'].includes(status) ? status : 'pending',
    expiresAt,
    deliveryMode: record.deliveryMode === 'instance_poll' ? 'instance_poll' : 'browser_callback',
  };
}
