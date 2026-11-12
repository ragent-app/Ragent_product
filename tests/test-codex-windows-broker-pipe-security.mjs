import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { secureWindowsCodexBrokerPipe } from '../chat/codex-windows-broker-pipe-security.mjs';

const pipe = '\\\\.\\pipe\\agentoc-codex-0123456789abcdef0123456789abcdef';
const options = { platform: 'win32', serviceMode: true, executable: 'host.exe' };

test('only a fixed Codex pipe and positive kernel server PID reach the helper', async () => {
  for (const [name, pid] of [['\\\\.\\pipe\\other', 10], [pipe, 0], [pipe, 1.5]]) {
    await assert.rejects(secureWindowsCodexBrokerPipe(name, pid, { ...options, spawnImpl() { throw Error('unexpected'); } }),
      { code: 'CODEX_BROKER_PIPE_SECURITY_INVALID' });
  }
  let calls = 0;
  await secureWindowsCodexBrokerPipe(pipe, 42, { ...options, spawnImpl(file, args) {
    calls++;
    assert.equal(file, 'host.exe');
    assert.deepEqual(args, ['--codex-broker-pipe-security', 'agentoc-codex-0123456789abcdef0123456789abcdef', '42']);
    const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0)); return child;
  } });
  assert.equal(calls, 1);
});

test('service helper errors fail closed and other platforms do not invoke it', async () => {
  const spawnImpl = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 1)); return child; };
  await assert.rejects(secureWindowsCodexBrokerPipe(pipe, 42, { ...options, spawnImpl }),
    { code: 'CODEX_BROKER_PIPE_SECURITY_FAILED' });
  await secureWindowsCodexBrokerPipe(pipe, 42, { ...options, platform: 'linux', spawnImpl() { throw Error('unexpected'); } });
  await secureWindowsCodexBrokerPipe(pipe, 42, { ...options, serviceMode: false, spawnImpl() { throw Error('unexpected'); } });
});
