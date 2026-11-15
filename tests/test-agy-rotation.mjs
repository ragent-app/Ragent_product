#!/usr/bin/env node
// Focused contract for the instance-local AgY round-robin account pool.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgyRotationStore } from '../lib/provider-runtime/agy-rotation.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-agy-rotation-'));
const profiles = [
  { id: 'agy-a', agentType: 'agy', enabled: true, status: 'ready' },
  { id: 'agy-b', agentType: 'agy', enabled: true, status: 'ready' },
  { id: 'agy-disabled', agentType: 'agy', enabled: false, status: 'ready' },
];

try {
  const store = createAgyRotationStore({ configDir: join(root, 'config') });
  await assert.rejects(
    () => store.update({ enabled: true, providerIds: ['agy-disabled'] }, profiles),
    (error) => error.code === 'AGY_ROTATION_PROVIDER_INVALID',
  );

  const configured = await store.update({ enabled: true, providerIds: ['agy-a', 'agy-b'] }, profiles);
  assert.deepEqual(configured.providerIds, ['agy-a', 'agy-b']);
  assert.equal((await store.selectNext(profiles)).id, 'agy-a');
  assert.equal((await store.selectNext(profiles)).id, 'agy-b');
  assert.equal((await store.selectNext(profiles)).id, 'agy-a');

  profiles[1].status = 'disabled';
  assert.equal((await store.selectNext(profiles)).id, 'agy-a', 'disabled profiles must be skipped');
  profiles[0].status = 'needs-login';
  assert.equal(await store.selectNext(profiles), null, 'rotation must fail closed when no account is ready');

  console.log('test-agy-rotation: round-robin cursor, validation, and ready-profile filtering OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
