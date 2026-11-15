/**
 * Durable, project-scoped state for the Project Memory Engine.
 *
 * The SQLite database is the commit authority. The Markdown workspace is a
 * repairable projection written only after a successful version commit. This
 * keeps an interrupted file write or a user-edited projection from changing
 * the project truth used by future prompts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PROJECT_MEMORY_DB, PROJECT_MEMORY_DIR } from '../lib/config.mjs';
import { createSerialTaskQueue, writeJsonAtomic, writeTextAtomic } from './fs-utils.mjs';

const DEFAULT_LEASE_MS = 30 * 60_000;
const DEFAULT_RETRY_MS = 5 * 60_000;
const DEFAULT_RETRY_REMAINING = 3;
const LEASE_ENV = 'RAGENT_PROJECT_MEMORY_LEASE_MS';
const RETRY_ENV = 'RAGENT_PROJECT_MEMORY_RETRY_MS';
const RETRIES_ENV = 'RAGENT_PROJECT_MEMORY_RETRIES';

function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export function readProjectMemoryJobOptions(env = process.env) {
  return {
    leaseMs: positiveInt(env?.[LEASE_ENV], DEFAULT_LEASE_MS, 24 * 60 * 60_000),
    retryMs: positiveInt(env?.[RETRY_ENV], DEFAULT_RETRY_MS, 24 * 60 * 60_000),
    retryRemaining: positiveInt(env?.[RETRIES_ENV], DEFAULT_RETRY_REMAINING, 20),
  };
}

function text(value, max = 0) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return max > 0 ? normalized.slice(0, max) : normalized;
}

function iso(now = new Date()) {
  return new Date(now).toISOString();
}

function addMs(now, ms) {
  return new Date(new Date(now).getTime() + ms).toISOString();
}

function id(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function stringify(value, fallback = {}) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stringify(value)).digest('hex');
}
export function projectMemoryConflictMutationDigest(project,changes,expectedVersion) {
  return digest({project,changes,expectedVersion});
}

const FACT_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/**
 * Model output may suggest an identity, but the server owns its namespace.
 * The workspace/root heuristic gives the common relocation fact one stable
 * identity even when an extractor omits the optional hint; other fallbacks
 * remain deterministic without trusting free-form model identifiers.
 */
export function normalizeProjectFactId(hint, kind = 'state', statement = '') {
  const candidate = text(hint, 120)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '');
  if (candidate && FACT_ID_RE.test(candidate)) return candidate;
  const normalizedStatement = text(statement, 1_200).toLowerCase().replace(/\s+/g, ' ');
  if (/(workspace|execution root|working directory|root path)/.test(normalizedStatement)) {
    return 'project.primary_workspace';
  }
  const prefix = ['architecture', 'decision', 'constraint', 'convention', 'state', 'failure'].includes(kind)
    ? kind
    : 'state';
  return `${prefix}.${digest(normalizedStatement).slice(0, 24)}`;
}

function begin(db) {
  db.exec('BEGIN IMMEDIATE');
}

function rollback(db) {
  try { db.exec('ROLLBACK'); } catch {}
}

function rowJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    state: row.state,
    ownershipToken: row.ownership_token || '',
    leaseUntil: row.lease_until || '',
    attempt: row.attempt || 0,
    retryRemaining: row.retry_remaining || 0,
    retryAt: row.retry_at || '',
    sourceWatermark: Number(row.source_watermark || 0),
    extractionWatermark: Number(row.extraction_watermark || 0),
    consolidationWatermark: Number(row.consolidation_watermark || 0),
    committedVersion: Number(row.committed_version || 0),
    payload: parse(row.payload_json, {}),
    error: row.error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowStage(row) {
  if (!row) return null;
  return {
    sequence: Number(row.stage_sequence || 0),
    id: row.id,
    projectId: row.project_id,
    workspaceId: row.workspace_id || '',
    taskId: row.task_id || '',
    sessionId: row.session_id || '',
    runId: row.run_id || '',
    provider: row.provider || '',
    deviceId: row.device_id || '',
    sourceEventStart: Number(row.source_event_start || 0),
    sourceEventEnd: Number(row.source_event_end || 0),
    sourceDigest: row.source_digest,
    sessionSummary: row.session_summary || '',
    taskStatus: row.task_status || 'unknown',
    candidates: parse(row.candidates_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowVersion(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    version: Number(row.version || 0),
    parentVersion: Number(row.parent_version || 0),
    sourceWatermark: Number(row.source_watermark || 0),
    extractionWatermark: Number(row.extraction_watermark ?? row.source_watermark ?? 0),
    consolidationWatermark: Number(row.consolidation_watermark ?? row.source_watermark ?? 0),
    content: row.content || '',
    summary: row.summary || '',
    facts: parse(row.facts_json, []),
    workspaceSnapshot: parse(row.workspace_snapshot_json, {}),
    candidateIds: parse(row.candidate_ids_json, []),
    digest: row.content_digest || '',
    createdAt: row.created_at,
  };
}

function rowCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    stage1Id: row.stage1_id,
    kind: row.kind,
    factId: row.fact_id || '',
    statement: row.statement,
    confidence: row.confidence,
    sourceEventStart: Number(row.source_event_start || 0),
    sourceEventEnd: Number(row.source_event_end || 0),
    state: row.state,
  };
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS project_memory (
      project_id TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL DEFAULT 0,
      source_watermark INTEGER NOT NULL DEFAULT 0,
      extraction_watermark INTEGER NOT NULL DEFAULT 0,
      consolidation_watermark INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      facts_json TEXT NOT NULL DEFAULT '[]',
      workspace_snapshot_json TEXT NOT NULL DEFAULT '{}',
      content_digest TEXT NOT NULL DEFAULT '',
      projection_state TEXT NOT NULL DEFAULT 'clean',
      projection_error TEXT NOT NULL DEFAULT '',
      projected_version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_stage1 (
      stage_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      task_id TEXT,
      session_id TEXT,
      run_id TEXT,
      provider TEXT,
      device_id TEXT,
      source_event_start INTEGER NOT NULL DEFAULT 0,
      source_event_end INTEGER NOT NULL DEFAULT 0,
      source_digest TEXT NOT NULL,
      session_summary TEXT NOT NULL,
      task_status TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, session_id, run_id, source_digest)
    );
    CREATE INDEX IF NOT EXISTS memory_stage1_project_sequence
      ON memory_stage1(project_id, stage_sequence);

    CREATE TABLE IF NOT EXISTS memory_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      ownership_token TEXT,
      lease_until TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      retry_remaining INTEGER NOT NULL DEFAULT 3,
      retry_at TEXT,
      source_watermark INTEGER NOT NULL DEFAULT 0,
      extraction_watermark INTEGER NOT NULL DEFAULT 0,
      consolidation_watermark INTEGER NOT NULL DEFAULT 0,
      committed_version INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_jobs_claim
      ON memory_jobs(kind, state, retry_at, lease_until, updated_at);

    CREATE TABLE IF NOT EXISTS memory_versions (
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      parent_version INTEGER NOT NULL DEFAULT 0,
      source_watermark INTEGER NOT NULL DEFAULT 0,
      extraction_watermark INTEGER NOT NULL DEFAULT 0,
      consolidation_watermark INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      summary TEXT NOT NULL,
      facts_json TEXT NOT NULL DEFAULT '[]',
      workspace_snapshot_json TEXT NOT NULL DEFAULT '{}',
      candidate_ids_json TEXT NOT NULL DEFAULT '[]',
      content_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, version)
    );

    CREATE TABLE IF NOT EXISTS memory_candidates (
      id TEXT PRIMARY KEY,
      stage1_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      statement TEXT NOT NULL,
      fact_id TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL,
      source_event_start INTEGER NOT NULL DEFAULT 0,
      source_event_end INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'unresolved',
      resolved_version INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(stage1_id, statement)
    );
    CREATE INDEX IF NOT EXISTS memory_candidates_project_state
      ON memory_candidates(project_id, state, created_at);

    CREATE TABLE IF NOT EXISTS memory_fact_provenance (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      memory_version INTEGER NOT NULL,
      section_name TEXT NOT NULL,
      fact_text TEXT NOT NULL,
      fact_id TEXT NOT NULL DEFAULT '',
      fact_key TEXT NOT NULL DEFAULT '',
      fact_value TEXT NOT NULL DEFAULT '',
      fact_version INTEGER NOT NULL DEFAULT 0,
      fact_state TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      stage1_id TEXT NOT NULL,
      session_id TEXT,
      run_id TEXT,
      provider TEXT,
      source_event_start INTEGER NOT NULL DEFAULT 0,
      source_event_end INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_provenance_project_version
      ON memory_fact_provenance(project_id, memory_version);

    CREATE TABLE IF NOT EXISTS memory_facts (
      project_id TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      current_version INTEGER NOT NULL,
      fact_value TEXT NOT NULL,
      fact_state TEXT NOT NULL,
      supersedes_fact_version INTEGER,
      contested_by TEXT NOT NULL DEFAULT '',
      candidate_ids_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, fact_id)
    );

    CREATE TABLE IF NOT EXISTS memory_user_overrides (
      project_id TEXT NOT NULL, fact_id TEXT NOT NULL, action TEXT NOT NULL,
      fact_value TEXT NOT NULL, actor_id TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, fact_id)
    );
    CREATE TABLE IF NOT EXISTS memory_user_mutations (
      project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
      payload_digest TEXT NOT NULL, memory_version INTEGER NOT NULL,
      PRIMARY KEY(project_id, actor_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS memory_conflict_reviews (
      project_id TEXT NOT NULL, group_key TEXT NOT NULL, fact_signature TEXT NOT NULL,
      fact_ids_json TEXT NOT NULL, actor_id TEXT NOT NULL, memory_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(project_id,group_key)
    );
    CREATE TABLE IF NOT EXISTS memory_conflict_review_events (
      project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
      group_key TEXT NOT NULL, fact_signature TEXT NOT NULL, changes_json TEXT NOT NULL,
      memory_version INTEGER NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(project_id,actor_id,request_id)
    );

    CREATE TABLE IF NOT EXISTS memory_fact_versions (
      project_id TEXT NOT NULL,
      fact_id TEXT NOT NULL,
      memory_version INTEGER NOT NULL,
      fact_version INTEGER NOT NULL,
      fact_key TEXT NOT NULL,
      fact_value TEXT NOT NULL,
      fact_state TEXT NOT NULL,
      supersedes_fact_version INTEGER,
      contested_by TEXT NOT NULL DEFAULT '',
      candidate_ids_json TEXT NOT NULL DEFAULT '[]',
      section_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, fact_id, memory_version)
    );

    CREATE TABLE IF NOT EXISTS memory_fresh_deltas (
      project_id TEXT PRIMARY KEY,
      base_version INTEGER NOT NULL DEFAULT 0,
      consolidation_watermark INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '',
      candidate_ids_json TEXT NOT NULL DEFAULT '[]',
      generated_at TEXT NOT NULL
    );
  `);

  // Development databases created before the Gate B correction used a
  // single source watermark. Preserve them while making the two lifecycles
  // explicit for all new reads and writes.
  const columns = (table) => new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
  );
  const addColumn = (table, name, definition) => {
    if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  addColumn('project_memory', 'extraction_watermark', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('project_memory', 'consolidation_watermark', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('project_memory', 'projection_state', "TEXT NOT NULL DEFAULT 'clean'");
  addColumn('project_memory', 'projection_error', "TEXT NOT NULL DEFAULT ''");
  addColumn('project_memory', 'projected_version', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('project_memory', 'facts_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('memory_jobs', 'extraction_watermark', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('memory_jobs', 'consolidation_watermark', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('memory_versions', 'extraction_watermark', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('memory_versions', 'consolidation_watermark', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('memory_versions', 'facts_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('memory_candidates', 'fact_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_fact_provenance', 'fact_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_fact_provenance', 'fact_key', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_fact_provenance', 'fact_value', "TEXT NOT NULL DEFAULT ''");
  addColumn('memory_fact_provenance', 'fact_version', 'INTEGER NOT NULL DEFAULT 0');
  for (const row of db.prepare(`SELECT id, kind, statement FROM memory_candidates WHERE fact_id = ''`).all()) {
    db.prepare('UPDATE memory_candidates SET fact_id = ? WHERE id = ?')
      .run(normalizeProjectFactId('', row.kind, row.statement), row.id);
  }
  db.exec(`
    UPDATE project_memory
    SET extraction_watermark = CASE WHEN extraction_watermark = 0 THEN source_watermark ELSE extraction_watermark END,
        consolidation_watermark = CASE WHEN consolidation_watermark = 0 THEN source_watermark ELSE consolidation_watermark END
    WHERE source_watermark > 0;
    UPDATE project_memory SET projection_state = 'dirty'
      WHERE current_version > 0 AND projected_version = 0;
  `);
}

function normalizeStageInput(input = {}) {
  const projectId = text(input.projectId, 160);
  const sessionId = text(input.sessionId, 160);
  const runId = text(input.runId, 160);
  const sourceDigest = text(input.sourceDigest, 128);
  if (!projectId || !sessionId || !runId || !sourceDigest) {
    throw new Error('Project memory extraction requires projectId, sessionId, runId, and sourceDigest');
  }
  return {
    projectId,
    workspaceId: text(input.workspaceId, 160),
    taskId: text(input.taskId, 160),
    sessionId,
    runId,
    provider: text(input.provider, 160),
    deviceId: text(input.deviceId, 160),
    sourceEventStart: Number.isInteger(input.sourceEventStart) ? Math.max(0, input.sourceEventStart) : 0,
    sourceEventEnd: Number.isInteger(input.sourceEventEnd) ? Math.max(0, input.sourceEventEnd) : 0,
    sourceDigest,
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
  };
}

export function projectMemoryProjectionPaths(projectId, workspaceRoot = PROJECT_MEMORY_DIR) {
  const safeProjectId = text(projectId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    root: join(workspaceRoot, safeProjectId),
    memory: join(workspaceRoot, safeProjectId, 'MEMORY.md'),
    summary: join(workspaceRoot, safeProjectId, 'memory_summary.md'),
    state: join(workspaceRoot, safeProjectId, 'state.json'),
  };
}

export function createProjectMemoryStore(options = {}) {
  const databasePath = options.databasePath || PROJECT_MEMORY_DB;
  const workspaceRoot = options.workspaceRoot || PROJECT_MEMORY_DIR;
  const mutationQueue = createSerialTaskQueue();
  const projectionQueue = createSerialTaskQueue();
  const projectionTextWriter = options.writeTextAtomic || writeTextAtomic;
  const projectionJsonWriter = options.writeJsonAtomic || writeJsonAtomic;

  function open() {
    const db = new DatabaseSync(databasePath);
    ensureSchema(db);
    return db;
  }

  async function withDatabase(fn, { mutate = false } = {}) {
    const run = async () => {
      const db = open();
      try { return await fn(db); } finally { db.close(); }
    };
    return mutate ? mutationQueue(run) : run();
  }

  async function initialize() {
    await mkdir(dirname(databasePath), { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await withDatabase(() => undefined, { mutate: true });
    await repairDirtyProjections();
  }

  async function repairDirtyProjections() {
    const rows = await withDatabase((db) => db.prepare(`SELECT project_id, current_version
      FROM project_memory WHERE current_version > 0
        AND (projection_state != 'clean' OR projected_version != current_version)
      ORDER BY project_id`).all());
    const results = [];
    for (const row of rows) {
      try {
        const version = await getMemoryVersion(row.project_id, row.current_version);
        if (!version) throw new Error('Project Memory head version is missing');
        await writeProjection(version);
        results.push({ projectId: row.project_id, version: row.current_version, ok: true });
      } catch (error) {
        await markProjectionDirty(row.project_id, error?.message || String(error), row.current_version).catch(() => {});
        results.push({ projectId: row.project_id, version: row.current_version, ok: false, error: error?.message || String(error) });
      }
    }
    return results;
  }

  async function enqueueExtraction(input) {
    const normalized = normalizeStageInput(input);
    const dedupeKey = `extract:${normalized.projectId}:${normalized.sessionId}:${normalized.runId}:${normalized.sourceDigest}`;
    const now = iso();
    const jobOptions = readProjectMemoryJobOptions();
    return withDatabase((db) => {
      begin(db);
      try {
        const existing = db.prepare('SELECT * FROM memory_jobs WHERE dedupe_key = ?').get(dedupeKey);
        if (existing) {
          const job = rowJob(existing);
          // A duplicate source is not a manual retry. Preserve error/backoff
          // so repeated terminal notifications cannot create a hot loop.
          db.exec('COMMIT');
          return job;
        }
        const job = {
          id: id('pmjob'),
          projectId: normalized.projectId,
          kind: 'extract',
          dedupeKey,
          state: 'pending',
          retryRemaining: jobOptions.retryRemaining,
          sourceWatermark: 0,
          payload: { ...normalized.payload, scope: normalized },
          createdAt: now,
          updatedAt: now,
        };
        db.prepare(`INSERT INTO memory_jobs
          (id, project_id, kind, dedupe_key, state, retry_remaining, source_watermark,
           extraction_watermark, consolidation_watermark, payload_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(job.id, job.projectId, job.kind, job.dedupeKey, job.state, job.retryRemaining,
            job.sourceWatermark, 0, 0, stringify(job.payload), now, now);
        db.exec('COMMIT');
        return job;
      } catch (error) {
        rollback(db);
        throw error;
      }
    }, { mutate: true });
  }

  async function enqueueConsolidation(projectId, payload = {}) {
    const normalizedProjectId = text(projectId, 160);
    if (!normalizedProjectId) throw new Error('Project memory consolidation requires projectId');
    const dedupeKey = `consolidate:${normalizedProjectId}`;
    const now = iso();
    const jobOptions = readProjectMemoryJobOptions();
    return withDatabase((db) => {
      begin(db);
      try {
        const existing = db.prepare('SELECT * FROM memory_jobs WHERE dedupe_key = ?').get(dedupeKey);
        if (!existing) {
          const job = {
            id: id('pmjob'), projectId: normalizedProjectId, kind: 'consolidate', dedupeKey,
            state: 'pending', retryRemaining: jobOptions.retryRemaining, sourceWatermark: 0,
            payload, createdAt: now, updatedAt: now,
          };
          db.prepare(`INSERT INTO memory_jobs
            (id, project_id, kind, dedupe_key, state, retry_remaining, source_watermark,
             extraction_watermark, consolidation_watermark, payload_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(job.id, job.projectId, job.kind, job.dedupeKey, job.state, job.retryRemaining,
              0, 0, 0, stringify(payload), now, now);
          db.exec('COMMIT');
          return job;
        }
        const previous = rowJob(existing);
        if (previous.state === 'succeeded') {
          db.prepare(`UPDATE memory_jobs
            SET state = 'pending', retry_at = NULL, error = '', retry_remaining = ?, committed_version = 0,
                payload_json = ?, updated_at = ?
            WHERE id = ?`).run(jobOptions.retryRemaining, stringify(payload), now, previous.id);
          db.exec('COMMIT');
          return { ...previous, state: 'pending', retryAt: '', error: '', retryRemaining: jobOptions.retryRemaining, payload };
        }
        if (previous.state === 'pending') {
          db.prepare(`UPDATE memory_jobs SET payload_json = ?, updated_at = ? WHERE id = ?`)
            .run(stringify(payload), now, previous.id);
          db.exec('COMMIT');
          return { ...previous, payload, updatedAt: now };
        }
        if (previous.state === 'error') {
          // Keep retry_at/retry_remaining intact. claimNextJob will retry when
          // backoff expires; exhausted jobs need a genuinely new Stage 1
          // source to be reopened by completeExtraction.
          db.prepare(`UPDATE memory_jobs SET payload_json = ?, updated_at = ? WHERE id = ?`)
            .run(stringify(payload), now, previous.id);
          db.exec('COMMIT');
          return { ...previous, payload, updatedAt: now };
        }
        db.exec('COMMIT');
        return previous;
      } catch (error) {
        rollback(db);
        throw error;
      }
    }, { mutate: true });
  }

  async function claimNextJob({ kind = '', projectId = '', now = new Date(), leaseMs = readProjectMemoryJobOptions().leaseMs } = {}) {
    const current = iso(now);
    const normalizedKind = text(kind, 40);
    const normalizedProjectId = text(projectId, 160);
    return withDatabase((db) => {
      begin(db);
      try {
        const clauses = [
          "(state = 'pending' OR (state = 'error' AND (retry_at IS NULL OR retry_at <= ?)) OR (state = 'running' AND lease_until <= ?))",
          "retry_remaining > 0",
        "(retry_at IS NULL OR retry_at <= ?)",
      ];
        const values = [current, current, current];
        if (normalizedKind) {
          clauses.push('kind = ?');
          values.push(normalizedKind);
        }
        if (normalizedProjectId) {
          clauses.push('project_id = ?');
          values.push(normalizedProjectId);
        }
        const row = db.prepare(`SELECT * FROM memory_jobs WHERE ${clauses.join(' AND ')} ORDER BY created_at, id LIMIT 1`).get(...values);
        if (!row) {
          db.exec('COMMIT');
          return null;
        }
        const ownershipToken = id('pmlease');
        const leaseUntil = addMs(now, leaseMs);
        const changed = db.prepare(`UPDATE memory_jobs
          SET state = 'running', ownership_token = ?, lease_until = ?, attempt = attempt + 1,
              retry_at = NULL, updated_at = ?
          WHERE id = ? AND (state = 'pending' OR state = 'error' OR lease_until <= ?)`)
          .run(ownershipToken, leaseUntil, current, row.id, current);
        if (changed.changes !== 1) {
          db.exec('COMMIT');
          return null;
        }
        const claimed = rowJob(db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(row.id));
        db.exec('COMMIT');
        return claimed;
      } catch (error) {
        rollback(db);
        throw error;
      }
    }, { mutate: true });
  }

  async function heartbeatJob(jobId, ownershipToken, { now = new Date(), leaseMs = DEFAULT_LEASE_MS } = {}) {
    const current = iso(now);
    return withDatabase((db) => {
      const result = db.prepare(`UPDATE memory_jobs SET lease_until = ?, updated_at = ?
        WHERE id = ? AND state = 'running' AND ownership_token = ?`)
        .run(addMs(now, leaseMs), current, text(jobId), text(ownershipToken));
      return result.changes === 1;
    }, { mutate: true });
  }

  async function failJob(jobId, ownershipToken, error, { now = new Date(), retryMs = readProjectMemoryJobOptions().retryMs } = {}) {
    const current = iso(now);
    return withDatabase((db) => {
      begin(db);
      try {
        const row = db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(text(jobId));
        if (!row || row.state !== 'running' || row.ownership_token !== text(ownershipToken)) {
          db.exec('COMMIT');
          return false;
        }
        const remaining = Math.max(0, Number(row.retry_remaining || 0) - 1);
        db.prepare(`UPDATE memory_jobs SET state = 'error', ownership_token = NULL, lease_until = NULL,
          retry_remaining = ?, retry_at = ?, error = ?, updated_at = ? WHERE id = ?`)
          .run(remaining, remaining > 0 ? addMs(now, retryMs) : null, text(error, 800), current, row.id);
        db.exec('COMMIT');
        return true;
      } catch (caught) {
        rollback(db);
        throw caught;
      }
    }, { mutate: true });
  }

  async function completeExtraction(jobId, ownershipToken, result, { now = new Date() } = {}) {
    const sessionSummary = text(result?.sessionSummary, 8_000);
    const taskStatus = ['active', 'completed', 'blocked', 'unknown'].includes(result?.taskStatus)
      ? result.taskStatus
      : 'unknown';
    const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
    const current = iso(now);
    return withDatabase((db) => {
      begin(db);
      try {
        const jobRow = db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(text(jobId));
        const job = rowJob(jobRow);
        if (!job || job.kind !== 'extract' || job.state !== 'running' || job.ownershipToken !== text(ownershipToken)) {
          throw new Error('Project memory extraction job ownership was lost');
        }
        const scope = job.payload?.scope || {};
        const stageInput = normalizeStageInput({ ...scope, payload: job.payload });
        let stage = db.prepare(`SELECT * FROM memory_stage1
          WHERE project_id = ? AND session_id = ? AND run_id = ? AND source_digest = ?`)
          .get(stageInput.projectId, stageInput.sessionId, stageInput.runId, stageInput.sourceDigest);
        if (!stage) {
          const stageId = id('pmstage');
          db.prepare(`INSERT INTO memory_stage1
            (id, project_id, workspace_id, task_id, session_id, run_id, provider, device_id,
             source_event_start, source_event_end, source_digest, session_summary, task_status,
             candidates_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(stageId, stageInput.projectId, stageInput.workspaceId || null, stageInput.taskId || null,
              stageInput.sessionId, stageInput.runId, stageInput.provider || null, stageInput.deviceId || null,
              stageInput.sourceEventStart, stageInput.sourceEventEnd, stageInput.sourceDigest, sessionSummary,
              taskStatus, stringify(candidates), current, current);
          stage = db.prepare('SELECT * FROM memory_stage1 WHERE id = ?').get(stageId);
          for (const candidate of candidates) {
            const statement = text(candidate?.statement, 1_200);
            if (!statement) continue;
            const kind = ['architecture', 'decision', 'constraint', 'convention', 'state', 'failure'].includes(candidate?.kind)
              ? candidate.kind
              : 'state';
            const confidence = ['verified', 'reported', 'tentative'].includes(candidate?.confidence)
              ? candidate.confidence
              : 'reported';
            const sourceEventStart = Number.isInteger(candidate?.sourceEventStart)
              ? candidate.sourceEventStart
              : stageInput.sourceEventStart;
            const sourceEventEnd = Number.isInteger(candidate?.sourceEventEnd)
              ? candidate.sourceEventEnd
              : stageInput.sourceEventEnd;
            if (sourceEventStart < stageInput.sourceEventStart
              || sourceEventEnd > stageInput.sourceEventEnd
              || sourceEventStart > sourceEventEnd
              || sourceEventStart < 0) {
              throw new Error('Project memory candidate source range is invalid');
            }
            const factId = normalizeProjectFactId(candidate?.factId, kind, statement);
            if (db.prepare('SELECT 1 FROM memory_user_overrides WHERE project_id=? AND fact_id=?').get(stageInput.projectId, factId)) continue;
            db.prepare(`INSERT OR IGNORE INTO memory_candidates
              (id, stage1_id, project_id, kind, statement, fact_id, confidence, source_event_start, source_event_end,
               state, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?, ?)`)
              .run(id('pmcand'), stageId, stageInput.projectId, kind, statement, factId, confidence,
                sourceEventStart, sourceEventEnd,
                current, current);
          }
        }
        const stageSequence = Number(stage.stage_sequence || 0);
        db.prepare(`INSERT INTO project_memory
          (project_id, extraction_watermark, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET
            extraction_watermark = MAX(project_memory.extraction_watermark, excluded.extraction_watermark),
            updated_at = excluded.updated_at`)
          .run(stageInput.projectId, stageSequence, current);
        // Canonical history remains the raw source. A successful job retains
        // only its scope and extracted evidence, including the nested copy.
        const retainedScope = { ...job.payload.scope };
        if (retainedScope.payload && typeof retainedScope.payload === 'object') {
          retainedScope.payload = { ...retainedScope.payload, events: [] };
        }
        const retainedPayload = { ...job.payload, events: [], scope: retainedScope };
        db.prepare(`UPDATE memory_jobs SET state = 'succeeded', ownership_token = NULL, lease_until = NULL,
          payload_json = ?, error = '', updated_at = ? WHERE id = ?`)
          .run(stringify(retainedPayload), current, job.id);
        const consolidationKey = `consolidate:${stageInput.projectId}`;
        const consolidationPayload = {
          trigger: 'TASK_COMPLETE',
          runtime: job.payload.runtime || {},
          workspaceSnapshot: job.payload.workspaceSnapshot || {},
        };
        const existing = db.prepare('SELECT * FROM memory_jobs WHERE dedupe_key = ?').get(consolidationKey);
        if (existing) {
          const retryRemaining = readProjectMemoryJobOptions().retryRemaining;
          if (existing.state === 'succeeded'
            || (existing.state === 'error' && Number(existing.retry_remaining || 0) <= 0)) {
            db.prepare(`UPDATE memory_jobs SET state = 'pending', retry_remaining = ?, retry_at = NULL,
              error = '', committed_version = 0, updated_at = ? WHERE id = ?`)
              .run(retryRemaining, current, existing.id);
          }
          if (existing.state !== 'running') {
            db.prepare('UPDATE memory_jobs SET payload_json = ?, updated_at = ? WHERE id = ?')
              .run(stringify(consolidationPayload), current, existing.id);
          }
        } else {
          const retryRemaining = readProjectMemoryJobOptions().retryRemaining;
          db.prepare(`INSERT INTO memory_jobs
            (id, project_id, kind, dedupe_key, state, retry_remaining, source_watermark,
             extraction_watermark, consolidation_watermark, payload_json, created_at, updated_at)
            VALUES (?, ?, 'consolidate', ?, 'pending', ?, 0, 0, 0, ?, ?, ?)`)
            .run(id('pmjob'), stageInput.projectId, consolidationKey, retryRemaining,
              stringify(consolidationPayload), current, current);
        }
        db.exec('COMMIT');
        return rowStage(stage);
      } catch (error) {
        rollback(db);
        throw error;
      }
    }, { mutate: true });
  }

  async function getConsolidationInput(projectId) {
    const normalizedProjectId = text(projectId, 160);
    return withDatabase((db) => {
      const head = db.prepare('SELECT * FROM project_memory WHERE project_id = ?').get(normalizedProjectId);
      const extractionWatermark = Number(head?.extraction_watermark ?? head?.source_watermark ?? 0);
      const consolidationWatermark = Number(head?.consolidation_watermark ?? head?.source_watermark ?? 0);
      const stages = db.prepare(`SELECT * FROM memory_stage1
        WHERE project_id = ? AND stage_sequence > ? ORDER BY stage_sequence ASC`).all(normalizedProjectId, consolidationWatermark).map(rowStage);
      const candidateRows = stages.length
        ? db.prepare(`SELECT * FROM memory_candidates WHERE project_id = ? AND stage1_id IN (${stages.map(() => '?').join(',')}) ORDER BY created_at, id`)
          .all(normalizedProjectId, ...stages.map((stage) => stage.id))
        : [];
      const priorCandidateRows = db.prepare(`SELECT * FROM memory_candidates
        WHERE project_id = ? AND state IN ('active', 'contested') ORDER BY updated_at, id`)
        .all(normalizedProjectId);
      return {
        projectId: normalizedProjectId,
        hasUserOverrides: !!db.prepare('SELECT 1 FROM memory_user_overrides WHERE project_id=? LIMIT 1').get(normalizedProjectId),
        head: head ? {
          projectId: head.project_id,
          currentVersion: Number(head.current_version || 0),
          sourceWatermark: consolidationWatermark,
          extractionWatermark,
          consolidationWatermark,
          content: head.content || '',
          summary: head.summary || '',
          workspaceSnapshot: parse(head.workspace_snapshot_json, {}),
          digest: head.content_digest || '',
          projectionState: head.projection_state || 'clean',
          projectionError: head.projection_error || '',
          projectedVersion: Number(head.projected_version || 0),
          updatedAt: head.updated_at,
        } : null,
        stages,
        candidates: candidateRows.map(rowCandidate),
        priorCandidates: priorCandidateRows.map(rowCandidate),
        nextWatermark: stages.at(-1)?.sequence || consolidationWatermark,
        extractionWatermark,
        consolidationWatermark,
      };
    });
  }

  async function commitConsolidation(jobId, ownershipToken, value, { now = new Date() } = {}) {
    const current = iso(now);
    let content = text(value?.content, 60_000);
    let summary = text(value?.summary, 8_000);
    const consolidationWatermark = Number.isInteger(value?.consolidationWatermark)
      ? Math.max(0, value.consolidationWatermark)
      : (Number.isInteger(value?.sourceWatermark) ? Math.max(0, value.sourceWatermark) : 0);
    const requestedExtractionWatermark = Number.isInteger(value?.extractionWatermark)
      ? Math.max(0, value.extractionWatermark)
      : null;
    const workspaceSnapshot = value?.workspaceSnapshot && typeof value.workspaceSnapshot === 'object'
      ? value.workspaceSnapshot
      : {};
    const candidateIds = [...new Set((Array.isArray(value?.candidateIds) ? value.candidateIds : []).map((entry) => text(entry, 160)).filter(Boolean))];
    const resolutions = Array.isArray(value?.resolutions) ? value.resolutions : [];
    const factResolutions = Array.isArray(value?.factResolutions) ? value.factResolutions : [];
    const facts = Array.isArray(value?.facts) ? value.facts : [];
    if (!content || !summary.startsWith('v1')) throw new Error('Project memory consolidation output is invalid');
    return withDatabase((db) => {
      begin(db);
      try {
        const job = rowJob(db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(text(jobId)));
        if (!job || job.kind !== 'consolidate' || job.state !== 'running' || job.ownershipToken !== text(ownershipToken)) {
          throw new Error('Project memory consolidation job ownership was lost');
        }
        const input = getConsolidationInputSync(db, job.projectId);
        const expectedWatermark = input.stages.at(-1)?.sequence || input.consolidationWatermark;
        const extractionWatermark = requestedExtractionWatermark ?? input.extractionWatermark;
        if (consolidationWatermark !== expectedWatermark
          || extractionWatermark < consolidationWatermark
          || extractionWatermark < input.extractionWatermark) {
          throw new Error('Project memory consolidation attempted an invalid watermark');
        }
        const allowedCandidates = new Set([...input.candidates, ...input.priorCandidates].map((candidate) => candidate.id));
        if (candidateIds.some((candidateId) => !allowedCandidates.has(candidateId))) {
          throw new Error('Project memory consolidation references a candidate outside its watermark');
        }
        const head = input.head;
        const version = Number(head?.currentVersion || 0) + 1;
        let stampedSummary = /^v\d+\b/.test(summary)
          ? summary.replace(/^v\d+\b/, `v${version}`)
          : `v${version}\n${summary}`;
        const normalizedFactResolutions = new Map();
        for (const resolution of factResolutions) {
          const hint = text(resolution?.factId, 120);
          if (!hint) continue;
          const factId = normalizeProjectFactId(hint, resolution?.kind, resolution?.value);
          if (factId) normalizedFactResolutions.set(factId, {
            state: ['active', 'superseded', 'contested', 'invalidated'].includes(resolution?.state)
              ? resolution.state : 'contested',
            contestedBy: text(resolution?.contestedBy, 160),
          });
        }
        const normalizedFacts = [];
        const factIds = new Set();
        for (const fact of facts.slice(0, 160)) {
          const factText = text(fact?.text || fact?.factValue, 1_200);
          if (!factText) continue;
          const candidateIdList = [...new Set((Array.isArray(fact?.candidateIds) ? fact.candidateIds : [])
            .map((candidateId) => text(candidateId, 160)).filter((candidateId) => allowedCandidates.has(candidateId)))];
          const candidateHint = candidateIdList.map((candidateId) => input.candidates.find((candidate) => candidate.id === candidateId)
            || input.priorCandidates.find((candidate) => candidate.id === candidateId)).find(Boolean);
          const factId = normalizeProjectFactId(fact?.factId || candidateHint?.factId, candidateHint?.kind, factText);
          if (factIds.has(factId)) continue;
          factIds.add(factId);
          normalizedFacts.push({
            factId,
            factKey: text(fact?.factKey, 160) || factId,
            factValue: text(fact?.factValue, 1_200) || factText,
            section: text(fact?.section, 120),
            text: factText,
            state: normalizedFactResolutions.get(factId)?.state
              || (['active', 'superseded', 'contested', 'invalidated'].includes(fact?.state) ? fact.state : 'active'),
            contestedBy: normalizedFactResolutions.get(factId)?.contestedBy || text(fact?.contestedBy, 160),
            supersedesFactVersion: Number.isInteger(fact?.supersedesFactVersion)
              ? Math.max(0, fact.supersedesFactVersion) : null,
            candidateIds: candidateIdList,
          });
        }
        // Once a user has corrected or retracted a fact, generated prose may
        // still contain the old value. Rebuild the injectable projection from
        // structured facts and apply the user's scoped overrides each time.
        const overrides = db.prepare('SELECT * FROM memory_user_overrides WHERE project_id=? ORDER BY fact_id').all(job.projectId);
        for (const override of overrides) {
          const index = normalizedFacts.findIndex(fact => fact.factId === override.fact_id);
          const previous = db.prepare('SELECT * FROM memory_facts WHERE project_id=? AND fact_id=?').get(job.projectId, override.fact_id);
          const fact = { factId: override.fact_id, factKey: previous?.fact_key || override.fact_id,
            factValue: override.action === 'correct' ? override.fact_value : '', text: override.action === 'correct' ? override.fact_value : '',
            state: override.action === 'correct' ? 'active' : 'invalidated', contestedBy: '',
            supersedesFactVersion: Number(previous?.current_version || 0) || null, candidateIds: [], section: 'user' };
          if (index < 0) normalizedFacts.push(fact); else normalizedFacts[index] = fact;
        }
        if (overrides.length) {
          const visible = normalizedFacts.filter(fact => fact.state === 'active' && fact.factValue);
          content = `# Project Memory\n\n${visible.map(fact => `- ${fact.factValue}`).join('\n') || 'No active structured facts.'}`;
          summary = `v${version}\n${visible.map(fact => `- ${fact.factValue}`).join('\n') || 'No active structured facts.'}`;
          stampedSummary = summary;
        }
        const outputDigest = digest({
          content, stampedSummary, extractionWatermark, consolidationWatermark, candidateIds, normalizedFacts, workspaceSnapshot,
        });
        db.prepare(`INSERT INTO memory_versions
          (project_id, version, parent_version, source_watermark, extraction_watermark, consolidation_watermark,
           content, summary, facts_json, workspace_snapshot_json, candidate_ids_json, content_digest, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(job.projectId, version, Number(head?.currentVersion || 0), consolidationWatermark,
            extractionWatermark, consolidationWatermark, content, stampedSummary, stringify(normalizedFacts),
            stringify(workspaceSnapshot), stringify(candidateIds), outputDigest, current);
        db.prepare(`INSERT INTO project_memory
          (project_id, current_version, source_watermark, extraction_watermark, consolidation_watermark,
           content, summary, facts_json, workspace_snapshot_json, content_digest, projection_state, projection_error,
           projected_version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dirty', '', ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET current_version = excluded.current_version,
            source_watermark = excluded.source_watermark,
            extraction_watermark = MAX(project_memory.extraction_watermark, excluded.extraction_watermark),
            consolidation_watermark = excluded.consolidation_watermark,
            content = excluded.content, summary = excluded.summary, facts_json = excluded.facts_json,
            workspace_snapshot_json = excluded.workspace_snapshot_json, content_digest = excluded.content_digest,
            projection_state = 'dirty', projection_error = '',
            projected_version = project_memory.projected_version,
            updated_at = excluded.updated_at`)
          .run(job.projectId, version, consolidationWatermark, extractionWatermark, consolidationWatermark,
            content, stampedSummary, stringify(normalizedFacts), stringify(workspaceSnapshot), outputDigest,
            Number(head?.projectedVersion || 0), current);
        for (const resolution of resolutions) {
          const candidateId = text(resolution?.candidateId, 160);
          if (!candidateId || !allowedCandidates.has(candidateId)) continue;
          const state = ['active', 'superseded', 'contested', 'invalidated'].includes(resolution?.state)
            ? resolution.state
            : 'contested';
          db.prepare(`UPDATE memory_candidates SET state = ?, resolved_version = ?, updated_at = ? WHERE id = ?`)
            .run(state, version, current, candidateId);
        }
        db.prepare(`UPDATE memory_candidates SET state='invalidated',resolved_version=?,updated_at=?
          WHERE project_id=? AND fact_id IN (SELECT fact_id FROM memory_user_overrides WHERE project_id=?)`).run(version,current,job.projectId,job.projectId);
        const recordFact = (fact) => {
          const previous = db.prepare(`SELECT * FROM memory_facts WHERE project_id = ? AND fact_id = ?`)
            .get(job.projectId, fact.factId);
          const factVersion = Number(previous?.current_version || 0) + 1;
          const supersedesFactVersion = fact.supersedesFactVersion
            || (previous && (previous.fact_value !== fact.factValue || previous.fact_state !== fact.state)
              ? Number(previous.current_version) : null);
          db.prepare(`INSERT INTO memory_fact_versions
            (project_id, fact_id, memory_version, fact_version, fact_key, fact_value, fact_state,
             supersedes_fact_version, contested_by, candidate_ids_json, section_name, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(job.projectId, fact.factId, version, factVersion, fact.factKey, fact.factValue, fact.state,
              supersedesFactVersion, fact.contestedBy || '', stringify(fact.candidateIds), fact.section || '', current);
          db.prepare(`INSERT INTO memory_facts
            (project_id, fact_id, fact_key, current_version, fact_value, fact_state,
             supersedes_fact_version, contested_by, candidate_ids_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, fact_id) DO UPDATE SET
              fact_key = excluded.fact_key, current_version = excluded.current_version,
              fact_value = excluded.fact_value, fact_state = excluded.fact_state,
              supersedes_fact_version = excluded.supersedes_fact_version,
              contested_by = excluded.contested_by, candidate_ids_json = excluded.candidate_ids_json,
              updated_at = excluded.updated_at`)
            .run(job.projectId, fact.factId, fact.factKey, factVersion, fact.factValue, fact.state,
              supersedesFactVersion, fact.contestedBy || '', stringify(fact.candidateIds), current);
          for (const candidateId of fact.candidateIds) {
            const source = db.prepare(`SELECT c.stage1_id, s.session_id, s.run_id, s.provider,
              c.source_event_start, c.source_event_end FROM memory_candidates c
              JOIN memory_stage1 s ON s.id = c.stage1_id WHERE c.id = ?`).get(candidateId);
            if (!source) continue;
            db.prepare(`INSERT INTO memory_fact_provenance
              (id, project_id, memory_version, section_name, fact_text, fact_id, fact_key, fact_value,
               fact_version, fact_state, candidate_id, stage1_id, session_id, run_id, provider,
               source_event_start, source_event_end, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(id('pmprov'), job.projectId, version, fact.section || '', fact.text, fact.factId,
                fact.factKey, fact.factValue, factVersion, fact.state, candidateId, source.stage1_id,
                source.session_id || null, source.run_id || null, source.provider || null,
                Number(source.source_event_start || 0), Number(source.source_event_end || 0), current);
          }
          return factVersion;
        };
        for (const fact of normalizedFacts) recordFact(fact);
        // A state-only fact resolution can close or contest a previously
        // current identity even when the Curator omits it from its sections.
        for (const [factId, resolution] of normalizedFactResolutions) {
          if (factIds.has(factId)) continue;
          const previous = db.prepare(`SELECT * FROM memory_facts WHERE project_id = ? AND fact_id = ?`)
            .get(job.projectId, factId);
          if (!previous) continue;
          recordFact({
            factId,
            factKey: previous.fact_key,
            factValue: previous.fact_value,
            section: '',
            text: previous.fact_value,
            state: resolution.state,
            contestedBy: resolution.contestedBy,
            supersedesFactVersion: Number(previous.current_version),
            candidateIds: [],
          });
        }
        // Keep the job leased until the canonical DB transaction is complete;
        // filesystem projection happens after this COMMIT.
        db.prepare(`UPDATE memory_jobs SET committed_version = ?, source_watermark = ?,
          extraction_watermark = ?, consolidation_watermark = ?, updated_at = ? WHERE id = ?`)
          .run(version, consolidationWatermark, extractionWatermark, consolidationWatermark, current, job.id);
        db.exec('COMMIT');
        return getVersionSync(db, job.projectId, version);
      } catch (error) {
        rollback(db);
        throw error;
      }
    }, { mutate: true });
  }

  async function finishCommittedJob(jobId, ownershipToken, { now = new Date() } = {}) {
    const current = iso(now);
    return withDatabase((db) => {
      // An extraction can finish while the curator is writing its projection.
      // Keep new stages runnable instead of losing them behind a succeeded job.
      const result = db.prepare(`UPDATE memory_jobs SET
        state = CASE WHEN EXISTS (SELECT 1 FROM memory_stage1 s
          WHERE s.project_id = memory_jobs.project_id AND s.stage_sequence > memory_jobs.consolidation_watermark)
          THEN 'pending' ELSE 'succeeded' END,
        committed_version = CASE WHEN EXISTS (SELECT 1 FROM memory_stage1 s
          WHERE s.project_id = memory_jobs.project_id AND s.stage_sequence > memory_jobs.consolidation_watermark)
          THEN 0 ELSE committed_version END,
        ownership_token = NULL, lease_until = NULL, error = '', updated_at = ?
        WHERE id = ? AND state = 'running' AND ownership_token = ? AND committed_version > 0`)
        .run(current, text(jobId), text(ownershipToken));
      return result.changes === 1;
    }, { mutate: true });
  }

  async function finishNoopJob(jobId, ownershipToken, { now = new Date() } = {}) {
    const current = iso(now);
    return withDatabase((db) => {
      const result = db.prepare(`UPDATE memory_jobs SET state = 'succeeded', ownership_token = NULL,
        lease_until = NULL, error = '', updated_at = ?
        WHERE id = ? AND state = 'running' AND ownership_token = ? AND committed_version = 0`)
        .run(current, text(jobId), text(ownershipToken));
      return result.changes === 1;
    }, { mutate: true });
  }

  async function markProjectionRepairing(projectId, version = 0, { now = new Date() } = {}) {
    const current = iso(now);
    return withDatabase((db) => {
      const result = db.prepare(`UPDATE project_memory SET projection_state = 'repairing',
        projection_error = '', updated_at = ?
        WHERE project_id = ? AND current_version = ?`)
        .run(current, text(projectId, 160), Number(version || 0));
      return result.changes === 1;
    }, { mutate: true });
  }

  async function markProjectionDirty(projectId, error, version = 0, { now = new Date() } = {}) {
    const current = iso(now);
    return withDatabase((db) => {
      const result = db.prepare(`UPDATE project_memory SET projection_state = 'dirty',
        projection_error = ?, updated_at = ?
        WHERE project_id = ? AND (? = 0 OR current_version = ?)`)
        .run(text(error, 2_000), current, text(projectId, 160), Number(version || 0), Number(version || 0));
      return result.changes === 1;
    }, { mutate: true });
  }

  async function markProjectionClean(projectId, version, { now = new Date() } = {}) {
    const current = iso(now);
    return withDatabase((db) => {
      const result = db.prepare(`UPDATE project_memory SET projection_state = 'clean',
        projection_error = '', projected_version = ?, updated_at = ?
        WHERE project_id = ? AND current_version = ?`)
        .run(Number(version || 0), current, text(projectId, 160), Number(version || 0));
      return result.changes === 1;
    }, { mutate: true });
  }

  async function getProjectMemory(projectId) {
    const normalizedProjectId = text(projectId, 160);
    return withDatabase((db) => {
      const row = db.prepare('SELECT * FROM project_memory WHERE project_id = ?').get(normalizedProjectId);
      if (!row) return null;
      return {
        projectId: row.project_id,
        currentVersion: Number(row.current_version || 0),
        sourceWatermark: Number(row.consolidation_watermark ?? row.source_watermark ?? 0),
        extractionWatermark: Number(row.extraction_watermark ?? row.source_watermark ?? 0),
        consolidationWatermark: Number(row.consolidation_watermark ?? row.source_watermark ?? 0),
        content: row.content || '',
        summary: row.summary || '',
        facts: parse(row.facts_json, []),
        workspaceSnapshot: parse(row.workspace_snapshot_json, {}),
        digest: row.content_digest || '',
        projectionState: row.projection_state || 'clean',
        projectionError: row.projection_error || '',
        projectedVersion: Number(row.projected_version || 0),
        updatedAt: row.updated_at,
      };
    });
  }

  async function getMemoryVersion(projectId, version) {
    return withDatabase((db) => getVersionSync(db, text(projectId, 160), Number(version || 0)));
  }

  async function getFactProvenance(projectId, version) {
    return withDatabase((db) => db.prepare(`SELECT * FROM memory_fact_provenance
      WHERE project_id = ? AND memory_version = ? ORDER BY created_at, id`)
      .all(text(projectId, 160), Number(version || 0)).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        memoryVersion: Number(row.memory_version),
        section: row.section_name,
        fact: row.fact_text,
        factId: row.fact_id || '',
        factKey: row.fact_key || '',
        factValue: row.fact_value || row.fact_text || '',
        factVersion: Number(row.fact_version || 0),
        state: row.fact_state,
        candidateId: row.candidate_id,
        stage1Id: row.stage1_id,
        sessionId: row.session_id || '',
        runId: row.run_id || '',
        provider: row.provider || '',
        sourceEventStart: Number(row.source_event_start || 0),
        sourceEventEnd: Number(row.source_event_end || 0),
        createdAt: row.created_at,
      })));
  }

  async function listCurrentFacts(projectId) {
    return withDatabase((db) => db.prepare(`SELECT * FROM memory_facts
      WHERE project_id = ? ORDER BY fact_id`).all(text(projectId, 160)).map((row) => ({
      projectId: row.project_id,
      factId: row.fact_id,
      factKey: row.fact_key,
      currentVersion: Number(row.current_version || 0),
      factValue: row.fact_value,
      state: row.fact_state,
      supersedesFactVersion: row.supersedes_fact_version === null ? null : Number(row.supersedes_fact_version),
      contestedBy: row.contested_by || '',
      candidateIds: parse(row.candidate_ids_json, []),
      updatedAt: row.updated_at,
    })));
  }

  async function getFactHistory(projectId, factId) {
    return withDatabase((db) => db.prepare(`SELECT * FROM memory_fact_versions
      WHERE project_id = ? AND fact_id = ? ORDER BY memory_version`).all(text(projectId, 160), text(factId, 120))
      .map((row) => ({
        projectId: row.project_id,
        factId: row.fact_id,
        memoryVersion: Number(row.memory_version),
        factVersion: Number(row.fact_version),
        factKey: row.fact_key,
        factValue: row.fact_value,
        state: row.fact_state,
        supersedesFactVersion: row.supersedes_fact_version === null ? null : Number(row.supersedes_fact_version),
        contestedBy: row.contested_by || '',
        candidateIds: parse(row.candidate_ids_json, []),
        section: row.section_name || '',
        createdAt: row.created_at,
      })));
  }

  // Read one exact fact and its provenance together; callers decide whether
  // the current state is suitable for their narrower authorization scope.
  async function getFactForTask(projectId, factId, memoryVersion) {
    return withDatabase(db => {
      db.exec('BEGIN');
      try {
      const project=text(projectId,160), fact=text(factId,120), version=Number(memoryVersion);
      const current=db.prepare('SELECT * FROM memory_facts WHERE project_id=? AND fact_id=?').get(project,fact);
      const saved=db.prepare('SELECT * FROM memory_fact_versions WHERE project_id=? AND fact_id=? AND memory_version=?').get(project,fact,version);
      if(!current || !saved) { db.exec('COMMIT'); return null; }
      const sources=db.prepare('SELECT id,session_id,run_id,source_event_start,source_event_end FROM memory_fact_provenance WHERE project_id=? AND fact_id=? AND memory_version=? ORDER BY id LIMIT 11').all(project,fact,version);
      const result={projectId:project,factId:fact,memoryVersion:version,factVersion:Number(saved.fact_version),factKey:saved.fact_key,
        factValue:saved.fact_value,state:saved.fact_state,contestedBy:saved.contested_by || '',currentVersion:Number(current.current_version),
        currentKey:current.fact_key,currentValue:current.fact_value,currentState:current.fact_state,currentContestedBy:current.contested_by || '',sources};
      db.exec('COMMIT'); return result;
      } catch(error) { rollback(db); throw error; }
    });
  }

  async function diffMemoryVersions(projectId, fromVersion, toVersion) {
    const from = await getMemoryVersion(projectId, fromVersion);
    const to = await getMemoryVersion(projectId, toVersion);
    if (!from || !to) throw new Error('Project Memory version does not exist');
    const fromFacts = new Map((from.facts || []).map((fact) => [fact.factId, fact]));
    const toFacts = new Map((to.facts || []).map((fact) => [fact.factId, fact]));
    const changedFactIds = [...new Set([...fromFacts.keys(), ...toFacts.keys()])]
      .filter((factId) => stringify(fromFacts.get(factId)) !== stringify(toFacts.get(factId)));
    return {
      projectId: text(projectId, 160),
      fromVersion: from.version,
      toVersion: to.version,
      changedFactIds,
      contentChanged: from.content !== to.content,
      summaryChanged: from.summary !== to.summary,
      extractionWatermarkChanged: from.extractionWatermark !== to.extractionWatermark,
      consolidationWatermarkChanged: from.consolidationWatermark !== to.consolidationWatermark,
    };
  }

  async function listConflictReviews(projectId) {
    return withDatabase(db=>db.prepare('SELECT * FROM memory_conflict_reviews WHERE project_id=? ORDER BY group_key').all(text(projectId,160)).map(row=>({groupKey:row.group_key,factSignature:row.fact_signature,factIds:parse(row.fact_ids_json,[]),memoryVersion:row.memory_version,actorId:row.actor_id,updatedAt:row.updated_at})));
  }

  async function resolveFactConflict({projectId,changes,expectedVersion,actorId,requestId}, {now:at=new Date(),authorize=null}={}) {
    return projectionQueue(async()=>{
      const project=text(projectId,160),actor=text(actorId,160),request=text(requestId,160),current=iso(at);
      if(!project||!actor||!request||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!Array.isArray(changes)||changes.length<2||changes.length>20) throw Object.assign(new Error('Invalid conflict resolution'),{statusCode:400});
      const normalized=changes.map(c=>({factId:text(c?.factId,120),action:c?.action,value:c?.action==='correct'?text(c?.value,1200):''})).sort((a,b)=>a.factId<b.factId?-1:a.factId>b.factId?1:0);
      if(normalized.some(c=>!c.factId||!['keep','correct','retract'].includes(c.action)||(c.action==='correct'&&!c.value))||new Set(normalized.map(c=>c.factId)).size!==normalized.length) throw Object.assign(new Error('Invalid conflict resolution'),{statusCode:400});
      const payloadDigest=projectMemoryConflictMutationDigest(project,normalized,expectedVersion);
      const result=await withDatabase(async db=>{if(authorize) await authorize();begin(db);try {
        const prior=db.prepare('SELECT * FROM memory_user_mutations WHERE project_id=? AND actor_id=? AND request_id=?').get(project,actor,request);
        if(prior) {if(prior.payload_digest!==payloadDigest) throw Object.assign(new Error('Request identity already used'),{statusCode:409});db.exec('COMMIT');return {version:prior.memory_version,replayed:true};}
        const head=db.prepare('SELECT * FROM project_memory WHERE project_id=?').get(project);
        if(!head||Number(head.current_version)!==expectedVersion) throw Object.assign(new Error('Memory version changed'),{statusCode:409});
        const previous=normalized.map(c=>db.prepare('SELECT * FROM memory_facts WHERE project_id=? AND fact_id=?').get(project,c.factId));
        if(previous.some(row=>!row||row.fact_state!=='active')) throw Object.assign(new Error('Conflict facts changed'),{statusCode:409});
        const changed=normalized.some(c=>c.action!=='keep'),version=expectedVersion+(changed?1:0);
        for(let i=0;i<normalized.length;i++) {const c=normalized[i],old=previous[i];if(c.action==='keep') continue;const state=c.action==='correct'?'active':'invalidated',value=c.value,versionOfFact=Number(old.current_version)+1;
          db.prepare('INSERT INTO memory_user_overrides VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,fact_id) DO UPDATE SET action=excluded.action,fact_value=excluded.fact_value,actor_id=excluded.actor_id,updated_at=excluded.updated_at').run(project,c.factId,c.action,value,actor,current);
          db.prepare('UPDATE memory_facts SET current_version=?,fact_value=?,fact_state=?,supersedes_fact_version=?,contested_by=?,candidate_ids_json=?,updated_at=? WHERE project_id=? AND fact_id=?').run(versionOfFact,value,state,old.current_version,'','[]',current,project,c.factId);
          db.prepare('UPDATE memory_candidates SET state=?,resolved_version=?,updated_at=? WHERE project_id=? AND fact_id=?').run('invalidated',version,current,project,c.factId);
          db.prepare('INSERT INTO memory_fact_versions (project_id,fact_id,memory_version,fact_version,fact_key,fact_value,fact_state,supersedes_fact_version,contested_by,candidate_ids_json,section_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(project,c.factId,version,versionOfFact,old.fact_key,value,state,old.current_version,'','[]','user',current);
          db.prepare('INSERT INTO memory_fact_provenance (id,project_id,memory_version,section_name,fact_text,fact_id,fact_key,fact_value,fact_version,fact_state,candidate_id,stage1_id,provider,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id('pmprov'),project,version,'user',value,c.factId,old.fact_key,value,versionOfFact,state,`user:${request}`,`user:${actor}`,'user',current);
        }
        const rows=db.prepare('SELECT * FROM memory_facts WHERE project_id=? ORDER BY fact_id').all(project);
        if(changed) {const facts=rows.map(row=>({factId:row.fact_id,factKey:row.fact_key,factValue:row.fact_value,text:row.fact_value,factVersion:Number(row.current_version),state:row.fact_state,supersedesFactVersion:row.supersedes_fact_version,contestedBy:row.contested_by,candidateIds:parse(row.candidate_ids_json,[]),section:normalized.some(c=>c.factId===row.fact_id&&c.action!=='keep')?'user':''}));const lines=facts.filter(f=>f.state==='active'&&f.factValue).map(f=>`- ${f.factValue}`).join('\n')||'No active structured facts.';const content=`# Project Memory\n\n${lines}`,summary=`v${version}\n${lines}`,snapshot=parse(head.workspace_snapshot_json,{}),outputDigest=digest({content,summary,facts,snapshot});
          db.prepare('INSERT INTO memory_versions (project_id,version,parent_version,source_watermark,extraction_watermark,consolidation_watermark,content,summary,facts_json,workspace_snapshot_json,candidate_ids_json,content_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(project,version,expectedVersion,head.source_watermark,head.extraction_watermark,head.consolidation_watermark,content,summary,stringify(facts),stringify(snapshot),'[]',outputDigest,current);
          const updated=db.prepare("UPDATE project_memory SET current_version=?,content=?,summary=?,facts_json=?,content_digest=?,projection_state='dirty',projection_error='',updated_at=? WHERE project_id=? AND current_version=?").run(version,content,summary,stringify(facts),outputDigest,current,project,expectedVersion);if(!updated.changes) throw Object.assign(new Error('Memory version changed'),{statusCode:409});db.prepare('DELETE FROM memory_fresh_deltas WHERE project_id=?').run(project);
        }
        const factIds=normalized.map(c=>c.factId),selected=rows.filter(row=>factIds.includes(row.fact_id)).map(row=>({factId:row.fact_id,version:Number(row.current_version),value:row.fact_value,state:row.fact_state}));
        const groupKey=digest(factIds),factSignature=digest(selected);db.prepare('INSERT INTO memory_conflict_reviews VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,group_key) DO UPDATE SET fact_signature=excluded.fact_signature,fact_ids_json=excluded.fact_ids_json,actor_id=excluded.actor_id,memory_version=excluded.memory_version,updated_at=excluded.updated_at').run(project,groupKey,factSignature,stringify(factIds),actor,version,current);
        db.prepare('INSERT INTO memory_conflict_review_events VALUES(?,?,?,?,?,?,?,?)').run(project,actor,request,groupKey,factSignature,stringify(normalized),version,current);
        db.prepare('INSERT INTO memory_user_mutations VALUES(?,?,?,?,?)').run(project,actor,request,payloadDigest,version);db.exec('COMMIT');return {version,replayed:false};
      } catch(e) {rollback(db);throw e;}},{mutate:true});
      if(result.version!==expectedVersion) {const version=await getMemoryVersion(project,result.version);try {await writeProjectionUnlocked(version);}catch {}}
      return {...result,projectId:project,projectionState:(await getProjectMemory(project))?.projectionState||'unknown'};
    });
  }

  async function reviseFact({ projectId, factId, action, value = '', expectedVersion, actorId, requestId }, { now = new Date() } = {}) {
    return projectionQueue(async () => {
    const project = text(projectId, 160), fact = text(factId, 120), actor = text(actorId, 160), request = text(requestId, 160);
    const normalizedValue = text(value, 1200), current = iso(now);
    if (!project || !fact || !actor || !request || !['correct', 'retract'].includes(action)
        || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || (action === 'correct' && !normalizedValue)) {
      throw Object.assign(new Error('Invalid memory revision'), { statusCode: 400 });
    }
    const payloadDigest = digest({ project, fact, action, value: normalizedValue, expectedVersion });
    const result = await withDatabase((db) => {
      begin(db);
      try {
        const old = db.prepare('SELECT * FROM memory_user_mutations WHERE project_id=? AND actor_id=? AND request_id=?').get(project, actor, request);
        if (old) {
          if (old.payload_digest !== payloadDigest) throw Object.assign(new Error('Request identity already used'), { statusCode: 409 });
          db.exec('COMMIT'); return { version: old.memory_version, replayed: true };
        }
        const head = db.prepare('SELECT * FROM project_memory WHERE project_id=?').get(project);
        const previous = db.prepare('SELECT * FROM memory_facts WHERE project_id=? AND fact_id=?').get(project, fact);
        if (!head || !previous || Number(head.current_version) !== expectedVersion) throw Object.assign(new Error('Memory or fact version changed'), { statusCode: 409 });
        const version = expectedVersion + 1, factVersion = Number(previous.current_version) + 1;
        const state = action === 'correct' ? 'active' : 'invalidated', factValue = action === 'correct' ? normalizedValue : '';
        db.prepare(`INSERT INTO memory_user_overrides VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,fact_id)
          DO UPDATE SET action=excluded.action,fact_value=excluded.fact_value,actor_id=excluded.actor_id,updated_at=excluded.updated_at`)
          .run(project, fact, action, factValue, actor, current);
        db.prepare('UPDATE memory_facts SET current_version=?,fact_value=?,fact_state=?,supersedes_fact_version=?,contested_by=?,candidate_ids_json=?,updated_at=? WHERE project_id=? AND fact_id=?')
          .run(factVersion, factValue, state, previous.current_version, '', '[]', current, project, fact);
        db.prepare('UPDATE memory_candidates SET state=?,resolved_version=?,updated_at=? WHERE project_id=? AND fact_id=?')
          .run('invalidated', version, current, project, fact);
        const facts = db.prepare('SELECT * FROM memory_facts WHERE project_id=? ORDER BY fact_id').all(project).map(row => ({
          factId: row.fact_id, factKey: row.fact_key, factValue: row.fact_value, text: row.fact_value,
          factVersion: Number(row.current_version), state: row.fact_state, supersedesFactVersion: row.supersedes_fact_version,
          contestedBy: row.contested_by, candidateIds: parse(row.candidate_ids_json, []), section: row.fact_id === fact ? 'user' : '' }));
        const visible = facts.filter(entry => entry.state === 'active' && entry.factValue);
        const lines = visible.map(entry => `- ${entry.factValue}`).join('\n') || 'No active structured facts.';
        const content = `# Project Memory\n\n${lines}`, summary = `v${version}\n${lines}`;
        const snapshot = parse(head.workspace_snapshot_json, {}), outputDigest = digest({ content, summary, facts, snapshot });
        db.prepare(`INSERT INTO memory_versions (project_id,version,parent_version,source_watermark,extraction_watermark,consolidation_watermark,content,summary,facts_json,workspace_snapshot_json,candidate_ids_json,content_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(project, version, expectedVersion, head.source_watermark, head.extraction_watermark, head.consolidation_watermark, content, summary, stringify(facts), stringify(snapshot), '[]', outputDigest, current);
        db.prepare(`UPDATE project_memory SET current_version=?,content=?,summary=?,facts_json=?,content_digest=?,projection_state='dirty',projection_error='',updated_at=? WHERE project_id=? AND current_version=?`)
          .run(version, content, summary, stringify(facts), outputDigest, current, project, expectedVersion);
        db.prepare(`INSERT INTO memory_fact_versions (project_id,fact_id,memory_version,fact_version,fact_key,fact_value,fact_state,supersedes_fact_version,contested_by,candidate_ids_json,section_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(project, fact, version, factVersion, previous.fact_key, factValue, state, previous.current_version, '', '[]', 'user', current);
        db.prepare(`INSERT INTO memory_fact_provenance (id,project_id,memory_version,section_name,fact_text,fact_id,fact_key,fact_value,fact_version,fact_state,candidate_id,stage1_id,provider,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id('pmprov'), project, version, 'user', factValue, fact, previous.fact_key, factValue, factVersion, state, `user:${request}`, `user:${actor}`, 'user', current);
        db.prepare('DELETE FROM memory_fresh_deltas WHERE project_id=?').run(project);
        db.prepare('INSERT INTO memory_user_mutations VALUES(?,?,?,?,?)').run(project, actor, request, payloadDigest, version);
        db.exec('COMMIT'); return { version, replayed: false };
      } catch (error) { rollback(db); throw error; }
    }, { mutate: true });
    const version = await getMemoryVersion(project, result.version);
    try { await writeProjectionUnlocked(version); } catch { /* committed DB remains authoritative and dirty for repair */ }
    return { ...result, projectId: project, factId: fact, projectionState: (await getProjectMemory(project))?.projectionState || 'unknown' };
    });
  }

  async function getMemoryMutationReceipt(projectId, actorId, requestId) {
    const project = text(projectId, 160), actor = text(actorId, 160), request = text(requestId, 160);
    if (!project || !actor || !request) throw Object.assign(new Error('Receipt identity required'), { statusCode: 400 });
    return withDatabase(db => {
      const row = db.prepare('SELECT payload_digest,memory_version FROM memory_user_mutations WHERE project_id=? AND actor_id=? AND request_id=?').get(project, actor, request);
      return row ? { payloadDigest: row.payload_digest, version: Number(row.memory_version) } : null;
    });
  }

  async function rollbackProjectMemoryHead(projectId, version, { now = new Date() } = {}) {
    const normalizedProjectId = text(projectId, 160);
    const targetVersion = await getMemoryVersion(normalizedProjectId, version);
    if (!targetVersion) throw new Error('Project Memory rollback version does not exist');
    const current = iso(now);
    return withDatabase((db) => {
      begin(db);
      try {
        if (db.prepare('SELECT 1 FROM memory_user_overrides WHERE project_id=? LIMIT 1').get(normalizedProjectId)) {
          throw Object.assign(new Error('Rollback would bypass user memory corrections'), { statusCode: 409 });
        }
        db.prepare(`INSERT INTO project_memory
          (project_id, current_version, source_watermark, extraction_watermark, consolidation_watermark,
           content, summary, facts_json, workspace_snapshot_json, content_digest, projection_state,
           projection_error, projected_version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dirty', '', ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET current_version = excluded.current_version,
            source_watermark = excluded.source_watermark, extraction_watermark = excluded.extraction_watermark,
            consolidation_watermark = excluded.consolidation_watermark, content = excluded.content,
            summary = excluded.summary, facts_json = excluded.facts_json,
            workspace_snapshot_json = excluded.workspace_snapshot_json,
            content_digest = excluded.content_digest, projection_state = 'dirty', projection_error = '',
            projected_version = project_memory.projected_version, updated_at = excluded.updated_at`)
          .run(normalizedProjectId, targetVersion.version, targetVersion.consolidationWatermark,
            targetVersion.extractionWatermark, targetVersion.consolidationWatermark, targetVersion.content,
            targetVersion.summary, stringify(targetVersion.facts), stringify(targetVersion.workspaceSnapshot),
            targetVersion.digest, targetVersion.version, current);
        db.prepare('DELETE FROM memory_facts WHERE project_id = ?').run(normalizedProjectId);
        for (const fact of targetVersion.facts || []) {
          db.prepare(`INSERT INTO memory_facts
            (project_id, fact_id, fact_key, current_version, fact_value, fact_state,
             supersedes_fact_version, contested_by, candidate_ids_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(normalizedProjectId, fact.factId, fact.factKey || fact.factId, Number(fact.factVersion || 1),
              fact.factValue || fact.text || '', fact.state || 'active', fact.supersedesFactVersion || null,
              fact.contestedBy || '', stringify(fact.candidateIds || []), current);
        }
        db.prepare('DELETE FROM memory_fresh_deltas WHERE project_id = ?').run(normalizedProjectId);
        db.exec('COMMIT');
        return getProjectMemory(normalizedProjectId);
      } catch (error) {
        rollback(db);
        throw error;
      }
    }, { mutate: true });
  }

  async function listJobs({ projectId = '', kind = '' } = {}) {
    return withDatabase((db) => {
      const clauses = [];
      const values = [];
      if (text(projectId)) { clauses.push('project_id = ?'); values.push(text(projectId)); }
      if (text(kind)) { clauses.push('kind = ?'); values.push(text(kind)); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return db.prepare(`SELECT * FROM memory_jobs ${where} ORDER BY created_at, id`).all(...values).map(rowJob);
    });
  }

  async function hasRecoverableWork(projectId) {
    const normalizedProjectId = text(projectId, 160);
    if (!normalizedProjectId) return false;
    return withDatabase((db) => !!db.prepare(`SELECT 1 FROM memory_jobs
      WHERE project_id = ? AND state != 'succeeded' LIMIT 1`).get(normalizedProjectId));
  }

  async function listRunnableProjects({ now = new Date(), limit = 32 } = {}) {
    const current = iso(now);
    return withDatabase((db) => db.prepare(`SELECT project_id AS projectId, MIN(updated_at) AS oldest
      FROM memory_jobs WHERE retry_remaining > 0
        AND (retry_at IS NULL OR retry_at <= ?)
        AND (state = 'pending' OR state = 'error' OR (state = 'running' AND lease_until <= ?))
      GROUP BY project_id ORDER BY oldest, project_id LIMIT ?`)
      .all(current, current, positiveInt(limit, 32, 128)));
  }

  async function writeProjectionUnlocked(version) {
    if (!version?.projectId || !version?.content || !version?.summary) {
      throw new Error('Cannot project an incomplete Project Memory version');
    }
      const canonical = await getMemoryVersion(version.projectId, version.version);
      if (!canonical || (version.digest && canonical.digest !== version.digest)) {
        throw new Error('Project Memory projection source is not the canonical DB version');
      }
      const head = await getProjectMemory(version.projectId);
      if (head?.currentVersion !== canonical.version) {
        throw new Error('Project Memory projection version is no longer current');
      }
      const paths = projectMemoryProjectionPaths(canonical.projectId, workspaceRoot);
      await markProjectionRepairing(canonical.projectId, canonical.version);
      try {
        await mkdir(paths.root, { recursive: true });
        await projectionTextWriter(paths.memory, `${canonical.content.trim()}\n`);
        await projectionTextWriter(paths.summary, `${canonical.summary.trim()}\n`);
        await projectionJsonWriter(paths.state, {
          schemaVersion: 1,
          projectId: canonical.projectId,
          version: canonical.version,
          extractionWatermark: canonical.extractionWatermark,
          consolidationWatermark: canonical.consolidationWatermark,
          sourceWatermark: canonical.consolidationWatermark,
          digest: canonical.digest,
          projectionState: 'clean',
          projectionError: '',
          projectedAt: iso(),
        });
        if (!await markProjectionClean(canonical.projectId, canonical.version)) {
          throw new Error('Project Memory head changed during filesystem projection');
        }
        return paths;
      } catch (error) {
        await markProjectionDirty(canonical.projectId, error?.message || String(error), canonical.version).catch(() => {});
        throw error;
      }
  }

  async function writeProjection(version) {
    return projectionQueue(() => writeProjectionUnlocked(version));
  }

  async function recordFreshDelta(projectId, value = {}) {
    const normalizedProjectId = text(projectId, 160);
    if (!normalizedProjectId) throw new Error('Fresh Delta requires projectId');
    const current = iso();
    return withDatabase((db) => {
      if (db.prepare('SELECT 1 FROM memory_user_overrides WHERE project_id=? LIMIT 1').get(normalizedProjectId)) return null;
      db.prepare(`INSERT INTO memory_fresh_deltas
        (project_id, base_version, consolidation_watermark, content, candidate_ids_json, generated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET base_version = excluded.base_version,
          consolidation_watermark = excluded.consolidation_watermark, content = excluded.content,
          candidate_ids_json = excluded.candidate_ids_json, generated_at = excluded.generated_at`)
        .run(normalizedProjectId, Number(value.baseVersion || 0), Number(value.consolidationWatermark || 0),
          text(value.content, 8_000), stringify(Array.isArray(value.candidateIds) ? value.candidateIds : []), current);
      return {
        projectId: normalizedProjectId,
        baseVersion: Number(value.baseVersion || 0),
        consolidationWatermark: Number(value.consolidationWatermark || 0),
        content: text(value.content, 8_000),
        candidateIds: Array.isArray(value.candidateIds) ? value.candidateIds : [],
        generatedAt: current,
      };
    }, { mutate: true });
  }

  async function getFreshDelta(projectId) {
    return withDatabase((db) => {
      if (db.prepare('SELECT 1 FROM memory_user_overrides WHERE project_id=? LIMIT 1').get(text(projectId, 160))) return null;
      const row = db.prepare('SELECT * FROM memory_fresh_deltas WHERE project_id = ?').get(text(projectId, 160));
      if (!row) return null;
      return {
        projectId: row.project_id,
        baseVersion: Number(row.base_version || 0),
        consolidationWatermark: Number(row.consolidation_watermark || 0),
        content: row.content || '',
        candidateIds: parse(row.candidate_ids_json, []),
        generatedAt: row.generated_at,
      };
    });
  }

  return {
    databasePath,
    workspaceRoot,
    initialize,
    listRunnableProjects,
    enqueueExtraction,
    enqueueConsolidation,
    claimNextJob,
    heartbeatJob,
    failJob,
    completeExtraction,
    getConsolidationInput,
    commitConsolidation,
    finishCommittedJob,
    finishNoopJob,
    markProjectionRepairing,
    markProjectionDirty,
    markProjectionClean,
    getProjectMemory,
    getMemoryVersion,
    getFactProvenance,
    listCurrentFacts,
    getFactHistory,
    getFactForTask,
    listConflictReviews,
    resolveFactConflict,
    reviseFact,
    getMemoryMutationReceipt,
    diffMemoryVersions,
    rollbackProjectMemoryHead,
    listJobs,
    hasRecoverableWork,
    writeProjection,
    recordFreshDelta,
    getFreshDelta,
    repairDirtyProjections,
  };
}

function getVersionSync(db, projectId, version) {
  return rowVersion(db.prepare('SELECT * FROM memory_versions WHERE project_id = ? AND version = ?').get(projectId, version));
}

function getConsolidationInputSync(db, projectId) {
  const head = db.prepare('SELECT * FROM project_memory WHERE project_id = ?').get(projectId);
  const extractionWatermark = Number(head?.extraction_watermark ?? head?.source_watermark ?? 0);
  const consolidationWatermark = Number(head?.consolidation_watermark ?? head?.source_watermark ?? 0);
  const stages = db.prepare(`SELECT * FROM memory_stage1 WHERE project_id = ? AND stage_sequence > ? ORDER BY stage_sequence ASC`)
    .all(projectId, consolidationWatermark).map(rowStage);
  const candidateRows = stages.length
    ? db.prepare(`SELECT * FROM memory_candidates WHERE project_id = ? AND stage1_id IN (${stages.map(() => '?').join(',')})`)
      .all(projectId, ...stages.map((stage) => stage.id))
    : [];
  const priorCandidateRows = db.prepare(`SELECT * FROM memory_candidates
    WHERE project_id = ? AND state IN ('active', 'contested') ORDER BY updated_at, id`).all(projectId);
  return {
    head: head ? {
      currentVersion: Number(head.current_version || 0), sourceWatermark: consolidationWatermark,
      extractionWatermark, consolidationWatermark,
      content: head.content || '', summary: head.summary || '',
      workspaceSnapshot: parse(head.workspace_snapshot_json, {}),
      projectionState: head.projection_state || 'clean',
      projectionError: head.projection_error || '',
      projectedVersion: Number(head.projected_version || 0),
    } : null,
    stages,
    candidates: candidateRows.map(rowCandidate),
    priorCandidates: priorCandidateRows.map(rowCandidate),
    extractionWatermark,
    consolidationWatermark,
  };
}

export const defaultProjectMemoryStore = createProjectMemoryStore();
