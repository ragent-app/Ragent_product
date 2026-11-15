#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-events-capabilities-'));

process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(tempHome, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(tempHome, 'workspace');
delete process.env.RAGENT_INSTANCE_ROOT;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const { createSession, getSessionEventsAfter, getSessionEventsPage, killAll } = sessionManager;
const history = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
const { appendEvent } = history;
const runs = await import(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href);
const { createRun } = runs;

const CAPABILITIES = {
  provider: 'zen',
  runtimeFamily: 'codex',
  supportsExternalUsageProjection: true,
  useResponsesLite: false,
};

try {
  const session = await createSession(tempHome, 'codex', 'Capabilities enrichment test');
  const run = await createRun({
    status: {
      provider: 'zen',
      runtimeFamily: 'codex',
      providerCapabilities: CAPABILITIES,
    },
    manifest: { tool: 'codex' },
  });
  const otherRun = await createRun({
    status: { provider: 'zen', runtimeFamily: 'codex' },
    manifest: { tool: 'codex' },
  });

  // Events persisted WITHOUT providerCapabilities (post-phase-2 shape) plus one
  // pre-existing embedded copy and a stale run reference.
  await appendEvent(session.id, { type: 'run_event', runId: run.id, payload: 'a' });
  await appendEvent(session.id, { type: 'text_delta', runId: run.id, delta: 'hi' });
  await appendEvent(session.id, { type: 'message', role: 'user', text: 'plain' });
  await appendEvent(session.id, {
    type: 'run_event',
    runId: otherRun.id,
    payload: 'b',
    providerCapabilities: { provider: 'legacy', runtimeFamily: 'codex' },
  });
  await appendEvent(session.id, { type: 'run_event', runId: 'missing-run-id', payload: 'c' });

  const events = await getSessionEventsAfter(session.id, 0);
  const bySeq = new Map(events.map((event) => [event.seq, event]));

  const enriched = bySeq.get(1);
  assert.deepEqual(
    enriched.providerCapabilities,
    CAPABILITIES,
    'run event without embedded capabilities should be enriched from the run record',
  );

  const delta = bySeq.get(2);
  assert.equal(delta.type, 'text_delta');
  assert.equal(delta.providerCapabilities, undefined, 'text_delta must not be enriched');

  const plain = bySeq.get(3);
  assert.equal(plain.providerCapabilities, undefined, 'events without runId must not be enriched');

  const embedded = bySeq.get(4);
  // Post-phase-2 shape: the persist boundary strips the embedded copy, so even
  // an append that supplied one lands field-free; enrichment serves the run
  // record's value (here: none — otherRun has no capabilities), never the
  // stripped input.
  assert.equal(embedded.providerCapabilities, undefined, 'run without a capabilities record must not fabricate');

  const missingRun = bySeq.get(5);
  assert.equal(missingRun.providerCapabilities, undefined, 'missing run record must not fail or fabricate');

  // Paginated read path behaves the same.
  const page = await getSessionEventsPage(session.id, { limit: 50 });
  const pagedRunEvent = page.events.find((event) => event.payload === 'a');
  assert.ok(pagedRunEvent, 'paginated read should include the run event');
  assert.deepEqual(
    pagedRunEvent.providerCapabilities,
    CAPABILITIES,
    'paginated events should be enriched identically',
  );

  // Pre-migration legacy files (written directly to disk, bypassing the strip
  // boundary) must keep their embedded value on read — enrichment must not
  // overwrite an existing field. Uses a fresh session so no eventCache entry
  // shadows the on-disk content.
  const legacySessionId = 'c'.repeat(32);
  const legacyDir = join(tempHome, '.config', 'ragent', 'chat-history', legacySessionId);
  mkdirSync(join(legacyDir, 'events'), { recursive: true });
  writeFileSync(join(legacyDir, 'meta.json'), JSON.stringify({
    latestSeq: 1,
    lastEventAt: 1785000000000,
    lastAssistantMessageAt: null,
    size: 1,
    counts: {},
  }));
  writeFileSync(join(legacyDir, 'events', '000000001.json'), JSON.stringify({
    type: 'run_event',
    seq: 1,
    timestamp: 1785000000000,
    runId: 'legacy-run',
    payload: 'old',
    providerCapabilities: { provider: 'legacy', runtimeFamily: 'codex' },
  }));
  const legacyEvents = await getSessionEventsAfter(legacySessionId, 0);
  assert.deepEqual(
    legacyEvents[0].providerCapabilities,
    { provider: 'legacy', runtimeFamily: 'codex' },
    'legacy files with embedded capabilities must be preserved on read (idempotent)',
  );

  console.log('test-session-events-capabilities-enrich: ok');
} finally {
  await killAll();
  rmSync(tempHome, { recursive: true, force: true });
}
