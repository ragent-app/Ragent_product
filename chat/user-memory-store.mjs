import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase as openCollaborationDatabase, withDatabase as withCollaborationDatabase } from './collaboration-store.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';

export const USER_MEMORY_SOURCE_TYPES = Object.freeze([
  'user_rule',
  'tool_verified',
  'model_inferred',
  'external_untrusted',
]);

export const USER_MEMORY_STATUSES = Object.freeze([
  'active',
  'retracted',
  'superseded',
]);

export const USER_MEMORY_CATEGORIES = Object.freeze([
  'user_rule',
  'preference',
  'work_habit',
  'constraint',
]);

export const USER_MEMORY_SOURCE_PRIORITY = Object.freeze({
  user_rule: 3,
  tool_verified: 2,
  model_inferred: 1,
  external_untrusted: 0,
});

const SOURCE_TYPE_SET = new Set(USER_MEMORY_SOURCE_TYPES);
const STATUS_SET = new Set(USER_MEMORY_STATUSES);
const CATEGORY_SET = new Set(USER_MEMORY_CATEGORIES);
const UNTRUSTED_ORIGINS = new Set([
  'external_untrusted',
  'external',
  'web',
  'email',
  'repo',
  'repository',
  'webhook',
  'ci_log',
  'untrusted',
  'prompt_injection',
]);
const MODEL_ORIGINS = new Set([
  'model_inferred',
  'model',
  'llm',
  'assistant',
  'inferred',
]);
const CONFIDENCE_LABELS = Object.freeze({
  verified: 0.95,
  high: 0.9,
  reported: 0.65,
  medium: 0.65,
  tentative: 0.35,
  low: 0.35,
  untrusted: 0.1,
});
const DEFAULT_CONFIDENCE_BY_SOURCE = Object.freeze({
  user_rule: 1.0,
  tool_verified: 0.95,
  model_inferred: 0.6,
  external_untrusted: 0.15,
});

const USER_MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_memory_facts (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('user_rule','preference','work_habit','constraint')),
  fact_key TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('user_rule','tool_verified','model_inferred','external_untrusted')),
  source_ref TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('global','project','responsibility')),
  project_id TEXT NOT NULL DEFAULT '',
  responsibility_id TEXT NOT NULL DEFAULT '',
  scope_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL,
  valid_until TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','retracted','superseded')),
  version INTEGER NOT NULL DEFAULT 1,
  superseded_by_id TEXT,
  supersedes_fact_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_memory_facts_owner_scope
  ON user_memory_facts(owner_principal_id, status, scope_type, project_id, responsibility_id);
CREATE INDEX IF NOT EXISTS user_memory_facts_owner_key
  ON user_memory_facts(owner_principal_id, normalized_key, status);
CREATE TRIGGER IF NOT EXISTS user_memory_facts_no_delete
  BEFORE DELETE ON user_memory_facts
  BEGIN SELECT RAISE(ABORT, 'user memory facts cannot be deleted; retract or supersede instead'); END;

CREATE TABLE IF NOT EXISTS user_memory_fact_versions (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES user_memory_facts(id),
  owner_principal_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','revise','correct','retract','supersede','set_valid_until','keep')),
  category TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  responsibility_id TEXT NOT NULL DEFAULT '',
  scope_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL,
  valid_until TEXT,
  status TEXT NOT NULL,
  superseded_by_id TEXT,
  supersedes_fact_id TEXT,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(fact_id, version)
);
CREATE INDEX IF NOT EXISTS user_memory_fact_versions_lookup
  ON user_memory_fact_versions(owner_principal_id, fact_id, version);
CREATE TRIGGER IF NOT EXISTS user_memory_versions_no_update
  BEFORE UPDATE ON user_memory_fact_versions
  BEGIN SELECT RAISE(ABORT, 'immutable user memory audit history'); END;
CREATE TRIGGER IF NOT EXISTS user_memory_versions_no_delete
  BEFORE DELETE ON user_memory_fact_versions
  BEGIN SELECT RAISE(ABORT, 'immutable user memory audit history'); END;

CREATE TABLE IF NOT EXISTS user_memory_receipts (
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, operation, target_id, idempotency_key)
);
CREATE TRIGGER IF NOT EXISTS user_memory_receipts_no_update
  BEFORE UPDATE ON user_memory_receipts
  BEGIN SELECT RAISE(ABORT, 'immutable user memory receipt'); END;
CREATE TRIGGER IF NOT EXISTS user_memory_receipts_no_delete
  BEFORE DELETE ON user_memory_receipts
  BEGIN SELECT RAISE(ABORT, 'immutable user memory receipt'); END;
`;

function userMemoryError(message, statusCode = 400, code = 'USER_MEMORY_INVALID') {
  return Object.assign(new Error(message), { statusCode, code });
}

function text(value, max = 0) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return max > 0 ? normalized.slice(0, max) : normalized;
}

function requiredText(value, name, max = 160) {
  const normalized = text(value, max);
  if (!normalized) throw userMemoryError(`${name} is required`, 400, 'USER_MEMORY_INVALID');
  return normalized;
}

function nowIso(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function parseJson(raw, fallback = null) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeFactKey(value, category, factValue) {
  const raw = text(value, 160);
  if (raw) {
    return {
      factKey: raw,
      normalizedKey: raw.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' '),
    };
  }
  const derived = `user.${category}.${digest(factValue.normalize('NFKC').trim().toLowerCase()).slice(0, 16)}`;
  return { factKey: derived, normalizedKey: derived };
}

function normalizeScope(scopeInput, fallbackProjectId = '', fallbackResponsibilityId = '') {
  if (scopeInput === undefined || scopeInput === null || scopeInput === '') {
    return { type: 'global', projectId: null, responsibilityId: null };
  }
  if (typeof scopeInput === 'string') {
    const trimmed = scopeInput.trim();
    if (!trimmed || trimmed === 'global' || trimmed === 'user' || trimmed === 'cross_project') {
      return { type: 'global', projectId: null, responsibilityId: null };
    }
    if (trimmed.startsWith('project:')) {
      const projectId = text(trimmed.slice('project:'.length), 160);
      if (!projectId) throw userMemoryError('Project scope requires a projectId', 400, 'USER_MEMORY_INVALID');
      return { type: 'project', projectId, responsibilityId: null };
    }
    if (trimmed.startsWith('responsibility:')) {
      const responsibilityId = text(trimmed.slice('responsibility:'.length), 160);
      if (!responsibilityId) throw userMemoryError('Responsibility scope requires a responsibilityId', 400, 'USER_MEMORY_INVALID');
      return {
        type: 'responsibility',
        projectId: text(fallbackProjectId, 160) || null,
        responsibilityId,
      };
    }
    throw userMemoryError(`Invalid user memory scope '${trimmed}'`, 400, 'USER_MEMORY_INVALID');
  }
  if (typeof scopeInput === 'object' && !Array.isArray(scopeInput)) {
    const inferredType = scopeInput.type || scopeInput.kind
      || (scopeInput.responsibilityId ? 'responsibility' : scopeInput.projectId ? 'project' : 'global');
    const type = text(inferredType, 40);
    if (!['global', 'project', 'responsibility'].includes(type)) {
      throw userMemoryError(`Invalid user memory scope type '${type}'`, 400, 'USER_MEMORY_INVALID');
    }
    if (type === 'global') return { type: 'global', projectId: null, responsibilityId: null };
    const projectId = text(scopeInput.projectId ?? fallbackProjectId, 160) || null;
    if (type === 'project') {
      if (!projectId) throw userMemoryError('Project scope requires projectId', 400, 'USER_MEMORY_INVALID');
      return { type: 'project', projectId, responsibilityId: null };
    }
    const responsibilityId = text(scopeInput.responsibilityId ?? fallbackResponsibilityId, 160) || null;
    if (!responsibilityId) throw userMemoryError('Responsibility scope requires responsibilityId', 400, 'USER_MEMORY_INVALID');
    return { type: 'responsibility', projectId, responsibilityId };
  }
  throw userMemoryError('Invalid user memory scope', 400, 'USER_MEMORY_INVALID');
}

function normalizeConfidence(value, sourceType) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_CONFIDENCE_BY_SOURCE[sourceType] ?? 0.5;
  }
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(CONFIDENCE_LABELS, lower)) {
      return CONFIDENCE_LABELS[lower];
    }
    const parsed = Number(lower);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
    throw userMemoryError(`Invalid confidence value '${value}'`, 400, 'USER_MEMORY_INVALID');
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value;
  }
  throw userMemoryError('confidence must be between 0 and 1', 400, 'USER_MEMORY_INVALID');
}

function normalizeValidUntil(value) {
  if (value === undefined || value === null || value === '') return null;
  const trimmed = text(value, 80);
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw userMemoryError('Invalid validUntil timestamp', 400, 'USER_MEMORY_INVALID');
  }
  return new Date(parsed).toISOString();
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw userMemoryError('metadata must be a plain object', 400, 'USER_MEMORY_INVALID');
  }
  return value;
}

function resolveOwnerPrincipal(input, actor) {
  const ownerId = text(input?.ownerPrincipalId, 160) || text(actor?.principalId, 160);
  if (!ownerId) {
    throw userMemoryError('ownerPrincipalId is required', 400, 'USER_MEMORY_INVALID');
  }
  if (actor?.principalId && text(actor.principalId, 160) !== ownerId) {
    throw userMemoryError('Actor principal does not match ownerPrincipalId', 403, 'USER_MEMORY_FORBIDDEN');
  }
  return ownerId;
}

function normalizeSourceType(value, fallback = '') {
  const candidate = text(value || fallback, 60);
  if (!SOURCE_TYPE_SET.has(candidate)) {
    throw userMemoryError(
      `sourceType must be one of ${USER_MEMORY_SOURCE_TYPES.join(', ')}`,
      400,
      'USER_MEMORY_INVALID',
    );
  }
  return candidate;
}

function normalizeCategory(value, sourceType, fallback = '') {
  const candidate = text(value || fallback || (sourceType === 'user_rule' ? 'user_rule' : 'preference'), 60);
  if (!CATEGORY_SET.has(candidate)) {
    throw userMemoryError(
      `category must be one of ${USER_MEMORY_CATEGORIES.join(', ')}`,
      400,
      'USER_MEMORY_INVALID',
    );
  }
  return candidate;
}

function isUserRuleRecord(record) {
  return Boolean(record && (record.sourceType === 'user_rule' || record.source_type === 'user_rule' || record.category === 'user_rule'));
}

function isActiveRecord(record) {
  return Boolean(record && (record.status === 'active'));
}

/**
 * Deterministic hard source-isolation guard for all User Memory writes.
 * Rejects attempts by untrusted external content to create/modify `user_rule`,
 * and prevents `model_inferred` or `tool_verified` from overwriting/superseding
 * an active `user_rule`.
 */
export function validateUserMemoryWrite(input = {}, existingFact = null, actor = null) {
  const operation = text(input?.operation || (existingFact ? 'update' : 'create'), 40);
  const incomingSourceType = input?.sourceType !== undefined && input?.sourceType !== ''
    ? normalizeSourceType(input.sourceType)
    : (existingFact ? existingFact.sourceType : normalizeSourceType(input?.sourceType));
  const incomingCategory = input?.category !== undefined && input?.category !== ''
    ? normalizeCategory(input.category, incomingSourceType)
    : (existingFact ? existingFact.category : normalizeCategory(input?.category, incomingSourceType));

  const origin = text(
    input?.originType || input?.provenanceKind || input?.sourceKind || '',
    80,
  ).toLowerCase();
  const sourceRef = text(input?.sourceRef, 500);
  const isUntrustedOrigin = incomingSourceType === 'external_untrusted'
    || UNTRUSTED_ORIGINS.has(origin)
    || input?.untrusted === true
    || /^(?:external_untrusted|untrusted):/i.test(sourceRef);
  const isModelOrigin = incomingSourceType === 'model_inferred'
    || MODEL_ORIGINS.has(origin)
    || /^model_inferred:/i.test(sourceRef);

  if (isUntrustedOrigin && (incomingSourceType === 'user_rule' || incomingCategory === 'user_rule')) {
    throw userMemoryError(
      'External untrusted content is forbidden from creating or promoting a user_rule',
      403,
      'USER_MEMORY_SOURCE_ISOLATION',
    );
  }

  if (isModelOrigin && (incomingSourceType === 'user_rule' || incomingCategory === 'user_rule')) {
    throw userMemoryError(
      'Model-inferred content is forbidden from creating or promoting a user_rule',
      403,
      'USER_MEMORY_SOURCE_ISOLATION',
    );
  }

  if (incomingSourceType === 'tool_verified' && incomingCategory === 'user_rule') {
    throw userMemoryError(
      'Tool-verified records cannot self-assign category user_rule; only explicit user_rule sources qualify',
      403,
      'USER_MEMORY_SOURCE_ISOLATION',
    );
  }

  if (actor && (incomingSourceType === 'user_rule' || incomingCategory === 'user_rule')) {
    if (actor.kind !== 'user' || actor.role !== 'owner') {
      throw userMemoryError(
        'Only an authenticated owner user may create or modify a user_rule',
        403,
        'USER_MEMORY_SOURCE_ISOLATION',
      );
    }
  }

  if (existingFact) {
    if (isUntrustedOrigin) {
      throw userMemoryError(
        `External untrusted content cannot ${operation} existing user memory fact '${existingFact.id}'`,
        403,
        'USER_MEMORY_SOURCE_ISOLATION',
      );
    }
    if (isUserRuleRecord(existingFact) && isActiveRecord(existingFact)) {
      const effectiveSource = input?.sourceType !== undefined && input?.sourceType !== ''
        ? incomingSourceType
        : '';
      if (isModelOrigin || (effectiveSource && effectiveSource !== 'user_rule')) {
        throw userMemoryError(
          `Source '${effectiveSource || origin || 'non-user'}' cannot overwrite, retract, or supersede active user_rule '${existingFact.id}'`,
          403,
          'USER_MEMORY_SOURCE_ISOLATION',
        );
      }
      if (actor && (actor.kind !== 'user' || actor.role !== 'owner')) {
        throw userMemoryError(
          `Non-owner actor cannot modify active user_rule '${existingFact.id}'`,
          403,
          'USER_MEMORY_SOURCE_ISOLATION',
        );
      }
    }
  }

  return {
    sourceType: incomingSourceType,
    category: incomingCategory,
    isUntrustedOrigin,
    isModelOrigin,
  };
}

function rowToFact(row) {
  if (!row) return null;
  const scope = parseJson(row.scope_json, null) || {
    type: row.scope_type,
    projectId: row.project_id || null,
    responsibilityId: row.responsibility_id || null,
  };
  return {
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    category: row.category,
    factKey: row.fact_key,
    normalizedKey: row.normalized_key,
    factValue: row.fact_value,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    scope,
    confidence: Number(row.confidence),
    validUntil: row.valid_until || null,
    status: row.status,
    version: Number(row.version),
    supersededById: row.superseded_by_id || null,
    supersedesFactId: row.supersedes_fact_id || null,
    metadata: parseJson(row.metadata_json, {}),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row) {
  if (!row) return null;
  const scope = parseJson(row.scope_json, null) || {
    type: row.scope_type,
    projectId: row.project_id || null,
    responsibilityId: row.responsibility_id || null,
  };
  return {
    id: row.id,
    factId: row.fact_id,
    ownerPrincipalId: row.owner_principal_id,
    version: Number(row.version),
    action: row.action,
    category: row.category,
    factKey: row.fact_key,
    normalizedKey: row.normalized_key,
    factValue: row.fact_value,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    scope,
    confidence: Number(row.confidence),
    validUntil: row.valid_until || null,
    status: row.status,
    supersededById: row.superseded_by_id || null,
    supersedesFactId: row.supersedes_fact_id || null,
    actorId: row.actor_id,
    reason: row.reason || '',
    idempotencyKey: row.idempotency_key || null,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function appendAuditVersion(db, {
  fact,
  action,
  actorId,
  reason = '',
  idempotencyKey = null,
  createdAt,
}) {
  db.prepare(`
    INSERT INTO user_memory_fact_versions (
      id, fact_id, owner_principal_id, version, action, category, fact_key, normalized_key,
      fact_value, source_type, source_ref, scope_type, project_id, responsibility_id, scope_json,
      confidence, valid_until, status, superseded_by_id, supersedes_fact_id, actor_id, reason,
      idempotency_key, metadata_json, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    newId('umv'),
    fact.id,
    fact.ownerPrincipalId,
    fact.version,
    action,
    fact.category,
    fact.factKey,
    fact.normalizedKey,
    fact.factValue,
    fact.sourceType,
    fact.sourceRef,
    fact.scope.type,
    fact.scope.projectId || '',
    fact.scope.responsibilityId || '',
    JSON.stringify(fact.scope),
    fact.confidence,
    fact.validUntil,
    fact.status,
    fact.supersededById,
    fact.supersedesFactId,
    actorId,
    text(reason, 500),
    idempotencyKey ? text(idempotencyKey, 160) : null,
    JSON.stringify(fact.metadata || {}),
    createdAt,
  );
}

function withReceipt(db, actorId, operation, targetId, idempotencyKey, payload, createdAt, fn) {
  const hash = digest(payload);
  const prior = db.prepare(`
    SELECT * FROM user_memory_receipts
    WHERE actor_id = ? AND operation = ? AND target_id = ? AND idempotency_key = ?
  `).get(actorId, operation, targetId, idempotencyKey);
  if (prior) {
    if (prior.payload_digest !== hash) {
      throw userMemoryError('Idempotency key reused with different user memory payload', 409, 'USER_MEMORY_CONFLICT');
    }
    return { ...JSON.parse(prior.result_json), replayed: true };
  }
  const result = fn();
  db.prepare(`
    INSERT INTO user_memory_receipts (actor_id, operation, target_id, idempotency_key, payload_digest, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(actorId, operation, targetId, idempotencyKey, hash, JSON.stringify(result), createdAt);
  return { ...result, replayed: false };
}

function tokenizeKeywords(input) {
  const list = Array.isArray(input) ? input : [input];
  const tokens = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const cleaned = entry.trim().toLowerCase();
    if (!cleaned) continue;
    for (const part of cleaned.split(/[\s,;|]+/)) {
      if (part.length >= 2) tokens.push(part);
    }
  }
  return [...new Set(tokens)].slice(0, 40);
}

function matchesKeywords(fact, keywords) {
  if (!keywords.length) return true;
  const haystack = `${fact.factKey} ${fact.factValue} ${fact.category}`.toLowerCase();
  return keywords.some((kw) => haystack.includes(kw));
}

export function ensureUserMemorySchema(db) {
  const ready = db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE (type = 'table' AND name IN ('user_memory_facts', 'user_memory_fact_versions', 'user_memory_receipts'))
       OR (type = 'trigger' AND name IN ('user_memory_facts_no_delete', 'user_memory_versions_no_update', 'user_memory_versions_no_delete', 'user_memory_receipts_no_update', 'user_memory_receipts_no_delete'))
  `).get();
  if (Number(ready?.count || 0) === 8) return;
  db.exec(USER_MEMORY_SCHEMA);
}

/**
 * Create a SQLite-backed User Memory store instance.
 * Defaults to the shared Ragent collaboration SQLite database when `databasePath`
 * is omitted, or opens an isolated SQLite database at `databasePath` for tests.
 */
export function createUserMemoryStore(options = {}) {
  const databasePath = text(options.databasePath, 2000);
  const mutationQueue = createSerialTaskQueue();

  async function withStoreDb(fn, { mutate = false, db: explicitDb = null } = {}) {
    if (explicitDb) {
      ensureUserMemorySchema(explicitDb);
      return fn(explicitDb);
    }
    if (!databasePath) {
      return withCollaborationDatabase((db) => {
        ensureUserMemorySchema(db);
        if (!mutate) return fn(db);
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = fn(db);
          if (result && typeof result.then === 'function') {
            throw userMemoryError('Async work is forbidden inside a user memory transaction', 500, 'USER_MEMORY_INVALID');
          }
          db.exec('COMMIT');
          return result;
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }, { mutate });
    }
    const run = async () => {
      mkdirSync(dirname(databasePath), { recursive: true });
      const db = new DatabaseSync(databasePath, { timeout: 10_000 });
      try {
        db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
        ensureUserMemorySchema(db);
        if (!mutate) return fn(db);
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = fn(db);
          if (result && typeof result.then === 'function') {
            throw userMemoryError('Async work is forbidden inside a user memory transaction', 500, 'USER_MEMORY_INVALID');
          }
          db.exec('COMMIT');
          return result;
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      } finally {
        db.close();
      }
    };
    return mutate ? mutationQueue(run) : run();
  }

  function fetchOwnedFactSync(db, factId, ownerPrincipalId) {
    const row = db.prepare(`
      SELECT * FROM user_memory_facts WHERE id = ? AND owner_principal_id = ?
    `).get(requiredText(factId, 'factId', 120), requiredText(ownerPrincipalId, 'ownerPrincipalId', 160));
    return rowToFact(row);
  }

  function insertFactSync(db, params, actorId, ts) {
    const id = params.factId || newId('umf');
    const existingById = db.prepare('SELECT id FROM user_memory_facts WHERE id = ?').get(id);
    if (existingById) {
      throw userMemoryError(`User memory fact '${id}' already exists`, 409, 'USER_MEMORY_CONFLICT');
    }
    const fact = {
      id,
      ownerPrincipalId: params.ownerPrincipalId,
      category: params.category,
      factKey: params.factKey,
      normalizedKey: params.normalizedKey,
      factValue: params.factValue,
      sourceType: params.sourceType,
      sourceRef: params.sourceRef,
      scope: params.scope,
      confidence: params.confidence,
      validUntil: params.validUntil,
      status: 'active',
      version: 1,
      supersededById: null,
      supersedesFactId: params.supersedesFactId || null,
      metadata: params.metadata,
      createdBy: actorId,
      updatedBy: actorId,
      createdAt: ts,
      updatedAt: ts,
    };
    db.prepare(`
      INSERT INTO user_memory_facts (
        id, owner_principal_id, category, fact_key, normalized_key, fact_value,
        source_type, source_ref, scope_type, project_id, responsibility_id, scope_json,
        confidence, valid_until, status, version, superseded_by_id, supersedes_fact_id,
        metadata_json, created_by, updated_by, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      fact.id,
      fact.ownerPrincipalId,
      fact.category,
      fact.factKey,
      fact.normalizedKey,
      fact.factValue,
      fact.sourceType,
      fact.sourceRef,
      fact.scope.type,
      fact.scope.projectId || '',
      fact.scope.responsibilityId || '',
      JSON.stringify(fact.scope),
      fact.confidence,
      fact.validUntil,
      fact.status,
      fact.version,
      fact.supersededById,
      fact.supersedesFactId,
      JSON.stringify(fact.metadata),
      fact.createdBy,
      fact.updatedBy,
      fact.createdAt,
      fact.updatedAt,
    );
    appendAuditVersion(db, {
      fact,
      action: 'create',
      actorId,
      reason: params.reason,
      idempotencyKey: params.idempotencyKey,
      createdAt: ts,
    });
    return fact;
  }

  function applySupersedeSync(db, targetFact, newFactId, actorId, reason, idempotencyKey, ts) {
    const nextVersion = targetFact.version + 1;
    const res = db.prepare(`
      UPDATE user_memory_facts
      SET status = 'superseded',
          superseded_by_id = ?,
          version = ?,
          updated_by = ?,
          updated_at = ?
      WHERE id = ? AND owner_principal_id = ? AND version = ? AND status = 'active'
    `).run(
      newFactId,
      nextVersion,
      actorId,
      ts,
      targetFact.id,
      targetFact.ownerPrincipalId,
      targetFact.version,
    );
    if (res.changes !== 1) {
      throw userMemoryError('User memory fact version changed concurrently', 409, 'USER_MEMORY_VERSION_CONFLICT');
    }
    const updated = fetchOwnedFactSync(db, targetFact.id, targetFact.ownerPrincipalId);
    appendAuditVersion(db, {
      fact: updated,
      action: 'supersede',
      actorId,
      reason,
      idempotencyKey,
      createdAt: ts,
    });
    return updated;
  }

  function parseCreateParams(input, actor) {
    const ownerPrincipalId = resolveOwnerPrincipal(input, actor);
    const idempotencyKey = requiredText(input?.idempotencyKey, 'idempotencyKey', 160);
    const sourceType = normalizeSourceType(input?.sourceType);
    const category = normalizeCategory(input?.category, sourceType);
    const factValue = requiredText(input?.factValue ?? input?.value ?? input?.statement ?? input?.content, 'factValue', 2000);
    const sourceRef = requiredText(input?.sourceRef, 'sourceRef', 500);
    const { factKey, normalizedKey } = normalizeFactKey(input?.factKey ?? input?.key, category, factValue);
    const scope = normalizeScope(input?.scope, input?.projectId, input?.responsibilityId);
    const confidence = normalizeConfidence(input?.confidence, sourceType);
    const validUntil = normalizeValidUntil(input?.validUntil);
    const metadata = normalizeMetadata(input?.metadata);
    const factId = text(input?.factId ?? input?.id, 120) || '';
    const supersedesFactId = text(input?.supersedesFactId, 120) || '';
    const reason = text(input?.reason, 500);
    return {
      ownerPrincipalId,
      idempotencyKey,
      sourceType,
      category,
      factKey,
      normalizedKey,
      factValue,
      sourceRef,
      scope,
      confidence,
      validUntil,
      metadata,
      factId,
      supersedesFactId,
      reason,
      originType: input?.originType,
      provenanceKind: input?.provenanceKind,
      sourceKind: input?.sourceKind,
      untrusted: input?.untrusted,
    };
  }

  async function listUserMemoryFacts(query = {}, opts = {}) {
    const ownerPrincipalId = resolveOwnerPrincipal(query, opts.actor);
    const limit = Math.max(1, Math.min(Number(query?.limit) || 100, 500));
    const currentIso = nowIso(opts.now ?? query?.now ?? new Date());
    const includeExpired = query?.includeExpired === true;
    const includeUntrusted = query?.includeUntrusted !== false;
    const exactScopeOnly = query?.exactScopeOnly === true;
    const projectId = text(query?.projectId, 160);
    const responsibilityId = text(query?.responsibilityId, 160);
    const scopeType = text(query?.scopeType, 40);
    const category = text(query?.category, 60);
    const normalizedKey = text(query?.normalizedKey || query?.factKey || query?.key, 160)
      .normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
    const statuses = Array.isArray(query?.statuses) && query.statuses.length
      ? query.statuses.map((s) => text(s, 40)).filter((s) => STATUS_SET.has(s))
      : (text(query?.status, 40) ? [text(query.status, 40)] : []);
    const sourceTypes = Array.isArray(query?.sourceTypes) && query.sourceTypes.length
      ? query.sourceTypes.map((s) => text(s, 60)).filter((s) => SOURCE_TYPE_SET.has(s))
      : (text(query?.sourceType, 60) ? [text(query.sourceType, 60)] : []);
    const keywords = tokenizeKeywords(query?.keywords);

    return withStoreDb((db) => {
      const clauses = ['owner_principal_id = ?'];
      const params = [ownerPrincipalId];

      if (statuses.length) {
        clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
      if (sourceTypes.length) {
        clauses.push(`source_type IN (${sourceTypes.map(() => '?').join(',')})`);
        params.push(...sourceTypes);
      }
      if (!includeUntrusted) {
        clauses.push("source_type <> 'external_untrusted'");
      }
      if (category && CATEGORY_SET.has(category)) {
        clauses.push('category = ?');
        params.push(category);
      }
      if (normalizedKey) {
        clauses.push('normalized_key = ?');
        params.push(normalizedKey);
      }
      if (!includeExpired) {
        clauses.push('(valid_until IS NULL OR valid_until > ?)');
        params.push(currentIso);
      }

      if (scopeType) {
        if (!['global', 'project', 'responsibility'].includes(scopeType)) {
          throw userMemoryError(`Invalid scopeType '${scopeType}'`, 400, 'USER_MEMORY_INVALID');
        }
        clauses.push('scope_type = ?');
        params.push(scopeType);
        if (scopeType === 'project' && projectId) {
          clauses.push('project_id = ?');
          params.push(projectId);
        }
        if (scopeType === 'responsibility' && responsibilityId) {
          clauses.push('responsibility_id = ?');
          params.push(responsibilityId);
        }
      } else if (projectId || responsibilityId) {
        if (exactScopeOnly) {
          if (responsibilityId) {
            clauses.push("scope_type = 'responsibility' AND responsibility_id = ?");
            params.push(responsibilityId);
            if (projectId) {
              clauses.push("(project_id = '' OR project_id = ?)");
              params.push(projectId);
            }
          } else {
            clauses.push("scope_type = 'project' AND project_id = ?");
            params.push(projectId);
          }
        } else if (projectId && responsibilityId) {
          clauses.push(
            "(scope_type = 'global' OR (scope_type = 'project' AND project_id = ?) OR (scope_type = 'responsibility' AND responsibility_id = ? AND (project_id = '' OR project_id = ?)))",
          );
          params.push(projectId, responsibilityId, projectId);
        } else if (projectId) {
          clauses.push("(scope_type = 'global' OR (scope_type = 'project' AND project_id = ?))");
          params.push(projectId);
        } else {
          clauses.push("(scope_type = 'global' OR (scope_type = 'responsibility' AND responsibility_id = ?))");
          params.push(responsibilityId);
        }
      }

      const rows = db.prepare(`
        SELECT * FROM user_memory_facts
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC, id ASC
      `).all(...params).map(rowToFact);

      const filtered = keywords.length ? rows.filter((fact) => matchesKeywords(fact, keywords)) : rows;
      return {
        schemaVersion: 1,
        facts: filtered.slice(0, limit),
        total: filtered.length,
        truncated: filtered.length > limit,
      };
    }, { db: opts.db });
  }

  async function getUserMemoryFact(factId, opts = {}) {
    const ownerPrincipalId = resolveOwnerPrincipal(opts, opts.actor);
    const id = requiredText(factId, 'factId', 120);
    return withStoreDb((db) => {
      const fact = fetchOwnedFactSync(db, id, ownerPrincipalId);
      if (!fact) return { schemaVersion: 1, fact: null, history: [] };
      const history = opts.includeHistory
        ? db.prepare(`
            SELECT * FROM user_memory_fact_versions
            WHERE fact_id = ? AND owner_principal_id = ?
            ORDER BY version ASC
          `).all(id, ownerPrincipalId).map(rowToVersion)
        : [];
      return { schemaVersion: 1, fact, history };
    }, { db: opts.db });
  }

  async function getUserMemoryHistory(factId, opts = {}) {
    const ownerPrincipalId = resolveOwnerPrincipal(opts, opts.actor);
    const id = requiredText(factId, 'factId', 120);
    return withStoreDb((db) => {
      const fact = fetchOwnedFactSync(db, id, ownerPrincipalId);
      if (!fact) return { schemaVersion: 1, factId: id, history: [] };
      const history = db.prepare(`
        SELECT * FROM user_memory_fact_versions
        WHERE fact_id = ? AND owner_principal_id = ?
        ORDER BY version ASC
      `).all(id, ownerPrincipalId).map(rowToVersion);
      return { schemaVersion: 1, factId: id, history };
    }, { db: opts.db });
  }

  async function createUserMemoryFact(input, opts = {}) {
    const actor = opts.actor || null;
    const params = parseCreateParams(input, actor);
    const ts = nowIso(opts.now);
    const actorId = text(actor?.principalId, 160) || params.ownerPrincipalId;

    return withStoreDb((db) => {
      const targetKey = params.factId || 'create';
      const receiptPayload = {
        op: 'create',
        ownerPrincipalId: params.ownerPrincipalId,
        factId: params.factId || null,
        category: params.category,
        factKey: params.factKey,
        factValue: params.factValue,
        sourceType: params.sourceType,
        sourceRef: params.sourceRef,
        scope: params.scope,
        confidence: params.confidence,
        validUntil: params.validUntil,
        supersedesFactId: params.supersedesFactId || null,
        metadata: params.metadata,
      };
      return withReceipt(db, actorId, 'create', targetKey, params.idempotencyKey, receiptPayload, ts, () => {
        if (params.factId) {
          const sameId = fetchOwnedFactSync(db, params.factId, params.ownerPrincipalId);
          if (sameId) {
            validateUserMemoryWrite({ ...params, operation: 'overwrite' }, sameId, actor);
            throw userMemoryError(`User memory fact '${params.factId}' already exists`, 409, 'USER_MEMORY_CONFLICT');
          }
        }
        let targetToSupersede = null;
        if (params.supersedesFactId) {
          targetToSupersede = fetchOwnedFactSync(db, params.supersedesFactId, params.ownerPrincipalId);
          if (!targetToSupersede) {
            throw userMemoryError(`Target fact '${params.supersedesFactId}' not found`, 404, 'USER_MEMORY_NOT_FOUND');
          }
          if (targetToSupersede.status !== 'active') {
            throw userMemoryError(`Target fact '${params.supersedesFactId}' is not active`, 409, 'USER_MEMORY_CONFLICT');
          }
          validateUserMemoryWrite({ ...params, operation: 'supersede' }, targetToSupersede, actor);
        } else {
          validateUserMemoryWrite({ ...params, operation: 'create' }, null, actor);
        }
        const fact = insertFactSync(db, params, actorId, ts);
        let supersededFact = null;
        if (targetToSupersede) {
          supersededFact = applySupersedeSync(
            db,
            targetToSupersede,
            fact.id,
            actorId,
            params.reason || `Superseded by ${fact.id}`,
            params.idempotencyKey,
            ts,
          );
        }
        return {
          schemaVersion: 1,
          fact,
          ...(supersededFact ? { supersededFact } : {}),
        };
      });
    }, { mutate: true, db: opts.db });
  }

  async function upsertUserMemoryFact(input, opts = {}) {
    const actor = opts.actor || null;
    const params = parseCreateParams(input, actor);
    const ts = nowIso(opts.now);
    const actorId = text(actor?.principalId, 160) || params.ownerPrincipalId;

    return withStoreDb((db) => {
      const targetKey = `${params.scope.type}:${params.scope.projectId || ''}:${params.scope.responsibilityId || ''}:${params.normalizedKey}`;
      const receiptPayload = {
        op: 'upsert',
        ownerPrincipalId: params.ownerPrincipalId,
        category: params.category,
        factKey: params.factKey,
        factValue: params.factValue,
        sourceType: params.sourceType,
        sourceRef: params.sourceRef,
        scope: params.scope,
        confidence: params.confidence,
        validUntil: params.validUntil,
        metadata: params.metadata,
      };
      return withReceipt(db, actorId, 'upsert', targetKey, params.idempotencyKey, receiptPayload, ts, () => {
        // Check active same-key rule in exact scope OR global user_rule shadowing protection.
        const activeSameScope = db.prepare(`
          SELECT * FROM user_memory_facts
          WHERE owner_principal_id = ? AND normalized_key = ? AND status = 'active'
            AND scope_type = ? AND project_id = ? AND responsibility_id = ?
          ORDER BY version DESC, created_at DESC LIMIT 1
        `).get(
          params.ownerPrincipalId,
          params.normalizedKey,
          params.scope.type,
          params.scope.projectId || '',
          params.scope.responsibilityId || '',
        );
        const existingSameScope = rowToFact(activeSameScope);

        const globalRuleRow = db.prepare(`
          SELECT * FROM user_memory_facts
          WHERE owner_principal_id = ? AND normalized_key = ? AND status = 'active'
            AND scope_type = 'global' AND (source_type = 'user_rule' OR category = 'user_rule')
          ORDER BY version DESC, created_at DESC LIMIT 1
        `).get(params.ownerPrincipalId, params.normalizedKey);
        const globalRule = rowToFact(globalRuleRow);

        if (globalRule && (!existingSameScope || existingSameScope.id !== globalRule.id)) {
          validateUserMemoryWrite({ ...params, operation: 'overwrite' }, globalRule, actor);
        }

        if (params.scope.type === 'responsibility' && params.scope.projectId) {
          const projectRuleRow = db.prepare(`
            SELECT * FROM user_memory_facts
            WHERE owner_principal_id = ? AND normalized_key = ? AND status = 'active'
              AND scope_type = 'project' AND project_id = ? AND (source_type = 'user_rule' OR category = 'user_rule')
            ORDER BY version DESC, created_at DESC LIMIT 1
          `).get(params.ownerPrincipalId, params.normalizedKey, params.scope.projectId);
          const projectRule = rowToFact(projectRuleRow);
          if (projectRule && (!existingSameScope || existingSameScope.id !== projectRule.id)) {
            validateUserMemoryWrite({ ...params, operation: 'overwrite' }, projectRule, actor);
          }
        }

        if (!existingSameScope) {
          validateUserMemoryWrite({ ...params, operation: 'create' }, null, actor);
          const fact = insertFactSync(db, params, actorId, ts);
          return { schemaVersion: 1, fact, action: 'created' };
        }

        validateUserMemoryWrite({ ...params, operation: 'overwrite' }, existingSameScope, actor);
        const newFact = insertFactSync(db, { ...params, supersedesFactId: existingSameScope.id }, actorId, ts);
        const supersededFact = applySupersedeSync(
          db,
          existingSameScope,
          newFact.id,
          actorId,
          params.reason || `Upsert superseded by ${newFact.id}`,
          params.idempotencyKey,
          ts,
        );
        return { schemaVersion: 1, fact: newFact, supersededFact, action: 'superseded' };
      });
    }, { mutate: true, db: opts.db });
  }

  async function reviseUserMemoryFact(input, opts = {}) {
    const actor = opts.actor || null;
    const ownerPrincipalId = resolveOwnerPrincipal(input, actor);
    const factId = requiredText(input?.factId, 'factId', 120);
    const idempotencyKey = requiredText(input?.idempotencyKey, 'idempotencyKey', 160);
    const expectedVersion = input?.expectedVersion;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw userMemoryError('expectedVersion must be a positive integer', 400, 'USER_MEMORY_INVALID');
    }
    const factValue = requiredText(input?.factValue ?? input?.value ?? input?.statement ?? input?.content, 'factValue', 2000);
    const action = text(input?.action || 'revise', 20);
    if (!['revise', 'correct'].includes(action)) {
      throw userMemoryError("action must be 'revise' or 'correct'", 400, 'USER_MEMORY_INVALID');
    }
    const ts = nowIso(opts.now);
    const actorId = text(actor?.principalId, 160) || ownerPrincipalId;

    return withStoreDb((db) => {
      const receiptPayload = {
        op: 'revise',
        ownerPrincipalId,
        factId,
        expectedVersion,
        action,
        factValue,
        category: input?.category ?? null,
        scope: input?.scope ?? null,
        confidence: input?.confidence ?? null,
        validUntil: input?.validUntil ?? null,
        sourceType: input?.sourceType ?? null,
        sourceRef: input?.sourceRef ?? null,
        reason: text(input?.reason, 500),
      };
      return withReceipt(db, actorId, 'revise', factId, idempotencyKey, receiptPayload, ts, () => {
        const existing = fetchOwnedFactSync(db, factId, ownerPrincipalId);
        if (!existing) throw userMemoryError(`User memory fact '${factId}' not found`, 404, 'USER_MEMORY_NOT_FOUND');
        if (existing.version !== expectedVersion) {
          throw userMemoryError('User memory fact version changed', 409, 'USER_MEMORY_VERSION_CONFLICT');
        }
        if (existing.status !== 'active') {
          throw userMemoryError(`Cannot revise ${existing.status} user memory fact`, 409, 'USER_MEMORY_CONFLICT');
        }
        const guard = validateUserMemoryWrite({ ...input, operation: action }, existing, actor);
        const nextSourceType = input?.sourceType !== undefined && input?.sourceType !== ''
          ? guard.sourceType
          : existing.sourceType;
        const nextCategory = input?.category !== undefined && input?.category !== ''
          ? guard.category
          : existing.category;
        const nextSourceRef = input?.sourceRef !== undefined && text(input.sourceRef, 500)
          ? text(input.sourceRef, 500)
          : existing.sourceRef;
        const nextScope = input?.scope !== undefined
          ? normalizeScope(input.scope, existing.scope.projectId || '', existing.scope.responsibilityId || '')
          : existing.scope;
        const nextConfidence = input?.confidence !== undefined
          ? normalizeConfidence(input.confidence, nextSourceType)
          : existing.confidence;
        const nextValidUntil = input?.validUntil !== undefined
          ? normalizeValidUntil(input.validUntil)
          : existing.validUntil;
        const nextMetadata = input?.metadata !== undefined
          ? normalizeMetadata(input.metadata)
          : existing.metadata;
        const nextKeyInfo = input?.factKey !== undefined && text(input.factKey, 160)
          ? normalizeFactKey(input.factKey, nextCategory, factValue)
          : { factKey: existing.factKey, normalizedKey: existing.normalizedKey };

        const nextVersion = existing.version + 1;
        const res = db.prepare(`
          UPDATE user_memory_facts
          SET category = ?, fact_key = ?, normalized_key = ?, fact_value = ?,
              source_type = ?, source_ref = ?, scope_type = ?, project_id = ?,
              responsibility_id = ?, scope_json = ?, confidence = ?, valid_until = ?,
              version = ?, metadata_json = ?, updated_by = ?, updated_at = ?
          WHERE id = ? AND owner_principal_id = ? AND version = ? AND status = 'active'
        `).run(
          nextCategory,
          nextKeyInfo.factKey,
          nextKeyInfo.normalizedKey,
          factValue,
          nextSourceType,
          nextSourceRef,
          nextScope.type,
          nextScope.projectId || '',
          nextScope.responsibilityId || '',
          JSON.stringify(nextScope),
          nextConfidence,
          nextValidUntil,
          nextVersion,
          JSON.stringify(nextMetadata),
          actorId,
          ts,
          factId,
          ownerPrincipalId,
          expectedVersion,
        );
        if (res.changes !== 1) {
          throw userMemoryError('User memory fact version changed concurrently', 409, 'USER_MEMORY_VERSION_CONFLICT');
        }
        const updated = fetchOwnedFactSync(db, factId, ownerPrincipalId);
        appendAuditVersion(db, {
          fact: updated,
          action,
          actorId,
          reason: text(input?.reason, 500),
          idempotencyKey,
          createdAt: ts,
        });
        return { schemaVersion: 1, fact: updated };
      });
    }, { mutate: true, db: opts.db });
  }

  async function retractUserMemoryFact(input, opts = {}) {
    const actor = opts.actor || null;
    const ownerPrincipalId = resolveOwnerPrincipal(input, actor);
    const factId = requiredText(input?.factId, 'factId', 120);
    const idempotencyKey = requiredText(input?.idempotencyKey, 'idempotencyKey', 160);
    const expectedVersion = input?.expectedVersion;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw userMemoryError('expectedVersion must be a positive integer', 400, 'USER_MEMORY_INVALID');
    }
    const reason = text(input?.reason, 500);
    const ts = nowIso(opts.now);
    const actorId = text(actor?.principalId, 160) || ownerPrincipalId;

    return withStoreDb((db) => {
      const receiptPayload = { op: 'retract', ownerPrincipalId, factId, expectedVersion, reason };
      return withReceipt(db, actorId, 'retract', factId, idempotencyKey, receiptPayload, ts, () => {
        const existing = fetchOwnedFactSync(db, factId, ownerPrincipalId);
        if (!existing) throw userMemoryError(`User memory fact '${factId}' not found`, 404, 'USER_MEMORY_NOT_FOUND');
        if (existing.version !== expectedVersion) {
          throw userMemoryError('User memory fact version changed', 409, 'USER_MEMORY_VERSION_CONFLICT');
        }
        if (existing.status !== 'active') {
          throw userMemoryError(`User memory fact '${factId}' is already ${existing.status}`, 409, 'USER_MEMORY_CONFLICT');
        }
        validateUserMemoryWrite({ ...input, operation: 'retract' }, existing, actor);
        const nextVersion = existing.version + 1;
        const res = db.prepare(`
          UPDATE user_memory_facts
          SET status = 'retracted', version = ?, updated_by = ?, updated_at = ?
          WHERE id = ? AND owner_principal_id = ? AND version = ? AND status = 'active'
        `).run(nextVersion, actorId, ts, factId, ownerPrincipalId, expectedVersion);
        if (res.changes !== 1) {
          throw userMemoryError('User memory fact version changed concurrently', 409, 'USER_MEMORY_VERSION_CONFLICT');
        }
        const updated = fetchOwnedFactSync(db, factId, ownerPrincipalId);
        appendAuditVersion(db, {
          fact: updated,
          action: 'retract',
          actorId,
          reason,
          idempotencyKey,
          createdAt: ts,
        });
        return { schemaVersion: 1, fact: updated };
      });
    }, { mutate: true, db: opts.db });
  }

  async function supersedeUserMemoryFact(input, opts = {}) {
    const actor = opts.actor || null;
    const ownerPrincipalId = resolveOwnerPrincipal(input, actor);
    const factId = requiredText(input?.factId, 'factId', 120);
    const idempotencyKey = requiredText(input?.idempotencyKey, 'idempotencyKey', 160);
    const expectedVersion = input?.expectedVersion;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw userMemoryError('expectedVersion must be a positive integer', 400, 'USER_MEMORY_INVALID');
    }
    const replacementRaw = input?.replacement && typeof input.replacement === 'object' ? input.replacement : input;
    const reason = text(input?.reason ?? replacementRaw?.reason, 500);
    const ts = nowIso(opts.now);
    const actorId = text(actor?.principalId, 160) || ownerPrincipalId;

    return withStoreDb((db) => {
      const outerSourceType = input?.replacement && input?.sourceType ? text(input.sourceType, 60) : '';
      const effectiveOrigin = replacementRaw?.originType ?? input?.originType ?? (outerSourceType && outerSourceType !== replacementRaw?.sourceType ? outerSourceType : undefined);
      const replacementParams = {
        ownerPrincipalId,
        idempotencyKey,
        factId: text(replacementRaw?.factId, 120) || '',
        sourceType: normalizeSourceType(replacementRaw?.sourceType),
        category: normalizeCategory(replacementRaw?.category, normalizeSourceType(replacementRaw?.sourceType)),
        factValue: requiredText(
          replacementRaw?.factValue ?? replacementRaw?.newFactValue ?? replacementRaw?.value ?? replacementRaw?.statement,
          'replacement.factValue',
          2000,
        ),
        sourceRef: requiredText(replacementRaw?.sourceRef, 'replacement.sourceRef', 500),
        scope: replacementRaw?.scope !== undefined
          ? normalizeScope(replacementRaw.scope, replacementRaw?.projectId, replacementRaw?.responsibilityId)
          : null,
        confidence: replacementRaw?.confidence !== undefined
          ? normalizeConfidence(replacementRaw.confidence, normalizeSourceType(replacementRaw?.sourceType))
          : null,
        validUntil: replacementRaw?.validUntil !== undefined ? normalizeValidUntil(replacementRaw.validUntil) : null,
        metadata: normalizeMetadata(replacementRaw?.metadata),
        factKeyRaw: text(replacementRaw?.factKey ?? replacementRaw?.key, 160),
        originType: effectiveOrigin,
        provenanceKind: replacementRaw?.provenanceKind ?? input?.provenanceKind,
        sourceKind: replacementRaw?.sourceKind ?? input?.sourceKind,
        untrusted: replacementRaw?.untrusted ?? input?.untrusted,
      };
      const receiptPayload = {
        op: 'supersede',
        ownerPrincipalId,
        factId,
        expectedVersion,
        replacement: replacementParams,
        reason,
      };
      return withReceipt(db, actorId, 'supersede', factId, idempotencyKey, receiptPayload, ts, () => {
        const existing = fetchOwnedFactSync(db, factId, ownerPrincipalId);
        if (!existing) throw userMemoryError(`User memory fact '${factId}' not found`, 404, 'USER_MEMORY_NOT_FOUND');
        if (existing.version !== expectedVersion) {
          throw userMemoryError('User memory fact version changed', 409, 'USER_MEMORY_VERSION_CONFLICT');
        }
        if (existing.status !== 'active') {
          throw userMemoryError(`User memory fact '${factId}' is already ${existing.status}`, 409, 'USER_MEMORY_CONFLICT');
        }
        validateUserMemoryWrite({ ...replacementParams, operation: 'supersede' }, existing, actor);

        const resolvedKey = replacementParams.factKeyRaw
          ? normalizeFactKey(replacementParams.factKeyRaw, replacementParams.category, replacementParams.factValue)
          : { factKey: existing.factKey, normalizedKey: existing.normalizedKey };
        const newFact = insertFactSync(db, {
          ownerPrincipalId,
          factId: replacementParams.factId,
          idempotencyKey,
          sourceType: replacementParams.sourceType,
          category: replacementParams.category,
          factKey: resolvedKey.factKey,
          normalizedKey: resolvedKey.normalizedKey,
          factValue: replacementParams.factValue,
          sourceRef: replacementParams.sourceRef,
          scope: replacementParams.scope || existing.scope,
          confidence: replacementParams.confidence ?? normalizeConfidence(undefined, replacementParams.sourceType),
          validUntil: replacementParams.validUntil,
          metadata: replacementParams.metadata,
          supersedesFactId: existing.id,
          reason: reason || `Supersedes ${existing.id}`,
        }, actorId, ts);

        const supersededFact = applySupersedeSync(
          db,
          existing,
          newFact.id,
          actorId,
          reason || `Superseded by ${newFact.id}`,
          idempotencyKey,
          ts,
        );
        return { schemaVersion: 1, supersededFact, newFact };
      });
    }, { mutate: true, db: opts.db });
  }

  async function setUserMemoryValidUntil(input, opts = {}) {
    const actor = opts.actor || null;
    const ownerPrincipalId = resolveOwnerPrincipal(input, actor);
    const factId = requiredText(input?.factId, 'factId', 120);
    const idempotencyKey = requiredText(input?.idempotencyKey, 'idempotencyKey', 160);
    const expectedVersion = input?.expectedVersion;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw userMemoryError('expectedVersion must be a positive integer', 400, 'USER_MEMORY_INVALID');
    }
    const validUntil = normalizeValidUntil(input?.validUntil);
    const reason = text(input?.reason, 500);
    const ts = nowIso(opts.now);
    const actorId = text(actor?.principalId, 160) || ownerPrincipalId;

    return withStoreDb((db) => {
      const receiptPayload = { op: 'set_valid_until', ownerPrincipalId, factId, expectedVersion, validUntil, reason };
      return withReceipt(db, actorId, 'set_valid_until', factId, idempotencyKey, receiptPayload, ts, () => {
        const existing = fetchOwnedFactSync(db, factId, ownerPrincipalId);
        if (!existing) throw userMemoryError(`User memory fact '${factId}' not found`, 404, 'USER_MEMORY_NOT_FOUND');
        if (existing.version !== expectedVersion) {
          throw userMemoryError('User memory fact version changed', 409, 'USER_MEMORY_VERSION_CONFLICT');
        }
        if (existing.status !== 'active') {
          throw userMemoryError(`Cannot update validity of ${existing.status} user memory fact`, 409, 'USER_MEMORY_CONFLICT');
        }
        validateUserMemoryWrite({ ...input, operation: 'set_valid_until' }, existing, actor);
        const nextVersion = existing.version + 1;
        const res = db.prepare(`
          UPDATE user_memory_facts
          SET valid_until = ?, version = ?, updated_by = ?, updated_at = ?
          WHERE id = ? AND owner_principal_id = ? AND version = ? AND status = 'active'
        `).run(validUntil, nextVersion, actorId, ts, factId, ownerPrincipalId, expectedVersion);
        if (res.changes !== 1) {
          throw userMemoryError('User memory fact version changed concurrently', 409, 'USER_MEMORY_VERSION_CONFLICT');
        }
        const updated = fetchOwnedFactSync(db, factId, ownerPrincipalId);
        appendAuditVersion(db, {
          fact: updated,
          action: 'set_valid_until',
          actorId,
          reason,
          idempotencyKey,
          createdAt: ts,
        });
        return { schemaVersion: 1, fact: updated };
      });
    }, { mutate: true, db: opts.db });
  }

  return {
    databasePath: databasePath || null,
    listUserMemoryFacts,
    getUserMemoryFact,
    getUserMemoryHistory,
    createUserMemoryFact,
    upsertUserMemoryFact,
    reviseUserMemoryFact,
    retractUserMemoryFact,
    supersedeUserMemoryFact,
    setUserMemoryValidUntil,
    validateUserMemoryWrite,
  };
}

export const defaultUserMemoryStore = createUserMemoryStore();

export const listUserMemoryFacts = (query, opts) => defaultUserMemoryStore.listUserMemoryFacts(query, opts);
export const getUserMemoryFact = (factId, opts) => defaultUserMemoryStore.getUserMemoryFact(factId, opts);
export const getUserMemoryHistory = (factId, opts) => defaultUserMemoryStore.getUserMemoryHistory(factId, opts);
export const createUserMemoryFact = (input, opts) => defaultUserMemoryStore.createUserMemoryFact(input, opts);
export const upsertUserMemoryFact = (input, opts) => defaultUserMemoryStore.upsertUserMemoryFact(input, opts);
export const reviseUserMemoryFact = (input, opts) => defaultUserMemoryStore.reviseUserMemoryFact(input, opts);
export const retractUserMemoryFact = (input, opts) => defaultUserMemoryStore.retractUserMemoryFact(input, opts);
export const supersedeUserMemoryFact = (input, opts) => defaultUserMemoryStore.supersedeUserMemoryFact(input, opts);
export const setUserMemoryValidUntil = (input, opts) => defaultUserMemoryStore.setUserMemoryValidUntil(input, opts);
