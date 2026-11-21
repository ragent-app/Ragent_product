#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  canIssueCollaborationResumeRootSessionControl,
  canIssueSessionControl,
  canIssueSwarmRootWakeupSessionControl,
  createRunSessionControlCapability,
  createSessionControlAuthenticator,
  sessionControlOperation,
} from '../chat/session-control-capability.mjs';
import { createRagentHttpClient } from '../lib/ragent-http-client.mjs';
import { runSessionSpawnCommand } from '../lib/session-spawn-command.mjs';

const secret = 'session-control-test-secret';
const leadership = { sessionClass: 'ROOT_LEADERSHIP', sessionPlane: 'user' };
assert.equal(canIssueSessionControl({ principalKind: 'trusted_device', session: leadership }), true);
assert.equal(canIssueSessionControl({ principalKind: 'owner', session: leadership }), true);
assert.equal(canIssueSessionControl({ principalKind: 'guest', session: leadership }), false);
assert.equal(canIssueSessionControl({ principalKind: 'trusted_device', session: leadership, temporaryControlAuthority: {} }), false);
assert.equal(canIssueSessionControl({ principalKind: 'trusted_device', session: { ...leadership, delegatedFromSessionId: 'parent' } }), false);
assert.equal(canIssueSessionControl({ principalKind: 'trusted_device', session: leadership, internalOperation: 'internal' }), false);
assert.equal(canIssueSessionControl({ principalKind: 'trusted_device', session: leadership, internalOperation: 'swarm_wakeup' }), false);

const swarmLeadership = { id: 'root-swarm-sess', sessionClass: 'ROOT_LEADERSHIP', sessionPlane: 'user', userAddressable: true };
const activeSwarmOrg = { id: 'org-swarm-1', rootSessionId: 'root-swarm-sess', state: 'active', policy: { swarmEnabled: true } };
assert.equal(canIssueSwarmRootWakeupSessionControl({
  session: swarmLeadership,
  internalOperation: 'swarm_wakeup',
  internalOrganizationWakeup: true,
  organization: activeSwarmOrg,
}), true);

const collabRoot = { id: 'root-collab-sess', sessionClass: 'ROOT_LEADERSHIP', sessionPlane: 'user', userAddressable: true };
const activeFormalOrg = { id: 'org-formal-1', rootSessionId: 'root-collab-sess', state: 'active' };
const aggregatingOrgCollab = {
  id: 'collab-1',
  rootSessionId: 'root-collab-sess',
  state: 'aggregating',
  aggregationGeneration: 1,
  aggregationClaimedGeneration: 1,
  aggregationRunId: '',
  policy: { organizationId: 'org-formal-1' },
};
const validAggregationContext = {
  kind: 'collaboration_aggregation',
  collaborationId: 'collab-1',
  aggregationGeneration: 1,
};
assert.equal(canIssueCollaborationResumeRootSessionControl({
  session: collabRoot,
  internalOperation: 'collaboration_resume',
  collaboration: aggregatingOrgCollab,
  organization: activeFormalOrg,
  sourceContext: validAggregationContext,
  requestId: 'collaboration:collab-1:aggregation:1',
}), true);
assert.equal(canIssueCollaborationResumeRootSessionControl({
  session: collabRoot,
  internalOperation: 'collaboration_resume',
  collaboration: { ...aggregatingOrgCollab, policy: {} },
  sourceContext: validAggregationContext,
  requestId: 'collaboration:collab-1:aggregation:1',
}), true);
assert.equal(canIssueCollaborationResumeRootSessionControl({
  session: collabRoot,
  internalOperation: 'collaboration_resume',
  temporaryControlAuthority: { id: 'tmp' },
  collaboration: aggregatingOrgCollab,
  organization: activeFormalOrg,
}), false);
assert.equal(canIssueCollaborationResumeRootSessionControl({
  session: collabRoot,
  internalOperation: 'swarm_poll',
  collaboration: aggregatingOrgCollab,
  organization: activeFormalOrg,
}), false);
assert.equal(canIssueCollaborationResumeRootSessionControl({
  session: { ...collabRoot, sessionPlane: 'organization' },
  internalOperation: 'collaboration_resume',
  collaboration: aggregatingOrgCollab,
  organization: activeFormalOrg,
}), false);
assert.equal(canIssueCollaborationResumeRootSessionControl({
  session: { ...collabRoot, delegatedFromSessionId: 'other-root' },
  internalOperation: 'collaboration_resume',
  collaboration: aggregatingOrgCollab,
  organization: activeFormalOrg,
}), false);
assert.equal(canIssueCollaborationResumeRootSessionControl({
  session: collabRoot,
  internalOperation: 'collaboration_resume',
  collaboration: { ...aggregatingOrgCollab, state: 'running' },
  organization: activeFormalOrg,
}), false);
assert.equal(canIssueCollaborationResumeRootSessionControl({
  session: collabRoot,
  internalOperation: 'collaboration_resume',
  collaboration: { ...aggregatingOrgCollab, aggregationRunId: 'run-already-started' },
  organization: activeFormalOrg,
}), false);
assert.equal(canIssueCollaborationResumeRootSessionControl({
  session: collabRoot,
  internalOperation: 'collaboration_resume',
  collaboration: aggregatingOrgCollab,
  organization: { ...activeFormalOrg, state: 'archived' },
}), false);
assert.equal(canIssueCollaborationResumeRootSessionControl({
  session: collabRoot,
  internalOperation: 'collaboration_resume',
  collaboration: aggregatingOrgCollab,
  organization: { ...activeFormalOrg, rootSessionId: 'other-root' },
}), false);
assert.equal(canIssueCollaborationResumeRootSessionControl({
  session: collabRoot,
  internalOperation: 'collaboration_resume',
  collaboration: aggregatingOrgCollab,
  organization: activeFormalOrg,
  sourceContext: validAggregationContext,
  requestId: 'collaboration:collab-1:aggregation:2',
}), false);
assert.equal(canIssueSwarmRootWakeupSessionControl({
  session: swarmLeadership,
  internalOperation: 'swarm_wakeup',
  internalOrganizationWakeup: false,
  organization: activeSwarmOrg,
}), false);
assert.equal(canIssueSwarmRootWakeupSessionControl({
  session: swarmLeadership,
  internalOperation: 'other_internal',
  internalOrganizationWakeup: true,
  organization: activeSwarmOrg,
}), false);
assert.equal(canIssueSwarmRootWakeupSessionControl({
  session: swarmLeadership,
  internalOperation: 'swarm_wakeup',
  internalOrganizationWakeup: true,
  temporaryControlAuthority: { id: 'tc-1' },
  organization: activeSwarmOrg,
}), false);
assert.equal(canIssueSwarmRootWakeupSessionControl({
  session: { ...swarmLeadership, sessionPlane: 'organization' },
  internalOperation: 'swarm_wakeup',
  internalOrganizationWakeup: true,
  organization: activeSwarmOrg,
}), false);
assert.equal(canIssueSwarmRootWakeupSessionControl({
  session: swarmLeadership,
  internalOperation: 'swarm_wakeup',
  internalOrganizationWakeup: true,
  organization: { ...activeSwarmOrg, policy: { swarmEnabled: false } },
}), false);
assert.equal(canIssueSwarmRootWakeupSessionControl({
  session: swarmLeadership,
  internalOperation: 'swarm_wakeup',
  internalOrganizationWakeup: true,
  organization: { ...activeSwarmOrg, state: 'archived' },
}), false);
assert.equal(canIssueSwarmRootWakeupSessionControl({
  session: swarmLeadership,
  internalOperation: 'swarm_wakeup',
  internalOrganizationWakeup: true,
  organization: { ...activeSwarmOrg, rootSessionId: 'other-root' },
}), false);
const root = { id: 'root-session' };
const child = { id: 'child-session', delegatedFromSessionId: root.id };
const runs = new Map([
  ['root-run', { id: 'root-run', sessionId: root.id, state: 'running' }],
  ['child-run', { id: 'child-run', sessionId: child.id, state: 'running' }],
]);
const sessions = new Map([[root.id, root], [child.id, child]]);
const capability = createRunSessionControlCapability({
  runId: 'root-run',
  sessionId: root.id,
  turnId: 'turn-1',
  secret,
  now: Date.parse('2026-01-01T00:00:00.000Z'),
});
assert.ok(capability);

const authenticate = createSessionControlAuthenticator({
  secret,
  now: () => Date.parse('2026-01-01T00:01:00.000Z'),
  getRunImpl: async (id) => runs.get(id) || null,
  getRunManifestImpl: async (id) => id === 'root-run'
    ? {
      sessionId: root.id,
      options: { sessionControlChannel: { turnId: 'turn-1', tokenHash: capability.tokenHash } },
    }
    : null,
  getSessionImpl: async (id) => sessions.get(id) || null,
});

function headers(overrides = {}) {
  return {
    'x-ragent-session-control-token': capability.token,
    'x-ragent-session-control-run-id': capability.runId,
    'x-ragent-session-control-session-id': capability.sessionId,
    'x-ragent-session-control-turn-id': capability.turnId,
    ...overrides,
  };
}

const delegateAuth = await authenticate({
  method: 'POST',
  url: `/api/sessions/${root.id}/delegate`,
  headers: headers(),
});
assert.equal(delegateAuth?.surfaceMode, 'session_control');
assert.equal(delegateAuth?.capabilityOperation, 'session.delegate');
assert.equal(delegateAuth?.sessionId, root.id);

const childRunAuth = await authenticate({
  method: 'GET',
  url: '/api/runs/child-run',
  headers: headers(),
});
assert.equal(childRunAuth?.sessionId, child.id);
assert.equal(childRunAuth?.capabilityOperation, 'session.run.read');

const childEventsAuth = await authenticate({
  method: 'GET',
  url: `/api/sessions/${child.id}/events/4/body`,
  headers: headers(),
});
assert.equal(childEventsAuth?.sessionId, child.id);
assert.equal(childEventsAuth?.capabilityOperation, 'session.events.read');

const assetAuth = await authenticate({
  method: 'POST',
  url: `/api/sessions/${root.id}/assets`,
  headers: headers(),
});
assert.equal(assetAuth?.sessionId, root.id);
assert.equal(assetAuth?.capabilityOperation, 'session.asset.publish');

const rootToolsAuth = await authenticate({
  method: 'POST',
  url: `/api/sessions/${root.id}/organization/tools-root`,
  headers: headers(),
});
assert.equal(rootToolsAuth?.sessionId, root.id);
assert.equal(rootToolsAuth?.capabilityOperation, 'session.organization.tools');
assert.equal(await authenticate({
  method: 'POST',
  url: `/api/sessions/${root.id}/organization/tools`,
  headers: headers(),
}), null, 'root-scoped capability must not satisfy node organization.tools route');

const childAssistantMessageAuth = await authenticate({
  method: 'POST',
  url: `/api/sessions/${root.id}/assistant-messages`,
  headers: headers(),
});
assert.equal(childAssistantMessageAuth?.sessionId, root.id);
assert.equal(childAssistantMessageAuth?.capabilityOperation, 'session.assistant_message.publish');

for (const [method, url, operation] of [
  ['GET', '/api/auth/me', 'session.auth.read'],
  ['GET', '/api/triggers', 'session.trigger.read'],
  ['POST', '/api/triggers', 'session.trigger.create'],
  ['GET', '/api/triggers/trg_000000000000000000000001', 'session.trigger.read'],
  ['PATCH', '/api/triggers/trg_000000000000000000000001', 'session.trigger.update'],
  ['DELETE', '/api/triggers/trg_000000000000000000000001', 'session.trigger.delete'],
  ['GET', '/api/managed-processes', 'session.process.read'],
  ['GET', '/api/managed-processes/mp_000000000000000000000001', 'session.process.read'],
  ['POST', '/api/managed-processes/mp_000000000000000000000001/cancel', 'session.process.cancel'],
  ['POST', '/api/consultations', 'session.consultation.manage'],
  ['GET', '/api/consultations/round_000000000000000000000001', 'session.consultation.manage'],
  ['POST', '/api/consultations/round_000000000000000000000001/dispatch', 'session.consultation.manage'],
  ['POST', '/api/consultations/round_000000000000000000000001/decide', 'session.consultation.manage'],
  ['POST', '/api/consultations/round_000000000000000000000001/cancel', 'session.consultation.manage'],
  ['GET', '/api/consultations/round_000000000000000000000001/decisions', 'session.consultation.manage'],
]) {
  assert.equal(sessionControlOperation(url, method), operation, `${method} ${url} should map to ${operation}`);
  const auth = await authenticate({ method, url, headers: headers() });
  assert.equal(auth?.sessionId, root.id, `${method} ${url} should remain bound to the root session`);
  assert.equal(auth?.capabilityOperation, operation);
}

assert.equal(await authenticate({
  method: 'POST',
  url: `/api/sessions/${child.id}/assistant-messages`,
  headers: headers(),
}), null, 'the run token must not publish into a child session');

assert.equal(await authenticate({
  method: 'GET',
  url: '/api/agents',
  headers: headers(),
}), null, 'the run token must not authenticate unrelated API routes');
assert.equal(await authenticate({
  method: 'POST',
  url: '/api/sessions/other-session/assets',
  headers: headers(),
}), null, 'the run token must not publish into another session');
assert.equal(await authenticate({
  method: 'POST',
  url: `/api/sessions/${root.id}/delegate`,
  headers: headers({ 'x-ragent-session-control-turn-id': 'wrong-turn' }),
}), null, 'a stale turn must be rejected');
assert.equal(await authenticate({
  method: 'GET',
  url: '/api/runs/unknown-run',
  headers: headers(),
}), null, 'a run outside the root tree must be rejected');

const expiredAuthenticate = createSessionControlAuthenticator({
  secret,
  now: () => Date.parse('2026-01-01T00:16:00.000Z'),
  getRunImpl: async (id) => runs.get(id) || null,
  getRunManifestImpl: async (id) => id === 'root-run'
    ? {
      sessionId: root.id,
      options: { sessionControlChannel: { turnId: 'turn-1', tokenHash: capability.tokenHash } },
    }
    : null,
  getSessionImpl: async (id) => sessions.get(id) || null,
});
assert.equal(await expiredAuthenticate({
  method: 'POST',
  url: '/api/consultations',
  headers: headers(),
}), null, 'an expired run capability must be rejected for consultation control');

const originalFetch = globalThis.fetch;
const seen = [];
globalThis.fetch = async (_url, init = {}) => {
  seen.push({ ...init, headers: { ...(init.headers || {}) } });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
try {
  const client = createRagentHttpClient({
    baseUrl: 'http://127.0.0.1:7690',
    sessionControlToken: capability.token,
    sessionControlRunId: capability.runId,
    sessionControlSessionId: capability.sessionId,
    sessionControlTurnId: capability.turnId,
  });
  const result = await client.request(`/api/sessions/${root.id}/delegate`, {
    method: 'POST',
    body: { task: 'test' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(seen.length, 1);
  const requestHeaders = seen[0].headers;
  assert.equal(requestHeaders['x-ragent-session-control-token'], capability.token);
  assert.equal(requestHeaders['x-ragent-session-control-run-id'], capability.runId);
  assert.equal(requestHeaders.Authorization, undefined);
  assert.equal(requestHeaders.Cookie, undefined);

  const savedEnv = {
    RAGENT_SESSION_ID: process.env.RAGENT_SESSION_ID,
    RAGENT_SESSION_CONTROL_TOKEN: process.env.RAGENT_SESSION_CONTROL_TOKEN,
    RAGENT_SESSION_CONTROL_RUN_ID: process.env.RAGENT_SESSION_CONTROL_RUN_ID,
    RAGENT_SESSION_CONTROL_SESSION_ID: process.env.RAGENT_SESSION_CONTROL_SESSION_ID,
    RAGENT_SESSION_CONTROL_TURN_ID: process.env.RAGENT_SESSION_CONTROL_TURN_ID,
  };
  try {
    process.env.RAGENT_SESSION_ID = root.id;
    process.env.RAGENT_SESSION_CONTROL_TOKEN = capability.token;
    process.env.RAGENT_SESSION_CONTROL_RUN_ID = capability.runId;
    process.env.RAGENT_SESSION_CONTROL_SESSION_ID = capability.sessionId;
    process.env.RAGENT_SESSION_CONTROL_TURN_ID = capability.turnId;
    globalThis.fetch = async (url, init = {}) => {
      seen.push({ url, ...init, headers: { ...(init.headers || {}) } });
      if (String(url).includes('/delegate')) {
        return new Response(JSON.stringify({
          session: { id: child.id, name: 'Child' },
          run: { id: 'child-run' },
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('/api/runs/')) {
        return new Response(JSON.stringify({ run: { id: 'child-run', sessionId: child.id, state: 'completed' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ events: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const stdout = { value: '', write(value) { this.value += value; } };
    const stderr = { value: '', write(value) { this.value += value; } };
    assert.equal(await runSessionSpawnCommand([
      '--task', 'spawn through capability', '--wait', '--json', '--base-url', 'http://127.0.0.1:7690',
    ], { stdout, stderr }), 0);
    const spawnRequests = seen.slice(1);
    assert.ok(spawnRequests.length >= 3);
    for (const request of spawnRequests) {
      assert.equal(request.headers['x-ragent-session-control-token'], capability.token);
      assert.equal(request.headers.Authorization, undefined);
      assert.equal(request.headers.Cookie, undefined);
    }

    const envClient = createRagentHttpClient({ baseUrl: 'http://127.0.0.1:7690' });
    const envResult = await envClient.request(`/api/sessions/${root.id}/assets`, {
      method: 'POST',
      body: { localPath: '/tmp/generated.apk' },
    });
    assert.equal(envResult.response.status, 200);
    const envRequest = seen[seen.length - 1];
    assert.equal(envRequest.headers['x-ragent-session-control-token'], capability.token);
    assert.equal(envRequest.headers['x-ragent-session-control-run-id'], capability.runId);
    assert.equal(envRequest.headers['x-ragent-session-control-session-id'], capability.sessionId);
    assert.equal(envRequest.headers['x-ragent-session-control-turn-id'], capability.turnId);
    assert.equal(envRequest.headers.Authorization, undefined);
    assert.equal(envRequest.headers.Cookie, undefined);

    const collaborationClient = createRagentHttpClient({
      baseUrl: 'http://127.0.0.1:7690',
      capabilityToken: 'collaboration-read-token',
    });
    const collaborationResult = await collaborationClient.request('/api/collaborations');
    assert.equal(collaborationResult.response.status, 200);
    const collaborationRequest = seen[seen.length - 1];
    assert.equal(collaborationRequest.headers.Authorization, 'Bearer collaboration-read-token');
    assert.equal(collaborationRequest.headers['x-ragent-session-control-token'], undefined);
    assert.equal(collaborationRequest.headers.Cookie, undefined);
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('test-session-control-capability: ok');
