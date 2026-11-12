import assert from 'node:assert/strict';
import { waitForPrivilegedShimResolution } from '../chat/privileged-shim-wait.mjs';

const pending = {
  id: 'run_qa', state: 'running',
  privilegedShimPending: { batchId: 'pbatch_qa', requestId: 'pshim_qa', expiresAt: '2030-01-01T00:01:00.000Z' },
};
let state = structuredClone(pending), sleeps = 0, reads = 0;
const result = await waitForPrivilegedShimResolution('run_qa', {
  now: () => Date.parse('2030-01-01T00:00:00.000Z'),
  getRunImpl: async () => { if (++reads === 1) throw new Error('transient'); return state; },
  updateRunImpl: async (_id, update) => { state = update(state); return state; },
  sleepImpl: async () => {
    if (++sleeps === 2) {
      assert.equal(state.state, 'waiting_user');
      state = { id: 'run_qa', state: 'waiting_user', privilegedShimResult: { batchId: 'pbatch_qa', status: 'resolved' } };
    }
  },
});
assert.equal(result.privilegedShimResult.status, 'resolved');
assert.equal(sleeps, 2);

for (const [value, expected] of [
  [{ ...pending, cancelRequested: true }, 'cancelled'],
  [pending, 'timeout'],
  [{ ...pending, privilegedShimPending: { ...pending.privilegedShimPending, expiresAt: 'bad' } }, 'timeout'],
]) {
  const valueAfter = await waitForPrivilegedShimResolution('run_qa', {
    now: () => Date.parse('2030-01-01T00:02:00.000Z'),
    getRunImpl: async () => value,
    updateRunImpl: async (_id, update) => update(value),
    sleepImpl: async () => { throw new Error('terminal case must not wait'); },
  });
  assert.equal(valueAfter.privilegedShimPending, undefined);
  assert.equal(valueAfter.privilegedShimResult.status, expected);
}
const noPending = await waitForPrivilegedShimResolution('run_qa', {
  getRunImpl: async () => ({ id: 'run_qa', state: 'running' }),
  sleepImpl: async () => { throw new Error('no request must not wait'); },
});
assert.equal(noPending.id, 'run_qa');
console.log('privileged shim waits for review and terminates on cancellation or deadline');
