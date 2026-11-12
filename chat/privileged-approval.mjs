import { CATEGORY_DELETE, CATEGORY_INSTALL, CATEGORY_OTHER } from './privileged-classifier.mjs';
import {
  PRIVILEGED_EVENT_SOURCE,
  computeBatchManifestHash,
  defaultSelectedOpIds,
  privilegedBatchRequestEvent,
  privilegedBatchResponseEvent,
} from './privileged-ops.mjs';

// Approval state machine for the AgentoC sudo-approval gate (design:
// notes/current/privileged-approval-design.md). Sits on top of the pure batch
// model in privileged-ops.mjs and emits the privileged_batch_request /
// privileged_batch_response events defined in §6.
//
// Persistence is injected via `store` = { readEvents(), appendEvent(event),
// invalidate?() } so this module stays decoupled from session-manager internals
// (broadcastSessionInvalidation is not exported) and is unit-testable with a
// fake store. The live glue (passing the real appendEvent/readEvents/invalidate)
// is part of the runner-integration slice; nothing here is wired into a live
// route yet, so no privileged events are created in real sessions today.
//
// Idempotent: re-opening a batch or re-resolving a category is a no-op.

export const PRIVILEGED_APPROVAL_CATEGORIES = Object.freeze([CATEGORY_OTHER, CATEGORY_DELETE]); // popup order other -> delete

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPrivilegedBatchRequest(event, batchId) {
  return event?.type === 'privileged_batch_request'
    && trimString(event?.batchId) === batchId;
}

function isPrivilegedBatchResponse(event, batchId, category) {
  return event?.type === 'privileged_batch_response'
    && trimString(event?.batchId) === batchId
    && trimString(event?.category) === category;
}

function resolveCategoryOpsFromDecisionEvent(categoryOps = [], responseEvent = {}) {
  const decisions = responseEvent?.decisions && typeof responseEvent.decisions === 'object'
    ? responseEvent.decisions
    : {};
  const approved = [];
  const denied = [];
  for (const op of Array.isArray(categoryOps) ? categoryOps : []) {
    if (decisions[op.opId] === 'approved') approved.push(op);
    else if (decisions[op.opId] === 'denied') denied.push(op);
  }
  return {
    categoryOps: Array.isArray(categoryOps) ? categoryOps.slice() : [],
    approved,
    denied,
    decisions,
    manifestHash: trimString(responseEvent?.signedManifestHash),
  };
}

// Open approval for a whole batch. Appends a single privileged_batch_request
// event carrying both categories' op summaries + per-category default selection
// (other = all selected / delete = none selected). The two popups (§5.5) are a
// UI projection of this one event's other/delete arrays.
export async function openPrivilegedBatchApproval(batch, store, options = {}) {
  if (!batch?.batchId) {
    const error = new Error('batch with batchId is required');
    error.code = 'BATCH_REQUIRED';
    throw error;
  }
  if (!store || typeof store.readEvents !== 'function' || typeof store.appendEvent !== 'function') {
    const error = new Error('store with readEvents/appendEvent is required');
    error.code = 'STORE_REQUIRED';
    throw error;
  }

  const events = await store.readEvents();
  const existing = events.find((event) => isPrivilegedBatchRequest(event, batch.batchId));
  if (existing) {
    return { duplicate: true, requestEvent: existing };
  }

  const requestEvent = privilegedBatchRequestEvent(batch);
  if (!requestEvent) {
    const error = new Error('failed to build privileged batch request event');
    error.code = 'BATCH_INVALID';
    throw error;
  }
  requestEvent.defaultSelected = {
    [CATEGORY_OTHER]: defaultSelectedOpIds(CATEGORY_OTHER, batch.other || []),
    [CATEGORY_DELETE]: defaultSelectedOpIds(CATEGORY_DELETE, batch.delete || []),
  };

  const stored = await store.appendEvent(requestEvent);
  if (typeof store.invalidate === 'function') await store.invalidate(batch);
  return { duplicate: false, requestEvent: stored };
}

// Resolve ONE category popup. Reads the op list for that category back from the
// privileged_batch_request event, applies the user's checked subset, and appends
// a privileged_batch_response event carrying per-op decisions + the signed
// manifest hash for that category's approved subset.
export async function resolvePrivilegedCategoryApproval(
  { batchId, category, checkedOpIds } = {},
  store,
  options = {},
) {
  const normalizedBatchId = trimString(batchId);
  const normalizedCategory = trimString(category);
  if (!normalizedBatchId || !normalizedCategory) {
    const error = new Error('batchId and category are required');
    error.code = 'RESOLVE_TARGET_REQUIRED';
    throw error;
  }
  if (!store || typeof store.readEvents !== 'function' || typeof store.appendEvent !== 'function') {
    const error = new Error('store with readEvents/appendEvent is required');
    error.code = 'STORE_REQUIRED';
    throw error;
  }

  const events = await store.readEvents();
  const request = events.find((event) => isPrivilegedBatchRequest(event, normalizedBatchId));
  if (!request) {
    const error = new Error('privileged batch request not found');
    error.code = 'BATCH_NOT_FOUND';
    throw error;
  }

  const categoryOps = (normalizedCategory === CATEGORY_DELETE
    ? request.delete
    : normalizedCategory === CATEGORY_INSTALL
      ? request.installAuto
      : request.other) || [];
  const existingResponse = events.find((event) =>
    isPrivilegedBatchResponse(event, normalizedBatchId, normalizedCategory));
  if (existingResponse) {
    return {
      duplicate: true,
      batchId: normalizedBatchId,
      category: normalizedCategory,
      responseEvent: existingResponse,
      ...resolveCategoryOpsFromDecisionEvent(categoryOps, existingResponse),
    };
  }
  const checked = new Set((Array.isArray(checkedOpIds) ? checkedOpIds : [])
    .map((id) => trimString(id))
    .filter(Boolean));

  const approved = categoryOps.filter((op) => checked.has(op.opId));
  const denied = categoryOps.filter((op) => !checked.has(op.opId));
  const decisions = {};
  for (const op of categoryOps) {
    decisions[op.opId] = checked.has(op.opId) ? 'approved' : 'denied';
  }
  const manifestHash = computeBatchManifestHash(approved, normalizedCategory);

  const responseEvent = privilegedBatchResponseEvent({
    batchId: normalizedBatchId,
    category: normalizedCategory,
    decisions,
    signedManifestHash: manifestHash,
    source: trimString(options.source) || PRIVILEGED_EVENT_SOURCE,
    temporaryControlGrantId: trimString(options.temporaryControlGrantId),
  });
  options.assertAuthorization?.();
  const stored = await store.appendEvent(responseEvent);
  if (typeof store.invalidate === 'function') await store.invalidate({ batchId: normalizedBatchId });

  return {
    duplicate: false,
    batchId: normalizedBatchId,
    category: normalizedCategory,
    approved,
    denied,
    categoryOps,
    manifestHash,
    decisions,
    responseEvent: stored,
  };
}

// P1c-8/P3e: in-scope software installs do not require the other/delete popup.
// They still get a durable privileged_batch_response so the timeline, audit
// projection, and idempotency model see the same approval lifecycle as manual
// categories.
export async function resolvePrivilegedInstallAutoApproval({ batchId, batch } = {}, store, options = {}) {
  const normalizedBatchId = trimString(batchId || batch?.batchId);
  if (!normalizedBatchId) {
    const error = new Error('batchId is required');
    error.code = 'RESOLVE_TARGET_REQUIRED';
    throw error;
  }
  if (!store || typeof store.readEvents !== 'function' || typeof store.appendEvent !== 'function') {
    const error = new Error('store with readEvents/appendEvent is required');
    error.code = 'STORE_REQUIRED';
    throw error;
  }

  const categoryOps = (Array.isArray(batch?.installAuto) ? batch.installAuto : [])
    .filter((op) => trimString(op?.opId) && trimString(op?.command));
  if (categoryOps.length === 0) {
    return {
      duplicate: false,
      batchId: normalizedBatchId,
      category: CATEGORY_INSTALL,
      approved: [],
      denied: [],
      categoryOps: [],
      manifestHash: '',
      decisions: {},
      responseEvent: null,
    };
  }

  const events = await store.readEvents();
  const existingResponse = events.find((event) =>
    isPrivilegedBatchResponse(event, normalizedBatchId, CATEGORY_INSTALL));
  if (existingResponse) {
    return {
      duplicate: true,
      batchId: normalizedBatchId,
      category: CATEGORY_INSTALL,
      responseEvent: existingResponse,
      ...resolveCategoryOpsFromDecisionEvent(categoryOps, existingResponse),
    };
  }

  const decisions = {};
  for (const op of categoryOps) {
    decisions[op.opId] = 'approved';
  }
  const manifestHash = computeBatchManifestHash(categoryOps, CATEGORY_INSTALL);
  const responseEvent = privilegedBatchResponseEvent({
    batchId: normalizedBatchId,
    category: CATEGORY_INSTALL,
    decisions,
    signedManifestHash: manifestHash,
    source: trimString(options.source) || PRIVILEGED_EVENT_SOURCE,
  });
  const stored = await store.appendEvent(responseEvent);
  if (typeof store.invalidate === 'function') await store.invalidate({ batchId: normalizedBatchId });

  return {
    duplicate: false,
    batchId: normalizedBatchId,
    category: CATEGORY_INSTALL,
    approved: categoryOps,
    denied: [],
    categoryOps,
    manifestHash,
    decisions,
    responseEvent: stored,
  };
}

// Read the persisted request + which categories are already resolved. Helper
// for the eventual UI/runner glue.
export async function getPrivilegedApprovalState(store, batchId) {
  const normalizedBatchId = trimString(batchId);
  if (!normalizedBatchId) return null;
  if (!store || typeof store.readEvents !== 'function') return null;
  const events = await store.readEvents();
  const request = events.find((event) => isPrivilegedBatchRequest(event, normalizedBatchId));
  if (!request) return null;
  const resolvedCategories = events
    .filter((event) => event?.type === 'privileged_batch_response'
      && trimString(event?.batchId) === normalizedBatchId)
    .map((event) => trimString(event.category));
  return {
    batchId: normalizedBatchId,
    requestEvent: request,
    resolvedCategories,
    pending: PRIVILEGED_APPROVAL_CATEGORIES.filter((c) => !resolvedCategories.includes(c)),
  };
}

// P1c-5 sync glue helper (design §13.7). During the run→session sync, the caller
// sees run.privilegedBatchPending (set only by the sidecar quiescence-debounce
// drain under privilegedMode, §13.6) and must decide what to do with it. This
// function is pure and store-injected so it is unit-testable with a fake store
// (the live realStore adapter — wrapping readEventsAfter/appendEvent/
// broadcastSessionInvalidation — is built by the caller in session-manager, where
// broadcastSessionInvalidation is in scope but intentionally not exported).
//
// Returns { clear, changed, error? }:
//   - clear: the caller should drop run.privilegedBatchPending (the batch was
//     surfaced, is a duplicate, is stale, or is unfixably malformed). false only
//     on a transient store failure so the next sync tick retries.
//   - changed: a NEW privileged_batch_request event was appended this call.
//   - error: present (and clear:false) when a transient store failure left the
//     batch pending for retry; the caller logs it.
//
// Default OFF in practice — the caller only invokes this when
// run.privilegedBatchPending is set, which only happens under privilegedMode.
// No privilege gain: the request event is inert data; actual root execution is P3.
export async function surfacePrivilegedBatchRequest(batch, privilegedMode, store) {
  if (!batch?.batchId) return { clear: false, changed: false };
  if (privilegedMode !== true) {
    // privilegedBatchPending present without privilegedMode (stale, or the mode was
    // turned off mid-run): clear it so the run is not stuck. No event is written.
    return { clear: true, changed: false };
  }
  if (!store || typeof store.readEvents !== 'function' || typeof store.appendEvent !== 'function') {
    const error = new Error('store with readEvents/appendEvent is required');
    error.code = 'STORE_REQUIRED';
    throw error;
  }
  try {
    const opened = await openPrivilegedBatchApproval(batch, store);
    // clear on success OR duplicate: the request event is persisted either way, so
    // the pending flag has done its job and must not re-trigger on the next tick.
    return { clear: true, changed: !opened?.duplicate };
  } catch (error) {
    // BATCH_INVALID = the batch is too broken to build a request event; retrying
    // will not help, so drop it. Anything else (transient read/append I/O, no
    // stable code) is retried by leaving the batch pending (clear:false).
    const transient = error?.code !== 'BATCH_INVALID';
    return { clear: !transient, changed: false, error };
  }
}

// ---------------------------------------------------------------------------
// Privileged-shim result writeback (design docs/privileged-shim-channel-
// 2026-09-03.md). The runner sidecar serves the real `agentoc-privileged`
// command: it writes `privilegedShimPending` alongside `privilegedBatchPending`.
// The command returns as soon as the batch is accepted; the server writes the
// final `privilegedShimResult` asynchronously after approval or execution.
// These builders return pure run-record updaters (or null when the caller has
// nothing to write) so the server wiring stays a one-liner and unit tests need
// no store.
// ---------------------------------------------------------------------------

function privilegedShimMatches(currentRun, batchId) {
  return currentRun?.privilegedShimPending?.batchId === batchId;
}

function privilegedShimResultPayload(batchId, requestId, extra = {}) {
  return {
    batchId,
    ...(requestId ? { requestId } : {}),
    ...extra,
    writtenAt: new Date().toISOString(),
  };
}

/**
 * Owner-resolution writeback: after every action of the batch reached a
 * terminal state, hand the per-op results to the Run's async shim result.
 */
export function buildPrivilegedShimResolveUpdate(currentRun, finalBatch) {
  const batchId = trimString(finalBatch?.batchId);
  if (!batchId || !privilegedShimMatches(currentRun, batchId)) return null;
  const results = (Array.isArray(finalBatch?.actions) ? finalBatch.actions : [])
    .map((action) => ({
      manifestHash: trimString(action?.manifestHash),
      canonicalCommand: trimString(action?.canonicalCommand),
      state: trimString(action?.state),
      resultRef: action?.resultRef && typeof action.resultRef === 'object' ? action.resultRef : {},
    }));
  return (current) => {
    if (!privilegedShimMatches(current, batchId)) return current;
    return {
      ...current,
      privilegedShimPending: undefined,
      privilegedShimResult: privilegedShimResultPayload(batchId, current.privilegedShimPending.requestId, {
        status: 'resolved',
        results,
      }),
    };
  };
}

// The legacy privileged-category route has its own response and execution
// events, separate from approved-action batches. A shim batch contains one
// operation; only that exact operation may settle the pending shim request.
export function buildPrivilegedShimCategoryUpdate(currentRun, batchId, resolved, execResults = []) {
  const pending = currentRun?.privilegedShimPending;
  const normalizedBatch = trimString(batchId);
  const opId = trimString(pending?.opId);
  if (!opId || !normalizedBatch || pending?.batchId !== normalizedBatch) return null;
  const denied = (resolved?.denied || []).find((op) => trimString(op?.opId) === opId);
  const approved = (resolved?.approved || []).find((op) => trimString(op?.opId) === opId);
  if (Boolean(denied) === Boolean(approved)) return null;
  const event = approved ? (Array.isArray(execResults) ? execResults : []).find((entry) => trimString(entry?.opId) === opId) : null;
  if (approved && !event) return null;
  const op = denied || approved;
  const success = approved && event.exitCode === 0 && !trimString(event.error);
  const result = {
    manifestHash: trimString(op.manifestHash),
    canonicalCommand: trimString(op.command),
    state: denied ? 'denied' : success ? 'completed' : 'failed',
    resultRef: event ? {
      exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
      ...(trimString(event.error) ? { error: trimString(event.error) } : {}),
      ...(trimString(event.stdoutRef) ? { stdoutRef: trimString(event.stdoutRef) } : {}),
    } : {},
  };
  return (current) => {
    if (current?.privilegedShimPending?.batchId !== normalizedBatch
        || current.privilegedShimPending.opId !== opId) return current;
    return {
      ...current,
      privilegedShimPending: undefined,
      privilegedShimResult: privilegedShimResultPayload(normalizedBatch, current.privilegedShimPending.requestId, {
        status: 'resolved', results: [result],
      }),
    };
  };
}

/**
 * installAuto writeback: in-scope installs execute at surface time without an
 * owner resolve route, so their privileged_exec_result events are mapped into
 * the same payload shape keyed off the surfaced batch's installAuto ops.
 */
export function buildPrivilegedShimInstallAutoUpdate(currentRun, batch, execResultEvents) {
  const batchId = trimString(batch?.batchId);
  if (!batchId || !privilegedShimMatches(currentRun, batchId)) return null;
  const events = Array.isArray(execResultEvents) ? execResultEvents : [];
  if (events.length === 0) return null;
  const installAutoOps = Array.isArray(batch?.installAuto) ? batch.installAuto : [];
  const results = events.map((event) => {
    const op = installAutoOps.find((candidate) => candidate?.opId === event?.opId) || null;
    const exitCode = Number.isInteger(event?.exitCode) ? event.exitCode : null;
    return {
      manifestHash: trimString(op?.manifestHash),
      canonicalCommand: trimString(op?.command),
      state: exitCode === 0 ? 'completed' : 'failed',
      resultRef: {
        exitCode,
        ...(trimString(event?.error) ? { error: trimString(event.error) } : {}),
        ...(trimString(event?.stdoutRef) ? { stdoutRef: trimString(event.stdoutRef) } : {}),
      },
    };
  });
  return (current) => {
    if (!privilegedShimMatches(current, batchId)) return current;
    return {
      ...current,
      privilegedShimPending: undefined,
      privilegedShimResult: privilegedShimResultPayload(batchId, current.privilegedShimPending.requestId, {
        status: 'resolved',
        results,
      }),
    };
  };
}

/**
 * Decline writeback: the batch can never surface because privileged routing is
 * disabled for the session. The Run gets an explicit declined result instead
 * of leaving the async request unresolved.
 */
export function buildPrivilegedShimDeclineUpdate(currentRun, batch, privilegedRouting) {
  if (privilegedRouting === true) return null;
  const batchId = trimString(batch?.batchId);
  if (!batchId || !privilegedShimMatches(currentRun, batchId)) return null;
  return (current) => {
    if (!privilegedShimMatches(current, batchId)) return current;
    return {
      ...current,
      privilegedShimPending: undefined,
      privilegedShimResult: privilegedShimResultPayload(batchId, current.privilegedShimPending.requestId, {
        status: 'declined',
        reason: 'privileged routing is disabled for this session',
      }),
    };
  };
}

export function buildPrivilegedShimPolicyDenialUpdate(currentRun, batch, reason) {
  const batchId = trimString(batch?.batchId);
  if (!batchId || !privilegedShimMatches(currentRun, batchId)) return null;
  return (current) => {
    if (!privilegedShimMatches(current, batchId)) return current;
    return {
      ...current,
      privilegedShimPending: undefined,
      privilegedShimResult: privilegedShimResultPayload(batchId, current.privilegedShimPending.requestId, {
        status: 'declined',
        reason: trimString(reason) || 'unattended privilege policy denied this operation',
      }),
    };
  };
}

/**
 * Sidecar-owned terminalization for an unresolved asynchronous shim request.
 * The sidecar uses this only when the owner deadline expires or the Run ends;
 * approval and execution results continue to be written by the server paths.
 */
export function buildPrivilegedShimTerminalUpdate(currentRun, batch, { status, reason } = {}) {
  if (!['timeout', 'cancelled'].includes(status)) return null;
  const batchId = trimString(batch?.batchId);
  if (!batchId || !privilegedShimMatches(currentRun, batchId)) return null;
  return (current) => {
    if (!privilegedShimMatches(current, batchId)) return current;
    return {
      ...current,
      privilegedShimPending: undefined,
      privilegedShimResult: privilegedShimResultPayload(batchId, current.privilegedShimPending.requestId, {
        status,
        reason: trimString(reason) || (status === 'timeout'
          ? 'owner did not resolve the privileged batch in time'
          : 'run ended before owner approval completed'),
      }),
    };
  };
}
