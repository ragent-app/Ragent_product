// Bounded incremental activity projection. It retains only operation identity,
// lifecycle and a classified kind; tool arguments, output and text are discarded.
import { classifyProviderOperation } from './provider-operation-classifier.mjs';

const states = new Map();
const MAX_STATES = 64;
const MAX_OPEN = 128;
const keysOf = (event) => [event.providerItemId, event.providerToolUseId, event.toolCallId, event.providerRequestId]
  .filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
const keyFor = (sessionId, runId) => `${sessionId}\0${runId}`;
function stateFor(sessionId, runId) {
  const key = keyFor(sessionId, runId);
  let state = states.get(key);
  if (!state) {
    state = { cursor: 0, open: new Map(), closed: new Set(), unknown: false, stream: false, pending: null };
    states.set(key, state);
    while (states.size > MAX_STATES) states.delete(states.keys().next().value);
  }
  return state;
}
function apply(state, event) {
  if (!['tool_use', 'tool_result'].includes(event?.type)) return;
  const keys = keysOf(event);
  if (!keys.length) { state.unknown = true; return; }
  const matching = [...state.open.entries()].filter(([, value]) => keys.some((key) => value.keys.includes(key)));
  if (matching.length > 1) { state.unknown = true; return; }
  const lifecycle = String(event.operationLifecycle || '').toLowerCase();
  const closing = event.type === 'tool_result' && lifecycle !== 'delta' ||
    ['completed', 'success', 'succeeded', 'failed', 'error', 'cancelled', 'canceled', 'interrupted', 'declined', 'denied'].includes(lifecycle);
  if (closing) {
    if (matching.length === 1) {
      const [id, operation] = matching[0];
      state.open.delete(id);
      for (const key of [...operation.keys, ...keys]) state.closed.add(key);
      while (state.closed.size > MAX_OPEN * 4) state.closed.delete(state.closed.values().next().value);
    } else if (!keys.some((key) => state.closed.has(key))) state.unknown = true;
    return;
  }
  for (const key of keys) state.closed.delete(key);
  if (event.type !== 'tool_use' && matching.length === 0) { state.unknown = true; return; }
  const existing = matching[0];
  const id = existing?.[0] || keys[0];
  if (!existing && state.open.size >= MAX_OPEN) { state.unknown = true; return; }
  const classified = classifyProviderOperation(event);
  const kind = classified.action?.semanticKind || classified.kind || null;
  state.open.set(id, { keys: [...new Set([...(existing?.[1].keys || []), ...keys])],
    kind: kind === 'command' ? 'execute' : kind === 'other' ? null : kind, seq: Number.isSafeInteger(event.seq) ? event.seq : existing?.[1].seq || 0 });
}
export function observeLiveActivity(sessionId, runId, events) {
  const state = states.get(keyFor(sessionId, runId));
  if (!state) return;
  for (const event of events || []) {
    if (event?.type === 'text_delta') state.stream = true;
    else if (event?.type === 'tool_use' || (event?.type === 'message' && event.role === 'assistant')) state.stream = false;
  }
}
export async function readIncrementalActivity(sessionId, runId, snapshot, getSessionEventsPage) {
  const state = stateFor(sessionId, runId);
  if (state.pending) return state.pending;
  state.pending = (async () => {
    const high = snapshot.historyMeta?.latestSeq || 0;
    if (state.cursor > high) { state.cursor = 0; state.open.clear(); state.closed.clear(); state.unknown = false; state.stream = false; }
    for (let i = 0; i < 4 && state.cursor < high; i++) {
      const page = await getSessionEventsPage(sessionId, { afterSeq: state.cursor, direction: 'after', limit: 200,
        strict: true, historyMeta: snapshot.historyMeta });
      const events = page.events || [];
      if (!events.length) { state.unknown = true; break; }
      const previous = state.cursor;
      for (const event of events) {
        if (event.runId === runId) apply(state, event);
        else if (!event.runId && event.type === 'tool_result' && state.open.size) state.unknown = true;
        if (Number.isSafeInteger(event.seq)) state.cursor = Math.max(state.cursor, event.seq);
      }
      if (state.cursor <= previous) { state.unknown = true; break; }
    }
    if (state.cursor < high || state.unknown) return { kind: null, sourceSeq: null };
    const latest = [...state.open.values()].sort((a, b) => b.seq - a.seq)[0];
    return { kind: latest?.kind || (state.stream ? 'responding' : null), sourceSeq: latest?.seq || state.cursor || null };
  })().finally(() => { state.pending = null; });
  return state.pending;
}
