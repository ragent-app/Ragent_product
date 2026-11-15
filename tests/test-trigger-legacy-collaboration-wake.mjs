import assert from 'assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const configDir = await mkdtemp(join(tmpdir(), 'ragent-legacy-collaboration-trigger-'));
process.env.RAGENT_CONFIG_DIR = configDir;

try {
  const { CHAT_TRIGGERS_FILE } = await import('../lib/config.mjs');
  await mkdir(dirname(CHAT_TRIGGERS_FILE), { recursive: true });
  await writeFile(CHAT_TRIGGERS_FILE, JSON.stringify([{
    id: 'trg_000000000000000000000001',
    triggerType: 'event',
    actionType: 'session_message',
    status: 'pending',
    enabled: true,
    title: 'Collaboration finished: collab_legacy',
    sessionId: 'root-session',
    text: 'Collaboration collab_legacy finished. Review child results and continue.',
    requestId: 'trigger:trg_000000000000000000000001',
    dedupeKey: 'collaboration-terminal:collab_legacy',
    eventType: 'collaboration_terminal',
    eventFilter: { collaborationId: 'collab_legacy' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deliveryAttempts: 0,
    occurrence: 0,
    deliveredEventKeys: [],
    repeat: false,
  }], null, 2));

  const { listTriggers } = await import('../chat/triggers.mjs');
  const [trigger] = await listTriggers();
  assert.ok(trigger, 'legacy trigger should remain auditable after migration');
  assert.equal(trigger.enabled, false, 'legacy automatic collaboration wake must be disabled');
  assert.equal(trigger.status, 'cancelled');
  assert.equal(trigger.inputMode, 'user_message', 'migration must not silently reinterpret owner trigger semantics');
  assert.match(trigger.lastError, /Retired legacy collaboration wake/);

  const stored = JSON.parse(await readFile(CHAT_TRIGGERS_FILE, 'utf8'));
  assert.equal(stored[0].enabled, false, 'migration must persist the disablement before any event delivery');
  assert.equal(stored[0].status, 'cancelled');

  console.log('test-trigger-legacy-collaboration-wake: ok');
} finally {
  await rm(configDir, { recursive: true, force: true });
}
