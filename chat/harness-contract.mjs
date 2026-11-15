// Stable contract for externally hosted agent harnesses.
//
// This describes the boundary between Ragent's durable control plane and a
// provider-specific agent loop. It intentionally does not prescribe a wire
// protocol: JSON-RPC, JSONL, ACP, HTTP+SSE, and a local SDK can all implement
// this contract through an adapter.

export const HARNESS_ADAPTER_CONTRACT_VERSION = '1.2';
export const HARNESS_ADAPTER_SUPPORTED_VERSIONS = Object.freeze(['1.0', '1.1', '1.2']);

export const HARNESS_TRANSPORTS = Object.freeze([
  'process-jsonl',
  'process-jsonl-bidi',
  'json-rpc-stdio',
  'http-sse',
  'acp',
  'sdk',
]);

export const HARNESS_EVENT_TYPES = Object.freeze([
  'run.started',
  'turn.started',
  'assistant.delta',
  'assistant.message',
  'reasoning.delta',
  'tool.started',
  'tool.approval_required',
  'tool.progress',
  'tool.completed',
  'file.changed',
  'usage.updated',
  'run.waiting',
  'run.cancel_requested',
  'run.cancel_acknowledged',
  'run.resumed',
  'checkpoint.created',
  'approval.responded',
  'artifact.created',
  'artifact.published',
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export const HARNESS_TERMINAL_STATES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
]);

export const HARNESS_REQUIRED_OPERATIONS = Object.freeze([
  'start',
  'sendTurn',
  'cancel',
  'terminate',
]);

export const HARNESS_OPTIONAL_OPERATIONS = Object.freeze([
  'resume',
  'getResumeAnchor',
  'steer',
  'followUp',
  'respondToApproval',
  'acknowledgeCancel',
  'listArtifacts',
]);

export const HARNESS_CAPABILITY_KEYS = Object.freeze([
  'supportsResume',
  'supportsSteer',
  'supportsInterrupt',
  'supportsApproval',
  'supportsBidirectionalApproval',
  'supportsCancelAck',
  'supportsResumeAnchor',
  'supportsArtifacts',
]);

const SETS = {
  transports: new Set(HARNESS_TRANSPORTS),
  events: new Set(HARNESS_EVENT_TYPES),
  terminalStates: new Set(HARNESS_TERMINAL_STATES),
  requiredOperations: new Set(HARNESS_REQUIRED_OPERATIONS),
  optionalOperations: new Set(HARNESS_OPTIONAL_OPERATIONS),
  versions: new Set(HARNESS_ADAPTER_SUPPORTED_VERSIONS),
};

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function list(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Validate the adapter metadata before a runtime is admitted.
 * This is intentionally a pure shape check; actual process, sandbox and
 * approval verification remain runtime admission responsibilities.
 */
export function validateHarnessAdapterDescriptor(descriptor) {
  const errors = [];
  const input = descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)
    ? descriptor
    : {};

  const contractVersion = text(input.contractVersion);
  if (!SETS.versions.has(contractVersion)) {
    errors.push(`contractVersion must be one of: ${HARNESS_ADAPTER_SUPPORTED_VERSIONS.join(', ')}`);
  }
  if (!text(input.id)) errors.push('id is required');
  if (!text(input.provider)) errors.push('provider is required');
  if (!SETS.transports.has(text(input.transport))) {
    errors.push(`transport must be one of: ${HARNESS_TRANSPORTS.join(', ')}`);
  }

  const operations = new Set(list(input.operations).map(text).filter(Boolean));
  for (const operation of HARNESS_REQUIRED_OPERATIONS) {
    if (!operations.has(operation)) errors.push(`operation is required: ${operation}`);
  }
  for (const operation of operations) {
    if (!SETS.requiredOperations.has(operation) && !SETS.optionalOperations.has(operation)) {
      errors.push(`unsupported operation: ${operation}`);
    }
  }

  const events = new Set(list(input.events).map(text).filter(Boolean));
  if (!input.capabilities || typeof input.capabilities !== 'object' || Array.isArray(input.capabilities)) {
    errors.push('capabilities object is required');
  } else {
    const capabilityKeys = contractVersion === '1.0'
      ? ['supportsResume', 'supportsSteer', 'supportsInterrupt', 'supportsApproval']
      : HARNESS_CAPABILITY_KEYS;
    for (const key of capabilityKeys) {
      if (typeof input.capabilities[key] !== 'boolean') {
        errors.push(`capabilities.${key} must be boolean`);
      }
    }
    if (input.capabilities.supportsResume && !operations.has('resume')) {
      errors.push('supportsResume requires resume operation');
    }
    if (input.capabilities.supportsSteer && !operations.has('steer')) {
      errors.push('supportsSteer requires steer operation');
    }
    if (input.capabilities.supportsApproval && !operations.has('respondToApproval')) {
      errors.push('supportsApproval requires respondToApproval operation');
    }
    if (input.capabilities.supportsBidirectionalApproval && input.capabilities.supportsApproval !== true) {
      errors.push('supportsBidirectionalApproval requires supportsApproval');
    }
    if (input.capabilities.supportsBidirectionalApproval && !events.has('approval.responded')) {
      errors.push('supportsBidirectionalApproval requires approval.responded event');
    }
    if (input.capabilities.supportsCancelAck && !events.has('run.cancel_acknowledged')) {
      errors.push('supportsCancelAck requires run.cancel_acknowledged event');
    }
    if (input.capabilities.supportsResumeAnchor
      && (!operations.has('resume') || !operations.has('getResumeAnchor'))) {
      errors.push('supportsResumeAnchor requires resume and getResumeAnchor operations');
    }
    if (input.capabilities.supportsResumeAnchor && !events.has('checkpoint.created')) {
      errors.push('supportsResumeAnchor requires checkpoint.created event');
    }
    if (input.capabilities.supportsArtifacts && !events.has('artifact.created')) {
      errors.push('supportsArtifacts requires artifact.created event');
    }
  }

  for (const event of events) {
    if (!SETS.events.has(event)) errors.push(`unsupported event: ${event}`);
  }
  for (const event of ['run.started', 'assistant.message', 'run.completed', 'run.failed', 'run.cancelled']) {
    if (!events.has(event)) errors.push(`event is required: ${event}`);
  }
  if (input.capabilities?.supportsApproval && !events.has('tool.approval_required')) {
    errors.push('supportsApproval requires tool.approval_required event');
  }

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

/**
 * Upgrade a legacy descriptor to the current additive shape. This does not
 * claim capabilities that the legacy descriptor did not declare.
 */
export function normalizeHarnessAdapterDescriptor(descriptor) {
  const input = descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)
    ? descriptor
    : {};
  const capabilities = input.capabilities && typeof input.capabilities === 'object'
    ? input.capabilities
    : {};
  return {
    ...input,
    contractVersion: HARNESS_ADAPTER_CONTRACT_VERSION,
    capabilities: Object.fromEntries(HARNESS_CAPABILITY_KEYS.map((key) => [
      key,
      capabilities[key] === true,
    ])),
    events: [...new Set(list(input.events).map(text).filter(Boolean))],
    operations: [...new Set(list(input.operations).map(text).filter(Boolean))],
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventIdOf(event) {
  return text(event?.eventId || event?.id);
}

function sequenceOf(event) {
  const value = Number(event?.seq ?? event?.sequence);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Validate one event envelope. `strict: false` preserves 1.0 bridge reads. */
export function validateHarnessEvent(event, { strict = true, runId = '', turnId = '' } = {}) {
  const errors = [];
  const input = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  const type = text(input.type);
  if (!SETS.events.has(type)) errors.push(`unsupported event: ${type || '(missing)'}`);
  if (strict && !eventIdOf(input)) errors.push('eventId is required');
  if (strict && sequenceOf(input) === null) errors.push('seq must be a positive integer');
  const effectiveRunId = text(input.runId || runId);
  if (strict && !effectiveRunId) errors.push('runId is required');
  if (runId && input.runId && text(input.runId) !== text(runId)) errors.push('runId does not match context');
  if (turnId && input.turnId && text(input.turnId) !== text(turnId)) errors.push('turnId does not match context');
  if (strict && ['tool.started', 'tool.progress', 'tool.completed'].includes(type)
    && !text(
      input.toolCallId
      || input.tool_call_id
      || input.data?.toolCallId
      || input.data?.tool_call_id
      || input.data?.callId
      || input.data?.call_id,
    )) {
    errors.push(`${type} requires toolCallId`);
  }
  if (type === 'tool.approval_required' && !text(input.data?.approvalId || input.approvalId || input.data?.id)) {
    errors.push('tool.approval_required requires approvalId');
  }
  if (type === 'approval.responded' && !text(input.data?.approvalId || input.approvalId)) {
    errors.push('approval.responded requires approvalId');
  }
  if (['artifact.created', 'artifact.published'].includes(type)
    && !text(input.data?.artifactId || input.artifactId)) {
    errors.push(`${type} requires artifactId`);
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

/** Fill the additive envelope fields without inventing an event identity. */
export function normalizeHarnessEvent(event, { runId = '', turnId = '', strict = false } = {}) {
  const input = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  const normalized = {
    ...input,
    ...(eventIdOf(input) ? { eventId: eventIdOf(input) } : {}),
    ...(sequenceOf(input) !== null ? { seq: sequenceOf(input) } : {}),
    ...(text(input.runId || runId) ? { runId: text(input.runId || runId) } : {}),
    ...(text(input.turnId || turnId) ? { turnId: text(input.turnId || turnId) } : {}),
  };
  const validation = validateHarnessEvent(normalized, { strict, runId, turnId });
  return { event: normalized, ...validation };
}

export function createHarnessEventLedger({ runId = '', turnId = '', lastSeq = 0, seenEventIds = [] } = {}) {
  return {
    runId: text(runId),
    turnId: text(turnId),
    lastSeq: Number.isInteger(lastSeq) && lastSeq > 0 ? lastSeq : 0,
    seenEventIds: new Set((Array.isArray(seenEventIds) ? seenEventIds : []).map(text).filter(Boolean)),
    fingerprints: new Map(),
  };
}

/**
 * Accept exactly-once event identities in a restart-safe, monotonic sequence.
 * The caller persists `lastSeq` and `seenEventIds` with its run checkpoint.
 */
export function acceptHarnessEvent(event, ledger) {
  const state = ledger && typeof ledger === 'object' ? ledger : createHarnessEventLedger();
  const normalized = normalizeHarnessEvent(event, { runId: state.runId, turnId: state.turnId, strict: true });
  if (!normalized.valid) return { accepted: false, reason: 'invalid', errors: normalized.errors, event: normalized.event };
  const value = normalized.event;
  const id = value.eventId;
  const fingerprint = stableJson(value);
  if (state.seenEventIds.has(id)) {
    const prior = state.fingerprints.get(id);
    return {
      accepted: false,
      duplicate: true,
      replay: true,
      conflict: Boolean(prior && prior !== fingerprint),
      reason: prior && prior !== fingerprint ? 'event_id_conflict' : 'duplicate',
      event: value,
    };
  }
  if (value.seq <= state.lastSeq) {
    return { accepted: false, replay: true, reason: 'out_of_order', event: value };
  }
  state.seenEventIds.add(id);
  state.fingerprints.set(id, fingerprint);
  state.lastSeq = value.seq;
  return { accepted: true, duplicate: false, replay: false, event: value };
}
