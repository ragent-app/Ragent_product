import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'ragent-tool-range-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, '.ragent', 'memory');
await mkdir(process.env.RAGENT_CONFIG_DIR, { recursive: true });

const { appendEvent, loadHistory } = await import('../chat/history.mjs');
const { createToolResultDescriptor, readHistoryToolResultRange } = await import('../chat/tool-result-descriptor.mjs');

const raw = `${'compiler diagnostic line\n'.repeat(600)}first failure at file.js:12`;
const sessionId = 'tool-range-session';
await appendEvent(sessionId, {
  type: 'tool_result',
  toolExecutionId: 'tool-range-1',
  toolName: 'npm test',
  output: raw,
  exitCode: 1,
});
const indexed = await loadHistory(sessionId, { includeBodies: false });
const descriptor = createToolResultDescriptor(indexed[0], { sessionId });
assert.ok(descriptor.rawOutputRef);
assert.equal(descriptor.rawOutputRef.kind, 'history_body');
assert.equal(descriptor.outputSha256, undefined);

const range = await readHistoryToolResultRange({
  sessionId,
  descriptor,
  startByte: 0,
  endByte: 80,
});
assert.equal(range.text, raw.slice(0, 80));
assert.equal(range.sha256.startsWith('sha256:'), true);
assert.equal(range.truncated, true);

console.log('test-tool-result-history-range: ok');
