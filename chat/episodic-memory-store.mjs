import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase as openCollaborationDatabase, withDatabase as withCollaborationDatabase } from './collaboration-store.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';

export const EPISODIC_OUTCOMES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'repaired',
  'partial',
  'blocked',
  'unknown_outcome',
]);

export const EPISODIC_REPAIR_STATUSES = Object.freeze([
  'none',
  'attempted',
  'succeeded',
  'failed',
]);

export const EPISODIC_SOURCE_TYPES = Object.freeze([
  'tool_verified',
  'model_inferred',
  'external_untrusted',
]);

const OUTCOME_SET = new Set(EPISODIC_OUTCOMES);
const REPAIR_STATUS_SET = new Set(EPISODIC_REPAIR_STATUSES);
const SOURCE_TYPE_SET = new Set(EPISODIC_SOURCE_TYPES);
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

const DEFAULT_MAX_RECORDS_PER_RESPONSIBILITY = 200;
const HARD_MAX_RECORDS_PER_RESPONSIBILITY = 10_000;

const EPISODIC_MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS episodic_memory_records (
  id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL,
  organization_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL,
  responsibility_id TEXT NOT NULL,
  wake_id TEXT NOT NULL DEFAULT '',
  goal_id TEXT NOT NULL DEFAULT '',
  work_item_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  packet_id TEXT NOT NULL DEFAULT '',
  episode_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','cancelled','repaired','partial','blocked','unknown_outcome')),
  summary TEXT NOT NULL,
  failure_root_cause TEXT NOT NULL DEFAULT '',
  repair_attempt TEXT NOT NULL DEFAULT '',
  repair_status TEXT NOT NULL DEFAULT 'none' CHECK(repair_status IN ('none','attempted','succeeded','failed')),
  artifact_links_json TEXT NOT NULL DEFAULT '[]',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  source_type TEXT NOT NULL DEFAULT 'tool_verified' CHECK(source_type IN ('tool_verified','model_inferred','external_untrusted')),
  source_ref TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.95,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retracted','expired')),
  valid_until TEXT,
  retention_tier TEXT NOT NULL DEFAULT 'standard' CHECK(retention_tier IN ('standard','pinned')),
  payload_digest TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_principal_id, responsibility_id, episode_key)
);
CREATE INDEX IF NOT EXISTS episodic_memory_scope
  ON episodic_memory_records(owner_principal_id, project_id, responsibility_id, status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS episodic_memory_expiry
  ON episodic_memory_records(status, valid_until);

CREATE TABLE IF NOT EXISTS episodic_memory_receipts (
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, operation, target_id, idempotency_key)
);
CREATE TRIGGER IF NOT EXISTS episodic_memory_receipts_no_update
  BEFORE UPDATE ON episodic_memory_receipts
  BEGIN SELECT RAISE(ABORT, 'immutable episodic memory receipt'); END;
CREATE TRIGGER IF NOT EXISTS episodic_memory_receipts_no_delete
  BEFORE DELETE ON episodic_memory_receipts
  BEGIN SELECT RAISE(ABORT, 'immutable episodic memory receipt'); END;
`;

function episodicError(message, statusCode = 400, code = 'EPISODIC_MEMORY_INVALID') {
  return Object.assign(new Error(message), { statusCode, code });
}

function text(value, max = 0) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return max > 0 ? normalized.slice(0, max) : normalized;
}

function requiredText(value, name, max = 160) {
  const normalized = text(value, max);
  if (!normalized) throw episodicError(`${name} is required`, 400, 'EPISODIC_MEMORY_INVALID');
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

function resolveRetentionLimits(options = {}) {
  const rawMaxRows = options.maxRecordsPerResponsibility !== undefined
    ? Number(options.maxRecordsPerResponsibility)
    : Number(process.env.RAGENT_EPISODIC_MEMORY_MAX_PER_RESPONSIBILITY || DEFAULT_MAX_RECORDS_PER_RESPONSIBILITY);
  const maxRecordsPerResponsibility = Number.isSafeInteger(rawMaxRows) && rawMaxRows >= 1
    ? Math.min(rawMaxRows, HARD_MAX_RECORDS_PER_RESPONSIBILITY)
    : DEFAULT_MAX_RECORDS_PER_RESPONSIBILITY;
  const rawMaxAge = options.maxAgeMs !== undefined
    ? Number(options.maxAgeMs)
    : Number(process.env.RAGENT_EPISODIC_MEMORY_MAX_AGE_MS || 0);
  const maxAgeMs = options.maxAgeMs === null
    ? 0
    : (Number.isFinite(rawMaxAge) && rawMaxAge > 0 ? rawMaxAge : 0);
  return { maxRecordsPerResponsibility, maxAgeMs };
}

function normalizeArtifactLinks(rawLinks, { packetId = '', packetDigest = '', runId = '' } = {}) {
  const links = [];
  const seen = new Set();
  const pushLink = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const kind = text(entry.kind || 'artifact', 40) || 'artifact';
    const ref = text(entry.ref || entry.packetId || entry.path || entry.url || '', 500);
    if (!ref) return;
    const key = `${kind}:${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({
      kind,
      ref,
      ...(text(entry.packetId, 160) ? { packetId: text(entry.packetId, 160) } : {}),
      ...(text(entry.digest, 160) ? { digest: text(entry.digest, 160) } : {}),
      ...(text(entry.path, 500) ? { path: text(entry.path, 500) } : {}),
      verified: entry.verified !== false,
    });
  };
  for (const item of Array.isArray(rawLinks) ? rawLinks.slice(0, 32) : []) {
    if (typeof item === 'string') {
      pushLink({ kind: 'artifact', ref: item, verified: true });
    } else {
      pushLink(item);
    }
  }
  if (packetId) {
    pushLink({
      kind: 'result_packet',
      ref: `packet:${packetId}`,
      packetId,
      ...(packetDigest ? { digest: packetDigest } : {}),
      verified: true,
    });
  }
  if (runId) {
    pushLink({
      kind: 'run',
      ref: `run:${runId}`,
      verified: true,
    });
  }
  return links.slice(0, 32);
}

function normalizeKeywords(rawKeywords) {
  const input = Array.isArray(rawKeywords) ? rawKeywords : (typeof rawKeywords === 'string' ? rawKeywords.split(/[\s,;|]+/) : []);
  const out = [];
  const seen = new Set();
  for (const entry of input) {
    const cleaned = text(String(entry || ''), 80).toLowerCase();
    if (cleaned.length < 2 || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= 32) break;
  }
  return out;
}

function tokenizeQueryKeywords(input) {
  const list = Array.isArray(input) ? input : [input];
  const tokens = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.trim().toLowerCase().split(/[\s,;|]+/)) {
      if (part.length >= 2) tokens.push(part);
    }
  }
  return [...new Set(tokens)].slice(0, 40);
}

function keywordScore(episode, keywords) {
  if (!keywords.length) return 0;
  const textCorpus = [
    episode.outcome,
    episode.summary,
    episode.failureRootCause,
    episode.repairAttempt,
    ...episode.keywords,
    ...episode.artifactLinks.map((l) => `${l.kind} ${l.ref} ${l.path || ''}`),
  ].join(' ').toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (textCorpus.includes(kw)) hits += 1;
  }
  return hits;
}

function normalizeConfidence(value, sourceType) {
  if (value === undefined || value === null || value === '') {
    return sourceType === 'tool_verified' ? 0.95 : sourceType === 'model_inferred' ? 0.6 : 0.15;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value;
  throw episodicError('confidence must be between 0 and 1', 400, 'EPISODIC_MEMORY_INVALID');
}

function rowToEpisode(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    organizationId: row.organization_id || null,
    projectId: row.project_id,
    responsibilityId: row.responsibility_id,
    wakeId: row.wake_id || null,
    goalId: row.goal_id || null,
    workItemId: row.work_item_id || null,
    runId: row.run_id || null,
    packetId: row.packet_id || null,
    episodeKey: row.episode_key,
    outcome: row.outcome,
    summary: row.summary,
    failureRootCause: row.failure_root_cause || '',
    repairAttempt: row.repair_attempt || '',
    repairStatus: row.repair_status || 'none',
    artifactLinks: parseJson(row.artifact_links_json, []),
    keywords: parseJson(row.keywords_json, []),
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    confidence: Number(row.confidence),
    status: row.status,
    validUntil: row.valid_until || null,
    retentionTier: row.retention_tier || 'standard',
    metadata: parseJson(row.metadata_json, {}),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pruneScopeSync(db, {
  ownerPrincipalId = '',
  responsibilityId = '',
  maxAgeMs = 0,
  maxRecordsPerResponsibility = DEFAULT_MAX_RECORDS_PER_RESPONSIBILITY,
  nowMs = Date.now(),
} = {}) {
  const currentIso = new Date(nowMs).toISOString();
  const scopeWhere = [];
  const scopeParams = [];
  if (ownerPrincipalId) {
    scopeWhere.push('owner_principal_id = ?');
    scopeParams.push(ownerPrincipalId);
  }
  if (responsibilityId) {
    scopeWhere.push('responsibility_id = ?');
    scopeParams.push(responsibilityId);
  }
  const scopePrefix = scopeWhere.length ? `${scopeWhere.join(' AND ')} AND ` : '';

  const expiredRes = db.prepare(`
    DELETE FROM episodic_memory_records
    WHERE ${scopePrefix} retention_tier <> 'pinned' AND valid_until IS NOT NULL AND valid_until <= ?
  `).run(...scopeParams, currentIso);
  let expiredCount = Number(expiredRes?.changes || 0);

  if (maxAgeMs > 0) {
    const cutoffIso = new Date(nowMs - maxAgeMs).toISOString();
    const agedRes = db.prepare(`
      DELETE FROM episodic_memory_records
      WHERE ${scopePrefix} retention_tier <> 'pinned' AND occurred_at < ?
    `).run(...scopeParams, cutoffIso);
    expiredCount += Number(agedRes?.changes || 0);
  }

  let prunedCount = 0;
  const groups = (ownerPrincipalId && responsibilityId)
    ? [{ owner_principal_id: ownerPrincipalId, responsibility_id: responsibilityId }]
    : db.prepare(`
        SELECT DISTINCT owner_principal_id, responsibility_id
        FROM episodic_memory_records
        ${scopeWhere.length ? `WHERE ${scopeWhere.join(' AND ')}` : ''}
      `).all(...scopeParams);

  for (const grp of groups) {
    const total = Number(db.prepare(`
      SELECT COUNT(*) AS n FROM episodic_memory_records
      WHERE owner_principal_id = ? AND responsibility_id = ? AND retention_tier <> 'pinned'
    `).get(grp.owner_principal_id, grp.responsibility_id)?.n || 0);
    if (total <= maxRecordsPerResponsibility) continue;
    const excess = total - maxRecordsPerResponsibility;
    const victims = db.prepare(`
      SELECT id FROM episodic_memory_records
      WHERE owner_principal_id = ? AND responsibility_id = ? AND retention_tier <> 'pinned'
      ORDER BY occurred_at ASC, created_at ASC, id ASC
      LIMIT ?
    `).all(grp.owner_principal_id, grp.responsibility_id, excess);
    if (victims.length) {
      const del = db.prepare(`
        DELETE FROM episodic_memory_records
        WHERE id IN (${victims.map(() => '?').join(',')})
      `).run(...victims.map((v) => v.id));
      prunedCount += Number(del?.changes || 0);
    }
  }

  return { expiredCount, prunedCount };
}

export function ensureEpisodicMemorySchema(db) {
  const ready = db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE (type = 'table' AND name IN ('episodic_memory_records', 'episodic_memory_receipts'))
       OR (type = 'trigger' AND name IN ('episodic_memory_receipts_no_update', 'episodic_memory_receipts_no_delete'))
  `).get();
  if (Number(ready?.count || 0) === 4) return;
  db.exec(EPISODIC_MEMORY_SCHEMA);
}

/**
 * Create a SQLite-backed Episodic Memory store instance.
 * Defaults to the shared Ragent collaboration SQLite database when `databasePath`
 * is omitted, or opens an isolated SQLite database at `databasePath` for tests.
 */
export function createEpisodicMemoryStore(options = {}) {
  const databasePath = text(options.databasePath, 2000);
  const mutationQueue = createSerialTaskQueue();

  async function withStoreDb(fn, { mutate = false, db: explicitDb = null } = {}) {
    if (explicitDb) {
      ensureEpisodicMemorySchema(explicitDb);
      return fn(explicitDb);
    }
    if (!databasePath) {
      return withCollaborationDatabase((db) => {
        ensureEpisodicMemorySchema(db);
        if (!mutate) return fn(db);
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = fn(db);
          if (result && typeof result.then === 'function') {
            throw episodicError('Async work is forbidden inside an episodic memory transaction', 500, 'EPISODIC_MEMORY_INVALID');
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
        ensureEpisodicMemorySchema(db);
        if (!mutate) return fn(db);
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = fn(db);
          if (result && typeof result.then === 'function') {
            throw episodicError('Async work is forbidden inside an episodic memory transaction', 500, 'EPISODIC_MEMORY_INVALID');
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

  async function recordEpisode(input = {}, opts = {}) {
    const actor = opts.actor || null;
    const ownerPrincipalId = text(input.ownerPrincipalId || actor?.principalId, 160);
    if (!ownerPrincipalId) throw episodicError('ownerPrincipalId is required', 400, 'EPISODIC_MEMORY_INVALID');
    if (actor?.principalId && text(actor.principalId, 160) !== ownerPrincipalId) {
      throw episodicError('Actor principal does not match ownerPrincipalId', 403, 'EPISODIC_MEMORY_FORBIDDEN');
    }
    const projectId = requiredText(input.projectId, 'projectId', 160);
    const responsibilityId = requiredText(input.responsibilityId, 'responsibilityId', 160);
    const outcome = text(input.outcome, 40);
    if (!OUTCOME_SET.has(outcome)) {
      throw episodicError(`outcome must be one of ${EPISODIC_OUTCOMES.join(', ')}`, 400, 'EPISODIC_MEMORY_INVALID');
    }
    const summary = requiredText(input.summary, 'summary', 2000);
    const sourceType = text(input.sourceType || 'tool_verified', 60);
    if (!SOURCE_TYPE_SET.has(sourceType)) {
      throw episodicError(`sourceType must be one of ${EPISODIC_SOURCE_TYPES.join(', ')}`, 400, 'EPISODIC_MEMORY_INVALID');
    }

    const origin = text(input.originType || input.provenanceKind || input.sourceKind || '', 80).toLowerCase();
    const packetId = text(input.packetId, 160);
    const runId = text(input.runId, 160);
    const workItemId = text(input.workItemId, 160);
    const wakeId = text(input.wakeId, 160);
    const goalId = text(input.goalId, 160);
    const organizationId = text(input.organizationId, 160);
    const sourceRef = text(
      input.sourceRef
        || (packetId ? `packet:${packetId}` : runId ? `run:${runId}` : workItemId ? `work-item:${workItemId}` : ''),
      500,
    );
    if (!sourceRef) throw episodicError('sourceRef is required', 400, 'EPISODIC_MEMORY_INVALID');

    if (
      sourceType === 'tool_verified'
      && (UNTRUSTED_ORIGINS.has(origin) || input.untrusted === true || /^(?:external_untrusted|untrusted):/i.test(sourceRef))
    ) {
      throw episodicError(
        'External untrusted content cannot be recorded as tool_verified episodic memory',
        403,
        'EPISODIC_MEMORY_SOURCE_ISOLATION',
      );
    }

    const failureRootCause = text(input.failureRootCause, 2000);
    const repairAttempt = text(input.repairAttempt, 2000);
    const repairStatus = text(input.repairStatus || (repairAttempt ? 'attempted' : 'none'), 40);
    if (!REPAIR_STATUS_SET.has(repairStatus)) {
      throw episodicError(`repairStatus must be one of ${EPISODIC_REPAIR_STATUSES.join(', ')}`, 400, 'EPISODIC_MEMORY_INVALID');
    }

    const artifactLinks = normalizeArtifactLinks(input.artifactLinks, {
      packetId,
      packetDigest: text(input.packetDigest, 160),
      runId,
    });
    const keywords = normalizeKeywords(input.keywords);
    const confidence = normalizeConfidence(input.confidence, sourceType);
    const retentionTier = text(input.retentionTier || 'standard', 20);
    if (!['standard', 'pinned'].includes(retentionTier)) {
      throw episodicError("retentionTier must be 'standard' or 'pinned'", 400, 'EPISODIC_MEMORY_INVALID');
    }
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : {};

    const occurredAt = input.occurredAt ? nowIso(input.occurredAt) : nowIso(opts.now);
    const occurredMs = Date.parse(occurredAt);
    let validUntil = null;
    if (input.validUntil !== undefined && input.validUntil !== null && input.validUntil !== '') {
      const parsed = Date.parse(String(input.validUntil));
      if (!Number.isFinite(parsed)) throw episodicError('Invalid validUntil timestamp', 400, 'EPISODIC_MEMORY_INVALID');
      validUntil = new Date(parsed).toISOString();
    } else if (Number.isFinite(input.ttlMs) && input.ttlMs > 0) {
      validUntil = new Date(occurredMs + input.ttlMs).toISOString();
    }

    const idempotencyKey = text(input.idempotencyKey, 160);
    const episodeKey = text(
      input.episodeKey
        || idempotencyKey
        || (packetId ? `packet:${packetId}` : '')
        || (runId ? `run:${runId}` : '')
        || (workItemId ? `work_item:${workItemId}:${outcome}:${digest(summary).slice(0, 12)}` : '')
        || `ep:${digest({ projectId, responsibilityId, outcome, summary, failureRootCause, repairAttempt, sourceRef }).slice(0, 24)}`,
      200,
    );

    const payloadDigest = digest({
      ownerPrincipalId,
      organizationId,
      projectId,
      responsibilityId,
      wakeId,
      goalId,
      workItemId,
      runId,
      packetId,
      episodeKey,
      outcome,
      summary,
      failureRootCause,
      repairAttempt,
      repairStatus,
      artifactLinks,
      keywords,
      sourceType,
      sourceRef,
      confidence,
      validUntil,
      retentionTier,
      metadata,
    });

    const ts = nowIso(opts.now);
    const nowMs = Date.parse(ts);
    const limits = resolveRetentionLimits({
      maxRecordsPerResponsibility: opts.maxRecordsPerResponsibility ?? options.maxRecordsPerResponsibility,
      maxAgeMs: opts.maxAgeMs ?? options.maxAgeMs,
    });

    return withStoreDb((db) => {
      if (idempotencyKey) {
        const receipt = db.prepare(`
          SELECT * FROM episodic_memory_receipts
          WHERE actor_id = ? AND operation = 'record' AND target_id = ? AND idempotency_key = ?
        `).get(ownerPrincipalId, responsibilityId, idempotencyKey);
        if (receipt) {
          if (receipt.payload_digest !== payloadDigest) {
            throw episodicError('Idempotency key reused with different episodic memory payload', 409, 'EPISODIC_MEMORY_CONFLICT');
          }
          return { ...JSON.parse(receipt.result_json), replayed: true };
        }
      }

      const existing = db.prepare(`
        SELECT * FROM episodic_memory_records
        WHERE owner_principal_id = ? AND responsibility_id = ? AND episode_key = ?
      `).get(ownerPrincipalId, responsibilityId, episodeKey);

      if (existing) {
        if (existing.payload_digest !== payloadDigest) {
          throw episodicError(
            `Episode key '${episodeKey}' already recorded with different outcome payload`,
            409,
            'EPISODIC_MEMORY_CONFLICT',
          );
        }
        return { schemaVersion: 1, episode: rowToEpisode(existing), replayed: true };
      }

      const episodeId = newId('epm');
      db.prepare(`
        INSERT INTO episodic_memory_records (
          id, owner_principal_id, organization_id, project_id, responsibility_id,
          wake_id, goal_id, work_item_id, run_id, packet_id, episode_key,
          outcome, summary, failure_root_cause, repair_attempt, repair_status,
          artifact_links_json, keywords_json, source_type, source_ref, confidence,
          status, valid_until, retention_tier, payload_digest, metadata_json,
          occurred_at, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        episodeId,
        ownerPrincipalId,
        organizationId,
        projectId,
        responsibilityId,
        wakeId,
        goalId,
        workItemId,
        runId,
        packetId,
        episodeKey,
        outcome,
        summary,
        failureRootCause,
        repairAttempt,
        repairStatus,
        JSON.stringify(artifactLinks),
        JSON.stringify(keywords),
        sourceType,
        sourceRef,
        confidence,
        'active',
        validUntil,
        retentionTier,
        payloadDigest,
        JSON.stringify(metadata),
        occurredAt,
        ts,
        ts,
      );

      const inserted = rowToEpisode(db.prepare('SELECT * FROM episodic_memory_records WHERE id = ?').get(episodeId));
      const result = { schemaVersion: 1, episode: inserted, replayed: false };

      if (idempotencyKey) {
        db.prepare(`
          INSERT INTO episodic_memory_receipts (actor_id, operation, target_id, idempotency_key, payload_digest, result_json, created_at)
          VALUES (?, 'record', ?, ?, ?, ?, ?)
        `).run(ownerPrincipalId, responsibilityId, idempotencyKey, payloadDigest, JSON.stringify(result), ts);
      }

      pruneScopeSync(db, {
        ownerPrincipalId,
        responsibilityId,
        maxAgeMs: limits.maxAgeMs,
        maxRecordsPerResponsibility: limits.maxRecordsPerResponsibility,
        nowMs,
      });

      return result;
    }, { mutate: true, db: opts.db });
  }

  async function listEpisodicMemories(query = {}, opts = {}) {
    const ownerPrincipalId = text(query?.ownerPrincipalId || opts.actor?.principalId, 160);
    if (!ownerPrincipalId) throw episodicError('ownerPrincipalId is required', 400, 'EPISODIC_MEMORY_INVALID');
    if (opts.actor?.principalId && text(opts.actor.principalId, 160) !== ownerPrincipalId) {
      throw episodicError('Actor principal does not match ownerPrincipalId', 403, 'EPISODIC_MEMORY_FORBIDDEN');
    }
    const projectId = text(query?.projectId, 160);
    const responsibilityId = text(query?.responsibilityId, 160);
    const includeExpired = query?.includeExpired === true;
    const includeRetracted = query?.includeRetracted === true;
    const includeUntrusted = query?.includeUntrusted === true;
    const limit = Math.max(1, Math.min(Number(query?.limit) || 50, 200));
    const currentIso = nowIso(opts.now ?? query?.now ?? new Date());
    const outcomes = Array.isArray(query?.outcomes) && query.outcomes.length
      ? query.outcomes.map((o) => text(o, 40)).filter((o) => OUTCOME_SET.has(o))
      : (text(query?.outcome, 40) ? [text(query.outcome, 40)] : []);
    const sourceTypes = Array.isArray(query?.sourceTypes) && query.sourceTypes.length
      ? query.sourceTypes.map((s) => text(s, 60)).filter((s) => SOURCE_TYPE_SET.has(s))
      : (text(query?.sourceType, 60) ? [text(query.sourceType, 60)] : []);
    const keywords = tokenizeQueryKeywords(query?.keywords);

    return withStoreDb((db) => {
      const clauses = ['owner_principal_id = ?'];
      const params = [ownerPrincipalId];
      if (projectId) {
        clauses.push('project_id = ?');
        params.push(projectId);
      }
      if (responsibilityId) {
        clauses.push('responsibility_id = ?');
        params.push(responsibilityId);
      }
      if (outcomes.length) {
        clauses.push(`outcome IN (${outcomes.map(() => '?').join(',')})`);
        params.push(...outcomes);
      }
      if (sourceTypes.length) {
        clauses.push(`source_type IN (${sourceTypes.map(() => '?').join(',')})`);
        params.push(...sourceTypes);
      }
      if (!includeUntrusted) {
        clauses.push("source_type <> 'external_untrusted'");
      }
      if (!includeRetracted) {
        clauses.push("status = 'active'");
      }
      if (!includeExpired) {
        clauses.push('(valid_until IS NULL OR valid_until > ?)');
        params.push(currentIso);
      }

      const rows = db.prepare(`
        SELECT * FROM episodic_memory_records
        WHERE ${clauses.join(' AND ')}
        ORDER BY occurred_at DESC, created_at DESC, id ASC
      `).all(...params).map(rowToEpisode);

      const matched = keywords.length
        ? rows
            .map((ep) => ({ ep, score: keywordScore(ep, keywords) }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => (b.score - a.score) || (b.ep.occurredAt < a.ep.occurredAt ? -1 : b.ep.occurredAt > a.ep.occurredAt ? 1 : 0))
            .map((entry) => entry.ep)
        : rows;

      return {
        schemaVersion: 1,
        episodes: matched.slice(0, limit),
        total: matched.length,
        truncated: matched.length > limit,
      };
    }, { db: opts.db });
  }

  async function getEpisodicMemory(episodeId, opts = {}) {
    const id = requiredText(episodeId, 'episodeId', 120);
    const ownerPrincipalId = text(opts?.ownerPrincipalId || opts?.actor?.principalId, 160);
    if (!ownerPrincipalId) throw episodicError('ownerPrincipalId is required', 400, 'EPISODIC_MEMORY_INVALID');
    return withStoreDb((db) => {
      const row = db.prepare(`
        SELECT * FROM episodic_memory_records WHERE id = ? AND owner_principal_id = ?
      `).get(id, ownerPrincipalId);
      return { schemaVersion: 1, episode: rowToEpisode(row) };
    }, { db: opts.db });
  }

  async function retractEpisodicMemory(input = {}, opts = {}) {
    const ownerPrincipalId = text(input.ownerPrincipalId || opts.actor?.principalId, 160);
    if (!ownerPrincipalId) throw episodicError('ownerPrincipalId is required', 400, 'EPISODIC_MEMORY_INVALID');
    const episodeId = requiredText(input.episodeId, 'episodeId', 120);
    const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey', 160);
    const reason = text(input.reason, 500);
    const ts = nowIso(opts.now);
    const payloadDigest = digest({ op: 'retract', ownerPrincipalId, episodeId, reason });

    return withStoreDb((db) => {
      const prior = db.prepare(`
        SELECT * FROM episodic_memory_receipts
        WHERE actor_id = ? AND operation = 'retract' AND target_id = ? AND idempotency_key = ?
      `).get(ownerPrincipalId, episodeId, idempotencyKey);
      if (prior) {
        if (prior.payload_digest !== payloadDigest) {
          throw episodicError('Idempotency key reused with different payload', 409, 'EPISODIC_MEMORY_CONFLICT');
        }
        return { ...JSON.parse(prior.result_json), replayed: true };
      }
      const existing = db.prepare(`
        SELECT * FROM episodic_memory_records WHERE id = ? AND owner_principal_id = ?
      `).get(episodeId, ownerPrincipalId);
      if (!existing) throw episodicError(`Episodic memory '${episodeId}' not found`, 404, 'EPISODIC_MEMORY_NOT_FOUND');

      const nextMetadata = {
        ...parseJson(existing.metadata_json, {}),
        ...(reason ? { retractionReason: reason } : {}),
        retractedAt: ts,
      };
      db.prepare(`
        UPDATE episodic_memory_records
        SET status = 'retracted', metadata_json = ?, updated_at = ?
        WHERE id = ? AND owner_principal_id = ?
      `).run(JSON.stringify(nextMetadata), ts, episodeId, ownerPrincipalId);

      const updated = rowToEpisode(db.prepare('SELECT * FROM episodic_memory_records WHERE id = ?').get(episodeId));
      const result = { schemaVersion: 1, episode: updated, replayed: false };
      db.prepare(`
        INSERT INTO episodic_memory_receipts (actor_id, operation, target_id, idempotency_key, payload_digest, result_json, created_at)
        VALUES (?, 'retract', ?, ?, ?, ?, ?)
      `).run(ownerPrincipalId, episodeId, idempotencyKey, payloadDigest, JSON.stringify(result), ts);
      return result;
    }, { mutate: true, db: opts.db });
  }

  async function pruneEpisodicMemory(query = {}, opts = {}) {
    const nowMs = opts.now ? new Date(opts.now).getTime() : (query.now ? new Date(query.now).getTime() : Date.now());
    const limits = resolveRetentionLimits({
      maxRecordsPerResponsibility: query.maxRecordsPerResponsibility ?? opts.maxRecordsPerResponsibility ?? options.maxRecordsPerResponsibility,
      maxAgeMs: query.maxAgeMs ?? opts.maxAgeMs ?? options.maxAgeMs,
    });
    return withStoreDb((db) => {
      const counts = pruneScopeSync(db, {
        ownerPrincipalId: text(query.ownerPrincipalId, 160),
        responsibilityId: text(query.responsibilityId, 160),
        maxAgeMs: limits.maxAgeMs,
        maxRecordsPerResponsibility: limits.maxRecordsPerResponsibility,
        nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
      });
      return { schemaVersion: 1, ...counts };
    }, { mutate: true, db: opts.db });
  }

  /**
   * Deterministically extract & record an execution outcome episode from a
   * Responsibility WorkItem / Attempt / Run / ResultPacket.
   */
  async function extractEpisodeFromExecution(input = {}, opts = {}) {
    const packet = input.packet || null;
    const run = input.run || null;
    const workItem = input.workItem || null;
    const attempt = input.attempt || null;
    const packetState = text(packet?.state, 40);
    const runState = text(run?.state, 40);
    let outcome = text(input.outcome, 40);
    if (!outcome) {
      if (input.repairAttempt && (packetState === 'succeeded' || runState === 'completed')) outcome = 'repaired';
      else if (packetState && OUTCOME_SET.has(packetState)) outcome = packetState;
      else if (runState === 'completed') outcome = 'succeeded';
      else if (runState === 'failed') outcome = 'failed';
      else if (runState === 'cancelled') outcome = 'cancelled';
      else if (attempt?.failureKind === 'unknown_outcome') outcome = 'unknown_outcome';
      else if (workItem?.state === 'blocked') outcome = 'blocked';
      else outcome = 'partial';
    }
    const packetId = text(input.packetId || packet?.packetId, 160);
    const runId = text(input.runId || run?.id || packet?.runId, 160);
    const workItemId = text(input.workItemId || workItem?.id, 160);
    const summary = text(
      input.summary
        || packet?.summary
        || workItem?.contract?.objective
        || `Execution ${outcome}`,
      2000,
    );
    const failureRootCause = text(
      input.failureRootCause
        || attempt?.failureReason
        || (Array.isArray(packet?.blockers) && packet.blockers.length
          ? packet.blockers.map((b) => (typeof b === 'string' ? b : b?.message || JSON.stringify(b))).join('; ')
          : '')
        || workItem?.blockedReason?.message
        || '',
      2000,
    );
    const artifactLinks = normalizeArtifactLinks(
      [
        ...(Array.isArray(input.artifactLinks) ? input.artifactLinks : []),
        ...(Array.isArray(packet?.evidenceRefs)
          ? packet.evidenceRefs.map((ref) => ({ kind: 'evidence', ref, verified: true }))
          : []),
      ],
      { packetId, packetDigest: text(packet?.digest, 160), runId },
    );
    const sourceRef = text(
      input.sourceRef
        || (packetId ? `packet:${packetId}` : runId ? `run:${runId}` : `work-item:${workItemId}`),
      500,
    );
    return recordEpisode({
      ownerPrincipalId: input.ownerPrincipalId,
      organizationId: input.organizationId || workItem?.organizationId,
      projectId: input.projectId || workItem?.projectId || packet?.projectId,
      responsibilityId: input.responsibilityId,
      wakeId: input.wakeId,
      goalId: input.goalId || workItem?.goalId,
      workItemId,
      runId,
      packetId,
      episodeKey: input.episodeKey,
      outcome,
      summary,
      failureRootCause,
      repairAttempt: input.repairAttempt || '',
      repairStatus: input.repairStatus || (input.repairAttempt ? (outcome === 'repaired' || outcome === 'succeeded' ? 'succeeded' : 'attempted') : 'none'),
      artifactLinks,
      keywords: input.keywords,
      sourceType: 'tool_verified',
      sourceRef,
      validUntil: input.validUntil,
      ttlMs: input.ttlMs,
      retentionTier: input.retentionTier,
      occurredAt: input.occurredAt || packet?.createdAt || run?.finalizedAt,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
    }, opts);
  }

  return {
    databasePath: databasePath || null,
    recordEpisode,
    listEpisodicMemories,
    getEpisodicMemory,
    retractEpisodicMemory,
    pruneEpisodicMemory,
    extractEpisodeFromExecution,
  };
}

export const defaultEpisodicMemoryStore = createEpisodicMemoryStore();

export const recordEpisode = (input, opts) => defaultEpisodicMemoryStore.recordEpisode(input, opts);
export const listEpisodicMemories = (query, opts) => defaultEpisodicMemoryStore.listEpisodicMemories(query, opts);
export const getEpisodicMemory = (episodeId, opts) => defaultEpisodicMemoryStore.getEpisodicMemory(episodeId, opts);
export const retractEpisodicMemory = (input, opts) => defaultEpisodicMemoryStore.retractEpisodicMemory(input, opts);
export const pruneEpisodicMemory = (query, opts) => defaultEpisodicMemoryStore.pruneEpisodicMemory(query, opts);
export const extractEpisodeFromExecution = (input, opts) => defaultEpisodicMemoryStore.extractEpisodeFromExecution(input, opts);
