#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-meta-debounce-'));
const previousHome = process.env.HOME;
process.env.HOME = home;

const sessionsFile = join(home, '.config', 'ragent', 'chat-sessions.json');
mkdirSync(join(home, '.config', 'ragent'), { recursive: true });
writeFileSync(sessionsFile, JSON.stringify([
  { id: 'session_meta_debounce', name: 'original', folder: '~' },
], null, 2), 'utf8');

const mtimeMs = () => statSync(sessionsFile).mtimeMs;

try {
  const {
    findSessionMetaCached,
    flushSessionsMetaNow,
    loadSessionsMeta,
    mutateSessionMeta,
  } = await import('../chat/session-meta-store.mjs');

  // --- non-critical mutation: debounced (cache fresh, file untouched) ---
  // Loading may migrate a legacy record, so establish the baseline after that write.
  await loadSessionsMeta();
  const before = mtimeMs();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const result = await mutateSessionMeta('session_meta_debounce', (session) => {
    session.name = 'renamed in memory';
    return true;
  });
  assert.equal(result.changed, true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(mtimeMs(), before, 'non-critical mutation must not rewrite the file immediately');
  assert.equal(findSessionMetaCached('session_meta_debounce').name, 'renamed in memory', 'cache updates synchronously');
  assert.equal(findSessionMetaCached('session_meta_debounce').id, 'session_meta_debounce', 'unchanged fields preserved');

  // --- flush writes the file ---
  await flushSessionsMetaNow();
  const onDisk = JSON.parse(readFileSync(sessionsFile, 'utf8'));
  assert.equal(onDisk.find((meta) => meta.id === 'session_meta_debounce').name, 'renamed in memory', 'flush persists the pending mutation');
  assert.ok(statSync(sessionsFile).mtimeMs > before, 'flush advances the file mtime');

  // --- activeRunId change: immediate write (boot-recovery critical) ---
  const beforeCritical = mtimeMs();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await mutateSessionMeta('session_meta_debounce', (session) => {
    session.activeRunId = 'run_critical_1';
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(statSync(sessionsFile).mtimeMs > beforeCritical, 'activeRunId mutation must flush immediately');
  const criticalDisk = JSON.parse(readFileSync(sessionsFile, 'utf8'));
  assert.equal(criticalDisk.find((meta) => meta.id === 'session_meta_debounce').activeRunId, 'run_critical_1');

  // --- archived change: immediate write ---
  const beforeArchive = mtimeMs();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await mutateSessionMeta('session_meta_debounce', (session) => {
    session.archived = true;
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(statSync(sessionsFile).mtimeMs > beforeArchive, 'archived mutation must flush immediately');

  // --- no-op mutation: nothing changes at all ---
  const beforeNoop = mtimeMs();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const noop = await mutateSessionMeta('session_meta_debounce', () => false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(noop.changed, false);
  assert.equal(mtimeMs(), beforeNoop, 'no-op mutation writes nothing');

  console.log('test-session-meta-store-debounce: ok');
} finally {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
