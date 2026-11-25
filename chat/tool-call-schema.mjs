/**
 * Stable ACP v1 ToolCall projection.
 *
 * Only ACP fields are emitted at the top level. Ragent lifecycle facts live
 * under `_meta.ragent`; display-only data is built separately by
 * tool-call-formatters.mjs. Raw provider input/output never enters this
 * projection.
 */

export const STABLE_TOOL_CALL_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'completed',
  'failed',
]);

export const STABLE_TOOL_CALL_KINDS = Object.freeze([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

const STABLE_KIND_SET = new Set(STABLE_TOOL_CALL_KINDS);
const SENSITIVE_KEY = /(?:authorization|api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|token)/i;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function redactAssignment(match, name, separator = '=') {
  return `${name}${separator}[redacted]`;
}

export function redactSensitiveText(value) {
  return String(value || '')
    // JSON / object-like quoted secrets, including Authorization values.
    .replace(
      /(["'])([^"'\r\n]*(?:authorization|api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|token)[^"'\r\n]*)\1\s*:\s*(["'])(?:\\.|(?!\3).)*\3/gi,
      (_match, quote, key, valueQuote) => `${quote}${key}${quote}:${valueQuote}[redacted]${valueQuote}`,
    )
    // Header and free-form bearer credentials, including quoted bearer values.
    .replace(
      /\b(authorization\s*[:=]\s*["']?\s*bearer|bearer)\s+[^\s'";]+/gi,
      '$1 [redacted]',
    )
    // Environment-style assignments such as OPENAI_API_KEY=... .
    .replace(
      /\b([a-z_][a-z0-9_]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|token))\b\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      (match, name) => redactAssignment(match, name),
    )
    // CLI flags in both --token=value and --token value forms.
    .replace(
      /(--[a-z0-9_-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|token))\s*(=|\s)\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      (_match, name, separator) => redactAssignment(_match, name, separator === '=' ? '=' : ' '),
    );
}

/** Recursively redact a provider-derived value without retaining raw secrets. */
export function redactSensitiveValue(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[redacted]' : redactSensitiveValue(item, depth + 1),
  ]));
}

export function normalizeToolCallKind(value) {
  const normalized = trimString(value).toLowerCase();
  switch (normalized) {
    case 'command': return 'execute';
    case 'file_edit': return 'edit';
    case 'web': return 'fetch';
    default: return STABLE_KIND_SET.has(normalized) ? normalized : 'other';
  }
}

/** Collapse the richer Ragent lifecycle to the four stable ACP statuses. */
export function stableToolCallStatus(lifecycle) {
  const state = trimString(lifecycle).toLowerCase();
  if (['completed', 'success', 'succeeded'].includes(state)) return 'completed';
  if (['failed', 'error', 'declined', 'denied', 'interrupted', 'cancelled', 'canceled'].includes(state)) {
    return 'failed';
  }
  if (['running', 'started', 'in_progress', 'inprogress', 'delta'].includes(state)) return 'in_progress';
  return 'pending';
}

function defaultTitle(kind) {
  switch (kind) {
    case 'read': return 'Reading';
    case 'edit': return 'Editing';
    case 'delete': return 'Deleting';
    case 'move': return 'Moving';
    case 'search': return 'Searching';
    case 'execute': return 'Running command';
    case 'think': return 'Thinking';
    case 'fetch': return 'Fetching';
    case 'switch_mode': return 'Switching mode';
    default: return 'Using tool';
  }
}

function normalizeLocation(candidate) {
  if (typeof candidate === 'string') {
    const path = redactSensitiveText(candidate.trim());
    return path ? { path } : null;
  }
  if (!candidate || typeof candidate !== 'object') return null;
  const path = redactSensitiveText(trimString(candidate.path));
  if (!path) return null;
  const line = Number(candidate.line);
  return {
    path,
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
  };
}

function uniqueLocations(operation) {
  const locations = [];
  const seen = new Set();
  const add = (candidate) => {
    const location = normalizeLocation(candidate);
    if (!location) return;
    const key = `${location.path}:${location.line || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push(location);
  };
  for (const location of Array.isArray(operation?.locations) ? operation.locations : []) add(location);
  for (const change of Array.isArray(operation?.fileChanges) ? operation.fileChanges : []) add(change?.filePath);
  const input = operation?.input && typeof operation.input === 'object' ? operation.input : {};
  const kind = normalizeToolCallKind(operation?.kind);
  if (['read', 'edit', 'delete'].includes(kind)) add(operation?.detail);
  add(input.path || input.file_path || input.notebook_path || '');
  if (kind === 'move') {
    add(input.from || input.source || input.oldPath || '');
    add(input.to || input.destination || input.newPath || '');
  }
  return locations;
}

function stableContent(operation) {
  if (!Array.isArray(operation?.content) || operation.content.length === 0) return [];
  return redactSensitiveValue(operation.content);
}

function ragentMeta(operation) {
  const meta = {
    schemaVersion: 1,
    lifecycle: trimString(operation.state) || 'pending',
    ...(['search', 'open', 'find', 'mixed', 'generic'].includes(operation.webAction) ? { webAction: operation.webAction } : {}),
    ...(['running', 'waiting_approval'].includes(operation.state) && trimString(operation.operationProgress) ? { operationProgress: redactSensitiveText(operation.operationProgress) } : {}),
    ...(trimString(operation.approvalId) ? { approval: { approvalId: trimString(operation.approvalId) } } : {}),
    ...(Number.isInteger(operation.startSeq) && operation.startSeq > 0 ? { startSeq: operation.startSeq } : {}),
    ...(Number.isInteger(operation.endSeq) && operation.endSeq > 0 ? { endSeq: operation.endSeq } : {}),
    ...(Number.isFinite(operation.durationMs) ? { durationMs: operation.durationMs } : {}),
    ...(Number.isFinite(operation.exitCode) ? { exitCode: operation.exitCode } : {}),
  };
  return { ragent: meta };
}

/**
 * Build a strict stable ACP v1 ToolCall plus the explicitly namespaced
 * Ragent metadata extension. Display input/output belongs in a separate
 * presentation envelope.
 */
export function buildCanonicalToolCall(operation = {}) {
  const toolCallId = trimString(operation.toolCallId || operation.operationId || operation.id);
  if (!toolCallId) throw new TypeError('Canonical ToolCall requires toolCallId');
  const kind = normalizeToolCallKind(operation.kind);
  const title = redactSensitiveText(trimString(operation.title) || defaultTitle(kind));
  const locations = uniqueLocations(operation);
  const content = stableContent(operation);
  return {
    toolCallId,
    title,
    kind,
    status: stableToolCallStatus(operation.state),
    ...(content.length > 0 ? { content } : {}),
    ...(locations.length > 0 ? { locations } : {}),
    _meta: ragentMeta(operation),
  };
}
