#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-autonomous-org-s24-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ORG_PROJECTION_V1_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/organization-store.mjs');
const messaging = await import('../chat/organization-messaging.mjs');
const projection = await import('../chat/organization-projection.mjs');
const routes = await import('../chat/router-organization-routes.mjs');

let assertions = 0;
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }

await store.initializeOrganizationStore();
await messaging.initializeOrganizationMessaging();
const org = await store.createOrganization({ id: 'org-s24', projectId: 'private-project', rootSessionId: 'root-s24', budget: { maxTotalRuns: 4, secret: 'must-not-leak' }, policy: { systemPrompt: 'private' }, idempotencyKey: 'org-s24' });
const revision = await store.createRevisionAtHead(org.id, { expectedCurrentRevision: 0, proposal: { objective: 'public objective' }, compiled: { objective: 'public objective', phases: [{ phaseId: 'phase-1', objective: 'build', acceptance: [{ criterion: 'tests' }] }] }, digest: 'sha256:revision', idempotencyKey: 'revision-s24' });
await store.freezeRevision(org.id, revision.revision);
const root = await store.createNode({ id: 'node-s24-root', organizationId: org.id, stableKey: 'root', nodeRole: 'manager', currentSessionId: 'root-session', sessionClass: 'MANAGER', grant: { token: 'secret-token' } });
const worker = await store.createNode({ id: 'node-s24-worker', organizationId: org.id, stableKey: 'worker', nodeRole: 'worker', parentNodeId: root.id, currentSessionId: 'worker-session', sessionClass: 'WORKER' });
await store.createOrganizationEdge({ organizationId: org.id, organizationRevision: 1, stableKey: 'root-worker', edgeType: 'MANAGES', parentNodeId: root.id, childNodeId: worker.id });
await messaging.appendOrganizationEvent({ organizationId: org.id, eventKey: 'phase-event', type: 'phase.completed', organizationRevision: 1, phaseId: 'phase-1', nodeId: worker.id, payloadRef: { kind: 'phase', id: 'phase-1' } });
await messaging.enqueueInternalEnvelope({ organizationId: org.id, organizationRevision: 1, type: 'TASK_ASSIGNED', fromNodeId: root.id, fromSessionId: root.currentSessionId, toNodeId: worker.id, subject: 'private subject', payloadRef: { kind: 'task', id: 'task-1' }, idempotencyKey: 'env-s24' });

const first = await projection.buildOrganizationProjection(org.id);
equal(first.schemaVersion, 1, 'projection schema is versioned');
equal(first.objective, 'public objective', 'projection includes objective');
equal(first.nodes.length, 2, 'projection includes node roster');
equal(first.nodes.find((node) => node.id === worker.id).parentId, root.id, 'projection includes hierarchy');
equal(first.edges[0].type, 'MANAGES', 'projection includes public edge type');
equal(first.phases[0].state, 'completed', 'projection derives phase state from event');
equal(first.activeCommunications.length, 1, 'projection includes bounded communication metadata');
equal(first.recentEvents[0].type, 'phase.completed', 'projection includes recent event summary');
ok(first.digest.startsWith('sha256:'), 'projection has digest');
projection.assertPublicProjection(first);
ok(!JSON.stringify(first).includes('secret'), 'projection omits secret fields');
ok(!JSON.stringify(first).includes('private-project'), 'projection omits private project internals');
const second = await projection.buildOrganizationProjection(org.id);
equal(second.digest, first.digest, 'projection digest is stable');
equal(projection.projectionDigest(first), first.digest, 'projection digest verifies');

function responseProbe() {
  const state = { status: 0, payload: null, headers: {} };
  return { state, setHeader(key, value) { state.headers[key] = value; }, writeHead(status, headers) { state.status = status; Object.assign(state.headers, headers); }, end(body) { state.payload = body ? JSON.parse(body) : null; } };
}
async function invoke(method, pathname, authSession, headers = {}) {
  const response = responseProbe();
  await routes.handleOrganizationRoutes({ req: { method, headers }, res: response, pathname, authSession, writeJson: (_res, status, body) => { response.state.status = status; response.state.payload = body; } });
  return response.state;
}
const denied = await invoke('GET', `/api/organizations/${org.id}/projection`, { role: 'agent' });
equal(denied.status, 403, 'projection is owner-only');
const allowed = await invoke('GET', `/api/organizations/${org.id}/projection`, { role: 'owner' });
equal(allowed.status, 200, 'owner projection route succeeds');
ok(allowed.headers.ETag, 'projection route sets ETag');
const cached = await invoke('GET', `/api/organizations/${org.id}/projection`, { role: 'owner' }, { 'if-none-match': allowed.headers.ETag });
equal(cached.status, 304, 'projection route supports ETag revalidation');
const forbiddenMutation = await invoke('POST', `/api/organizations/${org.id}/projection`, { role: 'owner' });
equal(forbiddenMutation.status, 405, 'projection endpoint does not accept mutation');
const missingRoot = await invoke('POST', `/api/organizations/${org.id}/cancel`, { role: 'owner' });
equal(missingRoot.status, 400, 'cancel requires server-selected root node');

console.log(`test-autonomous-organization-s24: ok (${assertions} assertions)`);
