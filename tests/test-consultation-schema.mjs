#!/usr/bin/env node
// P1-T4 聚焦测试:consultation 持久化基座。
// 验证 chat/consultation-store.mjs 将 §5 四张表归并到共享 collaboration 库
// (CHAT_COLLABORATIONS_DB),并核对列齐全、唯一约束、外键 CASCADE、冻结状态
// 词汇、错误码常量与 schema 幂等性。
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 隔离临时 HOME + RAGENT_CONFIG_DIR —— 必须在 import 被测模块之前设置。
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consultation-schema-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_WORK_ROOT_DIR;
delete process.env.RAGENT_MEMORY_DIR;
delete process.env.RAGENT_RUN_SPOOL_DIR;
delete process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT;

const store = await import('../chat/consultation-store.mjs');

// ── §5 期望列 ────────────────────────────────────────────────────────────────
const ROUND_COLUMNS = [
  'id', 'root_session_id', 'round_number', 'state', 'objective', 'question',
  'quorum', 'budget_json', 'deadline', 'decided_decision_record_id',
  'schema_version', 'version', 'created_at', 'updated_at',
];
const DECISION_COLUMNS = [
  'id', 'round_id', 'decision', 'rationale', 'required_guards_json',
  'decided_by_session_id', 'decided_by_node_id', 'base_revision',
  'context_digest', 'schema_version', 'created_at',
];
const EXPERT_COLUMNS = [
  'id', 'round_id', 'expert_session_id', 'role', 'writable_paths_json',
  'status', 'created_at',
];
const PACKET_LINK_COLUMNS = ['round_id', 'attempt_id', 'packet_id', 'created_at'];

const ROUND_STATES = [
  'PLANNED', 'DISPATCHED', 'AGGREGATING', 'DECIDED',
  'INCONCLUSIVE', 'FAILED', 'EXPIRED', 'CANCELLED',
];

const ERROR_CODES = {
  CONSULTATION_NOT_FOUND: 'CONSULTATION_NOT_FOUND',
  CONSULTATION_ROUND_STATE_INVALID: 'CONSULTATION_ROUND_STATE_INVALID',
  CONSULTATION_ROUND_STATE_CONFLICT: 'CONSULTATION_ROUND_STATE_CONFLICT',
  CONSULTATION_QUORUM_NOT_MET: 'CONSULTATION_QUORUM_NOT_MET',
  CONSULTATION_DEADLINE_EXPIRED: 'CONSULTATION_DEADLINE_EXPIRED',
  CONSULTATION_EXPERT_ASSIGNMENT_INVALID: 'CONSULTATION_EXPERT_ASSIGNMENT_INVALID',
  CONSULTATION_GUARD_INVALID: 'CONSULTATION_GUARD_INVALID',
  CONSULTATION_DECISION_INVALID: 'CONSULTATION_DECISION_INVALID',
};

const CONSULTATION_TABLES = [
  'consultation_rounds',
  'consultation_decision_records',
  'consultation_expert_assignments',
  'consultation_packet_links',
];

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'consultation_%' ORDER BY name").all().map((row) => row.name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function assertColumns(db, table, expected) {
  const actual = columnNames(db, table);
  for (const column of expected) {
    assert.ok(actual.has(column), `${table} 缺列 ${column}`);
  }
  assert.ok(actual.size >= expected.length, `${table} 列数异常: ${[...actual].join(', ')}`);
}

const insertRound = (db, id, root, roundNumber, ts) => db.prepare(`
  INSERT INTO consultation_rounds
    (id, root_session_id, round_number, state, objective, question, quorum,
     budget_json, deadline, created_at, updated_at)
  VALUES (?, ?, ?, 'PLANNED', 'objective', 'question', 2, '{}', ?, ?, ?)`)
  .run(id, root, roundNumber, ts, ts, ts);

async function testFourTablesExist() {
  const db = store.openDatabase();
  try {
    const tables = tableNames(db);
    for (const table of CONSULTATION_TABLES) {
      assert.ok(tables.includes(table), `表 ${table} 不存在`);
    }
  } finally {
    db.close();
  }
}

async function testColumnCompleteness() {
  const db = store.openDatabase();
  try {
    assertColumns(db, 'consultation_rounds', ROUND_COLUMNS);
    assertColumns(db, 'consultation_decision_records', DECISION_COLUMNS);
    assertColumns(db, 'consultation_expert_assignments', EXPERT_COLUMNS);
    assertColumns(db, 'consultation_packet_links', PACKET_LINK_COLUMNS);
  } finally {
    db.close();
  }
}

async function testRoundUniqueConstraint() {
  const db = store.openDatabase();
  try {
    const ts = new Date().toISOString();
    insertRound(db, 'round-u1', 'root-u', 1, ts);
    assert.throws(
      () => insertRound(db, 'round-u2', 'root-u', 1, ts),
      /UNIQUE/,
      '同 root_session_id + round_number 二次插入应抛 UNIQUE 约束错误',
    );
    // 同 root、不同 round_number 允许(第二轮质询)。
    insertRound(db, 'round-u3', 'root-u', 2, ts);
  } finally {
    db.close();
  }
}

async function testOnDeleteCascade() {
  const db = store.openDatabase();
  try {
    const ts = new Date().toISOString();
    insertRound(db, 'round-c', 'root-c', 1, ts);

    db.prepare(`INSERT INTO consultation_decision_records
      (id, round_id, decision, rationale, required_guards_json, decided_by_session_id, schema_version, created_at)
      VALUES ('dec-c', 'round-c', 'DECISION', 'rationale', '[]', 'session-c', 1, ?)`).run(ts);
    db.prepare(`INSERT INTO consultation_expert_assignments
      (id, round_id, expert_session_id, role, writable_paths_json, status, created_at)
      VALUES ('expert-c', 'round-c', 'session-expert', 'reviewer', '[]', 'assigned', ?)`).run(ts);
    db.prepare(`INSERT INTO consultation_packet_links
      (round_id, attempt_id, packet_id, created_at)
      VALUES ('round-c', 'attempt-c', 'packet-c', ?)`).run(ts);

    const count = (table, roundId) => db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE round_id = ?`,
    ).get(roundId).n;

    assert.equal(count('consultation_decision_records', 'round-c'), 1, '前置决策记录应存在');
    assert.equal(count('consultation_expert_assignments', 'round-c'), 1, '前置专家分配应存在');
    assert.equal(count('consultation_packet_links', 'round-c'), 1, '前置 packet 关联应存在');

    db.prepare('DELETE FROM consultation_rounds WHERE id = ?').run('round-c');
    assert.equal(count('consultation_decision_records', 'round-c'), 0, '决策记录应随 round 级联删除');
    assert.equal(count('consultation_expert_assignments', 'round-c'), 0, '专家分配应随 round 级联删除');
    assert.equal(count('consultation_packet_links', 'round-c'), 0, 'packet 关联应随 round 级联删除');
  } finally {
    db.close();
  }
}

async function testRoundStatesFrozen() {
  const states = store.CONSULTATION_ROUND_STATES;
  assert.ok(Array.isArray(states), 'CONSULTATION_ROUND_STATES 应为数组');
  assert.ok(Object.isFrozen(states), 'CONSULTATION_ROUND_STATES 必须冻结');
  assert.deepEqual([...states], ROUND_STATES, '8 态词汇必须与冻结集一致');
}

async function testErrorCodes() {
  for (const [key, value] of Object.entries(ERROR_CODES)) {
    assert.equal(store[key], value, `错误码 ${key} 应为 ${value}`);
  }
}

async function testWithDatabaseEnsuresSchema() {
  await store.withDatabase((db) => {
    const tables = tableNames(db);
    for (const table of CONSULTATION_TABLES) {
      assert.ok(tables.includes(table), `withDatabase 未确保 ${table} 存在`);
    }
  });
}

async function testIdempotentSchema() {
  const db = store.openDatabase();
  try {
    store.ensureConsultationSchema(db); // 第二次应用应不抛错
    assert.deepEqual(tableNames(db), [...CONSULTATION_TABLES].sort(), '重复 ensure 后表集合不变');
  } finally {
    db.close();
  }
}

try {
  await store.initializeConsultationStore();
  await testFourTablesExist();
  await testColumnCompleteness();
  await testRoundUniqueConstraint();
  await testOnDeleteCascade();
  await testRoundStatesFrozen();
  await testErrorCodes();
  await testWithDatabaseEnsuresSchema();
  await testIdempotentSchema();
  console.log('test-consultation-schema: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
