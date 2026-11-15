#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'ragent-collaboration-propagation-'));
const configDir = join(home, '.config', 'ragent');
const memoryDir = join(home, '.ragent', 'memory');
const workspace = join(home, 'workspace');
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_MEMORY_DIR = memoryDir;
process.env.RAGENT_WORK_ROOT_DIR = workspace;
process.env.RAGENT_AUTH_SESSION_SECRET = 'test-collaboration-propagation-secret';
process.env.RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
process.env.RAGENT_MEMORY_WRITEBACK = 'off';
mkdirSync(configDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(workspace, { recursive: true });

async function removeTreeAfterDetachedWritersSettle(path, attempts = 20) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      // A failed/missing harness can still be finishing its detached result
      // write after killAll() clears the observer. Retry only transient
      // directory races; preserve unrelated cleanup errors.
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (lastError) throw lastError;
}

const {
  createSession,
  killAll,
  submitHttpMessage,
} = await import('../chat/session-manager.mjs');
const { createApp } = await import('../chat/apps.mjs');
const { getRunManifest } = await import('../chat/runs.mjs');

try {
  const manager = await createApp({
    name: 'Manager capability test',
    tool: 'missing-tool',
    collaborationPolicy: { role: 'manager', canDelegate: true },
  });
  const specialist = await createApp({
    name: 'Specialist capability test',
    tool: 'missing-tool',
    collaborationPolicy: { role: 'specialist', canDelegate: false },
  });

  const managerSession = await createSession(workspace, 'missing-tool', 'Manager session', {
    templateId: manager.id,
  });
  const managerOutcome = await submitHttpMessage(managerSession.id, 'Create one bounded collaboration.', [], {
    requestId: 'propagation-manager-turn',
    queueIfBusy: false,
  });
  const managerManifest = await getRunManifest(managerOutcome.run.id);
  const managerCapabilities = managerManifest?.options?.collaborationCapabilities || [];
  assert.deepEqual(
    managerCapabilities.map((entry) => entry.operation),
    ['collaboration.read', 'collaboration.create', 'collaboration.dispatch', 'collaboration.retry', 'collaboration.cancel'],
    'manager root Run receives the exact collaboration operation set',
  );
  assert.ok(managerCapabilities.every((entry) => entry.resourceType === undefined), 'manifest records keep resource in signed token payload');
  assert.ok(managerCapabilities.every((entry) => entry.resource?.type === 'session'), 'manager capability is session-scoped');
  assert.ok(managerCapabilities.every((entry) => entry.resource?.id === managerSession.id), 'manager capability is bound to the current session');

  const specialistSession = await createSession(workspace, 'missing-tool', 'Specialist session', {
    templateId: specialist.id,
  });
  const specialistOutcome = await submitHttpMessage(specialistSession.id, 'Do bounded specialist work.', [], {
    requestId: 'propagation-specialist-turn',
    queueIfBusy: false,
  });
  const specialistManifest = await getRunManifest(specialistOutcome.run.id);
  assert.equal(specialistManifest?.options?.collaborationCapabilities, undefined, 'specialist Run receives no collaboration control capability');

  const childOutcome = await submitHttpMessage(managerSession.id, 'Inspect this collaboration only.', [], {
    requestId: 'propagation-child-turn',
    queueIfBusy: false,
    internalOperation: 'collaboration_task',
    collaborationCapability: {
      resourceType: 'collaboration',
      resourceId: 'collab_exact',
      rootSessionId: managerSession.id,
    },
  });
  const childManifest = await getRunManifest(childOutcome.run.id);
  const childCapabilities = childManifest?.options?.collaborationCapabilities || [];
  assert.deepEqual(childCapabilities.map((entry) => entry.operation), ['collaboration.read']);
  assert.equal(childCapabilities[0]?.resource?.type, 'collaboration');
  assert.equal(childCapabilities[0]?.resource?.id, 'collab_exact');

  const unboundChildOutcome = await submitHttpMessage(managerSession.id, 'Unbound child marker must fail closed.', [], {
    requestId: 'propagation-unbound-child-turn',
    queueIfBusy: false,
    internalOperation: 'collaboration_task',
  });
  const unboundChildManifest = await getRunManifest(unboundChildOutcome.run.id);
  assert.equal(unboundChildManifest?.options?.collaborationCapabilities, undefined, 'an unbound child marker cannot mint a capability');

  const wrongRootOutcome = await submitHttpMessage(managerSession.id, 'Wrong root must fail closed.', [], {
    requestId: 'propagation-wrong-root-turn',
    queueIfBusy: false,
    internalOperation: 'collaboration_task',
    collaborationCapability: {
      resourceType: 'collaboration',
      resourceId: 'collab_exact',
      rootSessionId: 'unrelated-root',
    },
  });
  const wrongRootManifest = await getRunManifest(wrongRootOutcome.run.id);
  assert.equal(wrongRootManifest?.options?.collaborationCapabilities, undefined, 'a task capability root must be in the server-resolved delegation lineage');
  console.log('test-collaboration-capability-propagation: ok');
} finally {
  killAll();
  await removeTreeAfterDetachedWritersSettle(home);
}
