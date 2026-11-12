import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ragent-bootstrap-preserve-'));
process.env.HOME = root;
process.env.AGENTOC_INSTANCE_ROOT = join(root, 'guest');
process.env.AGENTOC_CONFIG_DIR = join(root, 'guest', 'config');
process.env.AGENTOC_MEMORY_DIR = join(root, 'guest', 'memory');
try {
  const { createSession, getSession } = await import('../chat/session-manager.mjs');
  const { appendEvents, readEventsAfter } = await import('../chat/history.mjs');
  const { messageEvent } = await import('../chat/normalizer.mjs');
  const { backfillOwnerBootstrapSessions } = await import('../chat/bootstrap-sessions.mjs');
  const original = await createSession(root, 'codex', 'My migration notes', {
    externalTriggerId: 'owner_bootstrap:guide:guest_local_migration', sourceId: 'chat', sourceName: 'Chat',
  });
  await appendEvents(original.id, [messageEvent('user', 'Keep my custom migration notes.')]);
  await backfillOwnerBootstrapSessions();
  await backfillOwnerBootstrapSessions();
  assert.ok(await getSession(original.id), 'restore must not delete an edited guide');
  const events = await readEventsAfter(original.id, 0, { includeBodies: true });
  assert.ok(events.some(event => event.content === 'Keep my custom migration notes.'));
  console.log('test-bootstrap-preserves-user-session: ok');
} finally {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('ragent-bootstrap-preserve-'));
  rmSync(root, { recursive: true, force: true });
}
