#!/usr/bin/env node
// Large-session safety: raw event pages must enforce caller-provided body and
// aggregate response budgets without returning an error-shaped event.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-history-page-budget-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
process.env.RAGENT_INSTANCE_ROOT = home;

const { appendEvents, readEventBody, readEventsPage } = await import('../chat/history.mjs');
const { getSessionEventsPage } = await import('../chat/session-manager.mjs');

const sessionId = `history-page-budget-${process.pid}-${Date.now()}`;
try {
  const mediumBody = 'm'.repeat(100 * 1024);
  await appendEvents(sessionId, Array.from({ length: 6 }, (_, index) => ({
    type: 'message',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index}:${mediumBody}`,
  })));

  const bounded = await readEventsPage(sessionId, {
    includeBodies: false,
    includeMessageBodies: true,
    limit: 20,
    maxBodyBytes: 128 * 1024,
    maxResponseBytes: 256 * 1024,
  });
  assert.ok(bounded.events.length >= 2 && bounded.events.length < 6, 'aggregate budget should stop before the full page');
  assert.equal(bounded.pagination.truncatedByBytes, true, 'page should advertise a byte-budget truncation');
  assert.equal(bounded.pagination.hasMoreAfter, true, 'remaining events should stay reachable through pagination');
  assert.ok(bounded.events.every((event) => event.content.length >= 100 * 1024), 'bodies below the cap should remain intact');

  const oversizedBody = 'z'.repeat(300 * 1024);
  await appendEvents(sessionId, [{ type: 'message', role: 'assistant', content: oversizedBody }]);
  const previewPage = await readEventsPage(sessionId, {
    includeBodies: false,
    includeMessageBodies: true,
    limit: 1,
    direction: 'latest',
    maxBodyBytes: 128 * 1024,
    maxResponseBytes: 256 * 1024,
  });
  const preview = previewPage.events.at(-1);
  assert.equal(preview?.bodyTruncated, true, 'oversized bodies should be marked as truncated');
  assert.ok(preview?.content && preview.content.length < oversizedBody.length, 'oversized body should render its bounded preview');
  assert.doesNotMatch(preview.content, /body truncated:/, 'preview should not look like a generic error message');

  const fullBody = await readEventBody(sessionId, preview.seq);
  assert.equal(fullBody?.value, oversizedBody, 'dedicated body reads must retain the full content');

  // The public session wrapper must forward the caller budgets all the way to
  // history; otherwise route-level limits are silently ignored.
  const wrapped = await getSessionEventsPage(sessionId, {
    includeBodies: false,
    includeMessageBodies: true,
    limit: 20,
    maxBodyBytes: 128 * 1024,
    maxResponseBytes: 256 * 1024,
  });
  assert.ok(wrapped.events.length < 7, 'session wrapper should preserve the response budget');
  assert.equal(wrapped.pagination.truncatedByBytes, true, 'wrapper should expose byte-budget truncation');
  const thoughtSession = `${sessionId}-thinking`;
  const thoughtBodies = Array.from({ length: 3 }, (_, index) => `${index}:${'t'.repeat(100 * 1024)}`);
  await appendEvents(thoughtSession, thoughtBodies.map((content, index) => ({ type: 'reasoning',
    runId: 'r', providerMessageId: `m-${index}`, reasoningLifecycle: 'completed', content })));
  const deferred = await readEventsPage(thoughtSession, { limit: 5, includeBodies: false });
  assert.ok(deferred.events.every((event) => event.bodyLoaded === false), 'ordinary reads keep thinking bodies deferred');
  const thoughtPage = await getSessionEventsPage(thoughtSession, { includeReasoningBodies: true,
    limit: 5, maxBodyBytes: 128 * 1024, maxResponseBytes: 256 * 1024 });
  assert.ok(thoughtPage.events.length >= 2 && thoughtPage.events.length < 3);
  assert.equal(thoughtPage.pagination.truncatedByBytes, true, 'thinking respects the aggregate page budget');
  assert.deepEqual(thoughtPage.events.map((event) => event.content), thoughtBodies.slice(0, thoughtPage.events.length));
  const nextThoughtPage = await getSessionEventsPage(thoughtSession, { includeReasoningBodies: true,
    afterSeq: thoughtPage.events.at(-1).seq, limit: 5, maxResponseBytes: 256 * 1024 });
  assert.equal(nextThoughtPage.events.at(-1)?.content, thoughtBodies.at(-1), 'remaining thinking is reachable after pagination');
  console.log('history-page-response-budget: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
