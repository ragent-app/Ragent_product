import webpush from 'web-push';
import { dirname } from 'path';
import { VAPID_KEYS_FILE, PUSH_SUBSCRIPTIONS_FILE } from '../lib/config.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { createSerialTaskQueue, ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { sendFcm } from './fcm.mjs';

let ready = false;
let initPromise = null;
let cachedKeys = null;
const PUSH_TIMEOUT_MS = Number.parseInt(process.env.PUSH_TIMEOUT_MS || '5000', 10);
const PUSH_NETWORK_FAILURE_THRESHOLD = Number.parseInt(process.env.PUSH_NETWORK_FAILURE_THRESHOLD || '3', 10);
const PUSH_NETWORK_BACKOFF_MS = Number.parseInt(process.env.PUSH_NETWORK_BACKOFF_MS || `${30 * 60 * 1000}`, 10);
const PUSH_SEND_CONCURRENCY = Math.max(
  1,
  Math.min(32, Number.parseInt(process.env.AGENTOC_PUSH_SEND_CONCURRENCY || '8', 10) || 8),
);
const runSubscriptionMutation = createSerialTaskQueue();
const pushTransportEnv = buildToolProcessEnv();

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function resolvePushSendOptions(env = pushTransportEnv) {
  const options = { timeout: PUSH_TIMEOUT_MS };
  const proxy = firstNonEmpty(
    env?.AGENTOC_PUSH_PROXY,
    env?.HTTPS_PROXY,
    env?.https_proxy,
    env?.HTTP_PROXY,
    env?.http_proxy,
  );
  if (proxy) options.proxy = proxy;
  return options;
}

async function loadOrGenerateKeys() {
  if (cachedKeys) return cachedKeys;
  const existing = await readJson(VAPID_KEYS_FILE, null);
  if (existing) {
    cachedKeys = existing;
    return cachedKeys;
  }
  cachedKeys = webpush.generateVAPIDKeys();
  await ensureDir(dirname(VAPID_KEYS_FILE));
  await writeJsonAtomic(VAPID_KEYS_FILE, cachedKeys);
  console.log('[push] Generated new VAPID keys');
  return cachedKeys;
}

async function init() {
  if (ready) return;
  if (!initPromise) {
    initPromise = (async () => {
      const keys = await loadOrGenerateKeys();
      webpush.setVapidDetails('mailto:agentoc@localhost', keys.publicKey, keys.privateKey);
      ready = true;
    })();
  }
  await initPromise;
}

function buildMeta(meta = {}) {
  return {
    failureCount: Number.isFinite(meta.failureCount) ? meta.failureCount : 0,
    disabledUntil: Number.isFinite(meta.disabledUntil) ? meta.disabledUntil : 0,
    lastError: typeof meta.lastError === 'string' ? meta.lastError : '',
  };
}

function withFreshMeta(sub) {
  return { ...sub, __meta: buildMeta() };
}

function normalizeSubs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.endpoint === 'string')
    .map((entry) => ({ ...entry, __meta: buildMeta(entry.__meta) }));
}

function isInBackoff(sub) {
  return sub?.__meta?.disabledUntil > Date.now();
}

function clearNetworkFailure(sub) {
  return withFreshMeta(sub);
}

function isNetworkFailure(err) {
  const code = `${err?.code || ''}`.toUpperCase();
  if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPROTO'].includes(code)) {
    return true;
  }
  const message = `${err?.message || ''}`.toLowerCase();
  return [
    'socket timeout',
    'timed out',
    'tls',
    'client network socket disconnected',
    'econnreset',
    'eai_again',
    'unexpected response code',
  ].some((fragment) => message.includes(fragment));
}

function recordNetworkFailure(sub, err) {
  const failureCount = (sub?.__meta?.failureCount || 0) + 1;
  const disabledUntil = failureCount >= PUSH_NETWORK_FAILURE_THRESHOLD
    ? Date.now() + PUSH_NETWORK_BACKOFF_MS
    : 0;
  return {
    ...sub,
    __meta: {
      failureCount,
      disabledUntil,
      lastError: `${err?.message || 'network_error'}`,
    },
  };
}

export async function getPublicKey() {
  await init();
  return cachedKeys.publicKey;
}

async function loadSubs() {
  return normalizeSubs(await readJson(PUSH_SUBSCRIPTIONS_FILE, []));
}

async function saveSubs(subs) {
  await ensureDir(dirname(PUSH_SUBSCRIPTIONS_FILE));
  await writeJsonAtomic(PUSH_SUBSCRIPTIONS_FILE, subs);
}

export async function addSubscription(sub) {
  await init();
  await runSubscriptionMutation(async () => {
    const subs = await loadSubs();
    const idx = subs.findIndex((entry) => entry.endpoint === sub.endpoint);
    const next = withFreshMeta(sub);
    if (idx >= 0) subs[idx] = next;
    else subs.push(next);
    await saveSubs(subs);
    console.log(`[push] Subscription saved (total: ${subs.length})`);
  });
}

function buildSessionUrl(session) {
  const params = new URLSearchParams();
  if (session?.id) params.set('session', session.id);
  params.set('tab', 'sessions');
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

// Shared send fan-out over all non-backoff subscriptions. Prepares the payload
// (which may be data/JSON), persists backoff/stale bookkeeping, and cleans up
// stale subscriptions. Reused by completion and user-attention pushes.
async function dispatchPush(payload) {
  await init();
  const subs = await loadSubs();
  if (subs.length === 0) return false;

  const activeCount = subs.filter((sub) => !isInBackoff(sub)).length;
  if (activeCount === 0) return false;

  const stale = new Set();
  let changed = false;
  const nextSubs = [...subs];
  const sendable = subs
    .map((sub, index) => ({ sub, index }))
    .filter(({ sub }) => !isInBackoff(sub));
  let cursor = 0;
  const sendOne = async ({ sub, index: i }) => {
    if (isInBackoff(sub)) return;
    try {
      await webpush.sendNotification(sub, payload, resolvePushSendOptions());
      if ((sub?.__meta?.failureCount || 0) > 0 || (sub?.__meta?.disabledUntil || 0) > 0 || sub?.__meta?.lastError) {
        nextSubs[i] = clearNetworkFailure(sub);
        changed = true;
      }
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) stale.add(i);
      else if (isNetworkFailure(err)) {
        nextSubs[i] = recordNetworkFailure(sub, err);
        changed = true;
        const meta = nextSubs[i].__meta;
        if (meta.disabledUntil > 0) {
          console.warn(`[push] Backing off subscription for ${Math.round(PUSH_NETWORK_BACKOFF_MS / 60000)}m after ${meta.failureCount} network failures: ${err.message}`);
        } else {
          console.warn(`[push] Send failed (${meta.failureCount}/${PUSH_NETWORK_FAILURE_THRESHOLD}): ${err.message}`);
        }
    } else {
        console.warn(`[push] Send failed: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({
    length: Math.min(PUSH_SEND_CONCURRENCY, sendable.length),
  }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= sendable.length) return;
      await sendOne(sendable[index]);
    }
  }));

  if (changed || stale.size > 0) {
    await runSubscriptionMutation(async () => {
      await saveSubs(nextSubs.filter((_, i) => !stale.has(i)));
    });
  }

  if (stale.size > 0) {
    console.log(`[push] Removed ${stale.size} stale subscription(s)`);
  }
  return true;
}

export async function sendCompletionPush(session, { runId = '', eventId = '' } = {}) {
  const folder = (session?.folder || '').split('/').pop() || 'Session';
  const name = session?.name || folder;
  const rawTerminalRunId = String(runId || '').trim();
  const terminalRunId = rawTerminalRunId.length <= 256 ? rawTerminalRunId : '';
  const rawEventId = String(eventId || terminalRunId).trim();
  const notificationEventId = rawEventId.length <= 256 ? rawEventId : '';
  const payload = JSON.stringify({
    title: 'Ragent',
    body: `${name} — task completed`,
    sessionId: session?.id || null,
    tab: 'sessions',
    url: buildSessionUrl(session),
    kind: 'completion',
    eventId: notificationEventId,
    runId: terminalRunId,
  });
  const web = dispatchPush(payload);
  const fcm = sendFcm({
    title: 'Ragent', body: `${name} — task completed`, sessionId: session?.id || null, tab: 'sessions', kind: 'completion',
    eventId: notificationEventId, runId: terminalRunId,
  }).catch(() => false);
  const [webResult, fcmResult] = await Promise.all([web, fcm]);
  return webResult || fcmResult;
}

// Push when a session needs the user's attention: a pending approval or a
// question the model is waiting on. `detail` carries the waiting subtype so the
// notification is specific (plan / dangerous action / answer / approve).
export async function sendUserAttentionPush(session, detail = {}) {
  const folder = (session?.folder || '').split('/').pop() || 'Session';
  const name = session?.name || folder;
  const label = String(detail?.label || 'needs your attention').trim();
  const body = `${name} — ${label}`;
  const rawEventId = String(detail?.eventId || '').trim();
  const eventId = rawEventId.length <= 256 ? rawEventId : '';
  const rawRunId = String(detail?.runId || session?.activity?.run?.runId || session?.activity?.run?.id || session?.currentRunId || '').trim();
  const runId = rawRunId.length <= 256 ? rawRunId : '';
  const payload = JSON.stringify({
    title: 'Ragent',
    body,
    sessionId: session?.id || null,
    tab: 'sessions',
    url: buildSessionUrl(session),
    kind: detail?.kind || 'attention',
    awaitingKey: detail?.key || label,
    eventId,
    runId,
  });
  const web = dispatchPush(payload);
  const fcm = sendFcm({
    title: 'Ragent', body, sessionId: session?.id || null, tab: 'sessions', kind: detail?.kind || 'attention', awaitingKey: detail?.key || label,
    eventId, runId,
  }).catch(() => false);
  const [webResult, fcmResult] = await Promise.all([web, fcm]);
  return webResult || fcmResult;
}
