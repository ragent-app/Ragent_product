#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-projection-debounce-'));
const previousHome = process.env.HOME;
process.env.HOME = home;

const sessionId = 'session-projection-debounce';
const projectionFile = join(home, '.config', 'ragent', 'chat-history', sessionId, 'audit-projection.json');

try {
  const {
    flushPendingAuditProjections,
    readSessionAuditProjection,
    updateSessionAuditProjectionForEvents,
  } = await import('../chat/session-audit-projection.mjs');

  const events = [
    {
      seq: 1,
      id: 'evt-user-1',
      type: 'message',
      role: 'user',
      content: 'please inspect this',
    },
    {
      seq: 2,
      id: 'evt-edit-1',
      type: 'tool_use',
      toolName: 'Edit',
      runId: 'run-1',
      toolInput: JSON.stringify({
        file_path: 'static/chat/run-sheet.js',
        old_string: 'old line',
        new_string: 'new line',
      }),
    },
  ];

  // First update: merged data must be visible in memory, nothing on disk yet.
  const projection = await updateSessionAuditProjectionForEvents(sessionId, events, { latestSeq: 2 });
  assert.equal(projection.sourceLatestSeq, 2, 'in-memory projection advances');
  assert.equal(projection.changedFiles.length, 1, 'file edit lands in changedFiles');
  assert.throws(() => statSync(projectionFile), 'no file write before the debounce window elapses');

  // Second update inside the window: merge continues, still no write.
  const later = await updateSessionAuditProjectionForEvents(sessionId, [
    { seq: 3, id: 'evt-edit-2', type: 'tool_use', toolName: 'Edit', runId: 'run-1', toolInput: JSON.stringify({ file_path: 'static/chat/ui.js', old_string: 'a', new_string: 'b' }) },
  ], { latestSeq: 3 });
  assert.equal(later.sourceLatestSeq, 3, 'second update merges into the pending projection');
  assert.equal(later.changedFiles.length, 2, 'second file edit merges into changedFiles');
  assert.throws(() => statSync(projectionFile), 'still no write while the window stays open');

  // readSessionAuditProjection serves the pending value (the route reader path).
  const readBack = await readSessionAuditProjection(sessionId);
  assert.equal(readBack.sourceLatestSeq, 3, 'readSessionAuditProjection returns the pending projection');
  assert.equal(readBack.changedFiles.length, 2);

  // Flush: file appears and matches the pending projection exactly.
  await flushPendingAuditProjections();
  const onDisk = JSON.parse(readFileSync(projectionFile, 'utf8'));
  assert.equal(onDisk.sourceLatestSeq, 3, 'flushed file matches the pending projection');
  assert.equal(onDisk.changedFiles.length, 2);
  assert.equal(onDisk.schemaVersion, 2);

  // After flush, reads come from the file with identical content.
  const afterFlush = await readSessionAuditProjection(sessionId);
  assert.equal(afterFlush.sourceLatestSeq, 3);
  assert.equal(afterFlush.changedFiles.length, 2);

  console.log('test-session-audit-projection-debounce: ok');
} finally {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
