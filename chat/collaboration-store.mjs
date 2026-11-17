import { randomBytes } from 'crypto';
import { mkdirSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { CHAT_COLLABORATIONS_DB, CHAT_COLLABORATIONS_DIR } from '../lib/config.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';
import { publishOrganizationInvalidation } from './organization-invalidation.mjs';

const runStoreMutation = createSerialTaskQueue();
// A collaboration Attempt used to have one 20 minute lease which started
// before a Run even existed.  That made a healthy, capacity-queued Run look
// like a failed child task.  Keep `LEASE_MS` exported for older callers, but
// use phase-specific deadlines for all new Attempts.
const LEASE_MS = 20 * 60 * 1000;
const DISPATCH_DEADLINE_MS = positiveDurationFromEnv('RAGENT_COLLABORATION_DISPATCH_DEADLINE_MS', 5 * 60 * 1000);
const QUEUE_DEADLINE_MS = positiveDurationFromEnv('RAGENT_COLLABORATION_QUEUE_DEADLINE_MS', 60 * 60 * 1000);
// Dispatching a child is a two-system operation: first persist the intent in
// this database, then ask session-manager to admit the Run.  A short lease on
// the delivery claim makes the intent recoverable after a control-plane crash
// without creating a second Run (the requestId is stable per Attempt).
const DISPATCH_COMMAND_LEASE_MS = positiveDurationFromEnv('RAGENT_COLLABORATION_DISPATCH_COMMAND_LEASE_MS', 2 * 60 * 1000);
const DISPATCH_RETRY_DELAY_MS = positiveDurationFromEnv('RAGENT_COLLABORATION_DISPATCH_RETRY_DELAY_MS', 5 * 1000);
const AGGREGATION_LEASE_MS = 5 * 60 * 1000;
const MAX_COLLABORATION_EVENTS_IN_PROJECTION = 256;

function nowIso() {
  return new Date().toISOString();
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

function phaseDeadline(row) {
  const phase = row?.lifecycle_phase || 'running';
  if (phase === 'dispatching') return row?.dispatch_deadline || row?.lease_until || '';
  if (phase === 'queued') return row?.queue_deadline || row?.lease_until || '';
  return row?.execution_deadline || row?.lease_until || '';
}

function id(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function json(value, fallback = null) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

// Organization-managed attempts share the same SQLite transaction as node
// rebinding. Generic collaborations without organization policy are unchanged.
function managedAttemptBindingAvailable(db, collaborationId, taskId) {
  const raw=db.prepare('SELECT policy_json,plan_version FROM collaborations WHERE id=?').get(collaborationId);
  const policy=parseJson(raw?.policy_json,null);
  if (!policy || typeof policy!=='object' || Array.isArray(policy)) throw Object.assign(new Error('Collaboration policy is unavailable; reconcile before dispatch'),{code:'COLLABORATION_MANAGED_BINDING_CONFLICT',statusCode:409});
  const org=typeof policy.organizationId==='string' ? policy.organizationId.trim() : '';
  const nodeId=typeof policy.organizationNodeId==='string' ? policy.organizationNodeId.trim() : '';
  if (!org && !nodeId && policy.organizationBindingGeneration===undefined && !policy.factoryExecution) return true;
  if (org && !nodeId && policy.organizationBindingGeneration===undefined && !policy.factoryExecution) {
    const plan=parseJson(db.prepare('SELECT plan_json FROM collaboration_plans WHERE collaboration_id=? AND version=?').get(collaborationId,raw.plan_version)?.plan_json,null);
    const task=Array.isArray(plan?.tasks) ? plan.tasks.find(item=>item.id===taskId) : null;
    if (!task) throw Object.assign(new Error('Frozen collaboration task is unavailable'),{code:'COLLABORATION_MANAGED_BINDING_CONFLICT',statusCode:409});
    if (!task.managedSessionId) return true;
  }
  if (!org || !nodeId || !Number.isInteger(policy.organizationBindingGeneration) || policy.organizationBindingGeneration<0) throw Object.assign(new Error('Organization binding facts are incomplete; reconcile before dispatch'),{code:'COLLABORATION_MANAGED_BINDING_CONFLICT',statusCode:409});
  const node=db.prepare('SELECT current_session_id,binding_generation,retired_revision FROM organization_nodes WHERE id=? AND organization_id=?').get(nodeId,org);
  if (!node || !node.current_session_id || node.retired_revision!==null || node.binding_generation!==policy.organizationBindingGeneration) throw Object.assign(new Error('Organization binding changed; reconcile before dispatch'),{code:'COLLABORATION_MANAGED_BINDING_CONFLICT',statusCode:409});
  const hasPending=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_node_rebind_operations'").get();
  return !(hasPending && db.prepare("SELECT 1 FROM organization_node_rebind_operations WHERE organization_id=? AND node_id=? AND state='pending'").get(org,nodeId));
}

function rowDispatchCommand(row) {
  if (!row) return null;
  const payload = parseJson(row.payload_json, {});
  return {
    id: row.id,
    collaborationId: row.collaboration_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    state: row.state,
    requestId: row.request_id,
    prompt: typeof payload?.prompt === 'string' ? payload.prompt : '',
    options: payload?.options && typeof payload.options === 'object' ? payload.options : {},
    claimToken: row.claim_token || '',
    leaseUntil: row.lease_until || '',
    availableAt: row.available_at || '',
    runId: row.run_id || '',
    failureReason: row.failure_reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function openDatabase() {
  mkdirSync(CHAT_COLLABORATIONS_DIR, { recursive: true });
  // The collaboration DB is also the backing store for the provider-neutral
  // orchestration ledger.  Runs can be reconciled from a second process while
  // the chat plane is committing a dispatch, so a zero busy timeout turns a
  // harmless WAL writer overlap into an intermittent "database is locked"
  // failure.  Let SQLite wait briefly; the higher-level serial queues still
  // provide ordering inside one process.
  const db = new DatabaseSync(CHAT_COLLABORATIONS_DB, { timeout: 10_000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS collaborations (
      id TEXT PRIMARY KEY,
      root_session_id TEXT NOT NULL,
      state TEXT NOT NULL,
      title TEXT NOT NULL,
      plan_version INTEGER NOT NULL,
      policy_json TEXT NOT NULL,
      idempotency_key TEXT,
      aggregation_generation INTEGER NOT NULL DEFAULT 0,
      aggregation_claimed_generation INTEGER NOT NULL DEFAULT 0,
      aggregation_run_id TEXT,
      aggregation_lease_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(root_session_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS collaboration_plans (
      collaboration_id TEXT NOT NULL REFERENCES collaborations(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(collaboration_id, version)
    );
    CREATE TABLE IF NOT EXISTS collaboration_tasks (
      id TEXT PRIMARY KEY,
      collaboration_id TEXT NOT NULL REFERENCES collaborations(id) ON DELETE CASCADE,
      objective TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      project_id TEXT,
      runtime_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL,
      depends_on_json TEXT NOT NULL,
      acceptance_json TEXT NOT NULL,
      writable_paths_json TEXT NOT NULL,
      retry_json TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      current_attempt INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      run_id TEXT,
      task_kind TEXT NOT NULL DEFAULT 'execution',
      access_mode TEXT,
      read_only_required INTEGER NOT NULL DEFAULT 0,
      execution_isolation TEXT,
      runner_id TEXT,
      runner_unit_scope TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES collaboration_tasks(id) ON DELETE CASCADE,
      project_id TEXT,
      result_packet_id TEXT,
      attempt_number INTEGER NOT NULL,
      state TEXT NOT NULL,
      session_id TEXT,
      run_id TEXT,
      lifecycle_phase TEXT NOT NULL DEFAULT 'running',
      lease_until TEXT,
      dispatch_deadline TEXT,
      queue_deadline TEXT,
      execution_deadline TEXT,
      heartbeat_at TEXT,
      started_at TEXT,
      queued_at TEXT,
      runner_started_at TEXT,
      last_observed_at TEXT,
      completed_at TEXT,
      failure_kind TEXT,
      failure_reason TEXT,
      envelope_json TEXT,
      report_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, attempt_number),
      UNIQUE(run_id)
    );
    CREATE TABLE IF NOT EXISTS collaboration_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collaboration_id TEXT NOT NULL REFERENCES collaborations(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      task_id TEXT,
      attempt_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_dispatch_commands (
      id TEXT PRIMARY KEY,
      collaboration_id TEXT NOT NULL REFERENCES collaborations(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES collaboration_tasks(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL UNIQUE REFERENCES collaboration_attempts(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL,
      claim_token TEXT,
      lease_until TEXT,
      available_at TEXT NOT NULL,
      run_id TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_replay_receipts (
      attempt_id TEXT PRIMARY KEY REFERENCES collaboration_attempts(id), task_id TEXT NOT NULL,
      collaboration_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, plan_version INTEGER NOT NULL,
      source TEXT NOT NULL, effective_attempt_budget INTEGER NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_collab_tasks_ready ON collaboration_tasks(collaboration_id, state);
    CREATE INDEX IF NOT EXISTS idx_collab_attempts_run ON collaboration_attempts(run_id);
    CREATE INDEX IF NOT EXISTS idx_collab_events_collab ON collaboration_events(collaboration_id, id);
    CREATE INDEX IF NOT EXISTS idx_collab_dispatch_ready ON collaboration_dispatch_commands(collaboration_id, state, available_at);
    CREATE INDEX IF NOT EXISTS idx_collab_dispatch_attempt ON collaboration_dispatch_commands(attempt_id);
  `);
  const collaborationColumns = new Set(db.prepare('PRAGMA table_info(collaborations)').all().map((column) => column.name));
  if (!collaborationColumns.has('aggregation_lease_until')) {
    db.exec('ALTER TABLE collaborations ADD COLUMN aggregation_lease_until TEXT');
  }
  // S6 additive columns (idempotent for stores created before this slice).
  const taskColumns = new Set(db.prepare('PRAGMA table_info(collaboration_tasks)').all().map((column) => column.name));
  if (!taskColumns.has('project_id')) {
    db.exec('ALTER TABLE collaboration_tasks ADD COLUMN project_id TEXT');
  }
  if (!taskColumns.has('runtime_json')) {
    db.exec("ALTER TABLE collaboration_tasks ADD COLUMN runtime_json TEXT NOT NULL DEFAULT '{}'");
  }
  // C3 consultation contract columns (additive, idempotent for legacy stores).
  // ADD COLUMN with a default backfills legacy rows without rebuilding the table.
  if (!taskColumns.has('task_kind')) {
    db.exec("ALTER TABLE collaboration_tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'execution'");
  }
  if (!taskColumns.has('access_mode')) {
    db.exec('ALTER TABLE collaboration_tasks ADD COLUMN access_mode TEXT');
  }
  if (!taskColumns.has('read_only_required')) {
    db.exec('ALTER TABLE collaboration_tasks ADD COLUMN read_only_required INTEGER NOT NULL DEFAULT 0');
  }
  if (!taskColumns.has('execution_isolation')) {
    db.exec('ALTER TABLE collaboration_tasks ADD COLUMN execution_isolation TEXT');
  }
  if (!taskColumns.has('runner_id')) {
    db.exec('ALTER TABLE collaboration_tasks ADD COLUMN runner_id TEXT');
  }
  if (!taskColumns.has('runner_unit_scope')) {
    db.exec('ALTER TABLE collaboration_tasks ADD COLUMN runner_unit_scope TEXT');
  }
  const attemptColumns = new Set(db.prepare('PRAGMA table_info(collaboration_attempts)').all().map((column) => column.name));
  if (!attemptColumns.has('project_id')) {
    db.exec('ALTER TABLE collaboration_attempts ADD COLUMN project_id TEXT');
  }
  if (!attemptColumns.has('result_packet_id')) {
    db.exec('ALTER TABLE collaboration_attempts ADD COLUMN result_packet_id TEXT');
  }
  // V2 Attempt lifecycle is intentionally additive.  Existing running rows
  // retain their old lease as an execution deadline: a deploy must never turn
  // a pre-existing task into an unbounded one.
  if (!attemptColumns.has('lifecycle_phase')) {
    db.exec("ALTER TABLE collaboration_attempts ADD COLUMN lifecycle_phase TEXT NOT NULL DEFAULT 'running'");
  }
  if (!attemptColumns.has('dispatch_deadline')) {
    db.exec('ALTER TABLE collaboration_attempts ADD COLUMN dispatch_deadline TEXT');
  }
  if (!attemptColumns.has('queue_deadline')) {
    db.exec('ALTER TABLE collaboration_attempts ADD COLUMN queue_deadline TEXT');
  }
  if (!attemptColumns.has('execution_deadline')) {
    db.exec('ALTER TABLE collaboration_attempts ADD COLUMN execution_deadline TEXT');
  }
  if (!attemptColumns.has('approval_wait_started_at')) {
    db.exec('ALTER TABLE collaboration_attempts ADD COLUMN approval_wait_started_at TEXT');
  }
  if (!attemptColumns.has('approval_deadline')) db.exec('ALTER TABLE collaboration_attempts ADD COLUMN approval_deadline TEXT');
  if (!attemptColumns.has('approval_state')) db.exec('ALTER TABLE collaboration_attempts ADD COLUMN approval_state TEXT');
  if (!attemptColumns.has('queued_at')) {
    db.exec('ALTER TABLE collaboration_attempts ADD COLUMN queued_at TEXT');
  }
  if (!attemptColumns.has('runner_started_at')) {
    db.exec('ALTER TABLE collaboration_attempts ADD COLUMN runner_started_at TEXT');
  }
  if (!attemptColumns.has('last_observed_at')) {
    db.exec('ALTER TABLE collaboration_attempts ADD COLUMN last_observed_at TEXT');
  }
  db.exec(`UPDATE collaboration_attempts
    SET lifecycle_phase = COALESCE(NULLIF(lifecycle_phase, ''), 'running'),
        execution_deadline = COALESCE(execution_deadline, lease_until)
    WHERE state = 'running' AND (lifecycle_phase IS NULL OR lifecycle_phase = '' OR lifecycle_phase = 'running')`);
  // Backfill attempt project bindings from their tasks (legacy rows included).
  db.exec(`
    UPDATE collaboration_attempts
    SET project_id = (SELECT project_id FROM collaboration_tasks t WHERE t.id = collaboration_attempts.task_id)
    WHERE project_id IS NULL
  `);
  // Older collaboration rows may already have a normalized plan carrying a
  // runtime selection. Recover it into the task projection once so restart
  // and status reads do not silently lose provider/model/effort.
  const runtimeRows = db.prepare(`
    SELECT id, collaboration_id
    FROM collaboration_tasks
    WHERE runtime_json IS NULL OR runtime_json = '{}'
  `).all();
  const planCache = new Map();
  const updateRuntime = db.prepare('UPDATE collaboration_tasks SET runtime_json = ? WHERE id = ?');
  for (const taskRow of runtimeRows) {
    let plan = planCache.get(taskRow.collaboration_id);
    if (plan === undefined) {
      const planRow = db.prepare(`
        SELECT plan_json FROM collaboration_plans
        WHERE collaboration_id = ? ORDER BY version DESC LIMIT 1
      `).get(taskRow.collaboration_id);
      plan = parseJson(planRow?.plan_json, null);
      planCache.set(taskRow.collaboration_id, plan);
    }
    const persistedTask = Array.isArray(plan?.tasks)
      ? plan.tasks.find((candidate) => candidate?.id === taskRow.id)
      : null;
    if (persistedTask?.runtime && typeof persistedTask.runtime === 'object') {
      updateRuntime.run(json(persistedTask.runtime, {}), taskRow.id);
    }
  }
  return db;
}

export async function withDatabase(fn, { mutate = false } = {}) {
  const run = async () => {
    const db = openDatabase();
    try { return await fn(db); } finally { db.close(); }
  };
  return mutate ? runStoreMutation(run) : run();
}

function rowTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    collaborationId: row.collaboration_id,
    objective: row.objective,
    agentId: row.agent_id,
    role: row.role,
    runtime: parseJson(row.runtime_json, {}),
    state: row.state,
    dependsOn: parseJson(row.depends_on_json, []),
    acceptance: parseJson(row.acceptance_json, []),
    writablePaths: parseJson(row.writable_paths_json, []),
    retry: parseJson(row.retry_json, { maxAttempts: 1, retryOn: ['transient'] }),
    timeoutMs: row.timeout_ms,
    currentAttempt: row.current_attempt,
    sessionId: row.session_id || '',
    runId: row.run_id || '',
    projectId: row.project_id || '',
    taskKind: row.task_kind || 'execution',
    accessMode: row.access_mode || '',
    readOnlyRequired: row.read_only_required ? true : false,
    executionIsolation: row.execution_isolation || '',
    runnerId: row.runner_id || '',
    runnerUnitScope: row.runner_unit_scope || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowAttempt(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    collaborationId: row.collaboration_id || '',
    attemptNumber: row.attempt_number,
    state: row.state,
    lifecyclePhase: row.lifecycle_phase || 'running',
    sessionId: row.session_id || '',
    runId: row.run_id || '',
    leaseUntil: row.lease_until || '',
    dispatchDeadline: row.dispatch_deadline || '',
    queueDeadline: row.queue_deadline || '',
    executionDeadline: row.execution_deadline || '',
    approvalWaitStartedAt: row.approval_wait_started_at || '',
    approvalDeadline: row.approval_deadline || '',
    approvalState: row.approval_state || '',
    heartbeatAt: row.heartbeat_at || '',
    startedAt: row.started_at || '',
    queuedAt: row.queued_at || '',
    runnerStartedAt: row.runner_started_at || '',
    lastObservedAt: row.last_observed_at || '',
    completedAt: row.completed_at || '',
    failureKind: row.failure_kind || '',
    failureReason: row.failure_reason || '',
    envelope: parseJson(row.envelope_json, null),
    report: parseJson(row.report_json, null),
    projectId: row.project_id || '',
    resultPacketId: row.result_packet_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowCollaboration(db, row, {
  includeEvents = false,
  eventLimit = MAX_COLLABORATION_EVENTS_IN_PROJECTION,
} = {}) {
  if (!row) return null;
  const tasks = db.prepare('SELECT * FROM collaboration_tasks WHERE collaboration_id = ? ORDER BY rowid').all(row.id).map(rowTask);
  const frozenPlan = parseJson(db.prepare('SELECT plan_json FROM collaboration_plans WHERE collaboration_id = ? AND version = ?').get(row.id, row.plan_version)?.plan_json, {});
  const planTasks = new Map((frozenPlan.tasks || []).map((task) => [task.id, task]));
  for (const task of tasks) task.managedSessionId = planTasks.get(task.id)?.managedSessionId || '';
  const attempts = db.prepare(`
    SELECT a.* FROM collaboration_attempts a
    JOIN collaboration_tasks t ON t.id = a.task_id
    WHERE t.collaboration_id = ? ORDER BY a.created_at, a.attempt_number
  `).all(row.id).map((attempt) => rowAttempt({ ...attempt, collaboration_id: row.id }));
  const result = {
    id: row.id,
    rootSessionId: row.root_session_id,
    state: row.state,
    title: row.title,
    planVersion: row.plan_version,
    policy: parseJson(row.policy_json, {}),
    idempotencyKey: row.idempotency_key || '',
    aggregationGeneration: row.aggregation_generation,
    aggregationClaimedGeneration: row.aggregation_claimed_generation,
    aggregationRunId: row.aggregation_run_id || '',
    aggregationLeaseUntil: row.aggregation_lease_until || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tasks,
    attempts,
  };
  if (includeEvents) {
    const boundedEventLimit = Math.max(1, Math.min(
      MAX_COLLABORATION_EVENTS_IN_PROJECTION,
      Number.isInteger(eventLimit) ? eventLimit : MAX_COLLABORATION_EVENTS_IN_PROJECTION,
    ));
    // Collaboration events are an audit tail, not an unbounded transcript.
    // Returning the whole table here made a detail GET grow linearly with a
    // long-running collaboration and blocked callers that only needed the
    // current state or terminal marker.
    result.events = db.prepare(`SELECT * FROM collaboration_events
      WHERE collaboration_id = ? ORDER BY id DESC LIMIT ?`).all(row.id, boundedEventLimit).reverse().map((event) => ({
      id: event.id,
      type: event.type,
      taskId: event.task_id || '',
      attemptId: event.attempt_id || '',
      payload: parseJson(event.payload_json, {}),
      createdAt: event.created_at,
    }));
  }
  return result;
}

function appendEvent(db, collaborationId, type, payload = {}, taskId = '', attemptId = '') {
  db.prepare(`INSERT INTO collaboration_events
    (collaboration_id, type, task_id, attempt_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(collaborationId, type, taskId || null, attemptId || null, json(payload, {}), nowIso());
}

async function publishCollaborationInvalidation(collaborationId) {
  if (!collaborationId) return;
  const organizationId = await withDatabase((db) => {
    const row = db.prepare('SELECT policy_json FROM collaborations WHERE id = ?').get(collaborationId);
    return parseJson(row?.policy_json, {})?.organizationId || '';
  });
  if (organizationId) publishOrganizationInvalidation({ organizationId });
}

async function publishAttemptInvalidation(attemptId) {
  const collaborationId = await withDatabase((db) => db.prepare(`SELECT t.collaboration_id
    FROM collaboration_attempts a JOIN collaboration_tasks t ON t.id = a.task_id WHERE a.id = ?`).get(attemptId)?.collaboration_id || '');
  await publishCollaborationInvalidation(collaborationId);
}

export async function initializeCollaborationStore() {
  await withDatabase(() => true, { mutate: true });
  return CHAT_COLLABORATIONS_DB;
}

export async function createCollaborationRecord({ id: collaborationId = id('collab'), rootSessionId, title, policy, plan, idempotencyKey = '' }) {
  return withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (idempotencyKey) {
        const existing = db.prepare('SELECT * FROM collaborations WHERE root_session_id = ? AND idempotency_key = ?').get(rootSessionId, idempotencyKey);
        if (existing) {
          db.exec('COMMIT');
          return rowCollaboration(db, existing);
        }
      }
      db.prepare(`INSERT INTO collaborations
        (id, root_session_id, state, title, plan_version, policy_json, idempotency_key, created_at, updated_at)
        VALUES (?, ?, 'planning', ?, ?, ?, ?, ?, ?)`)
        .run(collaborationId, rootSessionId, title, plan.version, json(policy, {}), idempotencyKey || null, timestamp, timestamp);
      db.prepare('INSERT INTO collaboration_plans (collaboration_id, version, plan_json, created_at) VALUES (?, ?, ?, ?)')
        .run(collaborationId, plan.version, json(plan, {}), timestamp);
      const insertTask = db.prepare(`INSERT INTO collaboration_tasks
        (id, collaboration_id, objective, agent_id, role, project_id, runtime_json, state, depends_on_json, acceptance_json,
         writable_paths_json, retry_json, timeout_ms, task_kind, access_mode, read_only_required,
         execution_isolation, runner_id, runner_unit_scope, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const task of plan.tasks) {
        insertTask.run(task.id, collaborationId, task.objective, task.agentId, task.role, task.projectId || null,
          json(task.runtime, {}), 'planned',
          json(task.dependsOn, []), json(task.acceptance, []), json(task.writablePaths, []), json(task.retry, {}), task.timeoutMs,
          task.taskKind || 'execution',
          task.accessMode || null,
          task.taskKind === 'consultation' ? 1 : (task.readOnlyRequired === true || task.readOnlyRequired === 1 ? 1 : 0),
          task.executionIsolation || null,
          task.runnerId || null,
          task.runnerUnitScope || null,
          timestamp, timestamp);
      }
      appendEvent(db, collaborationId, 'plan_frozen', { version: plan.version, taskCount: plan.tasks.length });
      db.prepare('UPDATE collaborations SET state = \'ready\', updated_at = ? WHERE id = ?').run(nowIso(), collaborationId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowCollaboration(db, db.prepare('SELECT * FROM collaborations WHERE id = ?').get(collaborationId));
  }, { mutate: true });
}

export async function getCollaboration(collaborationId, options = {}) {
  return withDatabase((db) => rowCollaboration(db, db.prepare('SELECT * FROM collaborations WHERE id = ?').get(collaborationId), options));
}

export async function getCollaborationByIdempotencyKey(rootSessionId, idempotencyKey) {
  if (!rootSessionId || !idempotencyKey) return null;
  return withDatabase((db) => rowCollaboration(db, db.prepare(
    'SELECT * FROM collaborations WHERE root_session_id = ? AND idempotency_key = ?',
  ).get(rootSessionId, idempotencyKey)));
}

export async function listCollaborationRecords({ activeOnly = false, limit = 0 } = {}) {
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5_000) : 0;
  return withDatabase((db) => {
    const statement = activeOnly
      ? "SELECT * FROM collaborations WHERE state NOT IN ('completed', 'failed', 'cancelled') ORDER BY updated_at"
      : 'SELECT * FROM collaborations ORDER BY updated_at DESC';
    const rows = boundedLimit > 0
      ? db.prepare(`${statement} LIMIT ?`).all(boundedLimit)
      : db.prepare(statement).all();
    return rows.map((row) => rowCollaboration(db, row));
  });
}

// Bounded read used by the provider-neutral orchestration projection. The
// collaboration dispatch table remains authoritative; exposing its durable
// command envelope here avoids making the generic ledger reach into its
// SQLite schema or replay unbounded history during reconciliation.
export async function listAttemptDispatchCommands({ collaborationId, limit = 500 } = {}) {
  const normalizedId = typeof collaborationId === 'string' ? collaborationId.trim() : '';
  if (!normalizedId) return [];
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 2_000) : 500;
  return withDatabase((db) => db.prepare(`SELECT * FROM collaboration_dispatch_commands
    WHERE collaboration_id = ? ORDER BY created_at, id LIMIT ?`).all(normalizedId, boundedLimit).map(rowDispatchCommand));
}

export async function claimTaskAttempt(taskId, {
  sessionId,
  runId,
  // `leaseMs` remains a supported test/compatibility override.  It applies to
  // the current lifecycle phase, never to a future execution phase.
  leaseMs = null,
  dispatchDeadlineMs = DISPATCH_DEADLINE_MS,
  queueDeadlineMs = QUEUE_DEADLINE_MS,
} = {}) {
  const attempt = await withDatabase((db) => {
    const timestamp = nowIso();
    const attemptId = id('attempt');
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('SELECT state, current_attempt, collaboration_id, project_id FROM collaboration_tasks WHERE id = ?').get(taskId);
      // Only dependency-satisfied (ready) or retrying tasks are claimable; a
      // 'planned' task must pass through markReadyTasks first. This keeps the
      // dependency gate enforced at the store boundary, not just by callers.
      if (!current || !['ready', 'retrying'].includes(current.state)) {
        db.exec('COMMIT');
        return null;
      }
      if (!managedAttemptBindingAvailable(db,current.collaboration_id,taskId)) { db.exec('COMMIT'); return null; }
      const nextAttempt = Number(current.current_attempt || 0) + 1;
      const hasRun = typeof runId === 'string' && runId.trim().length > 0;
      const lifecyclePhase = hasRun ? 'queued' : 'dispatching';
      const phaseDurationMs = positiveDuration(
        leaseMs,
        hasRun
          ? positiveDuration(queueDeadlineMs, QUEUE_DEADLINE_MS)
          : positiveDuration(dispatchDeadlineMs, DISPATCH_DEADLINE_MS),
      );
      const deadline = isoAfter(timestamp, phaseDurationMs);
      db.prepare(`UPDATE collaboration_tasks SET state = 'running', current_attempt = ?, session_id = ?, run_id = ?, updated_at = ? WHERE id = ?`)
        .run(nextAttempt, sessionId || null, runId || null, timestamp, taskId);
      db.prepare(`INSERT INTO collaboration_attempts
        (id, task_id, project_id, attempt_number, state, session_id, run_id, lifecycle_phase,
         lease_until, dispatch_deadline, queue_deadline, heartbeat_at, queued_at, last_observed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(attemptId, taskId, current.project_id || null, nextAttempt, sessionId || null, runId || null,
          lifecyclePhase, deadline,
          hasRun ? null : deadline, hasRun ? deadline : null,
          timestamp, hasRun ? timestamp : null, timestamp, timestamp, timestamp);
      appendEvent(db, current.collaboration_id, hasRun ? 'attempt_queued' : 'attempt_dispatching', {
        attemptNumber: nextAttempt,
        sessionId,
        runId,
        lifecyclePhase,
        deadline,
      }, taskId, attemptId);
      db.prepare('UPDATE collaborations SET state = \'running\', updated_at = ? WHERE id = ?').run(timestamp, current.collaboration_id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowAttempt(db.prepare(`SELECT a.*, t.collaboration_id FROM collaboration_attempts a
      JOIN collaboration_tasks t ON t.id = a.task_id WHERE a.id = ?`).get(attemptId));
  }, { mutate: true });
  await publishCollaborationInvalidation(attempt?.collaborationId);
  return attempt;
}

export async function bindAttemptRun(attemptId, {
  sessionId = '',
  runId = '',
  queueDeadlineMs = QUEUE_DEADLINE_MS,
} = {}) {
  const normalizedAttemptId = typeof attemptId === 'string' ? attemptId.trim() : '';
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
  if (!normalizedAttemptId || !normalizedRunId) return null;
  const attempt = await withDatabase((db) => {
    const timestamp = nowIso();
    const queueDeadline = isoAfter(timestamp, positiveDuration(queueDeadlineMs, QUEUE_DEADLINE_MS));
    db.exec('BEGIN IMMEDIATE');
    try {
      const attempt = db.prepare('SELECT * FROM collaboration_attempts WHERE id = ?').get(normalizedAttemptId);
      if (!attempt || attempt.state !== 'running') {
        db.exec('COMMIT');
        return null;
      }
      if (attempt.run_id && attempt.run_id !== normalizedRunId) {
        db.exec('ROLLBACK');
        return null;
      }
      const task = db.prepare('SELECT collaboration_id FROM collaboration_tasks WHERE id = ?').get(attempt.task_id);
      const changed = db.prepare(`UPDATE collaboration_attempts
        SET session_id = COALESCE(NULLIF(?, ''), session_id), run_id = ?, lifecycle_phase = 'queued',
            lease_until = ?, queue_deadline = COALESCE(queue_deadline, ?), queued_at = COALESCE(queued_at, ?),
            heartbeat_at = ?, last_observed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'running' AND (run_id IS NULL OR run_id = ?)`)
        .run(normalizedSessionId, normalizedRunId, queueDeadline, queueDeadline, timestamp,
          timestamp, timestamp, timestamp, normalizedAttemptId, normalizedRunId).changes;
      if (changed === 1) {
        appendEvent(db, task?.collaboration_id, 'attempt_queued', {
          sessionId: normalizedSessionId || attempt.session_id || '',
          runId: normalizedRunId,
          lifecyclePhase: 'queued',
          queueDeadline,
        }, attempt.task_id, normalizedAttemptId);
      }
      db.prepare(`UPDATE collaboration_tasks SET session_id = COALESCE(NULLIF(?, ''), session_id), run_id = ?, updated_at = ?
        WHERE id = ? AND state = 'running' AND (run_id IS NULL OR run_id = ?)`)
        .run(normalizedSessionId, normalizedRunId, timestamp, attempt.task_id, normalizedRunId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowAttempt(db.prepare(`SELECT a.*, t.collaboration_id FROM collaboration_attempts a
      JOIN collaboration_tasks t ON t.id = a.task_id WHERE a.id = ?`).get(normalizedAttemptId));
  }, { mutate: true });
  if (attempt) await publishAttemptInvalidation(normalizedAttemptId);
  return attempt;
}

// Persist the exact child-session delivery before invoking session-manager.
// The UNIQUE(attempt_id) constraint makes this an outbox: a caller may safely
// repeat enqueue after a restart and will get the original immutable payload.
export async function enqueueAttemptDispatch({
  collaborationId,
  taskId,
  attemptId,
  sessionId,
  requestId,
  prompt,
  options = {},
} = {}) {
  const normalized = {
    collaborationId: typeof collaborationId === 'string' ? collaborationId.trim() : '',
    taskId: typeof taskId === 'string' ? taskId.trim() : '',
    attemptId: typeof attemptId === 'string' ? attemptId.trim() : '',
    sessionId: typeof sessionId === 'string' ? sessionId.trim() : '',
    requestId: typeof requestId === 'string' ? requestId.trim() : '',
    prompt: typeof prompt === 'string' ? prompt : '',
    options: options && typeof options === 'object' ? options : {},
  };
  if (!normalized.collaborationId || !normalized.taskId || !normalized.attemptId
      || !normalized.sessionId || !normalized.requestId || !normalized.prompt) return null;
  const command = await withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT * FROM collaboration_dispatch_commands WHERE attempt_id = ?').get(normalized.attemptId);
      if (existing) {
        db.exec('COMMIT');
        return rowDispatchCommand(existing);
      }
      const attempt = db.prepare(`SELECT a.*, t.collaboration_id FROM collaboration_attempts a
        JOIN collaboration_tasks t ON t.id = a.task_id WHERE a.id = ?`).get(normalized.attemptId);
      if (!attempt || attempt.state !== 'running' || attempt.lifecycle_phase !== 'dispatching'
          || attempt.task_id !== normalized.taskId || attempt.collaboration_id !== normalized.collaborationId
          || (attempt.session_id && attempt.session_id !== normalized.sessionId)) {
        db.exec('COMMIT');
        return null;
      }
      const commandId = id('dispatch');
      db.prepare(`INSERT INTO collaboration_dispatch_commands
        (id, collaboration_id, task_id, attempt_id, session_id, request_id, payload_json,
         state, available_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(commandId, normalized.collaborationId, normalized.taskId, normalized.attemptId,
          normalized.sessionId, normalized.requestId,
          json({ prompt: normalized.prompt, options: normalized.options }, {}), timestamp, timestamp, timestamp);
      appendEvent(db, normalized.collaborationId, 'attempt_dispatch_enqueued', {
        commandId,
        requestId: normalized.requestId,
      }, normalized.taskId, normalized.attemptId);
      db.exec('COMMIT');
      return rowDispatchCommand(db.prepare('SELECT * FROM collaboration_dispatch_commands WHERE id = ?').get(commandId));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
  if (command) await publishCollaborationInvalidation(command.collaborationId);
  return command;
}

// Claim a bounded batch of due outbox records. A claimed record becomes due
// again after its lease, so a process killed between sendMessage() and its
// acknowledgement resumes delivery using the same requestId.
export async function claimPendingDispatchCommands({
  collaborationId = '',
  commandId = '',
  limit = 16,
  leaseMs = DISPATCH_COMMAND_LEASE_MS,
  now = new Date(),
} = {}) {
  const normalizedCollaborationId = typeof collaborationId === 'string' ? collaborationId.trim() : '';
  const normalizedCommandId = typeof commandId === 'string' ? commandId.trim() : '';
  const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 16, 128));
  const commandLeaseMs = positiveDuration(leaseMs, DISPATCH_COMMAND_LEASE_MS);
  const claimed = await withDatabase((db) => {
    const timestamp = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : nowIso();
    const leaseUntil = isoAfter(timestamp, commandLeaseMs);
    db.exec('BEGIN IMMEDIATE');
    try {
      const candidates = db.prepare(`SELECT d.* FROM collaboration_dispatch_commands d
        JOIN collaboration_attempts a ON a.id = d.attempt_id
        WHERE a.state = 'running' AND a.lifecycle_phase = 'dispatching'
          AND (d.state = 'pending' OR (d.state = 'claimed' AND d.lease_until IS NOT NULL AND d.lease_until <= ?))
          AND d.available_at <= ?
          AND (? = '' OR d.collaboration_id = ?)
          AND (? = '' OR d.id = ?)
        ORDER BY d.created_at, d.id LIMIT ?`)
        .all(timestamp, timestamp, normalizedCollaborationId, normalizedCollaborationId, normalizedCommandId, normalizedCommandId, boundedLimit);
      const output = [];
      for (const candidate of candidates) {
        if (!managedAttemptBindingAvailable(db,candidate.collaboration_id,candidate.task_id)) continue;
        const claimToken = id('claim');
        const changed = db.prepare(`UPDATE collaboration_dispatch_commands
          SET state = 'claimed', claim_token = ?, lease_until = ?, updated_at = ?
          WHERE id = ? AND (state = 'pending' OR (state = 'claimed' AND lease_until IS NOT NULL AND lease_until <= ?))`)
          .run(claimToken, leaseUntil, timestamp, candidate.id, timestamp).changes;
        if (changed !== 1) continue;
        appendEvent(db, candidate.collaboration_id, 'attempt_dispatch_claimed', {
          commandId: candidate.id,
          leaseUntil,
        }, candidate.task_id, candidate.attempt_id);
        output.push(rowDispatchCommand(db.prepare('SELECT * FROM collaboration_dispatch_commands WHERE id = ?').get(candidate.id)));
      }
      db.exec('COMMIT');
      return output;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
  await Promise.all([...new Set(claimed.map((command) => command.collaborationId))].map((id) => publishCollaborationInvalidation(id)));
  return claimed;
}

// Atomically record the session-manager admission and bind its Run to the
// Attempt. This closes the former crash window where a child Run had started
// but the collaboration store still looked like it had never been dispatched.
export async function completeAttemptDispatch(commandId, {
  claimToken,
  runId,
  queueDeadlineMs = QUEUE_DEADLINE_MS,
  verify = null,
} = {}) {
  const normalizedCommandId = typeof commandId === 'string' ? commandId.trim() : '';
  const normalizedClaimToken = typeof claimToken === 'string' ? claimToken.trim() : '';
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
  if (!normalizedCommandId || !normalizedClaimToken || !normalizedRunId) return null;
  const outcome = await withDatabase((db) => {
    const timestamp = nowIso();
    const queueDeadline = isoAfter(timestamp, positiveDuration(queueDeadlineMs, QUEUE_DEADLINE_MS));
    db.exec('BEGIN IMMEDIATE');
    try {
      const command = db.prepare('SELECT * FROM collaboration_dispatch_commands WHERE id = ?').get(normalizedCommandId);
      if (!command || command.state !== 'claimed' || command.claim_token !== normalizedClaimToken) {
        db.exec('COMMIT');
        return null;
      }
      const attempt = db.prepare(`SELECT a.*, t.collaboration_id FROM collaboration_attempts a
        JOIN collaboration_tasks t ON t.id = a.task_id WHERE a.id = ?`).get(command.attempt_id);
      if (!attempt || attempt.state !== 'running' || attempt.lifecycle_phase !== 'dispatching'
          || (attempt.run_id && attempt.run_id !== normalizedRunId)) {
        db.exec('COMMIT');
        return null;
      }
      if (verify && (typeof verify !== 'function' || verify({db,command,attempt}) !== true)) {
        db.exec('COMMIT');
        return null;
      }
      const commandChanged = db.prepare(`UPDATE collaboration_dispatch_commands
        SET state = 'completed', run_id = ?, lease_until = NULL, claim_token = NULL, updated_at = ?
        WHERE id = ? AND state = 'claimed' AND claim_token = ?`)
        .run(normalizedRunId, timestamp, normalizedCommandId, normalizedClaimToken).changes;
      if (commandChanged !== 1) {
        db.exec('COMMIT');
        return null;
      }
      db.prepare(`UPDATE collaboration_attempts SET session_id = COALESCE(NULLIF(?, ''), session_id), run_id = ?, lifecycle_phase = 'queued', lease_until = ?,
        queue_deadline = ?, queued_at = COALESCE(queued_at, ?), heartbeat_at = ?, last_observed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'running' AND lifecycle_phase = 'dispatching'`)
        .run(command.session_id, normalizedRunId, queueDeadline, queueDeadline, timestamp, timestamp, timestamp, timestamp, attempt.id);
      db.prepare(`UPDATE collaboration_tasks SET session_id = COALESCE(NULLIF(?, ''), session_id), run_id = ?, updated_at = ?
        WHERE id = ? AND state = 'running' AND run_id IS NULL`)
        .run(command.session_id, normalizedRunId, timestamp, attempt.task_id);
      appendEvent(db, attempt.collaboration_id, 'attempt_queued', {
        sessionId: command.session_id,
        runId: normalizedRunId,
        lifecyclePhase: 'queued',
        queueDeadline,
        commandId: normalizedCommandId,
      }, attempt.task_id, attempt.id);
      db.exec('COMMIT');
      return rowAttempt(db.prepare(`SELECT a.*, t.collaboration_id FROM collaboration_attempts a
        JOIN collaboration_tasks t ON t.id = a.task_id WHERE a.id = ?`).get(attempt.id));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
  if (outcome) await publishAttemptInvalidation(outcome.id);
  return outcome;
}

// A transport/admission error is intentionally not treated as a failed child
// task. The durable command returns to pending after a small backoff, while
// the Attempt's dispatch deadline remains the ultimate bounded failure rule.
export async function deferAttemptDispatch(commandId, {
  claimToken,
  reason = '',
  delayMs = DISPATCH_RETRY_DELAY_MS,
} = {}) {
  const normalizedCommandId = typeof commandId === 'string' ? commandId.trim() : '';
  const normalizedClaimToken = typeof claimToken === 'string' ? claimToken.trim() : '';
  if (!normalizedCommandId || !normalizedClaimToken) return false;
  const changed = await withDatabase((db) => {
    const timestamp = nowIso();
    const availableAt = isoAfter(timestamp, positiveDuration(delayMs, DISPATCH_RETRY_DELAY_MS));
    const command = db.prepare('SELECT * FROM collaboration_dispatch_commands WHERE id = ?').get(normalizedCommandId);
    if (!command || command.state !== 'claimed' || command.claim_token !== normalizedClaimToken) return false;
    const updated = db.prepare(`UPDATE collaboration_dispatch_commands
      SET state = 'pending', claim_token = NULL, lease_until = NULL, available_at = ?, failure_reason = ?, updated_at = ?
      WHERE id = ? AND state = 'claimed' AND claim_token = ?`)
      .run(availableAt, typeof reason === 'string' ? reason.slice(0, 2000) : String(reason).slice(0, 2000), timestamp,
        normalizedCommandId, normalizedClaimToken).changes > 0;
    if (updated) appendEvent(db, command.collaboration_id, 'attempt_dispatch_deferred', {
      commandId: normalizedCommandId,
      availableAt,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : String(reason).slice(0, 500),
    }, command.task_id, command.attempt_id);
    return updated;
  }, { mutate: true });
  return changed;
}

export async function findAttemptByRunId(runId) {
  return withDatabase((db) => rowAttempt(db.prepare(`SELECT a.*, t.collaboration_id FROM collaboration_attempts a
    JOIN collaboration_tasks t ON t.id = a.task_id WHERE a.run_id = ?`).get(runId)));
}

export async function heartbeatAttempt(attemptId, leaseMs = LEASE_MS) {
  return withDatabase((db) => {
    const timestamp = nowIso();
    const deadline = isoAfter(timestamp, positiveDuration(leaseMs, LEASE_MS));
    const attempt = db.prepare('SELECT lifecycle_phase FROM collaboration_attempts WHERE id = ?').get(attemptId);
    if (!attempt || !['dispatching', 'queued', 'running'].includes(attempt.lifecycle_phase || 'running')) return false;
    const phase = attempt.lifecycle_phase || 'running';
    const deadlineColumn = phase === 'dispatching'
      ? 'dispatch_deadline'
      : phase === 'queued' ? 'queue_deadline' : 'execution_deadline';
    return db.prepare(`UPDATE collaboration_attempts
      SET heartbeat_at = ?, last_observed_at = ?, lease_until = ?, ${deadlineColumn} = ?, updated_at = ?
      WHERE id = ? AND state = 'running'`)
      .run(timestamp, timestamp, deadline, deadline, timestamp, attemptId).changes > 0;
  }, { mutate: true });
}

// Record a harness-neutral observation of a durable Run.  Every provider
// already projects the same run state and runnerStartedAt fields, so the
// collaboration layer deliberately does not inspect provider-specific output.
export async function observeAttemptRun(attemptId, {
  runState = '',
  runnerStartedAt = '',
  approvalWaiting = false,
  approvalDeadline = '',
  observedAt = new Date(),
} = {}) {
  const observedDate = observedAt instanceof Date && !Number.isNaN(observedAt.getTime())
    ? observedAt
    : new Date();
  const observedText = observedDate.toISOString();
  const normalizedRunState = typeof runState === 'string' ? runState.trim().toLowerCase() : '';
  const explicitRunnerStart = typeof runnerStartedAt === 'string' && runnerStartedAt.trim()
    ? runnerStartedAt.trim()
    : '';
  const outcome = await withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`SELECT a.*, t.timeout_ms, t.collaboration_id FROM collaboration_attempts a
        JOIN collaboration_tasks t ON t.id = a.task_id WHERE a.id = ?`).get(attemptId);
      if (!row || row.state !== 'running') {
        db.exec('COMMIT');
        return null;
      }
      if (approvalWaiting === true) {
        const deadlineMs = Date.parse(approvalDeadline);
        const deadline = Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null;
        const approvalState = !deadline ? 'deadline_unknown' : observedDate.getTime() >= deadlineMs ? 'deadline_elapsed' : 'waiting';
        db.prepare(`UPDATE collaboration_attempts SET approval_wait_started_at=COALESCE(approval_wait_started_at,?),
          approval_deadline=?,approval_state=?,last_observed_at=?,updated_at=? WHERE id=? AND state='running'`).run(observedText,deadline,approvalState,observedText,observedText,attemptId);
        db.exec('COMMIT');
        return rowAttempt(db.prepare(`SELECT a.*,t.collaboration_id FROM collaboration_attempts a JOIN collaboration_tasks t ON t.id=a.task_id WHERE a.id=?`).get(attemptId));
      }
      if (row.approval_wait_started_at) {
        const started = Date.parse(row.approval_wait_started_at);
        const elapsed = Number.isFinite(started) ? Math.max(0, observedDate.getTime() - started) : 0;
        for (const column of ['dispatch_deadline','queue_deadline','execution_deadline','lease_until']) {
          if (row[column] && Number.isFinite(Date.parse(row[column]))) row[column] = new Date(Date.parse(row[column]) + elapsed).toISOString();
        }
        db.prepare(`UPDATE collaboration_attempts SET approval_wait_started_at=NULL,approval_deadline=NULL,approval_state=NULL,dispatch_deadline=?,queue_deadline=?,execution_deadline=?,lease_until=?,updated_at=? WHERE id=? AND state='running'`)
          .run(row.dispatch_deadline,row.queue_deadline,row.execution_deadline,row.lease_until,observedText,attemptId);
      }
      const wasRunning = row.lifecycle_phase === 'running' || !!row.runner_started_at;
      const observedRunning = wasRunning || !!explicitRunnerStart || ['accepted', 'running'].includes(normalizedRunState);
      if (observedRunning) {
        const runnerStart = row.runner_started_at || explicitRunnerStart || observedText;
        const executionDeadline = row.execution_deadline
          || isoAfter(runnerStart, positiveDuration(row.timeout_ms, LEASE_MS));
        const changed = db.prepare(`UPDATE collaboration_attempts
          SET lifecycle_phase = 'running', runner_started_at = ?, started_at = COALESCE(started_at, ?),
              execution_deadline = ?, lease_until = ?, heartbeat_at = ?, last_observed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'running'`)
          .run(runnerStart, runnerStart, executionDeadline, executionDeadline, observedText, observedText, observedText, attemptId).changes;
        if (changed && !wasRunning) {
          appendEvent(db, row.collaboration_id, 'attempt_running', {
            runId: row.run_id || '', lifecyclePhase: 'running', runnerStartedAt: runnerStart, executionDeadline,
          }, row.task_id, attemptId);
        }
      } else {
        // An admitted but not-yet-started Run is still healthy queue work. Do
        // not reset queue_deadline here: that deadline bounds a genuinely
        // stalled scheduler while observations prove the control path alive.
        db.prepare(`UPDATE collaboration_attempts
          SET lifecycle_phase = 'queued', heartbeat_at = ?, last_observed_at = ?,
              lease_until = COALESCE(queue_deadline, lease_until), updated_at = ?
          WHERE id = ? AND state = 'running'`)
          .run(observedText, observedText, observedText, attemptId);
      }
      db.exec('COMMIT');
      return rowAttempt(db.prepare(`SELECT a.*, t.collaboration_id FROM collaboration_attempts a
        JOIN collaboration_tasks t ON t.id = a.task_id WHERE a.id = ?`).get(attemptId));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
  if (outcome) await publishAttemptInvalidation(attemptId);
  return outcome;
}

export async function completeAttempt(attemptId, result = {}, now = new Date()) {
  const outcome = await withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const attempt = db.prepare('SELECT * FROM collaboration_attempts WHERE id = ?').get(attemptId);
      if (!attempt) {
        db.exec('COMMIT');
        return null;
      }
      const task = db.prepare('SELECT * FROM collaboration_tasks WHERE id = ?').get(attempt.task_id);
      // A reconciler can race a terminal spool/result observation.  Terminal
      // Run truth wins while the Attempt is live.  If an old unknown-outcome
      // expiry already closed the same generation, an explicitly verified
      // successful Run may repair it, but it can never overwrite a retry or a
      // cancellation.
      const recoveringExpiredSuccess = result.allowRecovery === true
        && result.state === 'succeeded'
        && attempt.state === 'failed'
        && attempt.failure_kind === 'unknown_outcome'
        && Number(task?.current_attempt) === Number(attempt.attempt_number)
        && task?.state === 'failed';
      const expectedState = recoveringExpiredSuccess ? 'failed' : 'running';
      if (attempt.state !== expectedState) {
        db.exec('COMMIT');
        return null;
      }
      const changed = db.prepare(`UPDATE collaboration_attempts SET state = ?, completed_at = ?, failure_kind = ?, failure_reason = ?,
        envelope_json = ?, report_json = ?, result_packet_id = ?, lease_until = NULL, updated_at = ?
        WHERE id = ? AND state = ?`)
        .run(result.state, timestamp, result.failureKind || null, result.failureReason || null,
          json(result.envelope, null), json(result.report, null), result.resultPacketId || null,
          timestamp, attemptId, expectedState).changes;
      if (changed !== 1) {
        db.exec('COMMIT');
        return null;
      }
      const safeAdmissionRetry = false;
      if (result.serverAdmissionFailure === 'read_only_runtime_unavailable'
          && result.failureKind === 'deterministic_failure' && result.state === 'failed' && !attempt.run_id
          && attempt.lifecycle_phase === 'dispatching' && Number(task?.current_attempt) === Number(attempt.attempt_number)
          && !db.prepare('SELECT 1 FROM collaboration_dispatch_commands WHERE attempt_id=?').get(attemptId)) {
        const collaboration = db.prepare('SELECT plan_version,policy_json,state FROM collaborations WHERE id=?').get(task.collaboration_id);
        const policy = parseJson(collaboration?.policy_json, {});
        const retryPolicy = parseJson(task.retry_json, { maxAttempts: 1, retryOn: [] });
        const budget = Math.max(1, Math.min(Number(retryPolicy.maxAttempts) || 1, 5));
        let bindingAvailable = false;
        try { bindingAvailable = managedAttemptBindingAvailable(db,task.collaboration_id,task.id); } catch { /* No receipt without binding evidence. */ }
        if (collaboration && !['completed','cancelled'].includes(collaboration.state) && !policy.factoryExecution
            && Number(attempt.attempt_number) < budget && Array.isArray(retryPolicy.retryOn)
            && retryPolicy.retryOn.includes('deterministic_failure') && bindingAvailable) {
          db.prepare(`INSERT OR IGNORE INTO collaboration_replay_receipts
            (attempt_id,task_id,collaboration_id,attempt_number,plan_version,source,effective_attempt_budget,created_at,consumed_at)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(attemptId,task.id,task.collaboration_id,attempt.attempt_number,
            collaboration.plan_version,'read_only_runtime_unavailable_pre_dispatch',budget,timestamp,null);
        }
      }
      const nextTaskState = result.state === 'succeeded'
        ? 'succeeded'
        : safeAdmissionRetry ? 'retrying'
          : result.state === 'cancelled' ? 'cancelled' : 'failed';
      const taskChanged = db.prepare(`UPDATE collaboration_tasks SET state = ?, updated_at = ?
        WHERE id = ? AND current_attempt = ? AND state = ?`)
        .run(nextTaskState, timestamp, attempt.task_id, attempt.attempt_number, expectedState === 'failed' ? 'failed' : 'running').changes;
      if (taskChanged !== 1) {
        db.exec('ROLLBACK');
        return null;
      }
      appendEvent(db, task.collaboration_id, recoveringExpiredSuccess ? 'attempt_recovered' : 'attempt_completed', {
        ...result,
        retry: safeAdmissionRetry,
        recovered: recoveringExpiredSuccess,
      }, attempt.task_id, attemptId);
      db.prepare('UPDATE collaborations SET updated_at = ? WHERE id = ?').run(timestamp, task.collaboration_id);
      db.exec('COMMIT');
      return { collaborationId: task.collaboration_id, taskId: task.id, attempt: rowAttempt(db.prepare('SELECT * FROM collaboration_attempts WHERE id = ?').get(attemptId)) };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
  await publishCollaborationInvalidation(outcome?.collaborationId);
  return outcome;
}

export async function markReadyTasks(collaborationId) {
  const changed = await withDatabase((db) => {
    const timestamp = nowIso();
    const changed = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const tasks = db.prepare('SELECT * FROM collaboration_tasks WHERE collaboration_id = ?').all(collaborationId);
      const states = new Map(tasks.map((task) => [task.id, task.state]));
      for (const task of tasks) {
        if (task.state !== 'planned' && task.state !== 'retrying') continue;
        const deps = parseJson(task.depends_on_json, []);
        if (deps.every((dependency) => states.get(dependency) === 'succeeded')) {
          db.prepare("UPDATE collaboration_tasks SET state = 'ready', updated_at = ? WHERE id = ?").run(timestamp, task.id);
          changed.push(task.id);
        }
      }
      if (changed.length > 0) appendEvent(db, collaborationId, 'tasks_ready', { taskIds: changed });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }, { mutate: true });
  if (changed.length > 0) await publishCollaborationInvalidation(collaborationId);
  return changed;
}

export async function claimAggregation(collaborationId) {
  const generation = await withDatabase((db) => {
    const timestamp = nowIso();
    const leaseUntil = new Date(Date.now() + AGGREGATION_LEASE_MS).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM collaborations WHERE id = ?').get(collaborationId);
      if (!row || row.state === 'completed' || row.state === 'failed' || row.state === 'cancelled') {
        db.exec('COMMIT');
        return null;
      }
      const reclaiming = row.state === 'aggregating'
        && row.aggregation_claimed_generation >= row.aggregation_generation
        && !row.aggregation_run_id
        && (!row.aggregation_lease_until || row.aggregation_lease_until < timestamp);
      if (row.aggregation_claimed_generation >= row.aggregation_generation && !reclaiming) {
        db.exec('COMMIT');
        return null;
      }
      const changed = reclaiming
        ? db.prepare(`UPDATE collaborations SET aggregation_lease_until = ?, updated_at = ?
            WHERE id = ? AND state = 'aggregating' AND aggregation_run_id IS NULL
              AND aggregation_claimed_generation = aggregation_generation
              AND (aggregation_lease_until IS NULL OR aggregation_lease_until < ?)`)
          .run(leaseUntil, timestamp, collaborationId, timestamp).changes
        : db.prepare(`UPDATE collaborations SET state = 'aggregating',
            aggregation_claimed_generation = aggregation_generation, aggregation_lease_until = ?, updated_at = ?
            WHERE id = ? AND aggregation_claimed_generation < aggregation_generation`)
          .run(leaseUntil, timestamp, collaborationId).changes;
      if (changed !== 1) {
        db.exec('COMMIT');
        return null;
      }
      appendEvent(db, collaborationId, reclaiming ? 'aggregation_reclaimed' : 'aggregation_claimed', {
        generation: row.aggregation_generation,
        leaseUntil,
      });
      db.exec('COMMIT');
      return row.aggregation_generation;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
  if (generation !== null && generation !== undefined) await publishCollaborationInvalidation(collaborationId);
  return generation;
}

// A manager aggregation is an internal control-plane command, never an owner
// follow-up.  If the root Session is occupied, release the claim without
// advancing the aggregation generation so reconciliation can safely claim the
// exact same bounded ResultPacket set later.  The CAS guards against a late
// busy observation undoing a Run that another dispatcher has already started.
export async function deferAggregation(collaborationId, {
  generation,
  reason = 'Root session is busy',
} = {}) {
  const normalizedId = typeof collaborationId === 'string' ? collaborationId.trim() : '';
  const normalizedGeneration = Number(generation);
  if (!normalizedId || !Number.isInteger(normalizedGeneration) || normalizedGeneration < 1) return false;
  const changed = await withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM collaborations WHERE id = ?').get(normalizedId);
      if (!row
          || row.state !== 'aggregating'
          || Number(row.aggregation_generation) !== normalizedGeneration
          || Number(row.aggregation_claimed_generation) !== normalizedGeneration
          || row.aggregation_run_id) {
        db.exec('COMMIT');
        return false;
      }
      const updated = db.prepare(`UPDATE collaborations
        SET state = 'waiting_aggregation', aggregation_claimed_generation = ?,
            aggregation_lease_until = NULL, updated_at = ?
        WHERE id = ? AND state = 'aggregating' AND aggregation_generation = ?
          AND aggregation_claimed_generation = ? AND aggregation_run_id IS NULL`)
        .run(Math.max(0, normalizedGeneration - 1), timestamp, normalizedId,
          normalizedGeneration, normalizedGeneration).changes === 1;
      if (updated) {
        appendEvent(db, normalizedId, 'aggregation_deferred', {
          generation: normalizedGeneration,
          reason: typeof reason === 'string' ? reason.slice(0, 500) : String(reason).slice(0, 500),
        });
      }
      db.exec('COMMIT');
      return updated;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
  if (changed) await publishCollaborationInvalidation(normalizedId);
  return changed;
}

export async function refreshBarrier(collaborationId) {
  const refreshed = await withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM collaborations WHERE id = ?').get(collaborationId);
      if (!row) {
        db.exec('COMMIT');
        return null;
      }
      const tasks = db.prepare('SELECT state FROM collaboration_tasks WHERE collaboration_id = ?').all(collaborationId);
      const succeeded = tasks.length > 0 && tasks.every((task) => task.state === 'succeeded');
      const failed = tasks.some((task) => ['failed', 'cancelled'].includes(task.state));
      const factoryOwned = Boolean(parseJson(row.policy_json, {})?.factoryExecution);
      if (succeeded && factoryOwned && !['completed', 'cancelled'].includes(row.state)) {
        db.prepare("UPDATE collaborations SET state = 'completed', updated_at = ? WHERE id = ? AND state NOT IN ('completed', 'cancelled')")
          .run(timestamp, collaborationId);
      } else
      if (succeeded && !['aggregating', 'waiting_aggregation', 'completed', 'cancelled'].includes(row.state)) {
        db.prepare(`UPDATE collaborations SET aggregation_generation = aggregation_generation + 1,
          state = 'waiting_aggregation', updated_at = ? WHERE id = ? AND state NOT IN ('completed', 'cancelled', 'waiting_aggregation', 'aggregating')`)
          .run(timestamp, collaborationId);
      } else if (failed
        && !tasks.some((task) => ['running', 'ready', 'retrying'].includes(task.state))
        && !['failed', 'completed', 'cancelled'].includes(row.state)) {
        db.prepare("UPDATE collaborations SET state = 'failed', updated_at = ? WHERE id = ? AND state NOT IN ('completed', 'cancelled')")
          .run(timestamp, collaborationId);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return db.prepare('SELECT * FROM collaborations WHERE id = ?').get(collaborationId);
  }, { mutate: true });
  await publishCollaborationInvalidation(collaborationId);
  return refreshed;
}

export async function setAggregationRun(collaborationId, runId) {
  const changed = await withDatabase((db) => db.prepare('UPDATE collaborations SET aggregation_run_id = ?, aggregation_lease_until = NULL, updated_at = ? WHERE id = ?').run(runId, nowIso(), collaborationId).changes > 0, { mutate: true });
  if (changed) await publishCollaborationInvalidation(collaborationId);
  return changed;
}

export async function finishCollaboration(collaborationId, state, reason = '') {
  const changed = await withDatabase((db) => {
    const changed = db.prepare("UPDATE collaborations SET state = ?, aggregation_lease_until = NULL, updated_at = ? WHERE id = ? AND state NOT IN ('completed', 'failed', 'cancelled')")
      .run(state, nowIso(), collaborationId).changes;
    if (changed) appendEvent(db, collaborationId, 'collaboration_finished', { state, reason });
    return changed > 0;
  }, { mutate: true });
  if (changed) await publishCollaborationInvalidation(collaborationId);
  return changed;
}

export async function cancelCollaboration(collaborationId, reason = 'cancelled by manager') {
  const cancelled = await withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM collaborations WHERE id = ?').get(collaborationId);
      if (!row || ['completed', 'failed', 'cancelled'].includes(row.state)) {
        db.exec('COMMIT');
        return false;
      }
      db.prepare(`UPDATE collaboration_attempts SET state = 'cancelled', completed_at = ?, failure_kind = 'cancelled',
        failure_reason = ?, updated_at = ? WHERE task_id IN (SELECT id FROM collaboration_tasks WHERE collaboration_id = ?) AND state = 'running'`)
        .run(timestamp, reason, timestamp, collaborationId);
      db.prepare(`UPDATE collaboration_dispatch_commands SET state = 'cancelled', claim_token = NULL, lease_until = NULL,
        failure_reason = ?, updated_at = ? WHERE collaboration_id = ? AND state IN ('pending', 'claimed')`)
        .run(reason, timestamp, collaborationId);
      db.prepare(`UPDATE collaboration_tasks SET state = 'cancelled', updated_at = ?
        WHERE collaboration_id = ? AND state NOT IN ('succeeded', 'failed', 'cancelled')`)
        .run(timestamp, collaborationId);
      db.prepare("UPDATE collaborations SET state = 'cancelled', aggregation_lease_until = NULL, updated_at = ? WHERE id = ?").run(timestamp, collaborationId);
      appendEvent(db, collaborationId, 'collaboration_finished', { state: 'cancelled', reason });
      db.exec('COMMIT');
      return true;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
  if (cancelled) await publishCollaborationInvalidation(collaborationId);
  return cancelled;
}

export async function listExpiredAttempts(now = new Date()) {
  const nowText = now.toISOString();
  return withDatabase((db) => db.prepare(`SELECT a.*, t.collaboration_id
    FROM collaboration_attempts a
    JOIN collaboration_tasks t ON t.id = a.task_id
    WHERE a.state = 'running' AND a.approval_wait_started_at IS NULL AND (
      (a.lifecycle_phase = 'dispatching' AND COALESCE(a.dispatch_deadline, a.lease_until) < ?)
      OR (a.lifecycle_phase = 'queued' AND COALESCE(a.queue_deadline, a.lease_until) < ?)
      OR (a.lifecycle_phase = 'running' AND COALESCE(a.execution_deadline, a.lease_until) < ?)
      OR (a.lifecycle_phase NOT IN ('dispatching', 'queued', 'running') AND a.lease_until < ?)
    )`).all(nowText, nowText, nowText, nowText).map(rowAttempt));
}

// Keep a bounded recovery window for a Run that terminalized just after an
// earlier timeout sweep.  This is not a blind retry: the original Run id and
// Attempt generation must still match, and completeAttempt only admits a
// verified successful terminal result.
export async function listRecoverableAttemptRuns({
  since = new Date(Date.now() - 24 * 60 * 60 * 1000),
  limit = 64,
} = {}) {
  const sinceText = since instanceof Date && !Number.isNaN(since.getTime())
    ? since.toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 64, 512));
  return withDatabase((db) => db.prepare(`SELECT a.*, t.collaboration_id
    FROM collaboration_attempts a
    JOIN collaboration_tasks t ON t.id = a.task_id
    JOIN collaborations c ON c.id = t.collaboration_id
    WHERE a.state = 'failed' AND a.failure_kind = 'unknown_outcome'
      AND a.run_id IS NOT NULL AND a.run_id != ''
      AND t.state = 'failed' AND t.current_attempt = a.attempt_number
      AND c.state = 'failed' AND a.completed_at >= ?
    ORDER BY a.completed_at DESC LIMIT ?`).all(sinceText, boundedLimit).map(rowAttempt));
}

export async function listActiveAggregationLeases(now = new Date()) {
  const nowText = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString();
  return withDatabase((db) => db.prepare(`SELECT * FROM collaborations
    WHERE state = 'aggregating' AND aggregation_run_id IS NULL
      AND aggregation_lease_until IS NOT NULL AND aggregation_lease_until <= ?
    ORDER BY updated_at, id`).all(nowText).map((row) => ({
    id: row.id,
    aggregationGeneration: row.aggregation_generation,
    aggregationClaimedGeneration: row.aggregation_claimed_generation,
    aggregationLeaseUntil: row.aggregation_lease_until || '',
  })));
}

export async function requeueExpiredAttempt(attemptId, {
  retry = false,
  failureKind = 'unknown_outcome',
  reason = 'Attempt lease expired',
  now = new Date(),
} = {}) {
  const outcome = await withDatabase((db) => {
    const timestamp = nowIso();
    const checkNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const checkNowText = checkNow.toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const attempt = db.prepare(`SELECT a.*, t.collaboration_id FROM collaboration_attempts a
        JOIN collaboration_tasks t ON t.id = a.task_id WHERE a.id = ?`).get(attemptId);
      const deadline = phaseDeadline(attempt);
      if (!attempt || attempt.state !== 'running' || attempt.approval_wait_started_at || !deadline || deadline >= checkNowText) {
        db.exec('COMMIT');
        return null;
      }
      // A deadline is not proof that dispatch or external effects did not
      // occur. Only the separately receipted admission path can retry.
      const shouldRetry = false;
      db.prepare(`UPDATE collaboration_attempts SET state = 'failed', completed_at = ?, failure_kind = ?, failure_reason = ?,
        lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'running'`)
        .run(timestamp, failureKind, reason, timestamp, attemptId);
      // Never deliver a stale command after the Attempt has crossed its phase
      // deadline. A retry receives a new Attempt and therefore a new command.
      db.prepare(`UPDATE collaboration_dispatch_commands SET state = 'cancelled', claim_token = NULL, lease_until = NULL,
        failure_reason = ?, updated_at = ? WHERE attempt_id = ? AND state IN ('pending', 'claimed')`)
        .run(reason, timestamp, attemptId);
      db.prepare(`UPDATE collaboration_tasks SET state = ?, updated_at = ? WHERE id = ? AND state = 'running'`)
        .run(shouldRetry ? 'retrying' : 'failed', timestamp, attempt.task_id);
      appendEvent(db, attempt.collaboration_id, 'attempt_expired', {
        retry: shouldRetry,
        failureKind,
        reason,
        lifecyclePhase: attempt.lifecycle_phase || 'running',
        deadline,
      }, attempt.task_id, attemptId);
      if (shouldRetry) {
        db.prepare("UPDATE collaborations SET state = CASE WHEN state = 'failed' THEN 'ready' ELSE state END, updated_at = ? WHERE id = ?")
          .run(timestamp, attempt.collaboration_id);
      }
      db.prepare('UPDATE collaborations SET updated_at = ? WHERE id = ?').run(timestamp, attempt.collaboration_id);
      db.exec('COMMIT');
      return {
        ...rowAttempt(db.prepare('SELECT * FROM collaboration_attempts WHERE id = ?').get(attemptId)),
        collaborationId: attempt.collaboration_id,
        retryScheduled: shouldRetry,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
  await publishCollaborationInvalidation(outcome?.collaborationId);
  return outcome;
}

export async function retryFailedAttempt(attemptId, { reason = 'manual retry requested' } = {}) {
  const outcome = await withDatabase((db) => {
    const timestamp = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`SELECT a.*, t.collaboration_id, t.state AS task_state, t.current_attempt,
          t.retry_json, c.state AS collaboration_state
        FROM collaboration_attempts a
        JOIN collaboration_tasks t ON t.id = a.task_id
        JOIN collaborations c ON c.id = t.collaboration_id
        WHERE a.id = ?`).get(attemptId);
      if (!row || row.state !== 'failed' || row.task_state !== 'failed'
        || ['completed', 'cancelled'].includes(row.collaboration_state)) {
        db.exec('COMMIT');
        return null;
      }
      const receipt = db.prepare('SELECT * FROM collaboration_replay_receipts WHERE attempt_id=? AND consumed_at IS NULL').get(attemptId);
      const collaboration = db.prepare('SELECT plan_version,policy_json FROM collaborations WHERE id=?').get(row.collaboration_id);
      const retryPolicy = parseJson(row.retry_json, { maxAttempts: 1, retryOn: [] });
      const policy = parseJson(collaboration?.policy_json, {});
      const allowed = !!receipt && receipt.source === 'read_only_runtime_unavailable_pre_dispatch'
        && row.failure_kind === 'deterministic_failure' && !row.run_id && Number(row.current_attempt) === Number(row.attempt_number)
        && !db.prepare('SELECT 1 FROM collaboration_dispatch_commands WHERE attempt_id=?').get(attemptId)
        && !policy.factoryExecution && collaboration?.plan_version === receipt.plan_version
        && receipt.task_id === row.task_id && receipt.collaboration_id === row.collaboration_id
        && receipt.attempt_number === row.attempt_number && Number(row.attempt_number) < receipt.effective_attempt_budget
        && Number(retryPolicy.maxAttempts) === receipt.effective_attempt_budget
        && Array.isArray(retryPolicy.retryOn) && retryPolicy.retryOn.includes('deterministic_failure')
        && managedAttemptBindingAvailable(db,row.collaboration_id,row.task_id);
      if (!allowed) {
        db.exec('COMMIT');
        return null;
      }
      const changed = db.prepare("UPDATE collaboration_tasks SET state = 'retrying', updated_at = ? WHERE id = ? AND state = 'failed'")
        .run(timestamp, row.task_id).changes;
      if (changed !== 1) {
        db.exec('COMMIT');
        return null;
      }
      if (db.prepare('UPDATE collaboration_replay_receipts SET consumed_at=? WHERE attempt_id=? AND consumed_at IS NULL').run(timestamp,attemptId).changes !== 1) {
        db.exec('ROLLBACK'); return null;
      }
      db.prepare("UPDATE collaborations SET state = CASE WHEN state = 'failed' THEN 'ready' ELSE state END, updated_at = ? WHERE id = ?")
        .run(timestamp, row.collaboration_id);
      appendEvent(db, row.collaboration_id, 'attempt_retry_requested', {
        reason,
        failureKind: row.failure_kind || 'unknown_outcome',
        attemptNumber: row.attempt_number,
        effectiveAttemptBudget: receipt.effective_attempt_budget,
        reconciliation: receipt.source,
      }, row.task_id, row.id);
      db.exec('COMMIT');
      return rowAttempt(db.prepare(`SELECT a.*, t.collaboration_id FROM collaboration_attempts a
        JOIN collaboration_tasks t ON t.id = a.task_id WHERE a.id = ?`).get(attemptId));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }, { mutate: true });
  if (outcome) await publishAttemptInvalidation(attemptId);
  return outcome;
}

export { LEASE_MS };
