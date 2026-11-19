/**
 * Provider-native delegation v1 — versioned canonical contract.
 *
 * When a provider runtime (Claude Code Task/subagent, Codex sub-agents, …)
 * spawns a child agent natively, the backend observes provider events but must
 * not leak them outward. This module projects those observations into a single
 * canonical, versioned, provider-agnostic event shape and enforces the
 * delegation lifecycle in isolation.
 *
 * Contract boundaries (v1):
 *   - Provider raw payload, tokens, secrets, hidden/internal context never
 *     enter a canonical event. `normalizeDelegationEvent` strips them and
 *     `validateDelegationEvent` rejects them fail-closed.
 *   - The delegation identity is namespaced by (provider, runId,
 *     providerDelegationId) so the same provider-native id across runs never
 *     collides, and a run never sees an ambiguous identity.
 *   - Lifecycle states are exactly: spawned / running / waiting /
 *     completed / failed / cancelled / interrupted / lost.
 *   - This is independent from the Durable Collaboration store. It owns no
 *     persistence and holds no provider capabilities; it is a pure contract.
 */

import { createHash } from 'crypto';

import { redactSensitiveText } from './tool-call-schema.mjs';

export const DELEGATION_SCHEMA_VERSION = 1;

/** Lifecycle states of a provider-native delegation. */
export const DELEGATION_STATES = Object.freeze([
  'spawned',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'lost',
]);

/** Canonical event kinds. Transition kinds mirror their target state. */
export const DELEGATION_EVENT_KINDS = Object.freeze([
  'spawned',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'lost',
  'snapshot',
  'recovered',
]);

const STATE_SET = new Set(DELEGATION_STATES);
const KIND_SET = new Set(DELEGATION_EVENT_KINDS);
const ROOT_BIRTH_ACTOR_PROVIDERS = new Set(['codex', 'agy']);

/** States where the delegation is still expected to make progress. */
export const DELEGATION_ACTIVE_STATES = Object.freeze(['spawned', 'running', 'waiting']);

/** States where no further progress is expected from this delegation. */
export const DELEGATION_TERMINAL_STATES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'lost',
]);

const ACTIVE_STATE_SET = new Set(DELEGATION_ACTIVE_STATES);
const TERMINAL_STATE_SET = new Set(DELEGATION_TERMINAL_STATES);

// State machine. `snapshot` events are neutral (they carry the current state
// and do not transition). `recovered` is the only recovery arc: lost -> running.
// A `lost` delegation can be re-declared lost, marked failed (recovery
// impossible), or recovered back to running.
const STATE_TRANSITIONS = Object.freeze({
  spawned: new Set(DELEGATION_STATES),
  running: new Set(['running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted', 'lost']),
  waiting: new Set(['running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted', 'lost']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
  lost: new Set(['running', 'failed', 'lost']),
});

// The canonical event kind for a transition event must equal its target state.
const KIND_TARGET_STATE = Object.freeze({
  spawned: 'spawned',
  running: 'running',
  waiting: 'waiting',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  lost: 'lost',
  snapshot: null, // neutral — carries the current state
  recovered: 'running',
});

// Keys that must never survive into a canonical event. The regex covers
// provider raw payload, credentials, hidden/internal context, plus the
// underscore-hidden convention used by provider frames.
const FORBIDDEN_FIELD = /(?:raw[_-]?payload|raw|payload|access[_-]?token|token|secret|api[_-]?key|password|passwd|authorization|cookie|credential|hidden[_-]?context|hidden|internal|private|__|^_)/i;
const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function positiveTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Deterministic canonical delegation id (`delg_…`) from the namespaced key. */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildDelegationIdentity(input = {}) {
  const provider = trimString(input.provider);
  const providerDelegationId = trimString(input.providerDelegationId);
  const runId = trimString(input.runId);
  if (!provider || !providerDelegationId || !runId) return { key: '', id: '' };
  const key = `${provider}|${runId}|${providerDelegationId}`;
  return { key, id: `delg_${sha256Hex(key).slice(0, 20)}` };
}

function isForbiddenField(key) {
  return typeof key === 'string' && FORBIDDEN_FIELD.test(key);
}

/** Redact provider-key / credential-like values inside otherwise-safe strings. */
function redactDelegationText(value) {
  return redactSensitiveText(String(value || ''))
    .replace(/\b(?:sk-ant|sk|pk)-[A-Za-z0-9_-]{12,}\b/g, (match) => `${match.slice(0, 8)}...redacted`);
}

function safeHandle(value, pattern = HANDLE_PATTERN) {
  const text = trimString(value);
  if (!text || !pattern.test(text) || redactDelegationText(text) !== text) return '';
  return text;
}

/**
 * Recursively strip forbidden fields and redact remaining string values so raw
 * provider payload, tokens, secrets, and hidden context never persist.
 */
export function redactDelegationPayload(value, depth = 0) {
  if (depth > 10) return '[truncated]';
  if (typeof value === 'string') return redactDelegationText(value);
  if (Array.isArray(value)) return value.map((item) => redactDelegationPayload(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isForbiddenField(key))
      .map(([key, item]) => [key, redactDelegationPayload(item, depth + 1)]),
  );
}

function collectForbiddenFields(value, prefix = '', depth = 0, found = []) {
  if (depth > 10 || !value || typeof value !== 'object' || Array.isArray(value)) return found;
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isForbiddenField(key)) {
      found.push(path);
      continue;
    }
    collectForbiddenFields(item, path, depth + 1, found);
  }
  return found;
}

/**
 * Normalize a bounded terminal-candidate fact. `resultRef` is a handle to the
 * durable result, never the result body itself.
 */
export function buildTerminalCandidate(input = {}) {
  const outcome = trimString(input.outcome);
  if (!STATE_SET.has(outcome) || !TERMINAL_STATE_SET.has(outcome)) return null;
  const resultRef = safeHandle(input.resultRef);
  const reasonKind = safeHandle(input.reasonKind, LABEL_PATTERN);
  const reason = trimString(input.reason);
  return {
    outcome,
    ...(resultRef ? { resultRef } : {}),
    ...(reasonKind ? { reasonKind } : {}),
    ...(reason ? { reason: redactDelegationText(reason).slice(0, 400) } : {}),
  };
}

/** Normalize a bounded snapshot fact (current state plus a position handle). */
export function buildDelegationSnapshot(input = {}) {
  const state = trimString(input.state);
  if (!STATE_SET.has(state)) return null;
  const resultRef = safeHandle(input.resultRef);
  const position = Number.isInteger(input.position) && input.position >= 0 ? input.position : null;
  return {
    state,
    ...(resultRef ? { resultRef } : {}),
    ...(position !== null ? { position } : {}),
  };
}

/** Normalize bounded recovery facts for a lost delegation. */
export function buildRecoveryFacts(input = {}) {
  const mode = trimString(input.mode);
  if (!['resume', 'restart', 'none'].includes(mode)) return null;
  const resumeRef = safeHandle(input.resumeRef);
  const reason = trimString(input.reason);
  return {
    mode,
    ...(resumeRef ? { resumeRef } : {}),
    ...(reason ? { reason: redactDelegationText(reason).slice(0, 400) } : {}),
  };
}

function normalizeFacts(input) {
  if (!input || typeof input !== 'object') return undefined;
  const candidate = buildTerminalCandidate(input.candidate);
  const snapshot = buildDelegationSnapshot(input.snapshot);
  const recovery = buildRecoveryFacts(input.recovery);
  const birthActor = input.birthActor === 'root_session' ? 'root_session' : null;
  if (!candidate && !snapshot && !recovery && !birthActor) return undefined;
  return {
    ...(candidate ? { candidate } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(recovery ? { recovery } : {}),
    ...(birthActor ? { birthActor } : {}),
  };
}

/**
 * Validate a delegation event. Returns `{ ok, errors }`. Fails closed when a
 * forbidden field (raw payload / token / secret / hidden context) is present,
 * because such fields must never enter the canonical event stream.
 */
export function validateDelegationEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['delegation event must be an object'] };
  }
  const errors = [];

  if (input.schemaVersion !== DELEGATION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${DELEGATION_SCHEMA_VERSION}`);
  }

  const kind = trimString(input.kind);
  if (!KIND_SET.has(kind)) {
    errors.push(`kind must be one of: ${DELEGATION_EVENT_KINDS.join(', ')}`);
  }

  const state = trimString(input.state);
  if (!STATE_SET.has(state)) {
    errors.push(`state must be one of: ${DELEGATION_STATES.join(', ')}`);
  } else if (kind) {
    const target = KIND_TARGET_STATE[kind];
    if (target !== null && state !== target) {
      errors.push(`kind '${kind}' requires state '${target}'`);
    }
    if (kind === 'recovered' && state !== 'running') {
      errors.push(`kind 'recovered' requires state 'running'`);
    }
  }

  const identity = buildDelegationIdentity(input);
  const delegationId = trimString(input.delegationId);
  if (!delegationId) {
    errors.push('delegationId is required');
  } else if (identity.id && delegationId !== identity.id) {
    errors.push(`delegationId '${delegationId}' is inconsistent with provider/runId/providerDelegationId`);
  }
  if (!trimString(input.provider)) errors.push('provider is required');
  if (!trimString(input.providerDelegationId)) errors.push('providerDelegationId is required');
  if (!trimString(input.runId)) errors.push('runId is required');
  if (!trimString(input.parentSessionId)) errors.push('parentSessionId is required');
  if (input.parentDelegationId !== undefined && input.parentDelegationId !== null) {
    const parentDelegationId = trimString(input.parentDelegationId);
    if (!/^delg_[a-f0-9]{20}$/.test(parentDelegationId)) {
      errors.push('parentDelegationId must be a canonical delegation id when present');
    }
  }
  if (input.childSessionId !== undefined && input.childSessionId !== null && !trimString(input.childSessionId)) {
    errors.push('childSessionId must be a non-empty string when present');
  }

  if (!positiveInt(input.seq)) errors.push('seq must be a positive integer');
  if (!positiveTimestamp(input.timestamp)) errors.push('timestamp must be a positive number (epoch ms)');
  if (input.id !== undefined && input.id !== null && !trimString(input.id)) {
    errors.push('id must be a non-empty string when present');
  }

  if (input.facts !== undefined && !normalizeFacts(input.facts)) {
    errors.push('facts must contain at least one valid bounded fact');
  }
  if (input.facts?.birthActor && (input.facts.birthActor !== 'root_session' || kind !== 'spawned' || !ROOT_BIRTH_ACTOR_PROVIDERS.has(input.provider) || input.parentDelegationId)) {
    errors.push('root birth actor requires a top-level Codex or AgY spawned event');
  }

  const forbidden = collectForbiddenFields(input);
  if (forbidden.length > 0) {
    errors.push(`forbidden fields must not enter canonical events: ${forbidden.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}

export class DelegationContractError extends Error {
  constructor(errors) {
    super(`delegation contract violation: ${errors.join('; ')}`);
    this.name = 'DelegationContractError';
    this.code = 'DELEGATION_CONTRACT';
    this.errors = errors;
  }
}

function buildCanonicalEvent(input) {
  const identity = buildDelegationIdentity(input);
  const eventId = safeHandle(input.id) || `delgevt_${sha256Hex(`${identity.key}|${input.kind}|${input.state}|${input.seq}|${input.timestamp}`).slice(0, 16)}`;
  return {
    schemaVersion: DELEGATION_SCHEMA_VERSION,
    id: eventId,
    kind: trimString(input.kind),
    delegationId: trimString(input.delegationId) || identity.id,
    provider: trimString(input.provider),
    providerDelegationId: trimString(input.providerDelegationId),
    runId: trimString(input.runId),
    parentSessionId: trimString(input.parentSessionId),
    ...(trimString(input.parentDelegationId) ? { parentDelegationId: trimString(input.parentDelegationId) } : {}),
    ...(trimString(input.childSessionId) ? { childSessionId: trimString(input.childSessionId) } : {}),
    state: trimString(input.state),
    seq: input.seq,
    timestamp: input.timestamp,
    ...(normalizeFacts(input.facts) ? { facts: normalizeFacts(input.facts) } : {}),
  };
}

/**
 * Build a canonical delegation event. Forbidden fields are stripped and
 * remaining string values redacted; the result is validated and frozen.
 * Throws `DelegationContractError` on violation.
 */
export function normalizeDelegationEvent(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DelegationContractError(['delegation event must be an object']);
  }
  const sanitized = redactDelegationPayload(input);
  const seq = positiveInt(sanitized.seq)
    ? sanitized.seq
    : (positiveInt(options.seq) ? options.seq : 1);
  // Provider frames may omit wall-clock time. Use a deterministic fallback so
  // replaying the same raw evidence yields byte-identical canonical events.
  const timestamp = positiveTimestamp(sanitized.timestamp)
    ? sanitized.timestamp
    : (positiveTimestamp(options.timestamp) ? options.timestamp : seq);
  const event = buildCanonicalEvent({ ...sanitized, seq, timestamp });
  const result = validateDelegationEvent(event);
  if (!result.ok) throw new DelegationContractError(result.errors);
  return Object.freeze(event);
}

export function isDelegationTerminal(state) {
  return TERMINAL_STATE_SET.has(trimString(state));
}

export function isDelegationActive(state) {
  return ACTIVE_STATE_SET.has(trimString(state));
}

export function isDelegationStateTransitionValid(from, to) {
  const fromState = trimString(from);
  const toState = trimString(to);
  if (!STATE_SET.has(fromState) || !STATE_SET.has(toState)) return false;
  return STATE_TRANSITIONS[fromState].has(toState);
}

function eventTargetState(event) {
  if (event.kind === 'recovered') return 'running';
  if (event.kind === 'snapshot') return event.state;
  return event.state;
}

/**
 * In-memory projector that replays canonical delegation events and enforces the
 * history-dependent invariants the validator cannot see alone:
 *   - first event must be `spawned` (duplicate identity is rejected)
 *   - illegal state transitions are rejected
 *   - cross-run / cross-parent identity is rejected
 *   - a child session cannot be shared by two active delegations in different
 *     runs
 *   - per-delegation `seq` must be strictly increasing
 * It also answers active-child queries.
 */
export function createDelegationProjector() {
  const delegations = new Map(); // delegationId -> { state, runId, parentSessionId, parentDelegationId, childSessionId, seq, facts }
  const childBindings = new Map(); // childSessionId -> { runId, delegationId }
  const projectionErrors = [];

  function reject(errors) {
    projectionErrors.push(...errors);
    return { ok: false, errors };
  }

  function record(id) {
    let entry = delegations.get(id);
    if (!entry) {
      entry = { state: '', runId: '', parentSessionId: '', parentDelegationId: '', childSessionId: '', seq: 0, facts: null };
      delegations.set(id, entry);
    }
    return entry;
  }

  function apply(event) {
    const validation = validateDelegationEvent(event);
    if (!validation.ok) return reject(validation.errors);

    const delegationId = event.delegationId;
    const existing = delegations.get(delegationId);
    const errors = [];

    if (!existing) {
      if (event.kind !== 'spawned') {
        errors.push(`first event for delegation '${delegationId}' must be 'spawned'`);
        return reject(errors);
      }
    } else {
      if (event.kind === 'spawned') {
        errors.push(`duplicate identity: delegation '${delegationId}' already exists`);
      }
      if (event.runId !== existing.runId) {
        errors.push(`cross-run parent: delegation '${delegationId}' bound to run '${existing.runId}' cannot move to run '${event.runId}'`);
      }
      if (event.parentSessionId !== existing.parentSessionId) {
        errors.push(`cross-parent: delegation '${delegationId}' parent cannot change from '${existing.parentSessionId}' to '${event.parentSessionId}'`);
      }
      if (event.parentDelegationId && event.parentDelegationId !== existing.parentDelegationId) {
        errors.push(`parent delegation for '${delegationId}' cannot change`);
      }
      if (event.childSessionId && existing.childSessionId && event.childSessionId !== existing.childSessionId) {
        errors.push(`child session for delegation '${delegationId}' cannot change from '${existing.childSessionId}' to '${event.childSessionId}'`);
      }
      if (event.seq <= existing.seq) {
        errors.push(`seq must be strictly increasing for delegation '${delegationId}' (got ${event.seq}, last ${existing.seq})`);
      }
      if (errors.length === 0) {
        if (event.kind === 'snapshot') {
          if (event.state !== existing.state) {
            errors.push(`snapshot state '${event.state}' must match current state '${existing.state}'`);
          }
        } else if (event.kind === 'recovered') {
          if (existing.state !== 'lost') {
            errors.push(`kind 'recovered' requires current state 'lost' (was '${existing.state}')`);
          } else if (event.state !== 'running') {
            errors.push(`kind 'recovered' requires state 'running'`);
          }
        } else if (existing.state === 'lost' && !['lost', 'failed'].includes(event.kind)) {
          // Only the dedicated recovery arc (kind 'recovered'), a re-declared
          // loss, or a declared failure may leave the lost state.
          errors.push(`delegation '${delegationId}' is lost; only 'recovered', 'failed', 'lost', or 'snapshot' events are valid`);
        } else if (!isDelegationStateTransitionValid(existing.state, eventTargetState(event))) {
          errors.push(`illegal state transition '${existing.state}' -> '${event.state}' for delegation '${delegationId}'`);
        }
      }
    }

    if (event.childSessionId) {
      const binding = childBindings.get(event.childSessionId);
      if (binding && binding.delegationId !== event.delegationId && isDelegationActive(delegations.get(binding.delegationId)?.state || '')) {
        errors.push(`child session '${event.childSessionId}' is busy in run '${binding.runId}' (delegation '${binding.delegationId}')`);
      }
    }

    if (event.parentDelegationId) {
      if (event.parentDelegationId === event.delegationId) {
        errors.push(`delegation '${delegationId}' cannot parent itself`);
      } else {
        const parent = delegations.get(event.parentDelegationId);
        if (!parent) errors.push(`parent delegation '${event.parentDelegationId}' is unknown`);
        else if (!isDelegationActive(parent.state)) {
          errors.push(`parent delegation '${event.parentDelegationId}' is not active`);
        } else if (parent.runId !== event.runId) {
          errors.push(`parent delegation '${event.parentDelegationId}' belongs to another run`);
        }
      }
    }

    if (errors.length > 0) return reject(errors);

    const entry = record(delegationId);
    entry.state = eventTargetState(event);
    entry.runId = event.runId;
    entry.parentSessionId = event.parentSessionId;
    if (event.parentDelegationId) entry.parentDelegationId = event.parentDelegationId;
    if (event.childSessionId) entry.childSessionId = event.childSessionId;
    entry.seq = event.seq;
    if (event.facts) entry.facts = event.facts;
    if (event.childSessionId) {
      childBindings.set(event.childSessionId, { runId: event.runId, delegationId });
      if (isDelegationTerminal(entry.state)) childBindings.delete(event.childSessionId);
    }
    return { ok: true, state: entry.state, delegationId };
  }

  return {
    apply,
    getState(delegationId) {
      return delegations.get(delegationId)?.state || null;
    },
    getFacts(delegationId) {
      return delegations.get(delegationId)?.facts || null;
    },
    getErrors() {
      return [...projectionErrors];
    },
    isValid() {
      return projectionErrors.length === 0;
    },
    isTerminal(delegationId) {
      return isDelegationTerminal(delegations.get(delegationId)?.state || '');
    },
    isChildSessionActive(childSessionId) {
      const binding = childBindings.get(childSessionId);
      return Boolean(binding && isDelegationActive(delegations.get(binding.delegationId)?.state || ''));
    },
    activeChildSessionIds() {
      const active = new Set();
      for (const [childSessionId, binding] of childBindings) {
        if (isDelegationActive(delegations.get(binding.delegationId)?.state || '')) active.add(childSessionId);
      }
      return active;
    },
  };
}

/**
 * Replay a list of canonical events and return the active-child projection.
 * Invalid sequences are dropped from the projection (the caller already
 * validated or normalized them); the returned object exposes the same
 * active-child queries as `createDelegationProjector`.
 */
export function computeActiveChildDelegations(events = []) {
  const projector = createDelegationProjector();
  for (const event of events) {
    if (event && typeof event === 'object') projector.apply(event);
  }
  return {
    ok: projector.isValid(),
    errors: projector.getErrors(),
    activeChildSessionIds: projector.activeChildSessionIds(),
    isChildSessionActive: (childSessionId) => projector.isChildSessionActive(childSessionId),
  };
}
