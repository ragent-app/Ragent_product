#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const normalizerUrl = pathToFileURL(join(repoRoot, 'chat', 'normalizer.mjs')).href;

// 1. Distinct normalizer module instances (simulating server restarts) produce unique event IDs.
const boot1 = await import(`${normalizerUrl}?boot=1`);
const boot2 = await import(`${normalizerUrl}?boot=2`);

const evt1a = boot1.messageEvent('assistant', 'hello');
const evt1b = boot1.toolUseEvent('bash', 'echo 1');
const evt1c = boot1.textDeltaEvent(0, 'chunk');
const evt2a = boot2.messageEvent('assistant', 'hello');
const evt2b = boot2.statusEvent('running');

assert.match(evt1a.id, /^evt_[a-f0-9]{12}_000001$/);
assert.match(evt1b.id, /^evt_[a-f0-9]{12}_000002$/);
assert.match(evt1c.id, /^evt_[a-f0-9]{12}_000003$/);
assert.match(evt2a.id, /^evt_[a-f0-9]{12}_000001$/);
assert.match(evt2b.id, /^evt_[a-f0-9]{12}_000002$/);

assert.notEqual(evt1a.id, evt2a.id, 'restarted normalizer instance must not reuse evt_..._000001');
assert.notEqual(evt1b.id, evt2b.id, 'restarted normalizer instance must not reuse evt_..._000002');
assert.equal(new Set([evt1a.id, evt1b.id, evt1c.id, evt2a.id, evt2b.id]).size, 5);

// 2. Real separate Node subprocesses (true process restarts) also never collide.
async function emitIdsInChildProcess() {
  const script = `
    import { messageEvent, textDeltaEvent, statusEvent } from ${JSON.stringify(normalizerUrl)};
    console.log(JSON.stringify([
      messageEvent('user', 'hi').id,
      textDeltaEvent(0, 'tok').id,
      statusEvent('completed').id,
    ]));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
  });
  return JSON.parse(stdout.trim());
}

const [process1Ids, process2Ids] = await Promise.all([
  emitIdsInChildProcess(),
  emitIdsInChildProcess(),
]);
assert.equal(process1Ids.length, 3);
assert.equal(process2Ids.length, 3);
assert.equal(
  new Set([...process1Ids, ...process2Ids]).size,
  6,
  'event IDs generated across two separate server processes must all be unique',
);

console.log('test-normalizer-event-ids: ok');
