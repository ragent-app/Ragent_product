#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configDir = mkdtempSync(join(tmpdir(), 'ragent-run-index-'));
process.env.RAGENT_CONFIG_DIR = join(configDir, 'config');
process.env.RAGENT_INSTANCE_ROOT = configDir;
process.env.RAGENT_RUN_SPOOL_DIR = join(configDir, 'chat-runs');
process.env.RAGENT_MEMORY_DIR = join(configDir, 'memory');

const runs = await import(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href);
const {
  createRun,
  getRunIndexSnapshotForTests,
  listRunIndexEntries,
  listRunIds,
  removeRunsForSession,
  runIndexPath,
  runStatusPath,
  updateRun,
} = runs;

try {
  const first = await createRun({
    status: {
      id: 'run-index-a',
      sessionId: 'session-index',
      requestId: 'request-a',
      state: 'accepted',
      tool: 'codex',
    },
    manifest: { sessionId: 'session-index', requestId: 'request-a' },
  });
  const second = await createRun({
    status: {
      id: 'run-index-b',
      sessionId: 'session-index',
      requestId: 'request-b',
      state: 'queued',
      tool: 'claude',
      agyQueue: { providerId: 'agy-primary' },
      adaptiveQueue: { priority: 'background', queuedAt: '2026-09-02T00:00:00.000Z' },
    },
    manifest: { sessionId: 'session-index', requestId: 'request-b' },
  });
  await updateRun(second.id, (current) => ({
    ...current,
    agyQueue: { providerId: 'agy-primary' },
  }));
  const legacyQueued = await createRun({
    status: {
      id: 'run-index-c',
      sessionId: 'session-index',
      requestId: 'request-c',
      state: 'queued',
      tool: 'claude',
    },
    manifest: { sessionId: 'session-index', requestId: 'request-c' },
  });

  assert.deepEqual(await listRunIds(), ['run-index-a', 'run-index-b', 'run-index-c']);
  assert.equal(existsSync(runIndexPath()), true, 'run index is created on the first Run');
  const initialLines = readFileSync(runIndexPath(), 'utf8').trim().split('\n');
  assert.equal(initialLines.length, 5, 'new Runs append one header plus one index record each and queue metadata updates');

  await updateRun(first.id, (current) => ({ ...current, state: 'running' }));
  const updated = getRunIndexSnapshotForTests().find((entry) => entry.id === first.id);
  assert.equal(updated?.state, 'running', 'state changes are reflected in the durable index');
  assert.equal(updated?.tool, 'codex');

  const queuedForProvider = await listRunIndexEntries({ state: 'queued', providerId: 'agy-primary' });
  assert.deepEqual(queuedForProvider.map((entry) => entry.id), ['run-index-b', 'run-index-c']);
  assert.equal(queuedForProvider[0]?.agyQueueProviderId, 'agy-primary');
  assert.deepEqual(
    (await listRunIndexEntries({ state: 'queued', providerId: 'other-provider' })).map((entry) => entry.id),
    ['run-index-c'],
    'legacy/missing provider summaries remain visible to the authoritative status check',
  );

  // An update that only changes a non-indexed field still rewrites status.json,
  // but must not append a duplicate index record.
  const lineCountBeforeNoopIndexChange = readFileSync(runIndexPath(), 'utf8').trim().split('\n').length;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await updateRun(first.id, (current) => ({ ...current, providerHeartbeat: { at: Date.now() } }));
  const lineCountAfterNoopIndexChange = readFileSync(runIndexPath(), 'utf8').trim().split('\n').length;
  assert.equal(lineCountAfterNoopIndexChange, lineCountBeforeNoopIndexChange, 'non-indexed heartbeat does not churn the index');

  await removeRunsForSession('session-index');
  assert.deepEqual(await listRunIds(), [], 'deleting a session removes its Runs from the index');
  assert.equal(existsSync(runStatusPath(first.id)), false);

  // Legacy upgrade path: old installations have run directories but no index.
  const legacyConfigDir = mkdtempSync(join(tmpdir(), 'ragent-run-index-legacy-'));
  const legacyRunDir = join(legacyConfigDir, 'chat-runs', 'run-legacy');
  mkdirSync(legacyRunDir, { recursive: true });
  writeFileSync(join(legacyRunDir, 'status.json'), JSON.stringify({
    id: 'run-legacy',
    sessionId: 'legacy-session',
    state: 'completed',
  }));
  const legacyProbe = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    const runs = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href)});
    const ids = await runs.listRunIds();
    if (ids.length !== 1 || ids[0] !== 'run-legacy') process.exit(2);
    process.stdout.write('legacy-rebuild-hit\\n');
  `], {
    env: { ...process.env, RAGENT_CONFIG_DIR: join(legacyConfigDir, 'config'), RAGENT_INSTANCE_ROOT: legacyConfigDir,
      RAGENT_RUN_SPOOL_DIR: join(legacyConfigDir, 'chat-runs'), RAGENT_MEMORY_DIR: join(legacyConfigDir, 'memory') },
    encoding: 'utf8',
  });
  assert.equal(legacyProbe.status, 0, `legacy index rebuild: ${legacyProbe.stderr}`);
  assert.match(legacyProbe.stdout, /legacy-rebuild-hit/);
  assert.equal(existsSync(join(legacyConfigDir, 'chat-runs', 'run-index.jsonl')), true);
  rmSync(legacyConfigDir, { recursive: true, force: true });

  // Long-lived installs compact the append-only log once its configured
  // threshold is reached. Use a one-record threshold here so the probe also
  // verifies the cross-process lock path without needing thousands of Runs.
  const compactConfigDir = mkdtempSync(join(tmpdir(), 'ragent-run-index-compact-'));
  const compactProbe = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { readFileSync } from 'node:fs';
    const runs = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href)});
    const first = await runs.createRun({
      status: { id: 'run-compact-a', sessionId: 'compact-session', state: 'accepted', tool: 'codex' },
      manifest: { sessionId: 'compact-session' },
    });
    await runs.updateRun(first.id, (current) => ({ ...current, state: 'running' }));
    const lines = readFileSync(runs.runIndexPath(), 'utf8').trim().split('\\n');
    if (lines.length !== 2 || !lines[1].includes('\\"state\\":\\"running\\"')) process.exit(3);
    process.stdout.write('compaction-hit\\n');
  `], {
    env: {
      ...process.env,
      RAGENT_CONFIG_DIR: join(compactConfigDir, 'config'),
      RAGENT_INSTANCE_ROOT: compactConfigDir,
      RAGENT_RUN_SPOOL_DIR: join(compactConfigDir, 'chat-runs'),
      RAGENT_MEMORY_DIR: join(compactConfigDir, 'memory'),
      RAGENT_RUN_INDEX_COMPACT_BYTES: '1',
      RAGENT_RUN_INDEX_COMPACT_RECORDS: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(compactProbe.status, 0, `run index compaction: ${compactProbe.stderr}`);
  assert.match(compactProbe.stdout, /compaction-hit/);
  rmSync(compactConfigDir, { recursive: true, force: true });

  console.log('test-run-index: ok');
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
