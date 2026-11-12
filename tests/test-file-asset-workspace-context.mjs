import test from 'node:test';
import assert from 'node:assert/strict';
import { fileAssetAccountContext, canAccessFileAssetUpload } from '../chat/file-asset-account-context.mjs';
import { accountFileUploadMaximumBytes } from '../chat/file-asset-account-policy.mjs';
import { MAX_STABLE_UPLOAD_BYTES } from '../chat/file-asset-upload-checkpoints.mjs';

test('shared upload scope isolates members and exact grants and selects their quota', async () => {
  const session = { role: 'owner', principalKind: 'trusted_device', deviceId: 'device_fixture', accountId: 'acct_member_fixture',
    workspaceAccess: { ownerAccountId: 'acct_owner_fixture', grantId: `iag_${'a'.repeat(24)}` } };
  const context = fileAssetAccountContext(session);
  const asset = { uploadRequest: { principalScope: context.principalScope } };
  assert.equal(canAccessFileAssetUpload(session, asset), true);
  assert.equal(canAccessFileAssetUpload({ ...session, accountId: 'acct_other_fixture' }, asset), false);
  assert.equal(canAccessFileAssetUpload({ ...session, workspaceAccess: { ...session.workspaceAccess, grantId: `iag_${'b'.repeat(24)}` } }, asset), false);
  assert.equal(canAccessFileAssetUpload({ role: 'owner' }, asset), false);
  assert.equal(canAccessFileAssetUpload(session, { uploadRequest: { principalScope: 'owner' } }), false);
  assert.equal(canAccessFileAssetUpload(session, {}), false);
  let requested;
  const options = { getBinding: async () => ({ accountId: 'acct_owner_fixture' }), getPolicy: async input => {
    requested = input; return { contractVersion: 2, limits: { unlimited: true, maxFileBytes: Number.MAX_SAFE_INTEGER } };
  } };
  assert.equal(await accountFileUploadMaximumBytes(session, options), Number.MAX_SAFE_INTEGER);
  assert.equal(requested.expectedAccountId, session.accountId);
  assert.equal(requested.workspacePrincipal, session);
  assert.equal(await accountFileUploadMaximumBytes({ ...session, principalKind: 'device_handshake' }, options), MAX_STABLE_UPLOAD_BYTES);
  assert.equal(await accountFileUploadMaximumBytes({ ...session, workspaceAccess: { ...session.workspaceAccess, ownerAccountId: 'acct_other_owner' } }, options), MAX_STABLE_UPLOAD_BYTES);
});
