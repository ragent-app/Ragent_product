#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-timeline-cache-'));
const previousHome = process.env.HOME;
process.env.HOME = tempHome;
process.env.RAGENT_INSTANCE_ROOT = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, 'config');
process.env.RAGENT_MEMORY_DIR = join(tempHome, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(tempHome, 'work');

try {
  const sessionManager = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
  const {
    __getTimelineBundleCounters,
    createSession,
    getSessionTimelineBundle,
    getSessionTimelinePage,
    killAll,
  } = sessionManager;
  const { appendEvent } = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
  const { createRun, updateRun } = await import(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href);
  const { mutateSessionMeta } = await import(pathToFileURL(join(repoRoot, 'chat', 'session-meta-store.mjs')).href);

  const session = await createSession(tempHome, 'fake-codex', 'Timeline Cache Case');
  const sessionId = session.id;
  await appendEvent(sessionId, { type: 'message', role: 'user', content: 'hello' });
  await appendEvent(sessionId, { type: 'message', role: 'assistant', content: 'hi there' });

  // First build; unchanged second call is served from the memo.
  const [first, concurrentFirst] = await Promise.all([
    getSessionTimelineBundle(sessionId),
    getSessionTimelineBundle(sessionId),
  ]);
  assert.equal(__getTimelineBundleCounters().builds, 1, 'first call builds the bundle');
  assert.deepEqual(concurrentFirst.displayEvents, first.displayEvents, 'concurrent callers share the same bundle build');
  const second = await getSessionTimelineBundle(sessionId);
  assert.equal(__getTimelineBundleCounters().hits, 1, 'unchanged call hits the memo');
  assert.deepEqual(second.displayEvents, first.displayEvents, 'memo returns identical display events');

  // New event → latestSeq changes → rebuild with larger timeline.
  await appendEvent(sessionId, { type: 'message', role: 'user', content: 'one more' });
  const third = await getSessionTimelineBundle(sessionId);
  assert.equal(__getTimelineBundleCounters().builds, 2, 'new event forces a rebuild');
  assert.ok(third.displayEvents.length > first.displayEvents.length, 'rebuilt bundle includes the new event');

  const page = await getSessionTimelinePage(sessionId, { limit: 10, direction: 'latest' });
  assert.ok(Array.isArray(page.events), 'bounded timeline page should return display events');
  assert.equal(page.pagination.bounded, true, 'bounded timeline page should advertise its pagination mode');
  assert.ok(page.pagination.oldestSeq > 0, 'bounded timeline page should expose its oldest sequence');
  assert.ok(page.pagination.latestSeq >= page.pagination.oldestSeq, 'bounded timeline page sequence range should be ordered');

  // A raw page can begin in the middle of a long turn. The visible paginator
  // must read back to the turn boundary before slicing, otherwise the first
  // older-page cursor is anchored to an incomplete projection.
  const longTurn = await createSession(tempHome, 'fake-codex', 'Timeline Page Boundary Case');
  await appendEvent(longTurn.id, { type: 'message', role: 'user', content: 'long turn' });
  for (let index = 1; index <= 105; index += 1) {
    await appendEvent(longTurn.id, {
      type: 'message',
      role: 'assistant',
      runId: 'long-turn-run',
      content: `progress-${index}`,
    });
    await appendEvent(longTurn.id, {
      type: 'operation',
      operationId: `long-turn-operation-${index}`,
      state: 'completed',
      detail: `operation-${index}`,
    });
  }
  const longLatest = await getSessionTimelinePage(longTurn.id, { limit: 10, direction: 'latest' });
  assert.equal(longLatest.events.length, 10, 'long-turn latest page should respect the display limit');
  assert.deepEqual(
    longLatest.events.map((event) => event.type),
    ['message', 'operation', 'message', 'operation', 'message', 'operation', 'message', 'operation', 'message', 'operation'],
    'long-turn latest page should keep actions interleaved with assistant output',
  );
  assert.ok(longLatest.pagination.nextBeforeSeq > 1, 'long-turn latest page should expose a display cursor');
  const longOlder = await getSessionTimelinePage(longTurn.id, {
    limit: 10,
    direction: 'before',
    beforeSeq: longLatest.pagination.nextBeforeSeq,
  });
  assert.equal(longOlder.events.length, 10, 'long-turn older page should respect the display limit');
  assert.ok(
    longOlder.pagination.latestSeq < longLatest.pagination.oldestSeq,
    'long-turn older page should move strictly before the latest page',
  );
  assert.equal(
    new Set([...longLatest.events, ...longOlder.events].map((event) => event.seq)).size,
    20,
    'successive long-turn pages should not repeat display events',
  );

  // Stable again → hit.
  await getSessionTimelineBundle(sessionId);
  assert.equal(__getTimelineBundleCounters().hits, 2, 'stable session hits the memo again');

  // Run fingerprint change (activeRunId + run state) → rebuild.
  const run = await createRun({
    status: {
      sessionId,
      requestId: 'req_timeline_cache',
      state: 'accepted',
      tool: 'fake-codex',
      runtimeFamily: 'codex-json',
    },
    manifest: {
      sessionId,
      requestId: 'req_timeline_cache',
      folder: '~',
      tool: 'fake-codex',
      prompt: 'x',
      runtimeFamily: 'codex-json',
      options: { runtimeFamily: 'codex-json' },
    },
  });
  await mutateSessionMeta(sessionId, (draft) => {
    draft.activeRunId = run.id;
    return true;
  });
  await updateRun(run.id, { state: 'running' });
  const withRun = await getSessionTimelineBundle(sessionId);
  assert.equal(__getTimelineBundleCounters().builds, 3, 'run fingerprint change forces a rebuild');
  assert.equal(withRun.sessionRunning, true, 'bundle reflects the running run');
  await getSessionTimelineBundle(sessionId);
  assert.equal(__getTimelineBundleCounters().hits, 3, 'stable run state hits the memo');

  killAll();
  console.log('test-session-timeline-cache: ok');
} finally {
  process.env.HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
}
