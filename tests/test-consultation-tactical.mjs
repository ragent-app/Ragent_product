#!/usr/bin/env node
// P6-T1 聚焦测试:战术会诊 baseRevision + contextDigest/失效条件。
// 验证 chat/consultation-store.mjs 的 evaluateTacticalConsultationDecision
// (docs/consultation-v1-implementation-plan-2026-08-14.md §8 P6-T1 / §3 C6):
//   - 创建战术 round → decide(decision 带 baseRevision + contextDigest + requiredGuards)
//   - baseRevision+contextDigest 匹配 → { tactical:true, valid:true }
//   - baseRevision 入参变化 → { valid:false, reason:'base_revision_changed' }
//   - contextDigest 入参变化 → { valid:false, reason:'context_digest_changed' }
//     (Revision 未变化 ≠ 运行事实未变化)
//   - expiresAt 且 now > expiresAt → { valid:false, reason:'expired' }
//   - 非战术决策(无 baseRevision) → { tactical:false, valid:true },忽略失效输入
//   - 未知 decision → CONSULTATION_NOT_FOUND(404)
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 隔离临时 HOME + RAGENT_CONFIG_DIR —— 必须在 import 被测模块之前设置。
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consultation-tactical-'));
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
function pastIso(ms = 2000) {
  return new Date(Date.now() - ms).toISOString();
}

async function assertRejectsCode(promise, code, label = '') {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `${label} expected code ${code}, got ${err.code} — ${err.message}`);
    return true;
  });
}

async function makeTacticalRound() {
  return store.createConsultationRound({
    rootSessionId: nextId('root'),
    roundNumber: 1,
    objective: 'tactical consultation',
    question: 'approve at current revision?',
    experts: [{ role: 'security' }],
    quorum: 1,
    budget: { tokens: 50000 },
    deadline: futureIso(),
  });
}

// 创建战术决策:baseRevision + contextDigest + requiredGuards。
async function makeTacticalDecision(round, { baseRevision = 3, contextDigest = 'sha256:abc123', expiresAt = '' } = {}) {
  return store.createConsultationDecision({
    roundId: round.id,
    decision: `approve at revision ${baseRevision}`,
    rationale: 'running facts unchanged since base',
    requiredGuards: ['execution_isolation(selector=writers,value=worktree)'],
    decidedBySessionId: nextId('session'),
    baseRevision,
    contextDigest,
    expiresAt,
  });
}

// ── baseRevision + contextDigest 匹配 → 战术有效 ──────────────────────────────
async function testMatchingDecisionValid() {
  const round = await makeTacticalRound();
  const decision = await makeTacticalDecision(round);
  const result = await store.evaluateTacticalConsultationDecision(decision.id, {
    baseRevision: 3,
    contextDigest: 'sha256:abc123',
  });
  assert.deepEqual(result, { tactical: true, valid: true }, 'matching baseRevision + contextDigest → tactical valid');
}

// ── baseRevision 入参变化 → invalid(base_revision_changed) ───────────────────
async function testBaseRevisionChanged() {
  const round = await makeTacticalRound();
  const decision = await makeTacticalDecision(round, { baseRevision: 3, contextDigest: 'sha256:abc123' });
  const result = await store.evaluateTacticalConsultationDecision(decision.id, {
    baseRevision: 4,
    contextDigest: 'sha256:abc123',
  });
  assert.equal(result.tactical, true, 'base revision change is still a tactical decision');
  assert.equal(result.valid, false, 'base revision change invalidates the decision');
  assert.equal(result.reason, 'base_revision_changed', 'reason is base_revision_changed');
}

// ── contextDigest 入参变化 → invalid(context_digest_changed) ──────────────────
async function testContextDigestChanged() {
  const round = await makeTacticalRound();
  const decision = await makeTacticalDecision(round, { baseRevision: 3, contextDigest: 'sha256:abc123' });
  // baseRevision 未变化,但 contextDigest 变化 —— Revision 未变化 ≠ 运行事实未变化
  const result = await store.evaluateTacticalConsultationDecision(decision.id, {
    baseRevision: 3,
    contextDigest: 'sha256:changed',
  });
  assert.equal(result.tactical, true, 'digest change is still a tactical decision');
  assert.equal(result.valid, false, 'context digest change invalidates the decision');
  assert.equal(result.reason, 'context_digest_changed', 'reason is context_digest_changed');
}

// ── expiresAt 且 now > expiresAt → invalid(expired) ───────────────────────────
async function testExpired() {
  const round = await makeTacticalRound();
  const decision = await makeTacticalDecision(round, {
    baseRevision: 3,
    contextDigest: 'sha256:abc123',
    expiresAt: pastIso(),
  });
  const result = await store.evaluateTacticalConsultationDecision(decision.id, {
    baseRevision: 3,
    contextDigest: 'sha256:abc123',
    now: new Date(),
  });
  assert.equal(result.tactical, true, 'expired decision is still a tactical decision');
  assert.equal(result.valid, false, 'past expiresAt invalidates the decision');
  assert.equal(result.reason, 'expired', 'reason is expired');

  // now 未超过 expiresAt → 仍有效
  const future = await makeTacticalDecision(round, {
    baseRevision: 4,
    contextDigest: 'sha256:def456',
    expiresAt: futureIso(60 * 60 * 1000),
  });
  const notYet = await store.evaluateTacticalConsultationDecision(future.id, {
    baseRevision: 4,
    contextDigest: 'sha256:def456',
    now: new Date(),
  });
  assert.deepEqual(notYet, { tactical: true, valid: true }, 'now <= expiresAt → still valid');
}

// ── 非战术决策 → { tactical:false, valid:true },忽略失效输入 ─────────────────
async function testNonTacticalDecision() {
  const round = await makeTacticalRound();
  const decision = await store.createConsultationDecision({
    roundId: round.id,
    decision: 'proceed with rollout',
    rationale: 'strategic review passed',
    decidedBySessionId: nextId('session'),
  });
  assert.equal(decision.baseRevision, null, 'strategic decision has no baseRevision');
  const result = await store.evaluateTacticalConsultationDecision(decision.id, {
    baseRevision: 1,
    contextDigest: 'sha256:whatever',
    now: new Date(),
  });
  assert.deepEqual(result, { tactical: false, valid: true }, 'non-tactical decision ignores invalidation inputs');
}

// ── 未知 decision → CONSULTATION_NOT_FOUND(404) ──────────────────────────────
async function testUnknownDecisionNotFound() {
  await assertRejectsCode(
    store.evaluateTacticalConsultationDecision('dec_missing', { baseRevision: 1 }),
    store.CONSULTATION_NOT_FOUND,
    'evaluate unknown decision',
  );
}

try {
  await store.initializeConsultationStore();
  await testMatchingDecisionValid();
  await testBaseRevisionChanged();
  await testContextDigestChanged();
  await testExpired();
  await testNonTacticalDecision();
  await testUnknownDecisionNotFound();
  console.log('test-consultation-tactical: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
