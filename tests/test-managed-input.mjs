#!/usr/bin/env node
// S10 Managed Input enforcement — rejection matrix for the five input-bypass
// surfaces (fork / fork-at / delegate / session-spawn / message) plus the
// controlled Task -> Attempt -> child Session injection exemption.
//
// The main process runs with RAGENT_MANAGED_INPUT_ENFORCEMENT=1 so the
// rejection matrix and the HTTP-layer continuation rejection are exercised
// in-process. Flag-off behavior is verified with subprocess probes (config is
// read once at module load, so the default-off baseline cannot be tested in
// the same process as flag-on).
import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-managed-input-'));
const probeHome = mkdtempSync(join(tmpdir(), 'ragent-managed-input-probe-'));

// Isolate config + session storage before importing anything that reads it.
process.env.HOME = tempHome;
delete process.env.RAGENT_CONFIG_DIR;
delete process.env.RAGENT_INSTANCE_ROOT;
delete process.env.RAGENT_WORK_ROOT_DIR;
delete process.env.RAGENT_MEMORY_DIR;
delete process.env.RAGENT_RUN_SPOOL_DIR;
delete process.env.RAGENT_ORG_SCHEMA_ENABLED;
delete process.env.RAGENT_ORG_SHADOW_PROJECTION;
// Main process: flag ON for the rejection matrix.
process.env.RAGENT_MANAGED_INPUT_ENFORCEMENT = '1';

const workspace = join(tempHome, 'workspace');
mkdirSync(workspace, { recursive: true });

const managedInput = await import('../chat/managed-input.mjs');
const sessionManager = await import('../chat/session-manager.mjs');
const {
  handleSessionMainRoutes,
  resolveAuthenticatedTurnPrincipalKind,
} = await import('../chat/router-session-main-routes.mjs');
const { MANAGED_INPUT_ENFORCEMENT } = await import('../lib/config.mjs');

const {
  createSession,
  delegateSession,
  forkSession,
  forkSessionAt,
  getSession,
  killAll,
} = sessionManager;

const managedInputUrl = new URL('../chat/managed-input.mjs', import.meta.url).href;

let assertionCount = 0;
const a = new Proxy(assert, {
  get(target, prop) {
    const value = target[prop];
    if (typeof value === 'function') {
      return (...args) => {
        assertionCount += 1;
        return value.apply(target, args);
      };
    }
    return value;
  },
});

function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of ['RAGENT_MANAGED_INPUT_ENFORCEMENT']) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runProbe(script, overrides = {}) {
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: childEnv(overrides),
    encoding: 'utf8',
  });
  return out.trim();
}

function probeManagedScript() {
  return `
    import {
      MANAGED_SESSION_INPUT_BYPASS,
      assertManagedInputAllowed,
      isManagedSession,
    } from ${JSON.stringify(managedInputUrl)};
    const managed = { id: 'probe-m', sessionPlane: 'organization' };
    const user = { id: 'probe-u', sessionPlane: 'user' };
    if (!isManagedSession(managed)) throw new Error('probe: isManagedSession(managed) expected true');
    if (isManagedSession(user)) throw new Error('probe: isManagedSession(user) expected false');
    for (const op of ['fork', 'fork-at', 'delegate', 'session-spawn', 'message', 'continuation']) {
      let threw = false;
      try { assertManagedInputAllowed({ session: managed, operation: op }); }
      catch (e) { threw = e.code === MANAGED_SESSION_INPUT_BYPASS && e.statusCode === 409; }
      if (!threw) throw new Error('probe: expected MANAGED_SESSION_INPUT_BYPASS(409) for ' + op);
    }
    assertManagedInputAllowed({ session: managed, operation: 'message', requestContext: { internalOperation: 'collaboration_task' } });
    assertManagedInputAllowed({ session: managed, operation: 'continuation', requestContext: { internalOperation: 'collaboration_resume' } });
    assertManagedInputAllowed({ session: user, operation: 'fork' });
    console.log('PROBE_ON_OK');
  `;
}

function probeFlagOffScript() {
  return `
    import {
      MANAGED_SESSION_INPUT_BYPASS,
      assertManagedInputAllowed,
      isManagedSession,
    } from ${JSON.stringify(managedInputUrl)};
    const managed = { id: 'probe-m', sessionPlane: 'organization' };
    if (!isManagedSession(managed)) throw new Error('probe-off: isManagedSession expected true');
    for (const op of ['fork', 'fork-at', 'delegate', 'session-spawn', 'message', 'continuation']) {
      let threw = false;
      try { assertManagedInputAllowed({ session: managed, operation: op }); }
      catch (e) { threw = e.code === MANAGED_SESSION_INPUT_BYPASS; }
      if (threw) throw new Error('probe-off: flag off must not reject ' + op);
    }
    console.log('PROBE_OFF_OK');
  `;
}

// ---------------------------------------------------------------------------
// Pure gate: isManagedSession / parseManagedInputBypassRoute
// ---------------------------------------------------------------------------

function testIsManagedSession() {
  a.equal(managedInput.isManagedSession({ id: 'm', sessionPlane: 'organization' }), true, 'organization plane is managed');
  a.equal(managedInput.isManagedSession({ id: 'u', sessionPlane: 'user' }), false, 'user plane is not managed');
  a.equal(managedInput.isManagedSession({ id: 's', sessionPlane: 'system' }), false, 'system plane is not managed');
  a.equal(managedInput.isManagedSession({ id: 'x' }), false, 'missing plane is not managed');
  a.equal(managedInput.isManagedSession(null), false, 'null session is not managed');
  a.equal(managedInput.isManagedSession(undefined), false, 'undefined session is not managed');
  a.equal(managedInput.isManagedSession({}), false, 'empty session is not managed');
}

function testParseManagedInputBypassRoute() {
  a.deepEqual(
    managedInput.parseManagedInputBypassRoute('/api/sessions/sess-1/fork'),
    { sessionId: 'sess-1', operation: 'fork' },
    'fork route parsed',
  );
  a.deepEqual(
    managedInput.parseManagedInputBypassRoute('/api/sessions/sess-1/fork-at'),
    { sessionId: 'sess-1', operation: 'fork-at' },
    'fork-at route parsed',
  );
  a.deepEqual(
    managedInput.parseManagedInputBypassRoute('/api/sessions/sess-1/delegate'),
    { sessionId: 'sess-1', operation: 'delegate' },
    'delegate route parsed (session-spawn CLI posts here)',
  );
  a.equal(managedInput.parseManagedInputBypassRoute('/api/sessions/sess-1/messages'), null, 'messages is not a router-layer bypass route');
  a.equal(managedInput.parseManagedInputBypassRoute('/api/sessions/sess-1'), null, 'bare session path is not a bypass route');
  a.equal(managedInput.parseManagedInputBypassRoute('/api/projects/x/fork'), null, 'other paths are not bypass routes');
  a.equal(managedInput.parseManagedInputBypassRoute(null), null, 'null pathname is not a bypass route');
  a.equal(managedInput.parseManagedInputBypassRoute(''), null, 'empty pathname is not a bypass route');
}

// ---------------------------------------------------------------------------
// Pure gate: flag ON rejection matrix + controlled-channel exemption
// ---------------------------------------------------------------------------

function expectBypass(session, operation, requestContext) {
  a.throws(
    () => managedInput.assertManagedInputAllowed({ session, operation, requestContext }),
    (error) => {
      a.equal(error.code, 'MANAGED_SESSION_INPUT_BYPASS', `${operation} code`);
      a.equal(error.statusCode, 409, `${operation} HTTP 409 semantics`);
      return error.code === 'MANAGED_SESSION_INPUT_BYPASS' && error.statusCode === 409;
    },
    `${operation} on managed session must reject`,
  );
}

function testGateFlagOnMatrix() {
  const managed = { id: 'sess-m', sessionPlane: 'organization' };
  const user = { id: 'sess-u', sessionPlane: 'user' };

  // managed + every bypass operation -> MANAGED_SESSION_INPUT_BYPASS (409)
  for (const op of ['fork', 'fork-at', 'delegate', 'session-spawn', 'message', 'continuation']) {
    expectBypass(managed, op);
  }

  // non-managed (user plane) -> pass for every operation
  for (const op of ['fork', 'fork-at', 'delegate', 'session-spawn', 'message', 'continuation']) {
    a.doesNotThrow(
      () => managedInput.assertManagedInputAllowed({ session: user, operation: op }),
      `user-plane ${op} passes`,
    );
  }

  // null / undefined session -> pass
  a.doesNotThrow(() => managedInput.assertManagedInputAllowed({ session: null, operation: 'fork' }), 'null session passes');
  a.doesNotThrow(() => managedInput.assertManagedInputAllowed({ session: undefined, operation: 'message' }), 'undefined session passes');

  // controlled-channel internal injection -> pass
  a.doesNotThrow(
    () => managedInput.assertManagedInputAllowed({
      session: managed,
      operation: 'message',
      requestContext: { internalOperation: 'collaboration_task' },
    }),
    'managed message with collaboration_task internalOperation passes (controlled channel)',
  );
  a.doesNotThrow(
    () => managedInput.assertManagedInputAllowed({
      session: managed,
      operation: 'continuation',
      requestContext: { internalOperation: 'collaboration_resume' },
    }),
    'managed continuation with collaboration_resume internalOperation passes',
  );

  // the internalOperation exemption is scoped to message/continuation: a
  // creation-type bypass still rejects even when an internalOperation marker
  // is present (the orchestrator creates children via createSession directly).
  expectBypass(managed, 'fork', { internalOperation: 'collaboration_task' });
  expectBypass(managed, 'delegate', { internalOperation: 'collaboration_task' });
}

// ---------------------------------------------------------------------------
// Function-level enforcement (real session manager, flag ON in-process)
// ---------------------------------------------------------------------------

async function testFunctionLevelEnforcement() {
  const managed = await createSession(workspace, 'claude', 'managed-s10', {
    sessionPlane: 'organization',
  });
  a.ok(managed?.id, 'managed session created');
  const managedReloaded = await getSession(managed.id);
  a.equal(managedReloaded.sessionPlane, 'organization', 'managed sessionPlane persists');

  const user = await createSession(workspace, 'claude', 'user-s10', {});
  a.ok(user?.id, 'user session created');

  // fork / fork-at / delegate on a managed session -> MANAGED_SESSION_INPUT_BYPASS
  await a.rejects(
    () => forkSession(managed.id),
    (error) => error.code === 'MANAGED_SESSION_INPUT_BYPASS',
    'forkSession on managed session rejects',
  );
  await a.rejects(
    () => forkSessionAt(managed.id, { anchorSeq: 1, mode: 'assistant-continue' }),
    (error) => error.code === 'MANAGED_SESSION_INPUT_BYPASS',
    'forkSessionAt on managed session rejects',
  );
  await a.rejects(
    () => delegateSession(managed.id, { task: 'bypass' }),
    (error) => error.code === 'MANAGED_SESSION_INPUT_BYPASS',
    'delegateSession on managed session rejects',
  );

  // user-plane sessions are NOT rejected by the managed-input gate (they may
  // proceed or fail for unrelated reasons, but never with the bypass code).
  let userForkBypass = false;
  try {
    await forkSession(user.id);
  } catch (error) {
    userForkBypass = error?.code === 'MANAGED_SESSION_INPUT_BYPASS';
  }
  a.equal(userForkBypass, false, 'user-plane fork is not a managed bypass');

  let userDelegateBypass = false;
  try {
    await delegateSession(user.id, { task: 'ok' });
  } catch (error) {
    userDelegateBypass = error?.code === 'MANAGED_SESSION_INPUT_BYPASS';
  }
  a.equal(userDelegateBypass, false, 'user-plane delegate is not a managed bypass');

  return { managed, user };
}

// ---------------------------------------------------------------------------
// HTTP-layer continuation rejection (handleSessionMainRoutes, flag ON)
// ---------------------------------------------------------------------------

async function invokeSessionMessages(sessionId, text) {
  const response = {};
  const pathname = `/api/sessions/${sessionId}/messages`;
  await handleSessionMainRoutes({
    req: { method: 'POST', url: pathname },
    res: response,
    parsedUrl: { pathname, query: {}, searchParams: new URLSearchParams() },
    pathname,
    authSession: { role: 'owner' },
    sessionGetRoute: null,
    createSessionSummaryRef: null,
    immutablePrivateEventCacheControl: null,
    isDirectoryPath: async () => true,
    readSessionMessagePayload: async () => JSON.stringify({ text }),
    requireSessionAccess: async () => true,
    isSessionVisibleToAuthSession: async () => true,
    getAuthPrincipalId: async () => 'principal-s10',
    getAuthScopeAgentId: async () => '',
    isAgentScopedAuthSession: async () => false,
    resolveRequestedSessionAttachments: async () => {
      throw new Error('must not reach attachment resolution for a rejected bypass');
    },
    writeJson: (res, status, payload) => {
      res.status = status;
      res.payload = payload;
    },
    writeJsonCached: () => {
      throw new Error('must not reach cached write for a rejected bypass');
    },
  });
  return response;
}

async function testMessagesContinuationHttp(managed) {
  const response = await invokeSessionMessages(managed.id, 'hi there');
  a.equal(response.status, 409, 'managed continuation returns HTTP 409');
  a.equal(response.payload?.code, 'MANAGED_SESSION_INPUT_BYPASS', 'managed continuation carries the contract code');
}

// ---------------------------------------------------------------------------
// Subprocess probes (flag baseline)
// ---------------------------------------------------------------------------

function testFlagOnProbe() {
  const out = runProbe(probeManagedScript(), { RAGENT_MANAGED_INPUT_ENFORCEMENT: '1' });
  a.ok(out.includes('PROBE_ON_OK'), 'flag-on subprocess probe passes');
}

function testFlagOffProbe() {
  const out = runProbe(probeFlagOffScript(), { RAGENT_MANAGED_INPUT_ENFORCEMENT: undefined });
  a.ok(out.includes('PROBE_OFF_OK'), 'flag-off subprocess probe passes (default behavior unchanged)');
}

// ---------------------------------------------------------------------------

try {
  a.equal(MANAGED_INPUT_ENFORCEMENT, true, 'main process runs with flag ON');
  a.equal(resolveAuthenticatedTurnPrincipalKind({ role: 'owner' }), 'owner', 'ordinary owner cookie resolves to owner turn');
  a.equal(resolveAuthenticatedTurnPrincipalKind({ role: 'owner', principalKind: 'trusted_device' }), 'trusted_device', 'trusted device is not upgraded to an ordinary owner turn');
  a.equal(resolveAuthenticatedTurnPrincipalKind({ role: 'visitor', principalKind: 'agent_guest' }), 'agent_guest', 'agent-scoped principal remains non-owner');
  testIsManagedSession();
  testParseManagedInputBypassRoute();
  testGateFlagOnMatrix();
  const sessions = await testFunctionLevelEnforcement();
  await testMessagesContinuationHttp(sessions.managed);
  testFlagOnProbe();
  testFlagOffProbe();
  console.log(`test-managed-input: ok (${assertionCount} assertions)`);
} finally {
  killAll();
  rmSync(probeHome, { recursive: true, force: true });
  rmSync(tempHome, { recursive: true, force: true });
}
