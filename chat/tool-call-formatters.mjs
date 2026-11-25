import {
  normalizeToolCallKind,
  redactSensitiveText,
  redactSensitiveValue,
} from './tool-call-schema.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clip(value, maxLength = 80) {
  const normalized = redactSensitiveText(trimString(value)).replace(/\s+/g, ' ');
  if (!normalized || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function baseName(value) {
  const normalized = trimString(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized ? normalized.slice(normalized.lastIndexOf('/') + 1) : '';
}

function firstString(...values) {
  for (const value of values) {
    const text = trimString(value);
    if (text) return text;
  }
  return '';
}

function commandIsComposite(command) {
  return /(?:&&|\|\||(?<!\\);|(?<!\\)\|)/.test(command);
}

function hostAndPath(value) {
  const source = trimString(value);
  if (!source) return '';
  try {
    const url = new URL(source);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return clip(source, 80).replace(/^https?:\/\//i, '');
  }
}

function locationPaths(toolCall) {
  return (Array.isArray(toolCall?.locations) ? toolCall.locations : [])
    .map((location) => (typeof location === 'string' ? location : location?.path))
    .map(trimString)
    .filter(Boolean);
}

function safeOutputPreview(preview) {
  if (!preview || typeof preview !== 'object') return null;
  const head = Array.isArray(preview.head) ? preview.head.map((line) => redactSensitiveText(line)) : [];
  const tail = Array.isArray(preview.tail) ? preview.tail.map((line) => redactSensitiveText(line)) : [];
  if (head.length === 0 && tail.length === 0 && preview.bodyAvailable !== true) return null;
  return {
    head,
    tail,
    totalLines: Number.isInteger(preview.totalLines) ? preview.totalLines : head.length + tail.length,
    omittedLines: Number.isInteger(preview.omittedLines) ? preview.omittedLines : 0,
    bodyAvailable: preview.bodyAvailable === true,
    ...(Number.isInteger(preview.bodySeq) && preview.bodySeq > 0 ? { bodySeq: preview.bodySeq } : {}),
  };
}

function safeFileChanges(changes) {
  return (Array.isArray(changes) ? changes : [])
    .map((change) => ({
      filePath: redactSensitiveText(trimString(change?.filePath)),
      changeType: trimString(change?.changeType) || 'update',
      ...(Number.isFinite(Number(change?.added)) ? { added: Number(change.added) } : {}),
      ...(Number.isFinite(Number(change?.removed)) ? { removed: Number(change.removed) } : {}),
    }))
    .filter((change) => change.filePath);
}

/**
 * Build deterministic, language-neutral display data from a stable ToolCall
 * and already-normalized projection source. The source is defensively
 * redacted again and is never copied into the canonical ToolCall.
 */
export function formatToolCall(toolCall = {}, source = {}) {
  const kind = normalizeToolCallKind(toolCall.kind);
  const action = source?.action && typeof source.action === 'object' ? source.action : null;
  const input = source?.input && typeof source.input === 'object'
    ? redactSensitiveValue(source.input)
    : {};
  const locations = locationPaths(toolCall);
  const detailPath = firstString(input.path, input.file_path, input.notebook_path, locations[0]);
  let formatted;

  // The action parser is the provider-neutral equivalent of Codex's
  // ParsedCommand/ExecCell presentation layer. Keep the canonical ACP kind
  // stable while allowing the UI to use a semantic display label.
  if (action && (action.subject || action.semanticKind)) {
    const semanticKind = trimString(action.semanticKind).toLowerCase();
    const labelKind = [
      'read', 'list', 'search', 'inspect', 'edit', 'execute', 'mcp', 'subagent',
      'task_create', 'task_update', 'task_read', 'task_list', 'task_stop',
      'message', 'wait', 'question', 'approval', 'web', 'fetch',
      'click', 'input', 'scroll', 'capture', 'generate', 'switch_mode',
    ].includes(semanticKind)
      ? semanticKind
      : kind;
    const command = firstString(source.command, input.command, input.cmd, input.script, source.detail);
    formatted = {
      kind,
      labelKind,
      subject: clip(action.subject || semanticKind, 80),
      detail: clip(action.detail || command || source.detail, 320),
      actionKind: semanticKind,
      ...(action.confidence ? { actionConfidence: action.confidence } : {}),
      ...(action.groupable === true ? { groupable: true } : {}),
      ...(action.executionPlatform ? { executionPlatform: action.executionPlatform } : {}),
      ...(action.shellKind ? { shellKind: action.shellKind } : {}),
    };
  }

  if (!formatted && ['read', 'edit', 'delete'].includes(kind)) {
    formatted = { kind, labelKind: kind, subject: clip(baseName(detailPath) || detailPath, 80), detail: detailPath };
  } else if (!formatted && kind === 'search') {
    const subject = firstString(input.pattern, input.query, input.glob, input.needle, input.text, source.detail);
    formatted = { kind, labelKind: kind, subject: clip(subject, 80), detail: clip(subject, 320) };
  } else if (!formatted && kind === 'execute') {
    const command = firstString(input.command, input.cmd, input.script, input.text, source.command, source.detail);
    formatted = commandIsComposite(command)
      ? { kind, labelKind: 'execute_composite', subject: '', detail: clip(command, 320) }
      : { kind, labelKind: kind, subject: clip(command, 80), detail: clip(command, 320) };
  } else if (!formatted && kind === 'move') {
    const from = firstString(input.from, input.source, input.oldPath, locations[0]);
    const to = firstString(input.to, input.destination, input.newPath, locations[1]);
    const subject = from && to ? `${baseName(from) || from} → ${baseName(to) || to}` : firstString(from, to);
    formatted = { kind, labelKind: kind, subject: clip(subject, 80), detail: clip(subject, 320) };
  } else if (!formatted && kind === 'fetch') {
    const target = firstString(input.url, input.query, input.text, source.detail);
    formatted = { kind, labelKind: kind, subject: clip(hostAndPath(target), 80), detail: clip(target, 320) };
  } else if (!formatted && kind === 'switch_mode') {
    const mode = firstString(input.mode, input.name, source.detail);
    formatted = { kind, labelKind: kind, subject: clip(mode, 80), detail: clip(mode, 320) };
  } else if (!formatted && kind === 'think') {
    formatted = { kind, labelKind: kind, subject: '', detail: '' };
  } else if (!formatted) {
    const toolName = firstString(source.toolName, input.toolName, toolCall.title);
    formatted = { kind: 'other', labelKind: 'other', subject: clip(toolName, 80), detail: clip(source.detail || toolName, 320) };
  }

  return {
    schemaVersion: 1,
    ...formatted,
    ...(source.activityDescription ? {
      activityDescription: source.activityDescription,
      activityDescriptionSource: source.activityDescriptionSource,
      ...(source.activityDescriptionSeq ? { activityDescriptionSeq: source.activityDescriptionSeq } : {}),
    } : {}),
    ...(safeOutputPreview(source.outputPreview) ? { outputPreview: safeOutputPreview(source.outputPreview) } : {}),
    ...(safeFileChanges(source.fileChanges).length > 0 ? { fileChanges: safeFileChanges(source.fileChanges) } : {}),
  };
}
