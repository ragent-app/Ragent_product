import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { retireCodexBrokerAndAcquireHome } from '../chat/codex-broker-retirement.mjs';
import { acquireNativeOAuthLock, nativeOAuthLockPath } from '../lib/provider-runtime/oauth-lock.mjs';

test('missing broker still requires exclusive credential ownership', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-retire-client-'));
  t.after(async () => {
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const absent = () => {
    const socket = new EventEmitter(); socket.destroy = () => {};
    setImmediate(() => socket.emit('error', Object.assign(new Error('absent'), { code: 'ENOENT' })));
    return socket;
  };
  const lock = await retireCodexBrokerAndAcquireHome({ homeRoot: root, accountId: 'verified-account', timeoutMs: 500, connectImpl: absent });
  try {
    await assert.rejects(acquireNativeOAuthLock(nativeOAuthLockPath(root), { waitMs: 40, pollMs: 10 }), { code: 'NATIVE_OAUTH_LOCK_TIMEOUT' });
  } finally { await lock.release(); }
  const unsupported = () => {
    const socket = new EventEmitter(); socket.destroy = () => {};
    socket.write = () => setImmediate(() => socket.emit('data', Buffer.from('{"unexpected":true}\n')));
    setImmediate(() => socket.emit('connect'));
    return socket;
  };
  await assert.rejects(retireCodexBrokerAndAcquireHome({ homeRoot: root, accountId: 'verified-account', timeoutMs: 500, connectImpl: unsupported }), { code: 'CODEX_RETIRE_PROTOCOL' });
});
