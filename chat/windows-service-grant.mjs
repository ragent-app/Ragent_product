// Canonical wire bytes for the native broker's one-operation authorization.
// This module only encodes; policy decisions and signing belong to the server.
const id = /^[A-Za-z0-9._:-]{1,128}$/;
const nonce = /^[A-Za-z0-9_-]{24,128}$/;
const fields = ['version', 'keyId', 'brokerInstallationId', 'policyGeneration', 'requestId', 'sessionId', 'runId',
  'turnId', 'actionId', 'nonce', 'serviceName', 'action', 'definitionHash', 'authorization', 'issuedMs', 'expiresMs'];

export function windowsServiceControlSigningBytes(grant) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant) || Object.keys(grant).length !== fields.length ||
      fields.some(field => !Object.hasOwn(grant, field)) || grant.version !== 1 ||
      !['keyId', 'brokerInstallationId', 'requestId', 'sessionId', 'runId', 'turnId', 'actionId'].every(field => typeof grant[field] === 'string' && id.test(grant[field])) ||
      !Number.isSafeInteger(grant.policyGeneration) || grant.policyGeneration < 1 || typeof grant.nonce !== 'string' || !nonce.test(grant.nonce) ||
      typeof grant.serviceName !== 'string' || !grant.serviceName || !grant.serviceName.isWellFormed() || grant.serviceName !== grant.serviceName.trim() ||
      [...grant.serviceName].length > 256 || /[\\/*?\p{Cc}]/u.test(grant.serviceName) ||
      !['start-service', 'stop-service', 'restart-service'].includes(grant.action) || typeof grant.definitionHash !== 'string' || !/^[a-f0-9]{64}$/.test(grant.definitionHash) ||
      grant.authorization !== 'owner' || !Number.isSafeInteger(grant.issuedMs) || !Number.isSafeInteger(grant.expiresMs) ||
      grant.issuedMs < 1 || grant.expiresMs <= grant.issuedMs || grant.expiresMs - grant.issuedMs > 600_000) {
    throw Object.assign(new Error('Invalid Windows service control grant'), { code: 'SERVICE_CONTROL_GRANT_INVALID' });
  }
  const parts = [Buffer.from('Ragent Windows service control v1\0', 'utf8')];
  const num = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); parts.push(bytes); };
  const string = value => { const bytes = Buffer.from(value, 'utf8'); const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); parts.push(size, bytes); };
  num(grant.version); string(grant.keyId); string(grant.brokerInstallationId); num(grant.policyGeneration);
  for (const field of ['requestId', 'sessionId', 'runId', 'turnId', 'actionId', 'nonce', 'serviceName', 'action', 'definitionHash', 'authorization']) string(grant[field]);
  num(grant.issuedMs); num(grant.expiresMs);
  return Buffer.concat(parts);
}

export function windowsServiceOwnerSigningBytes(grant) {
  return Buffer.concat([Buffer.from('Ragent Windows service owner approval v1\0', 'utf8'), windowsServiceControlSigningBytes(grant)]);
}

export function windowsServiceOwnerDenialSigningBytes(grant) {
  return Buffer.concat([Buffer.from('Ragent Windows service owner denial v1\0', 'utf8'), windowsServiceControlSigningBytes(grant)]);
}

export function windowsServiceReviewSigningBytes(grant) {
  return Buffer.concat([Buffer.from('Ragent Windows service review v1\0', 'utf8'), windowsServiceControlSigningBytes(grant)]);
}
