import { classifyProviderOperation, getOperationTitle } from './provider-operation-classifier.mjs';
import { formatToolCall } from './tool-call-formatters.mjs';
import { buildCanonicalToolCall, redactSensitiveText } from './tool-call-schema.mjs';
import { serializeProviderToolValue } from './provider-tool-normalization.mjs';

const TERMINAL_STATES = new Set(['completed', 'failed', 'declined', 'interrupted']);
const RAW_OPERATION_TYPES = new Set(['tool_use', 'tool_result', 'file_change']);
const MAX_OPERATION_OUTPUT_CHARS = Math.max(
  16 * 1024,
  Number.parseInt(process.env.RAGENT_MAX_OPERATION_OUTPUT_CHARS || String(256 * 1024), 10)
    || 256 * 1024,
);
const MAX_FALLBACK_OPERATION_SCAN = 256;
const MAX_OPERATION_FILE_CHANGES = 256;
const MAX_OPERATION_LOCATIONS = 256;
const MAX_OPERATION_DIAGNOSTICS = 128;
const MAX_OPERATION_OUTPUT_CHUNKS = 128;
const OPERATION_OUTPUT_PREVIEW_INTERVAL = 32;
const REPLAY_IDENTITY_TEXT_CHARS = 2048;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedIdentityText(value) {
  const text = trimString(value);
  if (text.length <= REPLAY_IDENTITY_TEXT_CHARS) return text;
  const tail = Math.floor(REPLAY_IDENTITY_TEXT_CHARS / 4);
  return `${text.slice(0, REPLAY_IDENTITY_TEXT_CHARS - tail)}…${text.slice(-tail)}`;
}

function eventSeq(event) {
  return Number.isInteger(event?.seq) && event.seq > 0 ? event.seq : 0;
}

function eventTimestamp(event) {
  const value = event?.timestamp;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function lifecycleState(event, fallback = 'running') {
  const lifecycle = trimString(event?.operationLifecycle).toLowerCase();
  if (['failed', 'error'].includes(lifecycle)) return 'failed';
  if (['declined', 'denied'].includes(lifecycle)) return 'declined';
  if (['interrupted', 'cancelled', 'canceled'].includes(lifecycle)) return 'interrupted';
  if (['completed', 'success', 'succeeded'].includes(lifecycle)) return 'completed';
  if (['waiting_approval', 'approval_requested'].includes(lifecycle)) return 'waiting_approval';
  if (['started', 'running', 'in_progress', 'inprogress', 'delta'].includes(lifecycle)) return 'running';
  return fallback;
}

function isDeltaEvent(event) {
  return trimString(event?.operationLifecycle).toLowerCase() === 'delta';
}

function readCorrelationKeys(event) {
  const keys = [];
  for (const candidate of [
    event?.providerItemId,
    event?.providerToolUseId,
    event?.toolCallId,
    event?.providerRequestId,
  ]) {
    const normalized = trimString(candidate);
    const key = normalized ? `provider:${normalized}` : '';
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function readRunScope(event) {
  return trimString(event?.runId)
    || trimString(event?.requestId)
    || trimString(event?.providerTurnId)
    || 'turn';
}

function buildOperationId(event, correlationKey, startSeq) {
  const scope = encodeURIComponent(readRunScope(event));
  const identity = encodeURIComponent(correlationKey || `seq:${startSeq}`);
  return `operation:${scope}:${identity}`;
}

function normalizeToolName(event) {
  return trimString(event?.toolName || event?.sourceToolName).toLowerCase();
}

function terminalStateForResult(event) {
  const explicit = lifecycleState(event, '');
  if (explicit) return explicit;
  const exitCode = Number(event?.exitCode);
  return Number.isFinite(exitCode) && exitCode !== 0 ? 'failed' : 'completed';
}

function findFallbackOperation(operations, event, { kind = '' } = {}) {
  const toolName = normalizeToolName(event);
  const firstIndex = Math.max(0, operations.length - MAX_FALLBACK_OPERATION_SCAN);
  for (let index = operations.length - 1; index >= firstIndex; index -= 1) {
    const operation = operations[index];
    if (TERMINAL_STATES.has(operation.state)) continue;
    if (kind && operation.kind !== kind) continue;
    if (toolName && operation._toolName && operation._toolName !== toolName) continue;
    return operation;
  }
  return null;
}

function createOperation(event, correlationKeys = [], { orphan = false } = {}) {
  const seq = eventSeq(event);
  const classified = classifyProviderOperation(event);
  const timestamp = eventTimestamp(event);
  const correlationKey = correlationKeys[0] || '';
  return {
    type: 'operation',
    id: buildOperationId(event, correlationKey, seq),
    operationId: buildOperationId(event, correlationKey, seq),
    seq,
    startSeq: seq,
    endSeq: seq,
    timestamp,
    updatedAt: timestamp,
    provider: trimString(event?.provider),
    runtimeFamily: trimString(event?.runtimeFamily),
    runId: trimString(event?.runId),
    kind: classified.kind,
    state: 'running',
    title: classified.title,
    detail: classified.detail,
    toolName: classified.toolName || '',
    input: classified.input || {},
    locations: [],
    command: classified.command || '',
    cwd: classified.cwd || '',
    executionPlatform: classified.executionPlatform || '',
    shellKind: classified.shellKind || '',
    action: classified.action || null,
    startedAt: timestamp,
    completedAt: null,
    durationMs: null,
    exitCode: null,
    outputPreview: null,
    fileChanges: [],
    approvalId: '',
    canInterrupt: event?.providerCapabilities?.supportsInterrupt !== false,
    canSteer: event?.providerCapabilities?.supportsSteer === true,
    _correlationKeys: new Set(correlationKeys),
    _toolName: normalizeToolName(event),
    _output: '',
    _outputChunks: [],
    _outputChars: 0,
    _outputBodyAvailable: false,
    _outputBodySeq: null,
    _orphan: orphan,
    _diagnostics: [],
  };
}

function updateOperationIdentity(operation, event) {
  operation.provider ||= trimString(event?.provider);
  operation.runtimeFamily ||= trimString(event?.runtimeFamily);
  operation.runId ||= trimString(event?.runId);
  if (event?.providerCapabilities?.supportsInterrupt === false) operation.canInterrupt = false;
  if (event?.providerCapabilities?.supportsSteer === true) operation.canSteer = true;
}

function updateOperationBoundary(operation, event) {
  const seq = eventSeq(event);
  if (seq > 0) {
    if (!(operation.startSeq > 0)) operation.startSeq = seq;
    operation.endSeq = Math.max(operation.endSeq || 0, seq);
    operation.seq = operation.startSeq;
  }
  const timestamp = eventTimestamp(event);
  if (timestamp) {
    operation.startedAt ||= timestamp;
    operation.timestamp ||= timestamp;
    operation.updatedAt = Math.max(operation.updatedAt || 0, timestamp);
  }
}

function updateOperationClassification(operation, event) {
  const classified = classifyProviderOperation(event);
  if (operation.kind === 'other' || event?.type === 'file_change') operation.kind = classified.kind;
  if (!operation.title || operation.title === getOperationTitle('other')) operation.title = classified.title;
  if (!operation.detail && classified.detail) operation.detail = classified.detail;
  if (!operation.toolName && classified.toolName) operation.toolName = classified.toolName;
  if (Object.keys(operation.input || {}).length === 0 && Object.keys(classified.input || {}).length > 0) {
    operation.input = classified.input;
  }
  if (!operation.command && classified.command) operation.command = classified.command;
  if (!operation.cwd && classified.cwd) operation.cwd = classified.cwd;
  if (!operation.executionPlatform && classified.executionPlatform) operation.executionPlatform = classified.executionPlatform;
  if (!operation.shellKind && classified.shellKind) operation.shellKind = classified.shellKind;
  if (classified.action && (!operation.action
    || (operation.action.semanticKind === 'execute' && classified.action.semanticKind !== 'execute'))) {
    operation.action = classified.action;
  }
  operation._toolName ||= normalizeToolName(event);
}

function addDiagnostic(diagnostics, operation, event, code, detail = '') {
  const diagnostic = {
    code,
    eventType: trimString(event?.type) || 'unknown',
    seq: eventSeq(event),
    ...(operation?.operationId ? { operationId: operation.operationId } : {}),
    ...(detail ? { detail } : {}),
  };
  if (diagnostics.length < MAX_OPERATION_DIAGNOSTICS) diagnostics.push(diagnostic);
  if (operation && operation._diagnostics.length < MAX_OPERATION_DIAGNOSTICS) {
    operation._diagnostics.push(diagnostic);
  }
  return diagnostic;
}

function annotateActionGroups(displayOperations) {
  const grouped = displayOperations.slice();
  let current = null;
  const isGroupable = (operation) => operation?.presentation?.groupable === true
    && ['read', 'list', 'search', 'inspect'].includes(operation?.presentation?.actionKind || operation?.presentation?.labelKind);
  for (let index = 0; index < grouped.length; index += 1) {
    const operation = grouped[index];
    const sameRun = current && current.runId === (operation.runId || '');
    if (!isGroupable(operation) || !sameRun || current.items.length >= 8
      || operation.state === 'failed' || operation.state === 'declined' || operation.state === 'interrupted') {
      current = null;
    }
    if (!isGroupable(operation)) continue;
    if (!current) {
      current = {
        id: `action-group:${operation.runId || 'turn'}:${operation.operationId || operation.id}`,
        runId: operation.runId || '',
        items: [],
      };
    }
    current.items.push(operation);
    if (current.items.length > 1) {
      const group = {
        id: current.id,
        kind: 'exploring',
        index: current.items.length - 1,
        count: current.items.length,
        items: current.items.map((item) => ({
          operationId: item.operationId,
          labelKind: item.presentation.labelKind,
          subject: item.presentation.subject,
        })),
      };
      for (const item of current.items) item.presentation = { ...item.presentation, group };
    }
  }
  return grouped;
}

function applyLifecycleTransition(operation, nextState, event, diagnostics, reason = '') {
  const normalized = trimString(nextState).toLowerCase();
  if (!normalized || normalized === operation.state) return true;
  if (TERMINAL_STATES.has(operation.state)) {
    addDiagnostic(
      diagnostics,
      operation,
      event,
      'ignored_terminal_transition',
      `${operation.state} -> ${normalized}${reason ? ` (${reason})` : ''}`,
    );
    return false;
  }
  operation.state = normalized;
  return true;
}

function replayIdentity(event) {
  const type = trimString(event?.type) || 'unknown';
  const sourceIdentity = trimString(event?.providerEventId || event?.sourceEventId);
  const discriminator = [
    type,
    readCorrelationKeys(event),
    trimString(event?.approvalId),
    trimString(event?.operationLifecycle),
    trimString(event?.operationStream),
    trimString(event?.filePath),
  ];
  if (sourceIdentity) {
    return JSON.stringify([readRunScope(event), 'source', sourceIdentity, ...discriminator]);
  }
  const seq = eventSeq(event);
  if (!(seq > 0)) return '';
  return JSON.stringify([
    readRunScope(event),
    'durable',
    seq,
    ...discriminator,
    trimString(event?.toolName),
    boundedIdentityText(event?.toolInput),
    boundedIdentityText(serializeProviderToolValue(event?.output || event?.bodyPreview)),
    trimString(event?.decision || event?.status),
    Number.isFinite(Number(event?.exitCode)) ? Number(event.exitCode) : null,
  ]);
}

function updateTerminalMetadata(operation, event) {
  const durationMs = Number(event?.durationMs);
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    operation.durationMs = durationMs;
  }
  const exitCode = Number(event?.exitCode);
  if (Number.isFinite(exitCode)) operation.exitCode = exitCode;
  if (TERMINAL_STATES.has(operation.state)) {
    operation.completedAt = eventTimestamp(event) || operation.updatedAt || operation.startedAt;
    if (!Number.isFinite(operation.durationMs) && operation.startedAt && operation.completedAt) {
      operation.durationMs = Math.max(0, operation.completedAt - operation.startedAt);
    }
  }
}

function splitOutputLines(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return [];
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return normalized ? normalized.split('\n') : [];
}

function buildOutputPreview(output, { bodyAvailable = false, bodySeq = null } = {}) {
  const lines = splitOutputLines(output);
  if (lines.length === 0 && !bodyAvailable) return null;
  const headCount = 2;
  const tailCount = 4;
  const head = lines.slice(0, headCount).map((line) => redactSensitiveText(line));
  const tailStart = Math.max(head.length, lines.length - tailCount);
  const tail = lines.slice(tailStart).map((line) => redactSensitiveText(line));
  const omittedLines = Math.max(0, lines.length - head.length - tail.length);
  return {
    head,
    tail,
    totalLines: lines.length,
    omittedLines,
    bodyAvailable: bodyAvailable || omittedLines > 0,
    ...(Number.isInteger(bodySeq) && bodySeq > 0 ? { bodySeq } : {}),
  };
}

function setOperationOutput(operation, value) {
  const text = typeof value === 'string' ? value : '';
  const retained = text.length <= MAX_OPERATION_OUTPUT_CHARS
    ? text
    : text.slice(-MAX_OPERATION_OUTPUT_CHARS);
  operation._outputChunks = retained ? [retained] : [];
  operation._outputChars = retained.length;
  operation._output = retained;
  operation._outputDroppedLines = text.length <= MAX_OPERATION_OUTPUT_CHARS
    ? 0
    : (text.slice(0, text.length - MAX_OPERATION_OUTPUT_CHARS).match(/\n/g) || []).length;
}

function appendOperationOutput(operation, value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return;
  const chunks = Array.isArray(operation._outputChunks) ? operation._outputChunks : [];
  chunks.push(text);
  // A long-lived tool can emit one tiny frame at a time.  Retaining every
  // frame as its own array entry makes both the array and its later join grow
  // with event count instead of the bounded output budget.  Periodically fold
  // the older half into one chunk; output order and the byte cap are unchanged.
  if (chunks.length > MAX_OPERATION_OUTPUT_CHUNKS) {
    const foldCount = Math.max(1, chunks.length - Math.floor(MAX_OPERATION_OUTPUT_CHUNKS / 2));
    chunks.splice(0, foldCount, chunks.slice(0, foldCount).join(''));
  }
  operation._outputChunks = chunks;
  operation._outputChars = (operation._outputChars || 0) + text.length;
  while (operation._outputChars > MAX_OPERATION_OUTPUT_CHARS && chunks.length > 0) {
    const excess = operation._outputChars - MAX_OPERATION_OUTPUT_CHARS;
    const first = chunks[0] || '';
    if (first.length <= excess) {
      chunks.shift();
      operation._outputChars -= first.length;
      operation._outputDroppedLines = (operation._outputDroppedLines || 0)
        + (first.match(/\n/g) || []).length;
    } else {
      chunks[0] = first.slice(excess);
      operation._outputChars -= excess;
      operation._outputDroppedLines = (operation._outputDroppedLines || 0)
        + (first.slice(0, excess).match(/\n/g) || []).length;
    }
  }
}

function currentOperationOutput(operation) {
  if (Array.isArray(operation?._outputChunks)) {
    operation._output = operation._outputChunks.join('');
  }
  return operation?._output || '';
}

function addFileChange(operation, event) {
  const filePath = trimString(event?.filePath);
  if (!filePath) return;
  const change = {
    filePath: redactSensitiveText(filePath),
    changeType: trimString(event?.changeType) || 'update',
    ...(Number.isFinite(Number(event?.added)) ? { added: Number(event.added) } : {}),
    ...(Number.isFinite(Number(event?.removed)) ? { removed: Number(event.removed) } : {}),
  };
  const existingIndex = operation.fileChanges.findIndex((candidate) => candidate.filePath === filePath);
  if (existingIndex >= 0) operation.fileChanges[existingIndex] = change;
  else if (operation.fileChanges.length < MAX_OPERATION_FILE_CHANGES) operation.fileChanges.push(change);
  if (!operation.locations.includes(change.filePath) && operation.locations.length < MAX_OPERATION_LOCATIONS) {
    operation.locations.push(change.filePath);
  }
  if (!operation.detail) operation.detail = change.filePath;
}

function clientUpdatedAt(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toDisplayOperation(operation) {
  const toolCall = buildCanonicalToolCall(operation);
  const presentation = formatToolCall(toolCall, operation);
  return {
    type: 'operation',
    id: operation.id,
    operationId: operation.operationId,
    ...(toolCall.toolCallId ? { toolCallId: toolCall.toolCallId } : {}),
    toolCall,
    presentation,
    seq: operation.startSeq,
    startSeq: operation.startSeq,
    endSeq: operation.endSeq,
    timestamp: operation.timestamp,
    // Keep numeric clocks internal; typed event clients consume an ISO string.
    updatedAt: clientUpdatedAt(operation.updatedAt),
    ...(operation.runId ? { runId: operation.runId } : {}),
    kind: operation.kind,
    state: operation.state,
    title: operation.title || getOperationTitle(operation.kind),
    ...(operation.detail ? { detail: operation.detail } : {}),
    ...(operation.command ? { command: operation.command } : {}),
    ...(operation.action ? { action: operation.action } : {}),
    ...(operation.cwd ? { cwd: operation.cwd } : {}),
    ...(operation.executionPlatform ? { executionPlatform: operation.executionPlatform } : {}),
    ...(operation.shellKind ? { shellKind: operation.shellKind } : {}),
    ...(operation.startedAt ? { startedAt: operation.startedAt } : {}),
    ...(operation.completedAt ? { completedAt: operation.completedAt } : {}),
    ...(Number.isFinite(operation.durationMs) ? { durationMs: operation.durationMs } : {}),
    ...(Number.isFinite(operation.exitCode) ? { exitCode: operation.exitCode } : {}),
    ...(operation.outputPreview ? { outputPreview: operation.outputPreview } : {}),
    ...(operation.fileChanges.length > 0 ? { fileChanges: operation.fileChanges } : {}),
    ...(operation.approvalId ? { approvalId: operation.approvalId } : {}),
    ...(operation._diagnostics.length > 0 ? { diagnostics: operation._diagnostics } : {}),
    canInterrupt: operation.canInterrupt,
    canSteer: operation.canSteer,
  };
}

export function buildOperationProjection(events = [], options = {}) {
  const operations = [];
  const operationByCorrelationKey = new Map();
  const operationByApprovalId = new Map();
  const sourceSeqs = new Set();
  const processedEventKeys = new Set();
  const diagnostics = [];

  function registerOperation(operation) {
    operations.push(operation);
    for (const key of operation._correlationKeys) operationByCorrelationKey.set(key, operation);
    return operation;
  }

  function registerCorrelationKeys(operation, keys, event) {
    for (const key of keys) {
      const existing = operationByCorrelationKey.get(key);
      if (existing && existing !== operation) {
        addDiagnostic(diagnostics, operation, event, 'correlation_conflict');
        continue;
      }
      operation._correlationKeys.add(key);
      operationByCorrelationKey.set(key, operation);
    }
  }

  function resolveOperation(event, { fallbackKind = '', create = true } = {}) {
    const correlationKeys = readCorrelationKeys(event);
    const matches = correlationKeys
      .map((key) => operationByCorrelationKey.get(key))
      .filter(Boolean);
    let operation = matches[0] || null;
    if (!operation && correlationKeys.length === 0) {
      operation = findFallbackOperation(operations, event, { kind: fallbackKind });
    }
    if (!operation && create) {
      const orphan = event?.type !== 'tool_use';
      operation = registerOperation(createOperation(event, correlationKeys, { orphan }));
      if (orphan) addDiagnostic(diagnostics, operation, event, 'orphan_operation', 'missing tool_use start');
    }
    if (operation) registerCorrelationKeys(operation, correlationKeys, event);
    return operation;
  }

  const replayEvents = (Array.isArray(events) ? events : [])
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftSeq = eventSeq(left.event);
      const rightSeq = eventSeq(right.event);
      if (leftSeq > 0 && rightSeq > 0 && leftSeq !== rightSeq) return leftSeq - rightSeq;
      if (leftSeq > 0 && rightSeq === 0) return -1;
      if (leftSeq === 0 && rightSeq > 0) return 1;
      return left.index - right.index;
    });
  const replayPositionByEvent = new Map(replayEvents.map(({ event }, position) => [event, position]));

  const approvalResponsesById = new Map();
  for (const { event } of replayEvents) {
    if (event?.type !== 'approval_response') continue;
    const approvalId = trimString(event.approvalId);
    if (approvalId) approvalResponsesById.set(approvalId, {
      event,
      position: replayPositionByEvent.get(event) || 0,
    });
  }

  function applyApprovalResponse(operation, event) {
    if (!operation || !event) return;
    updateOperationBoundary(operation, event);
    const decision = trimString(event.decision || event.status).toLowerCase();
    const nextState = ['denied', 'declined'].includes(decision)
      ? 'declined'
      : (['cancelled', 'canceled'].includes(decision) ? 'interrupted' : 'running');
    applyLifecycleTransition(operation, nextState, event, diagnostics, 'approval_response');
    updateTerminalMetadata(operation, event);
  }

  for (const { event } of replayEvents) {
    if (!(event && typeof event === 'object')) continue;
    const seq = eventSeq(event);
    const replayKey = replayIdentity(event);
    if (replayKey && processedEventKeys.has(replayKey)) {
      addDiagnostic(diagnostics, null, event, 'duplicate_event_ignored');
      continue;
    }
    if (replayKey) processedEventKeys.add(replayKey);

    if (event.type === 'tool_use') {
      const operation = resolveOperation(event);
      if (!operation) continue;
      updateOperationIdentity(operation, event);
      updateOperationBoundary(operation, event);
      updateOperationClassification(operation, event);
      const nextState = lifecycleState(event, 'running');
      applyLifecycleTransition(operation, nextState, event, diagnostics, 'tool_use');
      updateTerminalMetadata(operation, event);
      if (seq > 0) sourceSeqs.add(seq);
      continue;
    }

    if (event.type === 'tool_result') {
      const operation = resolveOperation(event);
      if (!operation) continue;
      updateOperationIdentity(operation, event);
      updateOperationBoundary(operation, event);
      updateOperationClassification(operation, event);
      const output = event.output !== undefined && event.output !== null
        ? serializeProviderToolValue(event.output)
        : (typeof event.bodyPreview === 'string' ? event.bodyPreview : '');
      if (event.bodyAvailable === true && seq > 0) {
        operation._outputBodyAvailable = true;
        operation._outputBodySeq = seq;
      }
      const nextState = isDeltaEvent(event) ? 'running' : terminalStateForResult(event);
      const accepted = applyLifecycleTransition(operation, nextState, event, diagnostics, 'tool_result');
      if (isDeltaEvent(event)) {
        if (accepted) appendOperationOutput(operation, output);
      } else if (output) {
        setOperationOutput(operation, output);
      }
      // Rebuilding a preview for every high-frequency delta is itself a hot
      // O(n²) path once output is large.  Keep the bounded output buffer live,
      // but refresh the derived preview periodically and always on terminal
      // events.
      operation._outputDeltaCount = (operation._outputDeltaCount || 0) + 1;
      if (!isDeltaEvent(event)
        || !operation.outputPreview
        || operation._outputDeltaCount % OPERATION_OUTPUT_PREVIEW_INTERVAL === 0) {
        operation.outputPreview = buildOutputPreview(currentOperationOutput(operation), {
          bodyAvailable: operation._outputBodyAvailable || (operation._outputDroppedLines || 0) > 0,
          bodySeq: operation._outputBodySeq,
        });
        if (operation._outputDroppedLines > 0 && operation.outputPreview) {
          operation.outputPreview.totalLines += operation._outputDroppedLines;
          operation.outputPreview.omittedLines += operation._outputDroppedLines;
        }
      }
      updateTerminalMetadata(operation, event);
      if (seq > 0) sourceSeqs.add(seq);
      continue;
    }

    if (event.type === 'file_change') {
      const operation = resolveOperation(event, { fallbackKind: 'file_edit' });
      if (!operation) continue;
      updateOperationIdentity(operation, event);
      updateOperationBoundary(operation, event);
      updateOperationClassification(operation, event);
      const nextState = lifecycleState(event, isDeltaEvent(event) ? 'running' : 'completed');
      const accepted = applyLifecycleTransition(operation, nextState, event, diagnostics, 'file_change');
      if (accepted) addFileChange(operation, event);
      updateTerminalMetadata(operation, event);
      if (seq > 0) sourceSeqs.add(seq);
      continue;
    }

    if (event.type === 'approval_request') {
      const operation = resolveOperation(event, {
        fallbackKind: trimString(event.kind).toLowerCase() === 'command' ? 'command' : '',
        create: false,
      });
      if (!operation) continue;
      updateOperationBoundary(operation, event);
      operation.approvalId = trimString(event.approvalId);
      if (operation.approvalId) operationByApprovalId.set(operation.approvalId, operation);
      const response = operation.approvalId ? approvalResponsesById.get(operation.approvalId) : null;
      const requestPosition = replayPositionByEvent.get(event) || 0;
      if (response && response.position < requestPosition) applyApprovalResponse(operation, response.event);
      else applyLifecycleTransition(operation, 'waiting_approval', event, diagnostics, 'approval_request');
      continue;
    }

    if (event.type === 'approval_response') {
      const approvalId = trimString(event.approvalId);
      const operation = (approvalId ? operationByApprovalId.get(approvalId) : null)
        || resolveOperation(event, { create: false });
      if (!operation) continue;
      if (approvalId) {
        operation.approvalId ||= approvalId;
        operationByApprovalId.set(approvalId, operation);
      }
      applyApprovalResponse(operation, event);
    }
  }

  for (const operation of operations) {
    if (!TERMINAL_STATES.has(operation.state) && operation.state !== 'waiting_approval') {
      addDiagnostic(diagnostics, operation, {}, 'missing_terminal_event');
    }
  }

  const displayOperations = annotateActionGroups(operations
    .filter((operation) => operation.startSeq > 0)
    .sort((left, right) => left.startSeq - right.startSeq)
    .map((operation) => toDisplayOperation(operation)));
  const operationsByStartSeq = new Map();
  for (const operation of displayOperations) {
    const existing = operationsByStartSeq.get(operation.startSeq) || [];
    existing.push(operation);
    operationsByStartSeq.set(operation.startSeq, existing);
  }

  const unclassifiedOperations = displayOperations.filter((operation) => (
    operation.kind === 'other'
    && !trimString(operation?.presentation?.actionKind)
  )).length;
  const missingSubjectOperations = displayOperations.filter((operation) => (
    !trimString(operation?.presentation?.subject)
    && !['think', 'switch_mode'].includes(trimString(operation?.presentation?.labelKind))
  )).length;
  const countDiagnostic = (code) => diagnostics.filter((diagnostic) => diagnostic.code === code).length;
  const quality = {
    totalOperations: displayOperations.length,
    classifiedOperations: displayOperations.length - unclassifiedOperations,
    unclassifiedOperations,
    missingSubjectOperations,
    orphanOperations: countDiagnostic('orphan_operation'),
    missingTerminalOperations: countDiagnostic('missing_terminal_event'),
    lifecycleRegressions: countDiagnostic('ignored_terminal_transition'),
    classificationRate: displayOperations.length > 0
      ? (displayOperations.length - unclassifiedOperations) / displayOperations.length
      : 1,
  };

  return {
    operations: displayOperations,
    operationsByStartSeq,
    sourceSeqs,
    diagnostics,
    quality,
  };
}

export function isRawOperationEvent(event) {
  return RAW_OPERATION_TYPES.has(event?.type);
}
