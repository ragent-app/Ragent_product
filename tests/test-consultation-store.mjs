#!/usr/bin/env node
// P2-T1 聚焦测试:ConsultationRound CRUD + C5 状态机。
// 验证 chat/consultation-store.mjs 的冻结语义:
//   - 创建 round 字段/quorum/experts/deadline 校验,非法专家分配 → CONSULTATION_EXPERT_ASSIGNMENT_INVALID
//   - 完整生命周期 PLANNED→DISPATCHED→AGGREGATING→DECIDED(quorum 满足、digest 一致);
//     packetIds 从 consultation_packet_links append-only 推导(不落可变数组)
//   - quorum 不足 / digest 不一致 → CONSULTATION_QUORUM_NOT_MET;聚合到 INCONCLUSIVE
//   - 非法迁移 → CONSULTATION_ROUND_STATE_INVALID;CAS 过期 version → CONSULTATION_ROUND_STATE_CONFLICT
//   - partial-failure:非白名单 → FAILED(不可 recover);白名单 → recover 回 DISPATCHED
//   - deadline:now>deadline 且 DISPATCHED/AGGREGATING → EXPIRED;未到期不 EXPIRED
//   - cancel:PLANNED/DISPATCHED/AGGREGATING → CANCELLED
//   - 崩溃恢复语义:新连接读取同一 DB,round 状态与 packet_links 一致
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 隔离临时 HOME + RAGENT_CONFIG_DIR —— 必须在 import 被测模块之前设置。
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consultation-store-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_WORK_ROOT_DIR;
delete process.env.RAGENT_MEMORY_DIR;
delete process.env.RAGENT_RUN_SPOOL_DIR;
delete process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT;

const store = await import('../chat/consultation-store.mjs');
const resultPackets = await import('../chat/result-packets.mjs');

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}
function futureIso(ms = 60 * 60 * 1000) {
  return new Date(Date.now() + ms).toISOString();
}
function pastIso(ms = 60 * 60 * 1000) {
  return new Date(Date.now() - ms).toISOString();
}

async function assertRejectsCode(promise, code, label = '') {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `${label} expected code ${code}, got ${err.code} — ${err.message}`);
    return true;
  });
}

// 用 result-packets 的 createExecutionPacket + 注入 deps 生成真实 consultation packet
// (携带后端绑定 digest)。相同 recommendation → 相同 vote digest;不同 → 不同 vote digest。
const AGREE_RECOMMENDATION = {
  verdict: 'APPROVE',
  rationale: 'strategic alignment confirmed',
  conditions: ['monitor rollout'],
};
const DISAGREE_RECOMMENDATION = {
  verdict: 'REJECT',
  rationale: 'risk threshold exceeded',
  conditions: ['re-scope first'],
};

async function createConsultationPacket({ runId, taskId, attemptId, recommendation }) {
  const deps = {
    getRun: async () => ({ id: runId, state: 'completed', sessionId: `sess-${runId}` }),
    getRunManifest: async () => ({ projectId: 'proj-consult', taskId, attemptId }),
    getRunResult: async () => ({ summary: 'expert packet summary' }),
    listArtifacts: async () => [],
  };
  const packet = await resultPackets.createExecutionPacket({
    runId,
    projectId: 'proj-consult',
    sessionId: `sess-${runId}`,
    taskId,
    attemptId,
    taskKind: 'consultation',
    consultation: { recommendation },
    deps,
  });
  assert.ok(packet && packet.packetId && packet.digest, 'created consultation packet must carry packetId + digest');
  return packet;
}

async function makeRound({ experts, quorum, deadline, rootSessionId, roundNumber = 1 } = {}) {
  const round = await store.createConsultationRound({
    rootSessionId: rootSessionId || nextId('root'),
    roundNumber,
    objective: 'strategic consultation',
    question: 'Should we proceed with the rollout?',
    experts: experts ?? [{ role: 'security' }, { role: 'architecture' }],
    quorum: quorum ?? 2,
    budget: { tokens: 100000 },
    deadline: deadline ?? futureIso(),
  });
  return round;
}

// 两个专家各产出一个 packet,并把 packet 关联到 round。
async function dispatchAndLinkTwo(round, { sameVote = true } = {}) {
  const attempt1 = nextId('attempt');
  const attempt2 = nextId('attempt');
  await store.dispatchConsultationRound(round.id, {
    expertAssignmentId: round.experts[0].id,
    expertSessionId: nextId('sess'),
    attemptId: attempt1,
  });
  await store.dispatchConsultationRound(round.id, {
    expertAssignmentId: round.experts[1].id,
    expertSessionId: nextId('sess'),
    attemptId: attempt2,
  });
  const rec1 = AGREE_RECOMMENDATION;
  const rec2 = sameVote ? AGREE_RECOMMENDATION : DISAGREE_RECOMMENDATION;
  const packet1 = await createConsultationPacket({
    runId: nextId('run'), taskId: nextId('task'), attemptId: attempt1, recommendation: rec1,
  });
  const packet2 = await createConsultationPacket({
    runId: nextId('run'), taskId: nextId('task'), attemptId: attempt2, recommendation: rec2,
  });
  await store.linkPacketToRound(round.id, attempt1, packet1.packetId);
  await store.linkPacketToRound(round.id, attempt2, packet2.packetId);
  return { attempt1, attempt2, packet1, packet2 };
}

// ── 创建:字段、校验、非法专家分配 ───────────────────────────────────────────
async function testCreateRoundAndValidation() {
  const round = await makeRound();
  assert.ok(round.id.startsWith('round_'), 'round id should be prefixed round_');
  assert.equal(round.state, 'PLANNED', 'new round starts PLANNED');
  assert.equal(round.version, 1, 'new round starts at version 1');
  assert.equal(round.quorum, 2);
  assert.deepEqual(round.budget, { tokens: 100000 }, 'budget persisted as budget_json');
  assert.equal(round.experts.length, 2, 'two expert assignments created');
  for (const expert of round.experts) {
    assert.equal(expert.status, 'assigned', 'expert starts assigned');
    assert.deepEqual(expert.writablePaths, [], 'consultation experts are read-only (empty writablePaths)');
  }
  assert.deepEqual(round.packetIds, [], 'fresh round derives no packet ids');

  // quorum < 1 → 拒绝
  await assertRejectsCode(
    store.createConsultationRound({
      rootSessionId: nextId('root'), roundNumber: 1, objective: 'o', question: 'q',
      experts: [{ role: 'security' }], quorum: 0, budget: {}, deadline: futureIso(),
    }),
    store.CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
    'quorum=0',
  );
  // experts 空 → 拒绝
  await assertRejectsCode(
    store.createConsultationRound({
      rootSessionId: nextId('root'), roundNumber: 1, objective: 'o', question: 'q',
      experts: [], quorum: 1, budget: {}, deadline: futureIso(),
    }),
    store.CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
    'empty experts',
  );
  // 专家缺 role → 拒绝
  await assertRejectsCode(
    store.createConsultationRound({
      rootSessionId: nextId('root'), roundNumber: 1, objective: 'o', question: 'q',
      experts: [{ role: '' }], quorum: 1, budget: {}, deadline: futureIso(),
    }),
    store.CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
    'expert missing role',
  );
  // 专家携带非空 writablePaths → CONSULTATION_EXPERT_ASSIGNMENT_INVALID(咨询专家只读)
  await assertRejectsCode(
    store.createConsultationRound({
      rootSessionId: nextId('root'), roundNumber: 1, objective: 'o', question: 'q',
      experts: [{ role: 'security', writablePaths: ['/repo/src'] }], quorum: 1, budget: {}, deadline: futureIso(),
    }),
    store.CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
    'expert writablePaths must be empty',
  );
  // 非法 deadline → 拒绝
  await assertRejectsCode(
    store.createConsultationRound({
      rootSessionId: nextId('root'), roundNumber: 1, objective: 'o', question: 'q',
      experts: [{ role: 'security' }], quorum: 1, budget: {}, deadline: 'not-a-date',
    }),
    store.CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
    'invalid deadline',
  );
  // 同一 root + roundNumber 重复 → 冲突
  const dupRoot = nextId('root');
  await makeRound({ rootSessionId: dupRoot });
  await assertRejectsCode(
    store.createConsultationRound({
      rootSessionId: dupRoot, roundNumber: 1, objective: 'o', question: 'q',
      experts: [{ role: 'security' }], quorum: 1, budget: {}, deadline: futureIso(),
    }),
    store.CONSULTATION_ROUND_STATE_CONFLICT,
    'duplicate (root_session_id, round_number)',
  );
  // 同 root、不同 roundNumber(第二轮质询)允许
  const second = await store.createConsultationRound({
    rootSessionId: dupRoot, roundNumber: 2, objective: 'o', question: 'follow-up',
    experts: [{ role: 'security' }], quorum: 1, budget: {}, deadline: futureIso(),
  });
  assert.equal(second.roundNumber, 2);
}

// ── 完整生命周期 → DECIDED(packetIds 从 packet_links 推导) ──────────────────
async function testFullLifecycleDecided() {
  const round = await makeRound();
  const { packet1, packet2 } = await dispatchAndLinkTwo(round, { sameVote: true });

  const dispatched = await store.getConsultationRound(round.id);
  assert.equal(dispatched.state, 'DISPATCHED', 'after dispatch round is DISPATCHED');
  assert.ok(dispatched.experts.every((ex) => ex.status === 'dispatched'), 'experts marked dispatched');
  assert.ok(dispatched.experts.every((ex) => ex.attemptId !== ''), 'attemptId bound on dispatch');

  // linkPacketToRound 幂等:相同 (round, attempt, packet) 三元组第二次为 no-op
  const linked = await store.linkPacketToRound(round.id, dispatched.experts[0].attemptId, packet1.packetId);
  assert.equal(linked, false, 'duplicate (round, attempt, packet) link is idempotent');

  const aggregating = await store.beginAggregation(round.id);
  assert.equal(aggregating.state, 'AGGREGATING', 'DISPATCHED → AGGREGATING');

  const decided = await store.decideConsultationRound(round.id, { decisionRecordId: nextId('dec') });
  assert.equal(decided.state, 'DECIDED', 'AGGREGATING → DECIDED');
  assert.ok(decided.decidedDecisionRecordId.startsWith('dec-'), 'decided_decision_record_id persisted');
  assert.equal(decided.version, 4, 'version bumped once per transition (1 → 4)');
  assert.deepEqual(
    [...decided.packetIds].sort(),
    [packet1.packetId, packet2.packetId].sort(),
    'packetIds derived from consultation_packet_links, not a stored array',
  );

  // 崩溃恢复语义:新连接读取同一 DB,round 状态与 packet_links 一致。
  const fresh = store.openDatabase();
  try {
    const row = fresh.prepare('SELECT state, version FROM consultation_rounds WHERE id = ?').get(round.id);
    assert.equal(row.state, 'DECIDED', 'fresh connection sees persisted DECIDED state');
    assert.equal(row.version, 4, 'fresh connection sees persisted version');
    const links = fresh.prepare('SELECT packet_id FROM consultation_packet_links WHERE round_id = ?').all(round.id);
    assert.equal(links.length, 2, 'fresh connection sees both packet links');
  } finally {
    fresh.close();
  }
}

// ── quorum 不足 / digest 不一致 → QUORUM_NOT_MET;聚合到 INCONCLUSIVE ────────
async function testQuorumAndDigest() {
  // quorum 不足:两个专家已派发,仅一个产出 packet
  const roundQuorum = await makeRound();
  const attempt1 = nextId('attempt');
  const attempt2 = nextId('attempt');
  await store.dispatchConsultationRound(roundQuorum.id, {
    expertAssignmentId: roundQuorum.experts[0].id,
    expertSessionId: nextId('sess'), attemptId: attempt1,
  });
  await store.dispatchConsultationRound(roundQuorum.id, {
    expertAssignmentId: roundQuorum.experts[1].id,
    expertSessionId: nextId('sess'), attemptId: attempt2,
  });
  const onlyPacket = await createConsultationPacket({
    runId: nextId('run'), taskId: nextId('task'), attemptId: attempt1, recommendation: AGREE_RECOMMENDATION,
  });
  await store.linkPacketToRound(roundQuorum.id, attempt1, onlyPacket.packetId);

  // beginAggregation 带 verifyAllExpertsDone 应拒绝(仅一个专家产出)
  await assertRejectsCode(
    store.beginAggregation(roundQuorum.id, { verifyAllExpertsDone: true }),
    store.CONSULTATION_QUORUM_NOT_MET,
    'beginAggregation verifyAllExpertsDone',
  );
  // 不带校验则进入 AGGREGATING;decide 因 < quorum 抛 QUORUM_NOT_MET
  await store.beginAggregation(roundQuorum.id);
  await assertRejectsCode(
    store.decideConsultationRound(roundQuorum.id, { decisionRecordId: nextId('dec') }),
    store.CONSULTATION_QUORUM_NOT_MET,
    'quorum not met',
  );
  // 聚合到 INCONCLUSIVE 的场景
  const inconclusive = await store.transitionRoundState(roundQuorum.id, 'INCONCLUSIVE');
  assert.equal(inconclusive.state, 'INCONCLUSIVE', 'AGGREGATING → INCONCLUSIVE after failed quorum');

  // digest 不一致:两个专家各产出 packet,但 recommendation 不同
  const roundDisagree = await makeRound();
  await dispatchAndLinkTwo(roundDisagree, { sameVote: false });
  await store.beginAggregation(roundDisagree.id);
  await assertRejectsCode(
    store.decideConsultationRound(roundDisagree.id, { decisionRecordId: nextId('dec') }),
    store.CONSULTATION_QUORUM_NOT_MET,
    'digest disagreement',
  );
  assert.equal((await store.getConsultationRound(roundDisagree.id)).state, 'AGGREGATING', 'decide failure leaves round AGGREGATING');
}

// ── 非法迁移 → ROUND_STATE_INVALID ───────────────────────────────────────────
async function testIllegalTransitions() {
  // 到达 DECIDED 后 dispatch / cancel / 任意迁移都应拒绝
  const round = await makeRound();
  await dispatchAndLinkTwo(round, { sameVote: true });
  await store.beginAggregation(round.id);
  await store.decideConsultationRound(round.id, { decisionRecordId: nextId('dec') });

  await assertRejectsCode(
    store.dispatchConsultationRound(round.id, {
      expertAssignmentId: round.experts[0].id,
      expertSessionId: nextId('sess'), attemptId: nextId('attempt'),
    }),
    store.CONSULTATION_ROUND_STATE_INVALID,
    'dispatch after DECIDED',
  );
  await assertRejectsCode(
    store.cancelConsultationRound(round.id),
    store.CONSULTATION_ROUND_STATE_INVALID,
    'cancel after DECIDED',
  );
  await assertRejectsCode(
    store.transitionRoundState(round.id, 'FAILED'),
    store.CONSULTATION_ROUND_STATE_INVALID,
    'DECIDED has no outgoing transitions',
  );

  // PLANNED 不能直接 AGGREGATING
  const planned = await makeRound();
  await assertRejectsCode(
    store.beginAggregation(planned.id),
    store.CONSULTATION_ROUND_STATE_INVALID,
    'beginAggregation from PLANNED',
  );
}

// ── CAS:携带过期 version → ROUND_STATE_CONFLICT ──────────────────────────────
async function testCasConflict() {
  const round = await makeRound();
  assert.equal(round.version, 1);
  // 携带过期 version(=2)执行首个 dispatch → CAS 冲突
  await assertRejectsCode(
    store.dispatchConsultationRound(round.id, {
      expertAssignmentId: round.experts[0].id,
      expertSessionId: nextId('sess'), attemptId: nextId('attempt'), version: 2,
    }),
    store.CONSULTATION_ROUND_STATE_CONFLICT,
    'dispatch with stale version',
  );
  // transitionRoundState 携带过期 version → CAS 冲突
  await assertRejectsCode(
    store.transitionRoundState(round.id, 'CANCELLED', { version: 99 }),
    store.CONSULTATION_ROUND_STATE_CONFLICT,
    'transitionRoundState with stale version',
  );
  // 正确 version 的 cancel 应成功(证明 version 语义正确)
  const cancelled = await store.cancelConsultationRound(round.id, { version: round.version });
  assert.equal(cancelled.state, 'CANCELLED');
}

// ── partial-failure:非白名单 → FAILED 不可 recover;白名单 → recover 回 DISPATCHED ──
async function testPartialFailureAndRecover() {
  // 非白名单 failureKind → FAILED;recover 被拒
  const hard = await makeRound();
  await store.dispatchConsultationRound(hard.id, {
    expertAssignmentId: hard.experts[0].id,
    expertSessionId: nextId('sess'), attemptId: nextId('attempt'),
  });
  const failed = await store.failConsultationRound(hard.id, {
    failureKind: 'deterministic_failure',
    reason: 'expert refused to run',
  });
  assert.equal(failed.state, 'FAILED', 'DISPATCHED → FAILED');
  assert.equal(failed.failureKind, 'deterministic_failure', 'failureKind persisted');
  await assertRejectsCode(
    store.recoverConsultationRound(hard.id),
    store.CONSULTATION_ROUND_STATE_INVALID,
    'recover non-retryable failure',
  );

  // 白名单 failureKind → recover 回 DISPATCHED,专家重置为 assigned
  const soft = await makeRound();
  await store.dispatchConsultationRound(soft.id, {
    expertAssignmentId: soft.experts[0].id,
    expertSessionId: nextId('sess'), attemptId: nextId('attempt'),
  });
  await store.failConsultationRound(soft.id, {
    failureKind: 'attempt_lease_expired',
    reason: 'expert attempt lease expired',
  });
  const recovered = await store.recoverConsultationRound(soft.id);
  assert.equal(recovered.state, 'DISPATCHED', 'FAILED → DISPATCHED for retryable failure');
  assert.equal(recovered.failureKind, '', 'failureKind cleared after recover');
  assert.ok(recovered.experts.every((ex) => ex.status === 'assigned'), 'experts reset to assigned for re-dispatch');
  assert.ok(recovered.experts.every((ex) => ex.attemptId === ''), 'attempt bindings cleared for re-dispatch');

  // recover 后仍可继续派发 + 聚合
  await store.dispatchConsultationRound(soft.id, {
    expertAssignmentId: soft.experts[0].id,
    expertSessionId: nextId('sess'), attemptId: nextId('attempt'),
  });
  assert.equal((await store.getConsultationRound(soft.id)).state, 'DISPATCHED', 're-dispatch after recover succeeds');
}

// ── deadline:超期 DISPATCHED/AGGREGATING → EXPIRED;未到期不 EXPIRED ─────────
async function testDeadlineExpiry() {
  // 超期 + DISPATCHED → EXPIRED
  const overdueDispatched = await makeRound({ deadline: pastIso() });
  await store.dispatchConsultationRound(overdueDispatched.id, {
    expertAssignmentId: overdueDispatched.experts[0].id,
    expertSessionId: nextId('sess'), attemptId: nextId('attempt'),
  });
  const expired1 = await store.expireConsultationRoundIfPastDeadline(overdueDispatched.id);
  assert.equal(expired1, true, 'past-deadline DISPATCHED round expires');
  assert.equal((await store.getConsultationRound(overdueDispatched.id)).state, 'EXPIRED');

  // 未到期 → 不 EXPIRED
  const notDue = await makeRound({ deadline: futureIso(5 * 60 * 1000) });
  await store.dispatchConsultationRound(notDue.id, {
    expertAssignmentId: notDue.experts[0].id,
    expertSessionId: nextId('sess'), attemptId: nextId('attempt'),
  });
  const notExpired = await store.expireConsultationRoundIfPastDeadline(notDue.id);
  assert.equal(notExpired, false, 'future-deadline round is not expired');
  assert.equal((await store.getConsultationRound(notDue.id)).state, 'DISPATCHED');

  // 超期 + AGGREGATING → EXPIRED
  const overdueAggregating = await makeRound({ deadline: pastIso() });
  const { packet1 } = await dispatchAndLinkTwo(overdueAggregating, { sameVote: true });
  assert.ok(packet1, 'linked packet for aggregating expiry test');
  await store.beginAggregation(overdueAggregating.id);
  assert.equal((await store.getConsultationRound(overdueAggregating.id)).state, 'AGGREGATING');
  await store.expireConsultationRoundIfPastDeadline(overdueAggregating.id);
  assert.equal((await store.getConsultationRound(overdueAggregating.id)).state, 'EXPIRED', 'AGGREGATING past deadline → EXPIRED');

  // PLANNED 即使超期也不 EXPIRED(deadline 规则只作用于 DISPATCHED/AGGREGATING)
  const plannedOverdue = await makeRound({ deadline: pastIso() });
  assert.equal(await store.expireConsultationRoundIfPastDeadline(plannedOverdue.id), false, 'PLANNED is not deadline-eligible');

  // batch expiry(P6 reconciler 挂载点)
  const batch = await makeRound({ deadline: pastIso() });
  await store.dispatchConsultationRound(batch.id, {
    expertAssignmentId: batch.experts[0].id,
    expertSessionId: nextId('sess'), attemptId: nextId('attempt'),
  });
  const ids = await store.consultationRoundsPastDeadline();
  assert.ok(ids.includes(batch.id), 'consultationRoundsPastDeadline lists overdue round');
  const expiredIds = await store.expireConsultationRoundsPastDeadline();
  assert.ok(expiredIds.includes(batch.id), 'expireConsultationRoundsPastDeadline expires overdue round');
}

// ── cancel:PLANNED/DISPATCHED/AGGREGATING → CANCELLED ───────────────────────
async function testCancel() {
  const planned = await makeRound();
  assert.equal((await store.cancelConsultationRound(planned.id)).state, 'CANCELLED');

  const dispatched = await makeRound();
  await store.dispatchConsultationRound(dispatched.id, {
    expertAssignmentId: dispatched.experts[0].id,
    expertSessionId: nextId('sess'), attemptId: nextId('attempt'),
  });
  assert.equal((await store.cancelConsultationRound(dispatched.id)).state, 'CANCELLED');

  const aggregating = await makeRound();
  await dispatchAndLinkTwo(aggregating, { sameVote: true });
  await store.beginAggregation(aggregating.id);
  assert.equal((await store.cancelConsultationRound(aggregating.id)).state, 'CANCELLED');
}

// ── 其他 CRUD:list 与 get 不存在 ─────────────────────────────────────────────
async function testListAndNotFound() {
  const rootA = nextId('root');
  const rootB = nextId('root');
  await makeRound({ rootSessionId: rootA, roundNumber: 1 });
  await makeRound({ rootSessionId: rootB, roundNumber: 1 });
  await makeRound({ rootSessionId: rootA, roundNumber: 2 });

  const byRoot = await store.listConsultationRounds({ rootSessionId: rootA });
  assert.equal(byRoot.length, 2, 'list filters by rootSessionId');
  assert.ok(byRoot.every((r) => r.rootSessionId === rootA));

  const all = await store.listConsultationRounds();
  assert.ok(all.length >= 3, 'list without filter returns all rounds');

  await assertRejectsCode(
    store.getConsultationRound('round_missing'),
    store.CONSULTATION_NOT_FOUND,
    'get unknown round',
  );
}

try {
  await store.initializeConsultationStore();
  await testCreateRoundAndValidation();
  await testFullLifecycleDecided();
  await testQuorumAndDigest();
  await testIllegalTransitions();
  await testCasConflict();
  await testPartialFailureAndRecover();
  await testDeadlineExpiry();
  await testCancel();
  await testListAndNotFound();
  console.log('test-consultation-store: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
