import {
  DEFAULT_SESSION_NAME,
  buildTemporarySessionName,
  isSessionAutoRenamePending,
  normalizeGeneratedSessionTitle,
  normalizeSessionDescription,
  normalizeSessionGroup,
} from './session-naming.mjs';
import { extractTaggedBlock, parseJsonObjectText } from './session-text-parsing.mjs';

export const SESSION_LABELS_CONTROL_KIND = 'session-labels';
export const SESSION_LABELS_CONTROL_TAG = 'ragent-session-labels';
export const SESSION_LABELS_SCHEMA_VERSION = 1;

const SESSION_TITLE_MAX_CHARS = 64;

export function claimPendingSessionTitleForRun(session, runId, firstUserText = '', timestamp = new Date().toISOString()) {
  if (!session || !runId || !isSessionAutoRenamePending(session)) return false;
  const draft = firstUserText ? buildTemporarySessionName(firstUserText) : '';
  const nextName = draft || session.name;
  if (session.titleAnchorRunId === runId && session.name === nextName) return false;
  session.name = nextName;
  session.titleSource = 'provisional';
  session.titleAnchorRunId = runId;
  session.titleUpdatedAt = timestamp;
  session.updatedAt = timestamp;
  return true;
}

function clipText(value, maxChars) {
  const normalized = typeof value === 'string'
    ? value.replace(/\s+/gu, ' ').trim()
    : '';
  if (!normalized) return '';
  const chars = Array.from(normalized);
  return chars.length > maxChars
    ? `${chars.slice(0, maxChars - 1).join('').trimEnd()}…`
    : normalized;
}

function normalizeAssistantTitle(value, group = '') {
  const clipped = clipText(value, SESSION_TITLE_MAX_CHARS);
  if (!clipped) return '';
  const title = normalizeGeneratedSessionTitle(clipped, group);
  if (!title || title.toLowerCase() === DEFAULT_SESSION_NAME) return '';
  return title;
}

export function normalizeAssistantSessionLabels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const group = normalizeSessionGroup(value.group || '');
  const title = normalizeAssistantTitle(value.title || '', group);
  const description = normalizeSessionDescription(value.description || '');
  if (!title && !group && !description) return null;
  return {
    schemaVersion: SESSION_LABELS_SCHEMA_VERSION,
    ...(title ? { title } : {}),
    ...(group ? { group } : {}),
    ...(description ? { description } : {}),
  };
}

export function applyAssistantSessionLabelsToSession(session, value, options = {}) {
  if (!session || typeof session !== 'object') return false;
  const labels = normalizeAssistantSessionLabels(value);
  if (!labels) return false;
  const runId = typeof options.runId === 'string' ? options.runId.trim() : '';
  const anchorRunId = typeof session.titleAnchorRunId === 'string'
    ? session.titleAnchorRunId.trim()
    : '';
  const timestamp = typeof options.now === 'string' && options.now.trim()
    ? options.now.trim()
    : new Date().toISOString();
  if (anchorRunId && runId && anchorRunId !== runId) return false;
  let changed = false;

  // Compare-and-set: automatic metadata may only replace a provisional title
  // owned by this Run. A user/connector rename or a newer Run always wins.
  const canApplyTitle = isSessionAutoRenamePending(session);
  if (labels.title && canApplyTitle) {
    const effectiveGroup = session.group || labels.group || '';
    const nextTitle = normalizeGeneratedSessionTitle(labels.title, effectiveGroup);
    if (nextTitle && (session.name !== nextTitle || session.autoRenamePending !== false)) {
      session.name = nextTitle;
      session.autoRenamePending = false;
      session.titleSource = 'assistant';
      session.titleUpdatedAt = timestamp;
      if (runId) session.titleAnchorRunId = runId;
      changed = true;
    }
  }

  // Never overwrite owner/connector grouping fields that landed during the
  // foreground Run.
  if (!normalizeSessionGroup(session.group || '') && labels.group) {
    session.group = labels.group;
    changed = true;
  }
  if (!normalizeSessionDescription(session.description || '') && labels.description) {
    session.description = labels.description;
    changed = true;
  }

  if (changed) session.updatedAt = timestamp;
  return changed;
}

export function parseSessionLabelsFromAssistantContent(content) {
  const payload = parseJsonObjectText(extractTaggedBlock(content, SESSION_LABELS_CONTROL_TAG));
  if (!payload) return null;
  const schemaVersion = Number(payload.schemaVersion ?? SESSION_LABELS_SCHEMA_VERSION);
  if (schemaVersion !== SESSION_LABELS_SCHEMA_VERSION) return null;
  return normalizeAssistantSessionLabels(payload);
}

export function buildSessionLabelsPromptBlock(session = {}, options = {}) {
  const needsTitle = isSessionAutoRenamePending(session);
  const needsGroup = !normalizeSessionGroup(session?.group || '');
  const needsDescription = !normalizeSessionDescription(session?.description || '');
  if (!needsTitle && !needsGroup && !needsDescription) return '';
  const knownGroups = [...new Set((Array.isArray(options.knownGroups) ? options.knownGroups : [])
    .map((group) => normalizeSessionGroup(group))
    .filter(Boolean))]
    .slice(0, 16);
  return [
    'Session presentation metadata (hidden protocol):',
    needsTitle
      ? 'This session still has a provisional title. Infer durable presentation labels from the user\'s actual task and the work performed in this turn.'
      : 'This session has a stable title but is missing grouping metadata. Infer durable presentation labels without trying to rename the session.',
    'At the very end of your final answer, append exactly one single-line block in this form:',
    `<${SESSION_LABELS_CONTROL_TAG}>{"schemaVersion":${SESSION_LABELS_SCHEMA_VERSION},"title":"...","group":"...","description":"..."}</${SESSION_LABELS_CONTROL_TAG}>`,
    'Rules:',
    '- Keep the visible answer complete and natural; never mention this metadata block.',
    '- Write labels in the user\'s language, determined by the current user message. For English requests, write the title, group, and description in English. If the message has no clear language, default to English. Internal examples, host locale, and earlier assistant replies must not select the language.',
    '- title: a specific, stable topic or intended outcome; roughly 6-20 CJK characters or 3-8 words; no generic labels such as New session, Help, Analysis, or Request; no progress/status wording.',
    '- group: a reusable project or work-area label, not a duplicate of the title.',
    ...(knownGroups.length > 0 ? [
      `- Existing reusable groups: ${knownGroups.map((group) => JSON.stringify(group)).join(', ')}. Prefer an existing group when it accurately fits; create a new one only for a genuinely different durable scope.`,
    ] : []),
    '- description: one concise sentence describing the durable scope, not the current completion status.',
    '- Emit valid JSON with no Markdown fence. Do not emit this block before the final answer.',
  ].join('\n');
}
