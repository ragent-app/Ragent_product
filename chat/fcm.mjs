import { createSign } from 'crypto';
import { readFile } from 'fs/promises';
import { dirname } from 'path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { createSerialTaskQueue, ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { loadInstanceIdentity } from '../lib/instance-identity.mjs';

const TOKEN_FILE = process.env.AGENTOC_FCM_TOKENS_FILE || `${CONFIG_DIR}/fcm-tokens.json`;
const FCM_SEND_CONCURRENCY = Math.max(
  1,
  Math.min(32, Number.parseInt(process.env.AGENTOC_FCM_SEND_CONCURRENCY || '8', 10) || 8),
);
const mutationQueue = createSerialTaskQueue();
let accessToken = null;

async function serviceAccount() {
  const parse = (raw) => {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (!value.project_id || !value.client_email || !value.private_key) return null;
      return value;
    } catch {
      return null;
    }
  };
  const file = String(process.env.AGENTOC_FCM_SERVICE_ACCOUNT_FILE || '').trim();
  if (file) {
    try {
      const value = parse(await readFile(file, 'utf8'));
      if (value) return value;
    } catch {
      // Fall through to the legacy environment-based configuration.
    }
  }
  const configured = process.env.AGENTOC_FCM_SERVICE_ACCOUNT_JSON
    || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    || '';
  return parse(configured);
}

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function loadTokens() {
  const value = await readJson(TOKEN_FILE, []);
  return Array.isArray(value) ? value.filter((item) => item && typeof item.token === 'string' && item.token.trim()) : [];
}

async function saveTokens(tokens) {
  await ensureDir(dirname(TOKEN_FILE));
  await writeJsonAtomic(TOKEN_FILE, tokens);
}

export async function isFcmConfigured() { return Boolean(await serviceAccount()); }

export async function registerFcmToken({ token, deviceId = '', platform = 'android', appVersion = '' } = {}) {
  const normalized = String(token || '').trim();
  if (!normalized || normalized.length > 4096) throw new Error('Invalid FCM token');
  await mutationQueue(async () => {
    const tokens = await loadTokens();
    const now = new Date().toISOString();
    const record = { token: normalized, deviceId: String(deviceId || '').trim(), platform, appVersion, updatedAt: now };
    const index = tokens.findIndex((item) => item.token === normalized || (record.deviceId && item.deviceId === record.deviceId));
    if (index >= 0) tokens[index] = { ...tokens[index], ...record };
    else tokens.push({ ...record, createdAt: now });
    await saveTokens(tokens);
  });
}

export async function unregisterFcmToken(token) {
  const normalized = String(token || '').trim();
  if (!normalized) return;
  await mutationQueue(async () => {
    const tokens = await loadTokens();
    await saveTokens(tokens.filter((item) => item.token !== normalized));
  });
}

async function getAccessToken(account) {
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value;
  const now = Math.floor(Date.now() / 1000);
  const assertion = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(assertion);
  const signed = `${assertion}.${base64url(signer.sign(account.private_key))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signed }),
  });
  if (!response.ok) throw new Error(`FCM OAuth failed (${response.status})`);
  const payload = await response.json();
  accessToken = { value: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 };
  return accessToken.value;
}

export async function sendFcm(payload) {
  const account = await serviceAccount();
  if (!account) return false;
  const tokens = await loadTokens();
  if (!tokens.length) return false;
  // The producer's durable identity is authoritative, never a payload override.
  // Read only: notification delivery must not create or rotate an instance key.
  const identity = await loadInstanceIdentity();
  if (!identity) return false;
  const data = createFcmMessageData(payload, identity.instanceId);
  const bearer = await getAccessToken(account);
  const stale = new Set();
  let cursor = 0;
  const sendOne = async (record, index) => {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: {
        token: record.token,
        // Keep rendering in the native service so channel selection and the
        // session deep link are identical whether the app is foregrounded or
        // backgrounded.  HIGH is required for time-sensitive attention events.
        android: { priority: 'HIGH' },
        data,
      } }),
    });
    if (response.status === 404 || response.status === 400) stale.add(index);
    if (!response.ok && !stale.has(index)) console.warn(`[fcm] send failed (${response.status})`);
  };
  await Promise.all(Array.from({
    length: Math.min(FCM_SEND_CONCURRENCY, tokens.length),
  }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tokens.length) return;
      await sendOne(tokens[index], index);
    }
  }));
  if (stale.size) await removeRejectedFcmTokens([...stale].map((index) => tokens[index].token));
  return true;
}

/** Remove only rejected tokens from live storage; a send snapshot may precede rotation. */
export async function removeRejectedFcmTokens(rejectedTokens) {
  const rejected = new Set(rejectedTokens);
  await mutationQueue(async () => {
    const latest = await loadTokens();
    await saveTokens(latest.filter((record) => !rejected.has(record.token)));
  });
}

/** Small explicit data contract. Never forward arbitrary source fields or credentials. */
export function createFcmMessageData(payload, instanceId) {
  const id = /^[A-Za-z0-9_-]{1,160}$/;
  if (typeof instanceId !== 'string' || !id.test(instanceId)
      || typeof payload?.sessionId !== 'string' || !id.test(payload.sessionId)) {
    throw new Error('Invalid FCM source or session');
  }
  const data = { notificationContractVersion: '1', instanceId, sessionId: payload.sessionId };
  for (const [key, limit] of Object.entries({ title: 256, body: 2048, tab: 64, kind: 64, awaitingKey: 512, eventId: 256, runId: 256 })) {
    const value = payload?.[key] ?? '';
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > limit || /[\u0000-\u001f]/.test(value)) {
      throw new Error(`Invalid FCM ${key}`);
    }
    data[key] = value;
  }
  return data;
}
