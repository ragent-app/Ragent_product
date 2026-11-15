#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildForkHistoryIndex,
  FORK_HISTORY_INDEX_INTERVAL,
} from '../chat/fork-history-index.mjs';

const tempDir = await mkdtemp(join(tmpdir(), 'ragent-fork-perf-'));
process.env.RAGENT_CONFIG_DIR = tempDir;

try {
  const totalEvents = 2048;
  const events = [];
  for (let i = 1; i <= totalEvents; i++) {
    events.push({
      seq: i,
      type: i % 3 === 0 ? 'message' : (i % 3 === 1 ? 'tool_use' : 'tool_result'),
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `test event ${i}`,
      timestamp: Date.now() + i,
    });
  }

  // 1. Build initial index over 2048 events. Measure elapsed time.
  const t0 = performance.now();
  const index = await buildForkHistoryIndex({
    sessionId: 'perf-test-session',
    latestSeq: totalEvents,
    interval: FORK_HISTORY_INDEX_INTERVAL,
    forEachEvent: async (visitor, options) => {
      const from = options?.fromSeq || 1;
      const to = options?.toSeq || totalEvents;
      for (const event of events) {
        if (event.seq >= from && event.seq <= to) {
          await visitor(event);
        }
      }
    },
  });
  const t1 = performance.now();
  const buildDurationMs = t1 - t0;

  assert.equal(index.builtThroughSeq, totalEvents);
  assert.equal(index.complete, true);
  // With interval 512 and 2048 events, we expect checkpoints at 512, 1024, 1536, 2048
  assert.equal(index.checkpoints.length, 4);
  assert.equal(index.checkpoints[0].throughSeq, 512);
  assert.equal(index.checkpoints[1].throughSeq, 1024);
  assert.equal(index.checkpoints[2].throughSeq, 1536);
  assert.equal(index.checkpoints[3].throughSeq, 2048);
  assert.ok(
    buildDurationMs < 1500,
    `Batch chunked build for ${totalEvents} events should finish quickly, took ${buildDurationMs.toFixed(1)}ms`,
  );

  // 2. Incremental update: append 10 new events
  const extraEvents = 10;
  for (let i = totalEvents + 1; i <= totalEvents + extraEvents; i++) {
    events.push({
      seq: i,
      type: 'message',
      role: 'user',
      content: `extra event ${i}`,
      timestamp: Date.now() + i,
    });
  }

  let visitedCount = 0;
  const t2 = performance.now();
  const updatedIndex = await buildForkHistoryIndex({
    sessionId: 'perf-test-session',
    latestSeq: totalEvents + extraEvents,
    interval: FORK_HISTORY_INDEX_INTERVAL,
    existingIndex: index,
    forEachEvent: async (visitor, options) => {
      const from = options?.fromSeq || 1;
      const to = options?.toSeq || (totalEvents + extraEvents);
      for (const event of events) {
        if (event.seq >= from && event.seq <= to) {
          visitedCount++;
          await visitor(event);
        }
      }
    },
  });
  const t3 = performance.now();
  const incrementalDurationMs = t3 - t2;

  assert.equal(updatedIndex.builtThroughSeq, totalEvents + extraEvents);
  // Visited only the extra events, not the full 2048!
  assert.equal(visitedCount, extraEvents, `Incremental update should only visit ${extraEvents} events, visited ${visitedCount}`);
  assert.ok(
    incrementalDurationMs < 100,
    `Incremental build should be nearly instantaneous, took ${incrementalDurationMs.toFixed(1)}ms`,
  );
  // Checkpoints should contain 512, 1024, 1536, 2048, and the terminal 2058
  assert.equal(updatedIndex.checkpoints.at(-1).throughSeq, totalEvents + extraEvents);

  console.log('test-fork-history-index-perf: ok (build: ' + buildDurationMs.toFixed(1) + 'ms, incremental: ' + incrementalDurationMs.toFixed(1) + 'ms)');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
