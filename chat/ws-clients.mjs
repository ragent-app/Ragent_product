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
