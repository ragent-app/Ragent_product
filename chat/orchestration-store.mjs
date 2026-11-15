// Durable, provider-neutral orchestration ledger.
//
// Collaboration, organization and approval features already share the same
// SQLite file.  This module adds a small common execution vocabulary without
// replacing their domain stores in one risky migration: an Execution owns
// checkpoints and Steps; Commands model external side effects; Interrupts
// model durable human/external waits.  Each record is fenced with a version or
// a claim token so recovery can replay intent without guessing that an effect
// happened.
import { createHash, randomBytes } from 'crypto';
import { openDatabase as openCollaborationDatabase } from './collaboration-store.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';

const runMutation = createSerialTaskQueue();
const COMMAND_LEASE_MS = positiveDurationFromEnv('RAGENT_ORCHESTRATION_COMMAND_LEASE_MS', 2 * 60 * 1000);
const RETRY_DELAY_MS = positiveDurationFromEnv('RAGENT_ORCHESTRATION_RETRY_DELAY_MS', 5 * 1000);
const MAX_TEXT = 4000;
const MAX_JSON_BYTES = 256 * 1024;

// `failed` is intentionally resumable: Collaboration supports a policy-bound
// owner retry and a late verified Run result may repair an unknown outcome.
// Only completed/cancelled/dead-letter executions are irreversibly terminal.
const TERMINAL_EXECUTION_STATES = new Set(['completed', 'cancelled', 'dead_letter']);
const TERMINAL_COMMAND_STATES = new Set(['completed', 'cancelled', 'dead_letter']);
const TERMINAL_INTERRUPT_STATES = new Set(['resolved', 'cancelled', 'expired']);

function id(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function text(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function json(value, fallback = {}) {
  try {
    const encoded = JSON.stringify(value ?? fallback);
    return Buffer.byteLength(encoded, 'utf8') <= MAX_JSON_BYTES ? encoded : JSON.stringify(fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function positiveDurationFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveDuration(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isoAfter(timestamp, durationMs) {
  return new Date(new Date(timestamp).getTime() + durationMs).toISOString();
}

function invalid(message, code = 'ORCHESTRATION_INVALID') {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}

function conflict(message) {
  return Object.assign(new Error(message), { code: 'ORCHESTRATION_CONFLICT', statusCode: 409 });
}

function rowExecution(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    rootSessionId: row.root_session_id,
    kind: row.kind,
    state: row.state,
    specRevision: row.spec_revision,
    specDigest: row.spec_digest || '',
    spec: parseJson(row.spec_json, {}),
    checkpoint: parseJson(row.checkpoint_json, {}),
    nextWakeAt: row.next_wake_at || '',
    lastHeartbeatAt: row.last_heartbeat_at || '',
    blockedReason: row.blocked_reason || '',
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    executionId: row.execution_id,
    stableKey: row.stable_key,
    kind: row.kind,
    state: row.state,
    input: parseJson(row.input_json, {}),
    output: parseJson(row.output_json, {}),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowCommand(row) {
  if (!row) return null;
  return {
    id: row.id,
    executionId: row.execution_id,
    stepId: row.step_id || '',
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    payload: parseJson(row.payload_json, {}),
    state: row.state,
    claimToken: row.claim_token || '',
    leaseUntil: row.lease_until || '',
    nextAttemptAt: row.next_attempt_at || '',
    externalEffectId: row.external_effect_id || '',
    attemptCount: row.attempt_count,
    failureKind: row.failure_kind || '',
    failureReason: row.failure_reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowInterrupt(row) {
  if (!row) return null;
  return {
    id: row.id,
    executionId: row.execution_id,
    stableKey: row.stable_key,
    generation: row.generation,
    kind: row.kind,
    state: row.state,
    payload: parseJson(row.payload_json, {}),
    response: parseJson(row.response_json, null),
    deadlineAt: row.deadline_at || '',
    createdAt: row.created_at,
    resolvedAt: row.resolved_at || '',
    updatedAt: row.updated_at,
  };
}

function appendEvent(db, executionId, type, payload = {}) {
  db.prepare(`INSERT INTO orchestration_events (execution_id, type, payload_json, created_at)
    VALUES (?, ?, ?, ?)`)
    .run(executionId, text(type, 160), json(payload, {}), nowIso());
}

export function openDatabase() {
  const db = openCollaborationDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestration_executions (
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      root_session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      spec_revision INTEGER NOT NULL DEFAULT 1,
      spec_digest TEXT,
      spec_json TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL DEFAULT '{}',
      next_wake_at TEXT,
      last_heartbeat_at TEXT,
      blocked_reason TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope_kind, scope_id)
    );
    CREATE TABLE IF NOT EXISTS orchestration_steps (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES orchestration_executions(id) ON DELETE CASCADE,
      stable_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(execution_id, stable_key)
    );
    CREATE TABLE IF NOT EXISTS orchestration_commands (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES orchestration_executions(id) ON DELETE CASCADE,
      step_id TEXT REFERENCES orchestration_steps(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL,
      claim_token TEXT,
      lease_until TEXT,
      next_attempt_at TEXT NOT NULL,
      external_effect_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      failure_kind TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(execution_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS orchestration_interrupts (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES orchestration_executions(id) ON DELETE CASCADE,
      stable_key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      response_json TEXT,
      deadline_at TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(execution_id, stable_key, generation)
    );
    CREATE TABLE IF NOT EXISTS orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL REFERENCES orchestration_executions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orchestration_validations (
      id TEXT PRIMARY KEY,
      root_session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      dispatch_claimed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orchestration_executions_state ON orchestration_executions(state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_orchestration_commands_due ON orchestration_commands(state, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_orchestration_interrupts_open ON orchestration_interrupts(state, deadline_at);
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_execution ON orchestration_events(execution_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_orchestration_validations_expiry ON orchestration_validations(expires_at);
  `);
  return db;
}

async function withDatabase(fn, { mutate = false } = {}) {
  const run = async () => {
    const db = openDatabase();
    try { return await fn(db); } finally { db.close(); }
  };
  return mutate ? runMutation(run) : run();
}

export async function initializeOrchestrationStore() {
  return withDatabase(() => true, { mutate: true });
}

export async function ensureExecution({
  scopeKind,
  scopeId,
  rootSessionId,
  kind,
  state = 'running',
  specRevision = 1,
  specDigest = '',
  spec = {},
} = {}) {
  const normalized = {
    scopeKind: text(scopeKind, 120),
    scopeId: text(scopeId, 240),
    rootSessionId: text(rootSessionId, 240),
    kind: text(kind, 120),
    state: text(state, 80) || 'running',
  };
  if (!normalized.scopeKind || !normalized.scopeId || !normalized.rootSessionId || !normalized.kind) {
    throw invalid('scopeKind, scopeId, rootSessionId and kind are required');
  }
  return withDatabase((db) => {
    const timestamp = nowIso();
    const executionId = id('exec');
    db.exec('BEGIN IMMEDIATE');
    try {
      // The serial queue covers one control-plane process. BEGIN IMMEDIATE
      // also fences a second process during handoff/restart, so the unique
      // scope identity cannot surface as a transient constraint failure.
      const existing = db.prepare('SELECT * FROM orchestration_executions WHERE scope_kind = ? AND scope_id = ?')
        .get(normalized.scopeKind, normalized.scopeId);
      if (existing) {
        db.exec('COMMIT');
        return rowExecution(existing);
      }
      db.prepare(`INSERT INTO orchestration_executions
        (id, scope_kind, scope_id, root_session_id, kind, state, spec_revision, spec_digest, spec_json,
         checkpoint_json, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?)`)
        .run(executionId, normalized.scopeKind, normalized.scopeId, normalized.rootSessionId,
          normalized.kind, normalized.state,
          Number.isInteger(specRevision) && specRevision > 0 ? specRevision : 1,
          text(specDigest, 256), json(spec, {}), timestamp, timestamp);
      appendEvent(db, executionId, 'execution_created', {
        scopeKind: normalized.scopeKind,
        scopeId: normalized.scopeId,
        kind: normalized.kind,
        state: normalized.state,
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowExecution(db.prepare('SELECT * FROM orchestration_executions WHERE id = ?').get(executionId));
  }, { mutate: true });
}

export async function getExecution(executionId, { includeDetails = false, eventLimit = 128 } = {}) {
  const normalizedId = text(executionId, 240);
  if (!normalizedId) return null;
  return withDatabase((db) => {
    const execution = rowExecution(db.prepare('SELECT * FROM orchestration_executions WHERE id = ?').get(normalizedId));
    if (!execution || !includeDetails) return execution;
    const limit = Math.max(1, Math.min(Number.isInteger(eventLimit) ? eventLimit : 128, 512));
    return {
      ...execution,
      steps: db.prepare('SELECT * FROM orchestration_steps WHERE execution_id = ? ORDER BY created_at, id').all(normalizedId).map(rowStep),
      commands: db.prepare('SELECT * FROM orchestration_commands WHERE execution_id = ? ORDER BY created_at, id').all(normalizedId).map(rowCommand),
      interrupts: db.prepare('SELECT * FROM orchestration_interrupts WHERE execution_id = ? ORDER BY created_at, id').all(normalizedId).map(rowInterrupt),
      events: db.prepare('SELECT * FROM orchestration_events WHERE execution_id = ? ORDER BY sequence DESC LIMIT ?').all(normalizedId, limit)
        .reverse().map((row) => ({ sequence: row.sequence, type: row.type, payload: parseJson(row.payload_json, {}), createdAt: row.created_at })),
    };
  });
}

export async function getExecutionByScope(scopeKind, scopeId, options = {}) {
  const normalizedKind = text(scopeKind, 120);
  const normalizedId = text(scopeId, 240);
  if (!normalizedKind || !normalizedId) return null;
  const execution = await withDatabase((db) => rowExecution(db.prepare(
    'SELECT * FROM orchestration_executions WHERE scope_kind = ? AND scope_id = ?',
  ).get(normalizedKind, normalizedId)));
  return execution && options.includeDetails ? getExecution(execution.id, options) : execution;
}

// Synchronize a newer authoritative specification into an existing Execution.
// `ensureExecution` intentionally remains idempotent and therefore does not
// overwrite a row on replay; mirrors use this fenced operation when a
// collaboration or organization revision advances after the first checkpoint.
// Same-revision digest changes are rejected instead of silently mutating a
// frozen plan, which makes a stale writer visible to the reconciler.
export async function syncExecutionSpec(executionId, {
  specRevision,
  specDigest = '',
  spec = {},
  expectedVersion = null,
} = {}) {
  const normalizedId = text(executionId, 240);
  const revision = Number(specRevision);
  if (!normalizedId || !Number.isInteger(revision) || revision < 1) {
    throw invalid('executionId and a positive specRevision are required');
  }
  return withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM orchestration_executions WHERE id = ?').get(normalizedId);
      if (!current) {
        db.exec('COMMIT');
        return null;
      }
      if (expectedVersion !== null && expectedVersion !== undefined
        && Number(expectedVersion) !== Number(current.version)) {
        throw conflict(`Execution ${normalizedId} changed before its specification could be synchronized`);
      }
      const digestValue = text(specDigest, 256);
      if (revision < Number(current.spec_revision || 1)) {
        db.exec('COMMIT');
        return rowExecution(current);
      }
      if (revision === Number(current.spec_revision || 1)) {
        if (!digestValue || digestValue === (current.spec_digest || '')) {
          db.exec('COMMIT');
          return rowExecution(current);
        }
        // Rows created by the first ledger rollout may legitimately have an
        // empty digest. Fill that migration hole once at the same revision;
        // after a non-empty digest exists, a same-revision rewrite remains a
        // conflict and cannot silently replace a frozen plan.
        if (!current.spec_digest) {
          const changed = db.prepare(`UPDATE orchestration_executions
            SET spec_digest = ?, spec_json = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND version = ?`).run(
            digestValue,
            json(spec, {}),
            timestamp,
            normalizedId,
            current.version,
          ).changes;
          if (changed !== 1) throw conflict(`Execution ${normalizedId} specification compare-and-swap failed`);
          appendEvent(db, normalizedId, 'execution_spec_synchronized', {
            previousRevision: revision,
            specRevision: revision,
            specDigest: digestValue,
            migrationFill: true,
          });
          db.exec('COMMIT');
          return rowExecution(db.prepare('SELECT * FROM orchestration_executions WHERE id = ?').get(normalizedId));
        }
        throw conflict(`Execution ${normalizedId} received a different specification for revision ${revision}`);
      }
      const changed = db.prepare(`UPDATE orchestration_executions
        SET spec_revision = ?, spec_digest = ?, spec_json = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`).run(
        revision,
        digestValue,
        json(spec, {}),
        timestamp,
        normalizedId,
        current.version,
      ).changes;
      if (changed !== 1) throw conflict(`Execution ${normalizedId} specification compare-and-swap failed`);
      appendEvent(db, normalizedId, 'execution_spec_synchronized', {
        previousRevision: Number(current.spec_revision || 1),
        specRevision: revision,
        specDigest: digestValue,
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowExecution(db.prepare('SELECT * FROM orchestration_executions WHERE id = ?').get(normalizedId));
  }, { mutate: true });
}

export async function listExecutions({ rootSessionId = '', state = '', limit = 100 } = {}) {
  const root = text(rootSessionId, 240);
  const normalizedState = text(state, 80);
  const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 100, 500));
  return withDatabase((db) => db.prepare(`SELECT * FROM orchestration_executions
    WHERE (? = '' OR root_session_id = ?) AND (? = '' OR state = ?)
    ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(root, root, normalizedState, normalizedState, boundedLimit).map(rowExecution));
}

// A validation record binds a later dispatch to exactly the plan that passed
// policy/runtime/workspace checks. It is intentionally short-lived and holds
// no credential material; callers receive the digest for presentation/audit.
export async function createValidation({ rootSessionId, kind, payload, ttlMs = 10 * 60 * 1000 } = {}) {
  const root = text(rootSessionId, 240);
  const normalizedKind = text(kind, 120);
  if (!root || !normalizedKind || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalid('rootSessionId, kind and an object payload are required');
  }
  const timestamp = nowIso();
  const validationId = id('validation');
  const payloadDigest = digest(payload);
  const expiresAt = isoAfter(timestamp, positiveDuration(ttlMs, 10 * 60 * 1000));
  return withDatabase((db) => {
    db.prepare(`INSERT INTO orchestration_validations
      (id, root_session_id, kind, payload_digest, payload_json, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(validationId, root, normalizedKind, payloadDigest, json(payload, {}), expiresAt, timestamp, timestamp);
    return {
      validationId,
      rootSessionId: root,
      kind: normalizedKind,
      payloadDigest,
      expiresAt,
      payload,
    };
  }, { mutate: true });
}

export async function getValidation(validationId) {
  const normalizedId = text(validationId, 240);
  if (!normalizedId) return null;
  return withDatabase((db) => {
    const row = db.prepare('SELECT * FROM orchestration_validations WHERE id = ?').get(normalizedId);
    if (!row) return null;
    return {
      validationId: row.id,
      rootSessionId: row.root_session_id,
      kind: row.kind,
      payloadDigest: row.payload_digest,
      payload: parseJson(row.payload_json, {}),
      expiresAt: row.expires_at,
      dispatchClaimedAt: row.dispatch_claimed_at || '',
      expired: row.expires_at <= nowIso(),
    };
  });
}

export async function claimValidationForDispatch(validationId, { rootSessionId, kind } = {}) {
  const normalizedId = text(validationId, 240);
  const root = text(rootSessionId, 240);
  const normalizedKind = text(kind, 120);
  if (!normalizedId || !root || !normalizedKind) throw invalid('validationId, rootSessionId and kind are required');
  return withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM orchestration_validations WHERE id = ?').get(normalizedId);
      if (!row || row.root_session_id !== root || row.kind !== normalizedKind || row.expires_at <= timestamp) {
        db.exec('COMMIT');
        return null;
      }
      // Multiple transport retries must be allowed to redispatch the exact
      // same idempotent payload. The dispatch key remains derived from this
      // validation id; we only record the first claim timestamp.
      db.prepare(`UPDATE orchestration_validations
        SET dispatch_claimed_at = COALESCE(dispatch_claimed_at, ?), updated_at = ? WHERE id = ?`)
        .run(timestamp, timestamp, normalizedId);
      db.exec('COMMIT');
      return {
        validationId: row.id,
        rootSessionId: row.root_session_id,
        kind: row.kind,
        payloadDigest: row.payload_digest,
        payload: parseJson(row.payload_json, {}),
        expiresAt: row.expires_at,
        dispatchClaimedAt: row.dispatch_claimed_at || timestamp,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
}

export async function checkpointExecution(executionId, {
  state = '',
  checkpoint = undefined,
  nextWakeAt = undefined,
  blockedReason = undefined,
  expectedVersion = null,
  heartbeat = false,
  recordEvent = true,
  eventType = 'checkpoint_saved',
} = {}) {
  const normalizedId = text(executionId, 240);
  if (!normalizedId) return null;
  return withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM orchestration_executions WHERE id = ?').get(normalizedId);
      if (!current) {
        db.exec('COMMIT');
        return null;
      }
      if (expectedVersion !== null && expectedVersion !== undefined && Number(expectedVersion) !== Number(current.version)) {
        throw conflict(`Execution ${normalizedId} changed before checkpoint could be saved`);
      }
      const nextState = text(state, 80) || current.state;
      if (TERMINAL_EXECUTION_STATES.has(current.state) && nextState !== current.state) {
        throw conflict(`Terminal execution ${normalizedId} cannot return to ${nextState}`);
      }
      const checkpointJson = checkpoint === undefined ? current.checkpoint_json : json(checkpoint, {});
      const resolvedNextWakeAt = nextWakeAt === undefined ? current.next_wake_at : text(nextWakeAt, 80) || null;
      const resolvedBlockedReason = blockedReason === undefined ? current.blocked_reason : text(blockedReason, MAX_TEXT) || null;
      // A reconciler can observe the same durable fact many times. Do not turn
      // that into a write/event storm: only a caller-requested heartbeat is
      // allowed to refresh an otherwise identical row.
      const unchanged = nextState === current.state
        && canonicalJson(parseJson(checkpointJson, {})) === canonicalJson(parseJson(current.checkpoint_json, {}))
        && resolvedNextWakeAt === current.next_wake_at
        && resolvedBlockedReason === current.blocked_reason;
      if (unchanged && !heartbeat) {
        db.exec('COMMIT');
        return rowExecution(current);
      }
      const changed = db.prepare(`UPDATE orchestration_executions
        SET state = ?, checkpoint_json = ?, next_wake_at = ?, blocked_reason = ?,
            last_heartbeat_at = CASE WHEN ? THEN ? ELSE last_heartbeat_at END,
            version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`)
        .run(nextState,
          checkpointJson,
          resolvedNextWakeAt,
          resolvedBlockedReason,
          heartbeat ? 1 : 0, timestamp, timestamp, normalizedId, current.version).changes;
      if (changed !== 1) throw conflict(`Execution ${normalizedId} checkpoint compare-and-swap failed`);
      if (recordEvent) {
        appendEvent(db, normalizedId, eventType, {
          state: nextState,
          nextWakeAt: resolvedNextWakeAt || '',
          blockedReason: resolvedBlockedReason || '',
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowExecution(db.prepare('SELECT * FROM orchestration_executions WHERE id = ?').get(normalizedId));
  }, { mutate: true });
}

export async function ensureStep({ executionId, stableKey, kind, state = 'ready', input = {} } = {}) {
  const normalizedExecutionId = text(executionId, 240);
  const normalizedKey = text(stableKey, 240);
  const normalizedKind = text(kind, 120);
  if (!normalizedExecutionId || !normalizedKey || !normalizedKind) throw invalid('executionId, stableKey and kind are required');
  return withDatabase((db) => {
    const timestamp = nowIso();
    const stepId = id('step');
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT * FROM orchestration_steps WHERE execution_id = ? AND stable_key = ?')
        .get(normalizedExecutionId, normalizedKey);
      if (existing) {
        db.exec('COMMIT');
        return rowStep(existing);
      }
      const execution = db.prepare('SELECT id FROM orchestration_executions WHERE id = ?').get(normalizedExecutionId);
      if (!execution) throw invalid(`Execution not found: ${normalizedExecutionId}`, 'ORCHESTRATION_NOT_FOUND');
      db.prepare(`INSERT INTO orchestration_steps
        (id, execution_id, stable_key, kind, state, input_json, output_json, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '{}', 1, ?, ?)`)
        .run(stepId, normalizedExecutionId, normalizedKey, normalizedKind, text(state, 80) || 'ready', json(input, {}), timestamp, timestamp);
      appendEvent(db, normalizedExecutionId, 'step_created', { stepId, stableKey: normalizedKey, kind: normalizedKind });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowStep(db.prepare('SELECT * FROM orchestration_steps WHERE id = ?').get(stepId));
  }, { mutate: true });
}

export async function enqueueCommand({ executionId, stepId = '', kind, idempotencyKey, payload = {} } = {}) {
  const normalizedExecutionId = text(executionId, 240);
  const normalizedStepId = text(stepId, 240);
  const normalizedKind = text(kind, 120);
  const normalizedKey = text(idempotencyKey, 320);
  if (!normalizedExecutionId || !normalizedKind || !normalizedKey) throw invalid('executionId, kind and idempotencyKey are required');
  return withDatabase((db) => {
    const timestamp = nowIso();
    const commandId = id('ocmd');
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT * FROM orchestration_commands WHERE execution_id = ? AND idempotency_key = ?')
        .get(normalizedExecutionId, normalizedKey);
      if (existing) {
        db.exec('COMMIT');
        return rowCommand(existing);
      }
      const execution = db.prepare('SELECT state FROM orchestration_executions WHERE id = ?').get(normalizedExecutionId);
      if (!execution) throw invalid(`Execution not found: ${normalizedExecutionId}`, 'ORCHESTRATION_NOT_FOUND');
      if (TERMINAL_EXECUTION_STATES.has(execution.state)) throw conflict(`Cannot enqueue a command for terminal execution ${normalizedExecutionId}`);
      if (normalizedStepId && !db.prepare('SELECT id FROM orchestration_steps WHERE id = ? AND execution_id = ?').get(normalizedStepId, normalizedExecutionId)) {
        throw invalid(`Step ${normalizedStepId} is not part of execution ${normalizedExecutionId}`);
      }
      db.prepare(`INSERT INTO orchestration_commands
        (id, execution_id, step_id, kind, idempotency_key, payload_json, state, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(commandId, normalizedExecutionId, normalizedStepId || null, normalizedKind, normalizedKey,
          json(payload, {}), timestamp, timestamp, timestamp);
      appendEvent(db, normalizedExecutionId, 'command_enqueued', { commandId, stepId: normalizedStepId, kind: normalizedKind, idempotencyKey: normalizedKey });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowCommand(db.prepare('SELECT * FROM orchestration_commands WHERE id = ?').get(commandId));
  }, { mutate: true });
}

// Project a domain-owned side effect into this ledger without pretending that
// the generic worker executed it.  During migration, collaboration's durable
// dispatch outbox remains the effect authority; this helper only lets the
// common status/recovery surface observe a verified domain completion.  A
// live generic claim always wins, so a future command worker cannot be
// overwritten by a late mirror from an older domain snapshot.
export async function observeCommandState(commandId, {
  state = 'pending',
  externalEffectId = '',
  failureKind = '',
  failureReason = '',
} = {}) {
  const normalizedId = text(commandId, 240);
  const requestedState = text(state, 80) || 'pending';
  if (!normalizedId || !['pending', 'completed', 'cancelled', 'dead_letter'].includes(requestedState)) {
    throw invalid('commandId and a supported observed state are required');
  }
  return withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM orchestration_commands WHERE id = ?').get(normalizedId);
      if (!current) {
        db.exec('COMMIT');
        return null;
      }
      // Never trample a generic worker's fenced claim. Terminal rows are
      // immutable from an observational mirror as well.
      if (current.state === 'claimed' || TERMINAL_COMMAND_STATES.has(current.state)) {
        db.exec('COMMIT');
        return rowCommand(current);
      }
      if (requestedState === current.state
        && (requestedState === 'pending' || (externalEffectId || '') === (current.external_effect_id || ''))
        && (!failureReason || failureReason === (current.failure_reason || ''))) {
        db.exec('COMMIT');
        return rowCommand(current);
      }
      db.prepare(`UPDATE orchestration_commands
        SET state = ?, external_effect_id = ?, failure_kind = ?, failure_reason = ?,
            claim_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND state NOT IN ('claimed', 'completed', 'cancelled', 'dead_letter')`)
        .run(
          requestedState,
          text(externalEffectId, 320) || null,
          text(failureKind, 120) || null,
          text(failureReason, MAX_TEXT) || null,
          timestamp,
          normalizedId,
        );
      appendEvent(db, current.execution_id, 'command_observed', {
        commandId: normalizedId,
        state: requestedState,
        externalEffectId: text(externalEffectId, 320),
        source: 'domain_authority',
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowCommand(db.prepare('SELECT * FROM orchestration_commands WHERE id = ?').get(normalizedId));
  }, { mutate: true });
}

export async function claimDueCommands({ limit = 32, leaseMs = COMMAND_LEASE_MS, now = new Date() } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 32, 128));
  const timestamp = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : nowIso();
  const leaseUntil = isoAfter(timestamp, positiveDuration(leaseMs, COMMAND_LEASE_MS));
  return withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare(`SELECT c.* FROM orchestration_commands c
        JOIN orchestration_executions e ON e.id = c.execution_id
        WHERE e.state NOT IN ('completed', 'cancelled', 'dead_letter')
          AND (c.state IN ('pending', 'deferred') OR (c.state = 'claimed' AND c.lease_until <= ?))
          AND c.next_attempt_at <= ?
        ORDER BY c.next_attempt_at, c.created_at, c.id LIMIT ?`).all(timestamp, timestamp, boundedLimit);
      const claimed = [];
      for (const row of rows) {
        const token = id('claim');
        const changed = db.prepare(`UPDATE orchestration_commands
          SET state = 'claimed', claim_token = ?, lease_until = ?, attempt_count = attempt_count + 1, updated_at = ?
          WHERE id = ? AND (state IN ('pending', 'deferred') OR (state = 'claimed' AND lease_until <= ?))`)
          .run(token, leaseUntil, timestamp, row.id, timestamp).changes;
        if (changed !== 1) continue;
        appendEvent(db, row.execution_id, 'command_claimed', { commandId: row.id, leaseUntil });
        claimed.push(rowCommand(db.prepare('SELECT * FROM orchestration_commands WHERE id = ?').get(row.id)));
      }
      db.exec('COMMIT');
      return claimed;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
}

async function transitionClaimedCommand(commandId, claimToken, state, {
  externalEffectId = undefined,
  failureKind = undefined,
  failureReason = undefined,
  retryDelayMs = RETRY_DELAY_MS,
} = {}) {
  const normalizedCommandId = text(commandId, 240);
  const normalizedToken = text(claimToken, 240);
  if (!normalizedCommandId || !normalizedToken) return null;
  return withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const command = db.prepare('SELECT * FROM orchestration_commands WHERE id = ?').get(normalizedCommandId);
      const acceptedStates = state === 'completed' ? new Set(['claimed', 'acknowledged']) : new Set(['claimed']);
      if (!command || !acceptedStates.has(command.state) || command.claim_token !== normalizedToken) {
        db.exec('COMMIT');
        return null;
      }
      const nextAttemptAt = state === 'deferred'
        ? isoAfter(timestamp, positiveDuration(retryDelayMs, RETRY_DELAY_MS))
        : command.next_attempt_at;
      // An acknowledgement proves that an external system accepted the effect,
      // but the owner may still need to attach the final Result/Run. Keep the
      // fenced claim through that short acknowledgement-to-completion window.
      const keepClaim = state === 'acknowledged';
      db.prepare(`UPDATE orchestration_commands
        SET state = ?, claim_token = ?, lease_until = ?, next_attempt_at = ?, external_effect_id = ?,
          failure_kind = ?, failure_reason = ?, updated_at = ?
        WHERE id = ? AND state IN ('claimed', 'acknowledged') AND claim_token = ?`)
        .run(state, keepClaim ? command.claim_token : null, keepClaim ? command.lease_until : null, nextAttemptAt,
          externalEffectId === undefined ? command.external_effect_id : text(externalEffectId, 320) || null,
          failureKind === undefined ? command.failure_kind : text(failureKind, 120) || null,
          failureReason === undefined ? command.failure_reason : text(failureReason, MAX_TEXT) || null,
          timestamp, normalizedCommandId, normalizedToken);
      appendEvent(db, command.execution_id, `command_${state}`, {
        commandId: normalizedCommandId,
        externalEffectId: externalEffectId === undefined ? command.external_effect_id || '' : text(externalEffectId, 320),
        failureKind: failureKind === undefined ? command.failure_kind || '' : text(failureKind, 120),
      });
      db.exec('COMMIT');
      return rowCommand(db.prepare('SELECT * FROM orchestration_commands WHERE id = ?').get(normalizedCommandId));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
}

export async function acknowledgeCommand(commandId, options = {}) {
  return transitionClaimedCommand(commandId, options.claimToken, 'acknowledged', options);
}

export async function completeCommand(commandId, options = {}) {
  return transitionClaimedCommand(commandId, options.claimToken, 'completed', options);
}

export async function deferCommand(commandId, options = {}) {
  return transitionClaimedCommand(commandId, options.claimToken, 'deferred', options);
}

export async function deadLetterCommand(commandId, options = {}) {
  return transitionClaimedCommand(commandId, options.claimToken, 'dead_letter', options);
}

export async function openInterrupt({ executionId, stableKey, kind, payload = {}, deadlineAt = '' } = {}) {
  const normalizedExecutionId = text(executionId, 240);
  const normalizedKey = text(stableKey, 240);
  const normalizedKind = text(kind, 120);
  if (!normalizedExecutionId || !normalizedKey || !normalizedKind) throw invalid('executionId, stableKey and kind are required');
  return withDatabase((db) => {
    const interruptId = id('interrupt');
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const execution = db.prepare('SELECT * FROM orchestration_executions WHERE id = ?').get(normalizedExecutionId);
      if (!execution) throw invalid(`Execution not found: ${normalizedExecutionId}`, 'ORCHESTRATION_NOT_FOUND');
      if (TERMINAL_EXECUTION_STATES.has(execution.state)) throw conflict(`Cannot interrupt terminal execution ${normalizedExecutionId}`);
      const open = db.prepare(`SELECT * FROM orchestration_interrupts
        WHERE execution_id = ? AND stable_key = ? AND state = 'open' ORDER BY generation DESC LIMIT 1`)
        .get(normalizedExecutionId, normalizedKey);
      if (open) {
        db.exec('COMMIT');
        return rowInterrupt(open);
      }
      const previous = db.prepare(`SELECT MAX(generation) AS generation FROM orchestration_interrupts
        WHERE execution_id = ? AND stable_key = ?`).get(normalizedExecutionId, normalizedKey);
      const generation = Number(previous?.generation || 0) + 1;
      db.prepare(`INSERT INTO orchestration_interrupts
        (id, execution_id, stable_key, generation, kind, state, payload_json, deadline_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
        .run(interruptId, normalizedExecutionId, normalizedKey, generation, normalizedKind,
          json(payload, {}), text(deadlineAt, 80) || null, timestamp, timestamp);
      db.prepare(`UPDATE orchestration_executions SET state = 'waiting_input', blocked_reason = ?,
        next_wake_at = ?, version = version + 1, updated_at = ? WHERE id = ?`)
        .run(`${normalizedKind}:${normalizedKey}`, text(deadlineAt, 80) || null, timestamp, normalizedExecutionId);
      appendEvent(db, normalizedExecutionId, 'interrupt_opened', { interruptId, stableKey: normalizedKey, generation, kind: normalizedKind, deadlineAt: text(deadlineAt, 80) });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowInterrupt(db.prepare('SELECT * FROM orchestration_interrupts WHERE id = ?').get(interruptId));
  }, { mutate: true });
}

export async function resolveInterrupt(interruptId, { generation, response = {} } = {}) {
  const normalizedId = text(interruptId, 240);
  if (!normalizedId || !Number.isInteger(generation) || generation < 1) throw invalid('interruptId and generation are required');
  return withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const interrupt = db.prepare('SELECT * FROM orchestration_interrupts WHERE id = ?').get(normalizedId);
      if (!interrupt || interrupt.state !== 'open' || interrupt.generation !== generation) {
        db.exec('COMMIT');
        return null;
      }
      const changed = db.prepare(`UPDATE orchestration_interrupts
        SET state = 'resolved', response_json = ?, resolved_at = ?, updated_at = ?
        WHERE id = ? AND state = 'open' AND generation = ?`)
        .run(json(response, {}), timestamp, timestamp, normalizedId, generation).changes;
      if (changed !== 1) throw conflict(`Interrupt ${normalizedId} compare-and-swap failed`);
      const remaining = db.prepare(`SELECT COUNT(*) AS count FROM orchestration_interrupts
        WHERE execution_id = ? AND state = 'open'`).get(interrupt.execution_id);
      if (Number(remaining?.count || 0) === 0) {
        db.prepare(`UPDATE orchestration_executions SET state = 'running', blocked_reason = NULL, next_wake_at = NULL,
          version = version + 1, updated_at = ? WHERE id = ? AND state = 'waiting_input'`)
          .run(timestamp, interrupt.execution_id);
      }
      appendEvent(db, interrupt.execution_id, 'interrupt_resolved', { interruptId: normalizedId, generation });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowInterrupt(db.prepare('SELECT * FROM orchestration_interrupts WHERE id = ?').get(normalizedId));
  }, { mutate: true });
}

// A deadline is a policy fact, not evidence that downstream work succeeded.
// Expiry therefore never resumes or retries an Execution: it closes the
// stale wait and leaves a durable `blocked` checkpoint for an owner or a
// purpose-built recovery handler to decide the next safe action.
export async function expireDueInterrupts({ now = new Date(), limit = 100 } = {}) {
  const timestamp = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : nowIso();
  const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 100, 500));
  return withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const due = db.prepare(`SELECT * FROM orchestration_interrupts
        WHERE state = 'open' AND deadline_at IS NOT NULL AND deadline_at != '' AND deadline_at <= ?
        ORDER BY deadline_at, created_at, id LIMIT ?`).all(timestamp, boundedLimit);
      const expired = [];
      for (const interrupt of due) {
        const changed = db.prepare(`UPDATE orchestration_interrupts
          SET state = 'expired', updated_at = ?
          WHERE id = ? AND state = 'open' AND deadline_at <= ?`)
          .run(timestamp, interrupt.id, timestamp).changes;
        if (changed !== 1) continue;
        const remaining = db.prepare(`SELECT COUNT(*) AS count FROM orchestration_interrupts
          WHERE execution_id = ? AND state = 'open'`).get(interrupt.execution_id);
        if (Number(remaining?.count || 0) === 0) {
          db.prepare(`UPDATE orchestration_executions
            SET state = CASE WHEN state = 'waiting_input' THEN 'blocked' ELSE state END,
                blocked_reason = CASE WHEN state = 'waiting_input' THEN ? ELSE blocked_reason END,
                next_wake_at = CASE WHEN state = 'waiting_input' THEN NULL ELSE next_wake_at END,
                version = CASE WHEN state = 'waiting_input' THEN version + 1 ELSE version END,
                updated_at = ?
            WHERE id = ? AND state NOT IN ('completed', 'cancelled', 'dead_letter')`)
            .run(`interrupt_timeout:${interrupt.kind}:${interrupt.stable_key}`, timestamp, interrupt.execution_id);
        }
        appendEvent(db, interrupt.execution_id, 'interrupt_expired', {
          interruptId: interrupt.id,
          stableKey: interrupt.stable_key,
          generation: interrupt.generation,
          kind: interrupt.kind,
          deadlineAt: interrupt.deadline_at || '',
        });
        expired.push(rowInterrupt(db.prepare('SELECT * FROM orchestration_interrupts WHERE id = ?').get(interrupt.id)));
      }
      db.exec('COMMIT');
      return expired;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
}

export async function listStalledExecutions({ olderThanMs = 15 * 60 * 1000, now = new Date(), limit = 100 } = {}) {
  const cutoff = isoAfter(now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : nowIso(), -positiveDuration(olderThanMs, 15 * 60 * 1000));
  const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 100, 500));
  return withDatabase((db) => db.prepare(`SELECT * FROM orchestration_executions
    WHERE state NOT IN ('completed', 'cancelled', 'dead_letter', 'waiting_input')
      AND updated_at <= ? AND (next_wake_at IS NULL OR next_wake_at = '' OR next_wake_at <= ?)
    ORDER BY updated_at, id LIMIT ?`).all(cutoff, cutoff, boundedLimit).map(rowExecution));
}

export { TERMINAL_COMMAND_STATES, TERMINAL_EXECUTION_STATES, TERMINAL_INTERRUPT_STATES };
