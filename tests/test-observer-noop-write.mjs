#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-observer-noop-'));
const previousHome = process.env.HOME;
process.env.HOME = home;

const runStatusPath = (runId) => join(home, '.config', 'ragent', 'chat-runs', runId, 'status.json');
const runResultPath = (runId) => join(home, '.config', 'ragent', 'chat-runs', runId, 'result.json');

try {
  const {
    createRun,
    getRun,
    getRunResult,
    updateRun,
    writeRunResult,
  } = await import('../chat/runs.mjs');

  const run = await createRun({
    status: {
      sessionId: 'session_noop_write',
      requestId: 'req_noop_write',
      state: 'accepted',
      tool: 'fake-codex',
    },
    manifest: {
      sessionId: 'session_noop_write',
      requestId: 'req_noop_write',
      folder: '~',
      tool: 'fake-codex',
      prompt: 'hi',
      options: {},
    },
  });

  const path = runStatusPath(run.id);
  const mtimeMs = () => statSync(path).mtimeMs;

  // --- 1. no-op updater must not rewrite status.json ---
  const beforeNoop = mtimeMs();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const noopResult = await updateRun(run.id, (current) => current);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(mtimeMs(), beforeNoop, 'reference-identical updater result must skip the status.json write');
  assert.equal(noopResult.state, 'accepted', 'no-op updateRun still returns the fresh run record');

  // --- 2. object-form updateRun still persists (mtime advances) ---
  await new Promise((resolve) => setTimeout(resolve, 15));
  await updateRun(run.id, { state: 'running' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(mtimeMs() > beforeNoop, 'object-form updateRun must still rewrite status.json');
  const afterObjForm = mtimeMs();

  await new Promise((resolve) => setTimeout(resolve, 15));
  await updateRun(run.id, { state: 'running' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(mtimeMs(), afterObjForm, 'repeating an object-form update with identical fields must skip the write');

  // --- 3. mtime-gated read cache: a direct file write (sidecar/test bypass)
  // must be visible on the next read despite the cache ---
  const directState = {
    ...JSON.parse(readFileSync(path, 'utf8')),
    state: 'completed',
    directMarker: 'bypass-write',
  };
  writeFileSync(path, JSON.stringify(directState, null, 2), 'utf8');
  const readBack = await getRun(run.id);
  assert.equal(readBack.state, 'completed', 'direct status.json write must be picked up by the mtime-gated cache');
  assert.equal(readBack.directMarker, 'bypass-write', 'direct write content must not be masked by the stale cache');

  // --- 4. result.json read cache behaves the same ---
  await writeRunResult(run.id, { exitCode: 0, completedAt: '2026-08-06T00:00:00.000Z' });
  const resultPath = runResultPath(run.id);
  const resultBefore = statSync(resultPath).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 15));
  const result = await getRunResult(run.id);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(result.exitCode, 0);
  assert.equal(statSync(resultPath).mtimeMs, resultBefore, 'cached result.json read must not touch the file');
  writeFileSync(resultPath, JSON.stringify({ exitCode: 3 }, null, 2), 'utf8');
  assert.equal((await getRunResult(run.id)).exitCode, 3, 'direct result.json write must be visible');

  // --- 5. repeated no-op updates keep the file untouched across many ticks ---
  const tickStart = mtimeMs();
  for (let i = 0; i < 20; i += 1) {
    await updateRun(run.id, (current) => current);
  }
  assert.equal(mtimeMs(), tickStart, '20 no-op observer-style ticks must not advance status.json mtime');

  console.log('test-observer-noop-write: ok');
} finally {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
