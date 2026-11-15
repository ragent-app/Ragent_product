// Provider-neutral bounded result packet for Session delegation and
// collaboration handoff. This is intentionally a pure projection: durable
// ResultPacket stores remain the authority for project-bound work.

export const DELEGATION_RESULT_SCHEMA_VERSION = 1;
export const DELEGATION_RESULT_STATES = Object.freeze([
  'completed',
  'failed',
  'blocked',
  'waiting',
]);

const STATE_SET = new Set(DELEGATION_RESULT_STATES);
const MAX_SUMMARY_CHARS = 4000;
const MAX_ITEM_CHARS = 1200;
const MAX_ITEMS = 100;
const RESULT_START = '<ragent-result-packet>';
const RESULT_END = '</ragent-result-packet>';

function text(value, max = MAX_ITEM_CHARS) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function list(value, max = MAX_ITEMS) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry !== null && entry !== undefined)
    .map((entry) => {
      if (typeof entry === 'string') return text(entry);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
      const copy = {};
      for (const [key, item] of Object.entries(entry).slice(0, 20)) {
        if (typeof item === 'string') copy[key] = text(item);
        else if (typeof item === 'number' || typeof item === 'boolean') copy[key] = item;
      }
      return copy;
    })
    .filter((entry) => (typeof entry === 'string' ? entry : Object.keys(entry).length > 0))
    .slice(0, max);
}

function normalizeState(value, fallback = 'blocked') {
  const state = text(value).toLowerCase();
  return STATE_SET.has(state) ? state : fallback;
}

export function normalizeDelegationResult(input = {}) {
  const packet = {
    schemaVersion: DELEGATION_RESULT_SCHEMA_VERSION,
    state: normalizeState(input.state),
    summary: text(input.summary, MAX_SUMMARY_CHARS),
    changedFiles: list(input.changedFiles),
    tests: list(input.tests),
    risks: list(input.risks),
    blockers: list(input.blockers),
    acceptanceNotes: list(input.acceptanceNotes),
    unresolvedItems: list(input.unresolvedItems),
  };
  const sessionId = text(input.sessionId, 200);
  const runId = text(input.runId, 200);
  const childSessionId = text(input.childSessionId || sessionId, 200);
  if (childSessionId) packet.childSessionId = childSessionId;
  if (sessionId) packet.sessionId = sessionId;
  if (runId) packet.runId = runId;
  const completedAt = text(input.completedAt, 80);
  if (completedAt) packet.completedAt = completedAt;
  return packet;
}

function stripJsonFence(value) {
  const source = text(value, MAX_SUMMARY_CHARS * 2);
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
  return match ? match[1].trim() : source;
}

export function extractDelegationResult(textValue) {
  const source = typeof textValue === 'string' ? textValue : '';
  const start = source.indexOf(RESULT_START);
  if (start < 0) return null;
  const payloadStart = start + RESULT_START.length;
  const end = source.indexOf(RESULT_END, payloadStart);
  if (end < 0) return null;
  const raw = stripJsonFence(source.slice(payloadStart, end));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function lastAssistantText(history = [], runId = '') {
  for (const event of [...history].reverse()) {
    if (event?.type !== 'message' || event?.role !== 'assistant') continue;
    if (runId && text(event.runId, 200) && text(event.runId, 200) !== runId) continue;
    const content = text(event.content, MAX_SUMMARY_CHARS);
    if (content) return content;
  }
  return '';
}

export function buildDelegationResultFromRun({
  session = {},
  run = {},
  result = {},
  history = [],
} = {}) {
  const assistantText = lastAssistantText(history, text(run.id, 200));
  const declared = extractDelegationResult(assistantText) || {};
  const runState = text(run.state).toLowerCase();
  const fallbackState = runState === 'completed'
    ? 'completed'
    : runState === 'cancelled' || runState === 'failed'
      ? 'failed'
      : 'blocked';
  return normalizeDelegationResult({
    ...declared,
    state: declared.state || fallbackState,
    summary: declared.summary || assistantText || text(result.summary, MAX_SUMMARY_CHARS) || text(run.failureReason, MAX_SUMMARY_CHARS),
    changedFiles: declared.changedFiles || run.changedFiles || result.changedFiles,
    tests: declared.tests || run.tests || result.tests,
    risks: declared.risks || result.risks,
    blockers: declared.blockers || (run.failureReason ? [run.failureReason] : result.blockers),
    acceptanceNotes: declared.acceptanceNotes || result.acceptanceNotes,
    unresolvedItems: declared.unresolvedItems || result.unresolvedItems,
    childSessionId: session.id,
    sessionId: session.id,
    runId: run.id,
    completedAt: result.completedAt || run.completedAt || new Date().toISOString(),
  });
}

export function projectDelegationResults(events = [], childCount = 0) {
  const byIdentity = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'context_operation' || event.operation !== 'delegation_result') continue;
    const packet = event.resultPacket && typeof event.resultPacket === 'object'
      ? normalizeDelegationResult(event.resultPacket)
      : null;
    if (!packet) continue;
    const identity = `${packet.childSessionId || ''}:${packet.runId || ''}`;
    if (!identity || identity === ':') continue;
    byIdentity.set(identity, packet);
  }
  const results = [...byIdentity.values()].slice(-MAX_ITEMS);
  const counts = Object.fromEntries(DELEGATION_RESULT_STATES.map((state) => [state, 0]));
  for (const packet of results) counts[packet.state] += 1;
  const total = Math.max(Number(childCount) || 0, results.length);
  const terminal = counts.completed + counts.failed + counts.blocked;
  return {
    total,
    active: Math.max(0, total - terminal),
    completed: counts.completed,
    failed: counts.failed,
    blocked: counts.blocked,
    waiting: counts.waiting,
    results,
  };
}

export function resultPacketPrompt({ role = 'worker' } = {}) {
  const normalizedRole = text(role).toLowerCase() || 'worker';
  return [
    'Return one bounded result packet when this task reaches a meaningful stopping point.',
    'Allowed state values are: completed | failed | blocked | waiting.',
    `${RESULT_START}{"state":"completed","summary":"...","changedFiles":[],"tests":[],"risks":[],"blockers":[],"acceptanceNotes":[],"unresolvedItems":[]}${RESULT_END}`,
    `Your role is ${normalizedRole}; report only facts inside the granted scope. Do not claim a Session, Run, review, provisioning action, or aggregation exists unless Runtime evidence confirms it.`,
  ].join('\n');
}

export { RESULT_START, RESULT_END };
