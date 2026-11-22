#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-org-projection-v2-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ORG_PROJECTION_V1_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V2_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/organization-store.mjs');
const collaboration = await import('../chat/collaboration-store.mjs');
const messaging = await import('../chat/organization-messaging.mjs');
const projection = await import('../chat/organization-projection.mjs');
const context = await import('../chat/organization-context-projection.mjs');
const routes = await import('../chat/router-organization-routes.mjs');
const turnHook = await import('../chat/turn-context-hook.mjs');
const invalidation = await import('../chat/organization-invalidation.mjs');
const wsClients = await import('../chat/ws-clients.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

await store.initializeOrganizationStore();
await collaboration.initializeCollaborationStore();
await messaging.initializeOrganizationMessaging();

const org = await store.createOrganization({ id: 'org-v2', rootSessionId: 'root-v2', state: 'running', idempotencyKey: 'org-v2' });
const revision = await store.createRevisionAtHead(org.id, {
  expectedCurrentRevision: 0,
  proposal: { objective: 'status projection' },
  compiled: {
    objective: 'status projection',
    nodes: [
      { stableKey: 'worker-a', phaseId: 'build' },
      { stableKey: 'worker-b', phaseId: 'build' },
      { stableKey: 'reviewer', phaseId: 'review' },
    ],
    phases: [
      { phaseId: 'build', objective: 'build', acceptance: [{ criterion: 'tests' }] },
      { phaseId: 'review', objective: 'review', acceptance: [{ criterion: 'evidence' }] },
    ],
  },
  digest: 'sha256:v2',
  idempotencyKey: 'revision-v2',
});
await store.freezeRevision(org.id, revision.revision);
const root = await store.createNode({ id: 'node-v2-root', organizationId: org.id, stableKey: 'root', nodeRole: 'manager', currentSessionId: 'root-v2', sessionClass: 'MANAGER' });
const workerA = await store.createNode({ id: 'node-v2-a', organizationId: org.id, stableKey: 'worker-a', nodeRole: 'worker', parentNodeId: root.id, currentSessionId: 'session-a', sessionClass: 'WORKER' });
const workerB = await store.createNode({ id: 'node-v2-b', organizationId: org.id, stableKey: 'worker-b', nodeRole: 'worker', parentNodeId: root.id, currentSessionId: 'session-b', sessionClass: 'WORKER' });
const reviewer = await store.createNode({ id: 'node-v2-reviewer', organizationId: org.id, stableKey: 'reviewer', nodeRole: 'reviewer', parentNodeId: root.id, currentSessionId: 'session-reviewer', sessionClass: 'REVIEWER' });
for (const [parentNodeId, childNodeId, stableKey] of [[root.id, workerA.id, 'root-a'], [root.id, workerB.id, 'root-b'], [root.id, reviewer.id, 'root-reviewer']]) {
  await store.createOrganizationEdge({ organizationId: org.id, organizationRevision: 1, stableKey, edgeType: 'MANAGES', parentNodeId, childNodeId });
}

async function makeTask(node, taskId, objective) {
  const record = await collaboration.createCollaborationRecord({
    rootSessionId: root.currentSessionId,
    title: objective,
    policy: { organizationId: org.id, organizationNodeId: node.id, role: node.nodeRole },
    idempotencyKey: `collab-${taskId}`,
    plan: { version: 1, tasks: [{ id: taskId, objective, agentId: node.nodeRole, role: node.nodeRole, dependsOn: [], acceptance: [{ criterion: 'tests' }], retry: { maxAttempts: 2, retryOn: ['transient'] }, timeoutMs: 60_000 }] },
  });
  await collaboration.markReadyTasks(record.id);
  const attempt = await collaboration.claimTaskAttempt(taskId, { sessionId: node.currentSessionId, runId: `run-${taskId}` });
  return { recordId: record.id, taskId, attempt };
}

const taskA = await makeTask(workerA, 'task-a', 'run worker a');
const taskB = await makeTask(workerB, 'task-b', 'run worker b');
const taskReview = await makeTask(reviewer, 'task-review', 'review result');

const running = await projection.buildOrganizationProjection(org.id, { version: 2 });
equal(running.schemaVersion, 2, 'v2 projection is selected');
equal(running.nodes.find((node) => node.id === workerA.id).status, 'running', 'running attempt projects as running');
deepEqual(running.nodes.find((node) => node.id === workerA.id).progress, { state: 'running', completed: 0, total: 1, epoch: 0 }, 'progress is derived from task facts');
equal(running.summary.activeTasks, 3, 'summary counts active tasks across parallel nodes');
equal(running.asOf.eventId, 0, 'asOf exposes the event cursor');
ok(running.asOf.projectionDigest === running.digest, 'asOf carries the projection digest');
ok(!JSON.stringify(running).includes('private raw error body'), 'raw failure reason text is not public');

const reviewGate = await store.createGate({ organizationId: org.id, phaseId: 'review', generation: 1, state: 'open' });
await collaboration.completeAttempt(taskReview.attempt.id, { state: 'succeeded', resultPacketId: 'packet-review' });
const withReview = await projection.buildOrganizationProjection(org.id, { version: 2 });
equal(withReview.nodes.find((node) => node.id === reviewer.id).status, 'waiting_review', 'reviewer exposes waiting review');
equal(withReview.phases.find((phase) => phase.phaseId === 'review').state, 'waiting_review', 'phase exposes waiting review');
equal(reviewGate.state, 'open', 'review gate remains an authoritative fact');

await collaboration.completeAttempt(taskA.attempt.id, { state: 'succeeded', resultPacketId: 'packet-a' });
await collaboration.completeAttempt(taskB.attempt.id, { state: 'failed', failureKind: 'transient', failureReason: 'private raw error body' });
const blocked = await projection.buildOrganizationProjection(org.id, { version: 2 });
const blockedNode = blocked.nodes.find((node) => node.id === workerB.id);
equal(blockedNode.status, 'blocked', 'failed task is visible as a blocker');
equal(blockedNode.blocker.reasonCode, 'transient', 'only a bounded reason code is projected');
equal(blockedNode.blocker.kind, 'task', 'blocker identifies its safe source kind');
equal(blocked.summary.completedNodes, 1, 'parallel completion does not regress when a sibling blocks');

const workerContext = await context.buildOrganizationContextProjection({
  session: { id: workerA.currentSessionId, sessionPlane: 'organization', sessionClass: 'WORKER', organizationId: org.id, organizationNodeId: workerA.id },
});
equal(workerContext.targetRole, 'WORKER', 'worker context is role scoped');
equal(workerContext.task.taskId, 'task-a', 'worker context carries its task');
equal(workerContext.asOf.projectionDigest, blocked.digest, 'context carries the same projection version');
ok(!JSON.stringify(workerContext).includes('private raw error body'), 'context does not carry a sibling error body');

await store.retireNode(workerB.id, { retiredRevision: 1 });
const replaced = await projection.buildOrganizationProjection(org.id, { version: 2 });
equal(replaced.nodes.find((node) => node.id === workerB.id).status, 'replaced', 'retired node is projected as replaced');

// Regression (P2 #4): completed phase with all nodes completed and no open/passed gate
// must project state='completed' (never stuck at 'planned') while preserving honest reviewState='pending'.
const noGateOrg = await store.createOrganization({
  id: 'org-proj-phase-complete-no-gate',
  rootSessionId: 'root-phase-complete',
  state: 'running',
  idempotencyKey: 'org-proj-phase-complete-no-gate',
});
const noGateRev = await store.createRevisionAtHead(noGateOrg.id, {
  expectedCurrentRevision: 0,
  proposal: { objective: 'Complete phase cleanly' },
  compiled: {
    objective: 'Complete phase cleanly',
    nodes: [{ stableKey: 'lead', phaseId: 'phase-only' }],
    phases: [{
      phaseId: 'phase-only',
      objective: 'Run lead node',
      dependsOn: [],
      acceptance: [{ criterion: 'done', evidenceRequired: true }],
      reviewRequired: true,
    }],
  },
  digest: 'sha256:phase-complete',
  idempotencyKey: 'rev-phase-complete',
});
await store.freezeRevision(noGateOrg.id, noGateRev.revision);
const leadNode = await store.createNode({
  id: 'node-lead-phase-complete',
  organizationId: noGateOrg.id,
  stableKey: 'lead',
  nodeRole: 'specialist',
  currentSessionId: 'sess-lead-phase-complete',
  bindingGeneration: 1,
  sessionClass: 'WORKER',
});
const leadCollab = await collaboration.createCollaborationRecord({
  rootSessionId: 'root-phase-complete',
  title: 'lead-phase',
  policy: {
    organizationId: noGateOrg.id,
    organizationNodeId: leadNode.id,
    organizationRevision: 1,
    organizationBindingGeneration: 1,
    role: 'specialist',
  },
  idempotencyKey: 'collab-lead-phase-complete',
  plan: {
    version: 1,
    tasks: [{
      id: 'task-lead-complete',
      agentId: 'worker',
      role: 'specialist',
      objective: 'deliver',
      dependsOn: [],
      acceptance: [{ criterion: 'ok' }],
      writablePaths: ['out'],
      retry: { maxAttempts: 1, retryOn: ['transient'] },
      timeoutMs: 60_000,
    }],
  },
});
await collaboration.markReadyTasks(leadCollab.id);
const leadAttempt = await collaboration.claimTaskAttempt('task-lead-complete', {
  sessionId: leadNode.currentSessionId,
  runId: 'run-lead-phase-complete',
});
await collaboration.completeAttempt(leadAttempt.id, { state: 'succeeded', resultPacketId: 'pkt-lead' });
const noGateProjection = await projection.buildOrganizationProjection(noGateOrg.id, { version: 2 });
const noGatePhase = noGateProjection.phases.find((phase) => phase.phaseId === 'phase-only');
equal(noGatePhase.state, 'completed', 'phase transitions from planned to completed when all phase nodes complete');
equal(noGatePhase.reviewState, 'pending', 'reviewState honestly stays pending when no gate passed');
equal(noGatePhase.gate, null, 'gate fact is not fabricated');

function responseProbe() {
  const state = { status: 0, payload: null, headers: {} };
  return {
    state,
    setHeader(key, value) { state.headers[key] = value; },
    writeHead(status, headers = {}) { state.status = status; Object.assign(state.headers, headers); },
    end(body) { state.payload = body ? JSON.parse(body) : null; },
  };
}
async function invokeProjection(headers = {}) {
  const response = responseProbe();
  await routes.handleOrganizationRoutes({
    req: { method: 'GET', headers: { host: 'localhost', ...headers }, url: `/api/organizations/${org.id}/projection?sinceEventId=0` },
    res: response,
    pathname: `/api/organizations/${org.id}/projection`,
    authSession: { role: 'owner' },
    writeJson: (_res, status, body) => { response.state.status = status; response.state.payload = body; },
  });
  return response.state;
}
async function invokeRootProjection(headers = {}) {
  const response = responseProbe();
  await routes.handleOrganizationRoutes({
    req: { method: 'GET', headers: { host: 'localhost', ...headers }, url: '/api/sessions/root-v2/organization/projection?sinceEventId=0' },
    res: response,
    pathname: '/api/sessions/root-v2/organization/projection',
    authSession: { role: 'owner' },
    writeJson: (_res, status, body) => { response.state.status = status; response.state.payload = body; },
  });
  return response.state;
}
const routed = await invokeProjection();
equal(routed.status, 200, 'v2 projection route succeeds');
equal(routed.payload.projection.schemaVersion, 2, 'route returns v2 when the flag is enabled');
ok(routed.headers.ETag, 'v2 route sets ETag');
const cached = await invokeProjection({ 'if-none-match': routed.headers.ETag });
equal(cached.status, 304, 'v2 route supports ETag revalidation');
const rooted = await invokeRootProjection();
equal(rooted.status, 200, 'Root Session projection route succeeds');
equal(rooted.payload.projection.organizationId, org.id, 'Root Session route resolves the linked organization');

const rootHook = await turnHook.buildTurnContextHook({ id: root.currentSessionId, sessionClass: 'ROOT_LEADERSHIP' });
ok(rootHook.includes('<organization-status-projection>'), 'root leadership next turn receives organization status');

const messages = [];
const fakeWss = { clients: new Set([{ readyState: 1, _authSession: { role: 'owner' }, send(data) { messages.push(JSON.parse(data)); } }]) };
wsClients.setWss(fakeWss);
await messaging.appendOrganizationEvent({ organizationId: org.id, eventKey: 'v2-status-event', type: 'node.status_changed', organizationRevision: 1, nodeId: workerA.id, payload: { newState: 'running' } });
await wait(80);
ok(messages.some((message) => message.type === 'organization_invalidated' && message.organizationId === org.id), 'organization status changes invalidate owner projections');
const invalidated = messages.find((message) => message.type === 'organization_invalidated');
equal(invalidated.eventId, replaced.asOf.eventId + 1, 'invalidation carries the latest event id');
equal(invalidated.projectionDigest, (await projection.buildOrganizationProjection(org.id, { version: 2 })).digest, 'invalidation carries the current projection digest');
invalidation.__resetOrganizationInvalidationForTest();

console.log(`test-organization-projection-v2: ok (${assertions} assertions)`);
