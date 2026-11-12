// Trusted-device signature handshake for entry switching.
// A paired device signs a fresh timestamp and receives a short-lived,
// one-time credential. This authenticates device access; it does not carry
// configuration or session data between instances.
import { randomBytes, createPublicKey, verify } from 'crypto';
import { join } from 'path';
import { CONFIG_DIR } from './config.mjs';
import { readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';
import { authorizeDeviceBinding, assertDeviceBindingNow } from './binding-authority-runtime.mjs';

export const HANDSHAKE_TTL_MS = 5 * 60 * 1000;
export const HANDSHAKE_SKEW_MS = 5 * 60 * 1000;
// Keep the existing filename so in-flight entry-switch credentials survive
// the route/module rename. This file contains no configuration data.
export const DEVICE_HANDSHAKE_TOKENS_FILE = join(CONFIG_DIR, 'sync-handshake-tokens.json');

export function buildHandshakeMessage({ deviceId, timestamp }) {
  return `agentoc-sync-handshake-v2\n${deviceId}\n${timestamp}`;
}

export function normalizeSignature(signature) {
  const padded = String(signature || '').replace(/-/g, '+').replace(/_/g, '/');
  return padded.padEnd(Math.ceil(padded.length / 4) * 4, '=');
}

export function verifyDeviceSignature({ message, signature, publicKeyPem }) {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const sigBytes = Buffer.from(normalizeSignature(signature), 'base64');
    return verify(null, Buffer.from(message, 'utf8'), publicKey, sigBytes);
  } catch {
    return false;
  }
}

export function isFreshTimestamp(timestamp) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return Math.abs(Date.now() - ts) <= HANDSHAKE_SKEW_MS;
}

export async function issueDeviceHandshakeToken({ deviceId, ownerId, ownerKind = 'account' }) {
  const { getTrustedDeviceStatus } = await import('../chat/trusted-devices.mjs');
  const device = await getTrustedDeviceStatus(deviceId);
  if (device?.workspaceAccess) throw Object.assign(new Error('Entry switching is unavailable for shared workspaces'),
    { code: 'workspace_capability_unsupported', statusCode: 403 });
  const authority = await authorizeDeviceBinding(device);
  const tokens = (await readJson(DEVICE_HANDSHAKE_TOKENS_FILE, null)) || { tokens: {} };
  const now = Date.now();
  for (const [key, record] of Object.entries(tokens.tokens)) {
    if (!record.expiresAt || Date.parse(record.expiresAt) < now) delete tokens.tokens[key];
  }
  const token = randomBytes(24).toString('hex');
  tokens.tokens[token] = {
    deviceId,
    ownerId,
    ownerKind,
    ...(authority ? { accountId: authority.accountId, bindingAuthorityRevision: authority.revision } : {}),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + HANDSHAKE_TTL_MS).toISOString(),
    used: false,
  };
  assertDeviceBindingNow(device);
  await writeJsonAtomic(DEVICE_HANDSHAKE_TOKENS_FILE, tokens, { mode: 0o600 });
  return { token, expiresAt: tokens.tokens[token].expiresAt };
}

export async function consumeDeviceHandshakeToken(token) {
  const normalized = String(token || '').trim();
  if (!/^[0-9a-f]{48}$/.test(normalized)) return null;
  const tokens = (await readJson(DEVICE_HANDSHAKE_TOKENS_FILE, null)) || { tokens: {} };
  const record = tokens.tokens[normalized];
  if (!record || record.used) return null;
  if (!record.expiresAt || Date.parse(record.expiresAt) < Date.now()) return null;
  const { getTrustedDeviceStatus } = await import('../chat/trusted-devices.mjs');
  const device = await getTrustedDeviceStatus(record.deviceId);
  try { await authorizeDeviceBinding(device, { credential: true, tokenRevision: record.bindingAuthorityRevision }); }
  catch { return null; }
  record.used = true;
  await writeJsonAtomic(DEVICE_HANDSHAKE_TOKENS_FILE, tokens, { mode: 0o600 });
  return {
    deviceId: record.deviceId,
    ownerId: record.ownerId || '',
    ownerKind: record.ownerKind || '',
  };
}
