// 跨设备 provider credential refresh lease。
//
// 契约（docs/cross-device-credential-recovery-and-model-catalog-plan.md）：
//   - lease key = accountId + providerFamily + accountKey + credentialInstanceId，
//     Accounts 只保存非敏感 lease/版本元数据，永远不接触 provider token。
//   - 同一 lease key 同一时刻最多一个 held 持有者；fencingToken 单调递增，
//     旧持有者恢复上线后无法用旧 fencingToken 续约或提交。
//   - 持有者掉线后 TTL 到期，再加一个短 grace period 才允许其他设备接管，
//     避免“刚过期就立刻并发 refresh”。
//   - refresh 结果未知时由设备显式上报 outcome=uncertain；Accounts 记录该标记
//     但不做乐观推断，后续处理（fail-closed / 要求重新认证）在实例侧执行。
import {
  buildProviderRefreshLeaseMessage,
  createInstancePublicKeyFingerprint,
  verifyInstanceProofSignature,
} from '../lib/instance-proof-protocol.mjs';

export const REFRESH_LEASE_AUDIENCE = 'ragent-provider-refresh-lease';
export const REFRESH_LEASE_OPERATIONS = new Set(['acquire', 'heartbeat', 'complete', 'status']);
export const REFRESH_LEASE_TTL_MS_DEFAULT = 60 * 1000;
export const REFRESH_LEASE_TTL_MS_MIN = 10 * 1000;
export const REFRESH_LEASE_TTL_MS_MAX = 120 * 1000;
// TTL 过期后仍需等待一小段 grace period 才允许其他设备接管；持有个旧设备的
// 最后一次心跳可能仍在路上。
export const REFRESH_LEASE_TAKEOVER_GRACE_MS = 15 * 1000;
export const REFRESH_LEASE_OUTCOMES = new Set(['success', 'failed', 'uncertain', 'released']);
export const PROVIDER_REFRESH_FAMILIES = new Set(['codex', 'claude', 'agy']);
const TERMINAL_LEASE_STATES = new Set(['committed', 'failed', 'uncertain', 'released']);
const PRUNE_CLOSED_MS = 6 * 60 * 60 * 1000;
const PRUNE_MAX_ROWS = 1024;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function bounded(value, max) {
  const text = trimString(value);
  return text.slice(0, max);
}

function normalizeIso(value, fallback = '') {
  const text = trimString(value);
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function isProtocolField(value, { min = 1, max = 256 } = {}) {
  const text = trimString(value);
  return text.length >= min && text.length <= max;
}

function createError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export function refreshLeaseIdentityKey({ accountId, providerFamily, accountKey, credentialInstanceId }) {
  return [
    trimString(accountId),
    trimString(providerFamily),
    trimString(accountKey),
    trimString(credentialInstanceId),
  ].join('|');
}

function getProviderRefreshMeta(draft) {
  if (!draft.providerRefreshMeta || typeof draft.providerRefreshMeta !== 'object') draft.providerRefreshMeta = {};
  return draft.providerRefreshMeta;
}

function getProviderRefreshLeases(draft) {
  if (!Array.isArray(draft.providerRefreshLeases)) draft.providerRefreshLeases = [];
  return draft.providerRefreshLeases;
}

function pruneProviderRefreshLeases(draft, now) {
  const cutoff = now - PRUNE_CLOSED_MS;
  const rows = getProviderRefreshLeases(draft)
    .filter((row) => Boolean(trimString(row?.leaseId)));
  const kept = rows.filter((row) => (
    row.state === 'held' || !Number.isFinite(Date.parse(row.closedAt || '')) || Date.parse(row.closedAt) >= cutoff
  ));
  const closedDesc = kept
    .filter((row) => row.state !== 'held')
    .sort((left, right) => String(right.closedAt || '').localeCompare(String(left.closedAt || '')));
  for (const stale of closedDesc.slice(PRUNE_MAX_ROWS)) {
    const index = kept.indexOf(stale);
    if (index >= 0) kept.splice(index, 1);
  }
  draft.providerRefreshLeases = kept.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  return draft.providerRefreshLeases;
}

function publicLease(row) {
  if (!row) return null;
  return {
    leaseId: row.leaseId,
    fencingToken: row.fencingToken,
    accountId: row.accountId,
    providerFamily: row.providerFamily,
    accountKey: row.accountKey,
    credentialInstanceId: row.credentialInstanceId,
    holderInstanceId: row.holderInstanceId,
    ...(row.runId ? { runId: row.runId } : {}),
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    ...(TERMINAL_LEASE_STATES.has(row.state) ? { closedAt: row.closedAt || '' } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
  };
}

function publicCredential(meta) {
  if (!meta) return null;
  return {
    credentialVersion: meta.credentialVersion || 0,
    credentialInstanceId: meta.credentialInstanceId || '',
    updatedAt: meta.updatedAt || '',
    updatedByInstanceId: meta.updatedByInstanceId || '',
    ...(trimString(meta.lastUncertainAt) ? { lastUncertainAt: meta.lastUncertainAt } : {}),
  };
}

function normalizeInputFields(input) {
  return {
    requestId: bounded(input?.requestId, 128),
    accountId: bounded(input?.accountId, 128),
    providerFamily: trimString(input?.providerFamily).toLowerCase(),
    accountKey: bounded(input?.accountKey, 256),
    credentialInstanceId: bounded(input?.credentialInstanceId, 128),
    runId: bounded(input?.runId, 128),
    leaseId: bounded(input?.leaseId, 128),
    fencingToken: Number(input?.fencingToken),
    ttlMs: Number(input?.ttlMs),
    issuedAt: trimString(input?.issuedAt),
    audience: trimString(input?.audience),
  };
}

function validateBinding(draft, instanceId, accountId) {
  // 与 owner-auth broker 的 binding 检查保持一致：绑定缺失或被撤销一律拒绝。
  const binding = (Array.isArray(draft.instanceBindings) ? draft.instanceBindings : [])
    .find((item) => item.instanceId === instanceId);
  if (!binding || binding.accountId !== accountId) {
    throw createError('refresh_lease_instance_mismatch', 'Instance is not bound to this account.', 403);
  }
  if (binding.revokedAt) {
    throw createError('refresh_lease_binding_revoked', 'This instance binding has been revoked.', 403);
  }
  return binding;
}

// 设备签名 proof：transcript 绑定完整 lease 身份与操作名，跨身份/跨端点重放无效。
function verifyProof(input, fields, clock) {
  const instance = input?.instance && typeof input.instance === 'object' ? input.instance : {};
  const instanceId = trimString(instance.instanceId);
  const publicKey = trimString(instance.publicKey);
  const keyFingerprint = trimString(instance.keyFingerprint);
  const issuedMs = Date.parse(fields.issuedAt);
  if (!instanceId || !publicKey || !keyFingerprint || !fields.requestId
    || !isProtocolField(fields.requestId) || !issuedMs || fields.audience !== REFRESH_LEASE_AUDIENCE) {
    throw createError('refresh_lease_auth_invalid', 'Invalid refresh lease proof.', 400);
  }
  if (Math.abs(clock() - issuedMs) > 2 * 60 * 1000) {
    throw createError('refresh_lease_auth_expired', 'Refresh lease proof is expired.', 401);
  }
  if (createInstancePublicKeyFingerprint(publicKey) !== keyFingerprint) {
    throw createError('refresh_lease_auth_invalid', 'Refresh lease instance key fingerprint does not match.', 401);
  }
  const message = buildProviderRefreshLeaseMessage({
    instanceId,
    requestId: fields.requestId,
    accountId: fields.accountId,
    operation: trimString(input?.operation),   // 用原始 input.operation 验签；implied 补填只用于业务路由
    providerFamily: fields.providerFamily,
    accountKey: fields.accountKey,
    credentialInstanceId: fields.credentialInstanceId,
    runId: fields.runId,
    leaseId: fields.leaseId,
    fencingToken: fields.fencingToken,
    issuedAt: fields.issuedAt,
    audience: fields.audience,
  });
  if (!verifyInstanceProofSignature({ publicKey, message, signature: input?.signature })) {
    throw createError('refresh_lease_auth_invalid', 'Invalid refresh lease signature.', 401);
  }
  return { instanceId };
}

function normalizeCommon(input, { requireIdentity = true, impliedOperation = '' } = {}) {
  const fields = normalizeInputFields(input);
  const operation = trimString(input?.operation) || trimString(impliedOperation);
  // implied 仅用于在调用方未提供 operation 时补填；若调用方提供了，以提供的为准。
  // HTTP 路由层在注入前应保证 input.operation 与路由语义一致。
  if (!REFRESH_LEASE_OPERATIONS.has(operation)) {
    throw createError('refresh_lease_operation_invalid', 'Refresh lease operation is invalid.', 400);
  }
  fields.operation = operation;
  if (!PROVIDER_REFRESH_FAMILIES.has(fields.providerFamily)) {
    throw createError('refresh_lease_provider_invalid', 'Refresh lease provider family is invalid.', 400);
  }
  if (!isProtocolField(fields.accountId) || !isProtocolField(fields.accountKey)
    || (requireIdentity && !isProtocolField(fields.credentialInstanceId))) {
    throw createError('refresh_lease_identity_invalid', 'Refresh lease identity is incomplete.', 400);
  }
  return fields;
}

function activeLeaseFor(rows, identityKey) {
  return rows.find((row) => row.identityKey === identityKey && row.state === 'held') || null;
}

function latestClosedFor(rows, identityKey) {
  return rows
    .filter((row) => row.identityKey === identityKey && TERMINAL_LEASE_STATES.has(row.state))
    .sort((left, right) => String(right.closedAt || right.updatedAt || '').localeCompare(String(left.closedAt || left.updatedAt || '')))[0]
    || null;
}

function ensureMetaRow(metaMap, fields) {
  const identityKey = refreshLeaseIdentityKey(fields);
  let row = metaMap[identityKey];
  if (!row || typeof row !== 'object') {
    row = {
      identityKey,
      accountId: fields.accountId,
      providerFamily: fields.providerFamily,
      accountKey: fields.accountKey,
      credentialInstanceId: fields.credentialInstanceId,
      credentialVersion: 0,
      fencingToken: 0,
      updatedAt: '',
      updatedByInstanceId: '',
    };
    metaMap[identityKey] = row;
  }
  return row;
}

export function createRefreshLeaseBroker({
  store,
  clock = Date.now,
  audit = () => {},
}) {
  if (!store || typeof store.mutate !== 'function') {
    throw new Error('Refresh lease broker requires a store with mutate()');
  }

  async function acquireRefreshLease(input) {
    const fields = normalizeCommon(input, { impliedOperation: 'acquire' });
    const { instanceId } = verifyProof(input, fields, clock);
    const result = await store.mutate(async (draft) => {
      validateBinding(draft, instanceId, fields.accountId);
      const now = clock();
      const identityKey = refreshLeaseIdentityKey(fields);
      const metaMap = getProviderRefreshMeta(draft);
      const rows = pruneProviderRefreshLeases(draft, now);
      const meta = ensureMetaRow(metaMap, fields);
      const prior = latestClosedFor(rows, identityKey);

      const current = activeLeaseFor(rows, identityKey);
      if (current) {
        const expiry = Date.parse(current.expiresAt || '');
        const mine = current.holderInstanceId === instanceId;
        if (Number.isFinite(expiry) && expiry > now) {
          if (mine) {
            // 幂等重入：同一设备重复 acquire 返回现有租约并接受新的 runId。
            current.updatedAt = nowIso(clock);
            if (fields.runId) current.runId = fields.runId;
            audit({ event: 'refresh_lease.reacquired', identityKey, instanceId });
            return {
              acquired: true,
              reacquired: true,
              lease: publicLease(current),
              credential: publicCredential(meta),
              priorOutcome: prior?.outcome || (prior?.state === 'uncertain' ? 'uncertain' : ''),
            };
          }
          throw createError('refresh_lease_held', 'A refresh lease is already held by another device.', 409);
        }
        if (now < expiry + REFRESH_LEASE_TAKEOVER_GRACE_MS) {
          throw createError('refresh_lease_grace', 'Previous refresh lease has not reached its takeover grace deadline.', 409);
        }
        current.state = 'stolen';
        current.closedAt = nowIso(clock);
        current.outcome = 'expired';
        current.updatedAt = current.closedAt;
      }

      const ttlMs = Math.min(
        REFRESH_LEASE_TTL_MS_MAX,
        Math.max(REFRESH_LEASE_TTL_MS_MIN, Number.isFinite(fields.ttlMs) ? fields.ttlMs : REFRESH_LEASE_TTL_MS_DEFAULT),
      );
      const acquiredAt = nowIso(clock);
      meta.fencingToken = Number(meta.fencingToken || 0) + 1;
      const lease = {
        identityKey,
        leaseId: makeId('rlease'),
        fencingToken: meta.fencingToken,
        accountId: fields.accountId,
        providerFamily: fields.providerFamily,
        accountKey: fields.accountKey,
        credentialInstanceId: fields.credentialInstanceId,
        holderInstanceId: instanceId,
        runId: fields.runId,
        state: 'held',
        createdAt: acquiredAt,
        updatedAt: acquiredAt,
        expiresAt: new Date(now + ttlMs).toISOString(),
        lastHeartbeatAt: acquiredAt,
      };
      rows.push(lease);
      audit({
        event: 'refresh_lease.acquired',
        identityKey,
        instanceId,
        fencingToken: lease.fencingToken,
        ...(prior?.outcome ? { priorOutcome: prior.outcome } : {}),
      });
      return {
        acquired: true,
        ...(current?.state === 'stolen' ? { tookOver: true } : {}),
        lease: publicLease(lease),
        credential: publicCredential(meta),
        priorOutcome: prior?.outcome || (prior?.state === 'uncertain' ? 'uncertain' : ''),
      };
    });
    return result;
  }

  function assertHolderOpenLease(rows, fields, instanceId, now) {
    const lease = rows.find((row) => row.identityKey === refreshLeaseIdentityKey(fields)
      && row.state === 'held'
      && row.leaseId === fields.leaseId);
    if (!lease) throw createError('refresh_lease_not_found', 'Refresh lease is not held for this identity.', 404);
    if (lease.holderInstanceId !== instanceId) {
      throw createError('refresh_lease_holder_mismatch', 'Refresh lease belongs to another device.', 403);
    }
    const claimed = Number(fields.fencingToken);
    if (!Number.isSafeInteger(claimed) || claimed !== Number(lease.fencingToken)) {
      throw createError('refresh_lease_fencing_rejected', 'Refresh lease fencing token was rejected.', 409);
    }
    const expiry = Date.parse(lease.expiresAt || '');
    if (Number.isFinite(expiry) && expiry <= now) {
      throw createError('refresh_lease_expired', 'Refresh lease has expired.', 410);
    }
    return lease;
  }

  async function heartbeatRefreshLease(input) {
    const fields = normalizeCommon(input, { requireIdentity: false, impliedOperation: 'heartbeat' });
    if (!isProtocolField(fields.accountKey) || !fields.leaseId) {
      throw createError('refresh_lease_request_invalid', 'Refresh lease heartbeat request is incomplete.', 400);
    }
    if (!Number.isSafeInteger(fields.fencingToken)) {
      throw createError('refresh_lease_fencing_rejected', 'Refresh lease fencing token was rejected.', 409);
    }
    const { instanceId } = verifyProof(input, fields, clock);
    const result = await store.mutate(async (draft) => {
      validateBinding(draft, instanceId, fields.accountId);
      const now = clock();
      const rows = pruneProviderRefreshLeases(draft, now);
      const lease = assertHolderOpenLease(rows, fields, instanceId, now);
      const metaMap = getProviderRefreshMeta(draft);
      const meta = ensureMetaRow(metaMap, { ...fields, credentialInstanceId: lease.credentialInstanceId });
      const ttlMs = Math.min(
        REFRESH_LEASE_TTL_MS_MAX,
        Math.max(REFRESH_LEASE_TTL_MS_MIN, Number.isFinite(fields.ttlMs) ? fields.ttlMs : REFRESH_LEASE_TTL_MS_DEFAULT),
      );
      const stamp = nowIso(clock);
      lease.expiresAt = new Date(now + ttlMs).toISOString();
      lease.lastHeartbeatAt = stamp;
      lease.updatedAt = stamp;
      audit({ event: 'refresh_lease.heartbeat', identityKey: lease.identityKey, instanceId });
      return {
        renewed: true,
        lease: publicLease(lease),
        credential: publicCredential(meta),
      };
    });
    return result;
  }

  async function completeRefreshLease(input) {
    const fields = normalizeCommon(input, { requireIdentity: false, impliedOperation: 'complete' });
    const outcome = trimString(input?.outcome);
    if (!REFRESH_LEASE_OUTCOMES.has(outcome)) {
      throw createError('refresh_lease_outcome_invalid', 'Refresh lease outcome is invalid.', 400);
    }
    if (!isProtocolField(fields.accountKey) || !fields.leaseId) {
      throw createError('refresh_lease_request_invalid', 'Refresh lease completion request is incomplete.', 400);
    }
    if (!Number.isSafeInteger(fields.fencingToken)) {
      throw createError('refresh_lease_fencing_rejected', 'Refresh lease fencing token was rejected.', 409);
    }
    const { instanceId } = verifyProof(input, fields, clock);
    const expectedVersionRaw = Number(input?.expectedCredentialVersion);
    const result = await store.mutate(async (draft) => {
      validateBinding(draft, instanceId, fields.accountId);
      const now = clock();
      const rows = pruneProviderRefreshLeases(draft, now);
      const lease = assertHolderOpenLease(rows, fields, instanceId, now);
      const identityKey = lease.identityKey;
      const metaMap = getProviderRefreshMeta(draft);
      const meta = ensureMetaRow(metaMap, {
        ...fields,
        credentialInstanceId: lease.credentialInstanceId,
      });

      if (outcome === 'success') {
        if (Number.isSafeInteger(expectedVersionRaw)
          && Number(meta.credentialVersion || 0) !== expectedVersionRaw) {
          throw createError('refresh_lease_credential_conflict', 'Credential metadata version does not match.', 409);
        }
        meta.credentialVersion = Number(meta.credentialVersion || 0) + 1;
        meta.updatedAt = nowIso(clock);
        meta.updatedByInstanceId = instanceId;
        meta.lastUncertainAt = '';
      } else if (outcome === 'uncertain') {
        meta.lastUncertainAt = nowIso(clock);
      }

      const closed = nowIso(clock);
      lease.state = outcome === 'success' ? 'committed'
        : outcome === 'uncertain' ? 'uncertain'
          : outcome === 'failed' ? 'failed'
            : 'released';
      lease.closedAt = closed;
      lease.updatedAt = closed;
      lease.outcome = outcome;
      if (input?.notes && typeof input.notes === 'string') lease.notes = bounded(input.notes, 256);
      if (input?.credentialFingerprint && typeof input.credentialFingerprint === 'string') {
        lease.credentialFingerprint = bounded(input.credentialFingerprint, 128);
      }
      audit({
        event: 'refresh_lease.completed',
        identityKey,
        instanceId,
        outcome,
        credentialVersion: meta.credentialVersion,
      });
      return {
        completed: true,
        outcome,
        lease: publicLease(lease),
        credential: publicCredential(meta),
      };
    });
    return result;
  }

  async function statusOfRefreshLease(input) {
    // requireIdentity=false：status 只需要 account/provi­der 定位信息，
    // credentialInstanceId 可以省略以查询该账号下所有 provider 身份的状态。
    const fields = normalizeCommon(input, { requireIdentity: false, impliedOperation: 'status' });
    if (!isProtocolField(fields.accountKey)) {
      throw createError('refresh_lease_identity_invalid', 'Refresh lease identity is incomplete.', 400);
    }
    const { instanceId } = verifyProof(input, fields, clock);
    const identityScope = isProtocolField(fields.credentialInstanceId)
      ? refreshLeaseIdentityKey(fields)
      : null;
    const result = await store.mutate(async (draft) => {
      validateBinding(draft, instanceId, fields.accountId);
      const now = clock();
      const rows = pruneProviderRefreshLeases(draft, now);
      const metaMap = getProviderRefreshMeta(draft);
      const identityKeys = Object.keys(metaMap).filter((key) => {
        if (identityScope) return key === identityScope;
        return key.startsWith(`${fields.accountId}|${fields.providerFamily}|${fields.accountKey}`);
      }).sort();
      const identities = identityKeys.map((key) => {
        const meta = metaMap[key] || null;
        const current = activeLeaseFor(rows, key);
        return {
          identityKey: key,
          credential: publicCredential(meta),
          ...(current && current.holderInstanceId !== instanceId
            && Date.parse(current.expiresAt || '') > now
            ? {
              heldByOther: {
                holderInstanceId: current.holderInstanceId,
                expiresAt: current.expiresAt,
                ...(current.runId ? { runId: current.runId } : {}),
              },
            }
            : {}),
        };
      });
      return { accountId: fields.accountId, identities };
    });
    audit({ event: 'refresh_lease.status', instanceId, identities: result.identities.length });
    return result;
  }

  return {
    acquireRefreshLease,
    heartbeatRefreshLease,
    completeRefreshLease,
    statusOfRefreshLease,
  };
}
