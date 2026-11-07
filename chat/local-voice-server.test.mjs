import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLocalVoiceServer } from './local-voice-server.mjs';

test('repeated enable requests share an in-progress Whisper startup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-local-voice-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'whisper-server.exe');
  const model = join(root, 'ggml-base-q5_1.bin');
  await writeFile(executable, 'test executable');
  await writeFile(model, 'test model');

  let signalPortRequested;
  const portRequested = new Promise(resolve => { signalPortRequested = resolve; });
  let releasePort;
  let spawnCount = 0;
  class Child extends EventEmitter {
    exitCode = null;
    signalCode = null;
    kill() {
      this.exitCode = 0;
      this.emit('close', 0, null);
    }
  }

  const server = createLocalVoiceServer({
    executable,
    model,
    reservePort: () => {
      signalPortRequested();
      return new Promise(resolve => { releasePort = () => resolve(43127); });
    },
    spawnImpl: () => { spawnCount += 1; return new Child(); },
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => 'whisper.cpp' },
      text: async () => '',
    }),
    startupTimeoutMs: 5_000,
    retryIntervalMs: 60_000,
  });
  t.after(() => server.dispose());

  const firstEnable = server.setEnabled(true);
  await portRequested;
  const repeatedEnable = server.setEnabled(true);
  releasePort();

  await Promise.all([firstEnable, repeatedEnable]);
  assert.equal(spawnCount, 1);
  assert.equal(server.isRunning(), true);
  assert.equal(server.isReady(), true);
});
