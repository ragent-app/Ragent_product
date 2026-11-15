#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempHome = mkdtempSync(join(tmpdir(), 'ragent-autonomous-org-s15-'));
process.env.HOME = tempHome;
process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT = '1';
process.env.RAGENT_ORG_SESSION_ADDRESSABILITY_ENABLED = '1';
process.env.RAGENT_ORG_SCHEMA_ENABLED = '1';

const workspace = join(tempHome, 'workspace');
mkdirSync(workspace, { recursive: true });

const managedInput = await import('../chat/managed-input.mjs');
const manager = await import('../chat/session-manager.mjs');
const { handleSessionMainRoutes } = await import('../chat/router-session-main-routes.mjs');

const {
  MANAGED_SESSION_LINEAGE_INCOMPLETE,
  MANAGED_SESSION_INPUT_BYPASS,
  SESSION_NOT_USER_ADDRESSABLE,
  SESSION_CLASS_INVALID,
  assertManagedSessionLineage,
  assertUserAddressable,
  isManagedSessionClass,
  resolveSessionClass,
} = managedInput;
const { createSession, getSession, killAll } = manager;

let assertions = 0;
function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}
function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}
function throwsCode(fn, code, message) {
  assertions += 1;
  assert.throws(fn, (error) => error?.code === code, message);
}

// Pure class contract and compatibility rules.
equal(resolveSessionClass({ id: 'legacy-user', sessionPlane: 'user' }), 'ROOT_LEADERSHIP', 'legacy user projects to root leadership');
equal(resolveSessionClass({ id: 'legacy-delegated', sessionPlane: 'user', delegatedFromSessionId: 'parent' }), null, 'legacy delegated session is not upgraded');
equal(resolveSessionClass({ id: 'system', sessionPlane: 'system' }), null, 'system stays unclassified');
equal(isManagedSessionClass('manager'), true, 'managed class names are case-normalized');
throwsCode(
  () => resolveSessionClass({ id: 'bad', sessionPlane: 'organization', sessionClass: 'UNKNOWN' }),
  SESSION_CLASS_INVALID,
  'unknown managed class fails closed',
);
throwsCode(
  () => resolveSessionClass({ id: 'system-bad', sessionPlane: 'system', sessionClass: 'MANAGER' }),
  SESSION_CLASS_INVALID,
  'system cannot be forced into a managed class',
);
throwsCode(
  () => assertManagedSessionLineage({ id: 'missing', sessionPlane: 'organization', sessionClass: 'WORKER' }),
  MANAGED_SESSION_LINEAGE_INCOMPLETE,
  'managed lineage is required',
);
throwsCode(
  () => assertUserAddressable({ id: 'managed', sessionPlane: 'organization', sessionClass: 'MANAGER', userAddressable: false }, { force: true }),
  SESSION_NOT_USER_ADDRESSABLE,
  'managed sessions are not user-addressable',
);
assertUserAddressable({ id: 'root', sessionPlane: 'user', sessionClass: 'ROOT_LEADERSHIP', userAddressable: true }, { force: true });

const root = await createSession(workspace, 'missing-tool', 'S15 root', {});
equal(root.sessionClass, 'ROOT_LEADERSHIP', 'new user session defaults to root leadership');
equal(root.userAddressable, true, 'new user session is addressable');

await assert.rejects(
  () => createSession(workspace, 'missing-tool', 'Incomplete managed', {
    sessionPlane: 'organization',
    sessionClass: 'WORKER',
  }),
  (error) => error?.code === MANAGED_SESSION_LINEAGE_INCOMPLETE,
  'managed creation rejects incomplete lineage',
);

const managed = await createSession(workspace, 'missing-tool', 'S15 worker', {
  sessionPlane: 'organization',
  sessionClass: 'WORKER',
  organizationRootSessionId: root.id,
  organizationId: 'org_s15',
  organizationNodeId: 'node_s15',
  roleInstanceId: 'role_s15',
  organizationRevision: 1,
  controllerSessionId: root.id,
});
equal(managed.sessionClass, 'WORKER', 'managed class persists');
equal(managed.userAddressable, false, 'managed class is not addressable');
equal(managed.organizationNodeId, 'node_s15', 'managed lineage persists');
equal(managed.rootSessionId, root.id, 'managed root binding is exposed through the rootSessionId API semantic');
equal((await getSession(managed.id)).sessionClass, 'WORKER', 'managed class survives reload projection');

// The old route keeps S10's 409, while the new root route uses the public
// addressability 403 contract before trying to start a runner.
function responseProbe() {
  const state = { status: 0, payload: null };
  return {
    state,
    writeHead(status) { state.status = status; },
    end(body) {
      try { state.payload = JSON.parse(body); } catch { state.payload = body; }
    },
    setHeader() {},
  };
}
function requestProbe() {
  return { method: 'POST', headers: {}, on() {}, once() {} };
}
async function runMessageRoute(pathname) {
  const response = responseProbe();
  await handleSessionMainRoutes({
    req: requestProbe(),
    res: response,
    parsedUrl: { query: {} },
    pathname,
    authSession: { role: 'owner' },
    sessionGetRoute: null,
    createSessionSummaryRef: () => null,
    immutablePrivateEventCacheControl: 'private, no-store',
    isDirectoryPath: async () => true,
    readSessionMessagePayload: async () => ({ text: 'public message', requestId: `s15-${pathname}` }),
    requireSessionAccess: async () => true,
    isSessionVisibleToAuthSession: () => true,
    getAuthPrincipalId: () => 'owner',
    getAuthScopeAgentId: () => '',
    isAgentScopedAuthSession: () => false,
    resolveRequestedSessionAttachments: async () => [],
    writeJson: (res, status, payload) => {
      res.state.status = status;
      res.state.payload = payload;
    },
    writeJsonCached: () => {},
  });
  return response.state;
}

const oldRoute = await runMessageRoute(`/api/sessions/${managed.id}/messages`);
equal(oldRoute.status, 409, 'legacy managed message route keeps 409');
equal(oldRoute.payload?.code, MANAGED_SESSION_INPUT_BYPASS, 'legacy route keeps bypass code');
const rootRoute = await runMessageRoute(`/api/root-sessions/${managed.id}/messages`);
equal(rootRoute.status, 403, 'root route rejects non-addressable session');
equal(rootRoute.payload?.code, SESSION_NOT_USER_ADDRESSABLE, 'root route uses addressability code');

await killAll();
console.log(`test-autonomous-organization-s15: ok (${assertions} assertions)`);
