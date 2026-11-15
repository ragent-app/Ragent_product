#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-org-provisioning-route-'));
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';
process.env.RAGENT_ORG_PROJECTION_V1_ENABLED = '1';
process.env.RAGENT_ORG_AUTONOMOUS_PROVISIONING_ENABLED = '1';
mkdirSync(join(tempHome, 'workspace'), { recursive: true });

const store = await import('../chat/organization-store.mjs');
const routes = await import('../chat/router-organization-routes.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const sessionRoutes = await import('../chat/router-session-main-routes.mjs');

let assertions = 0;
function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}
function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

await store.initializeOrganizationStore();
const org = await store.createOrganization({
  id: 'org-provision-route',
  rootSessionId: 'root-provision-route',
  idempotencyKey: 'org-provision-route',
});

function responseProbe() {
  const state = { status: 0, payload: null };
  return {
    state,
    setHeader() {},
    writeHead(status) { state.status = status; },
    end(body) { state.payload = body ? JSON.parse(body) : null; },
  };
}

async function invoke({ authSession, body = '', headers = {}, provisionRevision } = {}) {
  const response = responseProbe();
  await routes.handleOrganizationRoutes({
    req: { method: 'POST', headers },
    res: response,
    pathname: `/api/organizations/${org.id}/provision`,
    authSession,
    readBody: async () => body,
    provisionRevision,
    managedSessionFactory: async () => ({ sessionId: 'route-session' }),
    writeJson: (_res, status, payload) => {
      response.state.status = status;
      response.state.payload = payload;
    },
  });
  return response.state;
}

async function invokeSessionList() {
  const response = responseProbe();
  await sessionRoutes.handleSessionMainRoutes({
    req: { method: 'GET', headers: {} },
    res: response,
    parsedUrl: { query: {} },
    pathname: '/api/sessions',
    authSession: { role: 'owner' },
    sessionGetRoute: { kind: 'list' },
    createSessionSummaryRef: (session) => ({ id: session.id }),
    immutablePrivateEventCacheControl: 'private, no-store',
    isDirectoryPath: async () => true,
    readSessionMessagePayload: async () => ({}),
    requireSessionAccess: async () => true,
    isSessionVisibleToAuthSession: () => true,
    getAuthPrincipalId: () => 'owner',
    getAuthScopeAgentId: () => '',
    isAgentScopedAuthSession: () => false,
    resolveRequestedSessionAttachments: async () => [],
    writeJson: (_res, status, payload) => {
      response.state.status = status;
      response.state.payload = payload;
    },
    writeJsonCached: (_req, _res, payload) => {
      response.state.status = 200;
      response.state.payload = payload;
    },
  });
  return response.state;
}

const denied = await invoke({
  authSession: { role: 'agent' },
  body: JSON.stringify({ revision: 1, idempotencyKey: 'route-denied' }),
});
equal(denied.status, 403, 'provisioning route is owner-only');

const missingKey = await invoke({
  authSession: { role: 'owner' },
  body: JSON.stringify({ revision: 1 }),
});
equal(missingKey.status, 400, 'provisioning route requires an idempotency key');
equal(missingKey.payload.code, 'ORG_PROVISIONING_IDEMPOTENCY_REQUIRED', 'missing key has a stable error code');

let received;
const allowed = await invoke({
  authSession: { role: 'owner' },
  body: JSON.stringify({ revision: '3', idempotencyKey: 'route-command-1' }),
  provisionRevision: async (input) => {
    received = input;
    return { attempted: true, state: 'provisioned', createdManagedSessions: 1 };
  },
});
equal(allowed.status, 200, 'owner provisioning command succeeds');
equal(allowed.payload.provisioning.state, 'provisioned', 'route returns the provisioning result');
equal(received.organizationId, org.id, 'route passes the path organization id');
equal(received.revision, 3, 'route normalizes a string revision');
equal(received.idempotencyKey, 'route-command-1', 'route passes the body idempotency key');
ok(typeof received.createManagedSession === 'function', 'route passes the managed-session factory boundary');

const headerKey = await invoke({
  authSession: { role: 'owner' },
  body: JSON.stringify({ revision: 1 }),
  headers: { 'idempotency-key': 'route-header-key' },
  provisionRevision: async (input) => ({ attempted: true, state: input.idempotencyKey }),
});
equal(headerKey.status, 200, 'route accepts the standard idempotency header');
equal(headerKey.payload.provisioning.state, 'route-header-key', 'header idempotency key reaches the command');

const rootSession = await sessionManager.createSession(join(tempHome, 'workspace'), 'missing-tool', 'Visible root', {
  suppressBroadcast: true,
});
const forkChild = await sessionManager.createSession(join(tempHome, 'workspace'), 'missing-tool', 'Visible fork child', {
  suppressBroadcast: true,
  forkedFromSessionId: rootSession.id,
  parentSessionId: rootSession.id,
  rootSessionId: rootSession.id,
});
const managedSession = await sessionManager.createSession(join(tempHome, 'workspace'), 'missing-tool', 'Hidden worker', {
  suppressBroadcast: true,
  sessionPlane: 'organization',
  sessionClass: 'WORKER',
  organizationRootSessionId: rootSession.id,
  organizationId: org.id,
  organizationNodeId: 'node-route-worker',
  roleInstanceId: 'role-route-worker',
  organizationRevision: 1,
  controllerSessionId: rootSession.id,
  parentSessionId: rootSession.id,
});
const listed = await invokeSessionList();
equal(listed.status, 200, 'session list route succeeds with managed sessions present');
ok(
  listed.payload.sessions.some((session) => session.id === rootSession.id),
  'user-addressable root session remains in the session list',
);
ok(
  listed.payload.sessions.some((session) => session.id === forkChild.id),
  'user-addressable fork root remains in the root-only session list',
);
const listedFork = listed.payload.sessions.find((session) => session.id === forkChild.id);
equal(listedFork?.isRootSession, true, 'legacy fork metadata is projected as a root session');
equal(listedFork?.sessionHierarchy?.parentSessionId, null, 'legacy fork metadata has no hierarchy parent');
equal(listedFork?.isDelegatedSession, undefined, 'legacy fork metadata is not exposed as delegated');
equal(
  listed.payload.sessions.some((session) => session.id === managedSession.id),
  false,
  'non-user-addressable managed child session is omitted from the session list',
);

await sessionManager.killAll();

console.log(`test-organization-provisioning-route: ok (${assertions} assertions)`);
