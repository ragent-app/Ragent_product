import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexAppServerThreadMessage, buildCodexAppServerTurnStartMessage } from '../chat/codex-app-server-protocol.mjs';

test('turn inherits its thread named profile without legacy sandbox overrides', () => {
  const namedPermissionProfile = 'ragent_read';
  const namedPermissionConfig = { filesystem: { ':root': 'read', '/private': 'deny' }, network: { enabled: false } };
  const thread = buildCodexAppServerThreadMessage({ cwd: '/workspace', namedPermissionProfile, namedPermissionConfig });
  assert.equal(thread.params.permissions, namedPermissionProfile);
  assert.deepEqual(thread.params.config['permissions.ragent_read'], namedPermissionConfig);
  assert.equal(Object.hasOwn(thread.params, 'sandbox'), false);
  const turn = buildCodexAppServerTurnStartMessage({ threadId: 'fixture', text: 'hello', namedPermissionProfile });
  assert.equal(Object.hasOwn(turn.params, 'permissions'), false);
  assert.equal(Object.hasOwn(turn.params, 'sandboxPolicy'), false);
});

test('profile names and inline configuration fail closed', () => {
  for (const value of [':danger-full-access', '../other', {}, 'UPPER', '']) {
    if (value === '') continue;
    assert.throws(() => buildCodexAppServerThreadMessage({ namedPermissionProfile: value }), TypeError);
    assert.throws(() => buildCodexAppServerTurnStartMessage({ namedPermissionProfile: value }), TypeError);
  }
  assert.throws(() => buildCodexAppServerThreadMessage({ namedPermissionConfig: {} }), TypeError);
  assert.throws(() => buildCodexAppServerThreadMessage({ namedPermissionProfile: 'ragent_read', namedPermissionConfig: [] }), TypeError);
  const ordinary = buildCodexAppServerThreadMessage({});
  assert.equal(Object.hasOwn(ordinary.params, 'permissions'), false);
  assert.ok(ordinary.params.sandbox);
});
