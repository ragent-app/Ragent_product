import { createHash } from 'node:crypto';
import {
  applyWorkStateUpdate,
  buildTaskStateFromLegacy,
  normalizeSourceRefs,
  normalizeWorkStateUpdate,
} from './continuity-work-state.mjs';
import {
  createInitialExecutionState,
  createExecutionStateProjectionReducer,
  mergeExecutionState,
  normalizeExecutionState,
} from './execution-state-projection.mjs';

export const CONTINUITY_SCHEMA_VERSION = 2;
export const LEGACY_CONTINUITY_SCHEMA_VERSION = 1;
export const CONTINUITY_INVARIANTS = Object.freeze({
  REVISION_MONOTONIC: 'I-CTX-001',
  COVERAGE_MONOTONIC: 'I-CTX-002',
  NO_SILENT_GAP: 'I-CTX-003',
  DETERMINISTIC_REPLAY: 'I-CTX-004',
  PROVIDER_RECEIPT_BOUNDED: 'I-CTX-005',
  CURSOR_AFTER_CHECKPOINT: 'I-CTX-006',
  REDUCE_BOUNDED: 'I-CTX-007',
});

function text(value, maxChars = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function positiveSeq(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function clone(value) {
  return structuredClone(value);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function digestEvents(events = []) {
  const hash = createHash('sha256');
  for (const event of events) hash.update(canonicalJson(event));
  return `sha256:${hash.digest('hex')}`;
}

function initialTaskState() {
  return {
    goal: null,
    status: 'idle',
    plan: null,
    decisions: [],
    completedWork: [],
    failedAttempts: [],
    blockers: [],
    unresolved: [],
    nextAction: null,
  };
}

function initialBindings() {
  return [];
}

export function createInitialContinuityState(sessionId = '') {
  return syncLegacyFields({
    schemaVersion: CONTINUITY_SCHEMA_VERSION,
    sessionId: text(sessionId, 240),
    revision: 0,
    coverage: { coveredThroughSeq: 0, eventDigest: digestEvents(), omittedRanges: [] },
    task: initialTaskState(),
    execution: createInitialExecutionState(),
    bindings: initialBindings(),
    completion: null,
    requiredUserInput: null,
  });
}

function firstSourceSeq(value) {
  return positiveSeq(value?.sourceRefs?.[0]?.seq) || positiveSeq(value?.sourceSeq);
}

function legacyObjectiveFromTask(task) {
  if (!task?.goal?.text) return null;
  return {
    raw: task.goal.text,
    text: task.goal.text,
    ...(firstSourceSeq(task.goal) ? { sourceSeq: firstSourceSeq(task.goal) } : {}),
    sourceRefs: normalizeSourceRefs(task.goal.sourceRefs),
  };
}

function legacyNextActionFromTask(task) {
  if (!task?.nextAction?.text) return null;
  return {
    text: task.nextAction.text,
    ...(firstSourceSeq(task.nextAction) ? { sourceSeq: firstSourceSeq(task.nextAction) } : {}),
    sourceRefs: normalizeSourceRefs(task.nextAction.sourceRefs),
  };
}

function syncLegacyFields(state) {
  const task = state.task || initialTaskState();
  const execution = state.execution || createInitialExecutionState();
  return {
    ...state,
    task,
    execution,
    objective: legacyObjectiveFromTask(task),
    status: task.status || 'idle',
    decisions: task.decisions || [],
    files: execution.files || [],
    validations: execution.validations || [],
    blockers: task.blockers || [],
    nextAction: legacyNextActionFromTask(task),
  };
}

function normalizeBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const bindingId = text(value.bindingId || value.id, 180);
  const runtime = text(value.runtime || value.runtimeFamily, 180);
  const providerProfile = text(value.providerProfile, 240);
  const nativeSessionId = text(value.nativeSessionId || value.resumeId, 300);
  if (!bindingId && !nativeSessionId) return null;
  return {
    ...(bindingId ? { bindingId } : {}),
    ...(runtime ? { runtime } : {}),
    ...(text(value.runtimeFamily, 180) ? { runtimeFamily: text(value.runtimeFamily, 180) } : {}),
    ...(providerProfile ? { providerProfile } : {}),
    ...(text(value.model, 240) ? { model: text(value.model, 240) } : {}),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(text(value.runtimeFingerprint, 240) ? { runtimeFingerprint: text(value.runtimeFingerprint, 240) } : {}),
    ...(text(value.instructionRevision, 240) ? { instructionRevision: text(value.instructionRevision, 240) } : {}),
    ...(positiveSeq(value.coveredThroughSeq) ? { coveredThroughSeq: value.coveredThroughSeq } : {}),
    ...(text(value.trustState, 80) ? { trustState: text(value.trustState, 80) } : {}),
    ...(text(value.lastValidatedAt, 80) ? { lastValidatedAt: text(value.lastValidatedAt, 80) } : {}),
    sourceRefs: normalizeSourceRefs(value.sourceRefs),
  };
}

function normalizeBindings(value) {
  const bindings = Array.isArray(value) ? value : [];
  const result = [];
  const seen = new Set();
  for (const raw of bindings.slice(-32)) {
    const binding = normalizeBinding(raw);
    if (!binding) continue;
    const key = binding.bindingId || binding.nativeSessionId;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(binding);
  }
  return result;
}

export function normalizeContinuityBinding(value) {
  return normalizeBinding(value);
}

function mergeBindings(left = [], right = []) {
  const result = [];
  for (const raw of [
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ]) {
    const binding = normalizeBinding(raw);
    if (!binding) continue;
    const index = result.findIndex((entry) => (
      (binding.bindingId && entry.bindingId === binding.bindingId)
      || (binding.nativeSessionId && entry.nativeSessionId === binding.nativeSessionId)
    ));
    if (index < 0) result.push(binding);
    else result[index] = { ...result[index], ...binding };
  }
  return result.slice(-32);
}

export function migrateContinuityState(sessionId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createInitialContinuityState(sessionId);
  if (value.schemaVersion === CONTINUITY_SCHEMA_VERSION) {
    const task = value.task && typeof value.task === 'object' ? value.task : buildTaskStateFromLegacy(value);
    const execution = normalizeExecutionState(value.execution || {
      files: value.files,
      validations: value.validations,
      activeRunId: value.execution?.activeRunId,
      lastRunId: value.execution?.lastRunId,
    });
    return syncLegacyFields({
      ...createInitialContinuityState(sessionId),
      ...value,
      schemaVersion: CONTINUITY_SCHEMA_VERSION,
      sessionId: text(value.sessionId || sessionId, 240),
      task: { ...initialTaskState(), ...task },
      execution,
      bindings: normalizeBindings(value.bindings),
    });
  }

  const legacy = value.schemaVersion === LEGACY_CONTINUITY_SCHEMA_VERSION || value.schemaVersion === undefined
    ? value
    : {};
  const task = buildTaskStateFromLegacy(legacy);
  const execution = normalizeExecutionState({
    ...(legacy.execution || {}),
    files: legacy.files,
    validations: legacy.validations,
  });
  const coveredThroughSeq = Number.isInteger(legacy.coverage?.coveredThroughSeq)
    ? legacy.coverage.coveredThroughSeq
    : (Number.isInteger(legacy.coveredThroughSeq)
      ? legacy.coveredThroughSeq
      : (Number.isInteger(legacy.compactedThroughSeq) ? legacy.compactedThroughSeq : 0));
  const revision = Number.isInteger(legacy.revision) ? legacy.revision : coveredThroughSeq;
  return syncLegacyFields({
    ...createInitialContinuityState(sessionId),
    ...legacy,
    schemaVersion: CONTINUITY_SCHEMA_VERSION,
    sessionId: text(legacy.sessionId || sessionId, 240),
    revision: Math.max(0, revision),
    coverage: {
      coveredThroughSeq: Math.max(0, coveredThroughSeq),
      eventDigest: text(legacy.coverage?.eventDigest, 240),
      omittedRanges: Array.isArray(legacy.coverage?.omittedRanges) ? legacy.coverage.omittedRanges : [],
    },
    task,
    execution,
    bindings: normalizeBindings(legacy.bindings),
  });
}

function upsertById(items, item, fallbackPrefix) {
  const id = text(item?.id, 180) || `${fallbackPrefix}:${items.length + 1}`;
  const next = { ...item, id };
  const index = items.findIndex((entry) => entry.id === id);
  if (index < 0) return [...items, next];
  const replaced = items.slice();
  replaced[index] = { ...replaced[index], ...next };
  return replaced;
}

function applyProviderBinding(state, event) {
  const binding = normalizeBinding({
    ...event,
    bindingId: event.bindingId || event.providerKey || event.runtimeFamily,
    nativeSessionId: event.nativeSessionId || event.resumeId,
    sourceRefs: [{ seq: event.seq, runId: event.runId, eventId: event.id }],
  });
  if (!binding) return state;
  const bindings = state.bindings.filter((entry) => (
    entry.bindingId !== binding.bindingId && entry.nativeSessionId !== binding.nativeSessionId
  ));
  return { ...state, bindings: [...bindings, binding].slice(-32) };
}

function applyEvent(state, event) {
  const runId = text(event?.runId, 180);
  // A late event from a superseded Run must not replace the current outcome.
  const currentRunId = state.execution.activeRunId || state.execution.lastRunId;
  if (['run_terminal', 'run_finished', 'run_completed'].includes(event?.type)
      && runId && currentRunId && runId !== currentRunId) return state;
  if (event?.type === 'run_terminal' && state.completion?.sourceRefs?.some((ref) => ref.runId === runId)
      && ['cancelled', 'failed'].includes(state.completion.state)) return state;
  let next = state;
  let touched = false;
  const edit = (fields) => {
    if (!touched) {
      next = { ...state };
      touched = true;
    }
    Object.assign(next, fields);
  };

  if (event?.type === 'provider_binding') {
    return applyProviderBinding(state, event);
  }

  if (event?.type === 'work_state_update') {
    const update = normalizeWorkStateUpdate(event);
    if (update) edit({ task: applyWorkStateUpdate(state.task, update, { sourceSeq: event.seq }) });
  }

  switch (event?.type) {
    case 'message': {
      const content = text(event.content);
      if (event.role === 'user' && !state.task.goal && content) {
        edit({ task: { ...state.task, goal: { text: content, sourceRefs: [{ seq: event.seq }] } } });
      }
      if (event.role === 'user' && runId) {
        edit({ execution: { ...state.execution, activeRunId: runId, lastRunId: runId } });
      }
      break;
    }
    case 'plan': {
      const update = normalizeWorkStateUpdate({
        operation: 'upsert',
        source: 'agent',
        facts: [{
          kind: 'plan',
          id: event.planId || event.artifactId || `plan:${event.seq}`,
          value: {
            planId: event.planId || event.artifactId,
            revision: event.revision,
            state: event.state || event.status,
            items: event.items,
            activeStepId: event.activeStepId,
            sourceRefs: [{ seq: event.seq, eventId: event.id, runId: event.runId }],
          },
        }],
      });
      if (update) edit({ task: applyWorkStateUpdate(state.task, update, { sourceSeq: event.seq }) });
      break;
    }
    case 'run_regenerate': {
      if (event.state !== 'accepted') break;
      const parentRunId = text(event.parentRunId, 180);
      edit({ task: {
        ...state.task,
        status: 'running',
        blockers: state.task.blockers.map((blocker) => (
          parentRunId && blocker.sourceRefs?.some((ref) => ref.runId === parentRunId)
            ? { ...blocker, status: 'superseded' } : blocker
        )),
        nextAction: null,
      }, execution: { ...state.execution, activeRunId: runId || null, lastRunId: runId || state.execution.lastRunId } });
      break;
    }
    case 'run_terminal': {
      const runState = text(event.state, 80).toLowerCase();
      const outcome = text(event.outcome, 80).toLowerCase();
      const status = ['completed', 'blocked', 'waiting', 'failed'].includes(outcome)
        ? outcome : (runState === 'completed' ? 'ready' : runState || state.task.status);
      const refs = [{ seq: event.seq, runId }];
      let blockers = state.task.blockers.map((blocker) => (
        blocker.recordedBy === 'system' && blocker.sourceRefs?.some((ref) => ref.runId === runId)
          && runState === 'completed' ? { ...blocker, status: 'resolved' } : blocker
      ));
      for (const [index, item] of (Array.isArray(event.blockers) ? event.blockers : []).slice(0, 16).entries()) {
        const message = text(item, 800);
        if (message) blockers = upsertById(blockers, { id: `terminal:${runId}:${index}`, text: message, status: 'open', sourceRefs: refs, recordedBy: 'agent' }, 'blocker');
      }
      const nextAction = text(Array.isArray(event.unresolvedItems) ? event.unresolvedItems.join('\n') : '', 2000);
      edit({ task: { ...state.task, status, blockers, nextAction: nextAction ? { text: nextAction, sourceRefs: refs } : null },
        completion: { state: runState, outcome: outcome || undefined, sourceRefs: refs },
        execution: { ...state.execution, activeRunId: null, lastRunId: runId || state.execution.lastRunId } });
      break;
    }
    case 'status': {
      if (runId && state.execution.activeRunId && runId !== state.execution.activeRunId) return state;
      const content = text(event.content);
      let status = state.task.status;
      if (/error|failed/i.test(content)) status = 'failed';
      else if (/cancel/i.test(content)) status = 'cancelled';
      else if (/complete|finished|ready/i.test(content)) status = 'ready';
      else if (/running|started|accepted/i.test(content)) status = 'running';
      const task = { ...state.task, status };
      if (/error|blocked|waiting/i.test(content)) {
        task.blockers = upsertById(task.blockers, {
          id: `blocker:${event.seq}`,
          text: content,
          status: /waiting/i.test(content) ? 'waiting' : 'open',
          sourceRefs: [{ seq: event.seq, runId, eventId: event.id }],
          recordedBy: 'system',
        }, 'blocker');
      }
      edit({ task });
      break;
    }
    case 'file_change':
    case 'tool_result':
    case 'process':
    case 'usage':
    case 'message':
      break;
    case 'user_input_required':
    case 'approval_request':
      edit({ requiredUserInput: {
        text: text(event.content || event.prompt || event.reason),
        sourceRefs: [{ seq: event.seq, runId, eventId: event.id }],
      } });
      break;
    case 'approval_response':
      edit({ requiredUserInput: null });
      break;
    case 'run_started':
      if (runId) edit({ execution: { ...state.execution, activeRunId: runId, lastRunId: runId } });
      break;
    case 'run_finished':
    case 'run_completed': {
      const runState = text(event.state || event.status, 80).toLowerCase() || 'completed';
      edit({
        execution: { ...state.execution, activeRunId: null, lastRunId: runId || state.execution.lastRunId },
        completion: { state: runState, sourceRefs: [{ seq: event.seq, runId, eventId: event.id }] },
        task: { ...state.task, status: runState === 'completed' ? 'ready' : runState },
      });
      break;
    }
    case 'execution_observation':
      if (event.execution && typeof event.execution === 'object') {
        edit({ execution: mergeExecutionState(state.execution, event.execution) });
      }
      break;
    default:
      break;
  }
  if (runId && runId !== next.execution.lastRunId
      && (!next.execution.activeRunId || next.execution.activeRunId === runId)) {
    edit({ execution: { ...next.execution, lastRunId: runId } });
  }
  return next;
}

export function createContinuityReducer(sessionId, options = {}, initialState = null) {
  let state = initialState
    ? migrateContinuityState(sessionId, { ...initialState, sessionId })
    : createInitialContinuityState(sessionId);
  let expectedSeq = (state.coverage?.coveredThroughSeq || 0) + 1;
  let latestSeq = state.coverage?.coveredThroughSeq || 0;
  const omittedRanges = Array.isArray(state.coverage?.omittedRanges)
    ? clone(state.coverage.omittedRanges)
    : [];
  const executionInput = options.executionInput && typeof options.executionInput === 'object'
    ? options.executionInput
    : {};
  const executionReducer = createExecutionStateProjectionReducer(executionInput);
  const digest = createHash('sha256');
  if (initialState) digest.update(canonicalJson({ baseDigest: state.coverage?.eventDigest || '' }));

  function push(event) {
    const seq = positiveSeq(event?.seq);
    if (!seq || seq < expectedSeq) return false;
    if (seq !== expectedSeq) omittedRanges.push({ from: expectedSeq, to: seq - 1 });
    expectedSeq = seq + 1;
    latestSeq = Math.max(latestSeq, seq);
    const currentRunId = state.execution.activeRunId || state.execution.lastRunId;
    const staleTerminal = ['run_terminal', 'run_finished', 'run_completed'].includes(event?.type)
      && event?.runId && currentRunId && event.runId !== currentRunId;
    state = applyEvent(state, event);
    if (!staleTerminal) executionReducer.push(event);
    digest.update(canonicalJson(event));
    return true;
  }

  function finish() {
    const projected = executionReducer.finish(executionInput);
    const mergedProjection = mergeExecutionState(state.execution, projected);
    // History-only replay uses the lifecycle-aware identity above. An explicit
    // Run snapshot remains authoritative when the caller supplies one.
    if (!executionInput.run && state.execution.lastRunId) {
      mergedProjection.activeRunId = state.execution.activeRunId;
      mergedProjection.lastRunId = state.execution.lastRunId;
    }
    // The event reducer can carry an execution observation that is not present
    // in the event-derived projection's optional inputs. Preserve those facts
    // instead of letting the projection's null defaults erase them.
    for (const key of ['activeRunId', 'lastRunId', 'workspace', 'git']) {
      if (projected[key] === null && state.execution[key] !== null) {
        mergedProjection[key] = state.execution[key];
      }
    }
    state = {
      ...state,
      execution: mergedProjection,
      ...(options.executionProjection ? { execution: mergeExecutionState(state.execution, options.executionProjection) } : {}),
      bindings: mergeBindings(state.bindings, options.bindings),
    };
    const eventDigest = `sha256:${digest.digest('hex')}`;
    return syncLegacyFields({
      ...state,
      schemaVersion: CONTINUITY_SCHEMA_VERSION,
      revision: latestSeq,
      coverage: { coveredThroughSeq: latestSeq, eventDigest, omittedRanges },
    });
  }

  return { push, finish };
}

function reduceContinuityEventsInternal(sessionId, events = [], options = {}, initialState = null) {
  const ordered = [...events].sort((left, right) => (left?.seq || 0) - (right?.seq || 0));
  const reducer = createContinuityReducer(sessionId, options, initialState);
  for (const event of ordered) reducer.push(event);
  return reducer.finish();
}

export function reduceContinuityEvents(sessionId, events = [], options = {}) {
  return reduceContinuityEventsInternal(sessionId, events, options, null);
}

// Incremental reducer used by shared-history indexes and fork tails. The base
// state is already a validated prefix checkpoint; only the supplied suffix is
// applied, so a child does not need to replay its logical parent history.
export function reduceContinuityEventsFromState(sessionId, baseState, events = [], options = {}) {
  if (!baseState || typeof baseState !== 'object') {
    return reduceContinuityEvents(sessionId, events, options);
  }
  return reduceContinuityEventsInternal(sessionId, events, options, baseState);
}

export function buildContinuityCheckpoint(state, { expectedRevision = null } = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('continuity state is required');
  const migrated = migrateContinuityState(state.sessionId, state);
  if (expectedRevision !== null && migrated.revision !== expectedRevision) {
    const error = new Error(`continuity revision mismatch: expected ${expectedRevision}, got ${migrated.revision}`);
    error.code = 'CONTINUITY_REVISION_MISMATCH';
    throw error;
  }
  validateContinuityState(migrated);
  return { ...clone(migrated), savedAt: new Date().toISOString() };
}

export function validateContinuityState(state) {
  if (!state || state.schemaVersion !== CONTINUITY_SCHEMA_VERSION) throw new Error('unsupported continuity schemaVersion');
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error('invalid continuity revision');
  const coverage = state.coverage || {};
  if (!Number.isInteger(coverage.coveredThroughSeq) || coverage.coveredThroughSeq < 0) throw new Error('invalid continuity coverage');
  if (coverage.coveredThroughSeq !== state.revision) throw new Error('revision and coverage diverged');
  if (!Array.isArray(coverage.omittedRanges)) throw new Error('invalid omittedRanges');
  if (!state.task || typeof state.task !== 'object' || !Array.isArray(state.task.decisions)) throw new Error('invalid continuity task state');
  if (!state.execution || typeof state.execution !== 'object' || !Array.isArray(state.execution.files)) throw new Error('invalid continuity execution state');
  if (!Array.isArray(state.bindings)) throw new Error('invalid continuity bindings');
  return true;
}

export function assertContinuityProgress(previous, next) {
  validateContinuityState(previous);
  validateContinuityState(next);
  if (next.revision < previous.revision) throw new Error(`${CONTINUITY_INVARIANTS.REVISION_MONOTONIC}: revision regressed`);
  if (next.coverage.coveredThroughSeq < previous.coverage.coveredThroughSeq) throw new Error(`${CONTINUITY_INVARIANTS.COVERAGE_MONOTONIC}: coverage regressed`);
  return true;
}
