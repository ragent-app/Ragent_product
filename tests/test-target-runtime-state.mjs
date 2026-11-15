#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getTargetRuntimeSummaryEvents,
  getTargetRuntimeState,
  recordTargetRuntimeSnapshotDetailed,
} from '../lib/target-runtime-state.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-target-runtime-state-'));
const filePath = join(root, 'target-runtime-state.json');
const firstNow = Date.parse('2026-09-03T00:00:00.000Z');

try {
  const first = await recordTargetRuntimeSnapshotDetailed({ sessions: { total: 1 } }, {
    filePath,
    targetId: 'target-a',
    instanceId: 'instance-a',
    nowMs: firstNow,
  });
  assert.deepEqual({ revision: first.revision, cursor: first.cursor, changed: first.changed }, {
    revision: 1,
    cursor: 1,
    changed: true,
  });
  assert.equal(first.event.targetId, 'target-a');

  const duplicate = await recordTargetRuntimeSnapshotDetailed({ sessions: { total: 1 } }, {
    filePath,
    targetId: 'target-a',
    instanceId: 'instance-a',
    nowMs: firstNow + 1000,
  });
  assert.deepEqual({ revision: duplicate.revision, cursor: duplicate.cursor, changed: duplicate.changed }, {
    revision: 1,
    cursor: 1,
    changed: false,
  });

  const second = await recordTargetRuntimeSnapshotDetailed({ sessions: { total: 2 } }, {
    filePath,
    targetId: 'target-a',
    instanceId: 'instance-a',
    nowMs: firstNow + 2000,
  });
  assert.equal(second.revision, 2);
  assert.equal(second.cursor, 2);

  const page = await getTargetRuntimeSummaryEvents({ filePath, afterCursor: 0, limit: 1 });
  assert.deepEqual({ cursor: page.cursor, nextCursor: page.nextCursor, hasMore: page.hasMore }, {
    cursor: '1',
    nextCursor: '1',
    hasMore: true,
  });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].summary.sessions.total, 1);

  const tail = await getTargetRuntimeSummaryEvents({ filePath, afterCursor: page.cursor, limit: 100 });
  assert.equal(tail.cursor, '2');
  assert.equal(tail.nextCursor, null);
  assert.equal(tail.hasMore, false);
  assert.equal(tail.events.length, 1);
  assert.equal(tail.events[0].summary.sessions.total, 2);

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.summaryCursor, 2);
  assert.equal(persisted.summaryEvents.length, 2);
  assert.equal((await getTargetRuntimeState({ filePath })).revision, 2);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('test-target-runtime-state: ok');
