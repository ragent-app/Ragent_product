/**
 * Provider-native delegation runtime orchestration.
 *
 * Provider adapters emit raw evidence into the Run spool.  This module is the
 * only layer that turns that evidence into canonical delegation events, folds
 * RunDelegation v1 records, and asks the Join Barrier whether the parent Run
 * may finalize.  It is deliberately pure so the sidecar, the observer, and
 * restart recovery all make the same decision for the same spool.
 */

import { createHash } from 'crypto';

import { createProviderNativeDelegationMapper } from './provider-native-delegation-mapper.mjs';
import {
  createJoinBarrier,
} from './provider-native-delegation-barrier.mjs';
import {
  normalizeDelegationEvent,
} from './delegation-canonical.mjs';
import {
  reduceRunDelegationRecord,
} from './run-delegation-record.mjs';

export const PROVIDER_NATIVE_DELEGATION_RUNTIME_SCHEMA_VERSION = 1;

const PROVIDERS = new Set(['claude', 'codex']);
const TERMINAL_OUTCOMES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'lost']);
const MAX_NATIVE_REPLAY_EVIDENCE_EVENTS = 8192;
const MAX_NATIVE_REPLAY_ERRORS = 128;
const MAX_NATIVE_REPLAY_DEDUP_KEYS = 8192;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function parseTimestamp(value) {
  const numeric = positiveNumber(value);
  if (numeric) return numeric;
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function resolveProvider(run = {}, explicit = '') {
  const value = text(explicit || run.provider || run.providerCapabilities?.provider || run.runtimeFamily);
  const lower = value.toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('codex')) return 'codex';
  return '';
}

function readRawFrame(record) {
  if (object(record?.json)) return record.json;
  const line = text(record?.line);
  if (!line || line.length > 2 * 1024 * 1024) return null;
  try {
    return object(JSON.parse(line));
  } catch {
    return null;
  }
}

function readCanonicalEvent(record) {
  const payload = object(record?.json);
  if (payload?.type !== 'agentoc.delegation_event') return null;
  return object(payload.event);
}

function hasExactString(value, needles, depth = 0, seen = new Set()) {
  if (depth > 8 || !value || needles.size === 0) return false;
  if (typeof value === 'string') return needles.has(value.trim());
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasExactString(item, needles, depth + 1, seen));
  return Object.values(value).some((item) => hasExactString(item, needles, depth + 1, seen));
}

function buildTerminalCandidate(input = {}) {
  const outcome = text(input.outcome);
  if (!TERMINAL_OUTCOMES.has(outcome)) return null;
  return {
    outcome,
    ...(text(input.resultRef) ? { resultRef: text(input.resultRef) } : {}),
    ...(text(input.reason) ? { reason: text(input.reason).slice(0, 400) } : {}),
  };
}

function recordToLostEvent(record, timestamp) {
  return normalizeDelegationEvent({
    provider: record.provider,
    providerDelegationId: record.providerDelegationId,
    runId: record.runId,
    parentSessionId: record.parentSessionId,
    ...(record.parentDelegationId ? { parentDelegationId: record.parentDelegationId } : {}),
    ...(record.childSessionId ? { childSessionId: record.childSessionId } : {}),
    kind: 'lost',
    state: 'lost',
    seq: Number(record.stateVersion || record.seq || 0) + 1,
    timestamp,
    facts: {
      candidate: {
        outcome: 'lost',
        reasonKind: 'provider_exit',
      },
    },
  });
}

function summarizeRecords(records) {
  const summary = {
    total: records.length,
    active: 0,
    activeDelegations: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    lost: 0,
  };
  for (const record of records) {
    if (['spawned', 'running', 'waiting'].includes(record.state)) {
      summary.active += 1;
      summary.activeDelegations += 1;
    } else if (Object.hasOwn(summary, record.state)) {
      summary[record.state] += 1;
    }
  }
  return summary;
}

function buildRecords(events) {
  const byId = new Map();
  for (const event of events) {
    const previous = byId.get(event.delegationId) || null;
    const next = reduceRunDelegationRecord(previous, event);
    if (next) byId.set(event.delegationId, next);
  }
  return [...byId.values()].sort((a, b) => a.delegationId.localeCompare(b.delegationId));
}

function normalizePriorRuntime(run) {
  const value = object(run?.providerNativeDelegation);
  return value && value.schemaVersion === PROVIDER_NATIVE_DELEGATION_RUNTIME_SCHEMA_VERSION
    ? value
    : null;
}

// Terminal recovery must inspect the complete provider spool so a delegation
// emitted early in a long Run is not hidden by the live tail reader. Keep only
// mapped delegation evidence in memory; ordinary provider progress frames are
// discarded after the mapper has seen them. This makes replay O(spool bytes)
// in I/O and O(delegation evidence) in heap instead of materializing every
// raw frame.
async function collectStreamedDelegationEvidence(streamRunSpoolRecords, run, provider) {
  const mapper = createProviderNativeDelegationMapper({
    provider,
    runId: text(run.id || run.runId),
    parentSessionId: text(run.sessionId || run.parentSessionId),
  });
  const records = [];
  const seenRawKeys = new Set();
  const rawKeyOrder = [];
  const errors = [];
  let recognized = false;
  let truncated = false;

  const addError = (value) => {
    if (errors.length >= MAX_NATIVE_REPLAY_ERRORS) return;
    const message = text(value);
    if (message) errors.push(message);
  };
  const rememberRawKey = (key) => {
    if (!key || seenRawKeys.has(key)) return false;
    seenRawKeys.add(key);
    rawKeyOrder.push(key);
    if (rawKeyOrder.length > MAX_NATIVE_REPLAY_DEDUP_KEYS) {
      const oldest = rawKeyOrder.shift();
      if (oldest) seenRawKeys.delete(oldest);
    }
    return true;
  };
  const appendEvidence = (event) => {
    if (records.length >= MAX_NATIVE_REPLAY_EVIDENCE_EVENTS) {
      truncated = true;
      return false;
    }
    records.push(canonicalDelegationSpoolRecord(event));
    return true;
  };

  for await (const record of streamRunSpoolRecords(run.id || run.runId)) {
    const canonical = readCanonicalEvent(record);
    if (canonical) {
      if (!appendEvidence(canonical)) break;
      continue;
    }
    const raw = readRawFrame(record);
    if (!raw) continue;
    const serialized = stableJson(raw);
    if (serialized && !rememberRawKey(hash(serialized))) continue;
    const mapped = mapper.map(raw);
    recognized = recognized || mapped.recognized === true;
    for (const error of mapped.errors || []) addError(error);
    for (const event of mapped.events || []) {
      if (!appendEvidence(event)) break;
    }
    if (truncated) break;
  }
  if (truncated) addError(`provider delegation replay exceeded ${MAX_NATIVE_REPLAY_EVIDENCE_EVENTS} evidence events`);
  return { records, recognized, errors };
}

/**
 * Project one complete spool.  `providerExited` must only be true when the
 * provider process has actually exited; a terminal frame alone is a
 * terminalCandidate and cannot trigger the lost transition.
 */
export function projectProviderNativeDelegation({
  run = {},
  spoolRecords = [],
  terminalCandidate: inputCandidate = null,
  providerExited = false,
  providerExitedAtMs = null,
  nowMs = null,
  provider: explicitProvider = '',
  recognized: inputRecognized = false,
  replayErrors: inputReplayErrors = [],
} = {}) {
  const runId = text(run.id || run.runId);
  const provider = resolveProvider(run, explicitProvider);
  const parentSessionId = text(run.sessionId || run.parentSessionId);
  if (!runId || !PROVIDERS.has(provider) || !parentSessionId) {
    return { handled: false, reason: 'provider_native_runtime_not_applicable' };
  }

  const mapper = createProviderNativeDelegationMapper({
    provider,
    runId,
    parentSessionId,
  });
  const events = [];
  const eventIds = new Set();
  const rawKeys = new Set();
  const childSessionIds = new Set();
  const errors = Array.isArray(inputReplayErrors)
    ? inputReplayErrors.map(text).filter(Boolean).slice(0, MAX_NATIVE_REPLAY_ERRORS)
    : [];
  let recognized = inputRecognized === true;
  const childFrameKeys = new Set();

  const addEvent = (event) => {
    if (!event || eventIds.has(event.id)) return;
    eventIds.add(event.id);
    events.push(event);
    if (event.childSessionId) childSessionIds.add(event.childSessionId);
  };

  for (const record of Array.isArray(spoolRecords) ? spoolRecords : []) {
    const canonical = readCanonicalEvent(record);
    if (canonical) {
      addEvent(canonical);
      continue;
    }
    const raw = readRawFrame(record);
    if (!raw) continue;
    const rawKey = stableJson(raw);
    if (rawKey && rawKeys.has(rawKey)) continue;
    if (rawKey) rawKeys.add(rawKey);
    const mapped = mapper.map(raw);
    recognized = recognized || mapped.recognized === true;
    if (mapped.errors.length > 0 && errors.length < MAX_NATIVE_REPLAY_ERRORS) {
      errors.push(...mapped.errors.slice(0, MAX_NATIVE_REPLAY_ERRORS - errors.length));
    }
    for (const event of mapped.events) addEvent(event);
    if (childSessionIds.size > 0 && hasExactString(raw, childSessionIds)) {
      const spawnedInFrame = mapped.events.some((event) => event.kind === 'spawned');
      if (!spawnedInFrame) childFrameKeys.add(rawKey || stableJson(raw));
    }
  }

  const prior = normalizePriorRuntime(run);
  const hadPriorRuntime = Boolean(prior && (prior.handled === true || Array.isArray(prior.delegations)));
  if (!recognized && events.length === 0 && !hadPriorRuntime) {
    return { handled: false, reason: 'no_provider_native_delegation_evidence' };
  }

  const replayRecordsBeforeRecovery = buildRecords(events);
  const priorDelegations = Array.isArray(prior?.delegations) ? prior.delegations : [];
  const priorActiveDelegations = priorDelegations.filter((record) => (
    ['spawned', 'running', 'waiting'].includes(record?.state)
  ));
  const replayDelegationIds = new Set(replayRecordsBeforeRecovery.map((record) => record.delegationId));
  const missingPriorDelegations = priorActiveDelegations.filter(
    (record) => !replayDelegationIds.has(record.delegationId),
  );
  const priorActiveCount = Math.max(
    priorActiveDelegations.length,
    Number(prior?.delegationSummary?.active) || 0,
  );
  const unknownMissingSnapshotCount = priorActiveDelegations.length === 0
    ? Math.max(0, priorActiveCount - replayRecordsBeforeRecovery.length)
    : 0;

  const candidate = buildTerminalCandidate(
    inputCandidate
      || prior?.terminalCandidate
      || (run.spoolCompletionDetectedAt ? { outcome: 'completed' } : null)
      || (run.cancelRequested === true ? { outcome: 'cancelled', reason: 'cancel_requested' } : null),
  );
  const exitTimestamp = positiveNumber(providerExitedAtMs)
    || positiveNumber(prior?.providerExitedAtMs)
    || parseTimestamp(run.completedAt)
    || parseTimestamp(run.updatedAt)
    || positiveNumber(nowMs)
    || 1;

  const barrier = createJoinBarrier({ runId });
  for (const event of events) {
    const result = barrier.applyDelegationEvent(event);
    if (!result.ok) errors.push(...(result.errors || [result.reason]));
  }

  let effectiveCandidate = candidate;
  if (!effectiveCandidate && providerExited) {
    effectiveCandidate = { outcome: 'failed', reason: 'provider_terminal_missing' };
  }
  if (effectiveCandidate) {
    const result = barrier.observeTerminalCandidate(effectiveCandidate);
    if (!result.ok) errors.push(result.reason);
  }

  let initialSnapshot = barrier.snapshot();
  if (providerExited && initialSnapshot.activeDelegations > 0) {
    for (const record of initialSnapshot.delegationSummary.delegations) {
      if (!['spawned', 'running', 'waiting'].includes(record.state)) continue;
      try {
        addEvent(recordToLostEvent(record, exitTimestamp));
      } catch (error) {
        errors.push(error?.message || String(error));
      }
    }
  }
  if (providerExited && missingPriorDelegations.length > 0) {
    for (const record of missingPriorDelegations) {
      try {
        addEvent(recordToLostEvent({
          ...record,
          provider: record.provider || provider,
          providerDelegationId: record.providerDelegationId || record.providerRefs?.providerDelegationId,
          runId: record.runId || record.parentRunId || runId,
          parentSessionId: record.parentSessionId || parentSessionId,
          childSessionId: record.childSessionId || record.providerRefs?.childSessionId,
        }, exitTimestamp));
      } catch (error) {
        errors.push(error?.message || String(error));
      }
    }
  }

  // Rebuild after synthetic lost events.  This also avoids relying on private
  // reducer state and makes the output identical after restart/replay.
  const finalBarrier = createJoinBarrier({ runId });
  for (const event of events) {
    const result = finalBarrier.applyDelegationEvent(event);
    if (!result.ok) errors.push(...(result.errors || [result.reason]));
  }
  if (effectiveCandidate) {
    const result = finalBarrier.observeTerminalCandidate(effectiveCandidate);
    if (!result.ok) errors.push(result.reason);
  }
  finalBarrier.reconcile({ complete: true });
  const finalSnapshotBeforeAggregation = finalBarrier.snapshot();

  const evidenceHash = hash(stableJson(events.map((event) => event.id)) + stableJson(effectiveCandidate));
  let aggregation = {
    generation: Number(prior?.aggregation?.generation) > 0 ? Number(prior.aggregation.generation) : 0,
    completed: false,
    evidenceHash,
  };
  if (prior?.aggregation?.completed === true && prior.aggregation.evidenceHash === evidenceHash) {
    aggregation = {
      generation: Number(prior.aggregation.generation) > 0 ? Number(prior.aggregation.generation) : 1,
      completed: true,
      evidenceHash,
    };
  } else if (
    finalSnapshotBeforeAggregation.phase === 'terminal_candidate'
    && finalSnapshotBeforeAggregation.activeDelegations === 0
    && finalSnapshotBeforeAggregation.delegationSummary.lostDelegations.length === 0
    && errors.length === 0
  ) {
    const claim = finalBarrier.claimAggregation({
      claimId: `agg_${runId}_${evidenceHash.slice(0, 20)}`,
      nowMs: positiveNumber(nowMs) || exitTimestamp,
    });
    if (!claim.ok) errors.push(claim.reason);
    else {
      const completed = finalBarrier.completeAggregation({
        claimId: claim.claim.claimId,
        generation: claim.generation,
        nowMs: (positiveNumber(nowMs) || exitTimestamp) + 1,
      });
      if (!completed.ok) errors.push(completed.reason);
      else {
        aggregation = { generation: claim.generation, completed: true, evidenceHash };
      }
    }
  }

  const finalSnapshot = finalBarrier.snapshot();
  const recordsById = new Map(priorDelegations.map((record) => [record.delegationId, clone(record)]));
  for (const record of buildRecords(events)) recordsById.set(record.delegationId, record);
  const records = [...recordsById.values()].sort((a, b) => a.delegationId.localeCompare(b.delegationId));
  const summary = summarizeRecords(records);
  const blockers = [...finalSnapshot.blockers];
  const missingSnapshotCount = unknownMissingSnapshotCount + (
    providerExited ? 0 : missingPriorDelegations.length
  );
  if (missingSnapshotCount > 0 || (providerExited && unknownMissingSnapshotCount > 0)) {
    blockers.push('delegation_snapshot_missing');
  }
  let decision = 'continue';
  let decisionReason = '';
  if (providerExited && unknownMissingSnapshotCount > 0) {
    decision = 'fail';
    decisionReason = 'delegation_lost';
  } else if (!providerExited && missingSnapshotCount > 0) {
    decision = 'await_delegations';
    decisionReason = 'delegation_snapshot_missing';
  } else if (errors.length > 0 || !finalSnapshot.delegationSummary.valid) {
    decision = 'fail';
    decisionReason = providerExited && finalSnapshot.activeDelegations > 0
      ? 'delegation_lost'
      : 'delegation_replay_invalid';
  } else if (finalSnapshot.delegationSummary.lostDelegations.length > 0) {
    decision = 'fail';
    decisionReason = 'delegation_lost';
  } else if (finalSnapshot.activeDelegations > 0) {
    decision = 'await_delegations';
    decisionReason = 'active_delegations';
  } else if (!effectiveCandidate) {
    decision = providerExited ? 'fail' : 'continue';
    decisionReason = providerExited ? 'provider_terminal_missing' : 'terminal_candidate_missing';
  } else if (!aggregation.completed) {
    decision = 'await_delegations';
    decisionReason = 'aggregation_incomplete';
  } else {
    decision = effectiveCandidate.outcome === 'completed'
      ? 'complete'
      : effectiveCandidate.outcome === 'cancelled'
        ? 'cancel'
        : 'fail';
    decisionReason = effectiveCandidate.reason || (decision === 'fail' ? 'provider_terminal_failure' : '');
  }

  const runtime = {
    schemaVersion: PROVIDER_NATIVE_DELEGATION_RUNTIME_SCHEMA_VERSION,
    handled: true,
    runId,
    parentRunId: runId,
    parentSessionId,
    provider,
    runtimeFamily: text(run.runtimeFamily),
    ownership: 'provider_native',
    recoverability: 'parent_process_bound',
    phase: decision === 'complete' || decision === 'fail' || decision === 'cancel'
      ? (decision === 'complete' ? 'completed' : decision === 'cancel' ? 'cancelled' : 'failed')
      : finalSnapshot.phase,
    terminalCandidate: effectiveCandidate,
    providerExited: providerExited === true || prior?.providerExited === true,
    ...(providerExited || prior?.providerExitedAtMs ? { providerExitedAtMs: exitTimestamp } : {}),
    aggregation,
    decision,
    decisionReason,
    delegationSummary: summary,
    delegations: records,
    canonicalEventIds: events.map((event) => event.id),
    canonicalEventCount: events.length,
    blockers,
    lastReconciledAtMs: positiveNumber(nowMs) || exitTimestamp,
  };

  return {
    handled: true,
    provider,
    canonicalEvents: events,
    runtime,
    decision,
    reason: decisionReason,
    childFrameKeys,
    activeChildSessionIds: new Set(records
      .filter((record) => ['spawned', 'running', 'waiting'].includes(record.state) && record.childSessionId)
      .map((record) => record.childSessionId)),
    rawKeys,
  };
}

export function isProviderNativeChildFrame(raw, childSessionIds = []) {
  const ids = new Set((Array.isArray(childSessionIds) ? childSessionIds : [...(childSessionIds || [])])
    .map(text)
    .filter(Boolean));
  return ids.size > 0 && hasExactString(raw, ids);
}

export function isProviderNativeDelegationEvidence(raw, provider = '') {
  const normalizedProvider = text(provider).toLowerCase();
  const serialized = stableJson(raw).toLowerCase();
  if (!serialized) return false;
  if (normalizedProvider.includes('claude')) {
    return serialized.includes('"name":"task"')
      || serialized.includes('"name":"agent"')
      || serialized.includes('"name":"subagent"')
      || serialized.includes('subagent_started')
      || serialized.includes('delegation_started');
  }
  if (normalizedProvider.includes('codex')) {
    return serialized.includes('collabagenttoolcall')
      || serialized.includes('spawn_agent')
      || serialized.includes('send_input')
      || serialized.includes('resume_agent')
      || serialized.includes('close_agent');
  }
  return false;
}

export function canonicalDelegationSpoolRecord(event) {
  return {
    stream: 'stdout',
    json: {
      type: 'agentoc.delegation_event',
      schemaVersion: PROVIDER_NATIVE_DELEGATION_RUNTIME_SCHEMA_VERSION,
      event: clone(event),
    },
  };
}

function isoFromMs(value) {
  const numeric = positiveNumber(value);
  return numeric ? new Date(numeric).toISOString() : new Date().toISOString();
}

/**
 * Durable adapter used by sidecar, observer, and startup recovery.  All
 * provider-specific work happens in `projectProviderNativeDelegation`; this
 * function only appends canonical evidence and applies the resulting bounded
 * Run projection.
 */
export async function reconcileProviderNativeDelegationRun({
  runId,
  result: inputResult = null,
  terminalCandidate = null,
  providerExited = false,
  providerExitedAtMs = null,
  nowMs = null,
  getRun,
  readRunSpoolRecords,
  streamRunSpoolRecords,
  appendRunSpoolRecord,
  updateRun,
  writeRunResult,
  protectedResultHandoff = false,
} = {}) {
  if (typeof getRun !== 'function' || typeof updateRun !== 'function'
    || (typeof readRunSpoolRecords !== 'function' && typeof streamRunSpoolRecords !== 'function')) {
    throw new TypeError('delegation reconciliation requires getRun, a spool reader, and updateRun');
  }
  const current = await getRun(runId);
  if (!current) return { handled: false, run: null, reason: 'run_not_found' };
  const provider = resolveProvider(current);
  const streamed = typeof streamRunSpoolRecords === 'function' && provider;
  const evidence = streamed
    ? await collectStreamedDelegationEvidence(streamRunSpoolRecords, current, provider)
    : null;
  const spoolRecords = evidence?.records || await readRunSpoolRecords(runId);
  const projected = projectProviderNativeDelegation({
    run: current,
    spoolRecords,
    terminalCandidate,
    providerExited,
    providerExitedAtMs,
    nowMs,
    ...(evidence ? { recognized: evidence.recognized, replayErrors: evidence.errors } : {}),
  });
  if (!projected.handled) return { ...projected, run: current };

  const terminalAt = isoFromMs(nowMs || providerExitedAtMs || current.completedAt || Date.now());
  // Record provider exit before appending derived canonical events.  If the
  // process crashes in that narrow window, startup recovery can still choose
  // the delegation-aware fail-closed path from raw spool evidence.
  if (providerExited) {
    await updateRun(runId, (latest) => ({
      ...latest,
      providerExitedAt: latest.providerExitedAt || terminalAt,
    }));
  }

  const existingCanonicalIds = new Set(
    (Array.isArray(spoolRecords) ? spoolRecords : [])
      .map(readCanonicalEvent)
      .filter(Boolean)
      .map((event) => event.id)
      .filter(Boolean),
  );
  if (typeof appendRunSpoolRecord === 'function') {
    for (const event of projected.canonicalEvents) {
      if (existingCanonicalIds.has(event.id)) continue;
      await appendRunSpoolRecord(runId, {
        ts: isoFromMs(event.timestamp),
        ...canonicalDelegationSpoolRecord(event),
      });
      existingCanonicalIds.add(event.id);
    }
  }

  const terminal = projected.decision === 'complete'
    || projected.decision === 'fail'
    || projected.decision === 'cancel';
  const candidate = projected.runtime.terminalCandidate;
  const terminalResult = terminal
    ? {
      ...(inputResult && typeof inputResult === 'object' ? inputResult : {}),
      ...(current.result && typeof current.result === 'object' ? current.result : {}),
      completedAt: inputResult?.completedAt || current.result?.completedAt || terminalAt,
      exitCode: projected.decision === 'complete' ? Number(inputResult?.exitCode ?? current.result?.exitCode ?? 0) : 1,
      signal: inputResult?.signal || current.result?.signal || null,
      ...(projected.decision === 'cancel' ? { cancelled: true } : {}),
      ...(projected.decision === 'fail'
        ? { error: projected.reason || 'delegation_lost' }
        : {}),
      ...(projected.reason === 'delegation_lost' ? { delegationLost: true } : {}),
    }
    : null;

  // In protected mode the control service must publish terminal status from
  // the authenticated root result; the task may not write that status first.
  if (terminal && protectedResultHandoff) {
    if (!providerExited) throw new Error('Protected delegation cannot finish before the provider exits');
    if (typeof writeRunResult !== 'function') throw new Error('Protected delegation result handoff unavailable');
    await writeRunResult(runId, terminalResult);
    return { ...projected, run: current, result: terminalResult };
  }

  const updated = await updateRun(runId, (latest) => {
    const next = {
      ...latest,
      providerNativeDelegation: projected.runtime,
      ...(projected.runtime.terminalCandidate ? { terminalCandidate: projected.runtime.terminalCandidate } : {}),
      ...(providerExited ? { providerExitedAt: terminalAt } : {}),
    };
    if (terminal) {
      next.state = projected.decision === 'complete'
        ? 'completed'
        : projected.decision === 'cancel'
          ? 'cancelled'
          : 'failed';
      next.completedAt = terminalResult.completedAt;
      next.result = terminalResult;
      next.failureReason = projected.decision === 'fail' ? (projected.reason || 'delegation_lost') : null;
    } else if (latest.state === 'completed' && projected.runtime.delegationSummary.active > 0) {
      // Repair a historical false-success observation without ever allowing an
      // active child to remain hidden behind a completed parent.
      next.state = 'failed';
      next.completedAt = terminalAt;
      next.result = {
        completedAt: terminalAt,
        exitCode: 1,
        signal: null,
        error: 'active_delegations_reconciled_after_false_success',
        delegationLost: providerExited,
      };
      next.failureReason = providerExited
        ? 'delegation_lost'
        : 'active_delegations_reconciled_after_false_success';
    } else {
      next.state = latest.state === 'waiting_user' ? latest.state : 'running';
    }
    return next;
  });
  if (terminal && typeof writeRunResult === 'function') {
    await writeRunResult(runId, terminalResult);
  }
  return {
    ...projected,
    run: updated || await getRun(runId),
    result: terminalResult,
  };
}
