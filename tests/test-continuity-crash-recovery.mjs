import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-continuity-crash-'));
const moduleUrl = new URL('../chat/continuity-store.mjs', import.meta.url).href;
const worker = spawn(process.execPath, ['--input-type=module', '-e', `
  import { createContinuityStore } from ${JSON.stringify(moduleUrl)};
  const store = createContinuityStore({ historyDir: process.env.TEST_HISTORY_DIR });
  await store.write('crash-session', {
    schemaVersion: 1, sessionId: 'crash-session', revision: 1,
    coverage: { coveredThroughSeq: 1, eventDigest: 'sha256:test', omittedRanges: [] },
    objective: { raw: 'durable', sourceSeq: 1 }, status: 'ready', completion: null,
    decisions: [], files: [], validations: [], blockers: [], nextAction: null,
    requiredUserInput: null, execution: { activeRunId: null, lastRunId: 'run-1', provider: null },
  }, { expectedRevision: 0 });
  process.stdout.write('checkpoint-written\\n');
  setTimeout(() => {}, 60_000);
`], { env: { ...process.env, TEST_HISTORY_DIR: root } });
let output = '';
worker.stdout.on('data', (chunk) => { output += chunk.toString(); });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('crash worker did not write checkpoint')), 10_000);
  worker.stdout.on('data', () => {
    if (output.includes('checkpoint-written')) { clearTimeout(timer); resolve(); }
  });
  worker.once('error', reject);
});
worker.kill('SIGKILL');
await once(worker, 'exit');

const reader = spawn(process.execPath, ['--input-type=module', '-e', `
  import { createContinuityStore } from ${JSON.stringify(moduleUrl)};
  const store = createContinuityStore({ historyDir: process.env.TEST_HISTORY_DIR });
  const checkpoint = await store.read('crash-session');
  if (checkpoint?.revision !== 1 || checkpoint.coverage.coveredThroughSeq !== 1) process.exit(2);
  process.stdout.write('recovered\\n');
`], { env: { ...process.env, TEST_HISTORY_DIR: root } });
let recovered = '';
reader.stdout.on('data', (chunk) => { recovered += chunk.toString(); });
const [code] = await once(reader, 'exit');
assert.equal(code, 0);
assert.match(recovered, /recovered/);
await rm(root, { recursive: true, force: true });
console.log('test-continuity-crash-recovery: ok');
