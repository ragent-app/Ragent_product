#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  createRunCollaborationCapabilities,
  collaborationCapabilityOperationsForRun,
  createCollaborationCapabilityAuthenticator,
  collaborationCapabilityOperation,
  verifyCollaborationCapabilityToken,
} = await import('../chat/collaboration-capability.mjs');
const { resolveSessionCollaborationPolicy } = await import('../chat/collaboration-policy.mjs');
const { openCapabilityGrantStore } = await import('../chat/capability-grant-store.mjs');

const secret = 'test-collaboration-capability-secret';
const now = Date.parse('2026-08-13T12:00:00.000Z');
const run = { id: 'run_collab_123', sessionId: 'sess_root_123', state: 'running' };
const manifest = { requestId: 'turn_123', options: {} };

assert.equal(collaborationCapabilityOperation('/api/collaborations', 'GET'), 'collaboration.read');
assert.equal(collaborationCapabilityOperation('/api/collaborations/c1/dispatch', 'POST'), 'collaboration.dispatch');
assert.equal(collaborationCapabilityOperation('/api/collaborations/c1', 'DELETE'), '');

assert.deepEqual(
  collaborationCapabilityOperationsForRun({
    policy: { role: 'manager', canDelegate: true },
  }),
  ['collaboration.read', 'collaboration.create', 'collaboration.dispatch', 'collaboration.retry', 'collaboration.cancel'],
  'server-approved manager policy receives the full collaboration surface',
);
assert.deepEqual(
  collaborationCapabilityOperationsForRun({
    policy: { role: 'specialist', canDelegate: false },
  }),
  [],
  'specialist runs receive no collaboration control capability',
);
assert.deepEqual(
  collaborationCapabilityOperationsForRun({
    internalOperation: 'collaboration_task',
    policy: { role: 'manager', canDelegate: true },
  }),
  ['collaboration.read'],
  'child collaboration runs remain read-only even if their Agent metadata says manager',
);
const rootPolicy = resolveSessionCollaborationPolicy({
  sessionClass: 'ROOT_LEADERSHIP',
  sessionPlane: 'user',
  userAddressable: true,
});
assert.equal(rootPolicy.role, 'manager');
assert.equal(rootPolicy.canDelegate, true);
assert.equal(resolveSessionCollaborationPolicy({
  sessionClass: 'ROOT_LEADERSHIP',
  sessionPlane: 'user',
  userAddressable: true,
  templateId: 'welcome-agent',
  agentId: 'welcome-agent',
}).canDelegate, true, 'root capability is not lost to retained entry metadata');
assert.equal(resolveSessionCollaborationPolicy({
  sessionClass: 'ROOT_LEADERSHIP',
  sessionPlane: 'user',
  userAddressable: true,
  delegatedFromSessionId: 'parent',
}).role, 'specialist');

const set = createRunCollaborationCapabilities({
  runId: run.id,
  sessionId: run.sessionId,
  turnId: manifest.requestId,
  resourceType: 'collaboration',
  resourceId: 'collab_123',
  rootSessionId: run.sessionId,
  secret,
  now,
  ttlMs: 60_000,
});
assert.ok(set?.capabilities?.length === 5);
const dispatch = set.capabilities.find((entry) => entry.operation === 'collaboration.dispatch');
assert.ok(dispatch?.token);
assert.equal(verifyCollaborationCapabilityToken(dispatch.token, {
  secret,
  operation: 'collaboration.dispatch',
  now,
})?.grantId, dispatch.grantId);
assert.equal(verifyCollaborationCapabilityToken(dispatch.token, {
  secret,
  operation: 'collaboration.cancel',
  now,
}), null, 'a capability cannot be widened to another operation');
assert.equal(verifyCollaborationCapabilityToken(dispatch.token, {
  secret: 'wrong-secret',
  operation: 'collaboration.dispatch',
  now,
}), null, 'forged signatures must fail closed');

const usageDir = await mkdtemp(join(tmpdir(), 'ragent-collaboration-capability-'));
const store = openCapabilityGrantStore({ dir: usageDir });
manifest.options.collaborationCapabilities = set.capabilities;
const authenticate = createCollaborationCapabilityAuthenticator({
  secret,
  store,
  now: () => now,
  getRunImpl: async (id) => id === run.id ? run : null,
  getRunManifestImpl: async (id) => id === run.id ? manifest : null,
});

function request(pathname, token, nonce, method = 'POST') {
  return {
    method,
    url: pathname,
    headers: {
      authorization: `Bearer ${token}`,
      'x-ragent-capability-use-nonce': nonce,
    },
  };
}

const first = await authenticate(request('/api/collaborations/collab_123/dispatch', dispatch.token, 'use-1'));
assert.equal(first?.principalKind, 'run_capability');
assert.equal(first.resourceType, 'collaboration');
assert.equal(first.resourceId, 'collab_123');

const replay = await authenticate(request('/api/collaborations/collab_123/dispatch', dispatch.token, 'use-1'));
assert.equal(replay, null, 'the durable per-use nonce must reject replay');
assert.equal(await authenticate(request('/api/collaborations/other/dispatch', dispatch.token, 'use-2')), null,
  'the capability resource must match the URL resource');
assert.equal(await authenticate(request('/api/sessions/sess_root_123/messages', dispatch.token, 'use-3')), null,
  'the collaboration capability must not authenticate another API surface');

store.close();
console.log('test-collaboration-capability: ok');
