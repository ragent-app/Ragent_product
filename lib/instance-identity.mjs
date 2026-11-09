// 每个 AgentoC 实例的本机 Ed25519 身份。
// 它用于向受控 Accounts 服务证明“发起/兑换 owner 授权的是同一实例”，
// 不承载用户 OAuth token，也不替代本机 owner 会话。
import { chmod, mkdir, readFile, rename, stat, writeFile, open, link, unlink, lstat } from 'fs/promises';
import { dirname } from 'path';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'crypto';
import {
  buildAccountJoinIntentProofMessage,
  buildInstanceProofMessage,
  buildNativeOwnerAuthMessage,
  buildNativeOwnerAuthRollbackMessage,
  buildBindingAuthorityProofMessage,
  buildAccountFileUploadQuotaMessage,
  buildOwnerAuthPollMessage,
  buildOwnerAuthDeviceMessage,
  buildProviderSyncPeerMessage,
  buildProviderRefreshLeaseMessage,
  buildTargetRuntimeAuthorizationMessage,
  buildAccountRendezvousPollMessage,
  createInstancePublicKeyFingerprint,
} from './instance-proof-protocol.mjs';

export {
  buildAccountJoinIntentProofMessage,
  buildInstanceProofMessage,
  buildNativeOwnerAuthMessage,
  buildNativeOwnerAuthRollbackMessage,
  buildBindingAuthorityProofMessage,
  buildAccountFileUploadQuotaMessage,
  buildOwnerAuthPollMessage,
  buildOwnerAuthDeviceMessage,
  buildProviderSyncPeerMessage,
  buildProviderRefreshLeaseMessage,
  buildTargetRuntimeAuthorizationMessage,
  buildAccountRendezvousPollMessage,
  createInstancePublicKeyFingerprint,
  verifyInstanceProofSignature,
} from './instance-proof-protocol.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

async function resolveDefaultIdentityFile() {
  // Keep config lazy so read-only callers that provide an explicit path (for
  // example Windows doctor) do not initialize the runtime directory tree.
  const { INSTANCE_IDENTITY_FILE } = await import('./config.mjs');
  return INSTANCE_IDENTITY_FILE;
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createInstanceId(publicKeyPem) {
  return `inst_${createInstancePublicKeyFingerprint(publicKeyPem).slice(0, 32)}`;
}

async function assertPrivateMode(filePath) {
  if (process.platform === 'win32') return;
  const info = await stat(filePath);
  if ((info.mode & 0o077) !== 0) {
    const error = new Error('Instance identity file must not be readable by group or others');
    error.statusCode = 500;
    throw error;
  }
}

async function writePrivateJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

function normalizeIdentity(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const privateKeyPem = trimString(source.privateKey);
  const publicKeyPem = trimString(source.publicKey);
  if (!privateKeyPem || !publicKeyPem) return null;

  try {
    const privateKey = createPrivateKey(privateKeyPem);
    const publicKey = createPublicKey(publicKeyPem);
    if (trimString(privateKey.asymmetricKeyType).toLowerCase() !== 'ed25519') return null;
    if (trimString(publicKey.asymmetricKeyType).toLowerCase() !== 'ed25519') return null;
    const probe = Buffer.from('agentoc-instance-identity-probe');
    if (!verify(null, probe, publicKey, sign(null, probe, privateKey))) return null;
    const normalizedPublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    return {
      version: 1,
      algorithm: 'ed25519',
      instanceId: trimString(source.instanceId) || createInstanceId(normalizedPublicKey),
      keyFingerprint: createInstancePublicKeyFingerprint(normalizedPublicKey),
      publicKey: normalizedPublicKey,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      createdAt: trimString(source.createdAt) || nowIso(),
    };
  } catch {
    return null;
  }
}

function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return normalizeIdentity({
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: nowIso(),
  });
}

/**
 * Load the durable instance identity without creating one when it is absent.
 * Read-only callers such as diagnostics and local clients must not change
 * instance state merely because the server has not initialized it yet.
 */
export async function loadInstanceIdentity(options = {}) {
  const filePath = trimString(options.filePath) || await resolveDefaultIdentityFile();
  try {
    await assertPrivateMode(filePath);
    const identity = normalizeIdentity(JSON.parse(await readFile(filePath, 'utf8')));
    if (!identity) throw new Error('Invalid instance identity file');
    return identity;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    const wrapped = new Error(`Failed to load instance identity: ${error.message}`);
    wrapped.statusCode = error?.statusCode || 500;
    throw wrapped;
  }
}

export async function loadOrCreateInstanceIdentity(options = {}) {
  const existing = await loadInstanceIdentity(options);
  if (existing) return existing;
  const filePath = trimString(options.filePath) || await resolveDefaultIdentityFile();
  const identity = generateIdentity();
  await writePrivateJsonAtomic(filePath, identity);
  return identity;
}

// Installer-only fresh initialization. Caller must first establish the fixed
// private service directory. Never replace/adopt an existing identity, follow a
// symlink, or regenerate a corrupt container. A crash leaves a lock for repair.
export async function initializeFreshInstanceIdentity({ filePath } = {}) {
  if (!filePath || typeof filePath !== 'string') throw new Error('IID_EXPLICIT_PATH_REQUIRED');
  const parent = await lstat(dirname(filePath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('IID_PRIVATE_DIRECTORY_REQUIRED');
  const lockPath = filePath + '.initialize-lock';
  const lease = await open(lockPath, 'wx', 0o600);
  let complete = false;
  const pending = filePath + '.pending';
  try {
    await lease.writeFile('{"version":1,"purpose":"fresh-instance-identity"}\n');
    await lease.sync();
    try { await lstat(filePath); throw new Error('IID_EXISTING_IDENTITY_REFUSED'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const identity = generateIdentity();
    const bytes = Buffer.from(JSON.stringify(identity, null, 2) + '\n');
    const file = await open(pending, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    // link is no-replace on NTFS; rename could overwrite another creator.
    await link(pending, filePath);
    await unlink(pending);
    const handle = await open(filePath, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || !(await handle.readFile()).equals(bytes)) throw new Error('IID_WRITE_VERIFY_FAILED');
    } finally { await handle.close(); }
    complete = true;
    return publicInstanceIdentity(identity);
  } finally {
    await lease.close();
    if (complete) await unlink(lockPath);
  }
}

export function publicInstanceIdentity(identity) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  return {
    instanceId: normalized.instanceId,
    algorithm: normalized.algorithm,
    keyFingerprint: normalized.keyFingerprint,
    publicKey: normalized.publicKey,
    createdAt: normalized.createdAt,
  };
}

// Bootstrap contracts and Accounts proofs must be verifiable with the same
// durable instance identity. Keep this generic signer here so callers cannot
// accidentally switch to the retired bootstrap-only key file.
export function signWithInstanceIdentity(identity, message) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  return base64Url(sign(null, Buffer.from(String(message), 'utf8'), createPrivateKey(normalized.privateKey)));
}

export function signOwnerAuthPollProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildOwnerAuthPollMessage({
    ...fields,
    instanceId: fields.instanceId || normalized.instanceId,
  });
  return {
    algorithm: normalized.algorithm,
    message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))),
  };
}

export function signAccountRendezvousPollProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildAccountRendezvousPollMessage({
    ...fields,
    instanceId: fields.instanceId || normalized.instanceId,
  });
  return {
    algorithm: normalized.algorithm,
    message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))),
  };
}

export function signOwnerAuthDeviceProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildOwnerAuthDeviceMessage({
    ...fields,
    instanceId: fields.instanceId || normalized.instanceId,
  });
  return {
    algorithm: normalized.algorithm,
    message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))),
  };
}

export function signNativeOwnerAuthProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildNativeOwnerAuthMessage({
    ...fields,
    instanceId: fields.instanceId || normalized.instanceId,
  });
  return {
    algorithm: normalized.algorithm,
    message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))),
  };
}

export function signNativeOwnerAuthRollbackProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildNativeOwnerAuthRollbackMessage({ ...fields, instanceId: normalized.instanceId });
  return { algorithm: normalized.algorithm, message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))) };
}

export function signBindingAuthorityProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildBindingAuthorityProofMessage({ ...fields, instanceId: normalized.instanceId,
    keyFingerprint: normalized.keyFingerprint });
  return { algorithm: normalized.algorithm, message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))) };
}

export function signAccountFileUploadQuotaProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildAccountFileUploadQuotaMessage({ ...fields, instanceId: normalized.instanceId });
  return { algorithm: normalized.algorithm, message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))) };
}

export function signAccountJoinIntentProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildAccountJoinIntentProofMessage({
    ...fields,
    instanceId: fields.instanceId || normalized.instanceId,
  });
  return {
    algorithm: normalized.algorithm,
    message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))),
  };
}

export function signInstanceProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildInstanceProofMessage({
    ...fields,
    instanceId: fields.instanceId || normalized.instanceId,
  });
  return {
    algorithm: normalized.algorithm,
    message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))),
  };
}

export function signProviderSyncPeerProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildProviderSyncPeerMessage({
    ...fields,
    instanceId: fields.instanceId || normalized.instanceId,
  });
  return {
    algorithm: normalized.algorithm,
    message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))),
  };
}

export function signProviderRefreshLeaseProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildProviderRefreshLeaseMessage({
    ...fields,
    instanceId: fields.instanceId || normalized.instanceId,
  });
  return {
    algorithm: normalized.algorithm,
    message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))),
  };
}

export function signTargetRuntimeAuthorizationProof(identity, fields = {}) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) throw new Error('Invalid instance identity');
  const message = buildTargetRuntimeAuthorizationMessage({
    ...fields,
    instanceId: fields.instanceId || normalized.instanceId,
  });
  return {
    algorithm: normalized.algorithm,
    message,
    signature: base64Url(sign(null, Buffer.from(message, 'utf8'), createPrivateKey(normalized.privateKey))),
  };
}
