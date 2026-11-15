#!/usr/bin/env node
// Completion/reply history hydration must enforce an aggregate body budget,
// not only a per-event cap.  This protects large sessions from allocating one
// large buffer for every message in the bounded event tail.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-scoped-history-body-budget-'));
const previousHome = process.env.HOME;
const previousConfig = process.env.RAGENT_CONFIG_DIR;
const previousMemory = process.env.RAGENT_MEMORY_DIR;
const previousWorkRoot = process.env.RAGENT_WORK_ROOT_DIR;
process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = join(tempHome, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(tempHome, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(tempHome, 'workspace');

try {
  const sessionManager = await import(pathToFileURL(resolve(repoRoot, '..', 'chat', 'session-manager.mjs')).href);
  const { appendEvents } = await import(pathToFileURL(resolve(repoRoot, '..', 'chat', 'history.mjs')).href);
  const sessionId = `scoped-history-body-budget-${process.pid}`;
  const body = 'x'.repeat(128 * 1024);
  const events = Array.from({ length: 40 }, (_, index) => ({
    type: 'message',
    role: 'assistant',
    runId: 'run-budget',
    content: `${index}:${body}`,
  }));
  await appendEvents(sessionId, events);

  const hydrated = await sessionManager.loadRecentTurnHistory(sessionId, { includeBodies: true });
  const loaded = hydrated.filter((event) => event?.bodyLoaded === true);
  const loadedBytes = loaded.reduce((total, event) => total + Buffer.byteLength(event.content || '', 'utf8'), 0);
  const deferred = hydrated.filter((event) => event?.bodyAvailable === true && event?.bodyLoaded === false);

  assert.equal(hydrated.length, events.length, 'bounded recent-turn reader should retain the event tail');
  assert.ok(loaded.length < events.length, 'aggregate budget should leave some bodies lazy');
  assert.ok(deferred.length > 0, 'events beyond the aggregate budget should remain lazy');
  assert.ok(
    loadedBytes <= 4 * 1024 * 1024,
    `hydrated body bytes should stay within the aggregate budget (got ${loadedBytes})`,
  );
  assert.equal(hydrated.at(-1)?.bodyLoaded, true, 'newest reply body should be prioritized within the budget');
  console.log('test-session-scoped-history-body-budget: ok');
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousConfig === undefined) delete process.env.RAGENT_CONFIG_DIR;
  else process.env.RAGENT_CONFIG_DIR = previousConfig;
  if (previousMemory === undefined) delete process.env.RAGENT_MEMORY_DIR;
  else process.env.RAGENT_MEMORY_DIR = previousMemory;
  if (previousWorkRoot === undefined) delete process.env.RAGENT_WORK_ROOT_DIR;
  else process.env.RAGENT_WORK_ROOT_DIR = previousWorkRoot;
  rmSync(tempHome, { recursive: true, force: true });
}
