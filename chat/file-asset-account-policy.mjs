import { getOwnerAccountBinding, getOwnerAccountFileUploadPolicy } from '../lib/owner-account-auth.mjs';
import { MAX_STABLE_UPLOAD_BYTES } from './file-asset-upload-checkpoints.mjs';
import { fileAssetAccountContext } from './file-asset-account-context.mjs';

// A capability is advisory: upload admission still requires an atomic quota
// reservation. Never promote a cached plan or a client-provided value to an
// unlimited allowance, and fail closed if Accounts cannot supply the policy.
export async function accountFileUploadMaximumBytes(authSession, {
  getBinding = getOwnerAccountBinding,
  getPolicy = getOwnerAccountFileUploadPolicy,
} = {}) {
  if (authSession?.role !== 'owner' || authSession.principalKind === 'run_capability') return MAX_STABLE_UPLOAD_BYTES;
  try {
    const binding = await getBinding();
    if (!binding?.accountId) return MAX_STABLE_UPLOAD_BYTES;
    const context = fileAssetAccountContext(authSession);
    const shared = Boolean(authSession.workspaceAccess);
    if (shared ? authSession.workspaceAccess.ownerAccountId !== binding.accountId
      : (authSession.accountId && authSession.accountId !== binding.accountId)) return MAX_STABLE_UPLOAD_BYTES;
    const policy = await getPolicy(shared ? context.quotaOptions : { expectedAccountId: binding.accountId });
    if (policy?.contractVersion === 2 && policy.limits?.unlimited === true &&
        policy.limits.maxFileBytes === Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  } catch {
    // Older Accounts versions and transient failures retain the default cap.
  }
  return MAX_STABLE_UPLOAD_BYTES;
}
