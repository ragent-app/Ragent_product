// Versioned provider-credential mutations with compare-and-swap commits.
//
// Multi-device contract (docs/cross-device-credential-recovery-and-model-catalog-plan.md):
//   - Each account's credential is a monotonically numbered chain identified by
//     `accountKey` + `credentialInstanceId`. Re-login creates a new instance
//     chain; an old instance can never write into the new chain.
//   - A mutation commits only when expectedVersion === currentVersion. A stale
//     writer gets `conflict` + the authoritative record, never a silent
//     overwrite. A foreign instance gets `account-mismatch` and no merge.
//   - Deletion writes a tombstone; an offline device with an old version can
//     never revive the credential.
//   - The ledger stores metadata only (versions, fingerprints, device ids).
//     API-key payloads go to the SecretStore or encrypted peer envelope;
//     rotating Codex OAuth payloads stay machine-local and never enter a peer
//     envelope. Neither payload type touches this file, logs, or run manifests.

import { createHash } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import {
  compareSyncVersions,
  normalizeSyncVersion,
  stableSyncValue,
} from '../account-sync.mjs';
import { normalizeProviderSyncRecord } from './sync.mjs';
import { parseProviderDataJson, assertProviderSyncHistory } from './json-data.mjs';

function createSyncError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export const CREDENTIAL_SYNC_SCOPE = 'provider-credential';
const ledgerOperationQueues = new Map();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeAccountKey(value) {
  const key = trimString(value);
  if (!key || key.length > 256) {
    throw createSyncError('credential_account_key_invalid', 'Credential account key is invalid.');
  }
  return key;
}

export function normalizeCredentialInstanceId(value) {
  const id = trimString(value);
  if (!id || id.length > 128) {
    throw createSyncError('credential_instance_invalid', 'Credential instance id is invalid.');
  }
  return id;
}

export function credentialSecretFingerprint(payload) {
  // A short, loggable identity of the payload: never the secret itself and
  // never reversible to it. Covers api-key and oauth token shapes.
  const material = payload?.authType === 'api-key'
    ? String(payload.apiKey || '')
    : payload?.authType === 'oauth-token'
      ? String(payload.token || '')
      : JSON.stringify(stableSyncValue(payload?.tokens || payload?.tokenFile || ''));
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function compareCredentialVersions(left, right) {
  const a = Number(left);
  const b = Number(right);
  const leftVersion = Number.isSafeInteger(a) && a >= 0 ? a : 0;
  const rightVersion = Number.isSafeInteger(b) && b >= 0 ? b : 0;
  return leftVersion - rightVersion;
}

function normalizeIso(value) {
  const text = trimString(value);
  if (!text) return '';
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function baseRecord(record) {
  const key = normalizeAccountKey(record?.accountKey || record?.key);
  const credentialInstanceId = normalizeCredentialInstanceId(record?.credentialInstanceId);
  const version = Number(record?.credentialVersion);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw createSyncError('credential_sync_version_invalid', 'Credential version must be a non-negative integer.');
  }
  const deletedAt = normalizeIso(record?.deletedAt);
  const updatedAt = normalizeIso(record?.updatedAt);
  return {
    scope: CREDENTIAL_SYNC_SCOPE,
    key,
    credentialInstanceId,
    credentialVersion: version,
    ...(trimString(record?.agentType) ? { agentType: trimString(record.agentType) } : {}),
    ...(trimString(record?.authType) ? { authType: trimString(record.authType) } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(trimString(record?.secretRef) ? { secretRef: trimString(record.secretRef) } : {}),
    ...(trimString(record?.credentialFingerprint) ? { credentialFingerprint: trimString(record.credentialFingerprint) } : {}),
    ...(trimString(record?.previousFingerprint) ? { previousFingerprint: trimString(record.previousFingerprint) } : {}),
    ...(trimString(record?.updatedByDeviceId || record?.sourceDeviceId)
      ? { updatedByDeviceId: trimString(record.updatedByDeviceId || record.sourceDeviceId) }
      : {}),
    ...(deletedAt ? { deletedAt } : {}),
  };
}

// Metadata-only sync record for ledger/catalog propagation. The encrypted
// payload travels in the peer envelope's `secret` field, not here.
export function normalizeCredentialSyncRecord(record, fallbackWriterId = '') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw createSyncError('provider_sync_record_invalid', 'Credential sync record must be an object.');
  }
  const scope = trimString(record.scope);
  if (scope && scope !== CREDENTIAL_SYNC_SCOPE) {
    throw createSyncError('account_sync_scope_invalid', 'Unsupported credential sync scope.');
  }
  const version = normalizeSyncVersion(record.version, fallbackWriterId);
  if (!version.updatedAt || !version.writerId) {
    throw createSyncError('provider_sync_version_invalid', 'Credential sync record version is incomplete.');
  }
  const normalized = { ...baseRecord(record), version };
  if (!normalized.updatedAt && version.updatedAt) normalized.updatedAt = version.updatedAt;
  // A full peer-envelope record may carry its credential payload; keep it for
  // the envelope path (it is encrypted in transit), metadata-only callers
  // simply never populate `secret`.
  if (record.secret && typeof record.secret === 'object') {
    return { ...normalized, secret: stableSyncValue(record.secret) };
  }
  return normalized;
}

// Peer-envelope record: full provider sync shape plus credential chain fields.
export function normalizeCredentialEnvelopeRecord(record, fallbackWriterId = '') {
  const normalized = normalizeProviderSyncRecord(record, fallbackWriterId);
  return {
    ...normalized,
    ...baseRecord({
      accountKey: record.accountKey || record.key || normalized.key,
      credentialInstanceId: record.credentialInstanceId,
      credentialVersion: record.credentialVersion,
      secretRef: record.secretRef ?? normalized.auth?.storageRef,
      credentialFingerprint: record.credentialFingerprint,
      previousFingerprint: record.previousFingerprint,
      updatedByDeviceId: record.updatedByDeviceId || record.sourceDeviceId,
      deletedAt: record.deletedAt,
    }),
  };
}

export function mergeCredentialSyncRecords(current = [], incoming = []) {
  const merged = new Map();
  for (const record of current) {
    const normalized = normalizeCredentialSyncRecord(record);
    merged.set(`${normalized.scope}:${normalized.key}`, normalized);
  }
  const accepted = [];
  const ignored = [];
  const acceptedRecords = [];
  for (const record of incoming) {
    const normalized = normalizeCredentialSyncRecord(record);
    const identity = `${normalized.scope}:${normalized.key}`;
    const prior = merged.get(identity);
    const takeover = !prior
      || normalized.credentialInstanceId !== prior.credentialInstanceId
        ? normalized.credentialInstanceId !== prior?.credentialInstanceId
          ? compareSyncVersions(normalized.version, prior?.version) > 0
          : true
        : normalized.credentialVersion > prior.credentialVersion;
    if (takeover) {
      merged.set(identity, normalized);
      accepted.push(identity);
      acceptedRecords.push(normalized);
    } else {
      ignored.push(identity);
    }
  }
  return {
    records: [...merged.values()].sort((left, right) => `${left.scope}:${left.key}`.localeCompare(`${right.scope}:${right.key}`)),
    accepted,
    acceptedRecords,
    ignored,
  };
}

// Submission payload validation. The credential itself is only fingerprinted
// here; the caller routes it to the SecretStore or encrypted envelope.
export function normalizeCredentialMutation(mutation) {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
    throw createSyncError('credential_mutation_invalid', 'Credential mutation must be an object.');
  }
  const expectedVersion = Number(mutation.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw createSyncError('credential_mutation_invalid', 'Credential mutation expectedVersion must be a non-negative integer.');
  }
  const authType = trimString(mutation.secretPayload?.authType);
  if (!['api-key', 'oauth', 'oauth-token'].includes(authType)) {
    throw createSyncError('credential_mutation_invalid', 'Credential mutation needs an api-key, oauth, or oauth-token payload.');
  }
  if (mutation.deleted !== true && credentialSecretFingerprint(mutation.secretPayload) === credentialSecretFingerprint('')) {
    throw createSyncError('credential_mutation_invalid', 'Credential mutation payload is empty.');
  }
  return {
    accountKey: normalizeAccountKey(mutation.accountKey),
    credentialInstanceId: normalizeCredentialInstanceId(mutation.credentialInstanceId),
    expectedVersion,
    secretPayload: stableSyncValue(mutation.secretPayload),
    secretRef: trimString(mutation.secretRef) || '',
    sourceDeviceId: trimString(mutation.sourceDeviceId) || '',
    deleted: mutation.deleted === true,
  };
}

function cloneState(state) {
  return {
    ...(state?.recoveryRequired === true ? { recoveryRequired: true } : {}),
    credentials: new Map(
      [...(state?.credentials || new Map())].map(([key, record]) => [key, { ...record }]),
    ),
  };
}

function authoritativeFrom(record) {
  const { secretPayload, ...metadata } = record || {};
  return metadata;
}

// Atomic (within one event-loop turn per state object) CAS submission.
// `state` is `{ credentials: Map<accountKey, record> }`; the returned state is
// a fresh clone so callers can commit transactionally.
export function submitCredentialMutation(state, mutation) {
  const normalized = normalizeCredentialMutation(mutation);
  const next = cloneState(state);
  const current = next.credentials.get(normalized.accountKey);

  if (current?.deletedAt) {
    return {
      status: 'tombstoned',
      state,
      authoritative: authoritativeFrom(current),
      record: null,
    };
  }
  if (current && current.credentialInstanceId !== normalized.credentialInstanceId) {
    return {
      status: 'account-mismatch',
      state,
      authoritative: authoritativeFrom(current),
      record: null,
    };
  }
  if (current && compareCredentialVersions(normalized.expectedVersion, current.credentialVersion) !== 0) {
    return {
      status: 'conflict',
      state,
      authoritative: authoritativeFrom(current),
      record: null,
    };
  }

  const fingerprint = normalized.deleted
    ? ''
    : credentialSecretFingerprint(normalized.secretPayload);
  const updatedAt = new Date().toISOString();
  const credentialVersion = (current?.credentialVersion || 0) + 1;
  const record = {
    scope: CREDENTIAL_SYNC_SCOPE,
    key: normalized.accountKey,
    credentialInstanceId: normalized.credentialInstanceId,
    credentialVersion,
    ...(normalized.secretRef || current?.secretRef ? { secretRef: normalized.secretRef || current?.secretRef } : {}),
    ...(fingerprint ? { credentialFingerprint: fingerprint } : {}),
    ...(current?.credentialFingerprint && fingerprint ? { previousFingerprint: current.credentialFingerprint } : {}),
    ...(normalized.sourceDeviceId ? { updatedByDeviceId: normalized.sourceDeviceId } : {}),
    updatedAt,
    version: {
      updatedAt,
      counter: credentialVersion,
      writerId: normalized.sourceDeviceId || 'local',
    },
    ...(normalized.deleted ? { deletedAt: updatedAt } : {}),
  };
  next.credentials.set(normalized.accountKey, record);
  return {
    status: 'accepted',
    state: next,
    authoritative: authoritativeFrom(record),
    record,
  };
}

// Re-login / account-identity change: open a fresh chain at version 1 under a
// new credentialInstanceId. The old chain becomes unwritable immediately.
export function rotateCredentialInstance(state, {
  accountKey,
  previousCredentialInstanceId = '',
  newCredentialInstanceId,
  secretPayload,
  secretRef = '',
  sourceDeviceId = '',
} = {}) {
  const key = normalizeAccountKey(accountKey);
  const newId = normalizeCredentialInstanceId(newCredentialInstanceId);
  const current = state?.credentials?.get(key);
  if (current && !current.deletedAt && previousCredentialInstanceId && current.credentialInstanceId !== previousCredentialInstanceId) {
    return {
      status: 'account-mismatch',
      state,
      authoritative: authoritativeFrom(current),
      record: null,
    };
  }
  const next = cloneState(state);
  const fingerprint = credentialSecretFingerprint(secretPayload);
  const updatedAt = new Date().toISOString();
  const record = {
    scope: CREDENTIAL_SYNC_SCOPE,
    key,
    credentialInstanceId: newId,
    credentialVersion: 1,
    ...(trimString(secretRef) ? { secretRef: trimString(secretRef) } : {}),
    ...(fingerprint ? { credentialFingerprint: fingerprint } : {}),
    ...(current?.credentialFingerprint && fingerprint ? { previousFingerprint: current.credentialFingerprint } : {}),
    ...(trimString(sourceDeviceId) ? { updatedByDeviceId: trimString(sourceDeviceId) } : {}),
    updatedAt,
    version: {
      updatedAt,
      counter: 1,
      writerId: trimString(sourceDeviceId) || 'local',
    },
  };
  next.credentials.set(key, record);
  return {
    status: 'accepted',
    state: next,
    authoritative: authoritativeFrom(record),
    record,
  };
}

function normalizeLedgerState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const credentials = new Map();
  for (const record of Array.isArray(source.credentials) ? source.credentials : []) {
    try {
      // Backfill the sync version for ledgers written before the explicit
      // version field was added. The old rows already carried the same
      // ordering inputs as top-level metadata.
      const version = record?.version || {
        updatedAt: record?.updatedAt,
        counter: record?.credentialVersion,
        writerId: record?.updatedByDeviceId,
      };
      const normalized = normalizeCredentialSyncRecord(
        { ...record, version },
        version?.writerId,
      );
      credentials.set(normalized.key, normalized);
    } catch {
      // Unknown/corrupt rows are skipped rather than poisoning the whole ledger.
    }
  }
  return { version: 1, credentials, ...(source.recoveryRequired === true ? { recoveryRequired: true } : {}) };
}

// File-backed ledger mirroring sync-ledger.mjs semantics: atomic tmp+rename,
// 0600, metadata only. The process-wide queue matters because the HTTP routes
// create short-lived ledger objects per request; an object-local queue would
// still allow two requests to compare against the same stale file snapshot.
export function createCredentialMutationLedger({
  configDir,
  filePath = '',
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  renameImpl = rename,
  nowImpl = () => new Date().toISOString(),
} = {}) {
  const targetPath = filePath || join(configDir, 'native-provider-runtime', 'credential-ledger.json');

  async function loadState() {
    try {
      const text = await readFileImpl(targetPath, 'utf8');
      return normalizeLedgerState(parseProviderDataJson(text, 'credential-ledger.json'));
    } catch (error) {
      if (error?.code === 'ENOENT') return normalizeLedgerState(null);
      throw error;
    }
  }

  async function persist(state) {
    await mkdirImpl(dirname(targetPath), { recursive: true, mode: 0o700 });
    const temp = `${targetPath}.${process.pid}.tmp`;
    const body = {
      version: 1,
      ...(state.recoveryRequired === true ? { recoveryRequired: true } : {}),
      credentials: [...state.credentials.values()].map((record) => {
        // Belt and braces: never persist payload-ish fields even if a caller
        // smuggled one in through normalizeCredentialSyncRecord.
        const { secret, secretPayload, tokens, apiKey, ...metadata } = record;
        void secret; void secretPayload; void tokens; void apiKey;
        return metadata;
      }),
    };
    await writeFileImpl(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flush: true });
    await renameImpl(temp, targetPath);
  }

  async function commit(result, sideEffect = null) {
    if (result.status === 'accepted') {
      try {
        await sideEffect?.apply?.(result);
        await persist(result.state);
      } catch (error) {
        try { await sideEffect?.rollback?.(result); } catch {}
        throw error;
      }
    }
    return result;
  }

  function withLedgerLock(task) {
    const previous = ledgerOperationQueues.get(targetPath) || Promise.resolve();
    const current = previous.then(task, task);
    const settled = current.catch(() => {});
    ledgerOperationQueues.set(targetPath, settled);
    return current;
  }

  function syncVersionFor(record, writerId) {
    const version = record.version || {
      updatedAt: record.updatedAt,
      counter: record.credentialVersion,
      writerId: record.updatedByDeviceId,
    };
    const normalized = normalizeSyncVersion(version, writerId || record.updatedByDeviceId || 'local');
    return {
      updatedAt: normalized.updatedAt || record.updatedAt || nowImpl(),
      counter: normalized.counter || record.credentialVersion || 0,
      writerId: normalized.writerId || trimString(writerId || record.updatedByDeviceId) || 'local',
    };
  }

  return {
    path: targetPath,
    submit: (mutation, sideEffect = null) => withLedgerLock(async () => commit(
      submitCredentialMutation(await loadState(), mutation),
      sideEffect,
    )),
    rotate: (options, sideEffect = null) => withLedgerLock(async () => commit(
      rotateCredentialInstance(await loadState(), options),
      sideEffect,
    )),
    remove: ({ accountKey, credentialInstanceId, expectedVersion, sourceDeviceId = '' }, sideEffect = null) => withLedgerLock(async () => {
      const result = submitCredentialMutation(await loadState(), {
        accountKey,
        credentialInstanceId,
        expectedVersion,
        secretPayload: { authType: 'oauth', tokens: {} },
        deleted: true,
        sourceDeviceId,
      });
      return commit(result, sideEffect);
    }),
    getRecord: (accountKey) => withLedgerLock(async () => {
      const state = await loadState();
      const record = state.credentials.get(normalizeAccountKey(accountKey));
      if (!record) return null;
      const { secret, secretPayload, tokens, apiKey, ...metadata } = record || {};
      void secret; void secretPayload; void tokens; void apiKey;
      return metadata;
    }),
    listRecords: () => withLedgerLock(async () => {
      const state = await loadState();
      return [...state.credentials.values()].map((record) => {
        const { secret, secretPayload, tokens, apiKey, ...metadata } = record;
        void secret; void secretPayload; void tokens; void apiKey;
        return metadata;
      });
    }),
    // Record shaped for peer sync propagation (metadata only).
    toSyncRecord: (accountKey, writerId = '') => withLedgerLock(async () => {
      const state = await loadState();
      const record = state.credentials.get(normalizeAccountKey(accountKey));
      if (!record) return null;
      const metadata = authoritativeFrom(record);
      return { ...metadata, version: syncVersionFor(record, writerId) };
    }),
    merge: (incoming = [], sideEffect = null) => withLedgerLock(async () => {
      const state = await loadState();
      assertProviderSyncHistory(state);
      const merged = mergeCredentialSyncRecords([...state.credentials.values()], incoming);
      const next = normalizeLedgerState({ credentials: merged.records });
      await commit({ status: 'accepted', state: next, merged }, sideEffect);
      return merged;
    }),
  };
}
