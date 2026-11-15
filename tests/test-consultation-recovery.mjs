#!/usr/bin/env node
// P6-T3 聚焦测试:启动恢复 —— 过期 deadline、孤儿 round、预算 reservation 对账。
// 验证 chat/consultation-store.mjs 的 consultationOrphanedPlannedRounds 辅助函数
// 与 chat/organization-reconciler.mjs 的 reconcileConsultationRounds(round 级启动恢复):
//   - 过期:DISPATCHED 且 now > deadline → EXPIRED,audit 含 recovery.consultation_round_expired
//   - 未过期:deadline 未来 → 不 EXPIRED
//   - 孤儿:PLANNED 且 created_at 很久前 → CANCELLED(reason 'orphaned'),audit 含 recovery.consultation_round_cancelled
//   - 新 PLANNED(created_at 现在)→ 不 CANCELLED
//   - 预算对账:consult reservation 超时未结算 → startup reconcile 释放
//   - 启动集成:reconcileOrganizationsAtStartup 返回 consultRecovery.rounds 反映过期/孤儿处理;
//     二次运行 digest 一致(consultRecovery 为 transient,不进入稳定 digest)
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 隔离临时 HOME + RAGENT_INSTANCE_ROOT + RAGENT_CONFIG_DIR —— 必须在 import 被测模块之前设置。
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-consultation-recovery-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/consultation-store.mjs');
const reconciler = await import('../chat/organization-reconciler.mjs');
const orgStore = await import('../chat/organization-store.mjs');
const governor = await import('../chat/organization-governor.mjs');
const messaging = await import('../chat/organization-messaging.mjs');

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

// 建一个 round,可选置为 DISPATCHED、可选把 created_at 回拨到很久前。
// created_at 回拨通过共享 withDatabase 直插 UPDATE 模拟「创建后长时间未派发」。
async function makeRound({ dispatched = false, deadline, rootSessionId, createdAgoMs = null } = {}) {
  const round = await store.createConsultationRound({
    rootSessionId: rootSessionId || nextId('root'),
    roundNumber: 1,
    objective: 'strategic consultation',
    question: 'Should we proceed with the rollout?',
    experts: [{ role: 'security' }, { role: 'architecture' }],
    quorum: 2,
    budget: { tokens: 100000 },
    deadline: deadline ?? futureIso(),
  });
  if (dispatched) {
    await store.dispatchConsultationRound(round.id, {
      expertAssignmentId: round.experts[0].id,
      expertSessionId: nextId('sess'),
      attemptId: nextId('attempt'),
    });
  }
  if (createdAgoMs != null) {
    const createdIso = new Date(Date.now() - createdAgoMs).toISOString();
    await store.withDatabase((db) => {
      db.prepare('UPDATE consultation_rounds SET created_at = ? WHERE id = ?').run(createdIso, round.id);
    }, { mutate: true });
  }
  return store.getConsultationRound(round.id);
}

// ── 过期:DISPATCHED 且 now > deadline → EXPIRED ─────────────────────────────
async function testExpiredDeadline() {
  const overdue = await makeRound({ dispatched: true, deadline: pastIso() });
  const result = await reconciler.reconcileConsultationRounds({ now: new Date() });
  assert.equal((await store.getConsultationRound(overdue.id)).state, 'EXPIRED', 'past-deadline DISPATCHED round is expired');
  assert.ok(
    result.audit.some((entry) => entry.type === 'recovery.consultation_round_expired' && entry.id === overdue.id),
    'audit records recovery.consultation_round_expired for the expired round',
  );
  assert.equal(result.roundsExpired, 1, 'reconcile counts the expired round');
  assert.equal(result.roundsCancelled, 0, 'no orphan cancellation in the expiry-only scenario');
}

// ── 未过期:deadline 未来 → 不 EXPIRED ───────────────────────────────────────
async function testNotExpired() {
  const fresh = await makeRound({ dispatched: true, deadline: futureIso() });
  const result = await reconciler.reconcileConsultationRounds({ now: new Date() });
  assert.equal((await store.getConsultationRound(fresh.id)).state, 'DISPATCHED', 'future-deadline round stays DISPATCHED');
  assert.ok(
    !result.audit.some((entry) => entry.type === 'recovery.consultation_round_expired' && entry.id === fresh.id),
    'no expired audit for a future-deadline round',
  );
  assert.equal(result.roundsExpired, 0, 'reconcile does not expire future-deadline rounds');
}

// ── 孤儿:PLANNED 且 created_at 很久前 → CANCELLED(reason 'orphaned') ────────
async function testOrphanedCancelled() {
  const orphaned = await makeRound({ dispatched: false, createdAgoMs: 2 * 24 * 60 * 60 * 1000 });
  const result = await reconciler.reconcileConsultationRounds({ orphanAgeMs: 0, now: new Date() });
  const round = await store.getConsultationRound(orphaned.id);
  assert.equal(round.state, 'CANCELLED', 'long-created PLANNED round is cancelled');
  assert.equal(round.failureReason, 'orphaned', 'cancelled orphan carries failure_reason=orphaned');
  assert.ok(
    result.audit.some((entry) => entry.type === 'recovery.consultation_round_cancelled' && entry.id === orphaned.id),
    'audit records recovery.consultation_round_cancelled for the orphaned round',
  );
  assert.equal(result.roundsCancelled, 1, 'reconcile counts the orphaned round');
  assert.equal(result.roundsExpired, 0, 'orphan sweep does not expire rounds');
}

// ── 新 PLANNED(created_at 现在)→ 不 CANCELLED ──────────────────────────────
async function testFreshPlannedNotCancelled() {
  const fresh = await makeRound({ dispatched: false });
  const result = await reconciler.reconcileConsultationRounds({ now: new Date() });
  assert.equal((await store.getConsultationRound(fresh.id)).state, 'PLANNED', 'fresh PLANNED round survives the orphan sweep');
  assert.ok(
    !result.audit.some((entry) => entry.type === 'recovery.consultation_round_cancelled' && entry.id === fresh.id),
    'no cancelled audit for a fresh PLANNED round',
  );
  assert.equal(result.roundsCancelled, 0, 'fresh PLANNED round is not counted as orphaned');
}

// ── adapter 注入:fake store 函数驱动 reconcileConsultationRounds ────────────
async function testAdapterInjection() {
  const fakeCancelCalls = [];
  const result = await reconciler.reconcileConsultationRounds({
    now: new Date(),
    adapters: {
      expireConsultationRoundsPastDeadline: async () => ['round_fake_expired'],
      consultationOrphanedPlannedRounds: async () => ['round_fake_orphan'],
      cancelConsultationRound: async (roundId, opts) => {
        fakeCancelCalls.push({ roundId, opts });
        return { id: roundId, state: 'CANCELLED' };
      },
    },
  });
  assert.equal(result.roundsExpired, 1, 'fake expiry results are counted');
  assert.equal(result.roundsCancelled, 1, 'fake orphan results are counted');
  assert.ok(
    result.audit.some((entry) => entry.type === 'recovery.consultation_round_expired' && entry.id === 'round_fake_expired'),
    'fake expiry round appears in audit',
  );
  assert.ok(
    result.audit.some((entry) => entry.type === 'recovery.consultation_round_cancelled' && entry.id === 'round_fake_orphan'),
    'fake orphan round appears in audit',
  );
  assert.deepEqual(fakeCancelCalls, [{ roundId: 'round_fake_orphan', opts: { reason: 'orphaned' } }], 'cancel is invoked with reason=orphaned');
}

// ── 预算对账:consult reservation 超时未结算 → startup reconcile 释放 ────────
async function testBudgetReconciliation() {
  await orgStore.initializeOrganizationStore();
  await governor.initializeOrganizationGovernor();
  await messaging.initializeOrganizationMessaging();
  const org = await orgStore.createOrganization({
    id: 'org-recovery',
    rootSessionId: 'root-recovery',
    budget: { maxTotalRuns: 3 },
    idempotencyKey: 'org-recovery',
  });
  await governor.reserveConsultationBudget({
    roundId: 'round-budget',
    reservationId: 'res-budget',
    idempotencyKey: 'res-budget',
    delta: { runs: 1 },
    limits: { maxTotalRuns: 3 },
    reservationTtlMs: 1,
    organizationId: org.id,
  });
  const recoveryNow = new Date(Date.now() + 10_000);
  const report = await reconciler.reconcileOrganizationsAtStartup({ enabled: true, now: recoveryNow });
  assert.ok(report.consultRecovery.reservationsReleased >= 1, 'startup reconcile releases the expired consult reservation');
  const counter = await governor.getConsultationBudgetCounter('round-budget');
  assert.equal(counter.reservations['res-budget'].state, 'released', 'expired consult reservation is durably released');
  assert.equal(counter.reserved.runs, 0, 'released consult reservation returns capacity');
  assert.ok(
    report.consultRecovery.audit.some((entry) => entry.type === 'recovery.budget_reservation_released'),
    'startup reconcile reports recovery.budget_reservation_released audit',
  );
  const events = await messaging.listOrganizationEvents(org.id);
  assert.ok(
    events.some((entry) => entry.type === 'recovery.budget_reservation_released'),
    'org-bound consult reservation release is durably audited',
  );
}

// ── 启动集成:reconcileOrganizationsAtStartup → consultRecovery.rounds + digest ─
async function testStartupIntegration() {
  const roundExpire = await makeRound({ dispatched: true, deadline: pastIso(60 * 1000) });
  const roundOrphan = await makeRound({ dispatched: false, createdAgoMs: 2 * 24 * 60 * 60 * 1000 });
  // 注入 fake adapter(包装 appendOrganizationEvent,记录调用)证明 options.adapters 穿透到 consult 恢复路径。
  // 同时放一个超时未结算的 org-bound consult reservation,让 budget 路径调用注入的 adapter。
  await governor.reserveConsultationBudget({
    roundId: 'round-integration-budget',
    reservationId: 'res-integration-budget',
    idempotencyKey: 'res-integration-budget',
    delta: { runs: 1 },
    limits: { maxTotalRuns: 3 },
    reservationTtlMs: 1,
    organizationId: 'org-recovery',
  });
  const startupNow = new Date(Date.now() + 10_000);
  const appendCalls = [];
  const realAppend = messaging.appendOrganizationEvent;
  const adapters = {
    appendOrganizationEvent: async (input) => {
      appendCalls.push(input);
      return realAppend(input);
    },
  };
  const first = await reconciler.reconcileOrganizationsAtStartup({ enabled: true, now: startupNow, adapters });
  assert.ok(first.consultRecovery.rounds.expired >= 1, 'startup consultRecovery.rounds.expired reflects expired rounds');
  assert.ok(first.consultRecovery.rounds.cancelled >= 1, 'startup consultRecovery.rounds.cancelled reflects orphaned rounds');
  assert.equal((await store.getConsultationRound(roundExpire.id)).state, 'EXPIRED', 'startup expiry reached the round');
  assert.equal((await store.getConsultationRound(roundOrphan.id)).state, 'CANCELLED', 'startup orphan sweep reached the round');
  assert.equal((await store.getConsultationRound(roundOrphan.id)).failureReason, 'orphaned', 'startup orphan cancel sets failure_reason=orphaned');
  assert.ok(
    first.consultRecovery.audit.some((entry) => entry.type === 'recovery.consultation_round_expired' && entry.id === roundExpire.id),
    'startup audit contains the expired round',
  );
  assert.ok(
    first.consultRecovery.audit.some((entry) => entry.type === 'recovery.consultation_round_cancelled' && entry.id === roundOrphan.id),
    'startup audit contains the cancelled orphan round',
  );
  // 二次运行:状态已收敛 → 不再重复回收;digest 稳定(consultRecovery 不进入稳定 digest)。
  const second = await reconciler.reconcileOrganizationsAtStartup({ enabled: true, now: startupNow, adapters });
  assert.equal(second.digest, first.digest, 'repeated startup reconciliation is deterministic');
  assert.equal(second.consultRecovery.rounds.expired, 0, 'replay does not expire the same round twice');
  assert.equal(second.consultRecovery.rounds.cancelled, 0, 'replay does not cancel the same round twice');
  assert.ok(appendCalls.length > 0, 'injected appendOrganizationEvent adapter was exercised (budget path)');
}

try {
  await store.initializeConsultationStore();
  await testExpiredDeadline();
  await testNotExpired();
  await testOrphanedCancelled();
  await testFreshPlannedNotCancelled();
  await testAdapterInjection();
  await testBudgetReconciliation();
  await testStartupIntegration();
  console.log('test-consultation-recovery: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
