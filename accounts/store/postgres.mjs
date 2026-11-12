// @ts-check
// Accounts 的 PostgreSQL store：对 owner-auth broker 暴露与 file store 相同的
// mutate(draft => result) 契约，把状态持久化到关系表（accounts /
// owner_auth_transactions / instance_bindings / devices / binding_history /
// account_entitlements / account_sync_catalog / account_connection_leases /
// target_runtime_authorizations）。
//
// 并发模型：单进程内用互斥队列，跨进程用 pg_advisory_xact_lock，保证同一时刻
// 只有一个写入者；每次 mutate 在事务内重读快照、应用变更。join intents
// 按主键写入差异，其余表保持既有完整快照写入；锁协议不变。
// 数据库不可用时 mutate 直接抛错（fail-closed）。
import { Pool } from 'pg';
import { insertRowsInBatches, syncRowsByPrimaryKey } from './insert-batches.mjs';

// A single blocked advisory lock used to stall this process-local queue
// indefinitely while read-only health checks continued to pass. Bound the
// wait so callers receive a retryable database failure and the next queued
// mutation can make progress.
const DEFAULT_MUTATION_LOCK_TIMEOUT_MS = 5_000;

function normalizeTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** @typedef {import('pg').Pool} PgPool */
/** @typedef {import('pg').PoolClient} PgClient */

/**
 * @typedef {Object} StoredAccount
 * @property {string} accountId
 * @property {string} provider
 * @property {string} providerSubject
 * @property {string} [email]
 * @property {string} [name]
 * @property {string} createdAt
 */

/**
 * @typedef {Object} StoredTurnConnectionLease
 * @property {string} connectionId
 * @property {string} accountId
 * @property {string} instanceId
 * @property {string} deviceId
 * @property {string} deviceKind
 * @property {string} [quotaDeviceId]
 * @property {string} plan
 * @property {string} status
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} expiresAt
 * @property {string} [releasedAt]
 * @property {string} [releaseReason]
 */

/**
 * @typedef {Object} StoredEntitlement
 * @property {string} accountId
 * @property {string} plan
 * @property {string} source
 * @property {string} [expiresAt]
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} StoredTransaction
 * @property {string} id
 * @property {string} purpose
 * @property {string} [returnUrl]
 * @property {string} [deliveryMode]
 * @property {string} [pollRequestId]
 * @property {string} [pollRedeemedAt]
 * @property {string} [pollAssertion]
 * @property {string} [pollExpiresAt]
 * @property {{ instanceId: string, publicKey: string, keyFingerprint: string }} instance
 * @property {string} nonce
 * @property {string} bootstrapHash
 * @property {string} [browserStartedAt]
 * @property {string} [desktopStartedAt]
 * @property {string} [desktopStateHash]
 * @property {string} [phoneTicketHash]
 * @property {string} [phoneStartedAt]
 * @property {string} [phoneStateHash]
 * @property {string} [completedAt]
 * @property {string} [redeemedAt]
 * @property {string} [grantHash]
 * @property {string} [accountId]
 * @property {string} createdAt
 * @property {string} expiresAt
 */

/**
 * @typedef {Object} StoredBinding
 * @property {string} instanceId
 * @property {string} accountId
 * @property {string} provider
 * @property {string} [deviceAlias]
 * @property {string} [publicEndpoint]
 * @property {string} [instancePublicKey]
 * @property {string} [instanceKeyFingerprint]
 * @property {string} boundAt
 * @property {string} [lastSeenAt]
 * @property {string} [revokedAt]
 */

/**
 * @typedef {Object} StoredDevice
 * @property {string} deviceId
 * @property {string} instanceId
 * @property {string} accountId
 * @property {string} [alias]
 * @property {string} [lastSeenAt]
 * @property {string} [unboundAt]
 * @property {string} createdAt
 */

/**
 * @typedef {Object} StoredHistoryEntry
 * @property {string} instanceId
 * @property {string} accountId
 * @property {string} action
 * @property {string} occurredAt
 */

/**
 * @typedef {{
 *   accounts: StoredAccount[],
 *   ownerAuthTransactions: StoredTransaction[],
 *   instanceBindings: StoredBinding[],
 *   devices: StoredDevice[],
 *   bindingHistory: StoredHistoryEntry[],
 *   nativeAuthRequests: { requestId: string, instanceId: string, deviceId: string, accountId: string, completedAt: string, status?: string, bindingCreated?: boolean, deviceCreated?: boolean, previousBinding?: object, previousDevice?: object, rolledBackAt?: string }[],
 *   accountJoinIntents: { intentId: string, instanceId: string, deviceId: string, devicePublicKey: string, devicePublicKeyFingerprint: string, deviceAlias?: string, computerAlias?: string, platform?: string, publicEndpoint?: string, nonceHash: string, createdAt: string, expiresAt: string, status?: string, accountId?: string, accountDeviceId?: string, completionRequestId?: string, completedAt?: string, rendezvousRequestId?: string, rendezvousNonce?: string, rendezvousGrant?: string, rendezvousDeviceSignature?: string, rendezvousResult?: object, accountClaimTokenHash?: string }[],
 *   accountDevices: { deviceId: string, accountId: string, alias?: string, platform?: string, createdAt: string, lastSeenAt: string, unboundAt?: string, revokedAt?: string }[],
 *   accountDeviceKeys: { keyId: string, accountId: string, deviceId: string, publicKey: string, fingerprint: string, createdAt: string, revokedAt?: string }[],
 *   accountCredentials: { credentialId: string, tokenHash: string, accountId: string, deviceId: string, keyId: string, scope: string, issuedAt: string, expiresAt: string, revokedAt?: string, lastUsedAt?: string }[],
 *   accountSessionChallenges: { transactionId: string, requestId: string, deviceId: string, publicKey: string, publicKeyFingerprint: string, deviceAlias?: string, platform?: string, nonce: string, createdAt: string, expiresAt: string, consumedAt?: string }[],
 *   accountCredentialRefreshes: { credentialId: string, requestId: string, nonceHash: string, issuedAt: string, createdAt: string }[],
 *   accountJoinGrants: { grantHash: string, accountId: string, instanceId: string, intentId: string, deviceId: string, accountDeviceId: string, keyFingerprint: string, claimInstance?: boolean, publicEndpoint?: string, requestId: string, createdAt: string, expiresAt: string, redeemedAt?: string }[],
 *   accountEntitlements: StoredEntitlement[],
 *   turnConnectionLeases: StoredTurnConnectionLease[],
 *   accountSyncCatalog: { accountId: string, scope: string, key: string, version: object, sourceInstanceId: string, deletedAt?: string, updatedAt: string }[],
 *   targetRuntimeAuthorizations: { requestId: string, idempotencyKey: string, sourceInstanceId: string, targetInstanceId: string, accountId: string, method: string, path: string, operation: string, resourceId: string, expectedRevision: number, issuedAt: string, expiresAt: string, jti: string, grantHash: string, claims: object, createdAt: string }[],
 *   temporaryPairingExchanges: object[],
 *   temporaryPairingClock: number,
 *   temporaryControlExchanges: object[],
 *   temporaryControlClock: number,
 * }} StoreSnapshot
 */

const TRANSACTION_COLUMNS = [
  'transaction_id',
  'purpose',
  'alias',
  'delivery_mode',
  'poll_request_id',
  'poll_redeemed_at',
  'poll_assertion',
  'poll_expires_at',
  'return_url',
  'instance_id',
  'instance_public_key',
  'instance_key_fingerprint',
  'nonce',
  'bootstrap_hash',
  'browser_started_at',
  'desktop_started_at',
  'desktop_state_hash',
  'phone_ticket_hash',
  'phone_started_at',
  'phone_state_hash',
  'completed_at',
  'redeemed_at',
  'grant_hash',
  'account_id',
  'created_at',
  'expires_at',
];

function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return text === '' ? null : text;
}

function toIso(value) {
  const normalized = iso(value);
  return normalized ?? '';
}

function accountToRow(account) {
  return {
    account_id: String(account.accountId),
    provider: String(account.provider),
    provider_subject: String(account.providerSubject),
    email: account.email == null ? null : String(account.email),
    name: account.name == null ? null : String(account.name),
    created_at: iso(account.createdAt),
  };
}

function rowToAccount(row) {
  return {
    accountId: String(row.account_id),
    provider: String(row.provider),
    providerSubject: String(row.provider_subject),
    email: row.email == null ? undefined : String(row.email),
    name: row.name == null ? undefined : String(row.name),
    createdAt: toIso(row.created_at),
    ...(row.deletion_requested_at ? {
      deletionRequestedAt: toIso(row.deletion_requested_at), deletionJobId: String(row.deletion_job_id),
    } : {}),
  };
}

function transactionToRow(transaction) {
  const instance = transaction.instance || {};
  return {
    transaction_id: String(transaction.id),
    purpose: String(transaction.purpose),
    alias: iso(transaction.alias),
    delivery_mode: String(transaction.deliveryMode || 'browser_callback'),
    poll_request_id: String(transaction.pollRequestId || ''),
    poll_redeemed_at: iso(transaction.pollRedeemedAt),
    poll_assertion: iso(transaction.pollAssertion),
    poll_expires_at: iso(transaction.pollExpiresAt),
    return_url: iso(transaction.returnUrl),
    instance_id: String(instance.instanceId || ''),
    instance_public_key: String(instance.publicKey || ''),
    instance_key_fingerprint: String(instance.keyFingerprint || ''),
    nonce: String(transaction.nonce),
    bootstrap_hash: String(transaction.bootstrapHash),
    browser_started_at: iso(transaction.browserStartedAt),
    desktop_started_at: iso(transaction.desktopStartedAt),
    desktop_state_hash: iso(transaction.desktopStateHash),
    phone_ticket_hash: iso(transaction.phoneTicketHash),
    phone_started_at: iso(transaction.phoneStartedAt),
    phone_state_hash: iso(transaction.phoneStateHash),
    completed_at: iso(transaction.completedAt),
    redeemed_at: iso(transaction.redeemedAt),
    grant_hash: iso(transaction.grantHash),
    account_id: iso(transaction.accountId),
    created_at: iso(transaction.createdAt),
    expires_at: iso(transaction.expiresAt),
  };
}

function rowToTransaction(row) {
  return {
    id: String(row.transaction_id),
    purpose: String(row.purpose),
    alias: toIso(row.alias),
    deliveryMode: String(row.delivery_mode || 'browser_callback'),
    pollRequestId: String(row.poll_request_id || ''),
    pollRedeemedAt: toIso(row.poll_redeemed_at),
    pollAssertion: toIso(row.poll_assertion),
    pollExpiresAt: toIso(row.poll_expires_at),
    returnUrl: toIso(row.return_url),
    instance: {
      instanceId: String(row.instance_id),
      publicKey: String(row.instance_public_key),
      keyFingerprint: String(row.instance_key_fingerprint),
    },
    nonce: String(row.nonce),
    bootstrapHash: String(row.bootstrap_hash),
    browserStartedAt: toIso(row.browser_started_at),
    desktopStartedAt: toIso(row.desktop_started_at),
    desktopStateHash: toIso(row.desktop_state_hash),
    phoneTicketHash: toIso(row.phone_ticket_hash),
    phoneStartedAt: toIso(row.phone_started_at),
    phoneStateHash: toIso(row.phone_state_hash),
    completedAt: toIso(row.completed_at),
    redeemedAt: toIso(row.redeemed_at),
    grantHash: toIso(row.grant_hash),
    accountId: toIso(row.account_id),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
  };
}

function bindingToRow(binding) {
  return {
    instance_id: String(binding.instanceId),
    account_id: String(binding.accountId),
    provider: String(binding.provider),
    device_alias: iso(binding.deviceAlias),
    public_endpoint: iso(binding.publicEndpoint),
    instance_public_key: iso(binding.instancePublicKey),
    instance_key_fingerprint: iso(binding.instanceKeyFingerprint),
    bound_at: iso(binding.boundAt),
    last_seen_at: iso(binding.lastSeenAt),
    revoked_at: iso(binding.revokedAt),
  };
}

function rowToBinding(row) {
  return {
    instanceId: String(row.instance_id),
    accountId: String(row.account_id),
    provider: String(row.provider),
    deviceAlias: toIso(row.device_alias),
    publicEndpoint: toIso(row.public_endpoint),
    instancePublicKey: toIso(row.instance_public_key),
    instanceKeyFingerprint: toIso(row.instance_key_fingerprint),
    boundAt: toIso(row.bound_at),
    lastSeenAt: toIso(row.last_seen_at),
    revokedAt: toIso(row.revoked_at),
  };
}

function deviceToRow(device) {
  return {
    device_id: String(device.deviceId),
    instance_id: String(device.instanceId),
    account_id: String(device.accountId),
    alias: iso(device.alias),
    device_public_key_fingerprint: iso(device.devicePublicKeyFingerprint),
    device_kind: device.deviceKind === 'computer' ? 'computer' : 'phone',
    last_seen_at: iso(device.lastSeenAt),
    unbound_at: iso(device.unboundAt),
    created_at: iso(device.createdAt),
  };
}

function rowToDevice(row) {
  return {
    deviceId: String(row.device_id),
    instanceId: String(row.instance_id),
    accountId: String(row.account_id),
    alias: toIso(row.alias),
    devicePublicKeyFingerprint: toIso(row.device_public_key_fingerprint),
    deviceKind: row.device_kind === 'computer' ? 'computer' : 'phone',
    lastSeenAt: toIso(row.last_seen_at),
    unboundAt: toIso(row.unbound_at),
    createdAt: toIso(row.created_at),
  };
}

function rowToEntitlement(row) {
  return {
    accountId: String(row.account_id),
    plan: String(row.plan || 'free'),
    source: String(row.source || 'manual'),
    expiresAt: toIso(row.expires_at),
    updatedAt: toIso(row.updated_at),
  };
}

function turnConnectionLeaseToRow(lease) {
  return {
    connection_id: String(lease.connectionId),
    account_id: String(lease.accountId),
    instance_id: String(lease.instanceId),
    device_id: String(lease.deviceId),
    device_kind: String(lease.deviceKind || 'phone'),
    quota_device_id: String(lease.quotaDeviceId || lease.deviceId),
    plan: String(lease.plan || 'free'),
    status: String(lease.status || 'reserved'),
    created_at: iso(lease.createdAt),
    updated_at: iso(lease.updatedAt),
    expires_at: iso(lease.expiresAt),
    released_at: iso(lease.releasedAt),
    release_reason: iso(lease.releaseReason),
    handoff_from: iso(lease.handoffFrom),
    handoff_deadline: iso(lease.handoffDeadline),
    handoff_committed_at: iso(lease.handoffCommittedAt),
  };
}

function rowToTurnConnectionLease(row) {
  return {
    connectionId: String(row.connection_id),
    accountId: String(row.account_id),
    instanceId: String(row.instance_id),
    deviceId: String(row.device_id),
    deviceKind: row.device_kind === 'computer' ? 'computer' : 'phone',
    quotaDeviceId: String(row.quota_device_id || row.device_id),
    plan: String(row.plan || 'free'),
    status: ['reserved', 'connected', 'released'].includes(String(row.status))
      ? String(row.status)
      : 'reserved',
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    expiresAt: toIso(row.expires_at),
    releasedAt: toIso(row.released_at),
    releaseReason: toIso(row.release_reason),
    handoffFrom: String(row.handoff_from || ''),
    handoffDeadline: toIso(row.handoff_deadline),
    handoffCommittedAt: toIso(row.handoff_committed_at),
  };
}

function rowToAccountSyncCatalog(row) {
  return {
    accountId: String(row.account_id),
    scope: String(row.scope),
    key: String(row.content_key),
    version: row.version || {},
    sourceInstanceId: String(row.source_instance_id),
    deletedAt: toIso(row.deleted_at),
    updatedAt: toIso(row.updated_at),
  };
}

function accountSyncCatalogToRow(item) {
  return {
    account_id: String(item.accountId),
    scope: String(item.scope),
    content_key: String(item.key),
    version: item.version || {},
    source_instance_id: String(item.sourceInstanceId),
    deleted_at: iso(item.deletedAt),
    updated_at: iso(item.updatedAt),
  };
}

function entitlementToRow(item) {
  return {
    account_id: String(item.accountId),
    plan: String(item.plan || 'free'),
    source: String(item.source || 'manual'),
    expires_at: iso(item.expiresAt),
    updated_at: iso(item.updatedAt),
  };
}

function historyToRow(entry) {
  return {
    instance_id: String(entry.instanceId),
    account_id: String(entry.accountId),
    action: String(entry.action),
    occurred_at: iso(entry.occurredAt),
  };
}

function rowToHistory(row) {
  return {
    instanceId: String(row.instance_id),
    accountId: String(row.account_id),
    action: String(row.action),
    occurredAt: toIso(row.occurred_at),
  };
}

function rowToNativeAuthRequest(row) {
  return {
    requestId: String(row.request_id),
    instanceId: String(row.instance_id),
    deviceId: String(row.device_id),
    accountId: String(row.account_id),
    completedAt: toIso(row.completed_at),
    status: String(row.status || 'completed'),
    bindingCreated: Boolean(row.binding_created),
    deviceCreated: Boolean(row.device_created),
    previousBinding: row.previous_binding || null,
    previousDevice: row.previous_device || null,
    rolledBackAt: toIso(row.rolled_back_at),
  };
}

function nativeAuthRequestToRow(item) {
  return {
    request_id: String(item.requestId),
    instance_id: String(item.instanceId),
    device_id: String(item.deviceId),
    account_id: String(item.accountId),
    completed_at: iso(item.completedAt),
    status: String(item.status || 'completed'),
    binding_created: item.bindingCreated === true,
    device_created: item.deviceCreated === true,
    previous_binding: item.previousBinding || null,
    previous_device: item.previousDevice || null,
    rolled_back_at: iso(item.rolledBackAt),
  };
}

function accountJoinIntentToRow(item) {
  const instance = item.instance || {};
  return {
    intent_id: String(item.intentId),
    instance_id: String(item.instanceId),
    instance_public_key: String(instance.publicKey || ''),
    instance_key_fingerprint: String(instance.keyFingerprint || ''),
    device_id: String(item.deviceId),
    device_public_key: String(item.devicePublicKey),
    device_public_key_fingerprint: String(item.devicePublicKeyFingerprint),
    device_alias: iso(item.deviceAlias),
    computer_alias: iso(item.computerAlias),
    platform: iso(item.platform),
    public_endpoint: iso(item.publicEndpoint),
    nonce_hash: String(item.nonceHash),
    issued_at: iso(item.issuedAt),
    created_at: iso(item.createdAt),
    expires_at: iso(item.expiresAt),
    status: String(item.status || 'pending'),
    account_id: iso(item.accountId),
    account_device_id: iso(item.accountDeviceId),
    completion_request_id: iso(item.completionRequestId),
    completed_at: iso(item.completedAt),
    rendezvous_request_id: iso(item.rendezvousRequestId),
    rendezvous_nonce: iso(item.rendezvousNonce),
    rendezvous_grant: iso(item.rendezvousGrant),
    rendezvous_device_signature: iso(item.rendezvousDeviceSignature),
    rendezvous_result: item.rendezvousResult || null,
    account_claim_token_hash: iso(item.accountClaimTokenHash),
  };
}

function rowToAccountJoinIntent(row) {
  return {
    intentId: String(row.intent_id),
    instanceId: String(row.instance_id),
    instance: {
      instanceId: String(row.instance_id),
      publicKey: String(row.instance_public_key),
      keyFingerprint: String(row.instance_key_fingerprint),
    },
    deviceId: String(row.device_id),
    devicePublicKey: String(row.device_public_key),
    devicePublicKeyFingerprint: String(row.device_public_key_fingerprint),
    deviceAlias: toIso(row.device_alias),
    computerAlias: toIso(row.computer_alias),
    platform: toIso(row.platform),
    publicEndpoint: toIso(row.public_endpoint),
    nonceHash: String(row.nonce_hash),
    issuedAt: toIso(row.issued_at),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    status: String(row.status || 'pending'),
    accountId: toIso(row.account_id),
    accountDeviceId: toIso(row.account_device_id),
    completionRequestId: toIso(row.completion_request_id),
    rendezvousRequestId: toIso(row.rendezvous_request_id),
    rendezvousNonce: toIso(row.rendezvous_nonce),
    rendezvousGrant: toIso(row.rendezvous_grant),
    rendezvousDeviceSignature: toIso(row.rendezvous_device_signature),
    rendezvousResult: row.rendezvous_result || null,
    accountClaimTokenHash: toIso(row.account_claim_token_hash),
    completedAt: toIso(row.completed_at),
  };
}

function accountDeviceToRow(item) {
  return {
    device_id: String(item.deviceId), account_id: String(item.accountId), alias: iso(item.alias),
    platform: iso(item.platform), created_at: iso(item.createdAt), last_seen_at: iso(item.lastSeenAt), unbound_at: iso(item.unboundAt), revoked_at: iso(item.revokedAt),
  };
}
function rowToAccountDevice(row) {
  return {
    deviceId: String(row.device_id), accountId: String(row.account_id), alias: toIso(row.alias), platform: toIso(row.platform),
    createdAt: toIso(row.created_at), lastSeenAt: toIso(row.last_seen_at), unboundAt: toIso(row.unbound_at), revokedAt: toIso(row.revoked_at),
  };
}
function accountDeviceKeyToRow(item) {
  return {
    key_id: String(item.keyId), account_id: String(item.accountId), device_id: String(item.deviceId),
    public_key: String(item.publicKey), fingerprint: String(item.fingerprint), created_at: iso(item.createdAt), revoked_at: iso(item.revokedAt),
  };
}
function rowToAccountDeviceKey(row) {
  return {
    keyId: String(row.key_id), accountId: String(row.account_id), deviceId: String(row.device_id), publicKey: String(row.public_key),
    fingerprint: String(row.fingerprint), createdAt: toIso(row.created_at), revokedAt: toIso(row.revoked_at),
  };
}
function accountCredentialToRow(item) {
  return {
    credential_id: String(item.credentialId), token_hash: String(item.tokenHash), account_id: String(item.accountId),
    device_id: String(item.deviceId), key_id: String(item.keyId), scope: String(item.scope || ''), issued_at: iso(item.issuedAt),
    expires_at: iso(item.expiresAt), revoked_at: iso(item.revokedAt), last_used_at: iso(item.lastUsedAt),
  };
}
function rowToAccountCredential(row) {
  return {
    credentialId: String(row.credential_id), tokenHash: String(row.token_hash), accountId: String(row.account_id),
    deviceId: String(row.device_id), keyId: String(row.key_id), scope: String(row.scope || ''), issuedAt: toIso(row.issued_at),
    expiresAt: toIso(row.expires_at), revokedAt: toIso(row.revoked_at), lastUsedAt: toIso(row.last_used_at),
  };
}
function accountSessionChallengeToRow(item) {
  return {
    transaction_id: String(item.transactionId), request_id: String(item.requestId), device_id: String(item.deviceId),
    public_key: String(item.publicKey), public_key_fingerprint: String(item.publicKeyFingerprint), device_alias: iso(item.deviceAlias),
    platform: iso(item.platform), nonce: String(item.nonce), created_at: iso(item.createdAt), expires_at: iso(item.expiresAt), consumed_at: iso(item.consumedAt),
  };
}
function rowToAccountSessionChallenge(row) {
  return {
    transactionId: String(row.transaction_id), requestId: String(row.request_id), deviceId: String(row.device_id),
    publicKey: String(row.public_key), publicKeyFingerprint: String(row.public_key_fingerprint), deviceAlias: toIso(row.device_alias),
    platform: toIso(row.platform), nonce: String(row.nonce), createdAt: toIso(row.created_at), expiresAt: toIso(row.expires_at), consumedAt: toIso(row.consumed_at),
  };
}
function accountCredentialRefreshToRow(item) {
  return {
    credential_id: String(item.credentialId), request_id: String(item.requestId), nonce_hash: String(item.nonceHash),
    issued_at: iso(item.issuedAt), created_at: iso(item.createdAt),
  };
}
function rowToAccountCredentialRefresh(row) {
  return {
    credentialId: String(row.credential_id), requestId: String(row.request_id), nonceHash: String(row.nonce_hash),
    issuedAt: toIso(row.issued_at), createdAt: toIso(row.created_at),
  };
}
function accountJoinGrantToRow(item) {
  return {
    grant_hash: String(item.grantHash), account_id: String(item.accountId), instance_id: String(item.instanceId),
    intent_id: String(item.intentId), device_id: String(item.deviceId), account_device_id: String(item.accountDeviceId), key_fingerprint: String(item.keyFingerprint),
    claim_instance: item.claimInstance === true, public_endpoint: iso(item.publicEndpoint),
    request_id: String(item.requestId), created_at: iso(item.createdAt), expires_at: iso(item.expiresAt), redeemed_at: iso(item.redeemedAt),
  };
}
function rowToAccountJoinGrant(row) {
  return {
    grantHash: String(row.grant_hash), accountId: String(row.account_id), instanceId: String(row.instance_id), intentId: String(row.intent_id),
    deviceId: String(row.device_id), accountDeviceId: String(row.account_device_id), keyFingerprint: String(row.key_fingerprint),
    claimInstance: row.claim_instance === true, publicEndpoint: toIso(row.public_endpoint), requestId: String(row.request_id),
    createdAt: toIso(row.created_at), expiresAt: toIso(row.expires_at), redeemedAt: toIso(row.redeemed_at),
  };
}

function targetRuntimeAuthorizationToRow(item) {
  return {
    request_id: String(item.requestId),
    idempotency_key: String(item.idempotencyKey),
    source_instance_id: String(item.sourceInstanceId),
    target_instance_id: String(item.targetInstanceId),
    account_id: String(item.accountId),
    method: String(item.method),
    path: String(item.path),
    operation: String(item.operation),
    resource_id: String(item.resourceId),
    expected_revision: String(Math.trunc(Number(item.expectedRevision) || 0)),
    issued_at: iso(item.issuedAt),
    expires_at: iso(item.expiresAt),
    jti: String(item.jti),
    grant_hash: String(item.grantHash),
    claims: item.claims || {},
    created_at: iso(item.createdAt),
  };
}

function rowToTargetRuntimeAuthorization(row) {
  return {
    requestId: String(row.request_id),
    idempotencyKey: String(row.idempotency_key),
    sourceInstanceId: String(row.source_instance_id),
    targetInstanceId: String(row.target_instance_id),
    accountId: String(row.account_id),
    method: String(row.method),
    path: String(row.path),
    operation: String(row.operation),
    resourceId: String(row.resource_id),
    expectedRevision: Number(row.expected_revision) || 0,
    issuedAt: toIso(row.issued_at),
    expiresAt: toIso(row.expires_at),
    jti: String(row.jti),
    grantHash: String(row.grant_hash),
    claims: row.claims || {},
    createdAt: toIso(row.created_at),
  };
}

// 跨设备 provider refresh lease：与 file store 相同的 draft 形状
// （providerRefreshLeases 数组 + providerRefreshMeta 对象）。
const REFRESH_LEASE_STATES = ['held', 'stolen', 'committed', 'failed', 'uncertain', 'released'];

function providerRefreshLeaseToRow(lease) {
  return {
    lease_id: String(lease.leaseId), identity_key: String(lease.identityKey), account_id: String(lease.accountId),
    provider_family: String(lease.providerFamily), account_key: String(lease.accountKey),
    credential_instance_id: String(lease.credentialInstanceId), holder_instance_id: String(lease.holderInstanceId),
    run_id: String(lease.runId || ''), fencing_token: String(Math.trunc(Number(lease.fencingToken) || 0)),
    state: String(lease.state || 'held'), outcome: iso(lease.outcome),
    notes: iso(lease.notes), created_at: iso(lease.createdAt), updated_at: iso(lease.updatedAt),
    expires_at: iso(lease.expiresAt), last_heartbeat_at: iso(lease.lastHeartbeatAt), closed_at: iso(lease.closedAt),
  };
}

function rowToProviderRefreshLease(row) {
  return {
    identityKey: String(row.identity_key), leaseId: String(row.lease_id), accountId: String(row.account_id),
    providerFamily: String(row.provider_family), accountKey: String(row.account_key),
    credentialInstanceId: String(row.credential_instance_id), holderInstanceId: String(row.holder_instance_id),
    runId: String(row.run_id || ''), fencingToken: Number(row.fencing_token) || 0,
    state: REFRESH_LEASE_STATES.includes(String(row.state)) ? String(row.state) : 'released',
    outcome: toIso(row.outcome), notes: toIso(row.notes),
    createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at), expiresAt: toIso(row.expires_at),
    lastHeartbeatAt: toIso(row.last_heartbeat_at), closedAt: toIso(row.closed_at),
  };
}

function providerRefreshMetaToRow(meta) {
  return {
    identity_key: String(meta.identityKey), account_id: String(meta.accountId),
    provider_family: String(meta.providerFamily), account_key: String(meta.accountKey),
    credential_instance_id: String(meta.credentialInstanceId),
    credential_version: String(Math.trunc(Number(meta.credentialVersion) || 0)),
    fencing_token: String(Math.trunc(Number(meta.fencingToken) || 0)),
    updated_at: iso(meta.updatedAt), updated_by_instance_id: iso(meta.updatedByInstanceId),
    last_uncertain_at: iso(meta.lastUncertainAt),
  };
}

function rowToProviderRefreshMeta(row) {
  return {
    identityKey: String(row.identity_key), accountId: String(row.account_id),
    providerFamily: String(row.provider_family), accountKey: String(row.account_key),
    credentialInstanceId: String(row.credential_instance_id),
    credentialVersion: Number(row.credential_version) || 0, fencingToken: Number(row.fencing_token) || 0,
    updatedAt: toIso(row.updated_at), updatedByInstanceId: toIso(row.updated_by_instance_id),
    lastUncertainAt: toIso(row.last_uncertain_at),
  };
}

async function replaceRows(client, table, columns, rows, toRow) {
  await client.query(`delete from ${table}`);
  await insertRowsInBatches(client, table, columns, rows, toRow);
}

async function instanceAccessGrantStorageVersion(client) {
  const result = await client.query(`select target is not null as available,
    exists(select 1 from pg_catalog.pg_attribute where attrelid=target and attname='request_id' and not attisdropped) as replay_ready
    from (select to_regclass(format('%I.%I', current_schema(), 'instance_access_grants')) as target) as storage`);
  return result.rows[0]?.replay_ready ? 2 : result.rows[0]?.available ? 1 : 0;
}

async function readSnapshot(client) {
  const accounts = await client.query('select * from accounts order by created_at, account_id');
  const transactions = await client.query('select * from owner_auth_transactions order by created_at, transaction_id');
  const browserStates = await client.query('select * from owner_auth_browser_states');
  const browserStateBySource = new Map(browserStates.rows.map(row => [
    JSON.stringify([row.transaction_id, row.nonce, row.bootstrap_hash]), row.state_hash,
  ]));
  const bindings = await client.query('select * from instance_bindings order by bound_at, instance_id');
  const instanceAccessGrants = await instanceAccessGrantStorageVersion(client)
    ? await client.query('select * from instance_access_grants order by created_at, grant_id') : { rows: [] };
  const devices = await client.query('select * from devices order by created_at, device_id');
  const history = await client.query('select * from binding_history order by occurred_at, instance_id');
  const nativeAuthRequests = await client.query('select * from native_owner_auth_requests order by completed_at, request_id');
  const accountJoinIntents = await client.query('select * from account_join_intents order by created_at, intent_id');
  const accountEntitlements = await client.query('select * from account_entitlements order by account_id');
  const accountFileUploads = await client.query('select * from account_file_uploads order by account_id, request_id');
  const turnConnectionLeases = await client.query('select * from account_connection_leases order by created_at, connection_id');
  const accountSyncCatalog = await client.query('select * from account_sync_catalog order by account_id, scope, content_key');
  const accountDevices = await client.query('select * from account_devices order by created_at, device_id');
  const accountDeviceKeys = await client.query('select * from account_device_keys order by created_at, key_id');
  const accountCredentials = await client.query('select * from account_credentials order by issued_at, credential_id');
  const accountSessionChallenges = await client.query('select * from account_session_challenges order by created_at, transaction_id');
  const accountCredentialRefreshes = await client.query('select * from account_credential_refreshes order by created_at, credential_id, request_id');
  const accountJoinGrants = await client.query('select * from account_join_grants order by created_at, intent_id');
  const providerRefreshLeases = await client.query('select * from provider_refresh_leases order by created_at, lease_id');
  const providerRefreshMetaRows = await client.query('select * from provider_refresh_meta order by identity_key');
  const targetRuntimeAuthorizations = await client.query('select * from target_runtime_authorizations order by created_at, request_id');
  const temporaryExchanges = await client.query('select * from temporary_pairing_exchanges order by invitation_id');
  const temporaryClock = await client.query('select last_observed_at from temporary_pairing_clock where singleton = true');
  const temporaryControlExchanges = await client.query('select * from temporary_control_exchanges order by invitation_id');
  const accountPairingExchanges = await client.query('select * from account_pairing_exchanges order by invitation_id');
  const temporaryControlClock = await client.query('select last_observed_at from temporary_control_clock where singleton = true');
  if (temporaryClock.rows.length !== 1 || !Number.isSafeInteger(Number(temporaryClock.rows[0].last_observed_at))
    || Number(temporaryClock.rows[0].last_observed_at) < 0) throw new Error('Temporary pairing clock is missing or invalid');
  if (temporaryControlClock.rows.length !== 1 || !Number.isSafeInteger(Number(temporaryControlClock.rows[0].last_observed_at))
    || Number(temporaryControlClock.rows[0].last_observed_at) < 0) throw new Error('Temporary control clock is missing or invalid');
  return {
    accounts: accounts.rows.map(rowToAccount),
    accountPairingExchanges: accountPairingExchanges.rows.map((row) => {
      const p = row.payload;
      if (!p || p.invitationId !== row.invitation_id || p.instanceId !== row.instance_id
        || p.accountId !== row.account_id || p.status !== row.status || p.expiresAt !== Number(row.expires_at)) {
        throw new Error('Account pairing row does not match its payload');
      }
      return p;
    }),
    temporaryPairingExchanges: temporaryExchanges.rows.map((row) => {
      const p = row.payload;
      if (!p || p.invitationId !== row.invitation_id || p.instanceId !== row.instance_id || p.accountId !== row.account_id
        || p.status !== row.status || p.claimExpiresAt !== Number(row.claim_expires_at) || p.accessExpiresAt !== Number(row.access_expires_at)) {
        throw new Error('Temporary pairing row does not match its payload');
      }
      return p;
    }),
    temporaryPairingClock: Number(temporaryClock.rows[0].last_observed_at),
    temporaryControlExchanges: temporaryControlExchanges.rows.map((row) => {
      const p = row.payload;
      if (!p || p.invitationId !== row.invitation_id || p.instanceId !== row.instance_id || p.accountId !== row.account_id
        || p.status !== row.status || p.claimExpiresAt !== Number(row.claim_expires_at)
        || (p.accessExpiresAt ?? null) !== (row.access_expires_at == null ? null : Number(row.access_expires_at))) {
        throw new Error('Temporary control row does not match its payload');
      }
      return p;
    }),
    temporaryControlClock: Number(temporaryControlClock.rows[0].last_observed_at),
    ownerAuthTransactions: transactions.rows.map(row => ({ ...rowToTransaction(row),
      browserStateHash: browserStateBySource.get(JSON.stringify([row.transaction_id, row.nonce, row.bootstrap_hash])) || '',
    })),
    instanceBindings: bindings.rows.map(rowToBinding),
    instanceAccessGrants: instanceAccessGrants.rows.map(row => ({ grantId: String(row.grant_id), requestId: String(row.request_id || `legacy_${row.grant_id}`),
      instanceId: String(row.instance_id), ownerAccountId: String(row.owner_account_id), accountId: String(row.account_id),
      bindingKeyFingerprint: String(row.binding_key_fingerprint), bindingBoundAt: toIso(row.binding_bound_at),
      bindingHistoryFingerprint: String(row.binding_history_fingerprint),
      scope: String(row.scope), createdAt: toIso(row.created_at), revokedAt: toIso(row.revoked_at) })),
    devices: devices.rows.map(rowToDevice),
    bindingHistory: history.rows.map(rowToHistory),
    nativeAuthRequests: nativeAuthRequests.rows.map(rowToNativeAuthRequest),
    accountJoinIntents: accountJoinIntents.rows.map(rowToAccountJoinIntent),
    accountEntitlements: accountEntitlements.rows.map(rowToEntitlement),
    accountFileUploads: accountFileUploads.rows.map((row) => ({
      accountId: String(row.account_id), requestId: String(row.request_id), instanceId: String(row.instance_id),
      quotaBatchId: String(row.quota_batch_id ?? row.request_id), sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256), status: String(row.status),
      reservedUntil: row.reserved_until ? toIso(row.reserved_until) : '',
      createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
    })),
    turnConnectionLeases: turnConnectionLeases.rows.map(rowToTurnConnectionLease),
    accountSyncCatalog: accountSyncCatalog.rows.map(rowToAccountSyncCatalog),
    accountDevices: accountDevices.rows.map(rowToAccountDevice),
    accountDeviceKeys: accountDeviceKeys.rows.map(rowToAccountDeviceKey),
    accountCredentials: accountCredentials.rows.map(rowToAccountCredential),
    accountSessionChallenges: accountSessionChallenges.rows.map(rowToAccountSessionChallenge),
    accountCredentialRefreshes: accountCredentialRefreshes.rows.map(rowToAccountCredentialRefresh),
    accountJoinGrants: accountJoinGrants.rows.map(rowToAccountJoinGrant),
    providerRefreshLeases: providerRefreshLeases.rows.map(rowToProviderRefreshLease),
    providerRefreshMeta: Object.fromEntries(providerRefreshMetaRows.rows.map((row) => {
      const meta = rowToProviderRefreshMeta(row);
      return [meta.identityKey, meta];
    })),
    targetRuntimeAuthorizations: targetRuntimeAuthorizations.rows.map(rowToTargetRuntimeAuthorization),
  };
}

async function writeSnapshot(client, snapshot, previousSnapshot) {
  // Clear this FK subgraph before generic full-rewrite insertion.  The broker
  // is serialized, so a transient empty set is never externally observable.
  const grantsStorageVersion = await instanceAccessGrantStorageVersion(client);
  if (grantsStorageVersion < 2 && JSON.stringify(snapshot.instanceAccessGrants || []) !== JSON.stringify(previousSnapshot.instanceAccessGrants || [])) {
    throw new Error('Instance access grants migration is required');
  }
  if (grantsStorageVersion >= 2) await client.query('delete from instance_access_grants');
  await client.query('delete from account_join_grants');
  await client.query('delete from account_credential_refreshes');
  await client.query('delete from account_session_challenges');
  await client.query('delete from account_credentials');
  await client.query('delete from account_device_keys');
  // Retain unchanged phone parents: deleting/reinserting them would trigger
  // ON DELETE SET NULL on intent rows that the delta writer leaves untouched.
  for (const account of snapshot.accounts) {
    const row = accountToRow(account);
    await client.query(
      `insert into accounts (account_id, provider, provider_subject, email, name, created_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (account_id) do update set
         provider = excluded.provider,
         provider_subject = excluded.provider_subject,
         email = excluded.email,
         name = excluded.name,
         created_at = coalesce(accounts.created_at, excluded.created_at)`,
      [row.account_id, row.provider, row.provider_subject, row.email, row.name, row.created_at],
    );
  }
  const remaining = snapshot.accounts.map((account) => account.accountId);
  await client.query('delete from accounts where not (account_id = any($1::text[]))', [remaining]);

  await replaceRows(
    client,
    'owner_auth_transactions',
    TRANSACTION_COLUMNS,
    snapshot.ownerAuthTransactions,
    transactionToRow,
  );
  for (const transaction of snapshot.ownerAuthTransactions) {
    if (!transaction.browserStateHash) continue;
    if (!/^[a-f0-9]{64}$/.test(transaction.browserStateHash)) throw new Error('Invalid retained browser state');
    const retained = await client.query(
      `insert into owner_auth_browser_states (transaction_id, nonce, bootstrap_hash, state_hash)
       values ($1,$2,$3,$4) on conflict (transaction_id, nonce, bootstrap_hash)
       do update set state_hash=excluded.state_hash where owner_auth_browser_states.state_hash=excluded.state_hash
       returning state_hash`,
      [transaction.id, transaction.nonce, transaction.bootstrapHash, transaction.browserStateHash]);
    if (retained.rowCount !== 1) throw new Error('Browser state cannot replace an existing authorization');
  }
  await client.query(`delete from owner_auth_browser_states s where not exists
    (select 1 from owner_auth_transactions t where t.transaction_id=s.transaction_id
     and t.nonce=s.nonce and t.bootstrap_hash=s.bootstrap_hash)`);
  await replaceRows(
    client,
    'instance_bindings',
    ['instance_id', 'account_id', 'provider', 'device_alias', 'public_endpoint', 'instance_public_key', 'instance_key_fingerprint', 'bound_at', 'last_seen_at', 'revoked_at'],
    snapshot.instanceBindings || [],
    bindingToRow,
  );
  const liveAccountIds = new Set(snapshot.accounts.map(account => account.accountId));
  if (grantsStorageVersion >= 2) await replaceRows(client, 'instance_access_grants',
    ['grant_id', 'request_id', 'instance_id', 'owner_account_id', 'account_id', 'binding_key_fingerprint', 'binding_bound_at', 'binding_history_fingerprint',
      'scope', 'created_at', 'revoked_at'],
    (snapshot.instanceAccessGrants || []).filter(grant => liveAccountIds.has(grant.ownerAccountId) && liveAccountIds.has(grant.accountId)),
    grant => ({ grant_id: grant.grantId, request_id: grant.requestId, instance_id: grant.instanceId, owner_account_id: grant.ownerAccountId,
      account_id: grant.accountId, binding_key_fingerprint: grant.bindingKeyFingerprint,
      binding_bound_at: grant.bindingBoundAt, binding_history_fingerprint: grant.bindingHistoryFingerprint, scope: grant.scope, created_at: grant.createdAt, revoked_at: grant.revokedAt || null }));
  await replaceRows(
    client,
    'devices',
    ['device_id', 'instance_id', 'account_id', 'alias', 'device_public_key_fingerprint', 'device_kind', 'last_seen_at', 'unbound_at', 'created_at'],
    snapshot.devices || [],
    deviceToRow,
  );
  await replaceRows(
    client,
    'account_entitlements',
    ['account_id', 'plan', 'source', 'expires_at', 'updated_at'],
    snapshot.accountEntitlements || [],
    entitlementToRow,
  );
  await replaceRows(
    client,
    'account_file_uploads',
    ['account_id', 'request_id', 'instance_id', 'quota_batch_id', 'size_bytes', 'sha256', 'status', 'reserved_until', 'created_at', 'updated_at'],
    snapshot.accountFileUploads || [],
    (item) => ({ account_id: item.accountId, request_id: item.requestId, instance_id: item.instanceId,
      quota_batch_id: item.quotaBatchId, size_bytes: item.sizeBytes, sha256: item.sha256, status: item.status,
      reserved_until: item.reservedUntil || null, created_at: item.createdAt, updated_at: item.updatedAt }),
  );
  await replaceRows(
    client,
    'account_connection_leases',
    ['connection_id', 'account_id', 'instance_id', 'device_id', 'device_kind', 'quota_device_id', 'plan', 'status', 'created_at', 'updated_at', 'expires_at', 'released_at', 'release_reason', 'handoff_from', 'handoff_deadline', 'handoff_committed_at'],
    snapshot.turnConnectionLeases || [],
    turnConnectionLeaseToRow,
  );
  await replaceRows(
    client,
    'account_sync_catalog',
    ['account_id', 'scope', 'content_key', 'version', 'source_instance_id', 'deleted_at', 'updated_at'],
    snapshot.accountSyncCatalog || [],
    accountSyncCatalogToRow,
  );
  await replaceRows(
    client,
    'target_runtime_authorizations',
    ['request_id', 'idempotency_key', 'source_instance_id', 'target_instance_id', 'account_id', 'method', 'path', 'operation', 'resource_id', 'expected_revision', 'issued_at', 'expires_at', 'jti', 'grant_hash', 'claims', 'created_at'],
    snapshot.targetRuntimeAuthorizations || [],
    targetRuntimeAuthorizationToRow,
  );
  await replaceRows(
    client,
    'binding_history',
    ['instance_id', 'account_id', 'action', 'occurred_at'],
    snapshot.bindingHistory || [],
    historyToRow,
  );
  await replaceRows(
    client,
    'native_owner_auth_requests',
    ['request_id', 'instance_id', 'device_id', 'account_id', 'completed_at', 'status', 'binding_created', 'device_created', 'previous_binding', 'previous_device', 'rolled_back_at'],
    snapshot.nativeAuthRequests || [],
    nativeAuthRequestToRow,
  );
  await syncRowsByPrimaryKey(
    client,
    'account_devices',
    ['device_id', 'account_id', 'alias', 'platform', 'created_at', 'last_seen_at', 'unbound_at', 'revoked_at'],
    snapshot.accountDevices || [],
    previousSnapshot.accountDevices || [],
    accountDeviceToRow,
    'device_id',
  );
  await syncRowsByPrimaryKey(
    client,
    'account_join_intents',
    ['intent_id', 'instance_id', 'instance_public_key', 'instance_key_fingerprint', 'device_id', 'device_public_key', 'device_public_key_fingerprint', 'device_alias', 'computer_alias', 'platform', 'public_endpoint', 'nonce_hash', 'issued_at', 'created_at', 'expires_at', 'status', 'account_id', 'account_device_id', 'completion_request_id', 'completed_at', 'rendezvous_request_id', 'rendezvous_nonce', 'rendezvous_grant', 'rendezvous_device_signature', 'rendezvous_result', 'account_claim_token_hash'],
    snapshot.accountJoinIntents || [],
    previousSnapshot.accountJoinIntents || [],
    accountJoinIntentToRow,
    'intent_id',
  );
  await replaceRows(
    client,
    'account_device_keys',
    ['key_id', 'account_id', 'device_id', 'public_key', 'fingerprint', 'created_at', 'revoked_at'],
    snapshot.accountDeviceKeys || [],
    accountDeviceKeyToRow,
  );
  await replaceRows(
    client,
    'account_credentials',
    ['credential_id', 'token_hash', 'account_id', 'device_id', 'key_id', 'scope', 'issued_at', 'expires_at', 'revoked_at', 'last_used_at'],
    snapshot.accountCredentials || [],
    accountCredentialToRow,
  );
  await replaceRows(
    client,
    'account_session_challenges',
    ['transaction_id', 'request_id', 'device_id', 'public_key', 'public_key_fingerprint', 'device_alias', 'platform', 'nonce', 'created_at', 'expires_at', 'consumed_at'],
    snapshot.accountSessionChallenges || [],
    accountSessionChallengeToRow,
  );
  await replaceRows(
    client,
    'account_credential_refreshes',
    ['credential_id', 'request_id', 'nonce_hash', 'issued_at', 'created_at'],
    snapshot.accountCredentialRefreshes || [],
    accountCredentialRefreshToRow,
  );
  await replaceRows(
    client,
    'account_join_grants',
    ['grant_hash', 'account_id', 'instance_id', 'intent_id', 'device_id', 'account_device_id', 'key_fingerprint', 'claim_instance', 'public_endpoint', 'request_id', 'created_at', 'expires_at', 'redeemed_at'],
    snapshot.accountJoinGrants || [],
    accountJoinGrantToRow,
  );
  // 放在 accounts 主表写入之后：账号级联删除先落库，再重建 lease/meta 行。
  await replaceRows(
    client,
    'provider_refresh_leases',
    ['lease_id', 'identity_key', 'account_id', 'provider_family', 'account_key', 'credential_instance_id', 'holder_instance_id', 'run_id', 'fencing_token', 'state', 'outcome', 'notes', 'created_at', 'updated_at', 'expires_at', 'last_heartbeat_at', 'closed_at'],
    snapshot.providerRefreshLeases || [],
    providerRefreshLeaseToRow,
  );
  await replaceRows(
    client,
    'provider_refresh_meta',
    ['identity_key', 'account_id', 'provider_family', 'account_key', 'credential_instance_id', 'credential_version', 'fencing_token', 'updated_at', 'updated_by_instance_id', 'last_uncertain_at'],
    Object.values(snapshot.providerRefreshMeta || {}),
    providerRefreshMetaToRow,
  );
  await replaceRows(client, 'temporary_pairing_exchanges',
    ['invitation_id', 'instance_id', 'account_id', 'status', 'claim_expires_at', 'access_expires_at', 'payload'],
    snapshot.temporaryPairingExchanges || [], (r) => ({ invitation_id: r.invitationId, instance_id: r.instanceId,
      account_id: r.accountId, status: r.status, claim_expires_at: r.claimExpiresAt,
      access_expires_at: r.accessExpiresAt, payload: r }));
  await replaceRows(client, 'temporary_pairing_clock', ['singleton', 'last_observed_at'],
    [{ singleton: true, last_observed_at: snapshot.temporaryPairingClock ?? 0 }], (r) => r);
  await replaceRows(client, 'temporary_control_exchanges',
    ['invitation_id', 'instance_id', 'account_id', 'status', 'claim_expires_at', 'access_expires_at', 'payload'],
    snapshot.temporaryControlExchanges || [], (r) => ({ invitation_id: r.invitationId, instance_id: r.instanceId,
      account_id: r.accountId, status: r.status, claim_expires_at: r.claimExpiresAt,
      access_expires_at: r.accessExpiresAt, payload: r }));
  await replaceRows(client, 'account_pairing_exchanges',
    ['invitation_id', 'instance_id', 'account_id', 'status', 'expires_at', 'payload'],
    snapshot.accountPairingExchanges || [], (r) => ({ invitation_id: r.invitationId,
      instance_id: r.instanceId, account_id: r.accountId, status: r.status, expires_at: r.expiresAt, payload: r }));
  await replaceRows(client, 'temporary_control_clock', ['singleton', 'last_observed_at'],
    [{ singleton: true, last_observed_at: snapshot.temporaryControlClock ?? 0 }], (r) => r);
}

/**
 * 创建 PostgreSQL store。
 * @param {{ pool: PgPool, schema?: string, ownsPool?: boolean, mutationLockTimeoutMs?: number }} options
 */
export function createPostgresStore({
  pool,
  schema = 'public',
  ownsPool = false,
  mutationLockTimeoutMs = DEFAULT_MUTATION_LOCK_TIMEOUT_MS,
  enableScopedRendezvousResult = false,
  enableScopedRendezvousCreation = false,
}) {
  if (!pool) throw new Error('Postgres store requires a pg Pool');
  let queue = Promise.resolve();
  const lockTimeoutMs = normalizeTimeoutMs(mutationLockTimeoutMs, DEFAULT_MUTATION_LOCK_TIMEOUT_MS);

  /** @param {PgClient} client */
  async function scope(client) {
    if (schema && schema !== 'public') {
      await client.query('select set_config($1, $2, true)', ['search_path', schema]);
    }
  }

  async function withClient(run) {
    const client = await pool.connect();
    try {
      await scope(client);
      return await run(client);
    } finally {
      client.release();
    }
  }

  async function readAuthority(client, instanceId) {
    if (typeof instanceId !== 'string' || !instanceId || instanceId.length > 160) throw new TypeError('A fixed instance identity is required');
    const result = await client.query(
      `select b.*, a.revision::text as authority_revision, a.authority_state as authority_state
       from (select $1::text as instance_id) as requested
       left join instance_bindings b on b.instance_id = requested.instance_id
       left join instance_authority_revisions a on a.instance_id = requested.instance_id`, [instanceId]);
    const row = result.rows[0];
    if ((row?.instance_id && !row.authority_revision) || (row?.authority_revision && row.authority_state?.version !== 1)) {
      throw new Error('Binding authority migration or revision is missing');
    }
    return { instanceId, revision: row?.authority_revision || '0', binding: row?.instance_id ? rowToBinding(row) : null };
  }

  function authorityFailure(code, statusCode = 409) {
    return Object.assign(new Error('Binding authority completion is unavailable or superseded'), { code, statusCode });
  }

  function finalizationContext(client) {
    let active = true, pending = Promise.resolve(), failure;
    const perform = operation => {
      if (!active) return Promise.reject(authorityFailure('owner_auth_authority_context_expired'));
      const run = pending.then(operation);
      pending = run.catch(error => { failure ||= error; });
      return run;
    };
    function identity(input, digest = true) {
      if (!['browser', 'native', 'account_join'].includes(input?.kind)
        || !['operationId', 'instanceId', 'accountId'].every(k => typeof input[k] === 'string' && input[k].length > 0 && input[k].length <= 160)
        || (digest && (!/^[a-f0-9]{64}$/.test(input.sourceDigest || '') || !/^[a-f0-9]{64}$/.test(input.keyFingerprint || '')))) {
        throw new TypeError('A fixed authenticated completion identity is required');
      }
    }
    async function current(input) {
      const authority = await readAuthority(client, input.instanceId);
      if (!authority.binding || authority.binding.revokedAt) throw authorityFailure('owner_auth_binding_revoked', 403);
      if (authority.binding.accountId !== input.accountId || authority.binding.instanceKeyFingerprint !== input.keyFingerprint) {
        throw authorityFailure('owner_auth_instance_mismatch', 403);
      }
      return authority;
    }
    async function retained(input, authority) {
      const result = await client.query(
        `select instance_id, account_id, key_fingerprint, authority_revision::text as revision,
         completion_sequence::text as completion_id
         from instance_authority_completions where operation_kind=$1 and operation_id=$2 and source_digest=$3`,
        [input.kind, input.operationId, input.sourceDigest]);
      const row = result.rows[0];
      if (!row || row.instance_id !== input.instanceId || row.account_id !== input.accountId
        || row.key_fingerprint !== input.keyFingerprint || row.revision !== authority.revision) {
        throw authorityFailure('owner_auth_native_replay');
      }
      return { revision: row.revision, completionId: row.completion_id };
    }
    const api = Object.freeze({
      readInstanceAuthority: instanceId => perform(() => readAuthority(client, instanceId)),
      recordCompletion: input => perform(async () => {
        identity(input); const authority = await current(input);
        await client.query(
          `insert into instance_authority_completions
           (operation_kind, operation_id, source_digest, instance_id, account_id, key_fingerprint, authority_revision)
           values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
          [input.kind, input.operationId, input.sourceDigest, input.instanceId, input.accountId, input.keyFingerprint, authority.revision]);
        return (await retained(input, authority)).revision;
      }),
      readCompletion: input => perform(async () => {
        identity(input); return (await retained(input, await current(input))).revision;
      }),
      readCompletionIdentity: input => perform(async () => {
        identity(input); return retained(input, await current(input));
      }),
      forgetCompletion: input => perform(async () => {
        identity(input);
        if (typeof input.expectedRevision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(input.expectedRevision)
          || BigInt(input.expectedRevision) > 9223372036854775807n) throw new TypeError('The original authorized revision is required');
        if (input.kind === 'native' && (typeof input.expectedCompletionId !== 'string'
          || !/^[1-9][0-9]{0,18}$/.test(input.expectedCompletionId)
          || BigInt(input.expectedCompletionId) > 9223372036854775807n)) throw new TypeError('The original native completion is required');
        const result = await client.query(
          `delete from instance_authority_completions where operation_kind=$1 and operation_id=$2 and source_digest=$3
           and instance_id=$4 and account_id=$5 and key_fingerprint=$6 and authority_revision=$7
           and ($8::bigint is null or completion_sequence=$8)`,
          [input.kind, input.operationId, input.sourceDigest, input.instanceId, input.accountId, input.keyFingerprint,
            input.expectedRevision, input.kind === 'native' ? input.expectedCompletionId : null]);
        if (result.rowCount !== 1) throw authorityFailure('owner_auth_native_replay');
        return result.rowCount;
      }),
      cacheOwnerPollAssertion: input => perform(async () => {
        if (!['transactionId', 'requestId', 'instanceId', 'accountId'].every(k => typeof input?.[k] === 'string' && input[k].length > 0 && input[k].length <= 160)
          || typeof input?.assertion !== 'string' || input.assertion.length > 16 * 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.assertion)) {
          throw new TypeError('A fixed signed poll result is required');
        }
        const result = await client.query(
          `update owner_auth_transactions set poll_assertion=$1
           where transaction_id=$2 and poll_request_id=$3 and instance_id=$4 and account_id=$5 and completed_at is not null`,
          [input.assertion, input.transactionId, input.requestId, input.instanceId, input.accountId]);
        if (result.rowCount !== 1) throw authorityFailure('owner_auth_native_replay');
      }),
    });
    return { api, finish: async () => { active = false; await pending; if (failure) throw failure; } };
  }

  function mutate(mutator, finalize = null) {
    const run = queue.then(() => withClient(async client => {
      await client.query('begin');
      try {
        await scope(client);
        await client.query('select set_config($1, $2, true)', ['lock_timeout', `${lockTimeoutMs}ms`]);
        await client.query('select pg_advisory_xact_lock(hashtext($1))', ['agentoc_accounts_store_v1']);
        const snapshot = await readSnapshot(client), before = JSON.stringify(snapshot);
        let result;
        if (finalize) {
          const validation = finalizationContext(client);
          const reader = Object.freeze({ readInstanceAuthority: validation.api.readInstanceAuthority,
            readCompletion: validation.api.readCompletion, readCompletionIdentity: validation.api.readCompletionIdentity });
          try { result = await mutator(snapshot, reader); await validation.finish(); }
          catch (error) { await validation.finish().catch(() => {}); throw error; }
        } else result = await mutator(snapshot);
        if (JSON.stringify(snapshot) !== before) await writeSnapshot(client, snapshot, JSON.parse(before));
        if (finalize) {
          await client.query('set constraints instance_authority_flush immediate');
          const context = finalizationContext(client);
          try { result = await finalize(result, context.api); await context.finish(); }
          catch (error) { await context.finish().catch(() => {}); throw error; }
        }
        await client.query('commit'); return result;
      } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    }));
    queue = run.catch(() => {});
    return run;
  }

  // Result publication touches only one intent. Share the snapshot writer's
  // queue and transaction lock so concurrent authorization and revocation
  // remain serialized, while avoiding a scan and rewrite of unrelated state.
  function mutateRendezvousResult(requestId, mutator) {
    if (typeof requestId !== 'string' || !requestId || typeof mutator !== 'function') {
      throw new TypeError('A rendezvous request and mutator are required');
    }
    const run = queue.then(() => withClient(async client => {
      await client.query('begin');
      try {
        await scope(client);
        await client.query('select set_config($1, $2, true)', ['lock_timeout', `${lockTimeoutMs}ms`]);
        await client.query('select pg_advisory_xact_lock(hashtext($1))', ['agentoc_accounts_store_v1']);
        const rows = await client.query('select * from account_join_intents where rendezvous_request_id = $1 for update', [requestId]);
        const draft = { accountJoinIntents: rows.rows.map(rowToAccountJoinIntent) };
        const original = JSON.parse(JSON.stringify(draft));
        const result = await mutator(draft);
        const intent = draft.accountJoinIntents[0], before = original.accountJoinIntents[0];
        if (intent && before) {
          const allowed = { ...before, rendezvousResult: intent.rendezvousResult,
            status: intent.status, completedAt: intent.completedAt };
          if (JSON.stringify(draft) !== JSON.stringify({ accountJoinIntents: [allowed] })) {
            throw new Error('Rendezvous result mutator changed unrelated authority');
          }
          if (JSON.stringify(intent) !== JSON.stringify(before)) {
            const written = await client.query(`update account_join_intents set rendezvous_result = $1::jsonb,
              status = $2, completed_at = $3 where intent_id = $4`,
            [JSON.stringify(intent.rendezvousResult), intent.status, intent.completedAt || null, intent.intentId]);
            if (written.rowCount !== 1) throw new Error('Rendezvous result target changed');
          }
        } else if (JSON.stringify(draft) !== JSON.stringify(original)) {
          throw new Error('Rendezvous result mutator changed unrelated authority');
        }
        await client.query('commit');
        return result;
      } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    }));
    queue = run.catch(() => {});
    return run;
  }

  // Opt-in until isolated equivalence and installed-release compatibility are
  // verified. The same queue/lock protects replay and account revocation.
  function mutateRendezvousCreation({ tokenHash, requestId }, mutator) {
    if (!/^[a-f0-9]{64}$/.test(tokenHash || '') || typeof requestId !== 'string' || !requestId
      || typeof mutator !== 'function') throw new TypeError('Fixed rendezvous authority is required');
    const run = queue.then(() => withClient(async client => {
      await client.query('begin');
      try {
        await scope(client);
        await client.query('select set_config($1, $2, true)', ['lock_timeout', `${lockTimeoutMs}ms`]);
        await client.query('select pg_advisory_xact_lock(hashtext($1))', ['agentoc_accounts_store_v1']);
        const credentials = await client.query('select * from account_credentials where token_hash = $1', [tokenHash]);
        const credential = credentials.rows[0];
        const draft = { accounts: [], accountCredentials: credentials.rows.map(rowToAccountCredential),
          accountDevices: [], accountDeviceKeys: [], instanceBindings: [], accountJoinIntents: [],
          accountSessionChallenges: [], accountCredentialRefreshes: [], accountJoinGrants: [] };
        if (credential) {
          const account = await client.query('select * from accounts where account_id = $1', [credential.account_id]);
          const devices = await client.query('select * from account_devices where device_id = $1', [credential.device_id]);
          const keys = await client.query('select * from account_device_keys where key_id = $1', [credential.key_id]);
          const bindings = await client.query('select * from instance_bindings where account_id = $1 order by bound_at, instance_id', [credential.account_id]);
          draft.accounts = account.rows.map(rowToAccount);
          draft.accountDevices = devices.rows.map(rowToAccountDevice);
          draft.accountDeviceKeys = keys.rows.map(rowToAccountDeviceKey);
          draft.instanceBindings = bindings.rows.map(rowToBinding);
        }
        const intents = await client.query('select * from account_join_intents where rendezvous_request_id = $1', [requestId]);
        draft.accountJoinIntents = intents.rows.map(rowToAccountJoinIntent);
        const original = JSON.parse(JSON.stringify(draft));
        let prune;
        const result = await mutator(draft, Object.freeze({ markPrune(value) {
          if (prune || !['now', 'refreshBefore', 'grantsBefore'].every(key => Number.isFinite(value?.[key]))) {
            throw new TypeError('Invalid rendezvous retention boundary');
          }
          prune = { ...value };
        } }));
        if (!prune) throw new Error('Rendezvous retention boundary is required');
        const expected = JSON.parse(JSON.stringify(original));
        if (expected.accountCredentials[0] && draft.accountCredentials[0]) {
          expected.accountCredentials[0].lastUsedAt = draft.accountCredentials[0].lastUsedAt;
        }
        if (expected.accountDevices[0] && draft.accountDevices[0]) {
          expected.accountDevices[0].lastSeenAt = draft.accountDevices[0].lastSeenAt;
        }
        if (original.accountJoinIntents.length) {
          const existing = expected.accountJoinIntents[0];
          const expiry = Date.parse(existing.expiresAt || '');
          if (existing.rendezvousResult != null && Number.isFinite(expiry) && expiry <= prune.now) existing.rendezvousResult = null;
        } else {
          if (draft.accountJoinIntents.length !== 1 || draft.accountJoinIntents[0].rendezvousRequestId !== requestId) {
            throw new Error('Invalid rendezvous creation result');
          }
          expected.accountJoinIntents = draft.accountJoinIntents;
        }
        if (JSON.stringify(draft) !== JSON.stringify(expected)) throw new Error('Rendezvous creation changed unrelated authority');
        const date = value => new Date(value).toISOString();
        await client.query('update account_join_intents set rendezvous_result = null where rendezvous_result is not null and expires_at <= $1', [date(prune.now)]);
        await client.query('delete from account_session_challenges where expires_at <= $1', [date(prune.now)]);
        await client.query('delete from account_credential_refreshes where created_at <= $1', [date(prune.refreshBefore)]);
        await client.query('delete from account_join_grants where expires_at <= $1', [date(prune.grantsBefore)]);
        if (original.accountCredentials[0] && original.accountCredentials[0].lastUsedAt !== draft.accountCredentials[0].lastUsedAt) {
          const updated = await client.query('update account_credentials set last_used_at = $1 where credential_id = $2',
            [draft.accountCredentials[0].lastUsedAt, original.accountCredentials[0].credentialId]);
          if (updated.rowCount !== 1) throw new Error('Rendezvous credential changed');
        }
        if (original.accountDevices[0] && original.accountDevices[0].lastSeenAt !== draft.accountDevices[0].lastSeenAt) {
          const updated = await client.query('update account_devices set last_seen_at = $1 where device_id = $2',
            [draft.accountDevices[0].lastSeenAt, original.accountDevices[0].deviceId]);
          if (updated.rowCount !== 1) throw new Error('Rendezvous device changed');
        }
        if (!original.accountJoinIntents.length) {
          await insertRowsInBatches(client, 'account_join_intents',
            ['intent_id', 'instance_id', 'instance_public_key', 'instance_key_fingerprint', 'device_id', 'device_public_key', 'device_public_key_fingerprint', 'device_alias', 'computer_alias', 'platform', 'public_endpoint', 'nonce_hash', 'issued_at', 'created_at', 'expires_at', 'status', 'account_id', 'account_device_id', 'completion_request_id', 'completed_at', 'rendezvous_request_id', 'rendezvous_nonce', 'rendezvous_grant', 'rendezvous_device_signature', 'rendezvous_result', 'account_claim_token_hash'],
            draft.accountJoinIntents, accountJoinIntentToRow);
        }
        await client.query('commit');
        return result;
      } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    }));
    queue = run.catch(() => {});
    return run;
  }

  return {
    // Internal service assembly only: reuse this exact pool and tenant schema.
    accountDeletionContext() { return Object.freeze({ pool, schema }); },
    // Account ASR has its own request/usage tables and never enters the global snapshot writer.
    accountAsrContext() { return Object.freeze({ pool, schema }); },
    /** Fixed account/request view; never enters the snapshot writer queue. */
    async readAccountRendezvousSnapshot({ tokenHash, requestId }) {
      if (!/^[a-f0-9]{64}$/.test(tokenHash || '')
        || typeof requestId !== 'string' || requestId.length > 128) {
        throw new TypeError('A fixed credential hash and bounded rendezvous request are required');
      }
      return withClient(async (client) => {
        await client.query('begin isolation level repeatable read read only');
        try {
          await scope(client);
          await client.query('select set_config($1, $2, true)',
            ['statement_timeout', `${5000}ms`]);
          await client.query('select set_config($1, $2, true)', ['lock_timeout', '1000ms']);
          const snapshot = { accounts: [], accountCredentials: [], accountDevices: [], accountDeviceKeys: [], accountJoinIntents: [] };
          const credentials = await client.query(
            'select * from account_credentials where token_hash = $1 limit 1', [tokenHash]);
          if (credentials.rows.length) {
            const credential = rowToAccountCredential(credentials.rows[0]);
            snapshot.accountCredentials.push(credential);
            const accounts = await client.query('select * from accounts where account_id = $1 limit 1', [credential.accountId]);
            snapshot.accounts = accounts.rows.map(rowToAccount);
            const devices = await client.query(
              'select * from account_devices where device_id = $1 and account_id = $2 limit 1',
              [credential.deviceId, credential.accountId]);
            snapshot.accountDevices = devices.rows.map(rowToAccountDevice);
            const keys = await client.query(
              'select * from account_device_keys where key_id = $1 and device_id = $2 and account_id = $3 limit 1',
              [credential.keyId, credential.deviceId, credential.accountId]);
            snapshot.accountDeviceKeys = keys.rows.map(rowToAccountDeviceKey);
            if (requestId) {
              const intents = await client.query(
                'select * from account_join_intents where rendezvous_request_id = $1 and account_id = $2 limit 1',
                [requestId, credential.accountId]);
              snapshot.accountJoinIntents = intents.rows.map(rowToAccountJoinIntent);
            }
          }
          await client.query('commit');
          return snapshot;
        } catch (error) {
          await client.query('rollback').catch(() => {});
          throw error;
        }
      });
    },

    /** Small, read-only credential snapshot for account-scoped cloud ASR. */
    async readAccountAsrSnapshot({ tokenHash }) {
      if (!/^[a-f0-9]{64}$/.test(tokenHash || '')) throw new TypeError('A fixed account credential hash is required');
      return withClient(async (client) => {
        await client.query('begin isolation level repeatable read read only');
        try {
          await scope(client);
          await client.query('select set_config($1, $2, true)', ['statement_timeout', '3000ms']);
          const credentials = await client.query('select * from account_credentials where token_hash=$1 limit 1', [tokenHash]);
          const snapshot = { accounts: [], accountCredentials: [], accountDevices: [], accountDeviceKeys: [], accountEntitlements: [] };
          const credential = credentials.rows[0] ? rowToAccountCredential(credentials.rows[0]) : null;
          if (credential) {
            snapshot.accountCredentials.push(credential);
            const [accounts, devices, keys, entitlements] = await Promise.all([
              client.query('select * from accounts where account_id=$1 limit 1', [credential.accountId]),
              client.query('select * from account_devices where device_id=$1 and account_id=$2 limit 1',
                [credential.deviceId, credential.accountId]),
              client.query('select * from account_device_keys where key_id=$1 and device_id=$2 and account_id=$3 limit 1',
                [credential.keyId, credential.deviceId, credential.accountId]),
              client.query('select * from account_entitlements where account_id=$1 limit 1', [credential.accountId]),
            ]);
            snapshot.accounts = accounts.rows.map(rowToAccount);
            snapshot.accountDevices = devices.rows.map(rowToAccountDevice);
            snapshot.accountDeviceKeys = keys.rows.map(rowToAccountDeviceKey);
            snapshot.accountEntitlements = entitlements.rows.map(rowToEntitlement);
          }
          await client.query('commit');
          return snapshot;
        } catch (error) {
          await client.query('rollback').catch(() => {});
          throw error;
        }
      });
    },

    /** A consistent account-scoped phone lease inventory; never holds the writer lock. */
    async readPhoneTurnInventorySnapshot({ tokenHash, now }) {
      if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash) || !Number.isFinite(now)) {
        throw new TypeError('A fixed token digest and clock are required');
      }
      return withClient(async client => {
        await client.query('begin isolation level repeatable read read only');
        try {
          await scope(client);
          await client.query('select set_config($1, $2, true)', ['statement_timeout', '3000ms']);
          await client.query('select set_config($1, $2, true)', ['lock_timeout', '1000ms']);
          const credentials = await client.query('select * from account_credentials where token_hash = $1 limit 1', [tokenHash]);
          const snapshot = { accountCredentials: credentials.rows.map(rowToAccountCredential), accounts: [],
            accountDevices: [], accountDeviceKeys: [], instanceBindings: [], turnConnectionLeases: [],
            accountJoinIntents: [], accountJoinGrants: [] };
          const credential = snapshot.accountCredentials[0];
          if (credential) {
            const accountId = credential.accountId;
            const accounts = await client.query('select * from accounts where account_id = $1 limit 1', [accountId]);
            const devices = await client.query('select * from account_devices where device_id = $1 limit 1', [credential.deviceId]);
            const keys = await client.query('select * from account_device_keys where key_id = $1 limit 1', [credential.keyId]);
            const bindings = await client.query('select * from instance_bindings where account_id = $1 order by bound_at, instance_id', [accountId]);
            const at = new Date(now).toISOString();
            const leases = await client.query(`select * from account_connection_leases where account_id = $1
              and btrim(status) in ('reserved','connected') and expires_at > $2 order by created_at, connection_id`, [accountId, at]);
            // Multiple terminal joins for the same phone prove the same link.
            // Retain legacy joins separately when their redeemed grant supplies
            // the phone identity; ambiguous links must remain ambiguous.
            const intents = await client.query(`select * from (
              select i.*, case when i.account_device_id ~ '^adev_[A-Za-z0-9_-]+$'
                then row_number() over (partition by i.instance_id, i.device_id, i.account_device_id
                  order by i.created_at, i.intent_id) else 1 end as inventory_link_rank
              from account_join_intents i where i.account_id = $1
              and i.status in ('completed','rendezvous_completed') and exists
              (select 1 from account_connection_leases l where l.account_id = i.account_id
               and l.instance_id = i.instance_id and l.device_id = i.device_id
               and btrim(l.status) in ('reserved','connected') and l.expires_at > $2)
              and (coalesce(btrim(i.account_device_id), '') <> '' or exists
                (select 1 from account_join_grants g where g.account_id = i.account_id
                 and g.intent_id = i.intent_id and g.instance_id = i.instance_id and g.device_id = i.device_id
                 and g.redeemed_at is not null and coalesce(btrim(g.account_device_id), '') <> ''))
              ) links where inventory_link_rank = 1 order by created_at, intent_id`, [accountId, at]);
            const legacyIntentIds = intents.rows.filter(row => !String(row.account_device_id || '').trim()).map(row => row.intent_id);
            const grants = legacyIntentIds.length ? await client.query(`select * from account_join_grants
              where account_id = $1 and intent_id = any($2::text[]) and redeemed_at is not null
              order by created_at, intent_id`, [accountId, legacyIntentIds]) : { rows: [] };
            snapshot.accounts = accounts.rows.map(rowToAccount);
            snapshot.accountDevices = devices.rows.map(rowToAccountDevice);
            snapshot.accountDeviceKeys = keys.rows.map(rowToAccountDeviceKey);
            snapshot.instanceBindings = bindings.rows.map(rowToBinding);
            snapshot.turnConnectionLeases = leases.rows.map(rowToTurnConnectionLease);
            snapshot.accountJoinIntents = intents.rows.map(rowToAccountJoinIntent);
            snapshot.accountJoinGrants = grants.rows.map(rowToAccountJoinGrant);
          }
          await client.query('commit');
          return snapshot;
        } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
      });
    },
    /** Fixed instance inbox read, released before any bounded wait. */
    async readAccountRendezvousInboxSnapshot({ instanceId, now }) {
      if (typeof instanceId !== 'string' || instanceId.length < 8 || instanceId.length > 160 || !Number.isFinite(now)) {
        throw new TypeError('A fixed bounded instance and clock are required');
      }
      return withClient(async client => {
        await client.query('begin isolation level repeatable read read only');
        try {
          await scope(client);
          await client.query('select set_config($1, $2, true)', ['statement_timeout', '3000ms']);
          await client.query('select set_config($1, $2, true)', ['lock_timeout', '1000ms']);
          const bindings = await client.query('select * from instance_bindings where instance_id = $1 limit 1', [instanceId]);
          const snapshot = { instanceBindings: bindings.rows.map(rowToBinding), accounts: [],
            accountJoinIntents: [], accountJoinGrants: [] };
          const binding = snapshot.instanceBindings[0];
          if (binding) {
            const accounts = await client.query('select * from accounts where account_id = $1 limit 1', [binding.accountId]);
            snapshot.accounts = accounts.rows.map(rowToAccount);
          }
          const at = new Date(now).toISOString();
          const intents = await client.query(`select i.* from account_join_intents i where i.instance_id = $1
            and i.status in ('rendezvous_pending','rendezvous_offered') and i.expires_at > $2
            and coalesce(i.rendezvous_device_signature, '') <> '' and coalesce(i.rendezvous_grant, '') <> ''
            and exists (select 1 from account_join_grants g where g.intent_id = i.intent_id
              and g.redeemed_at is null and g.expires_at > $2)
            order by i.created_at, i.intent_id limit 129`, [instanceId, at]);
          if (intents.rows.length > 128) throw Object.assign(new Error('Inbox capacity exceeded'), { statusCode: 503 });
          snapshot.accountJoinIntents = intents.rows.map(rowToAccountJoinIntent);
          if (intents.rows.length) {
            const grants = await client.query(`select * from account_join_grants where intent_id = any($1::text[])
              and redeemed_at is null and expires_at > $2 limit 129`, [intents.rows.map(row => row.intent_id), at]);
            if (grants.rows.length > 128) throw Object.assign(new Error('Inbox grant capacity exceeded'), { statusCode: 503 });
            snapshot.accountJoinGrants = grants.rows.map(rowToAccountJoinGrant);
          }
          await client.query('commit');
          return snapshot;
        } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
      });
    },

    /** A single MVCC read avoids the full snapshot/global mutation queue. */
    async readInstanceAuthority(instanceId) {
      return withClient(async (client) => {
        await client.query('begin read only');
        try {
          await scope(client);
          const result = await readAuthority(client, instanceId);
          await client.query('commit');
          return result;
        } catch (error) {
          await client.query('rollback').catch(() => {});
          throw error;
        }
      });
    },

    mutate,
    ...(enableScopedRendezvousResult ? { mutateRendezvousResult } : {}),
    ...(enableScopedRendezvousCreation ? { mutateRendezvousCreation } : {}),
    mutateWithAuthority(mutator, finalize) {
      if (typeof finalize !== 'function') throw new TypeError('An authority finalizer is required');
      return mutate(mutator, finalize);
    },

    async ping() {
      return withClient(async (client) => {
        await client.query('select 1');
      });
    },

    /**
     * 删除已过期事务；返回删除条数。
     * @param {number} now
     */
    async sweepExpired(now = Date.now()) {
      return withClient(async (client) => {
        const result = await client.query('delete from owner_auth_transactions where expires_at < $1', [
          new Date(now).toISOString(),
        ]);
        return Number(result.rowCount || 0);
      });
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

/**
 * 便捷工厂：从连接串创建 store。
 * @param {string} databaseUrl
 * @param {{ schema?: string, max?: number, mutationLockTimeoutMs?: number, enableScopedRendezvousResult?: boolean, enableScopedRendezvousCreation?: boolean }} [options]
 */
export function createPostgresStoreFromUrl(databaseUrl, options = {}) {
  const pool = new Pool({ connectionString: databaseUrl, max: options.max || 5 });
  const store = createPostgresStore({
    pool,
    schema: options.schema,
    ownsPool: true,
    mutationLockTimeoutMs: options.mutationLockTimeoutMs,
    enableScopedRendezvousResult: options.enableScopedRendezvousResult === true,
    enableScopedRendezvousCreation: options.enableScopedRendezvousCreation === true,
  });
  return { ...store, pool };
}
