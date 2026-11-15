#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ragent-delete-legacy-'));
process.env.HOME = home;
process.env.RAGENT_PUBLIC_BASE_URL = '';

const configDir = path.join(home, '.config', 'ragent');
const sessionId = 'session_legacy_archived';
const runId = 'run_legacy_archived';
const now = new Date().toISOString();

await fs.mkdir(path.join(configDir, 'chat-history', sessionId), { recursive: true });
await fs.mkdir(path.join(configDir, 'chat-runs', runId), { recursive: true });
await fs.writeFile(path.join(configDir, 'chat-sessions.json'), JSON.stringify([{
  id: sessionId,
  folder: home,
  tool: 'codex',
  name: 'Legacy archived session',
  created: now,
  updatedAt: now,
  archived: true,
  archivedAt: now,
}], null, 2));
await fs.writeFile(path.join(configDir, 'chat-history', sessionId, 'meta.json'), JSON.stringify({ latestSeq: 0 }));
await fs.writeFile(path.join(configDir, 'chat-runs', runId, 'status.json'), JSON.stringify({
  id: runId,
  sessionId,
  state: 'completed',
  createdAt: now,
  updatedAt: now,
}));

const { purgeLegacyArchivedSessions } = await import('../chat/session-manager.mjs');

try {
  const cleanup = await purgeLegacyArchivedSessions();
  assert.deepEqual(cleanup, { deletedSessionIds: [sessionId], skippedSessionIds: [] });

  const stored = JSON.parse(await fs.readFile(path.join(configDir, 'chat-sessions.json'), 'utf8'));
  assert.equal(stored.some((session) => session?.id === sessionId), false, 'legacy session meta is removed');
  await assert.rejects(fs.stat(path.join(configDir, 'chat-history', sessionId)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(configDir, 'chat-runs', runId)), { code: 'ENOENT' });
  console.log('test-session-delete-legacy-archive: ok');
} finally {
  await fs.rm(home, { recursive: true, force: true });
}
