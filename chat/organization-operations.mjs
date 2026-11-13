// S17 durable organization command journal.
//
// This journal deliberately lives in the Collaboration SQLite database. It
// records the saga boundary; handlers perform effects in their own stores and
// return an idempotent next step. No Session, Task, Run, or Envelope facts are
// created here.
import { randomBytes } from 'crypto';
import { withDatabase } from './collaboration-store.mjs';

export const ORGANIZATION_OPERATION_STATES = Object.freeze([
  'requested',
  'validated',
  'facts_created',
  'external_effect_created',
  'bound',
  'completed',
  'failed_retryable',
  'reconciled',
  'failed_terminal',
]);

const STATES = new Set(ORGANIZATION_OPERATION_STATES);
const TERMINAL_STATES = new Set(['completed', 'failed_terminal']);
const STATE_TRANSITIONS = Object.freeze({
  requested: new Set(['validated', 'failed_retryable', 'failed_terminal']),
  validated: new Set(['facts_created', 'failed_retryable', 'failed_terminal']),
  facts_created: new Set(['external_effect_created', 'failed_retryable', 'failed_terminal']),
  external_effect_created: new Set(['bound', 'failed_retryable', 'failed_terminal']),
  bound: new Set(['completed', 'failed_retryable', 'failed_terminal']),
  failed_retryable: new Set(['reconciled', 'failed_terminal']),
  reconciled: new Set(['validated', 'facts_created', 'external_effect_created', 'bound', 'completed', 'failed_retryable', 'failed_terminal']),
  completed: new Set(),
  failed_terminal: new Set(),
});

export const ORG_OPERATION_CONFLICT = 'ORG_OPERATION_CONFLICT';
export const ORG_OPERATION_NOT_FOUND = 'ORG_OPERATION_NOT_FOUND';

const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const COMMAND_KIND_RE = /^[A-Za-z][A-Za-z0-9_.-]{1,95}$/;

function error(code, message, statusCode = 409, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function id(prefix = 'op') {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function integer(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function json(value, fallback = null) {
  try {
    const encoded = JSON.stringify(value ?? fallback);
    return encoded === undefined ? JSON.stringify(fallback) : encoded;
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function nowIso() {
  return new Date().toISOString();
}

function assertState(state, label = 'state') {
  if (!STATES.has(state)) throw error(ORG_OPERATION_CONFLICT, `${label} is not a valid organization operation state`, 409, { state });
}

function assertIdentity(value, label) {
  const normalized = text(value);
  if (!normalized || normalized.length > 255) {
    throw error(ORG_OPERATION_CONFLICT, `${label} is required`, 409, { field: label });
  }
  return normalized;
}

function rowOperation(row) {
  if (!row) return null;
  return {
    operationId: row.operation_id,
    organizationId: row.organization_id,
    commandKind: row.command_kind,
    idempotencyKey: row.idempotency_key,
    actorNodeId: row.actor_node_id || '',
    actorSessionId: row.actor_session_id || '',
    revision: row.revision,
    version: row.version,
    generation: row.generation,
    state: row.state,
    currentStep: row.current_step,
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, null),
    error: parseJson(row.error_json, null),
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || '',
    completedAt: row.completed_at || '',
  };
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_operations (
      operation_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      command_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      actor_node_id TEXT,
      actor_session_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      generation INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      current_step TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(organization_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_org_operations_state
      ON organization_operations(organization_id, state, updated_at);
    CREATE INDEX IF NOT EXISTS idx_org_operations_actor
      ON organization_operations(organization_id, actor_node_id, created_at);
  `);
}

async function mutate(fn) {
  return withDatabase((db) => {
    ensureSchema(db);
    return fn(db);
  }, { mutate: true });
}

async function read(fn) {
  return withDatabase((db) => {
    ensureSchema(db);
    return fn(db);
  });
}

function validateCreateInput(input = {}) {
  const organizationId = assertIdentity(input.organizationId, 'organizationId');
  const commandKind = text(input.commandKind);
  if (!COMMAND_KIND_RE.test(commandKind)) {
    throw error(ORG_OPERATION_CONFLICT, 'commandKind must be a bounded structured command name', 409, { commandKind });
  }
  const idempotencyKey = assertIdentity(input.idempotencyKey, 'idempotencyKey');
  const operationId = text(input.operationId) || id('op');
  if (!OPERATION_ID_RE.test(operationId)) {
    throw error(ORG_OPERATION_CONFLICT, 'operationId has an invalid format', 409, { operationId });
  }
  const revision = integer(input.revision, 0);
  const version = integer(input.version, 1) || 1;
  const generation = integer(input.generation, 0);
  return {
    operationId,
    organizationId,
    commandKind,
    idempotencyKey,
    actorNodeId: text(input.actorNodeId),
    actorSessionId: text(input.actorSessionId),
    revision,
    version,
    generation,
    state: input.state || 'requested',
    currentStep: text(input.currentStep) || 'requested',
    payload: input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {},
  };
}

export async function initializeOrganizationOperations() {
  await mutate(() => true);
  return true;
}

export async function createOperation(input = {}) {
  const value = validateCreateInput(input);
  assertState(value.state);
  if (value.state !== 'requested') {
    throw error(ORG_OPERATION_CONFLICT, 'new organization operations must start in requested state');
  }
  return mutate((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const replay = db.prepare(`SELECT * FROM organization_operations
        WHERE organization_id = ? AND idempotency_key = ?`).get(value.organizationId, value.idempotencyKey);
      if (replay) {
        const same = replay.command_kind === value.commandKind
          && replay.actor_node_id === (value.actorNodeId || null)
          && replay.actor_session_id === (value.actorSessionId || null)
          && replay.revision === value.revision
          && replay.payload_json === json(value.payload, {});
        if (!same) throw error(ORG_OPERATION_CONFLICT, 'idempotency key already belongs to a different operation', 409, { operationId: replay.operation_id });
        db.exec('COMMIT');
        return rowOperation(replay);
      }
      const existingId = db.prepare('SELECT * FROM organization_operations WHERE operation_id = ?').get(value.operationId);
      if (existingId) throw error(ORG_OPERATION_CONFLICT, `operation ${value.operationId} already exists`, 409);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organizations'").get()) {
        const org = db.prepare('SELECT state FROM organizations WHERE id=?').get(value.organizationId);
        if (org && ['archived','lifecycle_pending'].includes(org.state)) throw error(ORG_OPERATION_CONFLICT, 'Organization lifecycle transition blocks new operations', 409);
      }
      db.prepare(`INSERT INTO organization_operations
        (operation_id, organization_id, command_kind, idempotency_key, actor_node_id, actor_session_id,
         revision, version, generation, state, current_step, payload_json, result_json, error_json,
         attempts, created_at, updated_at, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, NULL, NULL)`)
        .run(value.operationId, value.organizationId, value.commandKind, value.idempotencyKey,
          value.actorNodeId || null, value.actorSessionId || null, value.revision, value.version,
          value.generation, value.state, value.currentStep, json(value.payload, {}), timestamp, timestamp);
      db.exec('COMMIT');
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      if (String(cause?.message || '').includes('UNIQUE')) {
        throw error(ORG_OPERATION_CONFLICT, 'organization operation conflicts with an existing operation', 409, { cause });
      }
      throw cause;
    }
    return rowOperation(db.prepare('SELECT * FROM organization_operations WHERE operation_id = ?').get(value.operationId));
  });
}

export async function getOperation(operationId) {
  const idValue = text(operationId);
  if (!idValue) throw error(ORG_OPERATION_NOT_FOUND, 'operationId is required', 404);
  const result = await read((db) => rowOperation(db.prepare('SELECT * FROM organization_operations WHERE operation_id = ?').get(idValue)));
  if (!result) throw error(ORG_OPERATION_NOT_FOUND, `operation ${idValue} not found`, 404);
  return result;
}

export async function listOperations(organizationId, { states = [], limit = 200 } = {}) {
  const orgId = assertIdentity(organizationId, 'organizationId');
  const wanted = Array.isArray(states) ? states.filter((state) => STATES.has(state)) : [];
  const boundedLimit = Math.max(1, Math.min(1000, integer(limit, 200) || 200));
  return read((db) => {
    const rows = wanted.length > 0
      ? db.prepare(`SELECT * FROM organization_operations
          WHERE organization_id = ? AND state IN (${wanted.map(() => '?').join(',')})
          ORDER BY created_at, operation_id LIMIT ?`).all(orgId, ...wanted, boundedLimit)
      : db.prepare(`SELECT * FROM organization_operations
          WHERE organization_id = ? ORDER BY created_at, operation_id LIMIT ?`).all(orgId, boundedLimit);
    return rows.map(rowOperation);
  });
}

export async function transitionOperation(operationId, {
  expectedState,
  expectedVersion,
  expectedGeneration,
  nextState,
  currentStep,
  result,
  operationError,
  error: errorValue,
} = {}) {
  const idValue = text(operationId);
  assertState(nextState, 'nextState');
  return mutate((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT * FROM organization_operations WHERE operation_id = ?').get(idValue);
      if (!current) throw error(ORG_OPERATION_NOT_FOUND, `operation ${idValue} not found`, 404);
      if (expectedState !== undefined && current.state !== expectedState) {
        throw error(ORG_OPERATION_CONFLICT, `operation ${idValue} state changed`, 409, { actualState: current.state, expectedState });
      }
      if (expectedVersion !== undefined && Number(current.version) !== Number(expectedVersion)) {
        throw error(ORG_OPERATION_CONFLICT, `operation ${idValue} version changed`, 409, { actualVersion: current.version, expectedVersion });
      }
      if (expectedGeneration !== undefined && Number(current.generation) !== Number(expectedGeneration)) {
        throw error(ORG_OPERATION_CONFLICT, `operation ${idValue} generation changed`, 409, { actualGeneration: current.generation, expectedGeneration });
      }
      if (!STATE_TRANSITIONS[current.state]?.has(nextState)) {
        throw error(ORG_OPERATION_CONFLICT, `invalid operation transition ${current.state} -> ${nextState}`, 409);
      }
      const timestamp = nowIso();
      const nextVersion = Number(current.version) + 1;
      const nextGeneration = Number(current.generation) + 1;
      const final = TERMINAL_STATES.has(nextState);
      const updated = db.prepare(`UPDATE organization_operations SET
          version = ?, generation = ?, state = ?, current_step = ?,
          result_json = ?, error_json = ?, attempts = attempts + 1,
          updated_at = ?, started_at = COALESCE(started_at, ?), completed_at = ?
        WHERE operation_id = ? AND state = ? AND version = ? AND generation = ?`).run(
        nextVersion, nextGeneration, nextState, text(currentStep) || nextState,
        result === undefined ? current.result_json : json(result, null),
        (operationError ?? errorValue) === undefined ? current.error_json : json(operationError ?? errorValue, null),
        timestamp, timestamp, final ? timestamp : current.completed_at,
        idValue, current.state, current.version, current.generation);
      if (updated.changes !== 1) throw error(ORG_OPERATION_CONFLICT, `operation ${idValue} changed concurrently`, 409);
      db.exec('COMMIT');
      return rowOperation(db.prepare('SELECT * FROM organization_operations WHERE operation_id = ?').get(idValue));
    } catch (cause) {
      try { db.exec('ROLLBACK'); } catch {}
      throw cause;
    }
  });
}

function retryableError(cause) {
  return cause?.retryable === true || cause?.code === 'RETRYABLE' || cause?.code === 'ETIMEDOUT';
}

async function executeOperation(operationId, { stepHandlers = {}, maxSteps = 16 } = {}) {
  let operation = await getOperation(operationId);
  for (let index = 0; index < maxSteps && !TERMINAL_STATES.has(operation.state); index += 1) {
    if (operation.state === 'failed_retryable') {
      operation = await transitionOperation(operation.operationId, {
        expectedState: 'failed_retryable',
        expectedVersion: operation.version,
        expectedGeneration: operation.generation,
        nextState: 'reconciled',
        currentStep: operation.currentStep,
      });
      continue;
    }
    const handler = stepHandlers[operation.state] || stepHandlers[operation.currentStep];
    if (typeof handler !== 'function') break;
    try {
      const outcome = await handler(operation);
      if (!outcome || outcome.nextState === undefined) break;
      operation = await transitionOperation(operation.operationId, {
        expectedState: operation.state,
        expectedVersion: operation.version,
        expectedGeneration: operation.generation,
        nextState: outcome.nextState,
        currentStep: outcome.currentStep || outcome.nextState,
        result: outcome.result,
        operationError: outcome.error,
      });
    } catch (cause) {
      const failedState = retryableError(cause) ? 'failed_retryable' : 'failed_terminal';
      operation = await transitionOperation(operation.operationId, {
        expectedState: operation.state,
        expectedVersion: operation.version,
        expectedGeneration: operation.generation,
        nextState: failedState,
        currentStep: operation.currentStep,
        operationError: { code: cause?.code || 'ORG_OPERATION_FAILED', message: cause?.message || String(cause) },
      });
      if (failedState === 'failed_terminal') break;
    }
  }
  return operation;
}

export async function reconcileOperation(operationId, options = {}) {
  return executeOperation(operationId, options);
}

export async function reconcileOperations(organizationId, options = {}) {
  const operations = await listOperations(organizationId, {
    states: ['requested', 'validated', 'facts_created', 'external_effect_created', 'bound', 'failed_retryable', 'reconciled'],
    limit: options.limit,
  });
  const results = [];
  for (const operation of operations) results.push(await executeOperation(operation.operationId, options));
  return results;
}

export function isTerminalOperationState(state) {
  return TERMINAL_STATES.has(state);
}

export { STATES as ORGANIZATION_OPERATION_STATE_SET };
