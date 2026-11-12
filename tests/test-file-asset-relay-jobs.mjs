import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createFileAssetRelayJobs } from '../chat/file-asset-relay-jobs.mjs';

const asset = { id: `fasset_${'a'.repeat(24)}`, status: 'pending_upload', sizeBytes: 5, storage: { provider: 'local' } };
const request = { asset, accountsBaseUrl: 'https://accounts.example', relayId: 'a'.repeat(32),
  transferId: 'b'.repeat(32), readToken: 'c'.repeat(43), key: Buffer.alloc(32, 3).toString('base64url'),
  scopeCondition: { expectedScopeRevision: 1 } };

test('job keeps capabilities private and publishes only after scoped ingestion', async () => {
  let release, observed;
  const ready = new Promise(resolve => { release = resolve; });
  const jobs = createFileAssetRelayJobs({ open: async () => { await ready; return 'stream'; },
    ingest: async (id, input, options) => { observed = { id, input, scope: options.scopeCondition }; } });
  const job = jobs.start(request);
  assert.deepEqual(Object.keys(job).sort(), ['jobId', 'status', 'version']);
  assert.equal(job.status, 'receiving');
  assert.throws(() => jobs.start(request));
  assert.equal(jobs.status(asset.id, '0'.repeat(32)), null);
  release(); await tick();
  assert.deepEqual(observed, { id: asset.id, input: 'stream', scope: request.scopeCondition });
  assert.equal(jobs.status(asset.id, job.jobId).status, 'received');
  jobs.forgetReceived(asset.id);
  assert.equal(jobs.status(asset.id, job.jobId), null);
});

test('cancel aborts an active fetch and releases capacity', async () => {
  const jobs = createFileAssetRelayJobs({ maxJobs: 1, open: ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const job = jobs.start(request);
  const waited = jobs.waitForReceived(asset.id);
  assert.equal((await jobs.cancel(asset.id, job.jobId)).status, 'cancelled');
  await assert.rejects(waited, { code: 'FILE_ASSET_RELAY_FAILED' });
  const replacement = jobs.start(request);
  assert.equal((await jobs.cancel(asset.id, replacement.jobId)).status, 'cancelled');
});
