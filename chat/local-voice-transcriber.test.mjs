import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createLocalVoiceTranscriber, normalizeLocalVoiceLanguage } from './local-voice-transcriber.mjs';

function wav() {
  const audio = Buffer.alloc(44 + 16_000 * 2);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVE', 8); audio.write('fmt ', 12); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16_000, 24); audio.writeUInt32LE(32_000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}

test('language normalization accepts all Ragent language codes and rejects unknown values', () => {
  for (const language of ['auto', 'en', 'zh', 'ja', 'ko', 'fr', 'es', 'de', 'ru', 'pt', 'haw']) {
    assert.equal(normalizeLocalVoiceLanguage(language), language);
  }
  assert.throws(() => normalizeLocalVoiceLanguage('zzz'), { code: 'VOICE_LANGUAGE_INVALID' });
});

test('Windows whisper.cpp receives the requested speech language', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-local-voice-transcriber-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'whisper.exe');
  const model = join(root, 'model.bin');
  await writeFile(executable, 'test binary');
  await writeFile(model, 'test model');

  let childArgs;
  const transcriber = createLocalVoiceTranscriber({
    executable,
    model,
    timeoutMs: 5000,
    spawnImpl: (_binary, args) => {
      childArgs = args;
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.stdin = new PassThrough();
      child.stdin.resume();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stderr.resume();
      child.stdin.on('finish', () => {
        child.stdout.end('recognized Korean speech', () => {
          child.exitCode = 0;
          child.emit('close', 0, null);
        });
      });
      child.kill = () => { child.exitCode = 1; child.emit('close', 1, null); };
      return child;
    },
  });

  assert.equal(await transcriber.transcribe(wav(), { language: 'ko' }), 'recognized Korean speech');
  assert.deepEqual(childArgs.slice(childArgs.indexOf('--language'), childArgs.indexOf('--language') + 2), ['--language', 'ko']);
});
