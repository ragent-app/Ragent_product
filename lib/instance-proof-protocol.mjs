// Instance proof wire protocol shared by the local control plane and Accounts.
// It intentionally has no runtime-path or local-state dependency so Accounts
// can be released as a separate service artifact.
import { createHash, createPublicKey, verify } from 'node:crypto';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function createInstancePublicKeyFingerprint(publicKey) {
  return createHash('sha256')
    .update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

export function buildInstanceProofMessage({
  instanceId,
  transactionId,
  purpose,
  returnUrl,
  issuedAt,
  audience = 'agentoc-owner-auth',
}) {
  return [
    'agentoc-instance-proof-v1',
    trimString(instanceId),
    trimString(transactionId),
    trimString(purpose),
    trimString(returnUrl),
    trimString(issuedAt),
    trimString(audience) || 'agentoc-owner-auth',
  ].join('\n');
}

export function buildProviderSyncPeerMessage({
  instanceId,
  requestId,
  targetInstanceId,
  issuedAt,
  audience = 'agentoc-provider-sync',
}) {
  return [
    'agentoc-provider-sync-peer-v1',
    trimString(instanceId),
    trimString(requestId),
    trimString(targetInstanceId),
    trimString(issuedAt),
    trimString(audience) || 'agentoc-provider-sync',
  ].join('\n');
}

export function buildAccountRendezvousPollMessage({
  instanceId,
  requestId,
  issuedAt,
  audience = 'agentoc-account-rendezvous-poll',
}) {
  return [
    'agentoc-account-rendezvous-poll-v1',
    trimString(instanceId),
    trimString(requestId),
    trimString(issuedAt),
    trimString(audience) || 'agentoc-account-rendezvous-poll',
  ].join('\n');
}

export function buildNativeOwnerAuthMessage({
  instanceId,
  requestId,
  purpose,
  deviceId,
  devicePublicKeyFingerprint = '',
  deviceAlias = '',
  issuedAt,
  audience = 'agentoc-owner-auth-native',
}) {
  return [
    'agentoc-owner-auth-native-v2',
    trimString(instanceId),
    trimString(requestId),
    trimString(purpose),
    trimString(deviceId),
    trimString(devicePublicKeyFingerprint),
    trimString(deviceAlias),
    trimString(issuedAt),
    trimString(audience) || 'agentoc-owner-auth-native',
  ].join('\n');
}

export function buildOwnerAuthPollMessage({
  instanceId,
  transactionId,
  requestId,
  purpose,
  deliveryMode,
  issuedAt,
  requestPath,
  audience = 'agentoc-owner-auth-poll',
}) {
  return [
    'agentoc-owner-auth-poll-v1',
    trimString(instanceId),
    trimString(transactionId),
    trimString(requestId),
    trimString(purpose),
    trimString(deliveryMode),
    trimString(issuedAt),
    trimString(requestPath),
    trimString(audience) || 'agentoc-owner-auth-poll',
  ].join('\n');
}

export function buildNativeOwnerAuthRollbackMessage({ instanceId, requestId, accountId, deviceId,
  devicePublicKeyFingerprint, expectedRevision, expectedCompletionId, issuedAt, audience = 'agentoc-owner-auth-native-rollback' }) {
  return ['agentoc-native-owner-auth-rollback-v1', instanceId, requestId, accountId, deviceId,
    devicePublicKeyFingerprint, expectedRevision, expectedCompletionId, issuedAt, audience].map(trimString).join('\n');
}

export function buildBindingAuthorityProofMessage({ instanceId, keyFingerprint, requestId, accountId, nonce,
  issuedAt, audience = 'agentoc-binding-authority' }) {
  return ['agentoc-binding-authority-proof-v1', instanceId, keyFingerprint, requestId, accountId,
    nonce, issuedAt, audience].map(trimString).join('\n');
}

export function buildAccountFileUploadQuotaMessage({ instanceId, accountId, operation, requestId,
  quotaBatchId, sizeBytes, sha256, issuedAt, audience = 'agentoc-account-file-upload' }) {
  return ['agentoc-account-file-upload-v2', instanceId, accountId, operation, requestId, quotaBatchId,
    Number.isSafeInteger(sizeBytes) ? String(sizeBytes) : '', sha256, issuedAt, audience].map(trimString).join('\n');
}

export function buildOwnerAuthDeviceMessage({
  instanceId,
  transactionId,
  purpose,
  issuedAt,
  publicEndpoint = '',
  audience = 'agentoc-owner-auth-device',
}) {
  const endpoint = trimString(publicEndpoint);
  return [
    // Endpoint publication is a separately authorized v2 transcript. Keep
    // the v1 transcript byte-for-byte compatible for existing device ops.
    endpoint ? 'agentoc-owner-auth-device-v2' : 'agentoc-owner-auth-device-v1',
    trimString(instanceId),
    trimString(transactionId),
    trimString(purpose),
    trimString(issuedAt),
    trimString(audience) || 'agentoc-owner-auth-device',
    ...(endpoint ? [endpoint] : []),
  ].join('\n');
}

// Every field that selects a durable workspace authorization is signed.
export function buildInstanceAccessGrantMessage({ instanceId, keyFingerprint, ownerAccountId,
  accountId, operation, grantId = '', requestId, issuedAt, audience = 'agentoc-instance-access-grant' }) {
  return ['agentoc-instance-access-grant-v1', instanceId, keyFingerprint, ownerAccountId,
    accountId, operation, grantId, requestId, issuedAt, audience].map(trimString).join('\n');
}

export function buildAccountJoinIntentProofMessage({
  instanceId,
  intentId,
  deviceId,
  devicePublicKeyFingerprint,
  nonce,
  issuedAt,
  audience = 'agentoc-account-join',
  publicEndpoint = '',
}) {
  const endpoint = trimString(publicEndpoint);
  return [
    // Keep the original v1 transcript for an intent with no endpoint.  A
    // claimed computer needs its directory endpoint to be integrity-bound,
    // so the optional v2 transcript signs that extra field explicitly.
    endpoint ? 'agentoc-account-join-proof-v2' : 'agentoc-account-join-proof-v1',
    trimString(instanceId),
    trimString(intentId),
    trimString(deviceId),
    trimString(devicePublicKeyFingerprint),
    trimString(nonce),
    trimString(issuedAt),
    trimString(audience) || 'agentoc-account-join',
    ...(endpoint ? [endpoint] : []),
  ].join('\n');
}

// Cross-device provider credential refresh lease transcript. The full lease
// identity (account + provider family + accountKey + credentialInstanceId) is
// signed so a proof captured for one credential can never be replayed against
// another identity key, and the operation name keeps one request's proof from
// being replayed at a different lease endpoint.
export function buildProviderRefreshLeaseMessage({
  instanceId,
  requestId,
  accountId,
  operation,
  providerFamily = '',
  accountKey = '',
  credentialInstanceId = '',
  runId = '',
  leaseId = '',
  fencingToken = 0,
  issuedAt,
  audience = 'agentoc-provider-refresh-lease',
}) {
  return [
    'agentoc-provider-refresh-lease-v1',
    trimString(instanceId),
    trimString(requestId),
    trimString(accountId),
    trimString(operation),
    trimString(providerFamily),
    trimString(accountKey),
    trimString(credentialInstanceId),
    trimString(runId),
    trimString(leaseId),
    String(Number(fencingToken) || 0),
    trimString(issuedAt),
    trimString(audience) || 'agentoc-provider-refresh-lease',
  ].join('\n');
}

export function buildTargetRuntimeAuthorizationMessage({
  instanceId,
  requestId,
  targetInstanceId,
  idempotencyKey,
  method,
  path,
  operation,
  resourceId,
  expectedRevision,
  expiresAt,
  issuedAt,
  audience = 'agentoc-target-runtime',
}) {
  return [
    'agentoc-target-runtime-authorize-v1',
    trimString(instanceId),
    trimString(requestId),
    trimString(targetInstanceId),
    trimString(idempotencyKey),
    trimString(method).toUpperCase(),
    trimString(path),
    trimString(operation),
    trimString(resourceId),
    String(Number(expectedRevision) || 0),
    trimString(expiresAt),
    trimString(issuedAt),
    trimString(audience) || 'agentoc-target-runtime',
  ].join('\n');
}

export function verifyInstanceProofSignature({ publicKey, message, signature }) {
  const rawSignature = trimString(signature);
  if (!rawSignature) return false;
  const padded = rawSignature.replace(/-/g, '+').replace(/_/g, '/');
  const signatureBytes = Buffer.from(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='), 'base64');
  if (signatureBytes.length === 0) return false;
  try {
    return verify(null, Buffer.from(String(message || ''), 'utf8'), createPublicKey(publicKey), signatureBytes);
  } catch {
    return false;
  }
}
