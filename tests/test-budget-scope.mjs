#!/usr/bin/env node
// P1-T1: Budget Governor scope 泛化 (C2, docs/consultation-v1-implementation-plan-2026-08-14.md §3 C2).
//
// Covers:
//   - org scope semantics unchanged (reserve/settle/release against the existing
//     organization_budget_counters ledger, same expectations as S23 budget tests).
//   - consult scope lifecycle: reserve → settle → release across the isomorphic
//     budget_scope_counters ledger addressed by `consult:<roundId>`.
//   - over-limit throws CONSULTATION_BUDGET_EXCEEDED (statusCode 409).
//   - idempotent replay: same reservationId + idempotencyKey does not double count.
//   - expired-reservation release returns capacity to available budget.
//   - startup crash reconciliation releases expired, unsettled consult
//     reservations and reports recovery.budget_reservation_released events.
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-budget-scope-'));
// Isolate config + instance root before importing anything that reads env.
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/organization-store.mjs');
const governor = await import('../chat/organization-governor.mjs');
const messaging = await import('../chat/organization-messaging.mjs');
const reconciler = await import('../chat/organization-reconciler.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function rejectsCode(fn, code, statusCode, message) {
  assertions += 1;
  return assert.rejects(fn, (error) => error?.code === code && error?.statusCode === statusCode, message);
}

await store.initializeOrganizationStore();
await governor.initializeOrganizationGovernor();
await messaging.initializeOrganizationMessaging();
const org = await store.createOrganization({
  id: 'org-scope',
  rootSessionId: 'root-scope',
  budget: { maxTotalRuns: 3, maxTokens: 1000 },
  idempotencyKey: 'org-scope',
});

// ── org scope behavior unchanged ─────────────────────────────────────────────
{
  const reserved = await governor.reserveOrganizationBudget({
    organizationId: org.id, revision: 1, reservationId: 'res-org-a', idempotencyKey: 'res-org-a',
    delta: { agents: 1, runs: 1, tokens: 400 }, limits: { maxTotalRuns: 3, maxTokens: 1000 },
  });
  equal(reserved.reservation.state, 'reserved', 'org reservation is durable');
  equal(reserved.reserved.runs, 1, 'org run reservation is counted');
  equal(reserved.totals.runs, 0, 'org totals are untouched by reservation');
  const replay = await governor.reserveOrganizationBudget({
    organizationId: org.id, revision: 1, reservationId: 'res-org-a', idempotencyKey: 'res-org-a',
    delta: { agents: 1, runs: 1, tokens: 400 }, limits: { maxTotalRuns: 3, maxTokens: 1000 },
  });
  equal(replay.replay, true, 'org reservation replay is idempotent');
  equal(replay.reserved.runs, 1, 'org replay does not double count');
  await rejectsCode(
    () => governor.reserveOrganizationBudget({
      organizationId: org.id, revision: 1, reservationId: 'res-org-over', idempotencyKey: 'res-org-over',
      delta: { runs: 3 }, limits: { maxTotalRuns: 3 },
    }),
    governor.ORG_BUDGET_EXCEEDED, 409, 'org over-limit throws ORG_BUDGET_EXCEEDED(409)',
  );
  const settled = await governor.settleOrganizationBudget({
    organizationId: org.id, revision: 1, reservationId: 'res-org-a',
    backendUsage: { runs: 1, tokens: 350, elapsedMs: 10 },
  });
  equal(settled.reservation.state, 'settled', 'org settlement closes reservation');
  equal(settled.totals.tokens, 350, 'org backend usage settles tokens');
  equal(settled.reserved.runs, 0, 'org settlement releases reservation');
  const settleReplay = await governor.settleOrganizationBudget({
    organizationId: org.id, revision: 1, reservationId: 'res-org-a', backendUsage: { runs: 999, tokens: 999 },
  });
  equal(settleReplay.replay, true, 'org settlement replay does not double count');
  await rejectsCode(
    () => governor.settleOrganizationBudget({
      organizationId: org.id, revision: 1, reservationId: 'res-org-a', backendUsage: { agentReportedUsage: { tokens: 1 } },
    }),
    governor.ORG_BUDGET_INVALID, 400, 'org Agent-reported usage is rejected',
  );
  await governor.reserveOrganizationBudget({
    organizationId: org.id, revision: 1, reservationId: 'res-org-b', idempotencyKey: 'res-org-b',
    delta: { runs: 1 }, limits: { maxTotalRuns: 3 },
  });
  const released = await governor.releaseOrganizationBudgetReservation({
    organizationId: org.id, revision: 1, reservationId: 'res-org-b', idempotencyKey: 'res-org-b', reason: 'cancelled',
  });
  equal(released.reservation.state, 'released', 'org release marks reservation released');
  equal(released.reserved.runs, 0, 'org release returns capacity');
  const releaseReplay = await governor.releaseOrganizationBudgetReservation({
    organizationId: org.id, revision: 1, reservationId: 'res-org-b', idempotencyKey: 'res-org-b', reason: 'cancelled',
  });
  equal(releaseReplay.replay, true, 'org release replay is idempotent');
  const counter = await governor.getBudgetCounter(org.id, 1);
  equal(counter.organizationId, org.id, 'org counter is keyed by organizationId');
  equal(counter.revision, 1, 'org counter is keyed by revision');
  ok(counter.version > 1, 'org counter is versioned');
  equal(counter.totals.tokens, 350, 'org ledger totals are durable');
  equal(counter.reservations['res-org-a'].state, 'settled', 'org ledger records settled reservation');
  equal(counter.reservations['res-org-b'].state, 'released', 'org ledger records released reservation');
}

// ── consult scope lifecycle (reserve → settle → release) ────────────────────
{
  const reserved = await governor.reserveConsultationBudget({
    roundId: 'round-1', reservationId: 'res-consult-a', idempotencyKey: 'res-consult-a',
    delta: { agents: 1, runs: 1, tokens: 400 }, limits: { maxTotalRuns: 3, maxTokens: 1000 }, reservationTtlMs: 60_000,
  });
  equal(reserved.scope, 'consult:round-1', 'consult scope key is consult:<roundId>');
  equal(reserved.reservation.state, 'reserved', 'consult reservation is durable');
  equal(reserved.reservation.roundId, 'round-1', 'consult reservation records roundId');
  equal(reserved.reserved.runs, 1, 'consult run reservation is counted');
  equal(reserved.totals.runs, 0, 'consult totals are untouched by reservation');
  const replay = await governor.reserveConsultationBudget({
    roundId: 'round-1', reservationId: 'res-consult-a', idempotencyKey: 'res-consult-a',
    delta: { agents: 1, runs: 1, tokens: 400 }, limits: { maxTotalRuns: 3, maxTokens: 1000 }, reservationTtlMs: 60_000,
  });
  equal(replay.replay, true, 'consult reservation replay is idempotent');
  equal(replay.reserved.runs, 1, 'consult replay does not double count');
  await rejectsCode(
    () => governor.reserveConsultationBudget({
      roundId: 'round-1', reservationId: 'res-consult-over', idempotencyKey: 'res-consult-over',
      delta: { runs: 3 }, limits: { maxTotalRuns: 3 },
    }),
    governor.CONSULTATION_BUDGET_EXCEEDED, 409, 'consult over-limit throws CONSULTATION_BUDGET_EXCEEDED(409)',
  );
  const settled = await governor.settleConsultationBudget({
    roundId: 'round-1', reservationId: 'res-consult-a', backendUsage: { runs: 1, tokens: 350, elapsedMs: 10 },
  });
  equal(settled.reservation.state, 'settled', 'consult settlement closes reservation');
  equal(settled.totals.tokens, 350, 'consult backend usage settles tokens');
  equal(settled.reserved.runs, 0, 'consult settlement releases reservation');
  const settleReplay = await governor.settleConsultationBudget({
    roundId: 'round-1', reservationId: 'res-consult-a', backendUsage: { runs: 999, tokens: 999 },
  });
  equal(settleReplay.replay, true, 'consult settlement replay does not double count');
  await rejectsCode(
    () => governor.settleConsultationBudget({
      roundId: 'round-1', reservationId: 'res-consult-a', backendUsage: { agentReportedUsage: { tokens: 1 } },
    }),
    governor.ORG_BUDGET_INVALID, 400, 'consult Agent-reported usage is rejected',
  );

  await governor.reserveConsultationBudget({
    roundId: 'round-2', reservationId: 'res-consult-b', idempotencyKey: 'res-consult-b',
    delta: { runs: 1 }, limits: { maxTotalRuns: 3 },
  });
  const released = await governor.releaseConsultationBudgetReservation({
    roundId: 'round-2', reservationId: 'res-consult-b', idempotencyKey: 'res-consult-b', reason: 'cancelled',
  });
  equal(released.reservation.state, 'released', 'consult release marks reservation released');
  equal(released.reserved.runs, 0, 'consult release returns capacity');
  const releaseReplay = await governor.releaseConsultationBudgetReservation({
    roundId: 'round-2', reservationId: 'res-consult-b', idempotencyKey: 'res-consult-b', reason: 'cancelled',
  });
  equal(releaseReplay.replay, true, 'consult release replay is idempotent');

  // settlement over-limit on a dedicated round
  await governor.reserveConsultationBudget({
    roundId: 'round-3', reservationId: 'res-consult-c', idempotencyKey: 'res-consult-c',
    delta: { tokens: 50 }, limits: { maxTokens: 100 },
  });
  await rejectsCode(
    () => governor.settleConsultationBudget({
      roundId: 'round-3', reservationId: 'res-consult-c', backendUsage: { tokens: 200 },
    }),
    governor.CONSULTATION_BUDGET_EXCEEDED, 409, 'consult settlement over-limit throws CONSULTATION_BUDGET_EXCEEDED(409)',
  );

  const counter = await governor.getConsultationBudgetCounter('round-1');
  equal(counter.scope, 'consult:round-1', 'consult counter is keyed by scope');
  equal(counter.totals.tokens, 350, 'consult ledger totals are durable');
  equal(counter.reservations['res-consult-a'].state, 'settled', 'consult ledger records settled reservation');
  const listed = await governor.listConsultationBudgetCounters();
  ok(listed.some((entry) => entry.scope === 'consult:round-1'), 'listConsultationBudgetCounters returns consult scopes');
  ok(listed.every((entry) => entry.scope.startsWith('consult:')), 'scope ledger only carries consult: keys');
}

// ── expired reservation release ──────────────────────────────────────────────
{
  await governor.reserveConsultationBudget({
    roundId: 'round-expired', reservationId: 'res-expired', idempotencyKey: 'res-expired',
    delta: { runs: 1 }, limits: { maxTotalRuns: 3 }, reservationTtlMs: 1,
  });
  const future = new Date(Date.now() + 60_000);
  const released = await governor.releaseExpiredConsultationBudgetReservations({ now: future });
  const expired = released.find((entry) => entry.idempotencyKey === 'res-expired');
  ok(expired, 'expired consult reservation is released');
  equal(expired.state, 'released', 'expired consult reservation is marked released');
  equal(expired.roundId, 'round-expired', 'released consult reservation carries roundId');
  const counter = await governor.getConsultationBudgetCounter('round-expired');
  equal(counter.reservations['res-expired'].state, 'released', 'expired consult reservation is durably released');
  equal(counter.reserved.runs, 0, 'expired consult reservation returns capacity to available budget');

  await governor.reserveConsultationBudget({
    roundId: 'round-fresh', reservationId: 'res-fresh', idempotencyKey: 'res-fresh',
    delta: { runs: 1 }, limits: { maxTotalRuns: 3 }, reservationTtlMs: 60_000,
  });
  await governor.releaseExpiredConsultationBudgetReservations({ now: future });
  const fresh = await governor.getConsultationBudgetCounter('round-fresh');
  equal(fresh.reservations['res-fresh'].state, 'reserved', 'non-expired consult reservation survives the sweep');
}

// ── startup crash reconciliation ────────────────────────────────────────────
{
  await governor.reserveConsultationBudget({
    roundId: 'round-crash', reservationId: 'res-crash', idempotencyKey: 'res-crash',
    delta: { runs: 1 }, limits: { maxTotalRuns: 3 }, reservationTtlMs: 1,
    organizationId: org.id,
  });
  const recoveryNow = new Date(Date.now() + 10_000);
  const report = await reconciler.reconcileOrganizationsAtStartup({ enabled: true, now: recoveryNow });
  const counter = await governor.getConsultationBudgetCounter('round-crash');
  equal(counter.reservations['res-crash'].state, 'released', 'startup reconcile releases expired consult reservation');
  equal(counter.reserved.runs, 0, 'startup reconcile returns consult capacity');
  equal(report.consultRecovery.reservationsReleased, 1, 'startup reconcile counts released consult reservations');
  ok(
    report.consultRecovery.audit.some((entry) => entry.type === 'recovery.budget_reservation_released'),
    'startup reconcile reports recovery.budget_reservation_released audit',
  );
  const events = await messaging.listOrganizationEvents(org.id);
  const budgetEvent = events.find((entry) => entry.type === 'recovery.budget_reservation_released');
  ok(budgetEvent, 'recovery.budget_reservation_released event is durably recorded');
  equal(budgetEvent.payloadRef.kind, 'budget_reservation', 'recovery event payloadRef.kind is budget_reservation');
  equal(budgetEvent.payloadRef.roundId, 'round-crash', 'recovery event references the consult round');

  const second = await reconciler.reconcileOrganizationsAtStartup({ enabled: true, now: recoveryNow });
  equal(second.digest, report.digest, 'startup reconciliation is deterministic');
  equal(second.consultRecovery.reservationsReleased, 0, 'replay does not release the same consult reservation twice');
}

rmSync(tempHome, { recursive: true, force: true });
console.log(`test-budget-scope: ok (${assertions} assertions)`);
