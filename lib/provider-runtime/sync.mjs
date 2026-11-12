// Provider-only cross-instance synchronization primitives.
//
// This module deliberately knows nothing about sessions, runs, or history.
// Provider rows and their credential payloads are packaged as one encrypted
// envelope so a provider cannot be applied without its matching credential.
// Accounts authenticates the peer; it never receives this payload.

import {
  chmod,
  mkdir,
  readFile,
  link,
  unlink,
  writeFile,
} from 'fs/promises';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from 'crypto';
import { dirname, join } from 'path';
import {
  ACCOUNT_SYNC_SCOPES,
  compareSyncVersions,
  normalizeAccountSyncCatalogEntry,
  normalizeSyncKey,
  normalizeSyncScope,
  normalizeSyncVersion,
  stableSyncValue,
} from '../account-sync.mjs';
import { normalizeCredentialSyncRecord } from './credential-mutation.mjs';

export const PROVIDER_SYNC_PROTOCOL_VERSION = 1;
export const PROVIDER_SYNC_ALGORITHM = 'x25519-aes-256-gcm';
export const PROVIDER_SYNC_KEY_FILE_NAME = 'provider-sync-key.json';

export {
  ACCOUNT_SYNC_SCOPES,
  compareSyncVersions,
  normalizeAccountSyncCatalogEntry,
  normalizeSyncKey,
  normalizeSyncScope,
  normalizeSyncVersion,
};

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = trimString(value).replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  try {
    return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='), 'base64');
  } catch {
    return null;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

// Official native OAuth credentials are deliberately machine-local: an
// encrypted peer envelope must never move a refresh-token chain to another
// AgentoC instance. This covers Codex and AgY OAuth, plus Claude setup-token
// profiles. API-key rows remain synchronizable because they do not have this
// rotating credential ownership problem.
export const MACHINE_LOCAL_OAUTH_SYNC_REASON = 'machine-local-oauth';

export function isMachineLocalOAuthProvider({ provider, auth } = {}) {
  const agentType = trimString(provider?.agentType).toLowerCase();
  const authType = trimString(auth?.authType).toLowerCase();
  return ['codex', 'claude', 'agy'].includes(agentType)
    && ['oauth', 'oauth-token'].includes(authType);
}

export function isMachineLocalOAuthSyncRecord(record = {}) {
  if (record.machineLocalOnly === true) return true;
  if (isMachineLocalOAuthProvider({ provider: record.provider, auth: record.auth })) return true;
  const agentType = trimString(record.agentType).toLowerCase();
  const authType = trimString(record.authType).toLowerCase();
  if (['codex', 'claude', 'agy'].includes(agentType) && ['oauth', 'oauth-token'].includes(authType)) return true;
  // Older credential records did not carry the two metadata fields. Their
  // stable account key still identifies native OAuth accounts unambiguously.
  return /^account:(codex|agy):/i.test(trimString(record.key || record.accountKey))
    && (authType === '' || authType === 'oauth' || authType === 'oauth-token');
}

function createSyncError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export function normalizeProviderSyncRecord(record, fallbackWriterId = '') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw createSyncError('provider_sync_record_invalid', 'Provider sync record must be an object.');
  }
  let key;
  try {
    key = normalizeSyncKey(record.key || record.syncId || record.provider?.id);
  } catch {
    throw createSyncError('provider_sync_key_invalid', 'Provider sync record key is invalid.');
  }
  const version = normalizeSyncVersion(record.version, fallbackWriterId);
  if (!version.updatedAt || !version.writerId) {
    throw createSyncError('provider_sync_version_invalid', 'Provider sync record version is incomplete.');
  }
  const deleted = Boolean(record.deletedAt || record.deleted);
  if (deleted) {
    return {
      key,
      version,
      deletedAt: normalizeIsoValue(record.deletedAt, version.updatedAt),
    };
  }
  // The local ledger intentionally stores metadata only. It is still a valid
  // merge input because only its version participates in conflict resolution.
  if (!record.provider && !record.auth && !record.secret) {
    return {
      key,
      version,
      ...(record.machineLocalOnly === true ? { machineLocalOnly: true } : {}),
    };
  }
  if (!record.provider || typeof record.provider !== 'object' || !record.auth || typeof record.auth !== 'object') {
    throw createSyncError('provider_sync_record_invalid', 'Provider sync record needs provider and auth rows.');
  }
  if (isMachineLocalOAuthProvider({ provider: record.provider, auth: record.auth })) {
    // Preserve only the version/tombstone metadata when a legacy peer sends a
    // full OAuth record. The credential payload is intentionally discarded at
    // this boundary, so it cannot reach a registry or SecretStore importer.
    return { key, version, machineLocalOnly: true };
  }
  if (!record.secret || typeof record.secret !== 'object') {
    throw createSyncError('provider_sync_secret_missing', 'Provider sync record needs its credential payload.');
  }
  return {
    key,
    version,
    provider: stableValue(record.provider),
    auth: stableValue(record.auth),
    secret: stableValue(record.secret),
  };
}

function normalizeIsoValue(value, fallback = '') {
  const text = trimString(value);
  if (!text) return fallback;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

export function normalizeAgentProfileSyncRecord(record, fallbackWriterId = '') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw createSyncError('account_sync_record_invalid', 'Account sync record must be an object.');
  }
  const scope = normalizeSyncScope(record.scope, '');
  if (scope !== 'agent-profile') {
    throw createSyncError('account_sync_scope_invalid', 'Unsupported Agent profile sync scope.');
  }
  let key;
  try {
    key = normalizeSyncKey(record.key || record.agent?.id || record.profile?.id);
  } catch {
    throw createSyncError('account_sync_key_invalid', 'Agent profile sync record key is invalid.');
  }
  const version = normalizeSyncVersion(record.version, fallbackWriterId);
  if (!version.updatedAt || !version.writerId) {
    throw createSyncError('account_sync_version_invalid', 'Agent profile sync record version is incomplete.');
  }
  if (record.deletedAt || record.deleted) {
    return { scope, key, version, deletedAt: normalizeIsoValue(record.deletedAt, version.updatedAt) };
  }
  const agent = record.agent || record.profile;
  // The local ledger and the central account catalog intentionally carry
  // metadata only. They still participate in version comparison; the full
  // profile arrives separately in an encrypted peer snapshot.
  if (!agent) return { scope, key, version };
  if (!agent || typeof agent !== 'object' || Array.isArray(agent) || trimString(agent.id) !== key) {
    throw createSyncError('account_sync_record_invalid', 'Agent profile sync record payload is invalid.');
  }
  return { scope, key, version, agent: stableSyncValue(agent) };
}

// Account-level runtime policy sync (scope 'runtime-policy'). The payload is
// metadata only — the policy mode plus its sync version. There is no
// tombstone: the policy always has a value (unset locally means "use the
// built-in default"), so clearing is expressed as a newer record with an
// empty mode rather than a deletion.
export function normalizeRuntimePolicySyncRecord(record, fallbackWriterId = '') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw createSyncError('account_sync_record_invalid', 'Account sync record must be an object.');
  }
  const scope = normalizeSyncScope(record.scope, '');
  if (scope !== 'runtime-policy') {
    throw createSyncError('account_sync_scope_invalid', 'Unsupported runtime policy sync scope.');
  }
  let key;
  try {
    key = normalizeSyncKey(record.key);
  } catch {
    throw createSyncError('account_sync_key_invalid', 'Runtime policy sync record key is invalid.');
  }
  // Single fixed-key scope: instances must not publish arbitrary policy
  // records under the account namespace.
  if (key !== 'permission-policy') {
    throw createSyncError('account_sync_key_invalid', 'Runtime policy sync record key is invalid.');
  }
  const version = normalizeSyncVersion(record.version, fallbackWriterId);
  if (!version.updatedAt || !version.writerId) {
    throw createSyncError('account_sync_version_invalid', 'Runtime policy sync record version is incomplete.');
  }
  if (record.deletedAt || record.deleted) {
    throw createSyncError('account_sync_record_invalid', 'Runtime policy records cannot be deleted.');
  }
  const policy = record.policy && typeof record.policy === 'object' && !Array.isArray(record.policy)
    ? record.policy
    : null;
  if (!policy) return { scope, key, version };
  return { scope, key, version, policy: stableSyncValue(policy) };
}

export function normalizeAccountSyncRecord(record, fallbackWriterId = '') {
  const rawScope = trimString(record?.scope);
  const scope = rawScope ? normalizeSyncScope(rawScope, '') : 'provider';
  if (rawScope && !scope) {
    throw createSyncError('account_sync_scope_invalid', 'Unsupported account sync scope.');
  }
  if (scope === 'provider') {
    return {
      scope,
      ...normalizeProviderSyncRecord(record, fallbackWriterId),
    };
  }
  if (scope === 'agent-profile') return normalizeAgentProfileSyncRecord(record, fallbackWriterId);
  if (scope === 'provider-credential') {
    return normalizeCredentialSyncRecord(record, fallbackWriterId);
  }
  if (scope === 'runtime-policy') return normalizeRuntimePolicySyncRecord(record, fallbackWriterId);
  throw createSyncError('account_sync_scope_invalid', 'Unsupported account sync scope.');
}

export function mergeProviderSyncRecords(current = [], incoming = [], fallbackWriterId = '') {
  const merged = new Map();
  for (const record of current) {
    const normalized = normalizeProviderSyncRecord(record, fallbackWriterId);
    merged.set(normalized.key, normalized);
  }
  const accepted = [];
  const ignored = [];
  for (const record of incoming) {
    const normalized = normalizeProviderSyncRecord(record, fallbackWriterId);
    const prior = merged.get(normalized.key);
    if (!prior || compareSyncVersions(normalized.version, prior.version) > 0) {
      merged.set(normalized.key, normalized);
      accepted.push(normalized.key);
    } else {
      ignored.push(normalized.key);
    }
  }
  return {
    records: [...merged.values()].sort((left, right) => left.key.localeCompare(right.key)),
    accepted,
    ignored,
  };
}

export function mergeAccountSyncRecords(current = [], incoming = [], fallbackWriterId = '') {
  const merged = new Map();
  for (const record of current) {
    const normalized = normalizeAccountSyncRecord(record, fallbackWriterId);
    merged.set(`${normalized.scope}:${normalized.key}`, normalized);
  }
  const accepted = [];
  const ignored = [];
  const acceptedRecords = [];
  for (const record of incoming) {
    const normalized = normalizeAccountSyncRecord(record, fallbackWriterId);
    const identity = `${normalized.scope}:${normalized.key}`;
    const prior = merged.get(identity);
    if (!prior || compareSyncVersions(normalized.version, prior.version) > 0) {
      merged.set(identity, normalized);
      accepted.push(identity);
      acceptedRecords.push(normalized);
    } else {
      ignored.push(identity);
    }
  }
  return {
    records: [...merged.values()].sort((left, right) => `${left.scope}:${left.key}`.localeCompare(`${right.scope}:${right.key}`)),
    accepted,
    acceptedRecords,
    ignored,
  };
}

export function buildProviderSyncSnapshot({
  accountId,
  sourceInstanceId,
  records = [],
  protocolVersion = PROVIDER_SYNC_PROTOCOL_VERSION,
} = {}) {
  const normalizedAccountId = trimString(accountId);
  const normalizedSource = trimString(sourceInstanceId);
  if (!normalizedAccountId || !normalizedSource) {
    throw createSyncError('provider_sync_snapshot_invalid', 'Provider sync snapshot identity is incomplete.');
  }
  if (protocolVersion !== PROVIDER_SYNC_PROTOCOL_VERSION) {
    throw createSyncError('provider_sync_protocol_unsupported', 'Unsupported provider sync protocol.', 426);
  }
  return {
    protocolVersion,
    accountId: normalizedAccountId,
    sourceInstanceId: normalizedSource,
    // normalizeProviderSyncRecord strips legacy Codex OAuth payloads. Keep
    // this explicit filter as defense in depth for future record builders.
    records: records
      .filter((record) => !isMachineLocalOAuthSyncRecord(record))
      .map((record) => normalizeProviderSyncRecord(record, normalizedSource)),
  };
}

export function buildAccountSyncSnapshot({
  accountId,
  sourceInstanceId,
  records = [],
  protocolVersion = PROVIDER_SYNC_PROTOCOL_VERSION,
} = {}) {
  const normalizedAccountId = trimString(accountId);
  const normalizedSource = trimString(sourceInstanceId);
  if (!normalizedAccountId || !normalizedSource) {
    throw createSyncError('account_sync_snapshot_invalid', 'Account sync snapshot identity is incomplete.');
  }
  if (protocolVersion !== PROVIDER_SYNC_PROTOCOL_VERSION) {
    throw createSyncError('account_sync_protocol_unsupported', 'Unsupported account sync protocol.', 426);
  }
  return {
    protocolVersion,
    accountId: normalizedAccountId,
    sourceInstanceId: normalizedSource,
    records: records.map((record) => normalizeAccountSyncRecord(record, normalizedSource)),
  };
}

function assertX25519PublicKey(publicKeyPem) {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'x25519') throw new Error('wrong key type');
    return key;
  } catch {
    throw createSyncError('provider_sync_key_invalid', 'Provider sync public key is invalid.');
  }
}

function assertX25519PrivateKey(privateKeyPem) {
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== 'x25519') throw new Error('wrong key type');
    return key;
  } catch {
    throw createSyncError('provider_sync_key_invalid', 'Provider sync private key is invalid.');
  }
}

function exportPublicKey(key) {
  return key.export({ type: 'spki', format: 'pem' }).toString().trim();
}

function exportPrivateKey(key) {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
}

function keyFingerprint(publicKeyPem) {
  return createHash('sha256')
    .update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

export function providerSyncKeyFingerprint(publicKeyPem) {
  assertX25519PublicKey(publicKeyPem);
  return keyFingerprint(publicKeyPem);
}

export function createProviderSyncKeyStore({
  configDir,
  filePath = '',
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  linkImpl = link,
  unlinkImpl = unlink,
  chmodImpl = chmod,
} = {}) {
  const targetPath = filePath || join(configDir, 'native-provider-runtime', PROVIDER_SYNC_KEY_FILE_NAME);
  let keyPairPromise = null;

  async function writeKeyPair(keyPair) {
    await mkdirImpl(dirname(targetPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
    try {
      await writeFileImpl(temporaryPath, `${JSON.stringify(keyPair, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await chmodImpl(temporaryPath, 0o600).catch(() => {});
      try { await linkImpl(temporaryPath, targetPath); return true; }
      catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
    } finally {
      await unlinkImpl(temporaryPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    }
  }

  async function loadOrCreate() {
    try {
      const raw = JSON.parse(await readFileImpl(targetPath, 'utf8'));
      const privateKey = assertX25519PrivateKey(raw?.privateKeyPem);
      const publicKeyPem = exportPublicKey(privateKey === null ? raw.publicKeyPem : createPublicKey(privateKey));
      if (trimString(raw?.publicKeyPem) !== publicKeyPem) throw new Error('provider sync public key mismatch');
      return {
        algorithm: 'x25519',
        publicKeyPem,
        privateKeyPem: exportPrivateKey(privateKey),
        fingerprint: keyFingerprint(publicKeyPem),
        createdAt: normalizeIsoValue(raw?.createdAt, new Date().toISOString()),
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error?.code?.startsWith('provider_sync_')) throw error;
        throw createSyncError('provider_sync_key_invalid', `Failed to load provider sync key: ${error.message}`, 500);
      }
    }
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const publicKeyPem = exportPublicKey(publicKey);
    const keyPair = {
      algorithm: 'x25519',
      publicKeyPem,
      privateKeyPem: exportPrivateKey(privateKey),
      fingerprint: keyFingerprint(publicKeyPem),
      createdAt: new Date().toISOString(),
    };
    if (await writeKeyPair(keyPair)) return keyPair;
    return loadOrCreate();
  }

  async function getKeyPair() {
    if (!keyPairPromise) keyPairPromise = loadOrCreate();
    return keyPairPromise;
  }

  return {
    getKeyPair,
    getPublicKey: async () => (await getKeyPair()).publicKeyPem,
  };
}

function envelopeAssociatedData(envelope) {
  return canonicalJson({
    protocolVersion: envelope.protocolVersion,
    algorithm: envelope.algorithm,
    senderInstanceId: envelope.senderInstanceId,
    recipientInstanceId: envelope.recipientInstanceId,
    requestId: envelope.requestId,
    ephemeralPublicKeyPem: envelope.ephemeralPublicKeyPem,
    salt: envelope.salt,
    iv: envelope.iv,
  });
}

function deriveEnvelopeKey(sharedSecret, salt, senderInstanceId, recipientInstanceId) {
  return Buffer.from(hkdfSync(
    'sha256',
    sharedSecret,
    salt,
    Buffer.from(`agentoc-provider-sync-v${PROVIDER_SYNC_PROTOCOL_VERSION}\n${senderInstanceId}\n${recipientInstanceId}`, 'utf8'),
    32,
  ));
}

function encryptSyncEnvelope({
  snapshot,
  snapshotBuilder,
  recipientPublicKeyPem,
  senderInstanceId,
  senderSigningPrivateKeyPem,
  senderSigningPublicKeyPem,
  recipientInstanceId,
  requestId = `psync_${randomBytes(18).toString('base64url')}`,
} = {}) {
  const normalizedSnapshot = snapshotBuilder(snapshot);
  const sender = trimString(senderInstanceId) || normalizedSnapshot.sourceInstanceId;
  const recipient = trimString(recipientInstanceId);
  const signingPrivateKey = createPrivateKey(senderSigningPrivateKeyPem);
  const signingPublicKey = trimString(senderSigningPublicKeyPem);
  if (!sender || sender !== normalizedSnapshot.sourceInstanceId || !recipient || !signingPublicKey) {
    throw createSyncError('provider_sync_envelope_invalid', 'Provider sync envelope identity is incomplete.');
  }
  if (signingPrivateKey.asymmetricKeyType !== 'ed25519') {
    throw createSyncError('provider_sync_signing_key_invalid', 'Provider sync signing key must be Ed25519.');
  }
  assertX25519PublicKey(recipientPublicKeyPem);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublicKeyPem = exportPublicKey(ephemeral.publicKey);
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey(recipientPublicKeyPem),
  });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const unsigned = {
    protocolVersion: PROVIDER_SYNC_PROTOCOL_VERSION,
    algorithm: PROVIDER_SYNC_ALGORITHM,
    senderInstanceId: sender,
    recipientInstanceId: recipient,
    requestId: trimString(requestId),
    ephemeralPublicKeyPem,
    salt: base64Url(salt),
    iv: base64Url(iv),
  };
  if (!unsigned.requestId) throw createSyncError('provider_sync_envelope_invalid', 'Provider sync request ID is required.');
  const key = deriveEnvelopeKey(sharedSecret, salt, sender, recipient);
  const aad = Buffer.from(envelopeAssociatedData(unsigned), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(canonicalJson(normalizedSnapshot), 'utf8')), cipher.final()]);
  const envelope = {
    ...unsigned,
    ciphertext: base64Url(ciphertext),
    tag: base64Url(cipher.getAuthTag()),
    senderSigningPublicKeyPem: signingPublicKey,
  };
  const signature = sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), signingPrivateKey);
  return { ...envelope, signature: base64Url(signature) };
}

function decryptSyncEnvelope({
  envelope,
  snapshotBuilder,
  recipientPrivateKeyPem,
  expectedRecipientInstanceId,
  expectedSenderInstanceId,
  senderSigningPublicKeyPem,
} = {}) {
  if (!envelope || envelope.protocolVersion !== PROVIDER_SYNC_PROTOCOL_VERSION
    || envelope.algorithm !== PROVIDER_SYNC_ALGORITHM) {
    throw createSyncError('provider_sync_protocol_unsupported', 'Unsupported provider sync envelope.', 426);
  }
  const recipient = trimString(expectedRecipientInstanceId);
  const sender = trimString(expectedSenderInstanceId);
  if (!recipient || envelope.recipientInstanceId !== recipient
    || (sender && envelope.senderInstanceId !== sender)) {
    throw createSyncError('provider_sync_peer_mismatch', 'Provider sync envelope peer mismatch.', 403);
  }
  const trustedSigningKey = trimString(senderSigningPublicKeyPem);
  if (!trustedSigningKey || trustedSigningKey !== trimString(envelope.senderSigningPublicKeyPem)) {
    throw createSyncError('provider_sync_signing_key_mismatch', 'Provider sync sender key is not trusted.', 403);
  }
  const unsigned = { ...envelope };
  delete unsigned.signature;
  const signature = fromBase64Url(envelope.signature);
  if (!signature || !verify(null, Buffer.from(canonicalJson(unsigned), 'utf8'), createPublicKey(trustedSigningKey), signature)) {
    throw createSyncError('provider_sync_signature_invalid', 'Provider sync envelope signature is invalid.', 401);
  }
  const salt = fromBase64Url(envelope.salt);
  const iv = fromBase64Url(envelope.iv);
  const ciphertext = fromBase64Url(envelope.ciphertext);
  const tag = fromBase64Url(envelope.tag);
  if (!salt || salt.length !== 16 || !iv || iv.length !== 12 || !ciphertext || !tag || tag.length !== 16) {
    throw createSyncError('provider_sync_envelope_invalid', 'Provider sync envelope encoding is invalid.');
  }
  const recipientPrivateKey = assertX25519PrivateKey(recipientPrivateKeyPem);
  const sharedSecret = diffieHellman({
    privateKey: recipientPrivateKey,
    publicKey: assertX25519PublicKey(envelope.ephemeralPublicKeyPem),
  });
  const key = deriveEnvelopeKey(sharedSecret, salt, envelope.senderInstanceId, envelope.recipientInstanceId);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(envelopeAssociatedData(envelope), 'utf8'));
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw createSyncError('provider_sync_decrypt_failed', 'Provider sync envelope could not be decrypted.', 400);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(plaintext);
  } catch {
    throw createSyncError('provider_sync_payload_invalid', 'Provider sync payload is not valid JSON.');
  }
  if (snapshot?.sourceInstanceId !== envelope.senderInstanceId) {
    throw createSyncError('provider_sync_payload_invalid', 'Provider sync payload sender mismatch.');
  }
  return snapshotBuilder(snapshot);
}

export function encryptProviderSyncEnvelope(options = {}) {
  return encryptSyncEnvelope({ ...options, snapshotBuilder: buildProviderSyncSnapshot });
}

export function decryptProviderSyncEnvelope(options = {}) {
  return decryptSyncEnvelope({ ...options, snapshotBuilder: buildProviderSyncSnapshot });
}

export function encryptAccountSyncEnvelope(options = {}) {
  return encryptSyncEnvelope({ ...options, snapshotBuilder: buildAccountSyncSnapshot });
}

export function decryptAccountSyncEnvelope(options = {}) {
  return decryptSyncEnvelope({ ...options, snapshotBuilder: buildAccountSyncSnapshot });
}
