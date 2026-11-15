import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContinuityStore } from '../chat/continuity-store.mjs';
import { createInitialContinuityState, reduceContinuityEvents } from '../chat/continuity-core.mjs';

const root = await mkdtemp(join(tmpdir(), 'ragent-continuity-'));
try {
  const store = createContinuityStore({ historyDir: root });
  const state1 = reduceContinuityEvents('s1', [{ seq: 1, type: 'message', role: 'user', content: 'goal' }]);
  const saved1 = await store.write('s1', state1, { expectedRevision: 0 });
  assert.equal(saved1.revision, 1);
  assert.equal((await store.read('s1')).revision, 1);
  await assert.rejects(() => store.write('s1', reduceContinuityEvents('s1', [{ seq: 1, type: 'message', role: 'user', content: 'other' }, { seq: 2, type: 'status', content: 'ready' }]), { expectedRevision: 0 }), /CAS failed/);
  const state2 = reduceContinuityEvents('s1', [{ seq: 1, type: 'message', role: 'user', content: 'goal' }, { seq: 2, type: 'status', content: 'ready' }]);
  const saved2 = await store.write('s1', state2, { expectedRevision: 1 });
  assert.equal(saved2.revision, 2);
  assert.ok((await readFile(store.pathFor('s1'), 'utf8')).includes('schemaVersion'));
  const same = await store.write('s1', state2, { expectedRevision: 2 });
  assert.equal(same.revision, 2);
  assert.equal(same.savedAt, saved2.savedAt, 'same checkpoint is idempotent');
  const initial = createInitialContinuityState('legacy');
  await import('node:fs/promises').then(({ writeFile, mkdir }) => mkdir(join(root, 'legacy'), { recursive: true }).then(() => writeFile(join(root, 'legacy', 'continuity.json'), JSON.stringify({ compactedThroughSeq: 4, summary: 'old' }))));
  const migrated = await store.read('legacy');
  assert.equal(migrated.revision, 4);
  assert.equal(migrated.coverage.coveredThroughSeq, 4);
  assert.equal(initial.sessionId, 'legacy');
  assert.ok(JSON.parse(await readFile(store.pathFor('legacy'), 'utf8')).schemaVersion, 'migration is durable');
  const restored = createContinuityStore({ historyDir: root });
  assert.deepEqual(await restored.read('legacy'), migrated, 'a new store rereads the migrated checkpoint');
  const storeA = createContinuityStore({ historyDir: root });
  const storeB = createContinuityStore({ historyDir: root });
  const concurrentStateA = reduceContinuityEvents('race', [{ seq: 1, type: 'message', role: 'user', content: 'writer-a' }]);
  const concurrentStateB = reduceContinuityEvents('race', [{ seq: 1, type: 'message', role: 'user', content: 'writer-b' }]);
  const concurrent = await Promise.allSettled([
    storeA.write('race', concurrentStateA, { expectedRevision: 0 }),
    storeB.write('race', concurrentStateB, { expectedRevision: 0 }),
  ]);
  assert.equal(concurrent.filter((entry) => entry.status === 'fulfilled').length, 1, 'cross-store stale writer must lose CAS');
  assert.equal(concurrent.filter((entry) => entry.status === 'rejected').length, 1, 'cross-store stale writer must be rejected');
  assert.equal((await storeA.read('race')).revision, 1, 'cross-store race leaves one valid checkpoint');
  console.log('test-continuity-store: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
