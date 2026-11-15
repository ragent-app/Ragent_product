#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-autonomous-org-s22-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/organization-store.mjs');
const messaging = await import('../chat/organization-messaging.mjs');
const replan = await import('../chat/organization-replan.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function rejectsCode(fn, code, message) { assertions += 1; return assert.rejects(fn, (error) => error?.code === code, message); }

await store.initializeOrganizationStore();
await messaging.initializeOrganizationMessaging();
const org = await store.createOrganization({ id: 'org-s22', rootSessionId: 'root-s22', idempotencyKey: 'org-s22' });
const baseProposal = {
  schemaVersion: 1, proposalId: 'base-s22', idempotencyKey: 'base-s22', objective: 'base',
  nodes: [
    { stableKey: 'lead', role: 'manager', agentId: 'lead', capabilities: ['read', 'manage', 'review'], phaseId: 'p1', acceptance: [{ criterion: 'ship' }] },
    { stableKey: 'worker', role: 'worker', agentId: 'worker', capabilities: ['read'], phaseId: 'p1', parentKey: 'lead', dependsOn: ['lead'] },
    { stableKey: 'reviewer', role: 'reviewer', agentId: 'reviewer', capabilities: ['review'], phaseId: 'p1', parentKey: 'lead', dependsOn: ['worker'] },
  ],
  phases: [{ phaseId: 'p1', objective: 'build', acceptance: [{ criterion: 'tests' }], reviewerRoles: ['reviewer'] }],
  manages: [{ parentKey: 'lead', childKey: 'worker' }, { parentKey: 'lead', childKey: 'reviewer' }],
  reviewPolicy: { required: true, minReviewers: 1 }, acceptance: [{ criterion: 'result' }], budget: { maxNodes: 6 },
};
const compiledBase = await (await import('../chat/organization-planner.mjs')).compileOrganizationProposal(baseProposal, {
  profiles: [
    { agentId: 'lead', role: 'manager', canDelegate: true, capabilities: ['read', 'manage', 'review'], maxDepth: 3, maxChildren: 4, maxConcurrent: 2 },
    { agentId: 'worker', role: 'worker', capabilities: ['read'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
    { agentId: 'reviewer', role: 'reviewer', capabilities: ['review'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
  ],
});
const baseRevision = await store.createRevisionAtHead(org.id, { expectedCurrentRevision: 0, proposal: compiledBase.proposal, compiled: compiledBase.compiled, digest: compiledBase.digest, idempotencyKey: 'base-s22' });
await store.freezeRevision(org.id, baseRevision.revision);
const worker = await store.createNode({ id: 'node-s22-worker', organizationId: org.id, stableKey: 'worker', nodeRole: 'worker', createdRevision: 1, currentSessionId: 'session-old', bindingGeneration: 0 });
const lead = await store.createNode({ id: 'node-s22-lead', organizationId: org.id, stableKey: 'lead', nodeRole: 'manager', createdRevision: 1, currentSessionId: 'session-lead', grant: { canDelegate: true } });

const amendment = { baseRevision: 1, reason: 'replace stalled worker', idempotencyKey: 'amend-s22', operations: [{ operation: 'replace', stableKey: 'worker', replacementKey: 'replacement-1' }] };
const created = [];
const applied = await replan.applyPlanAmendment({ organizationId: org.id, amendment }, {
  profiles: [
    { agentId: 'lead', role: 'manager', canDelegate: true, capabilities: ['read', 'manage', 'review'], maxDepth: 3, maxChildren: 4, maxConcurrent: 2 },
    { agentId: 'worker', role: 'worker', capabilities: ['read'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
    { agentId: 'reviewer', role: 'reviewer', capabilities: ['review'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
  ],
  createManagedSession: async (input) => { created.push(input); return { sessionId: 'session-new', runId: 'run-new' }; },
});
equal(applied.revision.revision, 2, 'amendment appends revision N+1');
equal(applied.revision.state, 'frozen', 'amendment freezes new revision');
equal((await store.getRevision(org.id, 1)).state, 'frozen', 'old revision remains immutable');
equal((await store.getOrganization(org.id)).currentRevision, 2, 'organization head advances once');
equal(created.length, 1, 'replacement factory runs once');
equal((await store.getNode(worker.id)).currentSessionId, 'session-new', 'replacement binds new session');
equal((await store.getNode(worker.id)).bindingGeneration, 1, 'replacement advances binding generation');
equal(applied.replacements[0].event.type, 'node.session_replaced', 'replacement writes audit event');
equal(applied.event.type, 'plan.amended', 'amendment writes audit event');

const replay = await replan.applyPlanAmendment({ organizationId: org.id, amendment }, {
  profiles: [], createManagedSession: async () => { throw new Error('replay must not create a session'); },
});
equal(replay.revision.revision, 2, 'same amendment replays same revision');
equal(created.length, 1, 'amendment replay does not replace again');

const addAmendment = {
  baseRevision: 2,
  reason: 'add a specialist worker',
  idempotencyKey: 'amend-s22-add',
  operations: [{
    operation: 'add',
    stableKey: 'specialist',
    contract: {
      role: 'worker', agentId: 'specialist', capabilities: ['read'], phaseId: 'p1',
      parentKey: 'lead', acceptance: [{ criterion: 'specialist-result' }],
    },
  }],
};
const addSessions = [];
const addOptions = {
  profiles: [
    { agentId: 'lead', role: 'manager', canDelegate: true, capabilities: ['read', 'manage', 'review'], maxDepth: 3, maxChildren: 4, maxConcurrent: 2 },
    { agentId: 'worker', role: 'worker', capabilities: ['read'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
    { agentId: 'reviewer', role: 'reviewer', capabilities: ['review'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
    { agentId: 'specialist', role: 'worker', capabilities: ['read'], maxDepth: 2, maxChildren: 0, maxConcurrent: 1 },
  ],
  createManagedSession: async (input) => {
    addSessions.push(input);
    return { sessionId: 'session-specialist', runId: 'run-specialist' };
  },
};
const added = await replan.applyPlanAmendment({ organizationId: org.id, amendment: addAmendment }, addOptions);
equal(added.revision.revision, 3, 'add amendment appends a new frozen revision');
equal(added.added.length, 1, 'add amendment creates one node fact chain');
equal(addSessions.length, 1, 'add amendment creates one managed session');
const roleInstances = await store.listRoleInstances(org.id, { revision: 3 });
const edges = await store.listOrganizationEdges(org.id, { revision: 3 });
equal(roleInstances.length, 1, 'add creates one RoleInstance fact');
equal(roleInstances[0].organizationNodeId, added.added[0].node.id, 'RoleInstance binds to its Node');
equal(added.added[0].node.currentSessionId, 'session-specialist', 'Node binds to the managed Session');
equal(edges.length, 1, 'add creates one MANAGES edge fact');
equal(edges[0].parentNodeId, lead.id, 'MANAGES edge points at the existing parent');
equal(edges[0].childNodeId, added.added[0].node.id, 'MANAGES edge points at the added child');
const addedDelegationGrants = await store.listDelegationGrants(org.id, { revision: 3 });
equal(addedDelegationGrants.length, 1, 'add amendment creates one DelegationGrant');
equal(addedDelegationGrants[0].parentNodeId, lead.id, 'added DelegationGrant points to the existing parent');
equal(addedDelegationGrants[0].childNodeId, added.added[0].node.id, 'added DelegationGrant points to the new child');
const addReplay = await replan.applyPlanAmendment({ organizationId: org.id, amendment: addAmendment }, {
  profiles: [], createManagedSession: async () => { throw new Error('add replay must not create a session'); },
});
equal(addReplay.revision.revision, 3, 'same add amendment replays its frozen revision');
equal((await store.listRoleInstances(org.id, { revision: 3 })).length, 1, 'add replay does not duplicate RoleInstance');
equal((await store.listOrganizationEdges(org.id, { revision: 3 })).length, 1, 'add replay does not duplicate edge');
equal((await store.listDelegationGrants(org.id, { revision: 3 })).length, 1, 'add replay does not duplicate DelegationGrant');

const failedAddAmendment = {
  baseRevision: 3,
  reason: 'exercise session failure boundary',
  idempotencyKey: 'amend-s22-failed-add',
  operations: [{
    operation: 'add', stableKey: 'broken-specialist',
    contract: { role: 'worker', agentId: 'specialist', capabilities: ['read'], phaseId: 'p1', parentKey: 'lead' },
  }],
};
await rejectsCode(() => replan.applyPlanAmendment({ organizationId: org.id, amendment: failedAddAmendment }, {
  profiles: addOptions.profiles,
  createManagedSession: async () => { throw new Error('managed session factory interrupted'); },
}), replan.ORG_REPLAN_INVALID, 'session failure is reported without a false successful amendment');
const failedOperation = await (await import('../chat/organization-operations.mjs')).getOperation('op_amend-s22-failed-add');
equal(failedOperation.state, 'facts_created', 'session failure leaves the durable operation before external effects');
const failedNode = await store.getNodeByStableKey(org.id, 'broken-specialist');
ok(failedNode && !failedNode.currentSessionId, 'session failure leaves an explicitly unbound node for recovery/blocking');
const recoveredSessions = [];
const recoveredAdd = await replan.applyPlanAmendment({ organizationId: org.id, amendment: failedAddAmendment }, {
  profiles: addOptions.profiles,
  createManagedSession: async (input) => {
    recoveredSessions.push(input);
    return { sessionId: 'session-broken-specialist', runId: 'run-broken-specialist' };
  },
});
equal(recoveredAdd.revision.revision, 4, 'facts_created amendment resumes the existing frozen revision');
equal(recoveredSessions.length, 1, 'recovery invokes the managed session factory once');
equal((await store.getNodeByStableKey(org.id, 'broken-specialist')).currentSessionId, 'session-broken-specialist', 'recovery binds the previously unbound node');
equal((await store.listRoleInstances(org.id, { revision: 4 })).length, 1, 'recovery reuses the existing RoleInstance');
equal((await store.listOrganizationEdges(org.id, { revision: 4 })).length, 1, 'recovery reuses the existing MANAGES edge');

const edgeFailureAmendment = {
  baseRevision: 4,
  reason: 'exercise edge failure boundary',
  idempotencyKey: 'amend-s22-edge-failure',
  operations: [{
    operation: 'add', stableKey: 'edge-specialist',
    contract: { role: 'worker', agentId: 'specialist', capabilities: ['read'], phaseId: 'p1', parentKey: 'lead' },
  }],
};
let edgeFactoryCalls = 0;
let edgeWriterCalls = 0;
await rejectsCode(() => replan.applyPlanAmendment({ organizationId: org.id, amendment: edgeFailureAmendment }, {
  profiles: addOptions.profiles,
  createManagedSession: async () => { edgeFactoryCalls += 1; return { sessionId: 'session-edge-specialist' }; },
  createOrganizationEdge: async () => { edgeWriterCalls += 1; throw new Error('edge writer interrupted'); },
}), replan.ORG_REPLAN_INVALID, 'edge failure is reported after session binding without false success');
equal(edgeFactoryCalls, 1, 'edge failure setup invokes the session factory once');
equal(edgeWriterCalls, 1, 'edge failure setup reaches the edge writer');
const edgeNode = await store.getNodeByStableKey(org.id, 'edge-specialist');
ok(edgeNode && edgeNode.currentSessionId === 'session-edge-specialist', 'edge failure leaves the Node bound for recovery');
let recoveredEdgeFactoryCalls = 0;
const edgeRecovered = await replan.applyPlanAmendment({ organizationId: org.id, amendment: edgeFailureAmendment }, {
  profiles: addOptions.profiles,
  createManagedSession: async () => { recoveredEdgeFactoryCalls += 1; return { sessionId: 'must-not-run' }; },
});
equal(edgeRecovered.revision.revision, 5, 'bound add replay resumes the existing frozen revision');
equal(recoveredEdgeFactoryCalls, 0, 'bound add replay does not create a second Session');
equal((await store.listOrganizationEdges(org.id, { revision: 5 })).length, 1, 'bound add replay fills the missing MANAGES edge');

await rejectsCode(() => replan.applyPlanAmendment({ organizationId: org.id, amendment: { ...amendment, baseRevision: 1, idempotencyKey: 'stale-new' } }, { profiles: [] }), replan.ORG_PLAN_AMENDMENT_STALE_REVISION, 'stale base revision is rejected');
await rejectsCode(() => replan.replaceManagedSession({ organizationId: org.id, nodeId: worker.id, expectedBindingGeneration: 0, replacementKey: 'race' }, { createManagedSession: async () => ({ sessionId: 'session-race' }) }), replan.ORG_SESSION_BINDING_CONFLICT, 'stale binding generation is rejected');
await rejectsCode(() => replan.applyPlanAmendment({ organizationId: org.id, amendment: { ...amendment, baseRevision: 5, idempotencyKey: 'bad-add', operations: [{ operation: 'add', stableKey: 'new-node' }] } }, { profiles: [] }), replan.ORG_REPLAN_INVALID, 'incomplete add contract has no partial side effect');
ok(lead.id, 'root fact remains available after amendment');

console.log(`test-autonomous-organization-s22: ok (${assertions} assertions)`);
