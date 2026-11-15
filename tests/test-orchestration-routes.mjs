#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const configDir = mkdtempSync(join(tmpdir(), 'ragent-orchestration-routes-'));
process.env.RAGENT_CONFIG_DIR = configDir;

const store = await import('../chat/orchestration-store.mjs');
const { handleOrchestrationRoutes } = await import('../chat/router-orchestration-routes.mjs');

function response() {
  return {
    status: 0,
    payload: null,
  };
}

function writeJson(res, status, payload) {
  res.status = status;
  res.payload = payload;
}

async function invoke({ method = 'GET', pathname, query = {}, authSession = { role: 'owner' } }) {
  const res = response();
  const handled = await handleOrchestrationRoutes({
    req: { method }, res, pathname, query, authSession, writeJson,
  });
  assert.equal(handled, true);
  return res;
}

try {
  const execution = await store.ensureExecution({
    scopeKind: 'collaboration',
    scopeId: 'collaboration-route-1',
    rootSessionId: 'root-route-1',
    kind: 'collaboration',
    state: 'running',
    spec: { title: 'Route test' },
  });
  const listed = await invoke({ pathname: '/api/orchestrations', query: { rootSessionId: 'root-route-1' } });
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.executions.length, 1);
  const fetched = await invoke({ pathname: `/api/orchestrations/${execution.id}` });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.payload.execution.id, execution.id);
  const forbidden = await invoke({ pathname: '/api/orchestrations', authSession: { role: 'agent' } });
  assert.equal(forbidden.status, 403);
  const missing = await invoke({ pathname: '/api/orchestrations/exec_missing' });
  assert.equal(missing.status, 404);
  const method = await invoke({ method: 'POST', pathname: '/api/orchestrations' });
  assert.equal(method.status, 405);
  console.log('test-orchestration-routes: ok');
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
