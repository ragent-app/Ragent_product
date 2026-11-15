#!/usr/bin/env node
import assert from 'assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-spool-buffer-'));
const previousEnv = {
  HOME: process.env.HOME,
  RAGENT_CONFIG_DIR: process.env.RAGENT_CONFIG_DIR,
  RAGENT_SPOOL_BUFFER_DELAY_MS: process.env.RAGENT_SPOOL_BUFFER_DELAY_MS,
};
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
// Keep the timer from firing while the test checks that buffered writes are
// not synchronously persisted; the explicit flush is the terminal equivalent.
process.env.RAGENT_SPOOL_BUFFER_DELAY_MS = '60000';

try {
  const {
    appendRunSpoolRecord,
    createRun,
    flushRunSpool,
    readRunSpoolRecords,
    runSpoolPath,
  } = await import('../chat/runs.mjs');

  const run = await createRun({
    status: { sessionId: 'session_spool_buffer', requestId: 'req_spool_buffer', state: 'running', tool: 'codex' },
    manifest: { sessionId: 'session_spool_buffer', requestId: 'req_spool_buffer', folder: '~', tool: 'codex', prompt: 'buffer', options: {} },
  });
  const spoolPath = runSpoolPath(run.id);

  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'frame-1' }, { buffered: true });
  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'frame-2' }, { buffered: true });
  assert.equal(existsSync(spoolPath), false, 'short buffered burst should not write synchronously');

  await flushRunSpool(run.id);
  assert.deepEqual(
    JSON.parse(readFileSync(spoolPath, 'utf8').trim().split('\n')[0]).line,
    'frame-1',
  );
  const records = await readRunSpoolRecords(run.id);
  assert.deepEqual(records.map((record) => record.line), ['frame-1', 'frame-2']);

  // An immediate control record flushes any pending provider frames first and
  // keeps the on-disk order deterministic.
  await appendRunSpoolRecord(run.id, { stream: 'stdout', line: 'frame-3' }, { buffered: true });
  await appendRunSpoolRecord(run.id, { stream: 'error', line: 'control' });
  const ordered = await readRunSpoolRecords(run.id);
  assert.deepEqual(ordered.map((record) => record.line), ['frame-1', 'frame-2', 'frame-3', 'control']);

  console.log('test-run-spool-buffering: ok');
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}
