// Ownership handoff state for the user's external Codex OAuth account.
//
// The state file intentionally stores no credential material.  It records
// only account ids, short fingerprints, and ownership transitions so a
// logout/account switch cannot silently hand a still-running external Codex
// process's refresh token back to Ragent.

import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

export const EXTERNAL_CODEX_OWNERSHIP_VERSION = 1;
export const EXTERNAL_CODEX_OWNERSHIP_FILE_NAME = 'external-codex-ownership.json';

const OWNERSHIP_STATUSES = new Set(['external-owned', 'handoff-pending', 'ragent-owned']);
const ACCOUNT_ID_RE = /^[A-Za-z0-9._:@/-]{1,256}$/;
const MAX_RECORDS = 128;
const LOCK_WAIT_MS = 25;
const LOCK_ATTEMPTS = 240;
const STALE_LOCK_MS = 120_000;

export function normalizeExternalOAuthHandoffPolicy(value, fallback = 'explicit') {
  const normalized = trimString(value).toLowerCase();
  if (normalized === 'automatic' || normalized === 'auto') return 'automatic';
  if (normalized === 'explicit' || normalized === 'manual') return 'explicit';
  return fallback;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAccountId(value) {
  const normalized = trimString(value);
  return ACCOUNT_ID_RE.test(normalized) ? normalized : '';
}

function normalizeStatus(value) {
  const normalized = trimString(value);
  return OWNERSHIP_STATUSES.has(normalized) ? normalized : '';
}

function normalizeRecord(record) {
  const accountId = normalizeAccountId(record?.accountId);
  const status = normalizeStatus(record?.status);
  if (!accountId || !status) return null;
  return {
    accountId,
    status,
    lastSeenFingerprint: trimString(record?.lastSeenFingerprint),
    lastSeenAt: trimString(record?.lastSeenAt),
    pendingSince: trimString(record?.pendingSince),
    takeoverAt: trimString(record?.takeoverAt),
  };
}

export function emptyExternalCodexOwnershipState() {
  return {
    version: EXTERNAL_CODEX_OWNERSHIP_VERSION,
    currentExternalAccountId: '',
    currentExternalFingerprint: '',
    currentExternalObservedAt: '',
    records: [],
    updatedAt: '',
  };
}

export function normalizeExternalCodexOwnershipState(value) {
  const records = Array.isArray(value?.records)
    ? value.records.map(normalizeRecord).filter(Boolean).slice(-MAX_RECORDS)
    : [];
  return {
    version: EXTERNAL_CODEX_OWNERSHIP_VERSION,
    currentExternalAccountId: normalizeAccountId(value?.currentExternalAccountId),
    currentExternalFingerprint: trimString(value?.currentExternalFingerprint),
    currentExternalObservedAt: trimString(value?.currentExternalObservedAt),
    records,
    updatedAt: trimString(value?.updatedAt),
  };
}

export function externalCodexOwnershipFile(configDir) {
  return join(configDir, 'native-provider-runtime', EXTERNAL_CODEX_OWNERSHIP_FILE_NAME);
}

// The state-machine implementation is shared by other native OAuth clients
// too.  The legacy Codex exports remain the public compatibility surface, but
// callers may select a separate filename/reason prefix so Codex and Claude
// can never accidentally share ownership state.
function ownershipFile(configDir, ownershipFileName = EXTERNAL_CODEX_OWNERSHIP_FILE_NAME) {
  return join(configDir, 'native-provider-runtime', ownershipFileName);
}

function upsertRecord(state, accountId, updater) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedAccountId) return;
  const index = state.records.findIndex((record) => record.accountId === normalizedAccountId);
  const current = index >= 0 ? state.records[index] : { accountId: normalizedAccountId };
  const next = normalizeRecord(updater(current)) || current;
  if (index >= 0) state.records[index] = next;
  else state.records.push(next);
  state.records = state.records.slice(-MAX_RECORDS);
}

function findRecord(state, accountId) {
  const normalized = normalizeAccountId(accountId);
  return state.records.find((record) => record.accountId === normalized) || null;
}

async function readState(filePath, readFileImpl = readFile, reasonPrefix = 'external-codex') {
  try {
    const parsed = JSON.parse(await readFileImpl(filePath, 'utf8'));
    if (!parsed || parsed.version !== EXTERNAL_CODEX_OWNERSHIP_VERSION || !Array.isArray(parsed.records)) {
      return { ok: false, reason: `${reasonPrefix}-ownership-state-unreadable` };
    }
    return { ok: true, state: normalizeExternalCodexOwnershipState(parsed) };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, state: emptyExternalCodexOwnershipState() };
    }
    return { ok: false, reason: `${reasonPrefix}-ownership-state-unreadable` };
  }
}

async function writeState(filePath, state, {
  writeFileImpl = writeFile,
  renameImpl = rename,
  mkdirImpl = mkdir,
  chmodImpl = chmod,
} = {}) {
  await mkdirImpl(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(normalizeExternalCodexOwnershipState(state), null, 2)}\n`;
  await writeFileImpl(tempPath, body, { mode: 0o600 });
  await chmodImpl(tempPath, 0o600).catch(() => {});
  await renameImpl(tempPath, filePath);
  await chmodImpl(filePath, 0o600).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withStateLock(filePath, callback, {
  openImpl = open,
  statImpl = stat,
  rmImpl = rm,
  mkdirImpl = mkdir,
  lockTimeoutReason = 'external-codex-ownership-lock-timeout',
} = {}) {
  const lockPath = `${filePath}.lock`;
  await mkdirImpl(dirname(filePath), { recursive: true, mode: 0o700 });
  let handle = null;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      handle = await openImpl(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lockStat = await statImpl(lockPath);
        if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          await rmImpl(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
      }
      await sleep(LOCK_WAIT_MS);
    }
  }
  if (!handle) return { ok: false, reason: lockTimeoutReason };
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await rmImpl(lockPath, { force: true }).catch(() => {});
  }
}

export async function observeExternalCodexOwnership({
  configDir,
  accountId = '',
  fingerprint = '',
  // Codex is automatic by default. Explicit handoff remains available to
  // callers that intentionally opt into the legacy safety workflow.
  handoffPolicy = 'automatic',
  observedAt = new Date().toISOString(),
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  mkdirImpl = mkdir,
  chmodImpl = chmod,
  openImpl = open,
  statImpl = stat,
  rmImpl = rm,
  ownershipFileName = EXTERNAL_CODEX_OWNERSHIP_FILE_NAME,
  reasonPrefix = 'external-codex',
} = {}) {
  const filePath = ownershipFile(configDir, ownershipFileName);
  return withStateLock(filePath, async () => {
    const loaded = await readState(filePath, readFileImpl, reasonPrefix);
    if (!loaded.ok) return loaded;
    const state = loaded.state;
    const nextExternalAccountId = normalizeAccountId(accountId);
    const previousExternalAccountId = state.currentExternalAccountId;
    const automaticHandoff = normalizeExternalOAuthHandoffPolicy(handoffPolicy) === 'automatic';

    if (previousExternalAccountId && previousExternalAccountId !== nextExternalAccountId) {
      upsertRecord(state, previousExternalAccountId, (record) => ({
        ...record,
        status: automaticHandoff ? 'ragent-owned' : 'handoff-pending',
        pendingSince: automaticHandoff ? '' : (record.pendingSince || observedAt),
        takeoverAt: automaticHandoff ? observedAt : record.takeoverAt,
      }));
    }

    // A deployment may already contain records created by the legacy explicit
    // policy. The first automatic observation must migrate those old pending
    // records too; otherwise a logout observed before this upgrade would keep
    // rejecting every later Run forever.
    if (automaticHandoff) {
      state.records = state.records.map((record) => (
        record.status === 'handoff-pending' && record.accountId !== nextExternalAccountId
          ? {
            ...record,
            status: 'ragent-owned',
            pendingSince: '',
            takeoverAt: observedAt,
          }
          : record
      ));
    }

    if (nextExternalAccountId) {
      upsertRecord(state, nextExternalAccountId, (record) => ({
        ...record,
        status: 'external-owned',
        lastSeenFingerprint: trimString(fingerprint),
        lastSeenAt: observedAt,
        pendingSince: '',
        takeoverAt: '',
      }));
    }

    state.currentExternalAccountId = nextExternalAccountId;
    state.currentExternalFingerprint = nextExternalAccountId ? trimString(fingerprint) : '';
    state.currentExternalObservedAt = observedAt;
    state.updatedAt = observedAt;
    await writeState(filePath, state, { writeFileImpl, renameImpl, mkdirImpl, chmodImpl });
    return { ok: true, state };
  }, {
    openImpl,
    statImpl,
    rmImpl,
    mkdirImpl,
    lockTimeoutReason: `${reasonPrefix}-ownership-lock-timeout`,
  });
}

export async function loadExternalCodexOwnershipState({
  configDir,
  readFileImpl = readFile,
  ownershipFileName = EXTERNAL_CODEX_OWNERSHIP_FILE_NAME,
  reasonPrefix = 'external-codex',
} = {}) {
  return readState(ownershipFile(configDir, ownershipFileName), readFileImpl, reasonPrefix);
}

export function getExternalCodexOwnershipRecord(state, accountId) {
  return findRecord(normalizeExternalCodexOwnershipState(state), accountId);
}

export async function takeoverExternalCodexAccount({
  configDir,
  accountId,
  now = new Date().toISOString(),
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  mkdirImpl = mkdir,
  chmodImpl = chmod,
  openImpl = open,
  statImpl = stat,
  rmImpl = rm,
  ownershipFileName = EXTERNAL_CODEX_OWNERSHIP_FILE_NAME,
  reasonPrefix = 'external-codex',
} = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedAccountId) return { ok: false, reason: 'invalid-account-id' };
  const filePath = ownershipFile(configDir, ownershipFileName);
  return withStateLock(filePath, async () => {
    const loaded = await readState(filePath, readFileImpl, reasonPrefix);
    if (!loaded.ok) return loaded;
    const state = loaded.state;
    const record = findRecord(state, normalizedAccountId);
    if (!record) return { ok: false, reason: `${reasonPrefix}-account-not-pending` };
    if (state.currentExternalAccountId === normalizedAccountId) {
      return { ok: false, reason: `${reasonPrefix}-account-still-active` };
    }
    if (record.status !== 'handoff-pending') {
      return { ok: false, reason: `${reasonPrefix}-account-not-pending` };
    }
    upsertRecord(state, normalizedAccountId, (current) => ({
      ...current,
      status: 'ragent-owned',
      takeoverAt: now,
    }));
    state.updatedAt = now;
    await writeState(filePath, state, { writeFileImpl, renameImpl, mkdirImpl, chmodImpl });
    return { ok: true, state, accountId: normalizedAccountId };
  }, {
    openImpl,
    statImpl,
    rmImpl,
    mkdirImpl,
    lockTimeoutReason: `${reasonPrefix}-ownership-lock-timeout`,
  });
}
