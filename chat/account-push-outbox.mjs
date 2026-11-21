import { createHash, randomBytes } from 'crypto';
import { join } from 'path';
import { ACCOUNTS_URL, CONFIG_DIR } from '../lib/config.mjs';
import { loadInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { createSerialTaskQueue, readJsonStrict, writeJsonAtomic } from './fs-utils.mjs';

// Only the control process owns this file. Accepted and rejected entries remain
// available for diagnosis; old local FCM token files are deliberately untouched.
const OUTBOX_FILE = join(CONFIG_DIR, 'account-push-outbox.json');
const MAX_PENDING = 2048;
const MAX_RECENT_RESULTS = 256;
const RESULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const mutate = createSerialTaskQueue();
let timer = null;
let draining = false;
let started = false;
let lastLocalError = '';

async function readOutbox() {
  try {
    const value = await readJsonStrict(OUTBOX_FILE);
    if (!Array.isArray(value)) throw new Error('Invalid push outbox');
    return value;
  } catch (error) {
    if (error?.code === 'JSON_NOT_FOUND') return [];
    throw error;
  }
}

async function saveOutbox(entries) {
  const cutoff = Date.now() - RESULT_RETENTION_MS;
  const pending = entries.filter((entry) => entry.state === 'pending');
  const recent = entries.filter((entry) => entry.state !== 'pending' && (entry.lastAttemptAt || entry.createdAt || 0) >= cutoff)
    .sort((a, b) => (b.lastAttemptAt || b.createdAt || 0) - (a.lastAttemptAt || a.createdAt || 0))
    .slice(0, MAX_RECENT_RESULTS);
  try {
    await writeJsonAtomic(OUTBOX_FILE, [...pending, ...recent], { mode: 0o600, durable: true });
    lastLocalError = '';
  } catch (error) {
    lastLocalError = 'storage_unavailable';
    throw error;
  }
}

export async function getAccountPushStatus() {
  return mutate(async () => {
    const entries = await readOutbox();
    const recent = [...entries].filter((entry) => entry.lastAttemptAt).sort((a, b) => b.lastAttemptAt - a.lastAttemptAt)[0];
    return { countsScope: 'retained_recent', pending: entries.filter((entry) => entry.state === 'pending').length,
      accepted: entries.filter((entry) => entry.state === 'accepted').length,
      rejected: entries.filter((entry) => entry.state === 'rejected').length,
      maxPending: MAX_PENDING, lastLocalError,
      lastAttemptAt: recent?.lastAttemptAt || null, lastResult: recent?.lastResult || '' };
  });
}

function summarizeOutboxEntry(entry) {
  if (!entry) return null;
  return {
    kind: entry.kind,
    eventId: entry.eventId,
    state: entry.state,
    attempts: entry.attempts || 0,
    lastAttemptAt: entry.lastAttemptAt || null,
    lastResult: entry.lastResult || '',
    occurredAt: entry.occurredAt,
    expiresAt: entry.expiresAt,
  };
}

export async function getAccountPushEntryStatus(kind, eventId) {
  if (typeof kind !== 'string' || typeof eventId !== 'string' || !kind || !eventId) return null;
  return mutate(async () => {
    const entries = await readOutbox();
    return summarizeOutboxEntry(entries.find((entry) => entry.kind === kind && entry.eventId === eventId));
  });
}

export async function getAccountPushEntriesStatus(pairs = []) {
  const list = Array.isArray(pairs) ? pairs.filter((pair) => pair?.kind && pair?.eventId) : [];
  if (!list.length) return new Map();
  return mutate(async () => {
    const entries = await readOutbox();
    const byKey = new Map(entries.map((entry) => [`${entry.kind}\0${entry.eventId}`, summarizeOutboxEntry(entry)]));
    const result = new Map();
    for (const { kind, eventId } of list) {
      const key = `${kind}\0${eventId}`;
      const found = byKey.get(key);
      if (found) result.set(key, found);
    }
    return result;
  });
}

function schedule(delay = 0) {
  if (!started || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void drain().catch(() => { console.warn('[account-push] outbox unavailable'); schedule(60_000); });
  }, delay);
  timer.unref?.();
}

export function startAccountPushOutbox() {
  if (started) return;
  started = true;
  schedule();
}

export function stopAccountPushOutbox() {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export async function enqueueAccountPush({ sessionId, kind, runId = '', eventId = '', awaitingKey = '', generation = '', occurredAt, historySource = null }) {
  const clean = (value, max) => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid push event field');
    return value.trim();
  };
  sessionId = clean(sessionId, 160);
  kind = clean(kind, 64);
  runId = clean(runId, 256);
  eventId = clean(eventId, 256);
  awaitingKey = clean(awaitingKey, 512);
  generation = clean(generation, 20);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) || !['completion', 'plan', 'permission', 'answer', 'danger', 'approval', 'attention', 'attention_resolved'].includes(kind)) throw new Error('Invalid push event');
  if ((kind === 'attention_resolved' || ['plan', 'permission', 'answer', 'danger', 'approval'].includes(kind)) && (!awaitingKey || !/^[1-9][0-9]*$/.test(generation))) throw new Error('Push approval generation unavailable');
  // Never invent a run or approval identity. Waiting events can use their
  // real run and waiting key as a stable source when no approval id exists.
  if (!eventId && runId && kind === 'attention') eventId = `waiting-${createHash('sha256').update(JSON.stringify([sessionId, runId, awaitingKey])).digest('hex')}`;
  if (!eventId) throw new Error('Push event identity unavailable');
  const when = typeof occurredAt === 'number' ? occurredAt : Date.parse(occurredAt || '');
  if (!Number.isSafeInteger(when) || when <= 0) throw new Error('Push event occurrence time unavailable');
  const expiresAt = when + (kind === 'completion' || kind === 'attention_resolved' ? 24 * 60 * 60_000 : 15 * 60_000);
  const source = await loadInstanceIdentity().catch(() => null);
  await mutate(async () => {
    const entries = await readOutbox();
    const existing = entries.find((entry) => entry.kind === kind && entry.eventId === eventId);
    if (existing) {
      if (existing.sessionId !== sessionId || existing.runId !== runId || existing.awaitingKey !== awaitingKey || existing.generation !== generation) throw new Error('Conflicting push event identity');
      if (existing.state === 'rejected' && existing.lastResult === 'history_event_mismatch' && historySource) {
        Object.assign(existing, { occurredAt: when, expiresAt, historySource, instanceId: source?.instanceId || '', state: 'pending', attempts: 0, nextAttemptAt: 0, createdAt: Date.now(), lastResult: '' });
        await saveOutbox(entries);
        return;
      }
      if (existing.historySource && historySource && existing.historySource.seq === historySource.seq && existing.occurredAt !== when && existing.state === 'pending') {
        existing.occurredAt = when;
        existing.expiresAt = expiresAt;
        await saveOutbox(entries);
      }
      return;
    }
    if (entries.filter((entry) => entry.state === 'pending').length >= MAX_PENDING) {
      lastLocalError = 'outbox_full';
      throw new Error('Push outbox full');
    }
    entries.push({ sessionId, kind, runId, eventId, awaitingKey, generation, occurredAt: when, expiresAt, historySource, instanceId: source?.instanceId || '', state: 'pending', attempts: 0, nextAttemptAt: 0, createdAt: Date.now() });
    await saveOutbox(entries);
  });
  schedule();
  return true; // Persisted locally, not a delivery receipt.
}

async function submit(entry, { fetchImpl = globalThis.fetch } = {}) {
  if (entry.expiresAt <= Date.now()) return { rejected: true, reason: 'expired' };
  // History intents are written before the canonical event. An interrupted or
  // failed append must never produce a notification for an event that did not
  // commit. Recheck on every attempt, including recovery after restart.
  if (entry.historySource) {
    const { readPushSourceEvent } = await import('./history.mjs');
    const event = await readPushSourceEvent(entry.sessionId, entry.historySource.seq);
    if (!event) return { retry: true, reason: 'history_not_committed' };
    const key = String(event.approvalId || event.providerApprovalId || event.batchId || '').trim();
    const occurred = typeof event.timestamp === 'number' ? event.timestamp : Date.parse(event.timestamp || '');
    if (event.type !== entry.historySource.type || key !== entry.awaitingKey || occurred !== entry.occurredAt || String(event.runId || '').trim() !== entry.runId) {
      return { rejected: true, reason: 'history_event_mismatch' };
    }
  }
  const identity = await loadInstanceIdentity();
  if (!identity || !ACCOUNTS_URL) return { retry: true, reason: 'identity_or_accounts_unavailable' };
  if (entry.instanceId && entry.instanceId !== identity.instanceId) return { rejected: true, reason: 'instance_identity_changed' };
  if (!entry.instanceId) {
    await mutate(async () => {
      const entries = await readOutbox();
      const current = entries.find((item) => item.kind === entry.kind && item.eventId === entry.eventId);
      if (!current || current.state !== 'pending') throw new Error('Push event unavailable');
      if (current.instanceId && current.instanceId !== identity.instanceId) throw new Error('Push identity changed');
      current.instanceId = identity.instanceId;
      await saveOutbox(entries);
    });
  }
  let base;
  try {
    base = new URL(ACCOUNTS_URL);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error();
  } catch { return { retry: true, reason: 'accounts_unavailable' }; }
  const instanceId = identity.instanceId;
  const { eventId, sessionId, kind, runId, awaitingKey, generation } = entry;
  const { occurredAt, expiresAt } = entry;
  const issuedAt = Date.now();
  const nonce = randomBytes(24).toString('base64url');
  const message = JSON.stringify(['ragent-push-event-v1', instanceId, eventId, sessionId, kind, runId, awaitingKey, generation, occurredAt, expiresAt, issuedAt, nonce]);
  const signature = signWithInstanceIdentity(identity, message);
  const response = await fetchImpl(`${base.toString().replace(/\/$/, '')}/v1/push/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId, eventId, sessionId, kind, runId, awaitingKey, generation, occurredAt, expiresAt, issuedAt, nonce, signature }),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 200) {
    const receipt = await response.json();
    if (receipt?.ok === true && receipt?.accepted === true && receipt.instanceId === instanceId && receipt.kind === kind && receipt.eventId === eventId) return { accepted: true };
    return { retry: true, reason: 'invalid_receipt' };
  }
  let replayed = false;
  if (response.status === 409) {
    try { replayed = (await response.json())?.code === 'push_replayed'; } catch { /* malformed errors are not accepted */ }
  }
  if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 429 || response.status >= 500 || replayed) {
    const retryAfter = response.headers.get('retry-after');
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter || '');
    const retryAfterMs = response.status === 429 && retryAfter
      ? (Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0) : 0;
    return { retry: true, reason: `http_${response.status}`, retryAfterMs };
  }
  return { rejected: true, reason: `http_${response.status}` };
}

async function drain({ fetchImpl = globalThis.fetch, runWhenStopped = false } = {}) {
  if (draining) return;
  draining = true;
  try {
    while (started || runWhenStopped) {
      const entry = await mutate(async () => (await readOutbox()).find((item) => item.state === 'pending' && ((item.nextAttemptAt || 0) <= Date.now() || item.expiresAt <= Date.now())));
      if (!entry) break;
      let result;
      try { result = await submit(entry, { fetchImpl }); } catch { result = { retry: true, reason: 'transport_unavailable' }; }
      await mutate(async () => {
        const entries = await readOutbox();
        const current = entries.find((item) => item.kind === entry.kind && item.eventId === entry.eventId);
        if (!current || current.state !== 'pending') return;
        current.attempts = (current.attempts || 0) + 1;
        current.lastAttemptAt = Date.now();
        current.lastResult = result.reason || 'accepted';
        if (result.accepted) current.state = 'accepted';
        else if (result.rejected) current.state = 'rejected';
        else {
          const backoff = Math.min(30 * 60_000, 5_000 * 2 ** Math.min(current.attempts - 1, 9));
          const jittered = backoff * (0.75 + Math.random() * 0.5);
          current.nextAttemptAt = Date.now() + Math.max(jittered, result.retryAfterMs || 0);
        }
        await saveOutbox(entries);
      });
    }
  } finally {
    draining = false;
    if (started) schedule(5_000);
  }
}

export async function drainAccountPushOutbox({ fetchImpl = globalThis.fetch } = {}) {
  return drain({ fetchImpl, runWhenStopped: true });
}
