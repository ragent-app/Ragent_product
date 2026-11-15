/**
 * Durable, atomic, fail-closed store for capability grant usage.
 *
 * Phase 2B slice 2B-1. This module is the durable CAS backing for
 * one-time-use capability grants. It has no policy authority by itself: it
 * only records and checks (grantId, useNonce) uniqueness, the usage budget,
 * and the TTL. Every failure path returns { ok:false, code } with a reason
 * code from chat/permission-policy.mjs PERMISSION_REASON_CODES; nothing is
 * allowed by default and no caller-declared scope/resource facts are trusted.
 *
 * Concurrency:
 *  - In-process: a per-grant keyed task queue serializes claims for the same
 *    grant, mirroring chat/runs.mjs / chat/fs-utils.mjs.
 *  - Cross-process: a per-grant lock file serializes the read-modify-write, so
 *    exactly one concurrent claim for the same (grantId, useNonce) wins even
 *    across processes. A stale lock (holder process gone) is reclaimed; a lock
 *    held by a live process is never stolen.
 *
 * Durability:
 *  - The usage registry binds each grantId to its first-seen immutable
 *    `{ usageMax, expiresAtMs }` constraints as well as
 *    `{ consumed, useNonces }`. A later caller cannot enlarge the budget or
 *    extend the lifetime by submitting different claim metadata.
 *  - Writes go to a unique temp file, fsync the file, then atomic rename; the
 *    parent directory is fsynced best-effort. A reader never observes partial
 *    state and an interrupted write never replaces the canonical state.
 *
 * This module performs no I/O at import time (no fixed path), so it is safe to
 * import from node:test without touching the host.
 */

import { chmod, link, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  CAPABILITY_USAGE_MAX,
  PERMISSION_REASON_CODES,
} from './permission-policy.mjs';

const C = PERMISSION_REASON_CODES;

const GRANT_STATE_SCHEMA = 'capability-grant-usage/v1';
const AUTHORIZATION_SCHEMA = 'capability-authorization/v1';
const USAGE_REGISTRY_SCHEMA = 'capability-grant-usage-registry/v1';
// grantId becomes a file name under the store dir. Only a conservative token
// charset is accepted so a caller-supplied id can never escape the store
// directory (no '/', no '..', no NUL).
const GRANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CAPABILITY_REF_RE = /^capref_[A-Za-z0-9_-]{16,127}$/;
const MAX_USE_NONCE_LENGTH = 256;
const MAX_CLAIMS_PER_SET = 32;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 15;
const CLAIM_FIELDS = new Set(['grantId', 'useNonce', 'usageMax', 'expiresAt', 'now']);
const CLAIM_SET_FIELDS = new Set(['claims']);

let atomicWriteSeq = 0;

function atomicTempPath(path) {
  return `${path}.tmp-${process.pid}-${Date.now()}-${atomicWriteSeq++}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toEpochMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

/** In-process serialization per key, mirroring chat/fs-utils.mjs. */
function createKeyedTaskQueue() {
  const pendingByKey = new Map();
  return async function run(key, task) {
    const previous = pendingByKey.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    pendingByKey.set(key, next);
    try {
      return await next;
    } finally {
      if (pendingByKey.get(key) === next) {
        pendingByKey.delete(key);
      }
    }
  };
}

function emptyState() {
  return { consumed: 0, useNonces: [] };
}

function stateWithBinding(state, { usageMax, expiresAtMs } = {}) {
  return {
    consumed: state.consumed,
    useNonces: [...state.useNonces],
    usageMax,
    expiresAtMs,
  };
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function usageRegistryPath(dir) {
  return join(dir, '.usage-registry.json');
}

function usageRegistryLockPath(dir) {
  return join(dir, '.usage-registry.lock');
}

function authorizationPath(dir, capabilityRef) {
  return join(dir, `${capabilityRef}.authorization.json`);
}

async function fsyncDir(dirPath) {
  let dirFd = null;
  try {
    dirFd = await open(dirPath, 'r');
    await dirFd.sync();
  } catch {
    // Directory fsync is not supported on every platform (notably Windows).
    // The file itself was fsynced before the atomic rename, so this is a
    // best-effort durability accelerator, never a correctness requirement.
  } finally {
    if (dirFd) await dirFd.close().catch(() => {});
  }
}

async function writeAuthorizationRecord(recordPath, record) {
  await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(recordPath), 0o700).catch(() => {});
  const tempPath = atomicTempPath(recordPath);
  let fd = null;
  try {
    fd = await open(tempPath, 'w', 0o600);
    await fd.writeFile(JSON.stringify(record), 'utf8');
    await fd.sync();
    await fd.close();
    fd = null;
    // Publish without replacement. Authorization refs are recovery pointers;
    // allowing rename() to overwrite an existing ref could silently rebind an
    // already-authorized action to different proof/grant material. The temp
    // file is complete and fsynced before this atomic no-clobber link.
    await link(tempPath, recordPath);
    await rm(tempPath, { force: true });
    await chmod(recordPath, 0o600).catch(() => {});
  } catch (error) {
    if (fd) await fd.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  await fsyncDir(dirname(recordPath));
}

async function writeJsonDurable(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(dirname(filePath), 0o700).catch(() => {});
  const tempPath = atomicTempPath(filePath);
  let fd = null;
  try {
    fd = await open(tempPath, 'w', 0o600);
    await fd.writeFile(JSON.stringify(value), 'utf8');
    await fd.sync();
    await fd.close();
    fd = null;
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600).catch(() => {});
  } catch (error) {
    if (fd) await fd.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  await fsyncDir(dirname(filePath));
}

async function readAuthorizationRecord(recordPath) {
  let raw;
  try {
    raw = await readFile(recordPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability authorization record is missing' };
    return { ok: false, code: C.CAPABILITY_INVALID, error: `unable to read capability authorization record: ${error.message}` };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability authorization record is not valid JSON' }; }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== AUTHORIZATION_SCHEMA || !isPlainObject(parsed.authorization)) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability authorization record schema is invalid' };
  }
  return { ok: true, record: clone(parsed) };
}

async function readGrantState(statePath) {
  let raw;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, state: emptyState() };
    return { ok: false, code: C.CAPABILITY_INVALID, error: `unable to read grant state: ${error.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'grant state is not valid JSON' };
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== GRANT_STATE_SCHEMA) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'grant state schema is unknown' };
  }
  const { consumed, useNonces } = parsed;
  if (!Number.isInteger(consumed) || consumed < 0) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'grant state consumed is invalid' };
  }
  if (!Array.isArray(useNonces) || useNonces.some((nonce) => typeof nonce !== 'string')) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'grant state useNonces is invalid' };
  }
  if (useNonces.length !== new Set(useNonces).size) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'grant state useNonces contains duplicates' };
  }
  // The store writes consumed and useNonces together and every consumption
  // records exactly one nonce, so a state where the counts diverge is either a
  // partial write or tampering. Fail closed rather than guess.
  if (useNonces.length !== consumed) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'grant state consumed and useNonces are inconsistent' };
  }
  return { ok: true, state: { consumed, useNonces: [...useNonces] } };
}

async function readUsageRegistry(dir) {
  const registryPath = usageRegistryPath(dir);
  let raw;
  try {
    raw = await readFile(registryPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') return { ok: false, code: C.CAPABILITY_INVALID, error: `unable to read capability usage registry: ${error.message}` };
    // Backward reader for the original per-grant files. The registry becomes
    // authoritative after the first successful write.
    let names = [];
    try { names = await readdir(dir); } catch (readError) {
      if (readError.code !== 'ENOENT') return { ok: false, code: C.CAPABILITY_INVALID, error: `unable to enumerate capability usage: ${readError.message}` };
    }
    const grants = {};
    for (const name of names.filter((entry) => entry.endsWith('.json')
      && !entry.startsWith('.')
      && !entry.endsWith('.authorization.json'))) {
      const grantId = name.slice(0, -5);
      if (!GRANT_ID_RE.test(grantId)) continue;
      const legacy = await readGrantState(join(dir, name));
      if (!legacy.ok) return legacy;
      if (legacy.state.consumed > 0) {
        // Legacy per-grant files did not persist the grant constraints. They
        // remain readable for diagnostics, but cannot authorize another use.
        grants[grantId] = legacy.state;
      }
    }
    return { ok: true, registry: { schemaVersion: USAGE_REGISTRY_SCHEMA, grants } };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability usage registry is not valid JSON' }; }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== USAGE_REGISTRY_SCHEMA || !isPlainObject(parsed.grants)) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability usage registry schema is invalid' };
  }
  const grants = {};
  for (const [grantId, state] of Object.entries(parsed.grants)) {
    const id = validateGrantId(grantId);
    if (!id.ok || !isPlainObject(state)) return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability usage registry contains an invalid grant' };
    if (!Number.isInteger(state.consumed) || state.consumed < 0 || !Array.isArray(state.useNonces)
      || state.useNonces.some((nonce) => typeof nonce !== 'string')
      || state.useNonces.length !== new Set(state.useNonces).size
      || state.useNonces.length !== state.consumed) {
      return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability usage registry contains invalid state' };
    }
    if (state.usageMax !== undefined
      && (!Number.isInteger(state.usageMax) || state.usageMax < 1 || state.usageMax > CAPABILITY_USAGE_MAX)) {
      return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability usage registry contains invalid usageMax' };
    }
    if (state.expiresAtMs !== undefined
      && (!Number.isFinite(state.expiresAtMs) || state.expiresAtMs <= 0)) {
      return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability usage registry contains invalid expiresAtMs' };
    }
    if ((state.usageMax === undefined) !== (state.expiresAtMs === undefined)) {
      return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability usage registry binding is incomplete' };
    }
    grants[grantId] = state.usageMax === undefined
      ? { consumed: state.consumed, useNonces: [...state.useNonces] }
      : stateWithBinding(state, state);
  }
  return { ok: true, registry: { schemaVersion: USAGE_REGISTRY_SCHEMA, grants } };
}

async function writeUsageRegistry(dir, registry) {
  await writeJsonDurable(usageRegistryPath(dir), {
    schemaVersion: USAGE_REGISTRY_SCHEMA,
    grants: registry.grants,
  });
}

async function isLockStale(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    // Lock disappeared between the failed create and this read; let the caller
    // retry immediately. Any other read failure is not proof that the holder is
    // gone, so retain the lock and fail closed on acquisition timeout.
    return error?.code === 'ENOENT';
  }
  let holder;
  try {
    holder = JSON.parse(raw);
  } catch {
    // open('wx') creates the lock before its owner payload is written. Treating
    // an empty/partial payload as stale lets a competitor unlink a live lock in
    // that window and enter the critical section concurrently.
    return false;
  }
  const pid = holder?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false; // holder is alive — the lock is genuinely held
  } catch (error) {
    if (error?.code === 'ESRCH') return true; // holder no longer exists — stale
    return false; // EPERM etc.: holder exists but we cannot signal it — never steal
  }
}

async function acquireLock(dir, lockPath, timeoutMs = LOCK_ACQUIRE_TIMEOUT_MS) {
  await mkdir(dir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const token = randomBytes(16).toString('hex');
      const fd = await open(lockPath, 'wx');
      try {
        await fd.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), 'utf8');
      } finally {
        await fd.close();
      }
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await isLockStale(lockPath)) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        const err = new Error('timed out acquiring capability grant lock');
        err.code = 'RAGENT_GRANT_LOCK_TIMEOUT';
        throw err;
      }
      await sleep(LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS + 1)));
    }
  }
}

async function releaseLock(lockPath, token) {
  // PID alone is not an owner identity: two store instances in one process
  // share it, and an async gap between read and unlink can otherwise delete a
  // lock that a waiting instance has just acquired. The random token closes
  // that same-process ABA window as well as documenting ownership clearly.
  try {
    const raw = await readFile(lockPath, 'utf8');
    const holder = JSON.parse(raw);
    if (holder?.pid === process.pid && holder?.token === token) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // Already gone or unreadable; nothing safe to remove.
  }
}

function validateGrantId(grantId) {
  if (typeof grantId !== 'string' || !GRANT_ID_RE.test(grantId)) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'grantId is invalid' };
  }
  return { ok: true, grantId };
}

function validateClaimInput(input) {
  if (!isPlainObject(input)) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'claim input must be an object' };
  }
  for (const key of Object.keys(input)) {
    if (!CLAIM_FIELDS.has(key)) {
      return { ok: false, code: C.CAPABILITY_INVALID, error: `unknown claim field: ${key}` };
    }
  }
  const { grantId, useNonce, usageMax, expiresAt, now } = input;
  const grantIdValidation = validateGrantId(grantId);
  if (!grantIdValidation.ok) return grantIdValidation;
  if (typeof useNonce !== 'string' || useNonce.length === 0 || useNonce.length > MAX_USE_NONCE_LENGTH) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'useNonce must be a non-empty string' };
  }
  if (!Number.isInteger(usageMax) || usageMax < 1 || usageMax > CAPABILITY_USAGE_MAX) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'usageMax must be an integer in [1, CAPABILITY_USAGE_MAX]' };
  }
  const nowMs = toEpochMs(now);
  const expiresAtMs = toEpochMs(expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs)) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'expiresAt and now must be valid timestamps' };
  }
  return { ok: true, grantId, useNonce, usageMax, nowMs, expiresAtMs };
}

function validateClaimSetInput(input) {
  if (!isPlainObject(input) || Object.keys(input).some((key) => !CLAIM_SET_FIELDS.has(key))) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'claim set input is invalid' };
  }
  if (!Array.isArray(input.claims) || input.claims.length === 0 || input.claims.length > MAX_CLAIMS_PER_SET) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: `claims must contain 1-${MAX_CLAIMS_PER_SET} entries` };
  }
  const claims = input.claims.map(validateClaimInput);
  const invalid = claims.find((claim) => !claim.ok);
  if (invalid) return invalid;
  const ids = claims.map((claim) => claim.grantId);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, code: C.CAPABILITY_INVALID, error: 'claim set contains duplicate grantId values' };
  }
  return { ok: true, claims };
}

/**
 * Open a durable capability grant usage store rooted at `dir`.
 *
 * Returns { claimGrant, getGrantState, close }:
 *  - claimGrant({ grantId, useNonce, usageMax, expiresAt, now }) atomically
 *    records one useNonce consumption and returns either
 *    { ok:true, state:{ consumed, useNonces } } (post-claim state) or
 *    { ok:false, code } where code is a PERMISSION_REASON_CODES value:
 *    CAPABILITY_USE_NONCE_REPLAY, CAPABILITY_USAGE_EXHAUSTED,
 *    CAPABILITY_EXPIRED, or CAPABILITY_INVALID (unknown/missing field,
 *    corrupt state, or storage failure). Exactly one concurrent claim for the
 *    same (grantId, useNonce) wins.
 *  - getGrantState({ grantId }) returns { ok:true, state:{ consumed,
 *    useNonces, usageMax?, expiresAtMs? } } (the default empty state when
 *    nothing was ever claimed) or
 *    { ok:false, code }.
 *  - close() marks the store closed; later claims and reads fail closed.
 */
export function openCapabilityGrantStore({ dir, lockAcquireTimeoutMs = LOCK_ACQUIRE_TIMEOUT_MS } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new Error('capability grant store requires a non-empty dir');
  }
  if (!Number.isFinite(Number(lockAcquireTimeoutMs)) || Number(lockAcquireTimeoutMs) < 1) {
    throw new Error('capability grant store requires a positive lockAcquireTimeoutMs');
  }
  const acquireTimeoutMs = Math.floor(Number(lockAcquireTimeoutMs));
  const queue = createKeyedTaskQueue();
  let closed = false;

  async function claimGrantSet(input) {
    if (closed) {
      return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability grant store is closed' };
    }
    const validation = validateClaimSetInput(input);
    if (!validation.ok) return validation;
    return queue('__usage_registry__', async () => {
      if (closed) {
        return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability grant store is closed' };
      }
      const lockPath = usageRegistryLockPath(dir);
      let lockToken = '';
      try {
        lockToken = await acquireLock(dir, lockPath, acquireTimeoutMs);
      } catch (error) {
        return { ok: false, code: C.CAPABILITY_INVALID, error: `unable to acquire capability grant lock: ${error.message}` };
      }
      try {
        const read = await readUsageRegistry(dir);
        if (!read.ok) return read;
        const nextGrants = clone(read.registry.grants);
        let bindingsChanged = false;
        // Bind every previously unseen grant before evaluating expiry or
        // budget. Otherwise a caller could submit an expired grant first,
        // then retry the same grantId with a later expiry and obtain a fresh
        // authorization window.
        for (const claim of validation.claims) {
          const existing = nextGrants[claim.grantId];
          if (!existing) {
            nextGrants[claim.grantId] = stateWithBinding(emptyState(), claim);
            bindingsChanged = true;
          }
        }
        if (bindingsChanged) {
          try {
            await writeUsageRegistry(dir, { grants: nextGrants });
          } catch (error) {
            return { ok: false, code: C.CAPABILITY_INVALID, error: `unable to persist capability grant binding atomically: ${error.message}` };
          }
        }
        for (const claim of validation.claims) {
          // Expiry boundary matches the pure evaluator: now >= expiresAt is
          // expired, including at the exact millisecond boundary.
          if (claim.nowMs >= claim.expiresAtMs) {
            return { ok: false, code: C.CAPABILITY_EXPIRED, error: 'capability grant has expired' };
          }
          const state = nextGrants[claim.grantId] || null;
          if (state && state.usageMax !== undefined
            && (state.usageMax !== claim.usageMax || state.expiresAtMs !== claim.expiresAtMs)) {
            return {
              ok: false,
              code: C.CAPABILITY_INVALID,
              error: 'capability grant usage constraints do not match the bound grant',
            };
          }
          if (state && state.usageMax === undefined) {
            return {
              ok: false,
              code: C.CAPABILITY_INVALID,
              error: 'capability grant usage constraints are not durably bound',
            };
          }
          const currentState = state || stateWithBinding(emptyState(), claim);
          if (currentState.useNonces.includes(claim.useNonce)) {
            return { ok: false, code: C.CAPABILITY_USE_NONCE_REPLAY, error: 'capability per-use nonce was already consumed' };
          }
          if (currentState.consumed >= claim.usageMax) {
            return { ok: false, code: C.CAPABILITY_USAGE_EXHAUSTED, error: 'capability usage budget is exhausted' };
          }
          nextGrants[claim.grantId] = stateWithBinding({
            consumed: currentState.consumed + 1,
            useNonces: [...currentState.useNonces, claim.useNonce],
          }, claim);
        }
        try {
          await writeUsageRegistry(dir, { grants: nextGrants });
        } catch (error) {
          return { ok: false, code: C.CAPABILITY_INVALID, error: `unable to persist capability grant usage atomically: ${error.message}` };
        }
        return { ok: true, states: Object.fromEntries(validation.claims.map((claim) => [claim.grantId, clone(nextGrants[claim.grantId])] )) };
      } catch (error) {
        return { ok: false, code: C.CAPABILITY_INVALID, error: `unable to claim capability grant set: ${error.message}` };
      } finally {
        await releaseLock(lockPath, lockToken);
      }
    });
  }

  async function claimGrant(input) {
    const result = await claimGrantSet({ claims: [input] });
    if (!result.ok) return result;
    const grantId = input?.grantId;
    return { ok: true, state: result.states[grantId] };
  }

  async function getGrantState({ grantId }) {
    if (closed) {
      return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability grant store is closed' };
    }
    const grantIdValidation = validateGrantId(grantId);
    if (!grantIdValidation.ok) return grantIdValidation;
    const result = await readUsageRegistry(dir);
    if (!result.ok) return result;
    const state = result.registry.grants[grantId] || emptyState();
    return { ok: true, state: clone(state) };
  }

  async function putAuthorization({ capabilityRef = '', actionId = '', sessionId = '', runId = '', turnId = '', authorization } = {}) {
    if (closed) return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability grant store is closed' };
    if (!isPlainObject(authorization) || !trimString(actionId) || !trimString(sessionId) || !trimString(runId) || !trimString(turnId)) {
      return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability authorization record is missing binding or material' };
    }
    const ref = trimString(capabilityRef) || `capref_${randomBytes(24).toString('base64url')}`;
    if (!CAPABILITY_REF_RE.test(ref)) return { ok: false, code: C.CAPABILITY_INVALID, error: 'capabilityRef is invalid' };
    const record = {
      schemaVersion: AUTHORIZATION_SCHEMA,
      capabilityRef: ref,
      actionId: trimString(actionId),
      sessionId: trimString(sessionId),
      runId: trimString(runId),
      turnId: trimString(turnId),
      createdAt: new Date().toISOString(),
      authorization: clone(authorization),
    };
    try {
      await writeAuthorizationRecord(authorizationPath(dir, ref), record);
      return { ok: true, capabilityRef: ref };
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const existing = await readAuthorizationRecord(authorizationPath(dir, ref));
        if (existing.ok
          && existing.record.actionId === record.actionId
          && existing.record.sessionId === record.sessionId
          && existing.record.runId === record.runId
          && existing.record.turnId === record.turnId
          && isDeepStrictEqual(existing.record.authorization, record.authorization)) {
          return { ok: true, capabilityRef: ref, duplicate: true };
        }
        return { ok: false, code: C.CAPABILITY_INVALID, error: 'capabilityRef already belongs to different authorization material' };
      }
      return { ok: false, code: C.CAPABILITY_INVALID, error: `unable to persist capability authorization: ${error.message}` };
    }
  }

  async function getAuthorization({ capabilityRef = '', actionId = '', sessionId = '', runId = '', turnId = '' } = {}) {
    if (closed) return { ok: false, code: C.CAPABILITY_INVALID, error: 'capability grant store is closed' };
    const ref = trimString(capabilityRef);
    if (!CAPABILITY_REF_RE.test(ref)) return { ok: false, code: C.CAPABILITY_INVALID, error: 'capabilityRef is invalid' };
    const result = await readAuthorizationRecord(authorizationPath(dir, ref));
    if (!result.ok) return result;
    const record = result.record;
    for (const [field, expected] of Object.entries({ actionId, sessionId, runId, turnId })) {
      if (trimString(expected) && record[field] !== trimString(expected)) {
        return { ok: false, code: C.CAPABILITY_INVALID, error: `capability authorization ${field} binding mismatch` };
      }
    }
    return { ok: true, capabilityRef: ref, authorization: clone(record.authorization) };
  }

  function close() {
    closed = true;
  }

  return { claimGrant, claimGrantSet, getGrantState, putAuthorization, getAuthorization, close };
}
