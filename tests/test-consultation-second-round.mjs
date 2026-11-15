#!/usr/bin/env node
// P6-T2 聚焦测试:第二轮质询 roundNumber>1,追加 question。
// 验证 chat/consultation-store.mjs 的 createFollowUpConsultationRound
// (docs/consultation-v1-implementation-plan-2026-08-14.md §8 P6-T2 / §4):
//   - round 1(roundNumber=1)→ 决策 → follow-up(roundNumber=2)
//   - question/objective 为新值(追加质询);experts/quorum/budget/deadline 从 base 继承
//   - round 1 与新 round 可并存(同 root 下两个 round)
//   - 显式覆盖:提供 experts/quorum/budget/deadline 时不再继承
//   - 重复 follow-up(同 roundNumber)→ UNIQUE 约束 → CONSULTATION_ROUND_STATE_CONFLICT
//   - base round 不存在 → CONSULTATION_NOT_FOUND(404)
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 隔离临时 HOME + RAGENT_CONFIG_DIR —— 必须在 import 被测模块之前设置。
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consultation-second-round-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_WORK_ROOT_DIR;
delete process.env.RAGENT_MEMORY_DIR;
delete process.env.RAGENT_RUN_SPOOL_DIR;
delete process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT;

const store = await import('../chat/consultation-store.mjs');

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}
function futureIso(ms = 60 * 60 * 1000) {
  return new Date(Date.now() + ms).toISOString();
}

async function assertRejectsCode(promise, code, label = '') {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `${label} expected code ${code}, got ${err.code} — ${err.message}`);
    return true;
  });
}

async function makeRound1({ rootSessionId } = {}) {
  return store.createConsultationRound({
    rootSessionId: rootSessionId || nextId('root'),
    roundNumber: 1,
    objective: 'initial objective',
    question: 'initial question',
    experts: [{ role: 'security' }, { role: 'architecture' }],
    quorum: 2,
    budget: { tokens: 100000 },
    deadline: futureIso(),
  });
}

// ── round 1 → 决策 → follow-up(roundNumber=2):新 question,其余继承,两 round 并存 ──
async function testFollowUpRoundCreated() {
  const root = nextId('root');
  const base = await makeRound1({ rootSessionId: root });
  assert.equal(base.roundNumber, 1, 'base round is round 1');

  // round 1 产生决策(P6-T2 场景:round 1 → 决策 → follow-up)
  const decision = await store.createConsultationDecision({
    roundId: base.id,
    decision: 'proceed with initial round',
    decidedBySessionId: nextId('session'),
  });
  assert.ok(decision.id, 'round 1 decision created');

  const followUp = await store.createFollowUpConsultationRound({
    rootSessionId: root,
    baseRoundId: base.id,
    question: 'follow-up question: proceed further?',
    objective: 'follow-up objective',
  });

  assert.notEqual(followUp.id, base.id, 'follow-up is a distinct round');
  assert.equal(followUp.roundNumber, 2, 'follow-up roundNumber = base + 1');
  assert.equal(followUp.rootSessionId, root, 'follow-up shares root session');
  assert.equal(followUp.question, 'follow-up question: proceed further?', 'question is the new appended question');
  assert.equal(followUp.objective, 'follow-up objective', 'objective is the new value');

  // 继承:experts / quorum / budget / deadline
  assert.equal(followUp.quorum, 2, 'quorum inherited from base');
  assert.deepEqual(followUp.budget, { tokens: 100000 }, 'budget inherited from base');
  assert.equal(followUp.deadline, base.deadline, 'deadline inherited from base');
  assert.equal(followUp.experts.length, 2, 'experts count inherited from base');
  assert.deepEqual(
    followUp.experts.map((e) => e.role).sort(),
    ['architecture', 'security'],
    'expert roles inherited from base',
  );
  assert.ok(followUp.experts.every((e) => e.status === 'assigned'), 'follow-up experts start assigned');

  // round 1 与新 round 并存(同 root 下两个 round)
  const round1 = await store.getConsultationRound(base.id);
  const round2 = await store.getConsultationRound(followUp.id);
  assert.equal(round1.roundNumber, 1, 'round 1 still present');
  assert.equal(round2.roundNumber, 2, 'round 2 present');
  assert.equal(round1.state, 'PLANNED', 'round 1 decision does not migrate its state');
  assert.equal(round2.state, 'PLANNED', 'new round starts PLANNED');

  const listed = await store.listConsultationRounds({ rootSessionId: root });
  assert.equal(listed.length, 2, 'both rounds coexist under the same root session');
}

// ── 显式覆盖:提供 experts/quorum/budget/deadline 时不再继承 ───────────────────
async function testExplicitOverrides() {
  const root = nextId('root');
  const base = await makeRound1({ rootSessionId: root });
  const overrideDeadline = futureIso(30 * 60 * 1000);

  const followUp = await store.createFollowUpConsultationRound({
    rootSessionId: root,
    baseRoundId: base.id,
    question: 'override question',
    objective: 'override objective',
    experts: [{ role: 'architecture' }],
    quorum: 1,
    budget: { tokens: 5000 },
    deadline: overrideDeadline,
  });

  assert.equal(followUp.experts.length, 1, 'explicit experts override inheritance');
  assert.equal(followUp.experts[0].role, 'architecture', 'explicit expert role used');
  assert.equal(followUp.quorum, 1, 'explicit quorum overrides inheritance');
  assert.deepEqual(followUp.budget, { tokens: 5000 }, 'explicit budget overrides inheritance');
  assert.equal(followUp.deadline, overrideDeadline, 'explicit deadline overrides inheritance');
  assert.notEqual(followUp.deadline, base.deadline, 'explicit deadline differs from base deadline');
}

// ── 重复 follow-up(同 roundNumber)→ UNIQUE → CONFLICT ────────────────────────
async function testDuplicateFollowUpConflict() {
  const root = nextId('root');
  const base = await makeRound1({ rootSessionId: root });
  await store.createFollowUpConsultationRound({
    rootSessionId: root,
    baseRoundId: base.id,
    question: 'first follow-up',
    objective: 'first objective',
  });
  // 第二次 follow-up 仍从 base 推导 roundNumber=2 → UNIQUE(root_session_id, round_number) 冲突
  await assertRejectsCode(
    store.createFollowUpConsultationRound({
      rootSessionId: root,
      baseRoundId: base.id,
      question: 'duplicate follow-up',
      objective: 'duplicate objective',
    }),
    store.CONSULTATION_ROUND_STATE_CONFLICT,
    'duplicate follow-up round number (UNIQUE)',
  );
}

// ── base round 不存在 → CONSULTATION_NOT_FOUND(404) ──────────────────────────
async function testMissingBaseRound() {
  await assertRejectsCode(
    store.createFollowUpConsultationRound({
      rootSessionId: nextId('root'),
      baseRoundId: 'round_missing',
      question: 'q',
      objective: 'o',
    }),
    store.CONSULTATION_NOT_FOUND,
    'follow-up for missing base round',
  );
}

try {
  await store.initializeConsultationStore();
  await testFollowUpRoundCreated();
  await testExplicitOverrides();
  await testDuplicateFollowUpConflict();
  await testMissingBaseRound();
  console.log('test-consultation-second-round: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
