import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFileUploadMaximumBytes } from '../chat/file-asset-account-policy.mjs';
import { MAX_STABLE_UPLOAD_BYTES } from '../chat/file-asset-upload-checkpoints.mjs';

test('upload capability requires a fresh unlimited policy for the bound owner', async () => {
  const owner = { role: 'owner', accountId: 'account-a' };
  let calls = 0;
  const options = {
    getBinding: async () => ({ accountId: 'account-a', plan: 'test' }),
    getPolicy: async () => { calls++; return { contractVersion: 2,
      limits: { unlimited: true, maxFileBytes: Number.MAX_SAFE_INTEGER } }; },
  };
  assert.equal(await accountFileUploadMaximumBytes(owner, options), Number.MAX_SAFE_INTEGER);
  assert.equal(await accountFileUploadMaximumBytes({ ...owner, accountId: 'account-b' }, options), MAX_STABLE_UPLOAD_BYTES);
  assert.equal(await accountFileUploadMaximumBytes({ ...owner, principalKind: 'run_capability' }, options), MAX_STABLE_UPLOAD_BYTES);
  assert.equal(calls, 1, 'mismatched principals never consult policy');
  for (const policy of [null, { contractVersion: 1, limits: { unlimited: true, maxFileBytes: Number.MAX_SAFE_INTEGER } },
    { contractVersion: 2, limits: { unlimited: true, maxFileBytes: 1024 } },
    { contractVersion: 2, limits: { unlimited: false, maxFileBytes: Number.MAX_SAFE_INTEGER } }]) {
    assert.equal(await accountFileUploadMaximumBytes(owner, { ...options, getPolicy: async () => policy }), MAX_STABLE_UPLOAD_BYTES);
  }
  assert.equal(await accountFileUploadMaximumBytes(owner, { ...options, getPolicy: async () => { throw new Error('offline'); } }), MAX_STABLE_UPLOAD_BYTES);
  assert.equal(await accountFileUploadMaximumBytes(owner, { ...options, getBinding: async () => null }), MAX_STABLE_UPLOAD_BYTES);
});
