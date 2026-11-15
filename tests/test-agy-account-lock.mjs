import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireAgyAccountLock,
  agyAccountLockPath,
  isRecoverableAgyAccountLockOwner,
  listAgyAccountLocks,
} from '../lib/provider-runtime/agy-account-lock.mjs';

const configDir = await mkdtemp(join(tmpdir(), 'ragent-agy-lock-'));
try {
  const first = await acquireAgyAccountLock({ configDir, providerId: 'agy-a', runId: 'run-a' });
  assert.equal(first.ok, true);

  const sameAccount = await acquireAgyAccountLock({ configDir, providerId: 'agy-a', runId: 'run-b' });
  assert.equal(sameAccount.ok, false);
  assert.equal(sameAccount.reason, 'agy-account-busy');
  assert.equal(sameAccount.owner?.runId, 'run-a');
  const listed = await listAgyAccountLocks({ configDir });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.owner?.providerId, 'agy-a');

  const isTerminal = (state) => ['completed', 'failed', 'cancelled'].includes(state);
  assert.equal(
    isRecoverableAgyAccountLockOwner({ state: 'completed', finalizedAt: null }, isTerminal),
    true,
    'a terminal owner must release its account lock even when historical finalization is absent',
  );
  assert.equal(
    isRecoverableAgyAccountLockOwner({ state: 'running' }, isTerminal),
    false,
    'a live owner must retain its account lock',
  );

  const otherAccount = await acquireAgyAccountLock({ configDir, providerId: 'agy-b', runId: 'run-c' });
  assert.equal(otherAccount.ok, true);
  assert.notEqual(agyAccountLockPath(configDir, 'agy-a'), agyAccountLockPath(configDir, 'agy-b'));

  const adopted = await acquireAgyAccountLock({ configDir, providerId: 'agy-a', runId: 'run-a' });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.adopted, true);

  await first.release();
  await otherAccount.release();
  await adopted.release();
} finally {
  await rm(configDir, { recursive: true, force: true });
}

console.log('test-agy-account-lock: same-account exclusion, cross-account parallelism, and adoption OK');
