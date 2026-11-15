#!/usr/bin/env node
// Recovery scans must not materialize or retain a complete session transcript.
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'ragent-history-scan-'));
const previousConfigDir = process.env.RAGENT_CONFIG_DIR;
const previousSpoolDir = process.env.RAGENT_RUN_SPOOL_DIR;
process.env.RAGENT_CONFIG_DIR = root;
delete process.env.RAGENT_RUN_SPOOL_DIR;

try {
  const { CHAT_HISTORY_DIR } = await import('../lib/config.mjs');
  const { forEachStoredEvent } = await import('../chat/history.mjs');
  const { collectCacheMetrics } = await import('../chat/memory-registry.mjs');

  const sessionId = 'session_uncached_scan';
  const eventsDir = join(CHAT_HISTORY_DIR, sessionId, 'events');
  mkdirSync(eventsDir, { recursive: true });
  const total = 1200;
  writeFileSync(join(CHAT_HISTORY_DIR, sessionId, 'meta.json'), JSON.stringify({
    latestSeq: total,
    size: total,
    counts: { status: total },
  }));
  for (let seq = 1; seq <= total; seq += 1) {
    writeFileSync(join(eventsDir, `${String(seq).padStart(9, '0')}.json`), JSON.stringify({
      seq,
      type: 'status',
      content: `status-${seq}`,
      timestamp: Date.now(),
    }));
  }

  let seen = 0;
  await forEachStoredEvent(sessionId, (event) => {
    seen += 1;
    assert.equal(event.seq, seen);
    assert.equal(event.content, `status-${seen}`);
  });
  assert.equal(seen, total, 'scanner should visit every stored event');
  const eventCache = collectCacheMetrics().find((entry) => entry.name === 'history.events');
  assert.equal(eventCache?.entries, 0, 'uncached scanner must not populate history event cache');

  let stoppedAt = 0;
  await forEachStoredEvent(sessionId, (event) => {
    stoppedAt = event.seq;
    if (event.seq === 5) return false;
    return undefined;
  });
  assert.equal(stoppedAt, 5, 'scanner callback should support early stop');

  console.log('test-history-uncached-scan: ok');
} finally {
  if (previousConfigDir === undefined) delete process.env.RAGENT_CONFIG_DIR;
  else process.env.RAGENT_CONFIG_DIR = previousConfigDir;
  if (previousSpoolDir === undefined) delete process.env.RAGENT_RUN_SPOOL_DIR;
  else process.env.RAGENT_RUN_SPOOL_DIR = previousSpoolDir;
  rmSync(root, { recursive: true, force: true });
}
