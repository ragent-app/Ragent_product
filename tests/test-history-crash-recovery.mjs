import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-history-crash-'));
const sessionId = 'history-crash-session';
const historyRoot = join(root, 'chat-history', sessionId, 'events');
await mkdir(historyRoot, { recursive: true });
const historyModuleUrl = new URL('../chat/history.mjs', import.meta.url).href;
const first = spawn(process.execPath, ['--input-type=module', '-e', `
  const history = await import(${JSON.stringify(historyModuleUrl)});
  await history.appendEvent(${JSON.stringify(sessionId)}, { type: 'message', role: 'user', content: 'first' });
`], { env: { ...process.env, RAGENT_CONFIG_DIR: root } });
assert.equal((await new Promise((resolve) => first.once('exit', resolve))), 0);
await writeFile(join(historyRoot, '000000002.json'), JSON.stringify({
  seq: 2, type: 'status', content: 'orphan event', timestamp: Date.now(),
}));

const second = spawn(process.execPath, ['--input-type=module', '-e', `
  const history = await import(${JSON.stringify(historyModuleUrl)});
  const before = await history.getHistorySnapshot(${JSON.stringify(sessionId)});
  await history.appendEvent(${JSON.stringify(sessionId)}, { type: 'status', content: 'after restart' });
  const events = await history.readEventsAfter(${JSON.stringify(sessionId)}, 0, { includeBodies: true });
  process.stdout.write(JSON.stringify({ before, seqs: events.map((event) => event.seq), contents: events.map((event) => event.content) }));
`], { env: { ...process.env, RAGENT_CONFIG_DIR: root } });
let output = '';
second.stdout.on('data', (chunk) => { output += chunk.toString(); });
const [code] = await new Promise((resolve) => second.once('exit', (...args) => resolve(args)));
assert.equal(code, 0);
const result = JSON.parse(output);
assert.equal(result.before.latestSeq, 2);
assert.deepEqual(result.seqs, [1, 2, 3]);
assert.deepEqual(result.contents, ['first', 'orphan event', 'after restart']);
await rm(root, { recursive: true, force: true });
console.log('test-history-crash-recovery: ok');
