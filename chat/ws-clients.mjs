/**
 * Shared global WebSocket broadcast.
 * Decoupled from ws.mjs to avoid circular imports.
 */
import { allowsRemoteBinding } from '../lib/binding-authority-runtime.mjs';
import { sessionLiveFeed, sessionRealtimeLiveFeed, publishAllLiveEvents } from './session-live-feed.mjs';
import { notifySessionEvents } from './session-event-waiter.mjs';
let wss = null;
const MAX_WS_BUFFERED_BYTES = Math.max(
  64 * 1024,
  Number.parseInt(process.env.RAGENT_WS_MAX_BUFFERED_BYTES || String(2 * 1024 * 1024), 10)
    || 2 * 1024 * 1024,
);
const MAX_WS_SLOW_SENDS = 5;
const OWNER_INVALIDATION_COALESCE_MS = 50;
const ownerInvalidationListeners = new Set();
const pendingOwnerInvalidations = new Map();

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function maxEventSeq(events) {
  if (!Array.isArray(events)) return 0;
  let max = 0;
  for (const event of events) {
    max = Math.max(max, positiveInt(event?.endSeq), positiveInt(event?.seq));
  }
  return max;
}

function sanitizeOwnerInvalidation(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const type = typeof msg.type === 'string' ? msg.type.trim() : '';
  if (!type) return null;
  if (type === 'session_events' || type === 'session_invalidated') {
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId.trim() : '';
    if (!sessionId) return null;
    const latestSeq = positiveInt(msg.latestSeq) || (type === 'session_events' ? maxEventSeq(msg.events) : 0);
    return {
      type: 'session_invalidated',
      sessionId,
      ...(latestSeq > 0 ? { latestSeq } : {}),
    };
  }
  if (!type.endsWith('_invalidated')) return null;
  if (type === 'sessions_invalidated' || type === 'projects_invalidated' || type === 'windows_broker_approvals_invalidated') {
    return { type };
  }
  if (type === 'project_invalidated') {
    return {
      type,
      ...(typeof msg.projectId === 'string' && msg.projectId ? { projectId: msg.projectId } : {}),
    };
  }
  if (type === 'harnesses_invalidated' || type === 'harness_invalidated') {
    return {
      type,
      ...(typeof msg.harness === 'string' && msg.harness ? { harness: msg.harness } : {}),
    };
  }
  if (type === 'target_runtime_summary_invalidated') {
    return {
      type,
      ...(typeof msg.targetId === 'string' && msg.targetId ? { targetId: msg.targetId } : {}),
      ...(msg.revision != null ? { revision: msg.revision } : {}),
      ...(msg.cursor != null ? { cursor: msg.cursor } : {}),
    };
  }
  if (type === 'organization_invalidated') {
    return {
      type,
      ...(typeof msg.organizationId === 'string' && msg.organizationId ? { organizationId: msg.organizationId } : {}),
      ...(Number.isInteger(msg.eventId) ? { eventId: msg.eventId } : {}),
      ...(Number.isInteger(msg.revision) ? { revision: msg.revision } : {}),
      ...(Number.isInteger(msg.progressEpoch) ? { progressEpoch: msg.progressEpoch } : {}),
      ...(msg.projectionDigest != null ? { projectionDigest: msg.projectionDigest } : {}),
    };
  }
  return {
    type,
    ...(typeof msg.sessionId === 'string' && msg.sessionId ? { sessionId: msg.sessionId } : {}),
  };
}

function ownerInvalidationKey(payload) {
  return `${payload.type}:${payload.sessionId || payload.organizationId || payload.projectId || ''}`;
}

function mergeOwnerInvalidation(prev, next) {
  const latestSeq = Math.max(positiveInt(prev?.latestSeq), positiveInt(next?.latestSeq));
  return {
    ...prev,
    ...next,
    ...(latestSeq > 0 ? { latestSeq } : {}),
  };
}

export function notifyOwnerInvalidation(msg) {
  if (ownerInvalidationListeners.size === 0) return;
  const normalized = sanitizeOwnerInvalidation(msg);
  if (!normalized) return;
  const key = ownerInvalidationKey(normalized);
  const existing = pendingOwnerInvalidations.get(key);
  if (existing) {
    existing.payload = mergeOwnerInvalidation(existing.payload, normalized);
    return;
  }
  const entry = { payload: normalized, timer: null };
  entry.timer = setTimeout(() => {
    if (pendingOwnerInvalidations.get(key) === entry) {
      pendingOwnerInvalidations.delete(key);
    }
    const payload = entry.payload;
    for (const listener of [...ownerInvalidationListeners]) {
      try { listener(payload); } catch {}
    }
  }, OWNER_INVALIDATION_COALESCE_MS);
  entry.timer.unref?.();
  pendingOwnerInvalidations.set(key, entry);
}

export function subscribeOwnerInvalidations(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('listener must be a function');
  }
  ownerInvalidationListeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ownerInvalidationListeners.delete(listener);
    if (ownerInvalidationListeners.size === 0) {
      for (const entry of pendingOwnerInvalidations.values()) {
        clearTimeout(entry.timer);
      }
      pendingOwnerInvalidations.clear();
    }
  };
}

export function sendWithBackpressure(client, data, fallbackData = null) {
  if (!allowsRemoteBinding(client?._authSession)) {
    try { client.close?.(1008, 'Binding authorization expired'); } catch {}
    return false;
  }
  const bufferedAmount = Number(client?.bufferedAmount) || 0;
  if (bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    client._ragentSlowSendCount = (client._ragentSlowSendCount || 0) + 1;
    // An invalidation is cheap and lets the client recover the authoritative
    // delta later.  Never keep queueing full event batches for a slow mobile
    // or tunnel connection.
    if (fallbackData && bufferedAmount <= MAX_WS_BUFFERED_BYTES * 2) {
      try { client.send(fallbackData); } catch {}
    }
    if (client._ragentSlowSendCount >= MAX_WS_SLOW_SENDS) {
      try { client.close?.(1013, 'client too slow'); } catch {}
    }
    return false;
  }
  try {
    client.send(data);
    client._ragentSlowSendCount = 0;
    return true;
  } catch {
    return false;
  }
}

export function setWss(instance) {
  wss = instance;
}

export function getClientsMatching(predicate = () => true) {
  if (!wss) return [];
  const matches = [];
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (!allowsRemoteBinding(client._authSession)) continue;
    if (!predicate(client)) continue;
    matches.push(client);
  }
  return matches;
}

export function closeInvalidBindingClients({ deviceId = '' } = {}) {
  if (!wss) return;
  for (const client of wss.clients) {
    if ((deviceId && client._authSession?.deviceId === deviceId) || !allowsRemoteBinding(client._authSession)) {
      try { client.close(1008, 'Binding authorization expired'); } catch {}
      const timer = setTimeout(() => { try { client.terminate?.(); } catch {} }, 500);
      timer.unref?.();
    }
  }
}

export function broadcastMatching(msg, predicate = () => true) {
  let ownerMatches = false;
  try {
    ownerMatches = Boolean(predicate({ readyState: 1, _authSession: { role: 'owner' } }));
  } catch {
    ownerMatches = false;
  }
  if (ownerMatches) {
    notifyOwnerInvalidation(msg);
  }
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (!predicate(client)) continue;
    const fallback = msg?.type === 'session_events'
      ? JSON.stringify({ type: 'session_invalidated', sessionId: msg.sessionId })
      : null;
    sendWithBackpressure(client, data, fallback);
  }
}

export function broadcastAll(msg) {
  broadcastMatching(msg);
}

export function broadcastOwners(msg) {
  broadcastMatching(msg, (client) => client._authSession?.role === 'owner');
}

/**
 * Push session event data directly to authorised WebSocket clients.
 */
export function broadcastSessionEvents(sessionId, events, {
  findSessionMetaCached = null,
  latestSeq = null,
} = {}) {
  if (!Array.isArray(events) || events.length === 0) return;
  // TURN clients use the same filtered display events without a direct WS.
  const legacyAppended = publishAllLiveEvents(sessionLiveFeed, sessionId, events);
  const realtimeAppended = publishAllLiveEvents(sessionRealtimeLiveFeed, sessionId, events);
  if (legacyAppended || realtimeAppended) notifySessionEvents(sessionId);
  const resolvedLatestSeq = positiveInt(latestSeq) || maxEventSeq(events);
  const meta = typeof findSessionMetaCached === 'function' ? findSessionMetaCached(sessionId) : null;
  if (!meta?.internalRole) {
    notifyOwnerInvalidation({
      type: 'session_events',
      sessionId,
      ...(resolvedLatestSeq > 0 ? { latestSeq: resolvedLatestSeq } : {}),
    });
  }
  if (!wss) return;
  const msg = {
    type: 'session_events',
    sessionId,
    events,
    ...(Number.isInteger(latestSeq) && latestSeq > 0 ? { latestSeq } : {}),
  };
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const authSession = client._authSession;
    if (!authSession) continue;
    if (authSession.role === 'owner') {
      sendWithBackpressure(client, data, JSON.stringify({ type: 'session_invalidated', sessionId }));
      continue;
    }
    // visitor / agent-scoped — reuse same visibility check as broadcastSessionInvalidation
    if (typeof authSession.sessionId === 'string' && authSession.sessionId === sessionId) {
      sendWithBackpressure(client, data, JSON.stringify({ type: 'session_invalidated', sessionId }));
    }
  }
}
