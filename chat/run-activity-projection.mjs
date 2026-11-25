import { formatToolCall } from './tool-call-formatters.mjs';
import { buildCanonicalToolCall, redactSensitiveText } from './tool-call-schema.mjs';
import { normalizeProviderLiveness } from './provider-liveness.mjs';
import { activeWindowsServiceRequest } from './windows-service-activity.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function eventBoundary(event) {
  if (Number.isInteger(event?.lastEventSeq) && event.lastEventSeq > 0) return event.lastEventSeq;
  if (Number.isInteger(event?.endSeq) && event.endSeq > 0) return event.endSeq;
  if (Number.isInteger(event?.blockEndSeq) && event.blockEndSeq > 0) return event.blockEndSeq;
  return Number.isInteger(event?.seq) ? event.seq : 0;
}

export function reduceTurnProgressState(state, events, runId) {
  let next = state && state.runId === runId ? state : null;
  for (const event of events) {
    const seq = eventBoundary(event);
    if (event?.runId !== runId || seq <= (next?.sourceSeq || 0)) continue;
    if (event.type === 'provider_turn_started' && trimString(event.providerThreadId) && trimString(event.providerTurnId)) {
      next = { runId, threadId: event.providerThreadId, turnId: event.providerTurnId, sourceSeq: seq,
        progress: next?.threadId === event.providerThreadId && next?.turnId === event.providerTurnId ? next.progress : null };
    } else if (event.type === 'message' && next && event.providerThreadId === next.threadId
      && event.providerTurnId === next.turnId && trimString(event.providerMessageId) && trimString(event.turnProgressText)) {
      next = { ...next, sourceSeq: seq, progress: { text: event.turnProgressText, runId,
        turnId: next.turnId, messageId: event.providerMessageId, sourceSeq: seq } };
    }
  }
  return next;
}

function currentTurnProgress(events, timeline, runId, storedState) {
  if (!runId) return null;
  if (storedState?.runId === runId && Number.isInteger(storedState.sourceSeq)) {
    const replay = [...(Array.isArray(timeline) ? timeline.filter((event) => event?.type === 'provider_turn_started') : []), ...events]
      .sort((a, b) => eventBoundary(a) - eventBoundary(b));
    return reduceTurnProgressState(storedState, replay, runId)?.progress || null;
  }
  const boundary = (Array.isArray(timeline) ? timeline : [])
    .filter((event) => event?.type === 'provider_turn_started' && event.runId === runId
      && trimString(event.providerThreadId) && trimString(event.providerTurnId)
      && eventBoundary(event) > 0)
    .sort((a, b) => eventBoundary(b) - eventBoundary(a))[0];
  if (!boundary) return null;
  const candidate = events.filter((event) => event?.type === 'message'
    && event.runId === runId && event.providerThreadId === boundary.providerThreadId
    && event.providerTurnId === boundary.providerTurnId
    && trimString(event.providerMessageId) && trimString(event.turnProgressText)
    && eventBoundary(event) > eventBoundary(boundary))
    .sort((a, b) => eventBoundary(b) - eventBoundary(a))[0];
  return candidate ? { text: candidate.turnProgressText, runId,
    turnId: candidate.providerTurnId, messageId: candidate.providerMessageId,
    sourceSeq: eventBoundary(candidate) } : null;
}

function isFormalAssistantOutput(event) {
  if (event?.type === 'message' && event.role === 'assistant') {
    return trimString(event.content) !== ''
      || (Array.isArray(event.attachments) && event.attachments.length > 0)
      || (Array.isArray(event.images) && event.images.length > 0);
  }
  return event?.type === 'attachment_delivery' || event?.type === 'plan';
}

function latestOutputBoundary(events) {
  let boundary = 0;
  for (const event of events) {
    if (isFormalAssistantOutput(event)) boundary = Math.max(boundary, eventBoundary(event));
  }
  return boundary;
}

function withPresentation(activity, events, sourceEvent = null) {
  const outputBoundarySeq = latestOutputBoundary(events);
  const sourceSeq = eventBoundary(sourceEvent);
  const formatted = activity?.presentation && typeof activity.presentation === 'object'
    ? activity.presentation
    : (activity?.toolCall ? formatToolCall(activity.toolCall, activity) : null);
  const requestedKind = trimString(activity?.kind).toLowerCase();
  const kind = requestedKind || formatted?.kind || 'working';
  const updatedAt = parseTimestamp(sourceEvent?.updatedAt || sourceEvent?.timestamp);
  return {
    ...activity,
    kind,
    labelKind: trimString(activity?.labelKind) || formatted?.labelKind || kind,
    subject: typeof formatted?.subject === 'string' ? formatted.subject : trimString(activity?.subject),
    detail: redactSensitiveText(
      typeof formatted?.detail === 'string' && formatted.detail
        ? formatted.detail
        : trimString(activity?.detail),
    ),
    ...(formatted ? { presentation: formatted } : {}),
    ...(formatted?.activityDescription ? { activityDescription: formatted.activityDescription } : {}),
    ...(formatted?.activityDescriptionSource ? { activityDescriptionSource: formatted.activityDescriptionSource } : {}),
    ...(Number.isInteger(formatted?.activityDescriptionSeq) && formatted.activityDescriptionSeq > 0
      ? { activityDescriptionSeq: formatted.activityDescriptionSeq } : {}),
    ...(formatted?.group ? { group: formatted.group } : {}),
    sourceSeq,
    outputBoundarySeq,
    // The live activity row represents the active run, not an unfinished
    // transcript segment. Keep it visible for the whole run, including while
    // formal assistant output is being streamed or has already been persisted.
    inlineEligible: activity?.state !== 'idle',
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function activityCapabilities(run = {}, operation = null) {
  const capabilities = run?.providerCapabilities && typeof run.providerCapabilities === 'object'
    ? run.providerCapabilities
    : {};
  return {
    canInterrupt: capabilities.supportsInterrupt !== false && operation?.canInterrupt !== false,
    canSteer: operation?.canSteer === true || capabilities.supportsSteer === true,
  };
}

function buildIdleActivity() {
  return {
    state: 'idle',
    kind: 'idle',
    label: '',
    detail: '',
    operationId: null,
    since: null,
    elapsedMs: 0,
    actionRequired: false,
    canInterrupt: false,
    canSteer: false,
    labelKind: 'idle',
    subject: '',
    sourceSeq: 0,
    outputBoundarySeq: 0,
    inlineEligible: false,
  };
}

function findPendingApproval(events) {
  const resolvedApprovalIds = new Set();
  for (const event of events) {
    if (event?.type === 'approval_response') {
      const approvalId = trimString(event.approvalId);
      if (approvalId) resolvedApprovalIds.add(approvalId);
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'approval_request') continue;
    const approvalId = trimString(event.approvalId);
    const status = trimString(event.status).toLowerCase();
    if (approvalId && resolvedApprovalIds.has(approvalId)) continue;
    if (['approved', 'denied', 'declined', 'cancelled', 'canceled'].includes(status)) continue;
    return event;
  }
  return null;
}

const PRIVILEGED_APPROVAL_CATEGORIES = Object.freeze(['privileged_other', 'destructive_delete']);

function getPrivilegedCategoryOps(event, category) {
  if (category === 'privileged_other') return Array.isArray(event?.other) ? event.other : [];
  if (category === 'destructive_delete') return Array.isArray(event?.delete) ? event.delete : [];
  return [];
}

function findPendingPrivilegedApproval(events) {
  const resolvedByBatch = new Map();
  for (const event of events) {
    if (event?.type === 'privileged_batch_response') {
      const batchId = trimString(event.batchId);
      const category = trimString(event.category);
      if (!batchId || !category) continue;
      if (!resolvedByBatch.has(batchId)) resolvedByBatch.set(batchId, new Set());
      resolvedByBatch.get(batchId).add(category);
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'privileged_batch_request') continue;
    const batchId = trimString(event.batchId);
    if (!batchId) continue;
    const resolvedCategories = resolvedByBatch.get(batchId) || new Set();
    const pendingCategory = PRIVILEGED_APPROVAL_CATEGORIES.find((category) => (
      getPrivilegedCategoryOps(event, category).length > 0
      && !resolvedCategories.has(category)
    ));
    if (!pendingCategory) continue;
    const ops = getPrivilegedCategoryOps(event, pendingCategory);
    const firstOp = ops[0] || {};
    return {
      event,
      category: pendingCategory,
      detail: trimString(firstOp.description || firstOp.command),
    };
  }
  return null;
}

function findPendingApprovedAction(events) {
  const states = new Map();
  for (const event of events) {
    if (event?.type !== 'approved_action_state') continue;
    const actionId = trimString(event.actionId);
    if (!actionId) continue;
    states.set(actionId, trimString(event.state));
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'approved_action_batch_request') continue;
    const action = (Array.isArray(event.actions) ? event.actions : [])
      .find((candidate) => !['denied', 'cancelled', 'expired', 'completed', 'failed'].includes(
        states.get(trimString(candidate?.actionId)) || trimString(candidate?.state),
      ));
    if (!action) continue;
    return { event, action };
  }
  return null;
}

export function buildRunActivityProjection(displayEvents = [], options = {}) {
  if (options.sessionRunning !== true) return buildIdleActivity();
  const run = options.run && typeof options.run === 'object' ? options.run : {};
  const runStart = parseTimestamp(run.startedAt) || parseTimestamp(run.createdAt);
  const observedAt = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const runId = trimString(run.id || run.runId);
  const requestId = trimString(run.requestId);
  // Events without a confirmed run/request identity cannot safely be assigned
  // to the current run. Keep the identity-free mode for callers projecting an
  // already scoped collection without a run object.
  const events = (Array.isArray(displayEvents) ? displayEvents : []).filter((event) => {
    if (!runId && !requestId) return true;
    const eventRunId = trimString(event?.runId);
    if (eventRunId) return Boolean(runId && eventRunId === runId);
    return Boolean(requestId && trimString(event?.requestId) === requestId);
  });
  const providerLiveness = normalizeProviderLiveness(run.providerLiveness);
  const turnProgress = currentTurnProgress(events, options.timeline, runId, run.turnProgressState);
  const present = (activity, sourceEvent) => withPresentation({
    ...activity,
    ...(turnProgress ? { turnProgress } : {}),
    ...(runId ? { runId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(runStart && observedAt >= runStart ? { runElapsedMs: observedAt - runStart } : {}),
    ...(providerLiveness ? { providerLiveness } : {}),
  }, events, sourceEvent);

  if (run?.agyQueue?.reason === 'agy-account-busy') {
    const since = parseTimestamp(run.agyQueue.queuedAt) || parseTimestamp(run.createdAt);
    return present({
      state: 'queued',
      kind: 'provider_slot',
      label: 'Waiting for AgY account slot',
      detail: 'Another task is using this AgY account.',
      operationId: null,
      since,
      elapsedMs: 0,
      actionRequired: false,
      ...activityCapabilities(run),
    }, null);
  }

  if (run?.adaptiveQueue?.reason === 'adaptive_capacity' || run?.runnerLaunchState === 'adaptive_capacity') {
    const since = parseTimestamp(run.adaptiveQueue?.queuedAt) || parseTimestamp(run.runnerLaunchQueuedAt) || parseTimestamp(run.createdAt);
    return present({
      state: 'queued',
      kind: 'adaptive_capacity',
      label: 'Waiting for system capacity',
      detail: 'Other tasks are currently using system execution capacity.',
      operationId: null,
      since,
      elapsedMs: 0,
      actionRequired: false,
      adaptiveCapacityWait: true,
      ...activityCapabilities(run),
    }, null);
  }

  const serviceRequest = activeWindowsServiceRequest(run, observedAt);
  if (serviceRequest) {
    const waiting = serviceRequest.status === 'awaiting_device';
    return present({
      state: waiting ? 'waiting_user' : 'working',
      kind: waiting ? 'approval' : 'execute',
      label: waiting ? 'Waiting for approval' : 'Running Windows service action',
      detail: '', operationId: serviceRequest.requestId,
      since: serviceRequest.startedMs, elapsedMs: Math.max(0, observedAt - serviceRequest.startedMs),
      actionRequired: waiting, ...activityCapabilities(run),
    }, null);
  }

  const pendingApproval = findPendingApproval(events);
  if (pendingApproval) {
    const matchingOperation = [...events].reverse().find((event) => (
      event?.type === 'operation'
      && (
        (pendingApproval.approvalId && event.approvalId === pendingApproval.approvalId)
        || (pendingApproval.providerItemId && event.providerItemId === pendingApproval.providerItemId)
        || (pendingApproval.providerToolUseId && event.providerToolUseId === pendingApproval.providerToolUseId)
      )
    ));
    const since = parseTimestamp(pendingApproval.timestamp);
    return present({
      state: 'waiting_user',
      kind: 'approval',
      label: 'Approval required',
      detail: redactSensitiveText(
        trimString(pendingApproval.title || pendingApproval.command || pendingApproval.reason),
      ),
      operationId: matchingOperation?.operationId || null,
      since,
      elapsedMs: 0,
      actionRequired: true,
      ...activityCapabilities(run),
    }, pendingApproval);
  }

  const pendingApprovedAction = findPendingApprovedAction(events);
  if (pendingApprovedAction) {
    const since = parseTimestamp(pendingApprovedAction.event.createdAt || pendingApprovedAction.event.timestamp);
    return present({
      state: 'waiting_user',
      kind: 'approval',
      label: 'Managed action approval required',
      detail: redactSensitiveText(
        trimString(
          pendingApprovedAction.action?.originalRequest?.description
          || pendingApprovedAction.action?.description
          || pendingApprovedAction.action?.canonicalCommand,
        ),
      ),
      operationId: null,
      since,
      elapsedMs: 0,
      actionRequired: true,
      ...activityCapabilities(run),
    }, pendingApprovedAction.event);
  }

  const pendingPrivilegedApproval = findPendingPrivilegedApproval(events);
  if (pendingPrivilegedApproval) {
    const since = parseTimestamp(pendingPrivilegedApproval.event.timestamp);
    return present({
      state: 'waiting_user',
      kind: 'approval',
      label: 'Privileged approval required',
      detail: redactSensitiveText(pendingPrivilegedApproval.detail),
      operationId: null,
      since,
      elapsedMs: 0,
      actionRequired: true,
      ...activityCapabilities(run),
    }, pendingPrivilegedApproval.event);
  }

  const activeOperations = events
    .filter((event) => event?.type === 'operation'
      && ['running', 'waiting_approval'].includes(event.state)
      && !(Array.isArray(event.diagnostics) && event.diagnostics.some((item) => item?.code === 'orphan_operation')))
    .sort((left, right) => {
      const leftStart = Number.isInteger(left.startSeq) && left.startSeq > 0 ? left.startSeq : 0;
      const rightStart = Number.isInteger(right.startSeq) && right.startSeq > 0 ? right.startSeq : 0;
      return rightStart - leftStart || trimString(left.operationId).localeCompare(trimString(right.operationId));
    });
  const operation = activeOperations[0] || null;
  if (operation) {
    const since = parseTimestamp(operation.startedAt || operation.timestamp);
    const updatedAt = parseTimestamp(operation.updatedAt) || since;
    const toolCall = operation.toolCall || buildCanonicalToolCall(operation);
    return present({
      state: operation.state === 'waiting_approval' ? 'waiting_user' : 'working',
      kind: operation.state === 'waiting_approval' ? 'approval' : toolCall.kind,
      label: operation.state === 'waiting_approval' ? 'Approval required' : trimString(operation.title),
      detail: trimString(operation.detail || operation.command),
      toolCall,
      ...(operation.presentation ? { presentation: operation.presentation } : {}),
      ...(operation.state === 'waiting_approval' ? { labelKind: 'approval' } : {}),
      operationId: operation.operationId,
      operationState: operation.state,
      ...(operation.webAction ? { webAction: operation.webAction } : {}),
      ...(operation.operationProgress ? { operationProgress: operation.operationProgress } : {}),
      ...Object.fromEntries(['toolCallId', 'providerItemId', 'providerToolUseId', 'providerThreadId', 'providerTurnId'].filter((key) => trimString(operation[key])).map((key) => [key, operation[key]])),
      ...(Number.isInteger(operation.startSeq) && operation.startSeq > 0 ? { startSeq: operation.startSeq } : {}),
      since,
      elapsedMs: since && updatedAt ? Math.max(0, updatedAt - since) : 0,
      actionRequired: operation.state === 'waiting_approval',
      ...activityCapabilities(run, operation),
    }, operation);
  }

  const latest = [...events].reverse().find((event) => event && typeof event === 'object');
  const since = parseTimestamp(run?.startedAt) || parseTimestamp(latest?.timestamp);
  if (latest?.type === 'plan' && ['running', 'drafting'].includes(trimString(latest.state || latest.status))) {
    return present({
      state: 'working',
      kind: 'planning',
      label: 'Drafting plan',
      detail: trimString(latest.title),
      operationId: null,
      since,
      elapsedMs: 0,
      actionRequired: false,
      ...activityCapabilities(run),
    }, latest);
  }
  if (latest?.type === 'message' && latest.role === 'assistant') {
    return present({
      state: 'working',
      kind: 'responding',
      label: 'Writing response',
      detail: '',
      operationId: null,
      since,
      elapsedMs: 0,
      actionRequired: false,
      ...activityCapabilities(run),
    }, latest);
  }
  return present({
    state: 'working',
    kind: 'thinking',
    label: 'Analyzing',
    detail: '',
    operationId: null,
    since,
    elapsedMs: 0,
    actionRequired: false,
    ...activityCapabilities(run),
  }, latest);
}

// Activity updates are a pure replay of deterministic ToolCall projection data.
