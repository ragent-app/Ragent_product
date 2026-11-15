import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { handleWindowsBrokerInternalRoutes } from '../chat/router-windows-broker-internal-routes.mjs';
import { WINDOWS_BROKER_TARGET_ID } from '../chat/windows-privileged-broker.mjs';

const token = 'run-only-secret';
const binding = { sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1', requestKey: 'retry-1' };
const manifest = { sessionId: binding.sessionId, requestId: binding.turnId, options: {
  authenticatedPrincipalKind: 'owner',
  windowsBrokerChannel: { turnId: binding.turnId, tokenHash: createHash('sha256').update(token).digest('hex') },
} };
const proposals = [];
const client = {
  async propose(input) { proposals.push(input); return { type: 'result', status: 'awaiting_device' }; },
  async status(requestId) { return { type: 'result', requestId, status: 'succeeded' }; },
};

async function call({ method = 'POST', payload = binding, query, address = '127.0.0.1', secret = token,
  run = { id: binding.runId, sessionId: binding.sessionId, state: 'running' }, riskMode = 'full-auto',
  runManifest = manifest, platform = 'win32', validateOwnerDevice } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.socket = { remoteAddress: address };
  req.headers = { 'x-ragent-windows-broker-token': secret };
  req.url = `/api/internal/windows-broker/service-restart?${query || new URLSearchParams(payload)}`;
  if (method === 'POST') queueMicrotask(() => req.end(JSON.stringify(payload)));
  const res = { setHeader() {} };
  let output;
  const handled = await handleWindowsBrokerInternalRoutes({
    req, res, pathname: '/api/internal/windows-broker/service-restart',
    getRun: async () => run, getRunManifest: async () => runManifest,
    getSession: async () => ({ riskMode, privilegedMode: true }), resolveSessionRiskMode: (session) => session.riskMode,
    brokerClient: client, platform, ...(validateOwnerDevice ? { validateOwnerDevice } : {}),
    writeJson(_res, status, body) { output = { status, body }; },
  });
  assert.equal(handled, true);
  return output;
}

const proposed = await call();
assert.equal(proposed.status, 200);
assert.equal(proposed.body.status, 'awaiting_device');
assert.equal(proposals.length, 1);
assert.equal(proposals[0].operation, 'service.restart');
assert.equal(proposals[0].targetId, WINDOWS_BROKER_TARGET_ID);
assert.equal(proposals[0].runId, binding.runId);
assert.equal((await call()).body.requestId, proposed.body.requestId);
assert.equal((await call({ method: 'GET' })).body.status, 'succeeded');
assert.equal((await call({ method: 'GET', riskMode: 'conservative-auto',
  run: { id: binding.runId, sessionId: binding.sessionId, state: 'completed' } })).body.status, 'succeeded');
assert.equal(proposals.length, 2);

for (const input of [
  { secret: 'wrong', code: 'BROKER_RUN_BINDING_INVALID' },
  { address: '192.0.2.10', code: 'BROKER_RUN_LOCAL_ONLY' },
  { payload: { ...binding, runId: 'another-run' }, code: 'BROKER_RUN_BINDING_INVALID' },
  { payload: { ...binding, turnId: 'another-turn' }, code: 'BROKER_RUN_BINDING_INVALID' },
  { payload: { ...binding, operation: 'shell.execute' }, code: 'BROKER_RUN_REQUEST_INVALID' },
  { riskMode: 'conservative-auto', code: 'BROKER_PERMISSION_PROFILE_DENIED' },
  { run: { id: binding.runId, sessionId: binding.sessionId, state: 'completed' }, code: 'BROKER_RUN_TERMINAL' },
  { run: { id: binding.runId, sessionId: binding.sessionId, state: 'preparing' }, code: 'BROKER_RUN_TERMINAL' },
  { runManifest: { ...manifest, options: { ...manifest.options, authenticatedPrincipalKind: 'temporary' } }, code: 'BROKER_RUN_BINDING_INVALID' },
  { platform: 'linux', code: 'BROKER_PLATFORM_UNSUPPORTED' },
]) {
  const { code, ...options } = input;
  const response = await call(options);
  assert.equal(response.body.code, code);
  assert.notEqual(response.status, 200);
}
assert.equal(proposals.length, 2, 'denied requests must not reach Broker');
const pairedManifest = { ...manifest, options: { ...manifest.options, authenticatedPrincipalKind: 'trusted_device',
  windowsBrokerChannel: { ...manifest.options.windowsBrokerChannel, windowsOwnerDevice: { deviceId: 'paired' } } } };
assert.equal((await call({ runManifest: pairedManifest, validateOwnerDevice: async () => true })).status, 200);
assert.equal((await call({ runManifest: pairedManifest, validateOwnerDevice: async () => false })).body.code, 'BROKER_RUN_BINDING_INVALID');
assert.equal((await call({ runManifest: { ...pairedManifest, options: { ...pairedManifest.options, temporaryControlAuthority: {} } },
  validateOwnerDevice: async () => true })).body.code, 'BROKER_RUN_BINDING_INVALID');
let checks = 0;
assert.equal((await call({ runManifest: pairedManifest, validateOwnerDevice: async () => ++checks === 1 })).body.code, 'BROKER_RUN_BINDING_INVALID');
const duplicateStatus = await call({ method: 'GET', query: `${new URLSearchParams(binding)}&requestKey=other` });
assert.equal(duplicateStatus.status, 400);
assert.equal(duplicateStatus.body.code, 'BROKER_RUN_REQUEST_INVALID');

const routerSource = await readFile(resolve('chat/router.mjs'), 'utf8');
const managerSource = await readFile(resolve('chat/session-manager.mjs'), 'utf8');
const sidecarSource = await readFile(resolve('chat/runner-sidecar.mjs'), 'utf8');
assert.match(routerSource, /handleWindowsBrokerInternalRoutes\(\{/);
assert.match(managerSource, /authenticatedPrincipalKind === 'owner'[\s\S]*?windowsBrokerToken/);
assert.match(managerSource, /windowsBrokerChannel \} : \{\}/);
assert.match(sidecarSource, /ragent-windows-broker-mcp\.mjs/);
assert.match(sidecarSource, /server\.name === serverNamesByKind\.get\('broker'\)/);
console.log('Windows Broker Run channel tests passed');
