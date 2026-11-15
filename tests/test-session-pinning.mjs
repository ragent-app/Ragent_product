#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-session-pinning-'));

process.env.HOME = tempHome;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const history = await import(
  pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href
);

const {
  createSession,
  deleteSession,
  listSessions,
  setSessionPinned,
  updateSessionGrouping,
  killAll,
} = sessionManager;
const { appendEvents } = history;

const baseFolder = join(tempHome, 'workspace');

const older = await createSession(baseFolder, 'codex', 'Older session');
await new Promise((resolve) => setTimeout(resolve, 25));
const newer = await createSession(baseFolder, 'codex', 'Newer session');

let listed = await listSessions();
assert.deepEqual(
  listed.slice(0, 2).map((session) => session.id),
  [newer.id, older.id],
  'newer sessions should sort first before pinning',
);

const pinned = await setSessionPinned(older.id, true);
assert.equal(pinned?.pinned, true, 'pinning should persist the pinned flag');

listed = await listSessions();
assert.deepEqual(
  listed.slice(0, 2).map((session) => session.id),
  [older.id, newer.id],
  'pinned sessions should sort ahead of newer unpinned sessions',
);

const unpinned = await setSessionPinned(older.id, false);
assert.equal(unpinned?.pinned, undefined, 'unpinning should clear the pinned flag');

listed = await listSessions();
assert.deepEqual(
  listed.slice(0, 2).map((session) => session.id),
  [newer.id, older.id],
  'unpinned sessions should return to normal recency ordering',
);

const repinned = await setSessionPinned(older.id, true);
assert.equal(repinned?.pinned, true, 'unpinned sessions can be pinned again');

const unpinnedAgain = await setSessionPinned(older.id, false);
assert.equal(unpinnedAgain?.pinned, undefined, 'pinned sessions can be unpinned before later ordering checks');

await updateSessionGrouping(older.id, { sidebarOrder: 1 });
await updateSessionGrouping(newer.id, { sidebarOrder: 2 });
await appendEvents(newer.id, [
  {
    type: 'message',
    role: 'user',
    content: 'newer conversation activity',
    timestamp: new Date(Date.now() + 60_000).toISOString(),
  },
]);

listed = await listSessions();
assert.deepEqual(
  listed.slice(0, 2).map((session) => session.id),
  [newer.id, older.id],
  'sessions with the latest conversation activity should sort ahead of explicit sidebar order',
);

const deleted = await deleteSession(older.id);
assert.equal(deleted?.id, older.id, 'direct deletion returns the deleted session id');
listed = await listSessions();
assert.ok(!listed.some((session) => session.id === older.id), 'deleted session is removed from the session list');
assert.ok(listed.some((session) => session.id === newer.id), 'deleting one session preserves other sessions');

killAll();
rmSync(tempHome, { recursive: true, force: true });

console.log('test-session-pinning: ok');
