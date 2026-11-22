import { createHash } from 'node:crypto';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readEventBody(event, fields = []) {
  for (const field of fields) {
    if (typeof event?.[field] === 'string') return event[field];
  }
  return '';
}

function readNumericField(event, fields = []) {
  for (const field of fields) {
    const value = Number(event?.[field]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function readStatusIdentity(event) {
  const text = readEventBody(event, ['content', 'status', 'message', 'bodyPreview'])
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return [
    trimString(event?.runtimeFamily),
    trimString(event?.providerLifecycle),
    trimString(event?.runState),
    text,
  ];
}

function readUsageIdentity(event) {
  return [
    trimString(event?.runtimeFamily),
    readNumericField(event, ['contextTokens', 'inputTokens']),
    readNumericField(event, ['outputTokens']),
    readNumericField(event, ['cachedInputTokens']),
    readNumericField(event, ['reasoningTokens']),
    readNumericField(event, ['contextWindowTokens']),
  ];
}

function isSpoolDerivedHarnessIdentity(event) {
  return trimString(event?.harnessEventSource) === 'spool-record';
}

function providerEventIdentity(event) {
  const type = trimString(event?.type);
  const providerEventIndex = Number.isInteger(event?.providerEventIndex)
    ? event.providerEventIndex
    : null;
  if (type === 'message' || type === 'reasoning') {
    return [providerEventIndex, trimString(event?.role), readEventBody(event, ['content', 'bodyPreview'])];
  }
  if (type === 'text_delta') {
    return [providerEventIndex, Number.isInteger(event?.blockIndex) ? event.blockIndex : null, readEventBody(event, ['text'])];
  }
  if (type === 'tool_use') {
    return [providerEventIndex, trimString(event?.providerToolUseId), trimString(event?.toolName), readEventBody(event, ['toolInput', 'bodyPreview'])];
  }
  if (type === 'tool_result') {
    return [providerEventIndex, trimString(event?.providerToolUseId), Number.isFinite(event?.exitCode) ? event.exitCode : null, readEventBody(event, ['output', 'bodyPreview'])];
  }
  return [providerEventIndex, readEventBody(event, ['content', 'status', 'message', 'bodyPreview'])];
}

export function createClaudeFinalizedAssistantReplayFingerprint(providerSessionId, content) {
  const sessionId = trimString(providerSessionId);
  // Hash the exact body rather than persisting it a second time beside the
  // message event. Trimming a final snapshot would turn two distinct responses
  // into the same fallback identity.
  const body = typeof content === 'string' ? content : '';
  if (!sessionId || !body) return '';
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(['claude-finalized-assistant-v1', sessionId, body]))
    .digest('hex')}`;
}

function claudeFinalizedAssistantReplayKey(event, runId) {
  const provider = trimString(event?.provider).toLowerCase();
  const runtimeFamily = trimString(event?.runtimeFamily).toLowerCase();
  if (
    event?.type !== 'message'
    || event?.role !== 'assistant'
    || event?.providerSnapshotKind !== 'finalized-assistant'
    || (provider !== 'claude' && runtimeFamily !== 'claude-stream-json')
  ) return '';
  const providerSessionId = trimString(event?.providerSessionId);
  const fingerprint = trimString(event?.providerReplayFingerprint);
  if (!providerSessionId || !fingerprint) return '';
  return JSON.stringify([runId, 'claude-finalized-assistant', providerSessionId, fingerprint]);
}

export function getProviderEventDedupKey(event) {
  const runId = trimString(event?.runId);
  if (!runId) return '';
  const harnessEventId = trimString(event?.harnessEventId || event?.eventId);
  // An explicit harness id remains the strongest identity for external
  // adapters. The projection-generated spool id is intentionally deferred
  // until after provider identities so a provider's accumulating snapshot can
  // still collapse across two different spool records.
  if (harnessEventId && !isSpoolDerivedHarnessIdentity(event)) {
    // Some harnesses reuse a toolCallId for both start and completion. Keep
    // the normalized event type in the key so a result cannot be mistaken for
    // the preceding tool_use event.
    return JSON.stringify([runId, 'harness', trimString(event?.type), harnessEventId]);
  }
  const providerMessageId = trimString(event?.providerMessageId);
  const providerToolUseId = trimString(event?.providerToolUseId);
  const providerEventId = trimString(event?.providerEventId);

  // Message/reasoning identity is provider-scoped; the body is a REVISION
  // discriminator, not part of the identity. Accumulating stream-json
  // snapshots re-emit one provider message with a growing body: identical
  // re-emissions (same id + same body) collapse here, while a longer
  // revision is intentionally kept as its own durable row — the display
  // projection owns merging revisions into one visible message. Storage is
  // append-only, so an identity-only key would silently DROP the longer
  // revision instead.
  const contentBlockIndex = Number.isInteger(event?.providerContentBlockIndex)
    ? event.providerContentBlockIndex
    : null;
  if (event?.type === 'message' && providerMessageId) {
    const hasAsyncMetadata = Boolean(
      trimString(event?.messageDelivery || event?.delivery)
      || (Array.isArray(event?.asyncQuestions) && event.asyncQuestions.length > 0),
    );
    const asyncSummary = hasAsyncMetadata
      ? JSON.stringify([
        trimString(event?.messageDelivery || event?.delivery),
        Array.isArray(event?.asyncQuestions)
          ? event.asyncQuestions.map((q) => [
            trimString(q?.id),
            trimString(q?.title || q?.question),
            Array.isArray(q?.options) ? q.options : null,
          ])
          : [],
      ])
      : '';
    return JSON.stringify([
      runId,
      'message',
      trimString(event.role),
      providerMessageId,
      contentBlockIndex,
      readEventBody(event, ['content', 'bodyPreview']),
      ...(asyncSummary ? [asyncSummary] : []),
    ]);
  }
  if (event?.type === 'reasoning' && providerMessageId) {
    return JSON.stringify([
      runId,
      'reasoning',
      providerMessageId,
      trimString(event.providerBlockId) || contentBlockIndex,
      readEventBody(event, ['content', 'bodyPreview']),
    ]);
  }
  if (event?.type === 'tool_use' && providerToolUseId) {
    return JSON.stringify([
      runId,
      'tool_use',
      providerToolUseId,
      trimString(event.toolName),
      readEventBody(event, ['toolInput', 'bodyPreview']),
    ]);
  }
  if (event?.type === 'tool_result' && providerToolUseId) {
    return JSON.stringify([
      runId,
      'tool_result',
      providerToolUseId,
      Number.isFinite(event.exitCode) ? event.exitCode : null,
      readEventBody(event, ['output', 'bodyPreview']),
    ]);
  }
  if (event?.type === 'file_change' && providerToolUseId) {
    return JSON.stringify([
      runId,
      'file_change',
      providerToolUseId,
      trimString(event.filePath),
      trimString(event.changeType),
      Number.isFinite(event.added) ? event.added : null,
      Number.isFinite(event.removed) ? event.removed : null,
    ]);
  }
  if (providerEventId) {
    return JSON.stringify([
      runId,
      'provider_event',
      trimString(event?.type),
      providerEventId,
      ...providerEventIdentity(event),
    ]);
  }
  const claudeSnapshotKey = claudeFinalizedAssistantReplayKey(event, runId);
  if (claudeSnapshotKey) return claudeSnapshotKey;
  if (harnessEventId) {
    return JSON.stringify([runId, 'harness', trimString(event?.type), harnessEventId]);
  }
  return '';
}

// Broader replay identity used by the native observer. The primary key covers
// explicit provider/harness identities plus the projection-generated exact
// spool-record identity; progress-only frames get a separate semantic key.
export function getProviderEventReplayKey(event) {
  const providerKey = getProviderEventDedupKey(event);
  if (providerKey) return providerKey;
  const runId = trimString(event?.runId);
  if (!runId) return '';
  if (event?.type === 'status') {
    return JSON.stringify([runId, 'status', ...readStatusIdentity(event)]);
  }
  if (event?.type === 'usage') {
    return JSON.stringify([runId, 'usage', ...readUsageIdentity(event)]);
  }
  return '';
}

export function filterDuplicateProviderEvents(existingEvents = [], candidateEvents = []) {
  const seen = new Set();
  for (const event of Array.isArray(existingEvents) ? existingEvents : []) {
    const key = getProviderEventDedupKey(event);
    if (key) seen.add(key);
  }
  const filtered = [];
  for (const event of Array.isArray(candidateEvents) ? candidateEvents : []) {
    const key = getProviderEventDedupKey(event);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    filtered.push(event);
  }
  return filtered;
}

/**
 * Perf gate for the observer's per-tick dedup load.
 *
 * The observer normally re-reads the entire persisted history (with bodies)
 * on every delta tick to filter provider-id duplicates. Streaming runtimes
 * re-emit the same provider-identified events across many spool lines, so
 * once a session's known keys are cached, a tick whose candidates all carry
 * known keys cannot introduce any new durable event — the load can be
 * skipped entirely. Events without a replay key always pass through the
 * filter, so the shortcut is only valid when EVERY candidate carries a key.
 */
export function shouldSkipDedupLoad({ knownKeys = null, candidates = [] } = {}) {
  if (!knownKeys) return false;
  for (const event of Array.isArray(candidates) ? candidates : []) {
    const key = getProviderEventDedupKey(event);
    if (!key || !knownKeys.has(key)) return false;
  }
  return true;
}

export function buildKnownDedupKeySet(events = []) {
  const set = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const key = getProviderEventDedupKey(event);
    if (key) set.add(key);
  }
  return set;
}

/**
 * Active-run variant of the dedup filter. The per-session known-key set is
 * authoritative once seeded (built from a full history load and extended only
 * with events persisted through the observer path — the sole writer of
 * provider/harness-identified events). With a seeded set, a candidate whose key is
 * unknown was never persisted → it is new and can be appended WITHOUT
 * re-loading the whole history; a candidate whose key is known is a
 * re-emission → dropped. Events without a key always pass through.
 * Without a set (null), every candidate passes through — callers must fall
 * back to filterDuplicateProviderEvents against a fresh history load.
 */
export function filterUnknownProviderEvents(candidates = [], knownKeys = null) {
  if (!knownKeys) return [...(Array.isArray(candidates) ? candidates : [])];
  const seen = new Set(knownKeys);
  const filtered = [];
  for (const event of Array.isArray(candidates) ? candidates : []) {
    const key = getProviderEventDedupKey(event);
    if (!key || !seen.has(key)) {
      filtered.push(event);
      if (key) seen.add(key);
    }
  }
  return filtered;
}

export function filterUnknownHarnessEvents(candidates = [], knownKeys = null) {
  if (!knownKeys) return [...(Array.isArray(candidates) ? candidates : [])];
  const seen = new Set(knownKeys);
  const filtered = [];
  for (const event of Array.isArray(candidates) ? candidates : []) {
    const key = getProviderEventReplayKey(event);
    if (!key || !seen.has(key)) {
      filtered.push(event);
      if (key) seen.add(key);
    }
  }
  return filtered;
}
