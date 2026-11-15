#!/usr/bin/env node
// P5-T1 聚焦测试: Consultation Compiler Gate。
// 验证 chat/consultation-compiler-gate.mjs 的 P5-T1 冻结语义
// (docs/consultation-v1-implementation-plan-2026-08-14.md §3 C2/C3/C6、§4、
// §8 P5-T1):
//   - 合法 consultation 专家任务(只读、空 writablePaths、accessMode 'read')
//     → 编译通过,返回 reservation + capability;capability 只读
//     (operations 仅 consultation.read、readOnly true、绑定
//     roundId/expertAssignmentId/controllerSessionId)
//   - 写路径:consultation 任务带非空 writablePaths 或 accessMode 'write'
//     → CONSULTATION_READONLY_VIOLATION(403)
//   - 模型不可降级:任务带 readOnlyRequired:false → 输出任务 readOnlyRequired
//     仍 true,不因模型输入降级
//   - 超预算:round budget tokens limit 0,reserve delta 超限
//     → CONSULTATION_BUDGET_EXCEEDED(409)
//   - 幂等:同 reservationId+idempotencyKey 重复 compile 不重复计费(reservation replay)
//   - 预算可见性:compile 后 getConsultationBudgetCounter(roundId) 的 reserved
//     反映预占
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 隔离临时 HOME + RAGENT_CONFIG_DIR —— 必须在 import 被测模块之前设置。
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consultation-compiler-gate-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_WORK_ROOT_DIR;
delete process.env.RAGENT_MEMORY_DIR;
delete process.env.RAGENT_RUN_SPOOL_DIR;
delete process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT;

const store = await import('../chat/consultation-store.mjs');
const governor = await import('../chat/organization-governor.mjs');
const gate = await import('../chat/consultation-compiler-gate.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
function rejectsCode(fn, code, statusCode, message) {
  assertions += 1;
  return assert.rejects(fn, (error) => error?.code === code && error?.statusCode === statusCode, message);
}

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}
function futureIso(ms = 60 * 60 * 1000) {
  return new Date(Date.now() + ms).toISOString();
}

async function makeRound({ budget = { tokens: 100000 }, experts = [{ role: 'security' }] } = {}) {
  return store.createConsultationRound({
    rootSessionId: nextId('root'),
    roundNumber: 1,
    objective: 'strategic consultation',
    question: 'proceed?',
    experts,
    quorum: 1,
    budget,
    deadline: futureIso(),
  });
}

// ── 合法 consultation 专家任务:编译通过 + capability 只读 ─────────────────────
async function testLegalCompile() {
  const round = await makeRound();
  const expertAssignmentId = nextId('expert');
  const controllerSessionId = nextId('controller');
  const reservationId = nextId('res');
  const result = await gate.compileConsultationExpertTask({
    task: {
      id: 'expert-task-1',
      objective: 'review the security posture',
      role: 'security',
      taskKind: 'consultation',
      readOnlyRequired: true,
      accessMode: 'read',
      writablePaths: [],
    },
    roundId: round.id,
    expertAssignmentId,
    controllerSessionId,
    reservationId,
    delta: { tokens: 500, cost: 0.02 },
  });

  // task: read-only 规范化
  equal(result.task.taskKind, 'consultation', 'task kind consultation');
  equal(result.task.readOnlyRequired, true, 'task readOnlyRequired true');
  equal(result.task.role, 'security', 'task role normalized');
  equal(result.task.objective, 'review the security posture', 'task objective');
  equal(result.task.accessMode, 'read', 'task accessMode read');
  deepEqual(result.task.writablePaths, [], 'task writablePaths empty');
  equal(result.task.id, 'expert-task-1', 'task id preserved');

  // reservation
  ok(result.reservation, 'reservation present');
  equal(result.reservation.reservation.state, 'reserved', 'reservation state reserved');
  equal(result.reservation.replay, false, 'first reservation is not a replay');
  equal(result.reservation.reservation.reservationId, reservationId, 'reservation id matches');

  // capability 只读
  const cap = result.capability;
  equal(cap.scope, 'consultation', 'capability scope consultation');
  equal(cap.readOnly, true, 'capability readOnly true');
  deepEqual([...cap.operations], ['consultation.read'], 'capability operations only consultation.read');
  equal(cap.bindings.roundId, round.id, 'capability bound roundId');
  equal(cap.bindings.expertAssignmentId, expertAssignmentId, 'capability bound expertAssignmentId');
  equal(cap.bindings.controllerSessionId, controllerSessionId, 'capability bound controllerSessionId');
  ok(cap.schema, 'capability has versioned schema');
  ok(cap.createdAt, 'capability has createdAt');
}

// ── 写路径被拒:非空 writablePaths 或 accessMode 'write' → 403 ────────────────
async function testWritePathRejected() {
  const round = await makeRound();
  const base = {
    task: { id: nextId('task'), objective: 'x', taskKind: 'consultation' },
    roundId: round.id,
    expertAssignmentId: nextId('expert'),
    controllerSessionId: nextId('controller'),
  };

  await rejectsCode(
    () => gate.compileConsultationExpertTask({ ...base, task: { ...base.task, writablePaths: ['/repo/src'] } }),
    gate.CONSULTATION_READONLY_VIOLATION, 403,
    'consultation task with writablePaths rejected',
  );
  await rejectsCode(
    () => gate.compileConsultationExpertTask({ ...base, task: { ...base.task, accessMode: 'write' } }),
    gate.CONSULTATION_READONLY_VIOLATION, 403,
    'consultation task with accessMode write rejected',
  );
  await rejectsCode(
    () => gate.compileConsultationExpertTask({ ...base, task: { ...base.task, writablePaths: ['/a'], accessMode: 'write' } }),
    gate.CONSULTATION_READONLY_VIOLATION, 403,
    'consultation task with both write signals rejected',
  );
}

// ── 模型不可降级只读 ─────────────────────────────────────────────────────────
async function testModelCannotDowngrade() {
  const round = await makeRound();
  const result = await gate.compileConsultationExpertTask({
    task: { id: nextId('task'), objective: 'x', taskKind: 'consultation', readOnlyRequired: false, accessMode: 'read' },
    roundId: round.id,
    expertAssignmentId: nextId('expert'),
    controllerSessionId: nextId('controller'),
  });
  equal(result.task.readOnlyRequired, true, 'readOnlyRequired forced true despite model false');
  equal(result.task.taskKind, 'consultation', 'taskKind forced consultation');
  equal(result.task.accessMode, 'read', 'accessMode stays read');
  deepEqual(result.task.writablePaths, [], 'writablePaths empty');
}

// ── 超预算:budget tokens limit 0,delta 超限 → CONSULTATION_BUDGET_EXCEEDED(409) ──
async function testOverBudget() {
  const round = await makeRound({ budget: { tokens: 0 } });
  await rejectsCode(
    () => gate.compileConsultationExpertTask({
      task: { id: nextId('task'), objective: 'x', taskKind: 'consultation' },
      roundId: round.id,
      expertAssignmentId: nextId('expert'),
      controllerSessionId: nextId('controller'),
      delta: { tokens: 1 },
    }),
    gate.CONSULTATION_BUDGET_EXCEEDED, 409,
    'over-limit consultation budget reservation rejected',
  );
}

// ── 幂等:同 reservationId + idempotencyKey 重复 compile 不重复计费 ────────────
async function testIdempotentReplay() {
  const round = await makeRound();
  const reservationId = nextId('res');
  const idempotencyKey = nextId('key');
  const args = {
    task: { id: nextId('task'), objective: 'x', taskKind: 'consultation' },
    roundId: round.id,
    expertAssignmentId: nextId('expert'),
    controllerSessionId: nextId('controller'),
    reservationId,
    idempotencyKey,
    delta: { tokens: 100 },
  };
  const first = await gate.compileConsultationExpertTask(args);
  const second = await gate.compileConsultationExpertTask(args);
  equal(first.reservation.replay, false, 'first compile is a fresh reservation');
  equal(second.reservation.replay, true, 'second compile is an idempotent replay');
  equal(second.reservation.reservation.reservationId, reservationId, 'replay keeps the same reservationId');
  equal(second.reservation.reservation.idempotencyKey, idempotencyKey, 'replay keeps the same idempotencyKey');

  const counter = await governor.getConsultationBudgetCounter(round.id);
  equal(counter.reserved.tokens, 100, 'replay does not double count reserved tokens');
  equal(counter.reserved.agents, 1, 'replay does not double count default agents');
  equal(counter.reserved.runs, 1, 'replay does not double count default runs');
}

// ── 预算可见性:compile 后 reserved 反映预占,totals 不被触碰 ──────────────────
async function testBudgetVisibility() {
  const round = await makeRound({ budget: { tokens: 100000 } });
  await gate.compileConsultationExpertTask({
    task: { id: nextId('task'), objective: 'x', taskKind: 'consultation' },
    roundId: round.id,
    expertAssignmentId: nextId('expert'),
    controllerSessionId: nextId('controller'),
    delta: { tokens: 500 },
  });
  const counter = await governor.getConsultationBudgetCounter(round.id);
  ok(counter, 'consultation budget counter exists after compile');
  equal(counter.scope, `consult:${round.id}`, 'counter addressed by consult:<roundId> scope');
  equal(counter.reserved.tokens, 500, 'reserved tokens reflect the pre-reservation');
  equal(counter.reserved.agents, 1, 'default agents reservation visible');
  equal(counter.reserved.runs, 1, 'default runs reservation visible');
  equal(counter.totals.tokens, 0, 'totals untouched by reservation');
  equal(counter.totals.agents, 0, 'totals agents untouched by reservation');
}

// ── 注入依赖:round 对象 / getRound 函数均可注入 ──────────────────────────────
async function testInjectedDependencies() {
  const round = await makeRound();
  const args = {
    task: { id: nextId('task'), objective: 'x', taskKind: 'consultation' },
    roundId: round.id,
    expertAssignmentId: nextId('expert'),
    controllerSessionId: nextId('controller'),
  };

  // 注入已加载 round:不再走 getConsultationRound。
  let getRoundCalled = false;
  const viaRound = await gate.compileConsultationExpertTask({
    ...args,
    round: round,
    getRound: async () => { getRoundCalled = true; return round; },
  });
  equal(viaRound.reservation.reservation.state, 'reserved', 'injected round compiles');
  equal(getRoundCalled, false, 'injected round skips getRound');

  // 注入 getRound:round 未提供时使用依赖。
  const viaGetRound = await gate.compileConsultationExpertTask({
    ...args,
    round: undefined,
    getRound: async (id) => {
      assert.equal(id, round.id, 'getRound receives the roundId');
      return round;
    },
  });
  equal(viaGetRound.reservation.reservation.state, 'reserved', 'injected getRound compiles');

  // round 缺失 + getRound 返回 null → 解析失败。
  await rejectsCode(
    () => gate.compileConsultationExpertTask({
      ...args,
      round: undefined,
      getRound: async () => null,
    }),
    gate.CONSULTATION_EXPERT_ASSIGNMENT_INVALID, 400,
    'unresolvable round rejected',
  );
}

// ── buildConsultationReadOnlyCapability 直接调用 ─────────────────────────────
async function testBuildCapabilityDirect() {
  const cap = gate.buildConsultationReadOnlyCapability({
    roundId: 'round-a',
    expertAssignmentId: 'expert-a',
    controllerSessionId: 'controller-a',
    role: 'security',
  });
  equal(cap.schema, gate.CONSULTATION_CAPABILITY_VERSION, 'versioned schema constant');
  equal(cap.scope, 'consultation', 'scope consultation');
  equal(cap.readOnly, true, 'readOnly true');
  deepEqual([...cap.operations], ['consultation.read'], 'operations only read');
  equal(cap.bindings.roundId, 'round-a', 'bound roundId');
  equal(cap.bindings.expertAssignmentId, 'expert-a', 'bound expertAssignmentId');
  equal(cap.bindings.controllerSessionId, 'controller-a', 'bound controllerSessionId');
  ok(cap.createdAt, 'has createdAt');

  const withTtl = gate.buildConsultationReadOnlyCapability({
    roundId: 'r', expertAssignmentId: 'e', controllerSessionId: 'c', ttlMs: 60_000,
  });
  ok(withTtl.expiresAt, 'ttl adds expiresAt');
  ok(new Date(withTtl.expiresAt).getTime() >= new Date(withTtl.createdAt).getTime(), 'expiresAt after createdAt');
}

// ── 错误码引用来自既有模块(不重复定义) ──────────────────────────────────────
async function testErrorCodeReferences() {
  equal(gate.CONSULTATION_READONLY_VIOLATION, 'CONSULTATION_READONLY_VIOLATION', 'readonly code re-exported');
  equal(gate.CONSULTATION_BUDGET_EXCEEDED, 'CONSULTATION_BUDGET_EXCEEDED', 'budget code re-exported');

  // 缺失必填 → CONSULTATION_EXPERT_ASSIGNMENT_INVALID(400)
  await rejectsCode(
    () => gate.compileConsultationExpertTask({ task: {}, expertAssignmentId: 'e', controllerSessionId: 'c' }),
    gate.CONSULTATION_EXPERT_ASSIGNMENT_INVALID, 400,
    'missing roundId rejected',
  );
  await rejectsCode(
    () => gate.compileConsultationExpertTask({
      roundId: nextId('round'),
      task: { id: nextId('task'), objective: 'x', taskKind: 'consultation' },
      expertAssignmentId: 'e',
      controllerSessionId: 'c',
    }),
    store.CONSULTATION_NOT_FOUND, 404,
    'unknown round via default getRound rejects 404',
  );
}

try {
  await store.initializeConsultationStore();
  await testLegalCompile();
  await testWritePathRejected();
  await testModelCannotDowngrade();
  await testOverBudget();
  await testIdempotentReplay();
  await testBudgetVisibility();
  await testInjectedDependencies();
  await testBuildCapabilityDirect();
  await testErrorCodeReferences();
  console.log(`test-consultation-compiler-gate: ok (${assertions} assertions)`);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
