#!/usr/bin/env node
// DS-09 probe: compare dedup keys built from normalized (in-memory) events
// vs stored (index-file) events for one session, to verify whether a dedup
// index rebuilt from persisted history matches the keys of live delta
// candidates. Bodies under the inline limit are stored verbatim in the index
// (keys match); bodies above it are externalized with a clipped preview
// (keys diverge — the rebuilt index only approximates the live key universe,
// and noteDedupKeysSeen re-adds exact keys as events persist). Uses a
// throwaway instance dir; prints nothing sensitive.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'ds09-probe-'));
process.env.RAGENT_CONFIG_DIR = tmp;
process.env.RAGENT_MEMORY_DIR = join(tmp, 'memory');
process.env.RAGENT_INSTANCE_ROOT = tmp;

const { appendEvent, loadHistory } = await import('../chat/history.mjs');
const { getProviderEventDedupKey } = await import('../chat/provider-event-dedup.mjs');

const normalizedMessage = {
  type: 'message', role: 'assistant', runId: 'run-1',
  providerMessageId: 'msg-1', content: 'Hello world, this is a fairly long assistant message body.',
};
const normalizedTool = {
  type: 'tool_use', role: 'assistant', runId: 'run-1',
  providerToolUseId: 'tool-1', toolName: 'Bash',
  toolInput: '{"command":"node -e \\"for (let i=0;i<100;i++) console.log(i)\\"","args":[]}',
};

await appendEvent('sess-probe', normalizedMessage);
await appendEvent('sess-probe', normalizedTool);

const stored = await loadHistory('sess-probe', { includeBodies: false });
const storedMessage = stored.find((e) => e.type === 'message');
const storedTool = stored.find((e) => e.type === 'tool_use');

console.log('stored message fields:', JSON.stringify({ content: storedMessage.content, bodyPreview: storedMessage.bodyPreview, bodyRef: storedMessage.bodyRef, bodyField: storedMessage.bodyField, bodyAvailable: storedMessage.bodyAvailable }));
console.log('stored tool fields:', JSON.stringify({ content: storedTool.toolInput?.slice?.(0, 20), bodyPreview: storedTool.bodyPreview, bodyRef: storedTool.bodyRef }));
console.log('normalized message key :', getProviderEventDedupKey(normalizedMessage));
console.log('stored      message key :', getProviderEventDedupKey(storedMessage));
console.log('keys equal (message)   :', getProviderEventDedupKey(normalizedMessage) === getProviderEventDedupKey(storedMessage));
console.log('normalized tool key    :', getProviderEventDedupKey(normalizedTool));
console.log('stored      tool key   :', getProviderEventDedupKey(storedTool));
console.log('keys equal (tool)      :', getProviderEventDedupKey(normalizedTool) === getProviderEventDedupKey(storedTool));

rmSync(tmp, { recursive: true, force: true });
