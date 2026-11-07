import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalVoiceServer } from '../chat/local-voice-server.mjs';

function wav(samples = 8_000) {
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16_000, 24); audio.writeUInt32LE(32_000, 28); audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}

const root = await mkdtemp(join(tmpdir(), 'agentoc-local-voice-server-'));
try {
  const executable = join(root, 'whisper-server.exe');
  const model = join(root, 'ggml-base.bin');
  await writeFile(executable, 'test-runtime');
  await writeFile(model, 'test-model');
  let starts = 0, kills = 0, request;
  let child;
  const transcriber = createLocalVoiceServer({ executable, model, reservePort: async () => 49321,
    spawnImpl: (file, args, options) => {
      starts++;
      assert.equal(file, executable);
      assert.deepEqual(args.slice(0, 4), ['--host', '127.0.0.1', '--port', '49321']);
      assert.ok(args.includes('--no-gpu'));
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      child = new EventEmitter();
      child.exitCode = null; child.signalCode = null;
      child.kill = () => { kills++; child.exitCode = 0; child.emit('close', 0, null); return true; };
      return child;
    },
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/')) return { status: 200, headers: { get: name => name === 'server' ? 'whisper.cpp' : '' }, text: async () => '' };
      request = { url, options };
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('language'), 'auto');
      assert.equal(options.body.get('response_format'), 'json');
      assert.equal(options.body.get('file').name, 'ragent-voice.wav');
      return { ok: true, status: 200, json: async () => ({ text: '识别结果' }) };
    },
    retryIntervalMs: 300_000,
  });
  assert.equal(await transcriber.isInstalled(), true);
  assert.equal(transcriber.isRunning(), false);
  await assert.rejects(transcriber.transcribe(wav()), { code: 'VOICE_DISABLED' });
  assert.equal(starts, 0);
  await transcriber.setEnabled(true);
  assert.equal(starts, 1);
  assert.equal(transcriber.isRunning(), true);
  assert.equal(transcriber.isReady(), true);
  assert.equal(await transcriber.isAvailable(), true);
  assert.equal(await transcriber.transcribe(wav()), '识别结果');
  assert.equal(request.url, 'http://127.0.0.1:49321/inference');
  assert.ok(request.options.signal instanceof AbortSignal);
  await transcriber.setEnabled(false);
  assert.equal(kills, 1);
  assert.equal(transcriber.isRunning(), false);
  assert.equal(transcriber.isReady(), false);
  assert.equal(await transcriber.isAvailable(), false);
  await transcriber.dispose();
  console.log('local voice resident server opt-in and lifecycle: PASS');
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
