#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-cache-eviction-'));
const previousHome = process.env.HOME;
process.env.HOME = home;

try {
  const {
    __setCacheLimitsForTest,
    appendEvent,
    loadHistory,
    readEventBody,
  } = await import('../chat/history.mjs');

  // Shrink the caps so eviction is exercised without GBs of data: the event
  // cache holds 5 events, the body cache holds 5 externalized bodies.
  const sizes = __setCacheLimitsForTest({ eventCache: { maxEntries: 5 }, bodyCache: { maxEntries: 5 } });
  assert.equal(sizes.eventCacheSize, 0);
  assert.equal(sizes.bodyCacheSize, 0);

  const sessionId = 'session_cache_eviction';
  const messageContents = [];
  const reasoningContents = [];
  for (let i = 0; i < 10; i += 1) {
    const messageText = `message-${i}-${'m'.repeat(20)}`;
    const reasoningText = `reasoning-${i}-${'r'.repeat(200)}`; // reasoning is always externalized to a body file
    await appendEvent(sessionId, { type: 'message', role: 'assistant', content: messageText });
    messageContents.push(messageText);
    await appendEvent(sessionId, { type: 'reasoning', content: reasoningText });
    reasoningContents.push(reasoningText);
  }

  const { eventCacheSize, bodyCacheSize } = __setCacheLimitsForTest({});
  assert.ok(eventCacheSize <= 5, `event cache stays bounded (${eventCacheSize} entries)`);
  assert.ok(bodyCacheSize <= 5, `body cache stays bounded (${bodyCacheSize} entries)`);

  // Re-reading must return identical payloads even though most entries were
  // evicted — every miss re-reads the event file / body file from disk.
  const events = await loadHistory(sessionId, { includeBodies: true });
  const messages = events.filter((event) => event.type === 'message');
  const reasonings = events.filter((event) => event.type === 'reasoning');
  assert.equal(messages.length, 10, 'all messages survive eviction + re-read');
  assert.equal(reasonings.length, 10, 'all reasoning events survive eviction + re-read');
  assert.deepEqual(
    messages.map((event) => event.content),
    messageContents,
    'message payloads byte-identical after eviction',
  );
  assert.deepEqual(
    reasonings.map((event) => event.content),
    reasoningContents,
    'externalized reasoning bodies byte-identical after eviction',
  );

  // readEventBody directly hits the body cache / disk fallback.
  const firstReasoningSeq = events.find((event) => event.type === 'reasoning').seq;
  const direct = await readEventBody(sessionId, firstReasoningSeq);
  assert.equal(direct.value, reasoningContents[0], 'readEventBody returns the body after cache eviction');
  assert.equal(direct.bytes, Buffer.byteLength(reasoningContents[0], 'utf8'), 'body byte count intact');

  // Evicted-then-touched entries stay correct across further writes.
  await appendEvent(sessionId, { type: 'message', role: 'user', content: 'one more' });
  const afterAppend = await loadHistory(sessionId, { includeBodies: false });
  assert.equal(afterAppend.at(-1).content, 'one more', 'new append lands after eviction churn');

  console.log('test-history-cache-eviction: ok');
} finally {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
