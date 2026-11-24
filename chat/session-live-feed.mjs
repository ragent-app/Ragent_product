import { randomUUID } from 'node:crypto';
import { MESSAGE_TIMELINE_VERSION, withMessageTimelineIdentity } from './message-timeline.mjs';

const MAX_INFLIGHT_MESSAGES_PER_SESSION = 32;
const MAX_INFLIGHT_TEXT_CHARS = 512 * 1024;
const MAX_SEEN_PROVIDER_EVENT_IDS = 512;

function trimOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseSequentialDeltaOrdinal(providerEventId = '') {
  const codex = /^agent-message:(.+):(\d+)$/.exec(providerEventId);
  if (codex) return { stream: `codex:${codex[1]}`, ordinal: Number(codex[2]) };
  const claude = /^(.+):text:(\d+):(\d+)$/.exec(providerEventId);
  if (claude) return { stream: `claude:${claude[1]}:${claude[2]}`, ordinal: Number(claude[3]) };
  return null;
}

// Only consecutive provider deltas with the same complete semantic identity can
// share a delivery frame. Explicit delivery IDs remain indivisible.
function mergePendingDelta(previous, source) {
  if (!previous || source.eventId || source.type !== 'text_delta' || previous.type !== source.type
    || source.textMode === 'snapshot' || previous.textMode === 'snapshot'
    || !source.canonicalMessageId || !source.runId || typeof source.text !== 'string' || !source.text) return null;
  const ordinal = parseSequentialDeltaOrdinal(source.providerEventId || '');
  const priorOrdinal = parseSequentialDeltaOrdinal(previous.providerEventId || '');
  if (!ordinal || !priorOrdinal || ordinal.stream !== priorOrdinal.stream
    || ordinal.ordinal !== priorOrdinal.ordinal + 1) return null;
  const semantic = event => Object.fromEntries(Object.entries(event)
    .filter(([key]) => !['text', 'id', 'eventId', 'providerEventId', 'timestamp'].includes(key)
      && !(key === 'harnessEventId' && event.harnessEventSource === 'spool-record'))
    .sort(([a], [b]) => a.localeCompare(b)));
  if (JSON.stringify(semantic(previous)) !== JSON.stringify(semantic(source))) return null;
  return { ...previous, text: previous.text + source.text, providerEventId: source.providerEventId };
}

function inflightTextOf(event) {
  if (typeof event?.text === 'string') return event.text;
  if (typeof event?.content === 'string') return event.content;
  if (typeof event?.delta === 'string') return event.delta;
  return '';
}

function isTerminalRunSignal(event) {
  const type = trimOptionalString(event?.type).toLowerCase();
  if (type === 'run_terminal') return true;
  if (!['status', 'run_completed', 'run_failed', 'run_cancelled', 'session_completed'].includes(type)) return false;
  const state = trimOptionalString(event?.runState || event?.status || event?.state).toLowerCase();
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(state);
}

function isCompletedAssistantMessage(event) {
  return event?.type === 'message'
    && (!event.role || event.role === 'assistant')
    && event.textMode !== 'delta'
    && event.messageState !== 'streaming';
}

function hasUpstreamProviderIdentity(event) {
  return Boolean(
    trimOptionalString(event?.providerMessageId || event?.providerItemId || event?.streamItemId || event?.messageId),
  );
}

function updateInflightState(state, source, now) {
  if (!source || typeof source !== 'object') return false;
  if (isTerminalRunSignal(source)) {
    const runId = trimOptionalString(source.runId);
    const requestId = trimOptionalString(source.requestId);
    let removed = false;
    for (const [key, entry] of state.inflight) {
      if ((runId && entry.runId === runId) || (!runId && requestId && entry.requestId === requestId)) {
        state.inflight.delete(key);
        removed = true;
      }
    }
    if (removed) state.inflightRevision += 1;
    return removed;
  }

  const normalized = source.type === 'text_delta' || source.type === 'message' || source.type === 'message_start'
    ? withMessageTimelineIdentity(source)
    : source;
  const key = trimOptionalString(
    normalized?.canonicalMessageId
    || normalized?.timelineEntityId
    || source.entityId
    || source.messageId
    || source.providerMessageId
    || source.providerItemId
    || source.streamItemId,
  );

  if (source.type === 'message_start') {
    if (key && state.inflight.has(key) && Number.isInteger(source.seq) && source.seq > 0) {
      const entry = state.inflight.get(key);
      entry.firstSeq = entry.firstSeq > 0 ? Math.min(entry.firstSeq, source.seq) : source.seq;
      state.inflightRevision += 1;
    }
    return false;
  }

  if (isCompletedAssistantMessage(source)) {
    let removed = false;
    if (key && state.inflight.delete(key)) removed = true;
    const runId = trimOptionalString(source.runId);
    const firstSeq = Number.isInteger(source.firstSeq) && source.firstSeq > 0 ? source.firstSeq : 0;
    const blockIndex = source.providerContentBlockIndex ?? source.messageBlockIndex ?? 0;
    const providerIds = [
      trimOptionalString(source.providerMessageId),
      trimOptionalString(source.providerItemId),
      trimOptionalString(source.streamItemId),
    ].filter(Boolean);
    const sourceHasUpstream = hasUpstreamProviderIdentity(source);
    for (const [entryKey, entry] of state.inflight) {
      if (runId && entry.runId !== runId) continue;
      if (!runId && entry.runId) continue;
      const sharedProvider = providerIds.length > 0 && providerIds.some((id) =>
        id === entry.providerMessageId || id === entry.providerItemId || id === entry.streamItemId,
      );
      const sharedStartSeq = firstSeq > 0 && entry.firstSeq > 0 && entry.firstSeq === firstSeq;
      const anonymousMatch = Boolean(runId)
        && !sourceHasUpstream
        && entry.anonymous
        && entry.blockIndex === blockIndex;
      if (sharedProvider || sharedStartSeq || anonymousMatch) {
        state.inflight.delete(entryKey);
        removed = true;
      }
    }
    if (removed) state.inflightRevision += 1;
    return removed;
  }

  if (source.type !== 'text_delta' || (source.role && source.role !== 'assistant')) return false;
  if (!key) return false;
  const text = inflightTextOf(source);
  const existing = state.inflight.get(key);
  if (!text && !existing) return false;

  const isSnapshot = source.textMode === 'snapshot';
  const providerEventId = trimOptionalString(source.providerEventId);
  if (!isSnapshot && providerEventId && existing?.seenProviderEventIds.has(providerEventId)) {
    return false;
  }

  let nextText;
  if (isSnapshot) {
    if (!existing || !existing.text || text.startsWith(existing.text)) {
      nextText = text;
    } else if (existing.text.startsWith(text)) {
      nextText = existing.text;
    } else {
      nextText = text;
    }
  } else {
    nextText = existing ? `${existing.text}${text}` : text;
  }
  if (nextText.length > MAX_INFLIGHT_TEXT_CHARS) {
    nextText = nextText.slice(0, MAX_INFLIGHT_TEXT_CHARS);
  }

  const incomingFirstSeq = Number.isInteger(normalized?.firstSeq) && normalized.firstSeq > 0
    ? normalized.firstSeq
    : (Number.isInteger(source.firstSeq) && source.firstSeq > 0 ? source.firstSeq : 0);
  const firstSeq = existing?.firstSeq > 0
    ? (incomingFirstSeq > 0 ? Math.min(existing.firstSeq, incomingFirstSeq) : existing.firstSeq)
    : incomingFirstSeq;

  const seenProviderEventIds = existing?.seenProviderEventIds || new Set();
  if (!isSnapshot && providerEventId) {
    seenProviderEventIds.add(providerEventId);
    while (seenProviderEventIds.size > MAX_SEEN_PROVIDER_EVENT_IDS) {
      seenProviderEventIds.delete(seenProviderEventIds.values().next().value);
    }
  }

  const blockIndex = source.providerContentBlockIndex ?? source.messageBlockIndex ?? existing?.blockIndex ?? 0;
  const entry = {
    key,
    order: existing ? existing.order : (state.inflightOrder += 1),
    canonicalMessageId: trimOptionalString(normalized?.canonicalMessageId) || existing?.canonicalMessageId || '',
    timelineEntityId: trimOptionalString(normalized?.timelineEntityId) || existing?.timelineEntityId || '',
    firstSeq,
    runId: trimOptionalString(source.runId) || existing?.runId || '',
    requestId: trimOptionalString(source.requestId) || existing?.requestId || '',
    messagePhase: trimOptionalString(source.messagePhase) || existing?.messagePhase || '',
    providerMessageId: trimOptionalString(source.providerMessageId) || existing?.providerMessageId || '',
    providerItemId: trimOptionalString(source.providerItemId) || existing?.providerItemId || '',
    streamItemId: trimOptionalString(source.streamItemId) || existing?.streamItemId || '',
    providerContentBlockIndex: Number.isInteger(source.providerContentBlockIndex)
      ? source.providerContentBlockIndex
      : existing?.providerContentBlockIndex,
    messageBlockIndex: Number.isInteger(source.messageBlockIndex)
      ? source.messageBlockIndex
      : existing?.messageBlockIndex,
    blockIndex: Number.isInteger(blockIndex) ? blockIndex : 0,
    anonymous: existing?.anonymous ?? (
      !hasUpstreamProviderIdentity(source) && trimOptionalString(normalized?.canonicalMessageId).includes('anonymous:')
    ),
    text: nextText,
    timestamp: Number.isFinite(source.timestamp) ? source.timestamp : (existing?.timestamp || now),
    seenProviderEventIds,
  };
  state.inflight.set(key, entry);
  while (state.inflight.size > MAX_INFLIGHT_MESSAGES_PER_SESSION) {
    state.inflight.delete(state.inflight.keys().next().value);
  }
  state.inflightRevision += 1;
  return true;
}

// Ephemeral, bounded delivery only. Durable history retains its own cursor.
export function createSessionLiveFeed({ clock = Date.now, maximumSessions = 64,
  maximumEvents = 2048, maximumSessionBytes = 2 * 1024 * 1024, maximumBytes = 8 * 1024 * 1024,
  ttlMs = 5 * 60_000, compactPendingDeltas = false } = {}) {
  for (const value of [maximumSessions, maximumEvents, maximumSessionBytes, maximumBytes, ttlMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid live feed capacity');
  }
  const streamId = randomUUID(), sessions = new Map();
  let bytes = 0;
  function drop(id) { const old = sessions.get(id); if (old) bytes -= old.bytes; sessions.delete(id); }
  function prune() {
    for (const [id, state] of sessions) if (clock() - state.updatedAt >= ttlMs) drop(id);
    while (sessions.size > maximumSessions || bytes > maximumBytes) drop(sessions.keys().next().value);
  }
  function listInflightEntries(sessionId, { runId = '' } = {}) {
    prune();
    const state = sessions.get(sessionId);
    if (!state || state.inflight.size === 0) return [];
    const targetRunId = trimOptionalString(runId);
    return [...state.inflight.values()]
      .filter((entry) => entry.text && (!targetRunId || entry.runId === targetRunId))
      .sort((left, right) => {
        const leftSeq = left.firstSeq > 0 ? left.firstSeq : Number.MAX_SAFE_INTEGER;
        const rightSeq = right.firstSeq > 0 ? right.firstSeq : Number.MAX_SAFE_INTEGER;
        if (leftSeq !== rightSeq) return leftSeq - rightSeq;
        return left.order - right.order;
      });
  }
  return {
    publish(sessionId, events) {
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) || !Array.isArray(events)) return false;
      prune();
      const now = clock();
      const hadSession = sessions.has(sessionId);
      const state = sessions.get(sessionId) || {
        entries: [], bytes: 0, cursor: 0, exposedCursor: 0, updatedAt: now,
        inflight: new Map(), inflightRevision: 0, inflightOrder: 0,
      };
      let appended = false;
      let inflightChanged = false;
      for (const source of events.slice(0, 512)) {
        if (!source || typeof source !== 'object') continue;
        if (updateInflightState(state, source, now)) inflightChanged = true;
        if (Number(source.seq) > 0 || Number(source.endSeq) > 0) continue;
        const cursor = ++state.cursor;
        const tail = state.entries.at(-1);
        const merged = compactPendingDeltas && tail && tail.cursor > state.exposedCursor && tail.cursor === cursor - 1
          ? mergePendingDelta(tail.event, source) : null;
        if (merged) {
          merged.eventId = `live:${streamId}:${tail.firstCursor}-${cursor}`;
          const serialized = JSON.stringify(merged);
          const size = Buffer.byteLength(serialized);
          if (size <= Math.min(64 * 1024, maximumSessionBytes)) {
            state.bytes += size - tail.bytes; bytes += size - tail.bytes;
            tail.cursor = cursor; tail.event = JSON.parse(serialized); tail.bytes = size;
            while (state.bytes > maximumSessionBytes) {
              const removed = state.entries.shift(); state.bytes -= removed.bytes; bytes -= removed.bytes;
            }
            appended = true;
            continue;
          }
        }
        const event = { ...source,
          ...(!source.eventId && !(Number(source.seq) > 0) ? { eventId: `live:${streamId}:${cursor}` } : {}) };
        let serialized;
        try { serialized = JSON.stringify(event); } catch { serialized = ''; }
        const size = Buffer.byteLength(serialized);
        // Advance the cursor on an oversized frame as well: a reader must
        // detect the missing interval instead of silently accepting its tail.
        if (!serialized || size > Math.min(64 * 1024, maximumSessionBytes)) {
          bytes -= state.bytes; state.entries = []; state.bytes = 0; appended = true; continue;
        }
        state.entries.push({ firstCursor: cursor, cursor, event: JSON.parse(serialized), bytes: size });
        state.bytes += size; bytes += size; appended = true;
        while (state.entries.length > maximumEvents || state.bytes > maximumSessionBytes) {
          const removed = state.entries.shift(); state.bytes -= removed.bytes; bytes -= removed.bytes;
        }
      }
      if (!hadSession && !appended && state.inflight.size === 0) return false;
      state.updatedAt = now;
      if (hadSession || appended || state.inflight.size > 0 || inflightChanged) {
        sessions.delete(sessionId);
        sessions.set(sessionId, state);
      }
      prune();
      return appended;
    },
    read(sessionId, { afterCursor = 0, requestedStreamId = '' } = {}) {
      prune();
      const state = sessions.get(sessionId), latest = state?.cursor || 0;
      const first = state?.entries[0]?.firstCursor || latest + 1;
      const reset = !Number.isSafeInteger(afterCursor) || afterCursor < 0 || afterCursor > latest
        || Boolean(requestedStreamId && requestedStreamId !== streamId)
        || afterCursor < first - 1
        || Boolean(state?.entries.some(item => item.firstCursor <= afterCursor && afterCursor < item.cursor));
      const entries = reset ? [] : (state?.entries || []).filter(item => item.cursor > afterCursor).slice(0, 128);
      // Retain a 256KiB per-response budget independently of ring capacity.
      let size = 0; const page = [];
      for (const entry of entries) { if (size + entry.bytes > 256 * 1024) break; size += entry.bytes; page.push(entry); }
      // Freeze anything exposed to any reader, including a response whose
      // acknowledgement is lost. Retrying that cursor must not duplicate text.
      if (state && page.length) state.exposedCursor = Math.max(state.exposedCursor, page.at(-1).cursor);
      return { liveStreamId: streamId, liveCursor: reset ? latest : (page.at(-1)?.cursor ?? afterCursor),
        liveEvents: page.map(item => item.event), liveResetRequired: reset };
    },
    getInflightMessages(sessionId, { runId = '' } = {}) {
      return listInflightEntries(sessionId, { runId }).map((entry) => ({
        type: 'message',
        role: 'assistant',
        id: `inflight:${entry.canonicalMessageId || entry.key}`,
        ...(entry.canonicalMessageId ? { canonicalMessageId: entry.canonicalMessageId } : {}),
        ...(entry.timelineEntityId ? { timelineEntityId: entry.timelineEntityId } : {}),
        messageProtocolVersion: MESSAGE_TIMELINE_VERSION,
        textMode: 'snapshot',
        messageState: 'streaming',
        content: entry.text,
        ...(entry.firstSeq > 0 ? { seq: entry.firstSeq, firstSeq: entry.firstSeq, lastEventSeq: entry.firstSeq } : {}),
        ...(entry.runId ? { runId: entry.runId } : {}),
        ...(entry.requestId ? { requestId: entry.requestId } : {}),
        ...(entry.messagePhase ? { messagePhase: entry.messagePhase } : {}),
        ...(entry.providerMessageId ? { providerMessageId: entry.providerMessageId } : {}),
        ...(entry.providerItemId ? { providerItemId: entry.providerItemId } : {}),
        ...(entry.streamItemId ? { streamItemId: entry.streamItemId } : {}),
        ...(Number.isInteger(entry.providerContentBlockIndex)
          ? { providerContentBlockIndex: entry.providerContentBlockIndex }
          : {}),
        ...(Number.isInteger(entry.messageBlockIndex) ? { messageBlockIndex: entry.messageBlockIndex } : {}),
        timestamp: entry.timestamp,
      }));
    },
    getInflightLiveEvents(sessionId, { runId = '' } = {}) {
      const state = sessions.get(sessionId);
      const cursor = state?.cursor || 0;
      return listInflightEntries(sessionId, { runId }).map((entry, index) => ({
        type: 'text_delta',
        role: 'assistant',
        eventId: `live:${streamId}:inflight:${cursor}:${index}`,
        ...(entry.canonicalMessageId ? { canonicalMessageId: entry.canonicalMessageId } : {}),
        ...(entry.timelineEntityId ? { timelineEntityId: entry.timelineEntityId } : {}),
        messageProtocolVersion: MESSAGE_TIMELINE_VERSION,
        textMode: 'snapshot',
        messageState: 'streaming',
        text: entry.text,
        seq: 0,
        ...(entry.firstSeq > 0 ? { firstSeq: entry.firstSeq } : {}),
        ...(entry.runId ? { runId: entry.runId } : {}),
        ...(entry.requestId ? { requestId: entry.requestId } : {}),
        ...(entry.messagePhase ? { messagePhase: entry.messagePhase } : {}),
        ...(entry.providerMessageId ? { providerMessageId: entry.providerMessageId } : {}),
        ...(entry.providerItemId ? { providerItemId: entry.providerItemId } : {}),
        ...(entry.streamItemId ? { streamItemId: entry.streamItemId } : {}),
        ...(Number.isInteger(entry.providerContentBlockIndex)
          ? { providerContentBlockIndex: entry.providerContentBlockIndex }
          : {}),
        ...(Number.isInteger(entry.messageBlockIndex) ? { messageBlockIndex: entry.messageBlockIndex } : {}),
        timestamp: entry.timestamp,
      }));
    },
    readWithInflightRecovery(sessionId, { afterCursor = 0, requestedStreamId = '' } = {}) {
      const result = this.read(sessionId, { afterCursor, requestedStreamId });
      const isColdReader = !trimOptionalString(requestedStreamId) && (afterCursor === 0 || afterCursor == null);
      if (result.liveResetRequired && isColdReader) {
        const state = sessions.get(sessionId);
        const liveEvents = this.getInflightLiveEvents(sessionId);
        if (state && liveEvents.length > 0) {
          state.exposedCursor = Math.max(state.exposedCursor, state.cursor);
          return {
            liveStreamId: streamId,
            liveCursor: state.cursor,
            liveEvents,
            liveResetRequired: false,
          };
        }
      }
      return result;
    },
    getInflightRevision(sessionId) {
      prune();
      return sessions.get(sessionId)?.inflightRevision || 0;
    },
    hasEntries(sessionId) {
      prune();
      return Boolean((sessions.get(sessionId)?.cursor || 0) > 0);
    },
    clearInflight(sessionId, { runId = '', canonicalMessageId = '' } = {}) {
      const state = sessions.get(sessionId);
      if (!state || state.inflight.size === 0) return false;
      const targetRunId = trimOptionalString(runId);
      const targetMessageId = trimOptionalString(canonicalMessageId);
      let removed = false;
      for (const [key, entry] of state.inflight) {
        if (targetMessageId && entry.canonicalMessageId !== targetMessageId && key !== targetMessageId) continue;
        if (targetRunId && entry.runId !== targetRunId) continue;
        state.inflight.delete(key);
        removed = true;
      }
      if (removed) state.inflightRevision += 1;
      return removed;
    },
    stats() { prune(); return { sessions: sessions.size, bytes }; },
  };
}

export const sessionLiveFeed = createSessionLiveFeed();

// V2 is opt-in: legacy clients retain their original per-event delivery.
export const sessionRealtimeLiveFeed = createSessionLiveFeed({ compactPendingDeltas: true, maximumBytes: 4 * 1024 * 1024 });

export function publishAllLiveEvents(feed, sessionId, events) {
  if (!Array.isArray(events)) return false;
  let appended = false;
  for (let offset = 0; offset < events.length; offset += 512) {
    appended = feed.publish(sessionId, events.slice(offset, offset + 512)) || appended;
  }
  return appended;
}
