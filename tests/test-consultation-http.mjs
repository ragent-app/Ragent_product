#!/usr/bin/env node
// P4-T1b 聚焦测试: Consultation V1 控制面 HTTP 路由。
// 直接调用 handleConsultationRoutes(注入 mock req/res/writeJson + fake
// sessionFactory),覆盖完整生命周期与错误语义:
//   - POST create → 201 PLANNED;GET round 含 experts + packetIds
//   - POST dispatch:agentId + fake sessionFactory 创建受管专家会话后绑定;
//     也支持直接传 expertSessionId/attemptId
//   - 经 store 直接 linkPacketToRound(beginAggregation) → POST decide(typed guards)
//     → GET round DECIDED + decidedDecisionRecordId → GET decisions
//   - 未认证 → 401;未知 round → 404;非法状态迁移 → 409 + code;
//     guard 非法 → 400 + CONSULTATION_GUARD_INVALID
//   - RAGENT_CONSULTATION_V1_ENABLED 关闭时路由不处理(子进程探针,
//     因开关在 import 时读一次)
import assert from 'assert/strict';
import { execFile } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// 隔离临时 HOME + RAGENT_CONFIG_DIR,并在 import 被测模块前打开开关。
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consultation-http-'));
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

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}
function futureIso(ms = 60 * 60 * 1000) {
  return new Date(Date.now() + ms).toISOString();
}

const OWNER_SESSION = { id: 'root-http', role: 'owner' };
const RUN_CAPABILITY_SESSION = {
  role: 'runner',
  principalKind: 'run_capability',
  surfaceMode: 'session_control',
  sessionId: 'root-capability',
  rootSessionId: 'root-capability',
  runId: 'run-capability',
  capabilityOperation: 'session.consultation.manage',
};

const sessionFactoryCalls = [];
const fakeSessionFactory = async (input) => {
  sessionFactoryCalls.push(input);
  return { sessionId: `managed-sess-${sessionFactoryCalls.length}` };
};

async function invoke(method, pathname, body, authSession = OWNER_SESSION) {
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

const AGREE_RECOMMENDATION = {
  verdict: 'APPROVE',
  rationale: 'strategic alignment confirmed',
  conditions: ['monitor rollout'],
};

// ── 完整生命周期 ─────────────────────────────────────────────────────────────

// POST /api/consultations → 201 PLANNED
const createRes = await invoke('POST', '/api/consultations', {
  rootSessionId: 'root-http-1',
  objective: 'strategic consultation',
  question: 'Should we proceed with the rollout?',
  experts: [{ role: 'security' }, { role: 'architecture' }],
  quorum: 2,
  budget: { tokens: 100000 },
  deadline: futureIso(),
});
assert.equal(createRes.status, 201, 'create round returns 201');
const round = createRes.payload.round;
assert.equal(round.state, 'PLANNED');
assert.equal(round.rootSessionId, 'root-http-1');
assert.equal(round.roundNumber, 1, 'roundNumber defaults to 1');
assert.equal(round.experts.length, 2, 'experts persisted');
assert.deepEqual(round.experts[0].writablePaths, [], 'experts are read-only');
const securityExpert = round.experts.find((expert) => expert.role === 'security');
const architectureExpert = round.experts.find((expert) => expert.role === 'architecture');
assert.ok(securityExpert && architectureExpert, 'both expert roles persisted');

// GET /api/consultations/:id → 200 PLANNED
const getPlanned = await invoke('GET', `/api/consultations/${round.id}`);
assert.equal(getPlanned.status, 200);
assert.equal(getPlanned.payload.round.state, 'PLANNED');
assert.equal(getPlanned.payload.round.packetIds.length, 0);

// POST /api/consultations/:id/dispatch — expert via agentId + fake sessionFactory
const attempt1 = nextId('attempt');
const dispatch1 = await invoke('POST', `/api/consultations/${round.id}/dispatch`, {
  expertAssignmentId: securityExpert.id,
  agentId: 'agent-security',
  attemptId: attempt1,
});
assert.equal(dispatch1.status, 200, 'dispatch returns 200');
assert.equal(dispatch1.payload.round.state, 'DISPATCHED', 'first dispatch moves PLANNED → DISPATCHED');
assert.equal(sessionFactoryCalls.length, 1, 'managed expert session created');
assert.equal(sessionFactoryCalls[0].rootSessionId, 'root-http-1');
assert.equal(sessionFactoryCalls[0].consultationRoundId, round.id);
assert.equal(sessionFactoryCalls[0].expertAssignmentId, securityExpert.id);
assert.equal(sessionFactoryCalls[0].role, 'security');
assert.equal(sessionFactoryCalls[0].agentId, 'agent-security');
const dispatchedSecurity = dispatch1.payload.round.experts.find((expert) => expert.role === 'security');
assert.ok(dispatchedSecurity.expertSessionId, 'expert bound to managed session');

// POST dispatch — second expert via explicit expertSessionId + attemptId
const attempt2 = nextId('attempt');
const dispatch2 = await invoke('POST', `/api/consultations/${round.id}/dispatch`, {
  expertAssignmentId: architectureExpert.id,
  expertSessionId: 'sess-direct-2',
  attemptId: attempt2,
});
assert.equal(dispatch2.status, 200);
assert.equal(dispatch2.payload.round.state, 'DISPATCHED');
const dispatchedArchitecture = dispatch2.payload.round.experts.find((expert) => expert.role === 'architecture');
assert.equal(dispatchedArchitecture.expertSessionId, 'sess-direct-2');

// 经 store 直接关联 packet(HTTP 层没有 link 路由,属内部 Runtime API)
const packet1 = await createConsultationPacket({
  runId: nextId('run'), taskId: nextId('task'), attemptId: attempt1, recommendation: AGREE_RECOMMENDATION,
});
const packet2 = await createConsultationPacket({
  runId: nextId('run'), taskId: nextId('task'), attemptId: attempt2, recommendation: AGREE_RECOMMENDATION,
});
await store.linkPacketToRound(round.id, attempt1, packet1.packetId);
await store.linkPacketToRound(round.id, attempt2, packet2.packetId);
await store.beginAggregation(round.id);

// POST /api/consultations/:id/decide → 200 DECIDED + decision
const decideRes = await invoke('POST', `/api/consultations/${round.id}/decide`, {
  decision: 'Proceed with rollout',
  rationale: 'Experts agree on approach',
  requiredGuards: [
    'independent_reviewer(role=security,min=1)',
    { type: 'execution_isolation', selector: 'writers', value: 'worktree' },
  ],
  decidedBySessionId: 'root-http-1',
});
assert.equal(decideRes.status, 200, 'decide returns 200');
assert.equal(decideRes.payload.round.state, 'DECIDED');
assert.ok(decideRes.payload.round.decidedDecisionRecordId, 'round links decided decision');
assert.equal(decideRes.payload.round.decidedDecisionRecordId, decideRes.payload.decision.id);
assert.ok(decideRes.payload.decision, 'decision returned');
assert.equal(decideRes.payload.decision.roundId, round.id);
assert.equal(decideRes.payload.decision.requiredGuards.length, 2, 'typed guards persisted');
assert.equal(decideRes.payload.decision.decidedBySessionId, 'root-http-1');

// GET round → DECIDED + packetIds derived from packet links
const getDecided = await invoke('GET', `/api/consultations/${round.id}`);
assert.equal(getDecided.status, 200);
assert.equal(getDecided.payload.round.state, 'DECIDED');
assert.equal(getDecided.payload.round.decidedDecisionRecordId, decideRes.payload.decision.id);
assert.deepEqual(
  [...getDecided.payload.round.packetIds].sort(),
  [packet1.packetId, packet2.packetId].sort(),
  'packetIds derived from consultation_packet_links',
);

// GET /api/consultations/:id/decisions
const decisionsRes = await invoke('GET', `/api/consultations/${round.id}/decisions`);
assert.equal(decisionsRes.status, 200);
assert.equal(decisionsRes.payload.decisions.length, 1);
assert.equal(decisionsRes.payload.decisions[0].id, decideRes.payload.decision.id);

// ── 错误语义 ─────────────────────────────────────────────────────────────────

// 未认证 → 401
const unauth = await invoke('POST', '/api/consultations', {
  rootSessionId: 'root-http-1',
  objective: 'x',
  question: 'y',
  experts: [{ role: 'security' }],
  quorum: 1,
  deadline: futureIso(),
}, null);
assert.ok(unauth.status === 401 || unauth.status === 403, `unauthenticated → 4xx (got ${unauth.status})`);

// 未知 round → 404 + code
const missing = await invoke('GET', '/api/consultations/round-does-not-exist');
assert.equal(missing.status, 404);
assert.equal(missing.payload.code, 'CONSULTATION_NOT_FOUND');

// 非法状态迁移 → 409 + code(对 DECIDED round 再 cancel)
const badCancel = await invoke('POST', `/api/consultations/${round.id}/cancel`, { reason: 'too late' });
assert.equal(badCancel.status, 409);
assert.equal(badCancel.payload.code, 'CONSULTATION_ROUND_STATE_INVALID');

// guard 非法 → 400 + CONSULTATION_GUARD_INVALID
const badGuard = await invoke('POST', `/api/consultations/${round.id}/decide`, {
  decision: 'ignored',
  requiredGuards: ['unknown_guard(value=1)'],
  decidedBySessionId: 'root-http-1',
});
assert.equal(badGuard.status, 400);
assert.equal(badGuard.payload.code, 'CONSULTATION_GUARD_INVALID');

// Run-scoped capability has no authSession.id, but may control a round rooted
// at its exact root session. A different root and a different capability
// operation must be rejected without reaching the store.
const capabilityCreate = await invoke('POST', '/api/consultations', {
  rootSessionId: RUN_CAPABILITY_SESSION.rootSessionId,
  objective: 'capability consultation',
  question: 'Can the run control this round?',
  experts: [{ role: 'security' }],
  quorum: 1,
  deadline: futureIso(),
}, RUN_CAPABILITY_SESSION);
assert.equal(capabilityCreate.status, 201, 'run capability may create a consultation for its root');
const capabilityRound = capabilityCreate.payload.round;
const capabilityGet = await invoke('GET', `/api/consultations/${capabilityRound.id}`, undefined, RUN_CAPABILITY_SESSION);
assert.equal(capabilityGet.status, 200, 'run capability may inspect its consultation');
const wrongRoot = await invoke('POST', '/api/consultations', {
  rootSessionId: 'root-capability-other',
  objective: 'must be rejected',
  question: 'wrong root',
  experts: [{ role: 'security' }],
  quorum: 1,
  deadline: futureIso(),
}, RUN_CAPABILITY_SESSION);
assert.equal(wrongRoot.status, 403, 'run capability cannot create a consultation for another root');
const wrongOperation = await invoke('POST', '/api/consultations', {
  rootSessionId: RUN_CAPABILITY_SESSION.rootSessionId,
  objective: 'must be rejected',
  question: 'wrong operation',
  experts: [{ role: 'security' }],
  quorum: 1,
  deadline: futureIso(),
}, { ...RUN_CAPABILITY_SESSION, capabilityOperation: 'session.delegate' });
assert.equal(wrongOperation.status, 403, 'a different run capability operation cannot control consultations');

// ── 关闭开关时路由不处理(子进程探针,开关 import 时读一次) ─────────────────────
const routesUrl = pathToFileURL(join(__dirname, '..', 'chat', 'router-consultation-routes.mjs')).href;
const probePath = join(tempHome, 'flag-off-probe.mjs');
await writeFile(probePath, `
  import { mkdtempSync, rmSync } from 'fs';
  import { tmpdir } from 'os';
  import { join } from 'path';
  const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consult-flagoff-'));
  process.env.HOME = tempHome;
  process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
  process.env.RAGENT_CONSULTATION_V1_ENABLED = '0';
  delete process.env.RAGENT_INSTANCE_ROOT;
  delete process.env.RAGENT_WORK_ROOT_DIR;
  delete process.env.RAGENT_MEMORY_DIR;
  delete process.env.RAGENT_RUN_SPOOL_DIR;
  delete process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT;
  const mod = await import(${JSON.stringify(routesUrl)});
  const response = {};
  const handled = await mod.handleConsultationRoutes({
    req: { method: 'POST' },
    res: response,
    pathname: '/api/consultations',
    authSession: { id: 'root', role: 'owner' },
    writeJson: (res, status, payload) => { res.status = status; res.payload = payload; },
    readBody: async () => '{}',
  });
  if (handled !== false) { console.error('expected handleConsultationRoutes to return false when disabled'); process.exit(1); }
  rmSync(tempHome, { recursive: true, force: true });
`);
const probe = await execFileAsync(process.execPath, [probePath], { timeout: 30_000 });
assert.match(probe.stdout, /^$/m, 'flag-off probe exits cleanly');

console.log('test-consultation-http: ok');

// 清理临时 HOME 与探针文件
rmSync(tempHome, { recursive: true, force: true });
