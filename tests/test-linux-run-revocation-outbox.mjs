import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinuxRunRevocationOutboxRecovery } from '../chat/linux-run-revocation-outbox.mjs';

test('outbox retries failures fairly and acknowledges only root-confirmed revocation', async () => {
  const records = [1, 2, 3].map((n) => ({ runId: `run_fixture${n}`, launchAttempt: n }));
  const seen = [], acknowledged = [];
  let online = false;
  const recover = createLinuxRunRevocationOutboxRecovery({ list: async () => ({ records, invalid: 1 }),
    revoke: async (run) => { seen.push(run.id); return { state: online ? 'revoked' : 'unavailable' }; },
    acknowledge: async (id, attempt) => { acknowledged.push({ id, attempt }); } });
  assert.deepEqual(await recover({ limit: 2 }), { attempted: 2, revoked: 0, invalid: 1 });
  assert.deepEqual(await recover({ limit: 2 }), { attempted: 2, revoked: 0, invalid: 1 });
  assert.ok(seen.includes('run_fixture3'));
  assert.equal(acknowledged.length, 0);
  online = true;
  assert.deepEqual(await recover({ limit: 2 }), { attempted: 2, revoked: 2, invalid: 1 });
  assert.equal(acknowledged.length, 2);
});
