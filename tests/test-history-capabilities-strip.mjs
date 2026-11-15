#!/usr/bin/env node
// Phase 2 of the providerCapabilities persistence shrink: the history persist
// boundary must drop the per-event providerCapabilities clone (authority is
// the run record; read paths enrich it back). Verifies appendEvent/appendEvents
// write field-free events while preserving every other event field.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-history-capabilities-'));

process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(tempHome, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(tempHome, 'workspace');
delete process.env.RAGENT_INSTANCE_ROOT;

const history = await import(
  pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href
);

const SESSION_ID = 'a'.repeat(32);
const CAPABILITIES = {
  supportsInterrupt: false,
  supportsSteer: true,
  supportsExternalUsageProjection: true,
  runtimeFamily: 'codex',
  provider: 'zen',
};

try {
  // Single append: capabilities dropped, other fields kept.
  const stored = await history.appendEvent(SESSION_ID, {
    type: 'tool_use',
    id: 'evt_single',
    timestamp: 1785000000000,
    runId: 'run_test_1',
    provider: 'zen',
    runtimeFamily: 'codex',
    providerCapabilities: CAPABILITIES,
    providerItemId: 'item_1',
    name: 'bash',
  });
  assert.equal(stored.providerCapabilities, undefined, 'appendEvent must not return providerCapabilities');
  assert.equal(stored.type, 'tool_use');
  assert.equal(stored.runId, 'run_test_1');
  assert.equal(stored.providerItemId, 'item_1');
  assert.equal(stored.seq, 1);

  // Batch append: every event stripped individually.
  const batched = await history.appendEvents(SESSION_ID, [
    {
      type: 'status',
      id: 'evt_batch_1',
      timestamp: 1785000001000,
      runId: 'run_test_1',
      providerCapabilities: CAPABILITIES,
      status: 'running',
    },
    {
      type: 'tool_use',
      id: 'evt_batch_2',
      timestamp: 1785000002000,
      runId: 'run_test_1',
      providerCapabilities: CAPABILITIES,
      providerItemId: 'item_2',
    },
  ]);
  assert.equal(batched.length, 2);
  for (const event of batched) {
    assert.equal(event.providerCapabilities, undefined, 'appendEvents must strip providerCapabilities');
  }
  assert.equal(batched[0].status, 'running');
  assert.equal(batched[1].providerItemId, 'item_2');

  // Events without the field pass through untouched (plus a null value is
  // stripped too — an explicit null is still dead weight).
  const plain = await history.appendEvent(SESSION_ID, {
    type: 'message',
    id: 'evt_plain',
    timestamp: 1785000003000,
    role: 'user',
    content: 'hello',
  });
  assert.equal(plain.providerCapabilities, undefined);
  assert.equal(plain.content, 'hello');
  const nulled = await history.appendEvent(SESSION_ID, {
    type: 'message',
    id: 'evt_null',
    timestamp: 1785000004000,
    role: 'assistant',
    content: 'world',
    providerCapabilities: null,
  });
  assert.equal(nulled.providerCapabilities, undefined, 'explicit null capabilities must also be stripped');
  assert.equal(nulled.content, 'world');

  // Read-back paths (loadHistory / readEventsAfter) see field-free events.
  const loaded = await history.loadHistory(SESSION_ID, { includeBodies: true });
  assert.equal(loaded.length, 5);
  for (const event of loaded) {
    assert.equal(event.providerCapabilities, undefined, 'read back events must not carry providerCapabilities');
    assert.ok(Number.isInteger(event.seq), `seq preserved: ${event.seq}`);
  }

  console.log('PASS test-history-capabilities-strip (persist boundary strips providerCapabilities, fields preserved)');
} finally {
  await history.removeSessionHistory(SESSION_ID).catch(() => {});
  rmSync(tempHome, { recursive: true, force: true });
}
