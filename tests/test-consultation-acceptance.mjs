#!/usr/bin/env node
// P4-T3 聚焦测试:端到端战略会诊验收(docs/consultation-v1-implementation-plan
// §8 P4-T3)。走完整战略会诊链路:
//   root session 发起 → 创建 round → dispatch 多专家(经 HTTP 控制面 + fake
//   sessionFactory)→ 各专家产出真实 consultation ResultPacket(真实 Run,
//   后端绑定 usage/scope/digest)→ 聚合 → 决策(typed guards)→ DECIDED +
//   DecisionRecord。
//
// 链路分层:
//   - HTTP 控制面 handleConsultationRoutes(mock req/res/writeJson,对齐
//     test-consultation-http.mjs 调用方式):create / get / dispatch×3 / decide
//     / get / decisions
//   - store 直连(consultation-store.mjs):linkPacketToRound / beginAggregation
//     / transitionRoundState —— packet 关联属内部 Runtime API,无 HTTP 端点
//   - result-packets.mjs createExecutionPacket 生成真实 consultation packet
//     (taskKind=consultation + consultation.recommendation)
//
// 覆盖点:
//   1. POST /api/consultations → 201 PLANNED,3 名专家,quorum=2,read-only
//   2. GET round → PLANNED,experts=3,packetIds=[]
//   3. dispatch×3(fake sessionFactory)→ 全专家 dispatched,round DISPATCHED
//   4. 各专家真实 consultation packet + linkPacketToRound×3 → packetIds=3
//   5. beginAggregation(verifyAllExpertsDone:true) → AGGREGATING
//   6. POST decide(3 typed guards,decidedBySessionId)→ 200 DECIDED
//   7. GET round → DECIDED + packetIds=3 + decidedDecisionRecordId
//   8. GET decisions → 1 条,requiredGuards 解析回 3 个 typed guard
//   9. 负面:第三专家建议不一致的新 round → decide 409 CONSULTATION_QUORUM_NOT_MET,
//      round 保持 AGGREGATING → transitionRoundState INCONCLUSIVE
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 隔离临时 HOME + RAGENT_CONFIG_DIR —— 必须在 import 被测模块之前设置。
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consultation-acceptance-'));
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_CONSULTATION_V1_ENABLED = '1';
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_WORK_ROOT_DIR;
delete process.env.RAGENT_MEMORY_DIR;
delete process.env.RAGENT_RUN_SPOOL_DIR;
delete process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT;

const { handleConsultationRoutes } = await import('../chat/router-consultation-routes.mjs');
const store = await import('../chat/consultation-store.mjs');
const resultPackets = await import('../chat/result-packets.mjs');
const runs = await import('../chat/runs.mjs');
const { createProject } = await import('../chat/projects.mjs');

// ── 断言计数器(用于报告断言数)────────────────────────────────────────────────
let totalAssertions = 0;
function eq(actual, expected, message) { totalAssertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { totalAssertions += 1; assert.ok(value, message); }
function deepEq(actual, expected, message) { totalAssertions += 1; assert.deepEqual(actual, expected, message); }

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}
function futureIso(ms = 60 * 60 * 1000) {
  return new Date(Date.now() + ms).toISOString();
}

// 战略会诊的 root session(authSession)。
const AUTH = { id: 'root_session_1', role: 'owner' };
const ROOT_SESSION_ID = 'root_session_1';

// 专家 vote:结构化建议。相同 recommendation → 相同 vote digest;不同 → 不同。
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

// fake sessionFactory:dispatch 创建受管专家会话时返回固定形态的 sessionId。
const sessionFactoryCalls = [];
let sessionSeq = 0;
const fakeSessionFactory = async (input) => {
  sessionFactoryCalls.push(input);
  sessionSeq += 1;
  return { sessionId: `expert_session_${sessionSeq}` };
};

// HTTP 控制面调用,对齐 test-consultation-http.mjs。
async function invoke(method, pathname, body, authSession = AUTH) {
  const response = {};
  await handleConsultationRoutes({
    req: { method },
    res: response,
    pathname,
    authSession,
    readBody: async () => (body === undefined ? '' : JSON.stringify(body)),
    writeJson: (res, status, payload) => {
      res.status = status;
      res.payload = payload;
    },
    sessionFactory: fakeSessionFactory,
  });
  return response;
}

// 真实 Run(terminal)→ consultation ResultPacket 的前置。
async function makeTerminalRun({ project, sessionId, runId }) {
  await runs.ensureRunDirectory(runId);
  await runs.createRun({
    status: {
      id: runId,
      sessionId,
      state: 'completed',
      contextInputTokens: 1200,
      contextWindowTokens: 64000,
      normalizedLineCount: 42,
    },
    manifest: {
      sessionId,
      requestId: `req_${runId}`,
      projectId: project.id,
      executionScope: {
        projectId: project.id,
        sessionId,
        workspaceRevision: 1,
        git: { state: 'available', baseCommit: 'base_abc', headCommit: 'head_abc', dirty: false, partial: false },
      },
      executionScopeDigest: 'sha256:test-scope',
    },
  });
  await runs.writeRunResult(runId, { summary: `summary for ${runId}` });
  return runId;
}

// 用 result-packets 创建真实 consultation packet(taskKind + consultation 块)。
async function createConsultationPacket({ runId, projectId, sessionId, taskId, attemptId, recommendation }) {
  const packet = await resultPackets.createExecutionPacket({
    runId,
    projectId,
    sessionId,
    taskId,
    attemptId,
    taskKind: 'consultation',
    consultation: { recommendation },
  });
  ok(packet && packet.packetId && packet.digest, 'created consultation packet carries packetId + digest');
  return packet;
}

const createdDirs = [];

async function main() {
  await store.initializeConsultationStore();

  // 一个共享项目承载所有专家 Run(每个专家一个 terminal run)。
  const projectRoot = mkdtempSync(join(tmpdir(), 'ragent-consult-acceptance-proj-'));
  createdDirs.push(projectRoot);
  mkdirSync(projectRoot, { recursive: true });
  const project = await createProject({ name: 'consult-acceptance', rootPath: projectRoot });

  // ── 1. POST /api/consultations:root session 创建 round(3 名专家, quorum=2) ──
  const createRes = await invoke('POST', '/api/consultations', {
    rootSessionId: ROOT_SESSION_ID,
    objective: 'Strategic rollout go/no-go',
    question: 'Should we proceed with the production rollout?',
    experts: [
      { role: 'security_reviewer' },
      { role: 'architecture_reviewer' },
      { role: 'protocol_reviewer' },
    ],
    quorum: 2,
    budget: { tokens: 100000 },
    deadline: futureIso(),
  }, AUTH);
  eq(createRes.status, 201, 'create round returns 201');
  const round = createRes.payload.round;
  eq(round.state, 'PLANNED', 'new round starts PLANNED');
  eq(round.rootSessionId, ROOT_SESSION_ID, 'root session persisted');
  eq(round.roundNumber, 1, 'roundNumber defaults to 1');
  eq(round.quorum, 2, 'quorum frozen at 2');
  eq(round.experts.length, 3, 'three expert assignments created');
  ok(round.experts.every((ex) => ex.role.endsWith('_reviewer')), 'expert roles persisted');
  ok(round.experts.every((ex) => ex.writablePaths.length === 0), 'experts are read-only (writablePaths empty)');
  ok(round.experts.every((ex) => ex.status === 'assigned'), 'experts start assigned');

  // ── 2. GET /api/consultations/:id → PLANNED ────────────────────────────────
  const getPlanned = await invoke('GET', `/api/consultations/${round.id}`, undefined, AUTH);
  eq(getPlanned.status, 200, 'get round returns 200');
  eq(getPlanned.payload.round.state, 'PLANNED');
  eq(getPlanned.payload.round.experts.length, 3);
  deepEq(getPlanned.payload.round.packetIds, [], 'fresh round derives no packet ids');

  // ── 3. POST /api/consultations/:id/dispatch ×3(fake sessionFactory) ───────
  const attemptIds = [];
  for (let i = 0; i < 3; i += 1) {
    const expert = round.experts[i];
    const attemptId = nextId(`attempt-${i + 1}`);
    attemptIds.push(attemptId);
    const dispatchRes = await invoke('POST', `/api/consultations/${round.id}/dispatch`, {
      expertAssignmentId: expert.id,
      agentId: `agent-${expert.role}`,
      attemptId,
    }, AUTH);
    eq(dispatchRes.status, 200, `dispatch expert ${i} returns 200`);
    eq(dispatchRes.payload.round.state, 'DISPATCHED', `round → DISPATCHED after dispatch ${i}`);
  }
  eq(sessionFactoryCalls.length, 3, 'three managed expert sessions created');
  for (let i = 0; i < 3; i += 1) {
    const call = sessionFactoryCalls[i];
    eq(call.rootSessionId, ROOT_SESSION_ID, `sessionFactory call ${i} carries rootSessionId`);
    eq(call.consultationRoundId, round.id, `sessionFactory call ${i} carries consultationRoundId`);
    eq(call.expertAssignmentId, round.experts[i].id, `sessionFactory call ${i} binds expertAssignmentId`);
    eq(call.role, round.experts[i].role, `sessionFactory call ${i} carries expert role`);
    eq(call.agentId, `agent-${round.experts[i].role}`, `sessionFactory call ${i} carries agentId`);
  }
  const dispatched = (await invoke('GET', `/api/consultations/${round.id}`, undefined, AUTH)).payload.round;
  eq(dispatched.state, 'DISPATCHED', 'round DISPATCHED after all dispatches');
  ok(dispatched.experts.every((ex) => ex.status === 'dispatched'), 'all experts marked dispatched');
  ok(dispatched.experts.every((ex) => ex.expertSessionId.startsWith('expert_session_')), 'expert sessions bound via fake sessionFactory');
  ok(dispatched.experts.every((ex) => ex.attemptId !== ''), 'attemptIds bound on dispatch');
  for (let i = 0; i < 3; i += 1) {
    eq(dispatched.experts[i].attemptId, attemptIds[i], `expert ${i} attemptId matches dispatch`);
  }

  // ── 4. 各专家产出真实 consultation packet + linkPacketToRound×3 ────────────
  const packets = [];
  for (let i = 0; i < 3; i += 1) {
    const runId = nextId('run');
    const sessionId = dispatched.experts[i].expertSessionId;
    await makeTerminalRun({ project, sessionId, runId });
    const packet = await createConsultationPacket({
      runId,
      projectId: project.id,
      sessionId,
      taskId: nextId('task'),
      attemptId: dispatched.experts[i].attemptId,
      recommendation: AGREE_RECOMMENDATION,
    });
    eq(packet.taskKind, 'consultation', `packet ${i} is a consultation packet`);
    deepEq(packet.consultation.recommendation, AGREE_RECOMMENDATION, `packet ${i} recommendation round-trips`);
    packets.push(packet);
  }
  for (let i = 0; i < 3; i += 1) {
    const linked = await store.linkPacketToRound(round.id, dispatched.experts[i].attemptId, packets[i].packetId);
    eq(linked, true, `packet link ${i} created`);
  }
  const linkedRound = await store.getConsultationRound(round.id);
  eq(linkedRound.packetIds.length, 3, 'packetIds derived from consultation_packet_links = 3');

  // ── 5. beginAggregation(verifyAllExpertsDone:true) → AGGREGATING ───────────
  const aggregating = await store.beginAggregation(round.id, { verifyAllExpertsDone: true });
  eq(aggregating.state, 'AGGREGATING', 'DISPATCHED → AGGREGATING');

  // ── 6. POST /api/consultations/:id/decide(typed guards)→ DECIDED ───────────
  const decideRes = await invoke('POST', `/api/consultations/${round.id}/decide`, {
    decision: 'Proceed with production rollout',
    rationale: 'All three experts approve; strategic alignment confirmed',
    requiredGuards: [
      'independent_reviewer(role=security,min=1)',
      'execution_isolation(selector=writers,value=worktree)',
      'max_concurrent_writers(value=1)',
    ],
    decidedBySessionId: ROOT_SESSION_ID,
  }, AUTH);
  eq(decideRes.status, 200, 'decide returns 200');
  eq(decideRes.payload.round.state, 'DECIDED', 'AGGREGATING → DECIDED');
  ok(decideRes.payload.round.decidedDecisionRecordId, 'round links decided decision record');
  eq(decideRes.payload.round.decidedDecisionRecordId, decideRes.payload.decision.id, 'round.decidedDecisionRecordId matches decision.id');
  ok(decideRes.payload.decision, 'decision returned');
  eq(decideRes.payload.decision.roundId, round.id);
  eq(decideRes.payload.decision.decidedBySessionId, ROOT_SESSION_ID, 'strategic decision decidedBySessionId');
  eq(decideRes.payload.decision.requiredGuards.length, 3, 'three typed guards persisted');

  // ── 7. GET round → DECIDED + packetIds=3 + decidedDecisionRecordId ─────────
  const getDecided = await invoke('GET', `/api/consultations/${round.id}`, undefined, AUTH);
  eq(getDecided.status, 200);
  eq(getDecided.payload.round.state, 'DECIDED');
  eq(getDecided.payload.round.packetIds.length, 3, 'decided round still derives 3 packetIds');
  ok(getDecided.payload.round.decidedDecisionRecordId, 'decidedDecisionRecordId non-empty');
  deepEq(
    [...getDecided.payload.round.packetIds].sort(),
    [...packets.map((p) => p.packetId)].sort(),
    'packetIds match the three linked packets',
  );

  // ── 8. GET /api/consultations/:id/decisions → typed guards 解析回 ──────────
  const decisionsRes = await invoke('GET', `/api/consultations/${round.id}/decisions`, undefined, AUTH);
  eq(decisionsRes.status, 200);
  eq(decisionsRes.payload.decisions.length, 1, 'one decision recorded');
  const decision = decisionsRes.payload.decisions[0];
  eq(decision.id, decideRes.payload.decision.id);
  deepEq(decision.requiredGuards, [
    { type: 'independent_reviewer', role: 'security', min: 1 },
    { type: 'execution_isolation', selector: 'writers', value: 'worktree' },
    { type: 'max_concurrent_writers', value: 1 },
  ], 'requiredGuards parse back to 3 typed guards');

  // ── 9. 负面:第三专家建议不一致 → QUORUM_NOT_MET(409),round 保持 AGGREGATING ──
  const negCreate = await invoke('POST', '/api/consultations', {
    rootSessionId: ROOT_SESSION_ID,
    roundNumber: 2,
    objective: 'Rollout risk gate',
    question: 'Should we proceed given the risk findings?',
    experts: [
      { role: 'security_reviewer' },
      { role: 'architecture_reviewer' },
      { role: 'protocol_reviewer' },
    ],
    quorum: 2,
    budget: { tokens: 100000 },
    deadline: futureIso(),
  }, AUTH);
  eq(negCreate.status, 201, 'negative round created');
  const negRound = negCreate.payload.round;
  eq(negRound.experts.length, 3);

  for (let i = 0; i < 3; i += 1) {
    const d = await invoke('POST', `/api/consultations/${negRound.id}/dispatch`, {
      expertAssignmentId: negRound.experts[i].id,
      agentId: `neg-agent-${negRound.experts[i].role}`,
      attemptId: nextId(`neg-attempt-${i + 1}`),
    }, AUTH);
    eq(d.status, 200, `negative dispatch ${i} returns 200`);
    eq(d.payload.round.state, 'DISPATCHED');
  }
  const negDispatched = (await invoke('GET', `/api/consultations/${negRound.id}`, undefined, AUTH)).payload.round;
  ok(negDispatched.experts.every((ex) => ex.status === 'dispatched'), 'negative round all experts dispatched');

  const negPackets = [];
  for (let i = 0; i < 3; i += 1) {
    const runId = nextId('neg-run');
    const sessionId = negDispatched.experts[i].expertSessionId;
    await makeTerminalRun({ project, sessionId, runId });
    const rec = i === 2 ? DISAGREE_RECOMMENDATION : AGREE_RECOMMENDATION;
    const packet = await createConsultationPacket({
      runId,
      projectId: project.id,
      sessionId,
      taskId: nextId('neg-task'),
      attemptId: negDispatched.experts[i].attemptId,
      recommendation: rec,
    });
    negPackets.push(packet);
  }
  for (let i = 0; i < 3; i += 1) {
    await store.linkPacketToRound(negRound.id, negDispatched.experts[i].attemptId, negPackets[i].packetId);
  }
  const negAggregating = await store.beginAggregation(negRound.id, { verifyAllExpertsDone: true });
  eq(negAggregating.state, 'AGGREGATING', 'negative round begins aggregation');

  const negDecide = await invoke('POST', `/api/consultations/${negRound.id}/decide`, {
    decision: 'Should not proceed',
    rationale: 'experts disagree on risk',
    requiredGuards: ['independent_reviewer(role=security,min=1)'],
    decidedBySessionId: ROOT_SESSION_ID,
  }, AUTH);
  eq(negDecide.status, 409, 'decide with disagreeing experts → 409');
  eq(negDecide.payload.code, 'CONSULTATION_QUORUM_NOT_MET', 'error code CONSULTATION_QUORUM_NOT_MET');
  eq((await store.getConsultationRound(negRound.id)).state, 'AGGREGATING', 'round stays AGGREGATING after failed quorum');

  // 修复语义(C6):quorum/digest 不满足时 decide 在写 DecisionRecord 之前即拒绝,
  // 因此从未进入 DECIDED 的 round 不应遗留任何决策记录。
  const negDecisions = await invoke('GET', `/api/consultations/${negRound.id}/decisions`, undefined, AUTH);
  eq(negDecisions.status, 200, 'decisions endpoint returns 200 for failed-quorum round');
  eq(negDecisions.payload.decisions.length, 0, 'failed quorum leaves no orphan decision record');

  const inconclusive = await store.transitionRoundState(negRound.id, 'INCONCLUSIVE');
  eq(inconclusive.state, 'INCONCLUSIVE', 'AGGREGATING → INCONCLUSIVE after failed quorum');

  console.log('test-consultation-acceptance: ok');
  console.log(`CONSULTATION_ACCEPTANCE_ASSERTIONS ${totalAssertions}`);
}

try {
  await main();
} finally {
  for (const dir of createdDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  rmSync(tempHome, { recursive: true, force: true });
}
