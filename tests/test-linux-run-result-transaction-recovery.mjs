import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinuxRunResultTransactionRecovery } from '../chat/linux-run-result-transaction-recovery.mjs';

test('transaction recovery rotates failed entries and counts only removed journals', async () => {
  const records = [1, 2, 3].map((n) => ({ runId: `run_fixture${n}`, launchAttempt: n }));
  const seen = [], removed = new Set();
  let available = false;
  const recover = createLinuxRunResultTransactionRecovery({ list: async () => ({ records, invalid: 1 }),
    recoverResult: async (id) => { seen.push(id); if (available) removed.add(id); else throw new Error('offline'); },
    remains: async (id) => !removed.has(id) });
  assert.deepEqual(await recover({ limit: 2 }), { attempted: 2, recovered: 0, invalid: 1 });
  assert.deepEqual(await recover({ limit: 2 }), { attempted: 2, recovered: 0, invalid: 1 });
  assert.ok(seen.includes('run_fixture3'));
  available = true;
  assert.deepEqual(await recover({ limit: 2 }), { attempted: 2, recovered: 2, invalid: 1 });
});
