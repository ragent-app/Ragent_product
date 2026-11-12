// Persist a stable scope for each exact shared grant, so a retry or finalize
// cannot settle another account's upload or revive a revoked authorization.
export function fileAssetAccountContext(session) {
  if (!session?.workspaceAccess) return { principalScope: 'owner', quotaOptions: {} };
  const { ownerAccountId, grantId } = session.workspaceAccess;
  if (session.role !== 'owner' || session.principalKind !== 'trusted_device'
    || typeof session.deviceId !== 'string' || !session.deviceId
    || typeof session.accountId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(session.accountId)
    || typeof ownerAccountId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(ownerAccountId)
    || ownerAccountId === session.accountId || typeof grantId !== 'string' || !/^iag_[A-Za-z0-9_-]{16,128}$/.test(grantId)) {
    throw Object.assign(new Error('Invalid workspace upload identity'), { code: 'PERMISSION_DENIED', statusCode: 403 });
  }
  return { principalScope: JSON.stringify(['workspace-account', ownerAccountId, session.accountId, grantId]),
    quotaOptions: { expectedAccountId: session.accountId, workspacePrincipal: session } };
}

export function canAccessFileAssetUpload(session, asset, { allowLegacy = false } = {}) {
  if (!asset?.uploadRequest) return allowLegacy && !session?.workspaceAccess;
  try { return asset.uploadRequest.principalScope === fileAssetAccountContext(session).principalScope; }
  catch { return false; }
}
