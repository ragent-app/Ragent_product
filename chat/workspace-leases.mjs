// Durable WorkspaceLease store (Execution-Scope slice 3, design section 7).
//
// Coordinates reader/writer admission per physical Workspace so two AgentoC
// writers can never be admitted on the same canonical lockKey. Persists to
// CONFIG_DIR/runtime-coordination.db using node:sqlite + WAL (same pattern as
// chat/collaboration-store.mjs), independent of the collaboration store.
//
// Admission uses a short BEGIN IMMEDIATE transaction: read occupying holders
// for the lockKey, run the reader/writer compatibility check, bump the
// workspace_resources generation, insert the 'preparing' lease row, and
// commit. Git probing, runtime liveness checks and prompt building must never
// run inside the SQLite transaction.
//
// Frozen error codes (notes/current/execution-scope-contract.md):
//   WORKSPACE_LEASE_CONFLICT (409) -- reader/writer admission conflict
// Invalid inputs raise EINVAL (400).
import { randomBytes } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

import { CONFIG_DIR } from '../lib/config.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';
import { getWorkspaceById } from './workspaces.mjs';

export const WORKSPACE_LEASE_SCHEMA_VERSION = 1;
export const DEFAULT_HEARTBEAT_MS = 10 * 1000;
export const DEFAULT_TTL_MS = 45 * 1000;
const LEASE_ID_PREFIX = 'wsl_';
const OCCUPYING_STATES = new Set(['preparing', 'active', 'quarantined']);

const leaseMutation = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function createLeaseError(message, code, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function dbPath() {
  return join(CONFIG_DIR, 'runtime-coordination.db');
}

function openDatabase() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // busy_timeout keeps two independent Node processes (control plane + sidecar,
  // or two test processes) racing on BEGIN IMMEDIATE from deadlocking: the
  // loser waits for the winner's short transaction instead of failing with
  // SQLITE_BUSY.
  const db = new DatabaseSync(dbPath(), { timeout: 10_000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_resources (
      lock_key TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_leases (
      lease_id TEXT PRIMARY KEY,
      lock_key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('read','write')),
      workspace_id TEXT,
      project_id TEXT,
      session_id TEXT,
      run_id TEXT UNIQUE,
      runtime_id TEXT,
      runtime_capability_json TEXT,
      execution_scope_digest TEXT,
      state TEXT NOT NULL CHECK(state IN ('preparing','active','released','quarantined','reclaimed')),
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      hard_expires_at TEXT,
      runtime_terminal_at TEXT,
      released_at TEXT,
      recovery_json TEXT
    );
    CREATE TABLE IF NOT EXISTS workspace_lease_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lease_id TEXT,
      lock_key TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_leases_lock_state ON workspace_leases(lock_key, state);
    CREATE INDEX IF NOT EXISTS idx_workspace_leases_state_expires ON workspace_leases(state, expires_at);
    CREATE INDEX IF NOT EXISTS idx_workspace_leases_run ON workspace_leases(run_id);
  `);
  // S4 additive column (idempotent for stores created before this slice).
  const leaseColumns = new Set(db.prepare('PRAGMA table_info(workspace_leases)').all().map((column) => column.name));
  if (!leaseColumns.has('runtime_capability_json')) {
    db.exec('ALTER TABLE workspace_leases ADD COLUMN runtime_capability_json TEXT');
  }
  // Mutation-scoped leases carry an optional hard expiry (additive). NULL
  // means "no hard cap": renewLease/activateLease may keep sliding the soft
  // expires_at forward (the pre-redesign behavior). Only leases created with
  // an explicit hardTtlMs are bounded.
  if (!leaseColumns.has('hard_expires_at')) {
    db.exec('ALTER TABLE workspace_leases ADD COLUMN hard_expires_at TEXT');
  }
  return db;
}

function rowLease(row) {
  if (!row) return null;
  return {
    schemaVersion: WORKSPACE_LEASE_SCHEMA_VERSION,
    leaseId: row.lease_id,
    lockKey: row.lock_key,
    generation: row.generation,
    mode: row.mode,
    workspaceId: row.workspace_id || '',
    projectId: row.project_id || '',
    sessionId: row.session_id || '',
    runId: row.run_id || '',
    runtimeId: row.runtime_id || '',
    runtimeCapability: parseJson(row.runtime_capability_json, null),
    executionScopeDigest: row.execution_scope_digest || '',
    state: row.state,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    hardExpiresAt: row.hard_expires_at || null,
    runtimeTerminalAt: row.runtime_terminal_at || null,
    releasedAt: row.released_at || null,
    recovery: parseJson(row.recovery_json, null),
  };
}

function insertEvent(db, { leaseId = '', lockKey = '', type, payload = null, createdAt }) {
  const normalizedType = trimString(type);
  if (!normalizedType) {
    throw createLeaseError('lease event requires a type', 'EINVAL');
  }
  db.prepare(`
    INSERT INTO workspace_lease_events (lease_id, lock_key, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(leaseId, trimString(lockKey), normalizedType, payload == null ? null : JSON.stringify(payload), createdAt);
  return { leaseId, lockKey: trimString(lockKey), type: normalizedType, createdAt };
}

function reclaimExpiredLeases(db, { lockKey, now }) {
  const reclaimedAt = nowIso(now);
  // A crashed mutation lease is 'preparing' or 'active' and expired. A
  // quarantined lease is a deliberate hold from the old liveness path and is
  // only ever reclaimed by startup recovery (recoverMutationLeases), never at
  // acquire time.
  const expired = db.prepare(`
    SELECT lease_id, generation
    FROM workspace_leases
    WHERE lock_key = ?
      AND state IN ('preparing', 'active')
      AND COALESCE(runtime_id, '') <> 'factory-integration'
      AND expires_at < ?
  `).all(lockKey, reclaimedAt);
  if (expired.length === 0) return [];

  const reason = 'expired-lease';
  for (const lease of expired) {
    db.prepare(`
      UPDATE workspace_leases
      SET state = 'reclaimed', released_at = ?, recovery_json = ?
      WHERE lease_id = ? AND generation = ?
        AND state IN ('preparing', 'active')
    `).run(reclaimedAt, JSON.stringify({ reason }), lease.lease_id, lease.generation);
    insertEvent(db, {
      leaseId: lease.lease_id,
      lockKey,
      type: 'workspace_lease_reclaimed',
      payload: { generation: lease.generation, reason, releasedAt: reclaimedAt },
      createdAt: reclaimedAt,
    });
  }
  return expired;
}

/**
 * Record an audit event (state transitions only; heartbeats never write
 * events). Exposed for admission-adjacent flows that must leave a trace
 * without acquiring a lease (e.g. legacy synthetic-lease skips).
 */
export async function recordLeaseEvent({ leaseId = '', lockKey = '', type, payload = null, now = new Date() } = {}) {
  return leaseMutation(async () => {
    const db = openDatabase();
    try {
      return insertEvent(db, {
        leaseId: trimString(leaseId),
        lockKey,
        type,
        payload,
        createdAt: nowIso(now),
      });
    } finally {
      db.close();
    }
  });
}

async function selectLeaseById(db, leaseId) {
  return db.prepare('SELECT * FROM workspace_leases WHERE lease_id = ?').get(leaseId);
}

function assertTtlVsHeartbeat(ttlMs, heartbeatMs) {
  const ttl = Number(ttlMs);
  const heartbeat = Number(heartbeatMs);
  if (!Number.isFinite(ttl) || !Number.isFinite(heartbeat) || ttl <= 0 || heartbeat <= 0) {
    throw createLeaseError('ttlMs and heartbeatMs must be positive numbers', 'EINVAL');
  }
  if (ttl < 3 * heartbeat) {
    throw createLeaseError('ttlMs must be at least 3 * heartbeatMs', 'EINVAL');
  }
}

function compatibilityConflict(mode, occupying) {
  // No holder: allowed. READ x READ: allowed. WRITE against any holder, or
  // READ against a WRITE holder: conflict. This slice never mixes READ+WRITE.
  if (occupying.length === 0) return '';
  if (mode === 'write') return 'writer-conflict';
  if (occupying.some((row) => row.mode === 'write')) return 'reader-writer-conflict';
  return '';
}

/**
 * Acquire a WorkspaceLease for a physical lockKey.
 *
 * input: { lockKey, mode, workspaceId, projectId, sessionId, runId, runtimeId,
 *          executionScopeDigest, shadow, ttlMs, now }
 *
 * Returns the holder shape when admitted (state 'preparing'); on a shadow-mode
 * conflict returns { conflict: true, reason, mode: 'shadow' } without throwing;
 * on an enforce-mode conflict throws WORKSPACE_LEASE_CONFLICT (409) carrying
 * only project/run-accessible summary fields (never host details).
 */
export async function acquireWorkspaceLease(input = {}) {
  const {
    lockKey,
    mode,
    workspaceId,
    projectId,
    sessionId,
    runId,
    runtimeId,
    runtimeCapability,
    executionScopeDigest,
    shadow = false,
    ttlMs = DEFAULT_TTL_MS,
    hardTtlMs = null,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    now = new Date(),
  } = input;
  if (heartbeatMs !== null && heartbeatMs !== undefined) {
    assertTtlVsHeartbeat(ttlMs, heartbeatMs);
  }
  const hasHardTtl = hardTtlMs !== null && hardTtlMs !== undefined;
  if (hasHardTtl && (!Number.isFinite(Number(hardTtlMs)) || Number(hardTtlMs) <= 0)) {
    throw createLeaseError('hardTtlMs must be a positive number', 'EINVAL');
  }
  if (hasHardTtl && Number(hardTtlMs) < Number(ttlMs)) {
    throw createLeaseError('hardTtlMs must be >= ttlMs', 'EINVAL');
  }

  const normalizedMode = mode === 'read' ? 'read' : mode === 'write' ? 'write' : '';
  if (!normalizedMode) {
    throw createLeaseError('mode must be read or write', 'EINVAL');
  }
  let resolvedLockKey = trimString(lockKey);
  if (!resolvedLockKey && trimString(workspaceId)) {
    const workspace = await getWorkspaceById(workspaceId);
    resolvedLockKey = workspace && trimString(workspace.physicalKey) ? workspace.physicalKey : '';
  }
  if (!resolvedLockKey) {
    throw createLeaseError('lockKey is required', 'EINVAL');
  }

  const acquiredAt = nowIso(now);
  const heartbeatAt = acquiredAt;
  const expiresAt = new Date(new Date(acquiredAt).getTime() + ttlMs).toISOString();
  const hardExpiresAt = hasHardTtl
    ? new Date(new Date(acquiredAt).getTime() + hardTtlMs).toISOString()
    : null;
  const normalizedRunId = trimString(runId) || null;

  return leaseMutation(async () => {
    const db = openDatabase();
    try {
      db.exec('BEGIN IMMEDIATE');

      // Retry safety: a runId that already holds a live lease is re-attached
      // rather than admitted twice (prepareRunExecution can be retried after a
      // crash between lease admission and Run persistence). An expired holder
      // is never re-attached: it falls through to normal admission, which
      // reclaims it below.
      if (normalizedRunId) {
        const existing = db.prepare('SELECT * FROM workspace_leases WHERE run_id = ?').get(normalizedRunId);
        if (existing && Date.parse(existing.expires_at) > Date.parse(acquiredAt)) {
          db.exec('COMMIT');
          return rowLease(existing);
        }
      }

      // Any expired occupying lease is abandoned (mutation leases are short
      // locks; an expired holder never wrote its final release). Reclaim it
      // before running the compatibility check so a stale holder cannot block
      // the next compatible admission.
      reclaimExpiredLeases(db, { lockKey: resolvedLockKey, now });

      const occupying = db.prepare(`
        SELECT lease_id, mode, state
        FROM workspace_leases
        WHERE lock_key = ? AND state IN ('preparing', 'active', 'quarantined')
      `).all(resolvedLockKey);
      const conflictReason = compatibilityConflict(normalizedMode, occupying);
      if (conflictReason) {
        insertEvent(db, {
          leaseId: '',
          lockKey: resolvedLockKey,
          type: 'workspace_lease_conflict',
          payload: {
            mode: normalizedMode,
            reason: conflictReason,
            workspaceId: trimString(workspaceId),
            projectId: trimString(projectId),
            runId: normalizedRunId,
            ...(shadow ? { shadow: true } : {}),
          },
          createdAt: nowIso(now),
        });
        db.exec('COMMIT');
        if (shadow) {
          return { conflict: true, reason: conflictReason, mode: 'shadow', lockKey: resolvedLockKey };
        }
        throw createLeaseError(
          'Workspace lease admission conflict: another holder is using this workspace',
          'WORKSPACE_LEASE_CONFLICT',
          409,
          {
            mode: normalizedMode,
            reason: conflictReason,
            workspaceId: trimString(workspaceId),
            projectId: trimString(projectId),
            runId: normalizedRunId,
          },
        );
      }

      const resource = db.prepare(`
        INSERT INTO workspace_resources (lock_key, generation, updated_at) VALUES (?, 0, ?)
        ON CONFLICT(lock_key) DO NOTHING
      `).run(resolvedLockKey, acquiredAt);
      const currentResource = db.prepare('SELECT generation FROM workspace_resources WHERE lock_key = ?').get(resolvedLockKey);
      const generation = Number(currentResource?.generation || 0) + 1;
      db.prepare('UPDATE workspace_resources SET generation = ?, updated_at = ? WHERE lock_key = ?')
        .run(generation, acquiredAt, resolvedLockKey);

      const leaseId = `${LEASE_ID_PREFIX}${randomBytes(12).toString('hex')}`;
      db.prepare(`
        INSERT INTO workspace_leases (
          lease_id, lock_key, generation, mode, workspace_id, project_id, session_id,
          run_id, runtime_id, runtime_capability_json, execution_scope_digest, state, acquired_at, heartbeat_at,
          expires_at, hard_expires_at, runtime_terminal_at, released_at, recovery_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, NULL, NULL, NULL)
      `).run(
        leaseId,
        resolvedLockKey,
        generation,
        normalizedMode,
        trimString(workspaceId) || null,
        trimString(projectId) || null,
        trimString(sessionId) || null,
        normalizedRunId,
        trimString(runtimeId) || null,
        runtimeCapability && typeof runtimeCapability === 'object'
          ? JSON.stringify(runtimeCapability)
          : null,
        trimString(executionScopeDigest) || null,
        acquiredAt,
        heartbeatAt,
        expiresAt,
        hardExpiresAt,
      );
      insertEvent(db, {
        leaseId,
        lockKey: resolvedLockKey,
        type: 'workspace_lease_acquired',
        payload: {
          mode: normalizedMode,
          generation,
          workspaceId: trimString(workspaceId),
          projectId: trimString(projectId),
          sessionId: trimString(sessionId),
          runId: normalizedRunId,
          runtimeId: trimString(runtimeId) || null,
          runtimeCapability: runtimeCapability && typeof runtimeCapability === 'object'
            ? runtimeCapability
            : null,
        },
        createdAt: acquiredAt,
      });
      db.exec('COMMIT');
      return rowLease(await selectLeaseById(db, leaseId));
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // no open transaction — fall through
      }
      throw error;
    } finally {
      db.close();
    }
  });
}

/**
 * Switch a 'preparing' lease to 'active' once the ExecutionScopeSnapshot digest
 * exists. preparing and active both count as occupying for admission.
 */
export async function activateLease(leaseId, generation, {
  executionScopeDigest = '',
  ttlMs = DEFAULT_TTL_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  now = new Date(),
} = {}) {
  assertTtlVsHeartbeat(ttlMs, heartbeatMs);
  const normalizedId = trimString(leaseId);
  const gen = Number.isInteger(generation) ? generation : -1;
  if (!normalizedId) throw createLeaseError('leaseId is required', 'EINVAL');
  const activatedAt = nowIso(now);
  return leaseMutation(async () => {
    const db = openDatabase();
    try {
      db.exec('BEGIN IMMEDIATE');
      const before = await selectLeaseById(db, normalizedId);
      const hardAt = Date.parse(before?.hard_expires_at || '');
      const expiresAt = new Date(Math.min(
        new Date(activatedAt).getTime() + ttlMs,
        Number.isFinite(hardAt) ? hardAt : new Date(activatedAt).getTime() + ttlMs,
      )).toISOString();
      const updated = db.prepare(`
        UPDATE workspace_leases
        SET execution_scope_digest = ?, state = 'active', heartbeat_at = ?, expires_at = ?
        WHERE lease_id = ? AND generation = ? AND state = 'preparing'
      `).run(trimString(executionScopeDigest) || null, activatedAt, expiresAt, normalizedId, gen);
      if (Number(updated.changes) === 0) {
        db.exec('COMMIT');
        return null;
      }
      insertEvent(db, {
        leaseId: normalizedId,
        lockKey: (await selectLeaseById(db, normalizedId))?.lock_key || '',
        type: 'workspace_lease_active',
        payload: { generation: gen, executionScopeDigest: trimString(executionScopeDigest) || '' },
        createdAt: activatedAt,
      });
      db.exec('COMMIT');
      return rowLease(await selectLeaseById(db, normalizedId));
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // no open transaction
      }
      throw error;
    } finally {
      db.close();
    }
  });
}

/**
 * Conditional heartbeat: (lease_id, generation) UPDATE so a stale generation
 * can never renew a new holder's lease. Returns null when the condition does
 * not match; heartbeats never write audit events.
 */
export async function renewLease(leaseId, generation, { ttlMs = DEFAULT_TTL_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS, now = new Date() } = {}) {
  assertTtlVsHeartbeat(ttlMs, heartbeatMs);
  const normalizedId = trimString(leaseId);
  const gen = Number.isInteger(generation) ? generation : -1;
  if (!normalizedId) return null;
  const heartbeatAt = nowIso(now);
  return leaseMutation(async () => {
    const db = openDatabase();
    try {
      const before = await selectLeaseById(db, normalizedId);
      if (!before || before.generation !== gen || !['preparing', 'active'].includes(before.state)) return null;
      const hardAt = Date.parse(before.hard_expires_at || '');
      // Heartbeat slides the soft expiry forward but never past the hard cap:
      // with no hard cap the expiry advances as before (pre-redesign leases).
      const expiresAt = new Date(Math.min(
        new Date(heartbeatAt).getTime() + ttlMs,
        Number.isFinite(hardAt) ? hardAt : new Date(heartbeatAt).getTime() + ttlMs,
      )).toISOString();
      const updated = db.prepare(`
        UPDATE workspace_leases
        SET heartbeat_at = ?, expires_at = ?
        WHERE lease_id = ? AND generation = ? AND state IN ('preparing', 'active')
      `).run(heartbeatAt, expiresAt, normalizedId, gen);
      if (Number(updated.changes) === 0) return null;
      return rowLease(await selectLeaseById(db, normalizedId));
    } finally {
      db.close();
    }
  });
}

/**
 * The sidecar records runtime terminal AFTER persisting the terminal result;
 * the lease stays occupying until the control plane releases or reclaims it.
 */
export async function markRuntimeTerminal(leaseId, generation, { now = new Date() } = {}) {
  const normalizedId = trimString(leaseId);
  const gen = Number.isInteger(generation) ? generation : -1;
  if (!normalizedId) return null;
  const terminalAt = nowIso(now);
  return leaseMutation(async () => {
    const db = openDatabase();
    try {
      const updated = db.prepare(`
        UPDATE workspace_leases
        SET runtime_terminal_at = ?
        WHERE lease_id = ? AND generation = ? AND state IN ('preparing', 'active')
      `).run(terminalAt, normalizedId, gen);
      if (Number(updated.changes) === 0) return null;
      return rowLease(await selectLeaseById(db, normalizedId));
    } finally {
      db.close();
    }
  });
}

async function transitionLease({ leaseId, generation, nextState, reason, now, eventType }) {
  const normalizedId = trimString(leaseId);
  const gen = Number.isInteger(generation) ? generation : -1;
  if (!normalizedId) throw createLeaseError('leaseId is required', 'EINVAL');
  const releasedAt = nowIso(now);
  const recoveryJson = reason ? JSON.stringify({ reason }) : null;
  return leaseMutation(async () => {
    const db = openDatabase();
    try {
      db.exec('BEGIN IMMEDIATE');
      const updated = db.prepare(`
        UPDATE workspace_leases
        SET state = ?, released_at = ?, recovery_json = COALESCE(?, recovery_json)
        WHERE lease_id = ? AND generation = ? AND state IN ('preparing', 'active', 'quarantined')
      `).run(nextState, releasedAt, recoveryJson, normalizedId, gen);
      if (Number(updated.changes) === 0) {
        db.exec('COMMIT');
        return null;
      }
      const row = await selectLeaseById(db, normalizedId);
      insertEvent(db, {
        leaseId: normalizedId,
        lockKey: row?.lock_key || '',
        type: eventType,
        payload: { generation: gen, reason: reason || '', releasedAt },
        createdAt: releasedAt,
      });
      db.exec('COMMIT');
      return rowLease(row);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // no open transaction
      }
      throw error;
    } finally {
      db.close();
    }
  });
}

/**
 * Control-plane release: only the current generation may release; the holder
 * stops occupying so the next compatible admission can proceed.
 */
export async function releaseLease(leaseId, generation, { reason = '', now = new Date() } = {}) {
  return transitionLease({
    leaseId,
    generation,
    nextState: 'released',
    reason: trimString(reason),
    now,
    eventType: 'workspace_lease_released',
  });
}

/** Reclaim after runtime death is confirmed; frees the holder. */
export async function reclaimLease(leaseId, generation, { reason = '', now = new Date() } = {}) {
  return transitionLease({
    leaseId,
    generation,
    nextState: 'reclaimed',
    reason: trimString(reason),
    now,
    eventType: 'workspace_lease_reclaimed',
  });
}

/** Quarantine when liveness cannot be confirmed: blocks conflicting runs. */
export async function quarantineLease(leaseId, { reason = '', now = new Date() } = {}) {
  const normalizedId = trimString(leaseId);
  if (!normalizedId) throw createLeaseError('leaseId is required', 'EINVAL');
  const quarantinedAt = nowIso(now);
  const recoveryJson = reason ? JSON.stringify({ reason }) : null;
  return leaseMutation(async () => {
    const db = openDatabase();
    try {
      db.exec('BEGIN IMMEDIATE');
      const updated = db.prepare(`
        UPDATE workspace_leases
        SET state = 'quarantined', recovery_json = COALESCE(?, recovery_json)
        WHERE lease_id = ? AND state IN ('preparing', 'active')
      `).run(recoveryJson, normalizedId);
      if (Number(updated.changes) === 0) {
        db.exec('COMMIT');
        return null;
      }
      const row = await selectLeaseById(db, normalizedId);
      insertEvent(db, {
        leaseId: normalizedId,
        lockKey: row?.lock_key || '',
        type: 'workspace_lease_quarantined',
        payload: { reason: trimString(reason) || '', quarantinedAt },
        createdAt: quarantinedAt,
      });
      db.exec('COMMIT');
      return rowLease(row);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // no open transaction
      }
      throw error;
    } finally {
      db.close();
    }
  });
}

/** All leases that currently occupy their lockKey (preparing/active). */
export async function listActiveLeases() {
  return leaseMutation(async () => {
    const db = openDatabase();
    try {
      return db.prepare(`
        SELECT * FROM workspace_leases
        WHERE state IN ('preparing', 'active')
        ORDER BY acquired_at, lease_id
      `).all().map(rowLease);
    } finally {
      db.close();
    }
  });
}

/** Occupying leases whose expires_at is before `now`. */
export async function listExpiredLeases(now = new Date()) {
  const threshold = nowIso(now);
  return leaseMutation(async () => {
    const db = openDatabase();
    try {
      return db.prepare(`
        SELECT * FROM workspace_leases
        WHERE state IN ('preparing', 'active') AND expires_at < ?
        ORDER BY acquired_at, lease_id
      `).all(threshold).map(rowLease);
    } finally {
      db.close();
    }
  });
}

/**
 * Startup recovery over occupying leases. isRuntimeAlive(lease) must return
 * 'alive' | 'dead' | 'unknown'.
 *
 *   not expired + alive        -> renew + reattach
 *   not expired + dead         -> reclaim (runtime death confirmed)
 *   expired     + alive        -> renew + reattach (never reclaim)
 *   expired     + dead         -> reclaim
 *   liveness unknown           -> quarantine (blocks conflicting runs)
 *
 * TTL is not writer fencing: without proof the old runtime is dead we never
 * grant a new writer merely because the lease expired.
 *
 * Returns an audit array [{ leaseId, lockKey, runId, action }].
 */
export async function recoverLeases({ isRuntimeAlive, now = new Date() } = {}) {
  const referenceNow = now instanceof Date ? now : new Date(now);
  const audits = [];
  const active = await listActiveLeases();
  for (const lease of active) {
    // No persisted Run means no runner can own this lease. This can only be a
    // crash in the tiny admission-to-createRun window, so recovery must free
    // it instead of quarantining the whole Workspace indefinitely.
    if (!trimString(lease.runId)) {
      const reclaimed = await reclaimLease(lease.leaseId, lease.generation, {
        reason: 'untracked-pre-run',
        now: referenceNow,
      });
      audits.push({
        leaseId: lease.leaseId,
        lockKey: lease.lockKey,
        runId: lease.runId,
        action: reclaimed ? 'reclaimed' : 'skipped',
      });
      continue;
    }
    let liveness = 'unknown';
    if (typeof isRuntimeAlive === 'function') {
      try {
        const result = await isRuntimeAlive(lease);
        liveness = result === 'alive' || result === 'dead' ? result : 'unknown';
      } catch {
        liveness = 'unknown';
      }
    }
    const expired = Date.parse(lease.expiresAt) < referenceNow.getTime();
    if (liveness === 'alive') {
      const renewed = await renewLease(lease.leaseId, lease.generation, {
        ttlMs: DEFAULT_TTL_MS,
        heartbeatMs: DEFAULT_HEARTBEAT_MS,
        now: referenceNow,
      });
      if (renewed) {
        await recordLeaseEvent({
          leaseId: lease.leaseId,
          lockKey: lease.lockKey,
          type: 'workspace_lease_recovered',
          payload: { action: expired ? 'renewed' : 'reattached', runId: lease.runId },
          now: referenceNow,
        });
        audits.push({ leaseId: lease.leaseId, lockKey: lease.lockKey, runId: lease.runId, action: expired ? 'renewed' : 'reattached' });
      } else {
        audits.push({ leaseId: lease.leaseId, lockKey: lease.lockKey, runId: lease.runId, action: 'skipped' });
      }
    } else if (liveness === 'dead') {
      const reclaimed = await reclaimLease(lease.leaseId, lease.generation, { reason: 'runtime-dead', now: referenceNow });
      audits.push({
        leaseId: lease.leaseId,
        lockKey: lease.lockKey,
        runId: lease.runId,
        action: reclaimed ? 'reclaimed' : 'skipped',
      });
    } else {
      const quarantined = await quarantineLease(lease.leaseId, { reason: 'liveness-unknown', now: referenceNow });
      audits.push({
        leaseId: lease.leaseId,
        lockKey: lease.lockKey,
        runId: lease.runId,
        action: quarantined ? 'quarantined' : 'skipped',
      });
    }
  }
  return audits;
}

/**
 * Startup recovery for mutation-scoped leases. A mutation lease is a short
 * lock: once its expires_at (hard-capped at hard_expires_at for explicit
 * hardTtlMs leases) has passed, no holder can legitimately still be writing,
 * so every expired occupying lease is reclaimed without a run-liveness probe.
 * Replaces the old per-run liveness recover/reclaim/quarantine pass for the
 * run-lifecycle lease model. Fail-safe: never throws into startup.
 *
 * Returns an audit array [{ leaseId, lockKey, runId, action }].
 */
export async function recoverMutationLeases({ now = new Date() } = {}) {
  const referenceNow = now instanceof Date ? now : new Date(now);
  const threshold = nowIso(referenceNow);
  const expired = await leaseMutation(async () => {
    const db = openDatabase();
    try {
      return db.prepare(`
        SELECT lease_id, generation, lock_key, run_id
        FROM workspace_leases
        WHERE state IN ('preparing', 'active', 'quarantined')
          AND COALESCE(runtime_id, '') <> 'factory-integration'
          AND expires_at < ?
        ORDER BY acquired_at, lease_id
      `).all(threshold);
    } finally {
      db.close();
    }
  });
  const audits = [];
  for (const lease of expired) {
    const reclaimed = await reclaimLease(lease.lease_id, lease.generation, {
      reason: 'expired-mutation-lease',
      now: referenceNow,
    });
    audits.push({
      leaseId: lease.lease_id,
      lockKey: lease.lock_key,
      runId: lease.run_id || '',
      action: reclaimed ? 'reclaimed' : 'skipped',
    });
  }
  return audits;
}

/** Look up a lease by its run id (used by legacy synthetic-lease idempotency). */
export async function findLeaseByRunId(runId) {
  const normalizedRunId = trimString(runId);
  if (!normalizedRunId) return null;
  return leaseMutation(async () => {
    const db = openDatabase();
    try {
      return rowLease(db.prepare('SELECT * FROM workspace_leases WHERE run_id = ?').get(normalizedRunId));
    } finally {
      db.close();
    }
  });
}

/**
 * Test cleanup: connections are opened per operation, so closing is a no-op
 * that exists as an explicit store-lifecycle hook for tests that reset state.
 */
export async function closeWorkspaceLeaseStore() {
  return undefined;
}
