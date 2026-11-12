import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CONFIG_DIR } from './config.mjs';

const STATE_FILE = join(CONFIG_DIR, 'owner-webauthn.json');
const CHALLENGE_DIR = join(CONFIG_DIR, 'owner-webauthn-challenges');
const PROOF_DIR = join(CONFIG_DIR, 'owner-webauthn-proofs');
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PROOF_TTL_MS = 90 * 1000;
const OWNER_USER_ID = base64UrlEncode(createHash('sha256').update('agentoc-owner').digest().subarray(0, 16));
const WEBAUTHN_HINTS = new Set(['client-device', 'security-key', 'hybrid']);
const NATIVE_ANDROID_CLIENT = 'android-native-passkey';
const ANDROID_PACKAGE_NAME = trimString(process.env.AGENTOC_ANDROID_PACKAGE_NAME) || 'com.andysagent.agentoc';
// Credential Manager reports an Android-origin WebAuthn assertion as
// `android:apk-key-hash:<base64url-or-base64>`.  Keep the format-only check as
// the backwards-compatible default, but let deployments pin the release
// certificate when they know it.  This is deliberately optional so existing
// self-hosted instances do not become unusable during an APK key rotation.
const ANDROID_APK_KEY_HASHES = new Set(
  String(process.env.AGENTOC_ANDROID_APK_KEY_HASHES || '')
    .split(',')
    .map((value) => trimString(value))
    .filter(Boolean),
);
export const OWNER_WEBAUTHN_PROOF_HEADER = 'x-agentoc-webauthn-proof';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function expiresAt(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function notExpired(value) {
  const time = Date.parse(trimString(value));
  return Number.isFinite(time) && time > Date.now();
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

export function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function base64UrlDecode(value) {
  const normalized = trimString(value).replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized) return Buffer.alloc(0);
  return Buffer.from(`${normalized}${'='.repeat((4 - (normalized.length % 4)) % 4)}`, 'base64');
}

function randomBase64Url(bytes = 32) {
  return base64UrlEncode(randomBytes(bytes));
}

function safeOriginHost(value) {
  return trimString(value).split(',')[0].trim();
}

function normalizeAuthenticatorAttachment(value) {
  const normalized = trimString(value);
  return ['platform', 'cross-platform'].includes(normalized) ? normalized : '';
}

function normalizeCredentialHints(value, authenticatorAttachment = '') {
  const requested = Array.isArray(value)
    ? value.map(trimString).filter((hint) => WEBAUTHN_HINTS.has(hint))
    : [];
  if (requested.length > 0) return requested;
  if (authenticatorAttachment === 'platform') return ['client-device'];
  if (authenticatorAttachment === 'cross-platform') return ['security-key', 'hybrid'];
  return ['client-device', 'hybrid', 'security-key'];
}

function isNativeAndroidRequest(req = {}) {
  return trimString(req?.headers?.['x-agentoc-client']) === NATIVE_ANDROID_CLIENT;
}

export function resolveWebAuthnRequestScope(req = {}) {
  const forwardedHost = safeOriginHost(req.headers?.['x-forwarded-host']);
  const host = forwardedHost || safeOriginHost(req.headers?.host) || '127.0.0.1';
  const forwardedProto = safeOriginHost(req.headers?.['x-forwarded-proto']).toLowerCase();
  const hostname = host.replace(/:\d+$/g, '');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(hostname);
  const proto = forwardedProto || (local ? 'http' : 'https');
  return {
    rpId: hostname,
    origin: `${proto}://${host}`,
  };
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value, { mode = 0o600 } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(temporaryPath, mode).catch(() => {});
  await rename(temporaryPath, path);
}

async function readState() {
  const state = await readJson(STATE_FILE, {});
  return {
    credentials: Array.isArray(state?.credentials) ? state.credentials.filter((entry) => trimString(entry?.id)) : [],
  };
}

async function writeState(state) {
  await writeJsonAtomic(STATE_FILE, {
    credentials: Array.isArray(state?.credentials) ? state.credentials : [],
    updatedAt: nowIso(),
  }, { mode: 0o600 });
}

function challengePath(challenge) {
  return join(CHALLENGE_DIR, `${sha256Hex(challenge)}.json`);
}

function proofPath(token) {
  return join(PROOF_DIR, `${sha256Hex(token)}.json`);
}

async function storeChallenge(record) {
  await writeJsonAtomic(challengePath(record.challenge), record, { mode: 0o600 });
}

async function consumeChallenge(challenge, type) {
  const path = challengePath(challenge);
  const record = await readJson(path, null);
  await unlink(path).catch(() => {});
  if (!record || trimString(record.type) !== type || !notExpired(record.expiresAt)) {
    const error = new Error('WebAuthn challenge expired or not found');
    error.code = 'WEBAUTHN_CHALLENGE_INVALID';
    throw error;
  }
  return record;
}

async function cleanupExpired(directory, read = readJson) {
  let names = [];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(names
    .filter((name) => name.endsWith('.json'))
    .map(async (name) => {
      const path = join(directory, name);
      const record = await read(path, null);
      if (!record || !notExpired(record.expiresAt)) {
        await unlink(path).catch(() => {});
      }
    }));
}

export async function getOwnerWebAuthnState() {
  const state = await readState();
  return {
    registered: state.credentials.length > 0,
    credentials: state.credentials.map((credential) => ({
      id: credential.id,
      registeredAt: credential.registeredAt || '',
      lastUsedAt: credential.lastUsedAt || '',
      transports: Array.isArray(credential.transports) ? credential.transports : [],
    })),
  };
}

export async function createOwnerWebAuthnRegistrationOptions(req = {}, options = {}) {
  await cleanupExpired(CHALLENGE_DIR);
  const state = await readState();
  const scope = resolveWebAuthnRequestScope(req);
  const challenge = randomBase64Url();
  const authenticatorAttachment = normalizeAuthenticatorAttachment(options.authenticatorAttachment);
  const hints = normalizeCredentialHints(options.hints, authenticatorAttachment);
  const authenticatorSelection = {
    userVerification: 'required',
    residentKey: 'preferred',
    ...(authenticatorAttachment ? { authenticatorAttachment } : {}),
  };
  await storeChallenge({
    type: 'registration',
    challenge,
    rpId: scope.rpId,
    origin: scope.origin,
    expiresAt: expiresAt(CHALLENGE_TTL_MS),
    createdAt: nowIso(),
  });
  return {
    publicKey: {
      challenge,
      rp: { id: scope.rpId, name: 'Ragent' },
      user: {
        id: OWNER_USER_ID,
        name: 'owner',
        displayName: 'Ragent Owner',
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60_000,
      attestation: 'none',
      authenticatorSelection,
      hints,
      excludeCredentials: state.credentials.map((credential) => ({
        type: 'public-key',
        id: credential.id,
        transports: Array.isArray(credential.transports) ? credential.transports : undefined,
      })),
    },
  };
}

export async function verifyOwnerWebAuthnRegistration(payload = {}) {
  const clientData = parseClientData(payload?.response?.clientDataJSON);
  if (clientData.type !== 'webauthn.create') {
    const error = new Error('Invalid WebAuthn registration type');
    error.code = 'WEBAUTHN_TYPE_INVALID';
    throw error;
  }
  const challenge = await consumeChallenge(clientData.challenge, 'registration');
  assertClientOrigin(clientData.origin, challenge.origin);
  const attestation = decodeCbor(base64UrlDecode(payload?.response?.attestationObject));
  const authData = getCborMapValue(attestation, 'authData');
  if (!Buffer.isBuffer(authData)) {
    const error = new Error('WebAuthn attestation is missing authData');
    error.code = 'WEBAUTHN_ATTESTATION_INVALID';
    throw error;
  }
  const credential = parseAuthenticatorAttestedCredential(authData, challenge.rpId);
  const credentialId = trimString(payload.id) || base64UrlEncode(credential.credentialId);
  if (credentialId !== base64UrlEncode(credential.credentialId)) {
    const error = new Error('WebAuthn credential id mismatch');
    error.code = 'WEBAUTHN_CREDENTIAL_INVALID';
    throw error;
  }
  const state = await readState();
  const nextCredential = {
    id: credentialId,
    publicKeyJwk: credential.publicKeyJwk,
    signCount: credential.signCount,
    rpId: challenge.rpId,
    alg: credential.alg,
    transports: Array.isArray(payload?.response?.transports) ? payload.response.transports.map(trimString).filter(Boolean) : [],
    registeredAt: nowIso(),
    lastUsedAt: '',
  };
  const credentials = [
    nextCredential,
    ...state.credentials.filter((entry) => trimString(entry?.id) !== credentialId),
  ].slice(0, 8);
  await writeState({ credentials });
  return { ok: true, credentialId, registered: true };
}

export async function createOwnerWebAuthnAssertionOptions(req = {}, options = {}) {
  await cleanupExpired(CHALLENGE_DIR);
  const state = await readState();
  if (state.credentials.length === 0) {
    const error = new Error('Owner WebAuthn credential is required');
    error.code = 'WEBAUTHN_CREDENTIAL_REQUIRED';
    error.statusCode = 409;
    throw error;
  }
  const scope = resolveWebAuthnRequestScope(req);
  const challenge = randomBase64Url();
  const purpose = trimString(options.purpose);
  const sessionId = trimString(options.sessionId);
  const requestId = trimString(options.requestId);
  const nativeAndroid = options.nativeAndroid === true || isNativeAndroidRequest(req);
  // P2 (design §5.6): the challenge binds exactly one per-popup signed subset.
  // chat-server only mints 'passkey'-mode tokens when the submitted proof's
  // manifestHash equals the batch subset hash of the op being executed.
  const manifestHash = trimString(options.manifestHash);
  await storeChallenge({
    type: 'assertion',
    challenge,
    rpId: scope.rpId,
    origin: scope.origin,
    purpose,
    sessionId,
    requestId,
    clientPlatform: nativeAndroid ? 'android' : 'web',
    ...(manifestHash ? { manifestHash } : {}),
    expiresAt: expiresAt(CHALLENGE_TTL_MS),
    createdAt: nowIso(),
  });
  return {
    publicKey: {
      challenge,
      rpId: scope.rpId,
      timeout: 60_000,
      userVerification: 'required',
      allowCredentials: state.credentials.map((credential) => ({
        type: 'public-key',
        id: credential.id,
        transports: Array.isArray(credential.transports) ? credential.transports : undefined,
      })),
    },
    clientPlatform: nativeAndroid ? 'android' : 'web',
  };
}

export async function verifyOwnerWebAuthnAssertion(payload = {}) {
  const clientData = parseClientData(payload?.response?.clientDataJSON);
  if (clientData.type !== 'webauthn.get') {
    const error = new Error('Invalid WebAuthn assertion type');
    error.code = 'WEBAUTHN_TYPE_INVALID';
    throw error;
  }
  const challenge = await consumeChallenge(clientData.challenge, 'assertion');
  assertClientOrigin(clientData.origin, challenge.origin, {
    clientPlatform: challenge.clientPlatform,
    androidPackageName: clientData.androidPackageName,
  });
  const credentialId = trimString(payload.id) || trimString(payload.rawId);
  const state = await readState();
  const credential = state.credentials.find((entry) => trimString(entry?.id) === credentialId);
  if (!credential) {
    const error = new Error('WebAuthn credential is not registered');
    error.code = 'WEBAUTHN_CREDENTIAL_UNKNOWN';
    throw error;
  }
  const authenticatorData = base64UrlDecode(payload?.response?.authenticatorData);
  assertRpAndUserVerification(authenticatorData, credential.rpId || challenge.rpId);
  const signature = base64UrlDecode(payload?.response?.signature);
  const signedBytes = Buffer.concat([
    authenticatorData,
    createHash('sha256').update(base64UrlDecode(payload?.response?.clientDataJSON)).digest(),
  ]);
  const key = createPublicKey({ key: credential.publicKeyJwk, format: 'jwk' });
  const ok = verifySignature('sha256', signedBytes, key, signature);
  if (!ok) {
    const error = new Error('WebAuthn signature verification failed');
    error.code = 'WEBAUTHN_SIGNATURE_INVALID';
    throw error;
  }
  const signCount = readSignCount(authenticatorData);
  const credentials = state.credentials.map((entry) => (
    trimString(entry?.id) === credentialId
      ? { ...entry, signCount, lastUsedAt: nowIso() }
      : entry
  ));
  await writeState({ credentials });
  const proof = await issueOwnerWebAuthnProof({
    purpose: challenge.purpose,
    sessionId: challenge.sessionId,
    requestId: challenge.requestId,
    credentialId,
    ...(challenge.manifestHash ? { manifestHash: challenge.manifestHash } : {}),
  });
  return {
    ok: true,
    credentialId,
    purpose: challenge.purpose,
    sessionId: challenge.sessionId,
    requestId: challenge.requestId,
    ...(challenge.manifestHash ? { manifestHash: challenge.manifestHash } : {}),
    proof,
  };
}

async function issueOwnerWebAuthnProof(record = {}) {
  await cleanupExpired(PROOF_DIR);
  const token = randomBase64Url();
  const proof = {
    token,
    expiresAt: expiresAt(PROOF_TTL_MS),
    purpose: trimString(record.purpose),
    sessionId: trimString(record.sessionId),
    requestId: trimString(record.requestId),
    credentialId: trimString(record.credentialId),
    ...(trimString(record.manifestHash) ? { manifestHash: trimString(record.manifestHash) } : {}),
    createdAt: nowIso(),
  };
  await writeJsonAtomic(proofPath(token), proof, { mode: 0o600 });
  return { token, expiresAt: proof.expiresAt };
}

export async function consumeOwnerWebAuthnProof({ token, purpose, sessionId, requestId, manifestHash } = {}) {
  const normalizedToken = trimString(token);
  if (!normalizedToken) return false;
  const path = proofPath(normalizedToken);
  const proof = await readJson(path, null);
  await unlink(path).catch(() => {});
  if (!proof || !notExpired(proof.expiresAt)) return false;
  const normalizedManifestHash = trimString(manifestHash);
  return trimString(proof.purpose) === trimString(purpose)
    && trimString(proof.sessionId) === trimString(sessionId)
    && trimString(proof.requestId) === trimString(requestId)
    && (!normalizedManifestHash || trimString(proof.manifestHash) === normalizedManifestHash);
}

function parseClientData(encoded) {
  const raw = base64UrlDecode(encoded);
  let parsed = null;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    const error = new Error('Invalid WebAuthn clientDataJSON');
    error.code = 'WEBAUTHN_CLIENT_DATA_INVALID';
    throw error;
  }
  if (!trimString(parsed?.challenge) || !trimString(parsed?.origin)) {
    const error = new Error('Invalid WebAuthn client data');
    error.code = 'WEBAUTHN_CLIENT_DATA_INVALID';
    throw error;
  }
  return {
    type: trimString(parsed.type),
    challenge: trimString(parsed.challenge),
    origin: trimString(parsed.origin),
    androidPackageName: trimString(parsed.androidPackageName),
  };
}

function assertClientOrigin(actual, expected, { clientPlatform = 'web', androidPackageName = '' } = {}) {
  const normalizedActual = trimString(actual);
  const normalizedExpected = trimString(expected);
  const androidOriginMatch = /^android:apk-key-hash:([A-Za-z0-9_+\-/=]+)$/.exec(normalizedActual);
  const androidOrigin = Boolean(androidOriginMatch)
    && (ANDROID_APK_KEY_HASHES.size === 0 || ANDROID_APK_KEY_HASHES.has(androidOriginMatch[1]));
  const nativePackageMatches = !androidPackageName || androidPackageName === ANDROID_PACKAGE_NAME;
  const valid = clientPlatform === 'android'
    ? androidOrigin && nativePackageMatches
    : normalizedActual === normalizedExpected;
  if (!valid) {
    const error = new Error('WebAuthn origin mismatch');
    error.code = 'WEBAUTHN_ORIGIN_INVALID';
    throw error;
  }
}

function assertRpAndUserVerification(authData, rpId) {
  if (!Buffer.isBuffer(authData) || authData.length < 37) {
    const error = new Error('WebAuthn authenticator data is invalid');
    error.code = 'WEBAUTHN_AUTH_DATA_INVALID';
    throw error;
  }
  const expectedRpHash = createHash('sha256').update(trimString(rpId)).digest();
  if (!authData.subarray(0, 32).equals(expectedRpHash)) {
    const error = new Error('WebAuthn RP ID hash mismatch');
    error.code = 'WEBAUTHN_RP_INVALID';
    throw error;
  }
  const flags = authData[32];
  if ((flags & 0x01) !== 0x01 || (flags & 0x04) !== 0x04) {
    const error = new Error('WebAuthn user verification is required');
    error.code = 'WEBAUTHN_USER_VERIFICATION_REQUIRED';
    throw error;
  }
}

function readSignCount(authData) {
  return Buffer.isBuffer(authData) && authData.length >= 37 ? authData.readUInt32BE(33) : 0;
}

function parseAuthenticatorAttestedCredential(authData, rpId) {
  assertRpAndUserVerification(authData, rpId);
  const flags = authData[32];
  if ((flags & 0x40) !== 0x40 || authData.length < 55) {
    const error = new Error('WebAuthn attested credential data is missing');
    error.code = 'WEBAUTHN_ATTESTED_DATA_INVALID';
    throw error;
  }
  const signCount = authData.readUInt32BE(33);
  const credentialIdLength = authData.readUInt16BE(53);
  const credentialIdStart = 55;
  const credentialIdEnd = credentialIdStart + credentialIdLength;
  const credentialId = authData.subarray(credentialIdStart, credentialIdEnd);
  const cose = decodeCbor(authData.subarray(credentialIdEnd));
  const publicKeyJwk = coseEc2ToJwk(cose);
  return {
    credentialId,
    publicKeyJwk,
    alg: -7,
    signCount,
  };
}

function coseEc2ToJwk(cose) {
  const kty = getCborMapValue(cose, 1);
  const alg = getCborMapValue(cose, 3);
  const crv = getCborMapValue(cose, -1);
  const x = getCborMapValue(cose, -2);
  const y = getCborMapValue(cose, -3);
  if (kty !== 2 || alg !== -7 || crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) {
    const error = new Error('Only ES256 WebAuthn credentials are supported');
    error.code = 'WEBAUTHN_ALG_UNSUPPORTED';
    throw error;
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: base64UrlEncode(x),
    y: base64UrlEncode(y),
    ext: true,
  };
}

function getCborMapValue(value, key) {
  if (value instanceof Map) return value.get(key);
  if (value && typeof value === 'object') return value[key];
  return undefined;
}

function decodeCbor(buffer) {
  const source = Buffer.from(buffer);
  const { value, offset } = decodeCborItem(source, 0);
  if (offset > source.length) {
    const error = new Error('Invalid CBOR');
    error.code = 'CBOR_INVALID';
    throw error;
  }
  return value;
}

function decodeCborItem(buffer, offset) {
  if (offset >= buffer.length) throw new Error('Invalid CBOR offset');
  const first = buffer[offset++];
  const major = first >> 5;
  const additional = first & 0x1f;
  const lengthResult = readCborLength(buffer, offset, additional);
  let length = lengthResult.length;
  offset = lengthResult.offset;
  if (major === 0) return { value: length, offset };
  if (major === 1) return { value: -1 - length, offset };
  if (major === 2) {
    const end = offset + length;
    return { value: buffer.subarray(offset, end), offset: end };
  }
  if (major === 3) {
    const end = offset + length;
    return { value: buffer.subarray(offset, end).toString('utf8'), offset: end };
  }
  if (major === 4) {
    const value = [];
    for (let i = 0; i < length; i += 1) {
      const item = decodeCborItem(buffer, offset);
      value.push(item.value);
      offset = item.offset;
    }
    return { value, offset };
  }
  if (major === 5) {
    const value = new Map();
    for (let i = 0; i < length; i += 1) {
      const key = decodeCborItem(buffer, offset);
      const item = decodeCborItem(buffer, key.offset);
      value.set(key.value, item.value);
      offset = item.offset;
    }
    return { value, offset };
  }
  if (major === 6) {
    const item = decodeCborItem(buffer, offset);
    return { value: item.value, offset: item.offset };
  }
  if (major === 7) {
    if (additional === 20) return { value: false, offset };
    if (additional === 21) return { value: true, offset };
    if (additional === 22) return { value: null, offset };
  }
  const error = new Error('Unsupported CBOR value');
  error.code = 'CBOR_UNSUPPORTED';
  throw error;
}

function readCborLength(buffer, offset, additional) {
  if (additional < 24) return { length: additional, offset };
  if (additional === 24) return { length: buffer[offset], offset: offset + 1 };
  if (additional === 25) return { length: buffer.readUInt16BE(offset), offset: offset + 2 };
  if (additional === 26) return { length: buffer.readUInt32BE(offset), offset: offset + 4 };
  const error = new Error('Unsupported CBOR length');
  error.code = 'CBOR_LENGTH_UNSUPPORTED';
  throw error;
}
