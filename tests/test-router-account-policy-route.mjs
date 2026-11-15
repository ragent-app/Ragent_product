#!/usr/bin/env node
// Route-level contract coverage for the account-level permission policy.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-account-policy-route-'));
const configDir = join(root, 'config');
process.env.HOME = root;
process.env.RAGENT_CONFIG_DIR = configDir;
delete process.env.RAGENT_INSTANCE_ROOT;
await mkdir(configDir, { recursive: true });
await writeFile(join(configDir, 'auth.json'), JSON.stringify({
  username: 'testowner',
  passwordHash: 'not-a-real-hash',
}), 'utf8');

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(body = '') {
      this.body = body;
    },
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function jsonRequest(method, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const stream = new PassThrough();
  stream.end(body);
  return {
    method,
    headers: body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {},
    on(name, listener) {
      stream.on(name, listener);
      return this;
    },
    destroy() {
      stream.destroy();
    },
  };
}

async function callPolicyRoute(method, authSession, payload) {
  const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
  const response = makeResponse();
  const handled = await handleControlRoutes({
    req: jsonRequest(method, payload),
    res: response,
    parsedUrl: { pathname: '/api/account-policy', query: new URLSearchParams() },
    pathname: '/api/account-policy',
    authSession,
    writeJson,
    writeJsonCached: (_req, res, body) => writeJson(res, 200, body),
  });
  assert.equal(handled, true);
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
}

try {
  const { loadAccountPolicy } = await import('../lib/account-policy.mjs');

  // Visitors can neither read nor write the account policy.
  const visitorRead = await callPolicyRoute('GET', { role: 'visitor' });
  assert.equal(visitorRead.status, 403);
  const visitorWrite = await callPolicyRoute('PATCH', { role: 'visitor' }, { permissionPolicy: 'full-auto' });
  assert.equal(visitorWrite.status, 403);

  // Unset default.
  const initial = await callPolicyRoute('GET', { role: 'owner' });
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.policy, { permissionPolicy: '', updatedAt: '' });

  // Owner sets the account-wide mode.
  const patched = await callPolicyRoute('PATCH', { role: 'owner' }, { permissionPolicy: 'full-auto' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.policy.permissionPolicy, 'full-auto');
  assert.equal((await loadAccountPolicy()).permissionPolicy, 'full-auto');

  const reread = await callPolicyRoute('GET', { role: 'owner' });
  assert.equal(reread.body.policy.permissionPolicy, 'full-auto');

  const conservative = await callPolicyRoute('PATCH', { role: 'owner' }, { permissionPolicy: 'conservative-auto' });
  assert.equal(conservative.status, 200);
  assert.equal(conservative.body.policy.permissionPolicy, 'conservative-auto');

  // Clearing back to the built-in default is a first-class state.
  const cleared = await callPolicyRoute('PATCH', { role: 'owner' }, { permissionPolicy: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.policy.permissionPolicy, '');
  assert.equal((await loadAccountPolicy()).permissionPolicy, '');

  // Unknown modes are rejected and leave the stored policy untouched.
  await callPolicyRoute('PATCH', { role: 'owner' }, { permissionPolicy: 'approval' });
  const invalid = await callPolicyRoute('PATCH', { role: 'owner' }, { permissionPolicy: 'unrestricted' });
  assert.equal(invalid.status, 400);
  assert.equal((await loadAccountPolicy()).permissionPolicy, 'approval');

  console.log('test-router-account-policy-route: ok');
} finally {
  // No persistent state outside the temp root is touched.
}

console.log('done');
