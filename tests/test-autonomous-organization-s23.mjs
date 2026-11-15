#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-autonomous-org-s23-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/organization-store.mjs');
const governor = await import('../chat/organization-governor.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function rejectsCode(fn, code, message) { assertions += 1; return assert.rejects(fn, (error) => error?.code === code, message); }

await store.initializeOrganizationStore();
const org = await store.createOrganization({ id: 'org-s23', rootSessionId: 'root-s23', budget: { maxTotalRuns: 3, maxTokens: 1000 }, idempotencyKey: 'org-s23' });
await governor.initializeOrganizationGovernor();
const reserved = await governor.reserveOrganizationBudget({ organizationId: org.id, revision: 1, reservationId: 'res-s23', idempotencyKey: 'res-s23', delta: { agents: 1, runs: 1, tokens: 400 }, limits: { maxTotalRuns: 3, maxTokens: 1000 } });
equal(reserved.reservation.state, 'reserved', 'reservation is durable');
equal(reserved.reserved.runs, 1, 'run reservation is counted');
const reservationReplay = await governor.reserveOrganizationBudget({ organizationId: org.id, revision: 1, reservationId: 'res-s23', idempotencyKey: 'res-s23', delta: { agents: 1, runs: 1, tokens: 400 }, limits: { maxTotalRuns: 3, maxTokens: 1000 } });
equal(reservationReplay.replay, true, 'reservation replay is idempotent');
await rejectsCode(() => governor.reserveOrganizationBudget({ organizationId: org.id, revision: 1, reservationId: 'res-over', idempotencyKey: 'res-over', delta: { runs: 3 }, limits: { maxTotalRuns: 3 } }), governor.ORG_BUDGET_EXCEEDED, 'reserved capacity is included in budget check');

const settled = await governor.settleOrganizationBudget({ organizationId: org.id, revision: 1, reservationId: 'res-s23', backendUsage: { runs: 1, tokens: 350, elapsedMs: 10 } });
equal(settled.reservation.state, 'settled', 'settlement closes reservation');
equal(settled.totals.tokens, 350, 'backend usage settles tokens');
equal(settled.reserved.runs, 0, 'settlement releases reservation');
const settleReplay = await governor.settleOrganizationBudget({ organizationId: org.id, revision: 1, reservationId: 'res-s23', backendUsage: { runs: 999, tokens: 999 } });
equal(settleReplay.replay, true, 'settlement replay does not double count');
await rejectsCode(() => governor.settleOrganizationBudget({ organizationId: org.id, revision: 1, reservationId: 'res-s23', backendUsage: { agentReportedUsage: { tokens: 1 } } }), governor.ORG_BUDGET_INVALID, 'Agent-reported usage is rejected');

const progress = await governor.recordProgressMutation({ organizationId: org.id, kind: 'result.created', idempotencyKey: 'packet-1', expectedProgressEpoch: 0 });
equal(progress.progressEpoch, 1, 'canonical result advances progress epoch');
const progressReplay = await governor.recordProgressMutation({ organizationId: org.id, kind: 'result.created', idempotencyKey: 'packet-1' });
equal(progressReplay.replay, true, 'duplicate progress event does not advance epoch');
await rejectsCode(() => governor.recordProgressMutation({ organizationId: org.id, kind: 'manager.run.completed', idempotencyKey: 'not-progress' }), governor.ORG_PROGRESS_INVALID, 'ordinary manager run is not progress');

const stalledByRuns = governor.evaluateStall({ progressEpoch: 1, managerAggregationRuns: 3, maxAggregationRuns: 3, now: new Date('2026-08-13T00:00:00Z') });
equal(stalledByRuns.stalled, true, 'aggregation run threshold detects stall');
const stalledByTime = governor.evaluateStall({ lastProgressAt: '2026-08-12T23:00:00Z', now: new Date('2026-08-13T00:00:00Z'), stallWindowMs: 1000 });
equal(stalledByTime.reason, 'wall_clock', 'wall clock threshold detects stall');
const action = await governor.claimStallAction({ organizationId: org.id, revision: 1, action: 'retry', idempotencyKey: 'stall-retry-1', limits: { maxRetries: 1 } });
equal(action.action.count, 1, 'bounded retry action is claimed');
equal((await governor.claimStallAction({ organizationId: org.id, revision: 1, action: 'retry', idempotencyKey: 'stall-retry-1', limits: { maxRetries: 1 } })).replay, true, 'stall action replay is idempotent');
await rejectsCode(() => governor.claimStallAction({ organizationId: org.id, revision: 1, action: 'retry', idempotencyKey: 'stall-retry-2', limits: { maxRetries: 1 } }), governor.ORG_STALLED, 'retry limit fail closes');
ok((await governor.getBudgetCounter(org.id, 1)).version > 1, 'counter is durable and versioned');

console.log(`test-autonomous-organization-s23: ok (${assertions} assertions)`);
