#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configDir = mkdtempSync(join(tmpdir(), 'ragent-run-request-index-'));
process.env.RAGENT_CONFIG_DIR = join(configDir, 'config');
process.env.RAGENT_INSTANCE_ROOT = configDir;
process.env.RAGENT_RUN_SPOOL_DIR = join(configDir, 'chat-runs');
process.env.RAGENT_MEMORY_DIR = join(configDir, 'memory');

const runs = await import(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href);
const {
  createRun,
  findRunByRequest,
  removeRunsForSession,
  runRequestIndexPath,
  runStatusPath,
} = runs;

try {
  const first = await createRun({
    status: { id: 'run-index-first', sessionId: 'session-index', requestId: 'request-first' },
    manifest: { sessionId: 'session-index', requestId: 'request-first' },
  });
  const second = await createRun({
    status: { id: 'run-index-second', sessionId: 'session-index', requestId: 'request-second' },
    manifest: { sessionId: 'session-index', requestId: 'request-second' },
  });

  const indexLines = readFileSync(runRequestIndexPath(), 'utf8').trim().split('\n');
  assert.equal(indexLines.length, 3, 'new runs append one header plus one request index record each');
  assert.deepEqual(
    await findRunByRequest(' session-index ', ' request-first '),
    first,
    'request lookup is session-scoped and trims transport whitespace',
  );
  assert.equal(await findRunByRequest('session-index', 'missing-request'), null, 'unknown request is an O(1) index miss');

  // A lookup may race the two durable writes in createRun. Keep the index
  // entry while its Run directory exists, then resolve it once status.json
  // becomes visible instead of deleting the just-created request key.
  const pendingRunId = 'run-index-pending';
  const publishedPendingRun = await createRun({
    status: { id: pendingRunId, sessionId: 'session-index', requestId: 'request-pending' },
    manifest: { sessionId: 'session-index', requestId: 'request-pending' },
  });
  rmSync(runStatusPath(pendingRunId));
  assert.equal(await findRunByRequest('session-index', 'request-pending'), null, 'pending indexed Run is not deleted before status publication');
  const pendingRun = {
    id: pendingRunId,
    sessionId: 'session-index',
    requestId: 'request-pending',
    state: 'accepted',
  };
  writeFileSync(join(configDir, 'chat-runs', pendingRunId, 'status.json'), JSON.stringify(pendingRun));
  await assert.rejects(findRunByRequest('session-index', 'request-pending'),
    { code: 'RUN_PUBLICATION_UNAVAILABLE' }, 'published marker cannot be downgraded to a legacy status');
  writeFileSync(join(configDir, 'chat-runs', pendingRunId, 'status.json'), JSON.stringify(publishedPendingRun));
  assert.deepEqual(await findRunByRequest('session-index', 'request-pending'), publishedPendingRun,
    'pending indexed Run resolves only after its matching status publication');

  const restartProbe = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    const runs = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href)});
    const run = await runs.findRunByRequest('session-index', 'request-second');
    if (!run || run.id !== 'run-index-second') process.exit(2);
    process.stdout.write('restart-hit\\n');
  `], {
    env: { ...process.env, RAGENT_CONFIG_DIR: join(configDir, 'config') },
    encoding: 'utf8',
  });
  assert.equal(restartProbe.status, 0, `request index survives restart: ${restartProbe.stderr}`);
  assert.match(restartProbe.stdout, /restart-hit/);

  await removeRunsForSession('session-index');
  assert.equal(await findRunByRequest('session-index', 'request-first'), null, 'deleted session runs are removed from the index');
  assert.equal(await findRunByRequest('session-index', 'request-second'), null, 'deleted session runs do not become stale duplicates');

  // Simulate an upgraded instance with old run directories but no index file.
  const legacyConfigDir = mkdtempSync(join(tmpdir(), 'ragent-run-request-index-legacy-'));
  const legacyRunDir = join(legacyConfigDir, 'chat-runs', 'run-legacy');
  mkdirSync(legacyRunDir, { recursive: true });
  writeFileSync(
    join(legacyRunDir, 'status.json'),
    JSON.stringify({ id: 'run-legacy', sessionId: 'legacy-session', requestId: 'legacy-request', state: 'completed' }),
  );
  const legacyProbe = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    const runs = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href)});
    const run = await runs.findRunByRequest('legacy-session', 'legacy-request');
    if (!run || run.id !== 'run-legacy') process.exit(3);
    process.stdout.write('legacy-rebuild-hit\\n');
  `], {
    env: { ...process.env, RAGENT_CONFIG_DIR: join(legacyConfigDir, 'config'), RAGENT_INSTANCE_ROOT: legacyConfigDir,
      RAGENT_RUN_SPOOL_DIR: join(legacyConfigDir, 'chat-runs'), RAGENT_MEMORY_DIR: join(legacyConfigDir, 'memory') },
    encoding: 'utf8',
  });
  assert.equal(legacyProbe.status, 0, `legacy index rebuild: ${legacyProbe.stderr}`);
  assert.match(legacyProbe.stdout, /legacy-rebuild-hit/);
  assert.ok(readFileSync(join(legacyConfigDir, 'chat-runs', 'request-index.jsonl'), 'utf8').length > 0, 'legacy rebuild persists an index');
  rmSync(legacyConfigDir, { recursive: true, force: true });

  assert.equal(existsSync(runStatusPath(first.id)), false, 'removed run status is gone');
  console.log('test-run-request-index: ok');
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
