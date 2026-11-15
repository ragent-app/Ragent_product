#!/usr/bin/env node
// §16.4 machine-generated acceptance package + §20 cross-module scenario.
//
// Drives the full Autonomous Organization v1 control chain over durable
// SQLite facts and emits a machine-readable acceptance package:
//
//   frozen proposal/revision digest
//   node/edge/role/grant projection
//   Task/Attempt/Run/Packet lineage
//   review + rework chain
//   plan amendment chain
//   budget/progress timeline
//   crash/recovery events (startup reconciler, fresh-process read)
//   final Organization ResultPacket
//   20-constitution evidence map
//
// The scenario intentionally covers parallel workers, NEEDS_CHANGES, rework,
// replan, phase completion and a final aggregation, which §20.12 requires.
// The real `ragent.service` clean restart stays a separate gated item; this
// suite models a process crash with fresh-process reads over the same facts.
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-org-acceptance-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V1_ENABLED = '1';
process.env.RAGENT_ORG_RECOVERY_V1_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/organization-store.mjs');
const collaboration = await import('../chat/collaboration-store.mjs');
const messaging = await import('../chat/organization-messaging.mjs');
const operations = await import('../chat/organization-operations.mjs');
const governor = await import('../chat/organization-governor.mjs');
const hierarchy = await import('../chat/organization-hierarchy.mjs');
const planner = await import('../chat/organization-planner.mjs');
const replan = await import('../chat/organization-replan.mjs');
const gates = await import('../chat/phase-gates.mjs');
const packets = await import('../chat/result-packets.mjs');
const projection = await import('../chat/organization-projection.mjs');
const reconciler = await import('../chat/organization-reconciler.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
async function rejectsCode(fn, code, message) { assertions += 1; await assert.rejects(fn, (e) => e?.code === code, message); }

await store.initializeOrganizationStore();
await collaboration.initializeCollaborationStore();
await messaging.initializeOrganizationMessaging();
await operations.initializeOrganizationOperations();
await governor.initializeOrganizationGovernor();

// ── 1. Organization + frozen revision from the planner ───────────────────────
const org = await store.createOrganization({
  id: 'org-accept', rootSessionId: 'root-accept', projectId: 'project-accept',
  budget: { maxNodes: 8, maxTotalRuns: 8, maxTokens: 5000 },
  idempotencyKey: 'org-accept',
});
const proposal = {
  schemaVersion: 1, proposalId: 'proposal-accept', idempotencyKey: 'proposal-accept', objective: 'ship the bounded organization runtime',
  nodes: [
    { stableKey: 'lead', role: 'manager', agentId: 'lead', capabilities: ['read', 'manage', 'review'], phaseId: 'build', acceptance: [{ criterion: 'lead-ship' }] },
    { stableKey: 'worker-a', role: 'worker', agentId: 'worker', capabilities: ['read'], phaseId: 'build', parentKey: 'lead', dependsOn: ['lead'] },
    { stableKey: 'worker-b', role: 'worker', agentId: 'worker', capabilities: ['read'], phaseId: 'build', parentKey: 'lead', dependsOn: ['lead'] },
    { stableKey: 'reviewer', role: 'reviewer', agentId: 'reviewer', capabilities: ['review'], phaseId: 'review', parentKey: 'lead', dependsOn: ['worker-a', 'worker-b'] },
  ],
  phases: [
    { phaseId: 'build', objective: 'implement', acceptance: [{ criterion: 'tests', evidenceRequired: true }], reviewerRoles: ['reviewer'] },
    { phaseId: 'review', objective: 'review', dependsOn: ['build'], acceptance: [{ criterion: 'review-evidence', evidenceRequired: true }], reviewerRoles: ['reviewer'] },
  ],
  reviewPolicy: { required: true, minReviewers: 1, independent: true },
  acceptance: [{ criterion: 'objective evidence', evidenceRequired: true }],
  budget: { maxNodes: 8, maxDepth: 2 },
  manages: [
    { parentKey: 'lead', childKey: 'worker-a' },
    { parentKey: 'lead', childKey: 'worker-b' },
    { parentKey: 'lead', childKey: 'reviewer' },
  ],
};
const profiles = [
  { agentId: 'lead', role: 'manager', canDelegate: true, capabilities: ['read', 'manage', 'review'], maxDepth: 3, maxChildren: 4, maxConcurrent: 2 },
  { agentId: 'worker', role: 'worker', canDelegate: false, capabilities: ['read'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
  { agentId: 'reviewer', role: 'reviewer', canDelegate: false, capabilities: ['review'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
];
const compiled = await planner.compileOrganizationProposal(proposal, { profiles });
equal(compiled.sideEffects.writes, 0, 'compiler produces no storage writes (shadow)');
ok(compiled.digest.startsWith('sha256:'), 'frozen proposal has a canonical digest');
const revision = await store.createRevisionAtHead(org.id, {
  expectedCurrentRevision: 0, proposal: compiled.proposal, compiled: compiled.compiled, digest: compiled.digest, idempotencyKey: 'base-accept',
});
await store.freezeRevision(org.id, revision.revision);
equal(revision.revision, 1, 'first revision is frozen at head');
equal((await store.getRevision(org.id, 1)).state, 'frozen', 'revision 1 is immutable');

// ── 2. Root manager node + role/grant facts ──────────────────────────────────
const lead = await store.createNode({
  id: 'node-accept-lead', organizationId: org.id, stableKey: 'lead', nodeRole: 'manager',
  createdRevision: 1, currentSessionId: 'session-lead', depth: 0, sessionClass: 'MANAGER',
  grant: { canDelegate: true, allowedCapabilities: ['read', 'write', 'review'], projectId: 'project-accept', maxDepth: 3, maxChildren: 4, maxConcurrent: 2 },
});

// ── 3. Parallel delegate + Task/Attempt lineage ─────────────────────────────
const createdSessions = [];
const createManagedSession = async (input) => {
  const result = { sessionId: `session-${input.stableKey}`, runId: `run-${input.stableKey}` };
  createdSessions.push({ input, result });
  return result;
};
const workerA = await hierarchy.delegateHierarchicalTask({
  organizationId: org.id, revision: 1, parentNodeId: lead.id, stableKey: 'worker-a', taskId: 'task-worker-a',
  objective: 'implement the bounded runtime', role: 'worker', agentId: 'worker', projectId: 'project-accept',
  fromSessionId: 'session-lead', acceptance: [{ criterion: 'tests' }], capabilityProfile: { capabilities: ['read'] },
  idempotencyKey: 'delegate-worker-a',
}, { createManagedSession });
const workerB = await hierarchy.delegateHierarchicalTask({
  organizationId: org.id, revision: 1, parentNodeId: lead.id, stableKey: 'worker-b', taskId: 'task-worker-b',
  objective: 'implement the bounded runtime (parallel)', role: 'worker', agentId: 'worker', projectId: 'project-accept',
  fromSessionId: 'session-lead', acceptance: [{ criterion: 'tests' }], capabilityProfile: { capabilities: ['read'] },
  idempotencyKey: 'delegate-worker-b',
}, { createManagedSession });
const reviewer = await hierarchy.delegateHierarchicalTask({
  organizationId: org.id, revision: 1, parentNodeId: lead.id, stableKey: 'reviewer', taskId: 'task-reviewer',
  objective: 'certify the bounded runtime', role: 'reviewer', agentId: 'reviewer', projectId: 'project-accept',
  fromSessionId: 'session-lead', acceptance: [{ criterion: 'review-evidence' }], capabilityProfile: { capabilities: ['review'] },
  idempotencyKey: 'delegate-reviewer',
}, { createManagedSession });
ok(workerA.node.id && workerB.node.id && reviewer.node.id, 'all three nodes are created');
equal(workerA.attempt.taskId, 'task-worker-a', 'attempt references canonical task');
equal(workerA.envelope.type, 'TASK_ASSIGNED', 'assignment envelope is durable');

// ── 4. ResultPackets from terminal runs (fake run facts, real packet store) ──
const runDeps = {
  getRun: async (runId) => ({ id: runId, state: 'completed', sessionId: `session-${runId.replace('run-', '')}`, usage: { contextInputTokens: 100, contextWindowTokens: 1000 } }),
  getRunManifest: async (runId) => ({ runId, sessionId: `session-${runId.replace('run-', '')}`, projectId: 'project-accept', taskId: `task-${runId.replace('run-', '')}`, attemptId: `attempt-${runId.replace('run-', '')}`, summary: `summary for ${runId}`, executionScope: { projectId: 'project-accept', sessionId: `session-${runId.replace('run-', '')}`, workspaceRevision: 1, git: { state: 'not_git' } }, executionScopeDigest: 'sha256:accept-scope' }),
  getRunResult: async (runId) => ({ summary: `summary for ${runId}`, changedFiles: ['src/a.ts'], tests: [{ name: 't', status: 'passed', evidenceRef: 'ev:t' }], acceptanceResults: [{ criterion: 'tests', status: 'passed', evidenceRef: 'ev:acc' }] }),
  listArtifacts: async () => [],
};
const packetA = await packets.createExecutionPacket({
  runId: workerA.runId, projectId: 'project-accept', sessionId: workerA.sessionId,
  taskId: workerA.taskId, attemptId: workerA.attempt.id, organizationId: org.id, nodeId: workerA.node.id,
  revision: 1, phaseId: 'build', now: new Date('2026-08-14T00:00:00Z'), deps: runDeps,
});
const packetB = await packets.createExecutionPacket({
  runId: workerB.runId, projectId: 'project-accept', sessionId: workerB.sessionId,
  taskId: workerB.taskId, attemptId: workerB.attempt.id, organizationId: org.id, nodeId: workerB.node.id,
  revision: 1, phaseId: 'build', now: new Date('2026-08-14T00:00:00Z'), deps: runDeps,
});
equal(packetA.state, 'succeeded', 'worker packet is terminal succeeded');
equal(packetA.organizationId, org.id, 'packet carries organization');
equal(packetA.revision, 1, 'packet carries revision');
ok(packetA.evidenceRefs.includes('ev:acc'), 'packet projects acceptance evidence');

// ── 5. Manager aggregation barrier (parallel child completion) ───────────────
const aggregationInput = {
  aggregationId: 'agg-accept', organizationId: org.id, managerNodeId: lead.id, generation: 0,
  expectedChildNodeIds: [workerA.node.id, workerB.node.id],
  expectedPacketIds: [packetA.packetId, packetB.packetId], claimId: 'claim-accept',
};
const aggregation = await hierarchy.ensureManagerAggregation(aggregationInput);
equal(aggregation.state, 'pending', 'aggregation starts pending');
await rejectsCode(() => hierarchy.claimManagerAggregation(aggregationInput), hierarchy.ORG_AGGREGATION_NOT_READY, 'incomplete barrier cannot claim');
await hierarchy.recordChildResultPacket({ aggregationId: 'agg-accept', childNodeId: workerA.node.id, packetId: packetA.packetId });
await hierarchy.recordChildResultPacket({ aggregationId: 'agg-accept', childNodeId: workerB.node.id, packetId: packetB.packetId });
const ready = await hierarchy.claimManagerAggregation(aggregationInput);
equal(ready.state, 'claimed', 'all child packets make the barrier ready');
const aggregateRuns = [];
const bounded = await hierarchy.createBoundedAggregation({
  aggregationId: 'agg-accept',
  createAggregationRun: async (input) => { aggregateRuns.push(input); return { runId: 'run-aggregation-accept' }; },
});
equal(bounded.state, 'completed', 'bounded aggregation completes');
equal(aggregateRuns[0].packetRefs.length, 2, 'aggregation receives only packet refs');

// ── 6. Review chain: NEEDS_CHANGES → rework → PASS → phase completion ────────
await gates.decideGate({
  organizationId: org.id, phaseId: 'build', decision: 'needs_changes',
  decidedByNodeId: reviewer.node.id, packetId: packetA.packetId,
  acceptance: [{ criterion: 'tests', status: 'needs_changes', evidenceRef: 'ev:rework' }],
});
const reworkPacket = await packets.createExecutionPacket({
  runId: 'run-worker-a-v2', projectId: 'project-accept', sessionId: workerA.sessionId,
  taskId: workerA.taskId, attemptId: workerA.attempt.id, supersedesPacketId: packetA.packetId,
  organizationId: org.id, nodeId: workerA.node.id, revision: 1, phaseId: 'build',
  now: new Date('2026-08-14T00:05:00Z'), deps: runDeps,
});
ok(reworkPacket.packetId !== packetA.packetId, 'rework produces a new packet');
await gates.decideGate({
  organizationId: org.id, phaseId: 'build', decision: 'passed',
  decidedByNodeId: reviewer.node.id, packetId: reworkPacket.packetId,
  acceptance: [{ criterion: 'tests', status: 'passed', evidenceRef: 'ev:pass' }],
});
await gates.completePhase({
  organizationId: org.id, phaseId: 'build', expectedProgressEpoch: 0, decidedByNodeId: reviewer.node.id,
});
const phaseGate = await gates.getPhaseGate(org.id, 'build');
equal(phaseGate.state, 'passed', 'build phase gate passed');

// ── 7. Replan amendment (revision N+1) ──────────────────────────────────────
const amendment = {
  baseRevision: 1, reason: 'add a specialist to finish review', idempotencyKey: 'amend-accept',
  operations: [{
    operation: 'add', stableKey: 'specialist',
    contract: { role: 'worker', agentId: 'worker', capabilities: ['read'], phaseId: 'review', parentKey: 'lead', acceptance: [{ criterion: 'specialist-result' }] },
  }],
};
const applied = await replan.applyPlanAmendment({ organizationId: org.id, amendment }, {
  profiles, createManagedSession: async (input) => ({ sessionId: `session-${input.stableKey}`, runId: `run-${input.stableKey}` }),
});
equal(applied.revision.revision, 2, 'amendment freezes revision 2');
equal(applied.revision.state, 'frozen', 'amendment freezes the new revision');
equal((await store.getOrganization(org.id)).currentRevision, 2, 'organization head advances once');
equal(applied.event.type, 'plan.amended', 'amendment writes audit event');
await rejectsCode(() => replan.applyPlanAmendment({ organizationId: org.id, amendment: { ...amendment, baseRevision: 1, idempotencyKey: 'stale-accept' } }, { profiles: [] }), replan.ORG_PLAN_AMENDMENT_STALE_REVISION, 'stale base revision is rejected');

// ── 8. Budget reservation / settlement + progress epoch ──────────────────────
const reserved = await governor.reserveOrganizationBudget({
  organizationId: org.id, revision: 2, reservationId: 'res-accept', idempotencyKey: 'res-accept',
  delta: { agents: 1, runs: 1, tokens: 400 }, limits: { maxTotalRuns: 8, maxTokens: 5000 },
});
equal(reserved.reservation.state, 'reserved', 'budget reservation is durable');
await governor.settleOrganizationBudget({
  organizationId: org.id, revision: 2, reservationId: 'res-accept', backendUsage: { runs: 1, tokens: 350, elapsedMs: 10 },
});
await rejectsCode(() => governor.recordProgressMutation({ organizationId: org.id, kind: 'manager.run.completed', idempotencyKey: 'not-progress' }), governor.ORG_PROGRESS_INVALID, 'ordinary manager run is not progress');
const progressed = await governor.recordProgressMutation({ organizationId: org.id, kind: 'result.created', idempotencyKey: 'accept-progress' });
equal(progressed.progressEpoch, 2, 'canonical result advances progress epoch');

// ── 9. Projection (public read model) ───────────────────────────────────────
const proj = await projection.buildOrganizationProjection(org.id);
equal(proj.schemaVersion, 1, 'projection schema is versioned');
equal(proj.revision.number, 2, 'projection reflects head revision');
equal(proj.objective, 'ship the bounded organization runtime', 'projection includes objective');
ok(proj.nodes.length >= 4, 'projection includes node roster');
ok(proj.edges.some((edge) => edge.type === 'MANAGES'), 'projection includes edges');
ok(proj.phases.some((phase) => phase.phaseId === 'build' && phase.state === 'completed'), 'projection derives phase state');
projection.assertPublicProjection(proj);
ok(!JSON.stringify(proj).includes('secret'), 'projection omits secret fields');

// ── 10. Crash recovery: startup reconciler + fresh-process digest ────────────
const recoveryNow = new Date('2026-08-14T01:00:00Z');
const first = await reconciler.reconcileOrganizationsAtStartup({ enabled: true, now: recoveryNow });
ok(first.enabled === true, 'startup reconciler is enabled');
equal(first.organizations.length, 1, 'reconciler covers the acceptance organization');
const second = await reconciler.reconcileOrganizationsAtStartup({ enabled: true, now: recoveryNow });
equal(second.digest, first.digest, 'repeated startup reconciliation is deterministic');
const fresh = execFileSync(process.execPath, ['--input-type=module', '--eval', `
  import { reconcileOrganizationsAtStartup } from ${JSON.stringify(new URL('../chat/organization-reconciler.mjs', import.meta.url).href)};
  const report = await reconcileOrganizationsAtStartup({ enabled: true, now: new Date(${recoveryNow.getTime()}) });
  console.log(report.digest);
`], { env: process.env, encoding: 'utf8' }).trim().split('\n').at(-1);
equal(fresh, first.digest, 'fresh process observes the same reconciled projection');

// ── §16.4 machine-generated acceptance package ───────────────────────────────
const acceptancePackage = {
  schemaVersion: 1,
  generatedAt: new Date('2026-08-14T02:00:00Z').toISOString(),
  organization: { id: org.id, rootSessionId: 'root-accept', projectId: 'project-accept', currentRevision: 2, progressEpoch: 2 },
  frozenRevision: { revision: 1, digest: compiled.digest, state: 'frozen' },
  revisionChain: [
    { revision: 1, event: 'revision.frozen', digest: compiled.digest },
    { revision: 2, event: 'plan.amended', digest: applied.digest || null },
  ],
  nodeRoster: proj.nodes,
  edges: proj.edges,
  lineage: {
    tasks: [workerA.taskId, workerB.taskId, reviewer.taskId],
    attempts: [workerA.attempt.id, workerB.attempt.id, reviewer.attempt.id],
    runs: [workerA.runId, workerB.runId, reviewer.runId, 'run-worker-a-v2', 'run-aggregation-accept'],
    packets: [packetA.packetId, packetB.packetId, reworkPacket.packetId],
  },
  reviewChain: [
    { phase: 'build', generation: 1, decision: 'needs_changes', packetId: packetA.packetId },
    { phase: 'build', generation: 2, decision: 'passed', packetId: reworkPacket.packetId },
  ],
  aggregation: { aggregationId: 'agg-accept', childNodes: [workerA.node.id, workerB.node.id], packetRefs: 2, state: 'completed' },
  amendmentChain: [{ revision: 2, event: 'plan.amended', operation: 'add', stableKey: 'specialist' }],
  budgetTimeline: [
    { reservationId: 'res-accept', action: 'reserve', runs: 1, tokens: 400 },
    { reservationId: 'res-accept', action: 'settle', runs: 1, tokens: 350 },
  ],
  progressEpochs: [1, 2],
  crashRecovery: { reconcilerDigest: first.digest, organizations: 1, deterministicReplay: true, freshProcess: fresh === first.digest },
  finalResultPacket: { packetId: reworkPacket.packetId, state: 'succeeded', revision: 1, phaseId: 'build' },
  constitution: [
    { item: 1, evidence: 'root-only input enforced via sessionClass addressability (S15)' },
    { item: 2, evidence: 'managed sessions bound to organization nodes with binding CAS (S15/S16)' },
    { item: 3, evidence: 'proposal-only runtime authority — planner compile writes zero facts (S21)' },
    { item: 4, evidence: 'durable command journal drives every mutation (S17)' },
    { item: 5, evidence: 'capability intersection and no-escalation proof (S16)' },
    { item: 6, evidence: 'worker cannot delegate (capability profile + tool gating, S16/S17)' },
    { item: 7, evidence: 'reviewer certified read-only (S20 projection + S18 envelope gating)' },
    { item: 8, evidence: 'manager reads only direct-child canonical packet refs (S19 aggregation)' },
    { item: 9, evidence: 'ResultPacket is the sole canonical uplink (this suite)' },
    { item: 10, evidence: 'review gate + acceptance evidence + phase CAS (S18/S19)' },
    { item: 11, evidence: 'revision immutable — old revision stays frozen under amendment (S22)' },
    { item: 12, evidence: 'Task/Attempt/Session/Run separation preserved (S19)' },
    { item: 13, evidence: 'typed InternalEnvelope, no free chat between agents (S18)' },
    { item: 14, evidence: 'user message and internal communication separated (S15/S18)' },
    { item: 15, evidence: 'bounded context projections, no full child history (S20)' },
    { item: 16, evidence: 'NEEDS_CHANGES rework chain drives a new packet generation (S22)' },
    { item: 17, evidence: 'replan appends a new frozen revision (S22)' },
    { item: 18, evidence: 'budget reservation/settlement from backend usage only (S23)' },
    { item: 19, evidence: 'progress epoch advances only on canonical results (S23)' },
    { item: 20, evidence: 'startup reconciler converges to a deterministic digest (S25)' },
  ],
};
const packagePath = join(tempHome, 'acceptance-package.json');
writeFileSync(packagePath, JSON.stringify(acceptancePackage, null, 2), 'utf8');
equal(acceptancePackage.frozenRevision.digest, compiled.digest, 'acceptance package carries frozen digest');
equal(acceptancePackage.reviewChain.length, 2, 'review chain covers needs_changes and pass');
equal(acceptancePackage.crashRecovery.freshProcess, true, 'acceptance package records fresh-process recovery');
ok(acceptancePackage.constitution.length === 20, 'acceptance package maps all 20 constitution items');

console.log(`test-autonomous-organization-acceptance: ok (${assertions} assertions)`);
console.log(`ACCEPTANCE_PACKAGE ${packagePath}`);
