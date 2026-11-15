#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'ragent-history-strict-'));
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = join(home, '.config', 'ragent');
process.env.RAGENT_MEMORY_DIR = join(home, 'memory');
process.env.RAGENT_WORK_ROOT_DIR = join(home, 'workspace');
process.env.RAGENT_INSTANCE_ROOT = home;

const { CHAT_HISTORY_DIR } = await import('../lib/config.mjs');
const { appendEvent, loadMeta, readEventBody, readEventsPage } = await import('../chat/history.mjs');

try {
  const emptySessionId = `strict-empty-${process.pid}-${Date.now()}`;
  const emptyMeta = await loadMeta(emptySessionId, { strict: true });
  assert.equal(emptyMeta.latestSeq, 0, 'a brand-new empty session has a valid empty history');

  const orphanSessionId = `strict-orphan-${process.pid}-${Date.now()}`;
  const orphanEventsDir = join(CHAT_HISTORY_DIR, orphanSessionId, 'events');
  mkdirSync(orphanEventsDir, { recursive: true });
  writeFileSync(join(orphanEventsDir, '000000002.json'), JSON.stringify({ seq: 2 }), 'utf8');
  await assert.rejects(
    () => loadMeta(orphanSessionId, { strict: true }),
    (error) => error.code === 'SESSION_HISTORY_GAP' && error.seq === 2,
  );

  const sessionId = `strict-read-${process.pid}-${Date.now()}`;
  const first = await appendEvent(sessionId, {
    type: 'message',
    role: 'user',
    content: 'hello',
  });
  const metaPath = join(CHAT_HISTORY_DIR, sessionId, 'meta.json');
  const eventPath = join(CHAT_HISTORY_DIR, sessionId, 'events', `${String(first.seq).padStart(9, '0')}.json`);

  const meta = await loadMeta(sessionId, { strict: true });
  assert.equal(meta.latestSeq, first.seq);
  assert.ok(Number.isInteger(meta.historyRevision));

  writeFileSync(metaPath, '{broken', 'utf8');
  await assert.rejects(
    () => loadMeta(sessionId, { strict: true }),
    (error) => error.code === 'SESSION_HISTORY_CORRUPT' && error.stage === 'history',
  );

  // Restore metadata, then verify a missing event is reported as a gap rather
  // than silently filtered out of a successful page.
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  assert.equal(await readEventBody(sessionId, first.seq + 1, { strict: true }), null, 'future sequence is absent, not a gap');
  rmSync(eventPath);
  await assert.rejects(
    () => readEventBody(sessionId, first.seq, { strict: true }),
    (error) => error.code === 'SESSION_HISTORY_GAP' && error.seq === first.seq,
  );
  await assert.rejects(
    () => readEventsPage(sessionId, { limit: 10, direction: 'latest', strict: true }),
    (error) => error.code === 'SESSION_HISTORY_GAP' && error.seq === first.seq,
  );
  writeFileSync(eventPath, JSON.stringify(first, null, 2), 'utf8');

  // Strict body reads must bypass the body cache as well. Populate a cached
  // externalized body, corrupt its durable compressed file, and ensure the
  // next strict page reports corruption instead of returning the old value.
  const bodyEvent = await appendEvent(sessionId, {
    type: 'message',
    role: 'assistant',
    content: 'x'.repeat(70_000),
  });
  await readEventsPage(sessionId, {
    limit: 10,
    direction: 'latest',
    includeMessageBodies: true,
    strict: true,
  });
  const bodyDir = join(CHAT_HISTORY_DIR, sessionId, 'bodies');
  const bodyFile = readdirSync(bodyDir).find((name) => name.startsWith(bodyEvent.bodyRef) && name.endsWith('.gz'));
  assert.ok(bodyFile, 'large message should have a compressed body file');
  writeFileSync(join(bodyDir, bodyFile), 'corrupt-body', 'utf8');
  await assert.rejects(
    () => readEventsPage(sessionId, {
      limit: 10,
      direction: 'latest',
      includeMessageBodies: true,
      strict: true,
    }),
    (error) => error.code === 'SESSION_HISTORY_BODY_CORRUPT' && error.bodyRef === bodyEvent.bodyRef,
  );

  console.log('history-strict-read: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
