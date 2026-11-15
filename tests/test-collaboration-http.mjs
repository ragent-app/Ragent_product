#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-collaboration-http-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const { handleCollaborationRoutes } = await import('../chat/router-collaboration-routes.mjs');

const calls = [];
const record = {
  id: 'collab-http-1',
  rootSessionId: 'root-http-1',
  state: 'failed',
  tasks: [],
  attempts: [],
};
const completedRecord = {
  id: 'collab-completed',
  rootSessionId: 'root-http-2',
  state: 'completed',
  tasks: [],
  attempts: [],
};

const orchestrator = {
  list: async () => [record],
  get: async (id) => (id === completedRecord.id ? completedRecord : record),
  dispatch: async (input) => {
    calls.push(['dispatch', input]);
    return record;
  },
  validate: async (input) => {
    calls.push(['validate', input]);
    return { valid: true, rootSessionId: input.rootSessionId, plan: input.plan };
  },
  cancel: async (id, reason) => {
    calls.push(['cancel', id, reason]);
    return true;
  },
  retry: async (id, reason) => {
    calls.push(['retry', id, reason]);
    if (id === completedRecord.id) {
      const error = new Error('Collaboration is completed and cannot be retried');
      error.code = 'COLLABORATION_NOT_RETRYABLE';
      throw error;
    }
    return { retried: 1, collaboration: { ...record, state: 'running' } };
  },
};

async function invoke(method, pathname, body, role = 'owner') {
  const response = {};
  await handleCollaborationRoutes({
    req: { method },
    res: response,
    pathname,
    authSession: { role },
    readBody: async () => (body === undefined ? '' : JSON.stringify(body)),
    requireSessionAccess: async () => true,
    writeJson: (res, status, payload) => {
      res.status = status;
      res.payload = payload;
    },
    orchestrator,
  });
  return response;
}

async function invokeWithAuth(method, pathname, body, authSession) {
  const response = {};
  await handleCollaborationRoutes({
    req: { method },
    res: response,
    pathname,
    authSession,
    readBody: async () => (body === undefined ? '' : JSON.stringify(body)),
    requireSessionAccess: async () => true,
    writeJson: (res, status, payload) => {
      res.status = status;
      res.payload = payload;
    },
    orchestrator,
  });
  return response;
}

const list = await invoke('GET', '/api/collaborations');
assert.equal(list.status, 200);
assert.deepEqual(list.payload.collaborations, [record]);

const denied = await invoke('GET', '/api/collaborations', undefined, 'agent');
assert.equal(denied.status, 403);

const created = await invoke('POST', '/api/collaborations', {
  rootSessionId: 'root-http-1',
  title: 'HTTP collaboration',
  idempotencyKey: 'http-key',
  plan: { tasks: [{ id: 'task-http', objective: 'test', agentId: 'agent-http' }] },
});
assert.equal(created.status, 201);
assert.equal(calls.at(-1)[0], 'dispatch');
assert.equal(calls.at(-1)[1].idempotencyKey, 'http-key');

const validated = await invoke('POST', '/api/collaborations/validate', {
  rootSessionId: 'root-http-1',
  title: 'Validate before dispatch',
  plan: { tasks: [{ id: 'task-validate', objective: 'test', agentId: 'agent-http' }] },
});
assert.equal(validated.status, 200);
assert.equal(validated.payload.validation.valid, true);
assert.equal(calls.at(-1)[0], 'validate');

const dispatchedValidated = await invoke('POST', '/api/collaborations/dispatch-validated', {
  validationId: validated.payload.validation.validationId,
});
assert.equal(dispatchedValidated.status, 201);
assert.equal(dispatchedValidated.payload.collaboration.id, record.id);
assert.equal(calls.at(-1)[0], 'dispatch');

const retried = await invoke('POST', '/api/collaborations/collab-http-1/retry', { reason: 'owner retry' });
assert.equal(retried.status, 200);
assert.equal(retried.payload.retried, 1);
assert.deepEqual(calls.at(-1), ['retry', 'collab-http-1', 'owner retry']);

const retryTerminal = await invoke('POST', '/api/collaborations/collab-completed/retry', { reason: 'owner retry' });
assert.equal(retryTerminal.status, 409);
assert.equal(retryTerminal.payload.code, 'COLLABORATION_NOT_RETRYABLE');

const cancelled = await invoke('POST', '/api/collaborations/collab-http-1/cancel', { reason: 'stop now' });
assert.equal(cancelled.status, 200);
assert.deepEqual(calls.at(-1), ['cancel', 'collab-http-1', 'stop now']);

const childReadCapability = {
  role: 'runner',
  principalKind: 'run_capability',
  capabilityOperation: 'collaboration.read',
  resourceType: 'collaboration',
  resourceId: record.id,
  rootSessionId: record.rootSessionId,
};
const capabilityList = await invokeWithAuth('GET', '/api/collaborations', undefined, childReadCapability);
assert.equal(capabilityList.status, 200);
assert.deepEqual(capabilityList.payload.collaborations, [record], 'child read capability sees only its collaboration');
const capabilityCreate = await invokeWithAuth('POST', '/api/collaborations', {
  rootSessionId: record.rootSessionId,
  plan: {},
}, childReadCapability);
assert.equal(capabilityCreate.status, 403, 'child read capability cannot create');
const capabilityDispatch = await invokeWithAuth('POST', `/api/collaborations/${record.id}/dispatch`, {}, childReadCapability);
assert.equal(capabilityDispatch.status, 403, 'child read capability cannot dispatch');
const capabilityOther = await invokeWithAuth('GET', `/api/collaborations/${completedRecord.id}`, undefined, childReadCapability);
assert.equal(capabilityOther.status, 403, 'child capability cannot read another collaboration');

console.log('test-collaboration-http: ok');
rmSync(configDir, { recursive: true, force: true });
