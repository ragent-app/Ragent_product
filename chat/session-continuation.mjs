import { formatAttachmentContextLine } from './attachment-utils.mjs';
import { normalizeFileChangeType } from './normalizer.mjs';
import { formatPlanContextEvent } from './plan-context-format.mjs';

const MAX_EVENT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 24000;
const TRUNCATED_MARKER = '\n[... truncated by Ragent ...]\n';

// Mirrors AGENT_MESSAGE_PROMPT_KEY in session-manager.mjs. Defined locally to
// avoid a reverse import cycle. Historical per-message prompt events must never
// leak into fallback continuation context as Assistant text.
const AGENT_MESSAGE_PROMPT_KEY = 'agent.perMessageSystemPrompt';

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function formatTemplateSourceLabel(evt) {
  const sourceSessionName = normalizeText(evt?.sourceSessionName);
  if (sourceSessionName) return `session "${sourceSessionName}"`;
  const sourceSessionId = normalizeText(evt?.sourceSessionId);
  if (sourceSessionId) return `session ${sourceSessionId}`;
  return 'its source session';
}

export function buildTemplateFreshnessNotice(evt) {
  const freshness = normalizeText(evt?.templateFreshness).toLowerCase();
  if (!freshness) return '';

  const templateUpdatedAt = normalizeText(evt?.templateUpdatedAt);
  const currentSourceUpdatedAt = normalizeText(evt?.currentSourceUpdatedAt || evt?.sourceSessionUpdatedAt);
  const sourceLabel = formatTemplateSourceLabel(evt);

  if (freshness === 'stale') {
    const snapshotLine = templateUpdatedAt
      ? `This snapshot was saved at ${templateUpdatedAt}.`
      : 'This snapshot was saved earlier.';
    const sourceLine = currentSourceUpdatedAt
      ? `The source session changed again at ${currentSourceUpdatedAt}.`
      : 'The source session changed again after the snapshot was saved.';
    return [
      '[Template freshness warning]',
      `${snapshotLine} ${sourceLine} Treat the template from ${sourceLabel} as historical bootstrap context only. Re-read current files and notes before making changes.`,
    ].join('\n');
  }

  if (freshness === 'source_missing') {
    const snapshotLine = templateUpdatedAt
      ? `The last saved snapshot was captured at ${templateUpdatedAt}.`
      : 'The last saved snapshot time is unknown.';
    return [
      '[Template source unavailable]',
      `${snapshotLine} The original source session is no longer available, so verify current files and notes before making changes.`,
    ].join('\n');
  }

  return '';
}

function clipText(value, maxChars = MAX_EVENT_CHARS) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}${TRUNCATED_MARKER}${text.slice(-tailChars).trimStart()}`;
}

function truncateMiddle(text, maxChars = MAX_CONTEXT_CHARS) {
  if (!text || text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.35));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}${TRUNCATED_MARKER}${text.slice(-tailChars).trimStart()}`;
}

function formatImages(images) {
  return formatAttachmentContextLine(images);
}

function formatMessage(evt) {
  const label = evt.role === 'user' ? 'User' : 'Assistant';
  const parts = [];
  const imageLine = formatImages(evt.images);
  if (imageLine) parts.push(imageLine);
  const content = clipText(evt.content);
  if (content) parts.push(content);
  if (parts.length === 0) return '';
  return `[${label}]\n${parts.join('\n')}`;
}

function formatToolUse(evt) {
  const input = clipText(evt.toolInput, 2500);
  if (!input) return '';
  return `[Assistant tool call: ${evt.toolName || 'unknown'}]\n${input}`;
}

function formatToolResult(evt, { aggressive = false } = {}) {
  const maxChars = aggressive ? 800 : MAX_EVENT_CHARS;
  const output = clipText(evt.output, maxChars);
  if (!output) return '';
  const exitCode = evt.exitCode === undefined ? '' : `, exit ${evt.exitCode}`;
  return `[Tool result: ${evt.toolName || 'unknown'}${exitCode}]\n${output}`;
}

function formatFileChange(evt) {
  const filePath = normalizeText(evt.filePath);
  if (!filePath) return '';
  const changeType = normalizeFileChangeType(evt.changeType) || 'update';
  return `[File change: ${changeType}] ${filePath}`;
}

function formatStatus(evt) {
  const content = clipText(evt.content, 1000);
  if (!content) return '';
  if (!/^error:/i.test(content) && !/interrupted/i.test(content)) return '';
  return `[System status]\n${content}`;
}

function formatTemplateContext(evt) {
  const content = normalizeText(evt.content);
  if (!content) return '';
  const name = normalizeText(evt.templateName) || 'template';
  const freshnessNotice = buildTemplateFreshnessNotice(evt);
  return freshnessNotice
    ? `[Applied template context: ${name}]\n${freshnessNotice}\n\n${content}`
    : `[Applied template context: ${name}]\n${content}`;
}

function formatContinuationEvent(evt) {
  if (!evt || !evt.type) return '';
  if (evt.type === 'message' && evt.role === 'system'
      && evt.systemPromptKey === AGENT_MESSAGE_PROMPT_KEY) {
    return '';
  }
  switch (evt.type) {
    case 'message':
      return formatMessage(evt);
    case 'template_context':
      return formatTemplateContext(evt);
    case 'plan':
      return formatPlanContextEvent(evt);
    case 'tool_use':
      return formatToolUse(evt);
    case 'tool_result':
      return formatToolResult(evt);
    case 'file_change':
      return formatFileChange(evt);
    case 'status':
      return formatStatus(evt);
    default:
      return '';
  }
}

function buildContinuationIntro(options = {}) {
  const fromTool = options.fromTool || '';
  const toTool = options.toTool || '';
  const switchedTools = fromTool && toTool && fromTool !== toTool;
  return switchedTools
    ? `Ragent session continuity handoff: the user switched tools from ${fromTool} to ${toTool}.`
    : 'Ragent session continuity handoff for this existing conversation.';
}

export function prepareSessionContinuationBody(events) {
  const segments = (events || [])
    .map(formatContinuationEvent)
    .filter(Boolean);

  if (segments.length === 0) return '';

  return truncateMiddle(segments.join('\n\n'));
}

export function buildSessionContinuationContextFromBody(body, options = {}) {
  const normalizedBody = normalizeText(body);
  if (!normalizedBody) return '';

  return [
    buildContinuationIntro(options),
    'Below is the prior session state reconstructed from Ragent\'s normalized history.',
    'Treat it as the authoritative context for continuing this same session.',
    '',
    normalizedBody,
  ].join('\n');
}

export function buildSessionContinuationContext(events, options = {}) {
  return buildSessionContinuationContextFromBody(
    prepareSessionContinuationBody(events),
    options,
  );
}
