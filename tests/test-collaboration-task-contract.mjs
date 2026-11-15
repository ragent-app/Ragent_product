#!/usr/bin/env node
// P1-T2 C3: Task 完整只读契约持久化。
// - collaboration_tasks runtime_json + 六契约列(task_kind/access_mode/
//   read_only_required/execution_isolation/runner_id/runner_unit_scope)新建即含、
//   老库迁移补齐且默认值正确。
// - taskKind=consultation 落库可读回,字段齐全;默认 execution 任务回归兼容。
// - collaboration-plan.mjs 编译校验:consultation 写路径(非空 writablePaths 或
//   accessMode=write)抛 CONSULTATION_READONLY_VIOLATION(403);只读+空 writablePaths 通过。
// - taskKind=consultation 时 readOnlyRequired 恒为 true(Runtime 强制只读)。
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

// 隔离临时 HOME + RAGENT_CONFIG_DIR —— 必须在 import 任何被测模块之前设置。
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-collab-task-contract-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');

const store = await import('../chat/collaboration-store.mjs');
const { compileCollaborationPlan, CONSULTATION_READONLY_VIOLATION } = await import('../chat/collaboration-plan.mjs');
const { normalizeCollaborationPolicy } = await import('../chat/collaboration-policy.mjs');
const { CHAT_COLLABORATIONS_DB, CHAT_COLLABORATIONS_DIR } = await import('../lib/config.mjs');

const TASK_CONTRACT_COLUMNS = [
  'runtime_json',
  'task_kind',
  'access_mode',
  'read_only_required',
  'execution_isolation',
  'runner_id',
  'runner_unit_scope',
];

function makePolicy(overrides = {}) {
  return normalizeCollaborationPolicy({ role: 'manager', canDelegate: true, ...overrides });
}

function makePlan(taskDefs, policy = makePolicy(), input = {}) {
  return compileCollaborationPlan({ title: 'task contract plan', tasks: taskDefs, ...input }, policy);
}

function columnNames(db) {
  return new Set(db.prepare('PRAGMA table_info(collaboration_tasks)').all().map((c) => c.name));
}

// 1) 新库建表即含六契约列。
async function testFreshSchema() {
  rmSync(CHAT_COLLABORATIONS_DIR, { recursive: true, force: true });
  await store.initializeCollaborationStore();
  const db = store.openDatabase();
  const cols = columnNames(db);
  db.close();
  for (const col of TASK_CONTRACT_COLUMNS) {
    assert.ok(cols.has(col), `fresh DB should have collaboration_tasks.${col}`);
  }
}

// 2) 写 consultation 任务(accessMode=read)→ 落库可读回,字段齐全。
async function testConsultationRoundTrip() {
  const policy = makePolicy();
  const plan = makePlan([{
    id: 'consult-task',
    objective: 'review the design',
    agentId: 'agent-1',
    taskKind: 'consultation',
    accessMode: 'read',
    executionIsolation: 'shared',
    runnerId: 'runner-consult',
    runnerUnitScope: 'round-1',
  }], policy);
  assert.equal(plan.tasks[0].taskKind, 'consultation');
  assert.equal(plan.tasks[0].readOnlyRequired, true, 'compiler forces readOnlyRequired for consultation');
  assert.equal(plan.tasks[0].accessMode, 'read');

  const collab = await store.createCollaborationRecord({
    rootSessionId: 'consult-root',
    title: 'consult',
    policy,
    plan,
  });
  const task = collab.tasks[0];
  assert.equal(task.taskKind, 'consultation', 'consultation task persists taskKind');
  assert.equal(task.readOnlyRequired, true, 'consultation task persists readOnlyRequired=true');
  assert.equal(task.accessMode, 'read', 'consultation task persists accessMode');
  assert.equal(task.executionIsolation, 'shared', 'consultation task persists executionIsolation');
  assert.equal(task.runnerId, 'runner-consult', 'consultation task persists runnerId');
  assert.equal(task.runnerUnitScope, 'round-1', 'consultation task persists runnerUnitScope');
}

// 3) 默认 execution 任务(不带新字段)→ 读写行为与旧路径一致(回归兼容)。
async function testDefaultExecutionRegression() {
  const policy = makePolicy();
  const plan = makePlan([{ id: 'exec-task', objective: 'do the work', agentId: 'agent-1' }], policy);
  assert.equal(plan.tasks[0].taskKind, 'execution');
  assert.equal(plan.tasks[0].readOnlyRequired, false);
  assert.equal(plan.tasks[0].accessMode, undefined);
  assert.equal(plan.tasks[0].executionIsolation, undefined);
  assert.equal(plan.tasks[0].runnerId, undefined);
  assert.equal(plan.tasks[0].runnerUnitScope, undefined);

  const collab = await store.createCollaborationRecord({
    rootSessionId: 'exec-root',
    title: 'exec',
    policy,
    plan,
  });
  const persisted = collab.tasks[0];
  assert.equal(persisted.taskKind, 'execution', 'default execution task persists taskKind=execution');
  assert.equal(persisted.readOnlyRequired, false, 'default execution task persists readOnlyRequired=false');
  assert.equal(persisted.accessMode, '', 'default execution task keeps empty accessMode');
  assert.deepEqual(persisted.writablePaths, [], 'default execution task keeps empty writablePaths');

  // 完整生命周期回归:ready → claim → complete。
  await store.markReadyTasks(collab.id);
  const attempt = await store.claimTaskAttempt('exec-task', { sessionId: 's-exec', runId: 'run-exec' });
  assert.ok(attempt, 'default execution task is claimable');
  assert.equal(attempt.taskId, 'exec-task');
  assert.ok(await store.completeAttempt(attempt.id, { state: 'succeeded' }));
  const after = await store.getCollaboration(collab.id);
  assert.equal(after.tasks[0].state, 'succeeded');
}

// 4) plan 编译只读一致性校验:consultation 写路径被拒。
function testPlanReadonlyViolations() {
  const policy = makePolicy();
  assert.throws(
    () => makePlan([{ id: 'c1', objective: 'consult', agentId: 'agent-1', taskKind: 'consultation', writablePaths: ['/tmp/x'] }], policy),
    (err) => err.code === CONSULTATION_READONLY_VIOLATION && err.statusCode === 403,
    'consultation with non-empty writablePaths must throw CONSULTATION_READONLY_VIOLATION(403)',
  );
  assert.throws(
    () => makePlan([{ id: 'c2', objective: 'consult', agentId: 'agent-1', taskKind: 'consultation', accessMode: 'write' }], policy),
    (err) => err.code === CONSULTATION_READONLY_VIOLATION && err.statusCode === 403,
    'consultation with accessMode=write must throw CONSULTATION_READONLY_VIOLATION(403)',
  );
  // consultation + 只读 + 空 writablePaths → 通过。
  const plan = makePlan([{ id: 'c3', objective: 'consult', agentId: 'agent-1', taskKind: 'consultation', accessMode: 'read' }], policy);
  assert.equal(plan.tasks[0].taskKind, 'consultation');
  assert.equal(plan.tasks[0].readOnlyRequired, true);
}

// 5) taskKind=consultation 时 readOnlyRequired 恒 true(模型不可降级)。
function testConsultationForcesReadOnly() {
  const plan = makePlan([{
    id: 'c4',
    objective: 'consult',
    agentId: 'agent-1',
    taskKind: 'consultation',
    readOnlyRequired: false,
    accessMode: 'read',
  }], makePolicy());
  assert.equal(plan.tasks[0].readOnlyRequired, true, 'model cannot downgrade readOnlyRequired for consultation');
}

// 6) 模拟老库(无六列)→ 迁移补齐且默认值正确。
async function testLegacyMigration() {
  rmSync(CHAT_COLLABORATIONS_DIR, { recursive: true, force: true });
  mkdirSync(CHAT_COLLABORATIONS_DIR, { recursive: true });

  // 老库建表:与 CREATE TABLE IF NOT EXISTS 引入 runtime_json 和六契约列前的
  // collaboration_tasks 一致。
  const legacyDb = new DatabaseSync(CHAT_COLLABORATIONS_DB);
  legacyDb.exec(`CREATE TABLE collaboration_tasks (
    id TEXT PRIMARY KEY,
    collaboration_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL,
    project_id TEXT,
    state TEXT NOT NULL,
    depends_on_json TEXT NOT NULL,
    acceptance_json TEXT NOT NULL,
    writable_paths_json TEXT NOT NULL,
    retry_json TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    current_attempt INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  legacyDb.exec(`CREATE TABLE collaboration_plans (
    collaboration_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    plan_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(collaboration_id, version)
  )`);
  const legacyTs = new Date().toISOString();
  legacyDb.prepare(`INSERT INTO collaboration_plans
    (collaboration_id, version, plan_json, created_at)
    VALUES (?, 1, ?, ?)`)
    .run('legacy-collab', JSON.stringify({
      tasks: [{
        id: 'legacy-task',
        runtime: {
          schemaVersion: 1,
          tool: 'claude',
          provider: 'legacy-provider',
          model: 'legacy-model',
          effort: 'high',
        },
      }],
    }), legacyTs);
  legacyDb.prepare(`INSERT INTO collaboration_tasks
    (id, collaboration_id, objective, agent_id, role, state, depends_on_json,
     acceptance_json, writable_paths_json, retry_json, timeout_ms, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'planned', '[]', '[]', '[]', '{}', ?, ?, ?)`)
    .run('legacy-task', 'legacy-collab', 'legacy objective', 'agent-1', 'specialist', 1000, legacyTs, legacyTs);
  legacyDb.close();

  // 迁移前:确认六列缺失。
  const before = new DatabaseSync(CHAT_COLLABORATIONS_DB);
  const beforeCols = columnNames(before);
  before.close();
  for (const col of TASK_CONTRACT_COLUMNS) {
    assert.ok(!beforeCols.has(col), `legacy table should not yet have ${col}`);
  }

  // 执行迁移(openDatabase 幂等:CREATE IF NOT EXISTS + ALTER ADD COLUMN)。
  await store.initializeCollaborationStore();

  // 迁移后:runtime_json + 六契约列补齐。
  const migrated = store.openDatabase();
  const afterCols = columnNames(migrated);
  for (const col of TASK_CONTRACT_COLUMNS) {
    assert.ok(afterCols.has(col), `migration should add ${col}`);
  }

  // 默认值正确:只写老列(缺省 task_kind/read_only_required)→ 落库为
  // task_kind='execution'、read_only_required=0(ADD COLUMN 默认值生效)。
  const ts = new Date().toISOString();
  migrated.prepare(`INSERT INTO collaborations
    (id, root_session_id, state, title, plan_version, policy_json, created_at, updated_at)
    VALUES (?, ?, 'ready', ?, 1, '{}', ?, ?)`)
    .run('legacy-collab', 'legacy-root', 'legacy', ts, ts);
  migrated.close();

  const collab = await store.getCollaboration('legacy-collab');
  const task = collab.tasks.find((t) => t.id === 'legacy-task');
  assert.ok(task, 'legacy task row should be readable');
  assert.equal(task.taskKind, 'execution', 'legacy row defaults task_kind to execution');
  assert.equal(task.readOnlyRequired, false, 'legacy row defaults read_only_required to 0');
  assert.equal(task.accessMode, '', 'legacy row keeps access_mode NULL→empty');
  assert.deepEqual(task.runtime, {
    schemaVersion: 1,
    tool: 'claude',
    provider: 'legacy-provider',
    model: 'legacy-model',
    effort: 'high',
  }, 'legacy plan runtime is backfilled into the task projection');
}

try {
  await store.initializeCollaborationStore();
  await testFreshSchema();
  await testConsultationRoundTrip();
  await testDefaultExecutionRegression();
  testPlanReadonlyViolations();
  testConsultationForcesReadOnly();
  await testLegacyMigration();
  console.log('test-collaboration-task-contract: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
