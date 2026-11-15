#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isLoopbackAddress,
  isTunneledRequest,
  resolveChatBindHost,
  resolveSecureCookies,
  shouldUseLocalWebAuth,
} from '../lib/windows-local-runtime.mjs';
import { ensureWindowsOwnerAuth } from '../lib/windows-owner-auth-bootstrap.mjs';

assert.equal(isLoopbackAddress('127.0.0.1'), true);
assert.equal(isLoopbackAddress('::1'), true);
assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
assert.equal(isLoopbackAddress('192.168.1.20'), false);
assert.equal(resolveChatBindHost({ platform: 'win32', requestedHost: '0.0.0.0' }), '127.0.0.1');
assert.equal(resolveChatBindHost({ platform: 'linux', requestedHost: '0.0.0.0' }), '0.0.0.0');
assert.equal(resolveSecureCookies({ platform: 'win32' }), false);
assert.equal(resolveSecureCookies({ platform: 'linux' }), true);
assert.equal(resolveSecureCookies({ platform: 'win32', requested: '1' }), true);
assert.equal(resolveSecureCookies({ platform: 'linux', requested: '0' }), false);
assert.equal(shouldUseLocalWebAuth({ remoteAddress: '127.0.0.1', accept: 'text/html' }), true);
assert.equal(shouldUseLocalWebAuth({ remoteAddress: '192.168.1.20', accept: 'text/html' }), false);
assert.equal(shouldUseLocalWebAuth({ remoteAddress: '127.0.0.1', url: '/api/models', accept: 'text/html' }), false);
assert.equal(shouldUseLocalWebAuth({ remoteAddress: '127.0.0.1', accept: '*/*' }), false);
assert.equal(shouldUseLocalWebAuth({ remoteAddress: '127.0.0.1', accept: 'text/html', viaTunnel: true }), false);
assert.equal(shouldUseLocalWebAuth({ remoteAddress: '127.0.0.1', accept: 'text/html', viaTunnel: false }), true);
assert.equal(isTunneledRequest({ headers: { 'x-ragent-tunnel': '1' } }), true);
assert.equal(isTunneledRequest({ headers: { 'x-ragent-tunnel': '' } }), false);
assert.equal(isTunneledRequest({ headers: {} }), false);
assert.equal(isTunneledRequest({}), false);

const root = await mkdtemp(join(tmpdir(), 'ragent-windows-auth-'));
try {
  const authFile = join(root, 'config', 'auth.json');
  const created = await ensureWindowsOwnerAuth({
    authFile,
    platform: 'win32',
    username: 'installer-owner',
    password: 'installer-password-123',
  });
  assert.equal(created.created, true);
  assert.equal(created.auth.username, 'installer-owner');
  assert.equal(created.initialPassword, 'installer-password-123');
  assert.match(await readFile(authFile, 'utf8'), /passwordHash/);

  const existing = await ensureWindowsOwnerAuth({
    authFile,
    platform: 'win32',
    username: 'replacement',
    password: 'replacement-password-123',
  });
  assert.equal(existing.created, false);
  assert.equal(existing.auth.username, 'installer-owner');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('test-windows-local-runtime: ok (26 assertions)');
