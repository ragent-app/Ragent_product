#!/usr/bin/env node
// S25: startup reconciliation, lease recovery, idempotent replay, and
// fail-closed reporting. This suite deliberately uses durable SQLite facts and
// a fresh-process read to model a process crash without inventing provider
// success or mutating canonical history outside the existing stores.
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-autonomous-org-s25-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/organization-store.mjs');
const collaboration = await import('../chat/collaboration-store.mjs');
const messaging = await import('../chat/organization-messaging.mjs');
const operations = await import('../chat/organization-operations.mjs');
const hierarchy = await import('../chat/organization-hierarchy.mjs');
const reconciler = await import('../chat/organization-reconciler.mjs');
const governor = await import('../chat/organization-governor.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
async function rejectsCode(fn, code, message) { assertions += 1; await assert.rejects(fn, (error) => error?.code === code, message); }

await store.initializeOrganizationStore();
await collaboration.initializeCollaborationStore();
await messaging.initializeOrganizationMessaging();
await operations.initializeOrganizationOperations();
const org = await store.createOrganization({ id: 'org-s25', rootSessionId: 'root-s25', currentRevision: 1, budget: { maxTotalRuns: 3 }, idempotencyKey: 'org-s25' });
const root = await store.createNode({ id: 'node-s25-root', organizationId: org.id, stableKey: 'root', nodeRole: 'manager', currentSessionId: 'session-root', grant: { canDelegate: true } });
const worker = await store.createNode({ id: 'node-s25-worker', organizationId: org.id, stableKey: 'worker', nodeRole: 'worker', parentNodeId: root.id, currentSessionId: 'session-worker' });
await store.createOrganizationEdge({ organizationId: org.id, organizationRevision: 1, stableKey: 'root-worker', edgeType: 'MANAGES', parentNodeId: root.id, childNodeId: worker.id, idempotencyKey: 'edge-s25-root-worker' });

const staleEnvelope = await messaging.enqueueInternalEnvelope({
  envelopeId: 'env-s25-stale', organizationId: org.id, organizationRevision: 1, type: 'TASK_ASSIGNED',
  fromNodeId: root.id, fromSessionId: root.currentSessionId, toNodeId: worker.id, toSessionId: worker.currentSessionId,
  subject: 'recover me', payloadRef: { kind: 'task', id: 'task-s25' }, idempotencyKey: 'env-s25-stale',
});
const claimed = await messaging.claimInternalEnvelope(staleEnvelope.envelopeId, {
  expectedGeneration: 0, consumerSessionId: worker.currentSessionId, leaseMs: 1000,
});
ok(claimed.leaseUntil, 'claimed envelope has a durable lease');

const aggregation = await hierarchy.ensureManagerAggregation({
  aggregationId: 'agg-s25', organizationId: org.id, managerNodeId: root.id,
  expectedChildNodeIds: [worker.id], expectedPacketIds: ['packet-s25'],
});
await hierarchy.recordChildResultPacket({ aggregationId: aggregation.aggregationId, childNodeId: worker.id, packetId: 'packet-s25' });
const aggregationClaim = await hierarchy.claimManagerAggregation({
  aggregationId: aggregation.aggregationId, organizationId: org.id, managerNodeId: root.id,
  expectedChildNodeIds: [worker.id], expectedPacketIds: ['packet-s25'], generation: 0, claimId: 'claim-s25', leaseMs: 1000,
});
ok(aggregationClaim.leaseUntil, 'claimed aggregation has a durable lease');

const completedOperation = await operations.createOperation({
  organizationId: org.id, commandKind: 'completedBeforeRecovery', idempotencyKey: 'op-s25-completed',
  actorNodeId: root.id, actorSessionId: root.currentSessionId, revision: 1, payload: { stableKey: 'completed' },
});
for (const nextState of ['validated', 'facts_created', 'external_effect_created', 'bound', 'completed']) {
  await operations.transitionOperation(completedOperation.operationId, {
    expectedState: completedOperation.state,
    expectedVersion: completedOperation.version,
    expectedGeneration: completedOperation.generation,
    nextState,
    currentStep: nextState,
  });
  Object.assign(completedOperation, await operations.getOperation(completedOperation.operationId));
}
const operation = await operations.createOperation({ organizationId: org.id, commandKind: 'delegateTask', idempotencyKey: 'op-s25', actorNodeId: root.id, actorSessionId: root.currentSessionId, revision: 1, payload: { stableKey: 'worker' } });
await operations.transitionOperation(operation.operationId, { expectedState: 'requested', expectedVersion: 1, expectedGeneration: 0, nextState: 'failed_retryable', currentStep: 'reconcile' });
const pendingOperation = await operations.createOperation({
  organizationId: org.id, commandKind: 'pendingRecovery', idempotencyKey: 'op-s25-pending',
  actorNodeId: root.id, actorSessionId: root.currentSessionId, revision: 1, payload: { stableKey: 'pending' },
});
await governor.initializeOrganizationGovernor();
await governor.reserveOrganizationBudget({
  organizationId: org.id,
  revision: 1,
  reservationId: 'reservation-s25-expired',
  idempotencyKey: 'reservation-s25-expired',
  delta: { runs: 1 },
  reservationTtlMs: 1000,
});
const retryCollaboration = await collaboration.createCollaborationRecord({
  rootSessionId: root.currentSessionId,
  title: 'S25 retry recovery',
  policy: { organizationId: org.id, organizationNodeId: worker.id },
  idempotencyKey: 'collaboration-s25-retry',
  plan: {
    version: 1,
    tasks: [{
      id: 'task-s25-retry', objective: 'recover retry', agentId: 'worker', role: 'worker',
      dependsOn: [], acceptance: [], writablePaths: [],
      retry: { maxAttempts: 2, retryOn: ['unknown_outcome'] }, timeoutMs: 600000,
    }],
  },
});
await collaboration.markReadyTasks(retryCollaboration.id);
const expiredRetryAttempt = await collaboration.claimTaskAttempt('task-s25-retry', {
  sessionId: worker.currentSessionId, runId: 'run-s25-retry', leaseMs: 1000,
});
ok(expiredRetryAttempt, 'retry recovery has a running attempt to reclaim');

const recoveryNow = new Date(Date.now() + 10_000);
const first = await reconciler.reconcileOrganizationsAtStartup({ enabled: true, now: recoveryNow });
const report = first.organizations.find((entry) => entry.organizationId === org.id);
equal(report.status, 'recovering', 'recoverable leases do not become a false healthy state');
equal(report.recovery.envelopesReclaimed, 1, 'expired envelope lease is reclaimed');
equal(report.recovery.aggregationsReclaimed, 1, 'expired aggregation lease is reclaimed');
equal(report.recovery.operationsAdvanced, 1, 'retryable operation is advanced through its journal');
equal(report.counts.pendingOperations, 2, 'operation counts remain stable when terminal rows are omitted from execution results');
equal(report.recovery.budgetReservationsReleased, 1, 'expired budget reservation is released');
equal(report.recovery.attemptsReconciled, 1, 'expired attempt is reconciled');
equal(report.recovery.attemptsRetried, 1, 'retryable expired attempt is counted as scheduled for retry');
equal((await messaging.getInternalEnvelope(staleEnvelope.envelopeId)).deliveryState, 'pending', 'expired envelope returns to pending');
equal((await hierarchy.getManagerAggregation(aggregation.aggregationId)).state, 'ready', 'expired aggregation returns to ready');
equal((await operations.getOperation(operation.operationId)).state, 'reconciled', 'retryable operation is not marked successful');
equal((await governor.getBudgetCounter(org.id, 1)).reserved.runs, 0, 'released budget is removed from reserved capacity');
equal((await governor.getBudgetCounter(org.id, 1)).reservations['reservation-s25-expired'].state, 'released', 'expired reservation is durably marked released');

await rejectsCode(() => messaging.deliverInternalEnvelope(staleEnvelope.envelopeId, {
  expectedGeneration: claimed.deliveryGeneration,
  sessionId: worker.currentSessionId,
}), messaging.ORG_ENVELOPE_CONFLICT, 'old envelope consumer cannot deliver after generation fencing');
await rejectsCode(() => messaging.acknowledgeInternalEnvelope(staleEnvelope.envelopeId, {
  expectedGeneration: claimed.deliveryGeneration,
  sessionId: worker.currentSessionId,
}), messaging.ORG_ENVELOPE_CONFLICT, 'old envelope consumer cannot acknowledge after generation fencing');
let staleAggregationCallback = false;
await rejectsCode(() => hierarchy.createBoundedAggregation({
  aggregationId: aggregation.aggregationId,
  expectedGeneration: aggregationClaim.generation,
  createAggregationRun: async () => { staleAggregationCallback = true; return { runId: 'run-stale' }; },
}), hierarchy.ORG_HIERARCHY_CONFLICT, 'old aggregation claim cannot complete after generation fencing');
equal(staleAggregationCallback, false, 'stale aggregation writer is rejected before creating a Run');

const second = await reconciler.reconcileOrganizationsAtStartup({ enabled: true, now: recoveryNow });
equal(second.digest, first.digest, 'repeated startup reconciliation is deterministic');
equal(second.organizations[0].recovery.envelopesReclaimed, 0, 'replay does not reclaim the same envelope twice');
equal(second.organizations[0].recovery.aggregationsReclaimed, 0, 'replay does not reclaim the same aggregation twice');
equal(second.organizations[0].recovery.budgetReservationsReleased, 0, 'replay does not release the same budget reservation twice');

const events = await messaging.listOrganizationEvents(org.id);
for (const type of [
  'recovery.operation_reconciled',
  'recovery.envelope_reclaimed',
  'recovery.aggregation_reclaimed',
  'recovery.attempt_reconciled',
  'recovery.budget_reservation_released',
]) {
  ok(events.some((event) => event.type === type), `${type} is durably auditable`);
}

const beforeAuditFailure = await messaging.getInternalEnvelope(staleEnvelope.envelopeId);
const auditFailure = await reconciler.reconcileOrganizationById(org.id, {
  enabled: true,
  now: recoveryNow,
  adapters: {
    appendOrganizationEvent: async () => { throw Object.assign(new Error('audit sink unavailable'), { code: 'AUDIT_UNAVAILABLE' }); },
  },
});
equal(auditFailure.status, 'blocked', 'audit sink failure fail closes the organization report');
ok(auditFailure.errors.some((entry) => entry.area.startsWith('audit.')), 'audit sink failure is reported with an area');
equal((await messaging.getInternalEnvelope(staleEnvelope.envelopeId)).deliveryGeneration, beforeAuditFailure.deliveryGeneration, 'audit failure does not repeat the domain recovery');

const repaired = await reconciler.reconcileOrganizationById(org.id, { enabled: true, now: recoveryNow });
equal(repaired.status, 'recovering', 'normal startup remains conservative after audit repair');
const repairedEvents = await messaging.listOrganizationEvents(org.id);
equal(repairedEvents.filter((event) => event.type === 'recovery.envelope_reclaimed').length, 1, 'missing recovery audit is repaired exactly once');

await rejectsCode(() => operations.transitionOperation(operation.operationId, {
  expectedState: 'failed_retryable', expectedVersion: 2, expectedGeneration: 1,
  nextState: 'validated', currentStep: 'stale-writer',
}), operations.ORG_OPERATION_CONFLICT, 'stale writer cannot advance a reconciled operation');

const fresh = execFileSync(process.execPath, ['--input-type=module', '--eval', `
  import { reconcileOrganizationsAtStartup } from ${JSON.stringify(new URL('../chat/organization-reconciler.mjs', import.meta.url).href)};
  const report = await reconcileOrganizationsAtStartup({ enabled: true, now: new Date(${recoveryNow.getTime()}) });
  console.log(report.digest);
`], { env: process.env, encoding: 'utf8' }).trim().split('\n').at(-1);
equal(fresh, second.digest, 'fresh process observes the same reconciled projection');

const disabled = execFileSync(process.execPath, ['--input-type=module', '--eval', `
  delete process.env.RAGENT_ORG_SCHEMA_ENABLED;
  const { reconcileOrganizationsAtStartup } = await import(${JSON.stringify(new URL('../chat/organization-reconciler.mjs', import.meta.url).href)});
  console.log(JSON.stringify(await reconcileOrganizationsAtStartup()));
`], { env: process.env, encoding: 'utf8' }).trim().split('\n').at(-1);
equal(JSON.parse(disabled).enabled, false, 'feature flag off leaves organization recovery disabled');

console.log(`test-autonomous-organization-s25: ok (${assertions} assertions)`);
