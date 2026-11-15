#!/usr/bin/env node
// DS-11: bounded-concurrency read paths + cache-hit stats.
//
// Asserts that page/full-history reads walk events through the bounded worker
// pool (never a full-session sequential sweep), preserve order, tolerate
// missing event files, keep includeBodies semantics, and count cache hits.
// All sessions live in a throwaway HOME (same convention as
// test-history-index-contract.mjs).
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-history-read-concurrency-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
process.env.RAGENT_INSTANCE_ROOT = home;

const {
  appendEvents,
  findLatestAssistantMessage,
  getHistoryReadStats,
  getHistorySnapshot,
  loadHistory,
  loadMeta,
  readEventBody,
  readEventsAfter,
  readEventsPage,
  readLastEvent,
  readLastTurnEvents,
  __mapWithBoundedConcurrency,
  __resetHistoryReadStatsForTest,
} = await import('../chat/history.mjs');
const { CHAT_HISTORY_DIR } = await import('../lib/config.mjs');

let sessionCounter = 0;
function nextSessionId() {
  sessionCounter += 1;
  return `history-read-concurrency-${process.pid}-${sessionCounter}`;
}

function buildEvents(count, { withBodies = false } = {}) {
  const events = [];
  for (let index = 0; index < count; index += 1) {
    events.push({
      type: 'message',
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: withBodies && index % 7 === 0 ? `big message ${index} ` + 'x'.repeat(70 * 1024) : `message ${index}`,
    });
  }
  return events;
}

async function assertAscendingSeq(events, label) {
  let previous = 0;
  for (const event of events) {
    assert.ok(Number.isInteger(event.seq), `${label}: seq should be an integer`);
    assert.ok(event.seq > previous, `${label}: seq order should be strictly ascending`);
    previous = event.seq;
  }
}

// Fabricate a session purely on disk (meta.json + one file per event) without
// going through appendEvents, so the event cache stays cold and reads must
// hit the real files — the only way to exercise disk-read paths in-process.
async function fabricateSessionOnDisk(sessionId, count) {
  const { ensureDir } = await import('../chat/fs-utils.mjs');
  const sessionEventsDir = join(CHAT_HISTORY_DIR, sessionId, 'events');
  await ensureDir(sessionEventsDir);
  await writeFile(join(CHAT_HISTORY_DIR, sessionId, 'meta.json'), JSON.stringify({
    latestSeq: count,
    lastEventAt: Date.now(),
    lastAssistantMessageAt: null,
    size: count,
    counts: { message_user: count },
  }));
  const timestamp = Date.now();
  const writes = [];
  for (let seq = 1; seq <= count; seq += 1) {
    writes.push(writeFile(
      join(sessionEventsDir, `${String(seq).padStart(9, '0')}.json`),
      JSON.stringify({ seq, type: 'message', role: 'user', content: `file-event ${seq}`, timestamp }),
    ));
  }
  await Promise.all(writes);
}

try {
  // --- 1. pool primitive: bounded concurrency, order preserved ---
  {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 100 }, (_, index) => index);
    const results = await __mapWithBoundedConcurrency(items, 8, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return value * 2;
    });
    assert.deepEqual(results, items.map((value) => value * 2), 'pool should return results in input order');
    assert.equal(results.length, 100, 'pool should process every item');
    assert.ok(peak <= 8, `peak in-flight should respect the bound (got ${peak})`);
  }

  // --- 2. page reads are bounded: they never sweep the session ---
  {
    const sessionId = nextSessionId();
    await fabricateSessionOnDisk(sessionId, 3000);

    __resetHistoryReadStatsForTest();
    const page1 = await readEventsPage(sessionId, { limit: 200 });
    assert.equal(page1.events.length, 200, 'forward page should return exactly the limit');
    const readsAfterPage1 = getHistoryReadStats().eventFileReads;
    assert.ok(
      readsAfterPage1 <= 256,
      `first page should read at most one batch of files (read ${readsAfterPage1})`,
    );

    const page2 = await readEventsPage(sessionId, { afterSeq: 200, limit: 200 });
    assert.equal(page2.events.length, 200, 'second page should return exactly the limit');
    assert.equal(page2.events[0].seq, 201, 'second page should continue after seq 200');
    const readsAfterPage2 = getHistoryReadStats().eventFileReads;
    const pageStats = getHistoryReadStats();
    assert.ok(
      readsAfterPage2 - readsAfterPage1 <= 256,
      `second page should read at most one more batch (read ${readsAfterPage2 - readsAfterPage1})`,
    );
    assert.ok(
      readsAfterPage2 < 1000,
      `two pages of a 3000-event session must not sweep the session (read ${readsAfterPage2} files)`,
    );
    assert.equal(pageStats.pageReads, 2, 'history metrics should count page reads');
    assert.ok(pageStats.totalReadDurationMs >= pageStats.maxReadDurationMs);
    assert.ok(pageStats.lastReadDurationMs >= 0, 'history metrics should record read latency');
  }

  // --- 3. forward/backward order + pagination metadata ---
  {
    const sessionId = nextSessionId();
    await appendEvents(sessionId, buildEvents(620));

    const forward = await readEventsPage(sessionId, { limit: 200 });
    assert.equal(forward.events.length, 200);
    await assertAscendingSeq(forward.events, 'forward page');
    assert.equal(forward.pagination.oldestSeq, 1);
    assert.equal(forward.pagination.latestSeq, 200);
    assert.equal(forward.pagination.hasMoreBefore, false);
    assert.equal(forward.pagination.hasMoreAfter, true);
    assert.equal(forward.pagination.totalLatestSeq, 620);

    const backward = await readEventsPage(sessionId, { beforeSeq: 620, limit: 200 });
    assert.equal(backward.events.length, 200);
    await assertAscendingSeq(backward.events, 'backward page');
    assert.equal(backward.events[0].seq, 420, 'backward page should start below beforeSeq');
    assert.equal(backward.events.at(-1).seq, 619);

    const midPage = await readEventsPage(sessionId, { afterSeq: 100, limit: 200 });
    assert.equal(midPage.events[0].seq, 101, 'afterSeq page should start after the boundary');
    assert.equal(midPage.pagination.hasMoreBefore, true);

    // afterSeq boundary inside a backward scan stops at the boundary
    const boundedBackward = await readEventsPage(sessionId, { beforeSeq: 620, afterSeq: 610, limit: 200 });
    assert.equal(boundedBackward.events.length, 9, 'backward scan should stop at the afterSeq boundary');
    assert.equal(boundedBackward.events[0].seq, 611);
    assert.equal(boundedBackward.events.at(-1).seq, 619);
  }

  // --- 4. missing-file tolerance (cold disk reads: the cache never saw the
  // deleted event, so reads must fall back to the tolerant readJson path) ---
  {
    const sessionId = nextSessionId();
    await fabricateSessionOnDisk(sessionId, 50);
    rmSync(join(CHAT_HISTORY_DIR, sessionId, 'events', '000000025.json'), { force: true });

    const after = await readEventsAfter(sessionId, 0);
    assert.equal(after.length, 49, 'read should skip the missing event');
    assert.ok(!after.some((event) => event.seq === 25), 'missing event should not be returned');
    await assertAscendingSeq(after, 'after missing-file read');

    const page = await readEventsPage(sessionId, { beforeSeq: 50, limit: 200 });
    assert.equal(page.events.length, 48, 'backward page spans 1..49 and should skip the missing 25');
    assert.ok(!page.events.some((event) => event.seq === 25), 'backward page should also skip the missing event');

    const last = await readLastEvent(sessionId);
    assert.equal(last.seq, 50, 'readLastEvent should still work');
  }

  // --- 5. includeBodies semantics + body externalization ---
  {
    const sessionId = nextSessionId();
    const bigMessage = 'm'.repeat(70 * 1024);
    const bigResult = 'r'.repeat(8 * 1024);
    await appendEvents(sessionId, [
      { type: 'message', role: 'user', content: bigMessage },
      { type: 'reasoning', content: 'thinking '.repeat(1000) },
      { type: 'tool_use', id: 'tool-1', toolName: 'shell', toolInput: 'echo hi' },
      { type: 'tool_result', output: bigResult, exitCode: 0 },
    ]);

    const indexRead = await readEventsPage(sessionId, { limit: 10 });
    const [messageEvent, reasoningEvent, toolUseEvent, toolResultEvent] = indexRead.events;
    assert.equal(messageEvent.content, '', 'externalized message body should be stripped from the index read');
    assert.equal(messageEvent.bodyAvailable, true);
    assert.equal(messageEvent.bodyLoaded, false);
    assert.ok(typeof messageEvent.bodyRef === 'string' && messageEvent.bodyRef.length > 0);
    assert.equal(reasoningEvent.bodyLoaded, false, 'reasoning is always externalized');
    assert.equal(toolUseEvent.toolInput, '', 'inline tool_use input should be stripped from the index read');
    assert.equal(toolResultEvent.output, '');
    assert.ok(
      typeof toolResultEvent.bodyPreview === 'string' && toolResultEvent.bodyPreview.length > 0,
      'tool_result index read should carry a preview',
    );
    assert.ok(
      toolResultEvent.bodyPreview.length < bigResult.length,
      'preview should be clipped well below the full body',
    );

    const hydrated = await readEventsPage(sessionId, { includeBodies: true, limit: 10 });
    const [hydratedMessage, hydratedReasoning, hydratedToolUse, hydratedToolResult] = hydrated.events;
    assert.equal(hydratedMessage.content, bigMessage, 'includeBodies should restore the full message body');
    assert.equal(hydratedMessage.bodyLoaded, true);
    assert.equal(hydratedReasoning.bodyLoaded, true);
    assert.equal(hydratedToolUse.toolInput, 'echo hi', 'includeBodies should keep inline tool_use input');
    assert.equal(hydratedToolResult.output, bigResult, 'includeBodies should restore the full tool_result body');

    const body = await readEventBody(sessionId, 1);
    assert.equal(body.value, bigMessage, 'readEventBody should return the externalized body');
  }

  // --- 6. cache-hit stats: hot reads read no files ---
  {
    const sessionId = nextSessionId();
    await fabricateSessionOnDisk(sessionId, 200);

    __resetHistoryReadStatsForTest();
    await readEventsPage(sessionId, { limit: 200 });
    const cold = getHistoryReadStats();
    assert.ok(cold.eventFileReads > 0, 'cold page should read files');
    assert.equal(cold.eventCacheHits, 0, 'cold page should have no cache hits');

    __resetHistoryReadStatsForTest();
    await readEventsPage(sessionId, { limit: 200 });
    const hot = getHistoryReadStats();
    assert.equal(hot.eventFileReads, 0, 'fully cached page should read no files');
    assert.ok(hot.eventCacheHits >= 200, 'fully cached page should hit the event cache');
    assert.equal(hot.pageReads, 1, 'hot page metrics should remain bounded per operation');
    assert.equal(hot.lastReadKind, 'page');
  }

  // --- 7. countMessageEventsAfter (via getHistorySnapshot with activeFromSeq):
  // correctness + memoized re-count reads nothing ---
  {
    const sessionId = nextSessionId();
    const { ensureDir } = await import('../chat/fs-utils.mjs');
    const sessionEventsDir = join(CHAT_HISTORY_DIR, sessionId, 'events');
    await ensureDir(sessionEventsDir);
    await writeFile(join(CHAT_HISTORY_DIR, sessionId, 'meta.json'), JSON.stringify({
      latestSeq: 100,
      lastEventAt: Date.now(),
      // Pre-set so getHistorySnapshot skips the backward assistant-message scan
      // (that scan legitimately touches the event cache; the memo assertions
      // below must isolate the count memo itself).
      lastAssistantMessageAt: '2026-08-08T00:00:00.000Z',
      size: 100,
      counts: { message_user: 25, message_assistant: 25 },
    }));
    await writeFile(join(CHAT_HISTORY_DIR, sessionId, 'context.json'), JSON.stringify({ mode: 'history', activeFromSeq: 25 }));
    const timestamp = Date.now();
    const writes = [];
    for (let seq = 1; seq <= 100; seq += 1) {
      const isMessage = seq % 2 === 1;
      writes.push(writeFile(join(sessionEventsDir, `${String(seq).padStart(9, '0')}.json`), JSON.stringify({
        seq,
        timestamp,
        type: isMessage ? 'message' : 'tool_use',
        role: isMessage ? (seq % 4 === 1 ? 'user' : 'assistant') : undefined,
        content: isMessage ? `file-event ${seq}` : undefined,
        toolName: isMessage ? undefined : 'shell',
      })));
    }
    await Promise.all(writes);

    const first = await getHistorySnapshot(sessionId);
    assert.equal(first.activeMessageCount, 37, 'active count should include only messages after activeFromSeq');

    __resetHistoryReadStatsForTest();
    const second = await getHistorySnapshot(sessionId);
    assert.equal(second.activeMessageCount, 37, 'memoized count should return the same result');
    const memoized = getHistoryReadStats();
    assert.equal(memoized.eventFileReads, 0, 'memoized count should read no files');
    assert.equal(memoized.eventCacheHits, 0, 'memoized count should not touch the event cache at all');
  }

  // --- 8. old API compatibility across the read surface ---
  {
    const sessionId = nextSessionId();
    const events = buildEvents(80);
    events.push({ type: 'tool_use', id: 'last-tool', toolName: 'shell', toolInput: 'echo done' });
    await appendEvents(sessionId, events);

    const full = await readEventsAfter(sessionId, 0);
    assert.equal(full.length, 81, 'readEventsAfter without limit should return everything');

    const limited = await readEventsAfter(sessionId, 30, { limit: 50 });
    assert.equal(limited.length, 50);
    assert.equal(limited[0].seq, 31);

    const meta = await loadMeta(sessionId);
    const lastTurn = await readLastTurnEvents(sessionId);
    assert.ok(lastTurn.length >= 1, 'readLastTurnEvents should return the final turn');
    assert.equal(lastTurn.at(-1).seq, meta.latestSeq, 'readLastTurnEvents should end at the latest event');
    assert.equal(lastTurn.at(-1).type, 'tool_use');

    const found = await findLatestAssistantMessage(sessionId, {
      match: (event) => event.content.includes('message 60'),
    });
    assert.equal(found.seq, 61, 'findLatestAssistantMessage should honour the match predicate');

    const history = await loadHistory(sessionId);
    assert.equal(history.length, 81, 'loadHistory should return the full range');
    assert.equal(history[0].content, 'message 0', 'loadHistory default includeBodies should hydrate inline bodies');
  }

  console.log(`history read-concurrency: all ${sessionCounter} sessions passed`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
