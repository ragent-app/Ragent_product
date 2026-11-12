import { randomBytes } from 'crypto';
import {
  getContextHead,
  getHistorySnapshot,
  loadMeta,
  readEventsPage,
  readEventBody,
  readLastTurnEvents,
  setContextHead,
} from './history.mjs';
import {
  contextOperationEvent,
  messageEvent,
  normalizeFileChangeType,
  statusEvent,
} from './normalizer.mjs';
import { buildTemplateFreshnessNotice } from './session-continuation.mjs';
import { formatAttachmentContextLine, getMessageAttachments } from './attachment-utils.mjs';
import { updateRun } from './runs.mjs';
import { readLatestCodexSessionMetrics } from './codex-session-metrics.mjs';
import { formatPlanContextEvent } from './plan-context-format.mjs';
import { clipCompactionSection } from './session-context-compaction.mjs';
import { extractTaggedBlock } from './session-text-parsing.mjs';
import { findLatestAssistantMessageForRun } from './session-assistant-followups.mjs';
import { extractCriticalFacts } from './session-pre-compact-extraction.mjs';

export const INTERNAL_SESSION_ROLE_CONTEXT_COMPACTOR = 'context_compactor';

const AUTO_COMPACT_MARKER_TEXT = 'Older messages above this marker are no longer in the model\'s current context. They remain visible in the transcript, but only the compressed handoff and newer messages below are loaded for continued work.';
const CONTEXT_COMPACTOR_SYSTEM_PROMPT = [
  'You are Ragent\'s hidden context compactor for a user-facing session.',
  'Your job is to condense older session context into a compact continuation package.',
  'Preserve the task objective, accepted decisions, constraints, completed work, current state, open questions, and next steps.',
  'Do not include raw tool dumps unless a tiny excerpt is essential.',
  'Be explicit about what is no longer in the current context and what the next worker should rely on.',
].join('\n');
// P0 (2026-07-31): Lower the default auto-compact trigger from 100% to 70% of
// the context window. Waiting until 100% lets sessions drift to the absolute
// edge of the window (every late turn runs near the limit and is expensive);
// triggering at 70% keeps a headroom buffer while the LLM compaction runs. The
// previous 100% default is restorable via AGENTOC_AUTO_COMPACT_WINDOW_PERCENT=100.
const DEFAULT_AUTO_COMPACT_CONTEXT_WINDOW_PERCENT = 70;

// P1 (2026-07-31): incremental compaction merges new events into the existing
// summary instead of re-summarizing everything. To bound format drift from
// repeated merges, every MAX_INCREMENTAL_MERGE_DEPTH-th compaction forces a full
// rewrite of the summary structure (still from [prior summary + new events],
// but with a regenerate-from-scratch instruction).
const MAX_INCREMENTAL_MERGE_DEPTH = 5;

// P2a (2026-08-01): Multi-level progressive context budget.
// Level 1 (50%): TOOL_TRIM — aggressive tool output clipping, zero API cost.
// Level 2 (70%): COMPACT — LLM incremental compaction (P0+P1).
// Level 3 (85%): EMERGENCY — clear resume IDs to force fresh provider context.
const TOOL_TRIM_CONTEXT_WINDOW_PERCENT = 50;
const EMERGENCY_CLEAR_CONTEXT_WINDOW_PERCENT = 85;

function getConfiguredToolTrimPercent() {
  const raw = String(process.env.AGENTOC_PROGRESSIVE_TOOL_TRIM_PERCENT || '').trim();
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

function getConfiguredEmergencyClearPercent() {
  const raw = String(process.env.AGENTOC_EMERGENCY_CLEAR_PERCENT || '').trim();
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

export const COMPACTION_LEVEL = Object.freeze({
  NONE: 0,
  TRIM_TOOLS: 1,    // 50%: aggressive tool output trimming, zero API calls
  COMPACT: 2,        // 70%: LLM incremental compaction
  EMERGENCY: 3,      // 85%: clear resume IDs + force fresh provider context
});

function parsePositiveIntOrInfinity(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  if (/^(inf|infinity)$/i.test(trimmed)) return Number.POSITIVE_INFINITY;
  const parsed = parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// P0: Allow overriding the window-percent trigger at runtime. Accepts 1-100.
function getConfiguredAutoCompactWindowPercent() {
  const raw = String(process.env.AGENTOC_AUTO_COMPACT_WINDOW_PERCENT || '').trim();
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

function getConfiguredAutoCompactContextTokens() {
  return parsePositiveIntOrInfinity(process.env.AGENTOC_CURRENT_CONTEXT_COMPACT_TOKENS);
}

function getRunCurrentContextTokens(run) {
  return Number.isInteger(run?.contextInputTokens) && run.contextInputTokens > 0
    ? run.contextInputTokens
    : null;
}

function getRunContextWindowTokens(run) {
  return Number.isInteger(run?.contextWindowTokens) && run.contextWindowTokens > 0
    ? run.contextWindowTokens
    : null;
}

function getAutoCompactContextTokens(run) {
  const configured = getConfiguredAutoCompactContextTokens();
  if (configured !== null) {
    return configured;
  }
  const contextWindowTokens = getRunContextWindowTokens(run);
  if (!Number.isInteger(contextWindowTokens)) {
    return Number.POSITIVE_INFINITY;
  }
  const percent = getConfiguredAutoCompactWindowPercent()
    ?? DEFAULT_AUTO_COMPACT_CONTEXT_WINDOW_PERCENT;
  return Math.max(
    1,
    Math.floor((contextWindowTokens * percent) / 100),
  );
}

export function shouldAutoCompactRun(run) {
  // codex app-server manages its own thread context natively via its
  // `remote_compaction_v2` / `auto_compact_token_limit` feature (stable, on by
  // default). Running AgentoC's separate compaction worker for those runs is
  // redundant (codex already compacts its thread) and was the OOM-adjacent path
  // (the worker re-loaded full history). Let codex handle it; AgentoC's
  // cross-tool handoff still works via the bounded history branch.
  // Kill-switch: AGENTOC_CODEX_NATIVE_COMPACT=0|off.
  const codexNativeCompact = run?.runtimeFamily === 'codex-app-server-json'
    && !/^(0|false|no|off)$/i.test(String(process.env.AGENTOC_CODEX_NATIVE_COMPACT ?? 'on').trim());
  if (codexNativeCompact) {
    return false;
  }
  const contextTokens = getRunCurrentContextTokens(run);
  const autoCompactTokens = getAutoCompactContextTokens(run);
  return Number.isInteger(contextTokens)
    && Number.isFinite(autoCompactTokens)
    && contextTokens > autoCompactTokens;
}

export function getProgressiveCompactionLevel(run) {
  // codex app-server manages its own thread context natively via
  // `remote_compaction_v2` / `auto_compact_token_limit`.
  const codexNativeCompact = run?.runtimeFamily === 'codex-app-server-json'
    && !/^(0|false|no|off)$/i.test(String(process.env.AGENTOC_CODEX_NATIVE_COMPACT ?? 'on').trim());
  if (codexNativeCompact) {
    return COMPACTION_LEVEL.NONE;
  }

  const contextTokens = getRunCurrentContextTokens(run);
  const contextWindowTokens = getRunContextWindowTokens(run);
  if (!Number.isInteger(contextTokens) || !Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    return COMPACTION_LEVEL.NONE;
  }

  const usagePercent = (contextTokens / contextWindowTokens) * 100;

  const emergencyPercent = getConfiguredEmergencyClearPercent() ?? EMERGENCY_CLEAR_CONTEXT_WINDOW_PERCENT;
  if (usagePercent >= emergencyPercent) {
    return COMPACTION_LEVEL.EMERGENCY;
  }
  const compactPercent = getConfiguredAutoCompactWindowPercent() ?? DEFAULT_AUTO_COMPACT_CONTEXT_WINDOW_PERCENT;
  if (usagePercent >= compactPercent) {
    return COMPACTION_LEVEL.COMPACT;
  }
  const trimPercent = getConfiguredToolTrimPercent() ?? TOOL_TRIM_CONTEXT_WINDOW_PERCENT;
  if (usagePercent >= trimPercent) {
    return COMPACTION_LEVEL.TRIM_TOOLS;
  }
  return COMPACTION_LEVEL.NONE;
}

async function refreshCodexContextMetrics(run) {
  if (!run?.id || !run?.codexThreadId) return null;
  const metrics = await readLatestCodexSessionMetrics(run.codexThreadId);
  if (!Number.isInteger(metrics?.contextTokens)) return null;

  await updateRun(run.id, (current) => ({
    ...current,
    contextInputTokens: metrics.contextTokens,
    ...(Number.isInteger(metrics.contextWindowTokens)
      ? { contextWindowTokens: metrics.contextWindowTokens }
      : {}),
  }));

  return metrics;
}

function getAutoCompactStatusText(run) {
  const configured = getConfiguredAutoCompactContextTokens();
  const contextTokens = getRunCurrentContextTokens(run);
  const contextWindowTokens = getRunContextWindowTokens(run);
  if (configured === null && Number.isInteger(contextTokens) && Number.isInteger(contextWindowTokens)) {
    const percent = ((contextTokens / contextWindowTokens) * 100).toFixed(1);
    return `Current context exceeded the model window (${contextTokens.toLocaleString()} / ${contextWindowTokens.toLocaleString()}, ${percent}%) — compacting conversation…`;
  }
  const autoCompactTokens = getAutoCompactContextTokens(run);
  if (Number.isFinite(autoCompactTokens)) {
    return `Current context exceeded ${autoCompactTokens.toLocaleString()} tokens — compacting conversation…`;
  }
  return 'Current context overflowed — compacting conversation…';
}

function trimCompactionReason(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return '';
  return normalized.replace(/[.。…\s]+$/u, '');
}

function getCompactionTriggerReason(run, { automatic = false } = {}) {
  if (!automatic) return 'Manual context compaction was requested';
  return trimCompactionReason(getAutoCompactStatusText(run));
}

function buildQueuedCompactionOperation(sessionId, compactorSessionId, compactionSource, run, { automatic = false } = {}) {
  return contextOperationEvent({
    operation: 'compact_context',
    phase: 'queued',
    trigger: automatic ? 'automatic' : 'manual',
    title: automatic ? 'Auto Compress queued' : 'Context compaction queued',
    summary: 'Ragent started condensing older context into a continuation handoff.',
    reason: getCompactionTriggerReason(run, { automatic }),
    targetSessionId: sessionId,
    workerSessionId: compactorSessionId,
    compactedThroughSeq: Number.isInteger(compactionSource?.targetSeq) ? compactionSource.targetSeq : 0,
    hadExistingSummary: !!String(compactionSource?.existingSummary || '').trim(),
  });
}

function buildFailedCompactionOperation(sessionId, errorMessage, { automatic = false, workerSessionId = '' } = {}) {
  return contextOperationEvent({
    operation: 'compact_context',
    phase: 'failed',
    trigger: automatic ? 'automatic' : 'manual',
    title: automatic ? 'Auto Compress failed' : 'Context compaction failed',
    summary: 'Ragent could not replace older context with a continuation handoff.',
    reason: errorMessage,
    targetSessionId: sessionId,
    ...(workerSessionId ? { workerSessionId } : {}),
  });
}

function buildAppliedCompactionOperation(targetSessionId, run, manifest, summary) {
  const automatic = manifest?.compactionReason === 'automatic';
  return contextOperationEvent({
    operation: 'compact_context',
    phase: 'applied',
    trigger: automatic ? 'automatic' : 'manual',
    title: automatic ? 'Current context compacted' : 'Context compaction applied',
    summary: 'Older context was replaced with a continuation summary and handoff.',
    reason: getCompactionTriggerReason(run, { automatic }),
    targetSessionId,
    workerSessionId: run?.sessionId || '',
    compactedThroughSeq: Number.isInteger(manifest?.compactionSourceSeq) ? manifest.compactionSourceSeq : 0,
    summaryChars: typeof summary === 'string' ? summary.length : 0,
  });
}

function parseCompactionWorkerOutput(content) {
  return {
    summary: extractTaggedBlock(content, 'summary'),
    handoff: extractTaggedBlock(content, 'handoff'),
  };
}

function buildFallbackCompactionHandoff(summary, toolIndex) {
  const parts = [
    '# Auto Compress',
    '',
    '## Kept in current context',
    '- Ragent carried forward a compressed continuation summary for the task.',
  ];

  const trimmedSummary = clipCompactionSection(summary, 3000);
  if (trimmedSummary) {
    parts.push('', trimmedSummary);
  }

  parts.push('', '## Left out of current context', '- Older messages above the marker are no longer loaded into the model\'s current context.');
  if (toolIndex) {
    parts.push('- Earlier tool activity remains in session history and is summarized as compact retrieval hints.');
  }
  parts.push('', '## Continue from here', '- Use the carried-forward summary plus the new messages below this marker.');
  return parts.join('\n');
}

export function buildContextCompactionPrompt({
  session,
  existingSummary,
  conversationBody,
  toolIndex,
  automatic = false,
  mergeMode = false,
  forceRewrite = false,
  protectedFacts = [],
} = {}) {
  const appInstructions = clipCompactionSection(session?.systemPrompt || '', 6000);
  const priorSummary = clipCompactionSection(existingSummary || '', 12000);
  const conversationSlice = clipCompactionSection(conversationBody || '', 18000);
  const toolActivity = clipCompactionSection(toolIndex || '', 10000);

  // P1: when there is already a carried summary, run an incremental MERGE instead
  // of a full replace — the compactor only needs to fold the new slice into the
  // existing summary, which keeps its prompt (and thus its token cost) bounded by
  // the delta, not the whole session. forceRewrite (every MAX_INCREMENTAL_MERGE_DEPTH
  // compactions) keeps the merge instruction but asks for a clean structural
  // rewrite to reset accumulated format drift.
  const isIncremental = mergeMode && Boolean(priorSummary && priorSummary !== '[none]');

  const goalLines = isIncremental
    ? (forceRewrite
      ? [
          'Goal (periodic rewrite — this is a scheduled full-rewrite compaction to correct drift):',
          '- Regenerate the continuation summary from scratch as a clean, well-structured package.',
          '- Synthesize BOTH the existing summary below AND the new conversation slice.',
          '- Drop stale facts, merge conflicting information toward the latest state, and rebuild section structure cleanly.',
        ]
      : [
          'Goal (incremental merge):',
          '- Merge the new conversation slice below INTO the existing continuation summary.',
          '- The existing summary is authoritative — preserve every fact that still holds.',
          '- Add new decisions, findings, state changes, and constraints from the slice.',
          '- Update or remove facts that the new slice supersedes.',
          '- Keep the same dense operational format as the existing summary.',
        ])
    : [
        'Goal:',
        '- Replace older context with a fresh continuation package.',
        '- Preserve only what the next worker turn truly needs.',
        '- Treat older tool activity as retrievable hints, not as currently loaded prompt material.',
      ];

  return [
    'You are operating inside Ragent\'s hidden compaction worker for a parent session.',
    `Compaction trigger: ${automatic ? 'automatic auto-compress' : 'manual compact request'}`,
    '',
    ...goalLines,
    '',
    'Rules:',
    '- Use only the supplied session material; do not rely on prior thread state.',
    '- Do not call tools unless absolutely necessary.',
    '- Do not include full raw tool output.',
    '- Mark uncertainty clearly.',
    '- The user-visible handoff must explicitly say that older messages above the marker are no longer in the current context.',
    '',
    'Return exactly two tagged blocks:',
    '<summary>',
    isIncremental
      ? (forceRewrite
        ? 'A freshly regenerated dense operational continuation state synthesizing the existing summary and the new slice.'
        : 'The existing summary updated with the new slice — merged, not regenerated from scratch.')
      : 'Dense operational continuation state for the next worker turn.',
    'Always include: main objective, confirmed constraints, completed work, current code/system state, open questions, next steps, and critical references.',
    '</summary>',
    '',
    '<handoff>',
    '# Auto Compress',
    '## Kept in current context',
    '- ...',
    '## Left out of current context',
    '- ...',
    '## Continue from here',
    '- ...',
    '</handoff>',
    '',
    'Parent session app instructions:',
    appInstructions || '[none]',
    '',
    isIncremental ? 'Existing continuation summary (merge the new slice into this):' : 'Previously carried summary:',
    priorSummary || '[none]',
    '',
    isIncremental ? 'New conversation slice since the last compaction:' : 'New conversation slice since the last compaction:',
    conversationSlice || '[no new conversation messages]',
    '',
    'Earlier tool activity index:',
    toolActivity || '[no earlier tool activity recorded]',
    ...(protectedFacts.length > 0
      ? ['', 'Protected durable facts (must survive compaction verbatim):', ...protectedFacts.map((f) => `- ${f}`)]
      : []),
  ].join('\n');
}

function normalizeCompactionText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function clipCompactionEventText(value, maxChars = 4000) {
  const text = normalizeCompactionText(value);
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}\n[... truncated by Ragent ...]\n${text.slice(-tailChars).trimStart()}`;
}

function formatCompactionAttachments(images) {
  return formatAttachmentContextLine(images);
}

function formatCompactionMessage(event) {
  const label = event.role === 'user' ? 'User' : 'Assistant';
  const parts = [];
  const imageLine = formatCompactionAttachments(getMessageAttachments(event));
  if (imageLine) parts.push(imageLine);
  const content = clipCompactionEventText(event.content);
  if (content) parts.push(content);
  if (parts.length === 0) return '';
  return `[${label}]\n${parts.join('\n')}`;
}

function formatCompactionTemplateContext(event) {
  const content = normalizeCompactionText(event.content);
  if (!content) return '';
  const name = normalizeCompactionText(event.templateName) || 'template';
  const freshnessNotice = buildTemplateFreshnessNotice(event);
  return freshnessNotice
    ? `[Applied template context: ${name}]\n${freshnessNotice}\n\n${content}`
    : `[Applied template context: ${name}]\n${content}`;
}

function formatCompactionStatus(event) {
  const content = clipCompactionEventText(event.content, 1000);
  if (!content) return '';
  if (!/^error:/i.test(content) && !/interrupted/i.test(content)) return '';
  return `[System status]\n${content}`;
}

export function prepareConversationOnlyContinuationBody(events) {
  const segments = (events || [])
    .map((event) => {
      if (!event || !event.type) return '';
      if (event.type === 'message') return formatCompactionMessage(event);
      if (event.type === 'template_context') return formatCompactionTemplateContext(event);
      if (event.type === 'plan') return formatPlanContextEvent(event);
      if (event.type === 'status') return formatCompactionStatus(event);
      return '';
    })
    .filter(Boolean);

  if (segments.length === 0) return '';
  return clipCompactionSection(segments.join('\n\n'), 24000);
}

const MAX_COMPACTION_HISTORY_EVENTS = Math.max(
  512,
  Number.parseInt(process.env.AGENTOC_MAX_COMPACTION_HISTORY_EVENTS || '8192', 10) || 8192,
);
const MAX_COMPACTION_HEAD_EVENTS = 64;
const MAX_COMPACTION_BODY_HYDRATIONS = 256;
const MAX_COMPACTION_TOTAL_BODY_BYTES = 4 * 1024 * 1024;
const MAX_COMPACTION_BODY_BYTES = 32 * 1024;

async function loadCompactionHistory(sessionId, { fromSeq = 1, toSeq = 0 } = {}) {
  // Keep a representative head (the first user goal and early constraints)
  // plus a bounded tail.  The compaction prompt is itself clipped to a small
  // byte budget, so retaining 100K raw events here only adds GC pressure and
  // delays the compactor without improving the prompt.
  const meta = await loadMeta(sessionId);
  const rangeStart = Number.isInteger(fromSeq) && fromSeq > 0 ? fromSeq : 1;
  const rangeEnd = Number.isInteger(toSeq) && toSeq > 0
    ? Math.min(toSeq, meta.latestSeq || 0)
    : (meta.latestSeq || 0);
  if (rangeEnd < rangeStart) return [];

  const head = [];
  const tailCapacity = Math.max(1, MAX_COMPACTION_HISTORY_EVENTS - MAX_COMPACTION_HEAD_EVENTS);
  const headEnd = Math.min(rangeEnd, rangeStart + MAX_COMPACTION_HEAD_EVENTS - 1);
  const tailStart = Math.max(rangeStart, rangeEnd - tailCapacity + 1);
  const readWindow = async (startSeq, endSeq) => {
    if (endSeq < startSeq) return [];
    const page = await readEventsPage(sessionId, {
      afterSeq: Math.max(0, startSeq - 1),
      direction: 'after',
      includeBodies: false,
      limit: endSeq - startSeq + 1,
    });
    return (page.events || []).filter((event) => (
      Number.isInteger(event?.seq) && event.seq >= startSeq && event.seq <= endSeq
    ));
  };
  // The compactor only retains a small representative head and tail. Reading
  // those sequence windows directly avoids an O(total-events) cold scan for
  // sessions with hundreds of thousands of provider/tool events.
  const [headEvents, tailEvents] = await Promise.all([
    readWindow(rangeStart, headEnd),
    tailStart > headEnd ? readWindow(tailStart, rangeEnd) : Promise.resolve([]),
  ]);
  const seen = new Set();
  const history = [];
  for (const event of [...headEvents, ...tailEvents]) {
    if (!event || seen.has(event.seq)) continue;
    seen.add(event.seq);
    history.push(event);
  }
  // Compaction's conversation section consumes message/template text only;
  // never hydrate tool/reasoning/result bodies. Hydrate only a bounded number
  // of message/template bodies in small parallel batches.
  const candidates = history.filter((event) => event
    && ['message', 'template_context'].includes(event.type)
    && event.bodyLoaded === false && event.bodyAvailable && event.bodyField);
  let remainingBodyBytes = MAX_COMPACTION_TOTAL_BODY_BYTES;
  for (let offset = 0;
    offset < candidates.length && offset < MAX_COMPACTION_BODY_HYDRATIONS && remainingBodyBytes > 0;
    offset += 8) {
    const batch = candidates.slice(
      offset,
      offset + Math.min(8, Math.ceil(remainingBodyBytes / MAX_COMPACTION_BODY_BYTES)),
    );
    const bodyBudgets = batch.map(() => {
      const budget = Math.min(MAX_COMPACTION_BODY_BYTES, remainingBodyBytes);
      remainingBodyBytes -= budget;
      return budget;
    });
    await Promise.all(batch.map(async (event, index) => {
      const body = await readEventBody(sessionId, event.seq, { maxBytes: bodyBudgets[index] }).catch(() => null);
      if (body?.field && typeof body.value === 'string') {
        event[body.field] = clipCompactionEventText(body.value, 32_000);
        event.bodyLoaded = true;
      }
    }));
  }
  return history;
}

function buildToolActivityIndex(events) {
  const toolCounts = new Map();
  const recentCommands = [];
  const touchedFiles = [];
  const notableFailures = [];

  const pushRecentUnique = (entries, key, value, maxEntries) => {
    if (!key || !value) return;
    const existingIndex = entries.findIndex((entry) => entry.key === key);
    if (existingIndex !== -1) {
      entries.splice(existingIndex, 1);
    }
    entries.push({ key, value });
    if (entries.length > maxEntries) {
      entries.shift();
    }
  };

  for (const event of events || []) {
    if (!event || !event.type) continue;
    if (event.type === 'tool_use') {
      const toolName = normalizeCompactionText(event.toolName) || 'tool';
      toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
      const toolInput = clipCompactionEventText(event.toolInput, 240);
      if (toolInput) {
        pushRecentUnique(recentCommands, `${toolName}:${toolInput}`, `- ${toolName}: ${toolInput.replace(/\n/g, ' ↵ ')}`, 8);
      }
      continue;
    }
    if (event.type === 'file_change') {
      const filePath = normalizeCompactionText(event.filePath);
      if (!filePath) continue;
      const changeType = normalizeFileChangeType(event.changeType) || 'update';
      pushRecentUnique(touchedFiles, `${changeType}:${filePath}`, `- ${filePath} (${changeType})`, 12);
      continue;
    }
    if (event.type === 'tool_result') {
      const exitCode = event.exitCode;
      if (exitCode === undefined || exitCode === 0) continue;
      const toolName = normalizeCompactionText(event.toolName) || 'tool';
      const output = clipCompactionEventText(event.output, 320);
      pushRecentUnique(notableFailures, `${toolName}:${exitCode}:${output}`, `- ${toolName} exit ${exitCode}: ${output.replace(/\n/g, ' ↵ ')}`, 6);
    }
  }

  const toolSummary = [...toolCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([toolName, count]) => `${toolName} ×${count}`)
    .join(', ');

  const lines = [];
  if (toolSummary) lines.push(`Tools used: ${toolSummary}`);
  if (recentCommands.length > 0) {
    lines.push('Recent tool calls:');
    lines.push(...recentCommands.map((entry) => entry.value));
  }
  if (touchedFiles.length > 0) {
    lines.push('Touched files:');
    lines.push(...touchedFiles.map((entry) => entry.value));
  }
  if (notableFailures.length > 0) {
    lines.push('Notable tool failures:');
    lines.push(...notableFailures.map((entry) => entry.value));
  }

  if (lines.length === 0) return '';
  return clipCompactionSection(lines.join('\n'), 12000);
}

function createContextBarrierEvent(content, extra = {}) {
  return {
    type: 'context_barrier',
    role: 'system',
    id: `evt_${randomBytes(8).toString('hex')}`,
    timestamp: Date.now(),
    content,
    ...extra,
  };
}

async function buildCompactionSourcePayload(sessionId, { uptoSeq = 0 } = {}) {
  const contextHead = await getContextHead(sessionId);
  const existingSummary = typeof contextHead?.summary === 'string' ? contextHead.summary.trim() : '';
  const activeFromSeq = Number.isInteger(contextHead?.activeFromSeq) ? contextHead.activeFromSeq : 0;
  const compactionCount = Number.isInteger(contextHead?.compactionCount) && contextHead.compactionCount > 0
    ? contextHead.compactionCount
    : 0;

  // P1: when a carried summary already exists, load only the events produced
  // SINCE the last compaction point (activeFromSeq) instead of replaying the
  // whole transcript. This bounds the compactor prompt by the delta rather than
  // by total session length. First-ever compaction (no summary) still loads from
  // seq 1. The tool activity index keeps using whatever window we loaded.
  const incremental = Boolean(existingSummary) && activeFromSeq > 0;
  const loadFromSeq = incremental ? Math.max(1, activeFromSeq + 1) : 1;
  const history = await loadCompactionHistory(sessionId, { fromSeq: loadFromSeq });

  const targetSeq = uptoSeq > 0 ? uptoSeq : (history.at(-1)?.seq || 0);
  const boundedHistory = history.filter((event) => (event?.seq || 0) <= targetSeq);
  const sliceEvents = incremental
    ? boundedHistory
    : boundedHistory.filter((event) => (event?.seq || 0) > activeFromSeq);
  const conversationBody = prepareConversationOnlyContinuationBody(sliceEvents);
  const toolIndex = buildToolActivityIndex(boundedHistory);

  if (!existingSummary && !conversationBody && !toolIndex) {
    return null;
  }

  // P1 drift mitigation: every MAX_INCREMENTAL_MERGE_DEPTH-th incremental
  // compaction asks for a full structural rewrite instead of a patch merge.
  const mergeMode = incremental;
  const forceRewrite = mergeMode && compactionCount > 0 && compactionCount % MAX_INCREMENTAL_MERGE_DEPTH === 0;

  return {
    targetSeq,
    existingSummary,
    conversationBody,
    toolIndex,
    mergeMode,
    forceRewrite,
    compactionCount,
  };
}

async function ensureContextCompactorSession(sourceSessionId, session, run, services = {}) {
  const existingId = typeof session?.compactionSessionId === 'string' ? session.compactionSessionId.trim() : '';
  if (existingId) {
    const existing = await services.getSession(existingId);
    if (existing) {
      if ((run?.tool || session.tool) && existing.tool !== (run?.tool || session.tool)) {
        await services.mutateSessionMeta(existing.id, (draft) => {
          draft.tool = run?.tool || session.tool;
          draft.updatedAt = services.nowIso();
          return true;
        });
      }
      return existing;
    }
  }

  const metas = await services.loadSessionsMeta();
  const linked = metas.find((meta) => meta.compactsSessionId === sourceSessionId && services.isContextCompactorSession(meta));
  if (linked) {
    await services.mutateSessionMeta(sourceSessionId, (draft) => {
      if (draft.compactionSessionId === linked.id) return false;
      draft.compactionSessionId = linked.id;
      draft.updatedAt = services.nowIso();
      return true;
    });
    return services.enrichSessionMeta(linked);
  }

  const created = await services.createSession(session.folder, run?.tool || session.tool, `auto-compress - ${session.name || 'session'}`, {
    sourceId: session.sourceId || '',
    sourceName: session.sourceName || '',
    systemPrompt: CONTEXT_COMPACTOR_SYSTEM_PROMPT,
    internalRole: INTERNAL_SESSION_ROLE_CONTEXT_COMPACTOR,
    compactsSessionId: sourceSessionId,
    rootSessionId: session.rootSessionId || session.id,
  });
  if (!created) return null;

  await services.mutateSessionMeta(sourceSessionId, (draft) => {
    if (draft.compactionSessionId === created.id) return false;
    draft.compactionSessionId = created.id;
    draft.updatedAt = services.nowIso();
    return true;
  });

  return created;
}

export async function queueContextCompaction(sessionId, session, run, { automatic = false } = {}, services = {}) {
  const runtimeState = services.ensureSessionRuntimeState(sessionId);
  if (runtimeState.pendingCompact) return false;

  // P2b: Extract critical facts before compaction (automatic only, kill-switchable).
  // Facts are persisted into the task-card memory and injected into the compactor
  // prompt as protected facts the worker must preserve.
  let protectedFacts = [];
  if (automatic && !/^(0|false|no|off)$/i.test(String(process.env.AGENTOC_PRE_COMPACT_EXTRACTION ?? '1').trim())) {
    try {
      const lastTurnEvents = await readLastTurnEvents(sessionId, { includeBodies: false });
      const facts = await extractCriticalFacts({ session, lastTurnEvents });
      if (facts.length > 0) {
        // Write extracted facts to task-card memory
        await services.mutateSessionMeta(sessionId, (draft) => {
          const currentCard = draft.taskCard || {};
          const existingMemory = Array.isArray(currentCard.memory) ? currentCard.memory : [];
          const merged = [...existingMemory];
          for (const fact of facts) {
            if (!merged.some((m) => m.toLowerCase() === fact.toLowerCase())) {
              merged.push(fact);
            }
          }
          // Cap at 8 entries, drop oldest
          if (merged.length > 8) {
            merged.splice(0, merged.length - 8);
          }
          draft.taskCard = { ...currentCard, memory: merged };
          draft.updatedAt = services.nowIso();
          return true;
        });
        protectedFacts = [...(Array.isArray(session?.taskCard?.memory) ? session.taskCard.memory : []), ...facts]
          .slice(-8); // same cap as the persisted copy
      }
    } catch (error) {
      console.error(`[pre-compact-extraction] Failed for ${(sessionId || '').slice(0, 8)}: ${error.message}`);
      // Extraction failure never blocks compaction
    }
  }

  const snapshot = await getHistorySnapshot(sessionId);
  const compactionSource = await buildCompactionSourcePayload(sessionId, {
    uptoSeq: snapshot.latestSeq,
  });
  if (!compactionSource) return false;

  const compactorSession = await ensureContextCompactorSession(sessionId, session, run, services);
  if (!compactorSession) return false;

  runtimeState.pendingCompact = true;

  const statusText = automatic
    ? getAutoCompactStatusText(run)
    : 'Auto Compress is condensing older context…';
  const compactQueuedEvent = statusEvent(statusText);
  await services.appendEvent(sessionId, compactQueuedEvent);
  await services.appendEvent(sessionId, buildQueuedCompactionOperation(
    sessionId,
    compactorSession.id,
    compactionSource,
    run,
    { automatic },
  ));
  services.broadcastSessionInvalidation(sessionId);

  try {
    await services.sendMessage(compactorSession.id, buildContextCompactionPrompt({
      session,
      existingSummary: compactionSource.existingSummary,
      conversationBody: compactionSource.conversationBody,
      toolIndex: compactionSource.toolIndex,
      automatic,
      mergeMode: compactionSource.mergeMode === true,
      forceRewrite: compactionSource.forceRewrite === true,
      protectedFacts,
    }), [], {
      tool: run?.tool || session.tool,
      model: run?.model || undefined,
      effort: run?.effort || undefined,
      thinking: false,
      recordUserMessage: false,
      queueIfBusy: false,
      freshThread: true,
      skipSessionContinuation: true,
      internalOperation: 'context_compaction_worker',
      compactionTargetSessionId: sessionId,
      compactionSourceSeq: compactionSource.targetSeq,
      compactionToolIndex: compactionSource.toolIndex,
      compactionReason: automatic ? 'automatic' : 'manual',
    });
    return true;
  } catch (error) {
    runtimeState.pendingCompact = false;
    const failure = statusEvent(`error: failed to compact context: ${error.message}`);
    await services.appendEvent(sessionId, failure);
    await services.appendEvent(sessionId, buildFailedCompactionOperation(sessionId, error.message, {
      automatic,
      workerSessionId: compactorSession.id,
    }));
    services.broadcastSessionInvalidation(sessionId);
    return false;
  }
}

async function applyToolOutputTrimPolicy(sessionId, services) {
  const runtimeState = services.ensureSessionRuntimeState(sessionId);
  if (runtimeState.toolOutputTrimActive) return false;
  runtimeState.toolOutputTrimActive = true;
  const event = statusEvent('Context window at 50% — Ragent is trimming older tool outputs to conserve tokens.');
  await services.appendEvent(sessionId, event);
  services.broadcastSessionInvalidation(sessionId);
  return true;
}

async function applyEmergencyContextClear(sessionId, services) {
  const event = statusEvent('Context window at 85% — Ragent is clearing provider context to prevent overflow.');
  await services.appendEvent(sessionId, event);
  await services.clearPersistedResumeIds(sessionId);
  services.broadcastSessionInvalidation(sessionId);
  return true;
}

export async function maybeApplyContextBudget(sessionId, session, run, manifest, services = {}) {
  if (!session || !run) return false;
  if (manifest?.internalOperation && manifest.internalOperation !== 'reply_self_repair') return false;
  if (services.getSessionQueueCount(session) > 0) return false;

  let effectiveRun = run;
  // Refresh codex context metrics if current tokens are unavailable
  if (!Number.isInteger(getRunCurrentContextTokens(run)) || !Number.isInteger(getRunContextWindowTokens(run))) {
    const refreshed = await refreshCodexContextMetrics(run);
    if (refreshed) {
      effectiveRun = {
        ...run,
        contextInputTokens: refreshed.contextTokens,
        ...(Number.isInteger(refreshed.contextWindowTokens)
          ? { contextWindowTokens: refreshed.contextWindowTokens }
          : {}),
      };
    }
  }

  const level = getProgressiveCompactionLevel(effectiveRun);

  switch (level) {
    case COMPACTION_LEVEL.TRIM_TOOLS:
      return applyToolOutputTrimPolicy(sessionId, services);
    case COMPACTION_LEVEL.COMPACT:
      // The level is inclusive for progressive status/reporting, while the
      // actual automatic action remains strictly-over-threshold.
      return shouldAutoCompactRun(effectiveRun)
        ? queueContextCompaction(sessionId, session, effectiveRun, { automatic: true }, services)
        : false;
    case COMPACTION_LEVEL.EMERGENCY:
      return applyEmergencyContextClear(sessionId, services);
    default:
      return false;
  }
}

export async function applyCompactionWorkerResult(targetSessionId, run, manifest, services = {}) {
  const workerEvent = await findLatestAssistantMessageForRun(run.sessionId, run.id);
  const parsed = parseCompactionWorkerOutput(workerEvent?.content || '');
  const summary = parsed.summary;
  if (!summary) {
    await services.appendEvent(targetSessionId, statusEvent('error: failed to apply auto compress: compaction worker returned no <summary> block'));
    await services.appendEvent(targetSessionId, buildFailedCompactionOperation(
      targetSessionId,
      'Compaction worker returned no <summary> block',
      {
        automatic: manifest?.compactionReason === 'automatic',
        workerSessionId: run?.sessionId || '',
      },
    ));
    return false;
  }

  const barrierEvent = await services.appendEvent(targetSessionId, createContextBarrierEvent(AUTO_COMPACT_MARKER_TEXT, {
    automatic: manifest?.compactionReason === 'automatic',
    compactionSessionId: run.sessionId,
  }));
  const handoffContent = parsed.handoff || buildFallbackCompactionHandoff(summary, manifest?.compactionToolIndex || '');
  const handoffEvent = await services.appendEvent(targetSessionId, messageEvent('assistant', handoffContent, undefined, {
    source: 'context_compaction_handoff',
    compactionRunId: run.id,
  }));
  await services.appendEvent(targetSessionId, buildAppliedCompactionOperation(targetSessionId, run, manifest, summary));
  const compactEvent = await services.appendEvent(targetSessionId, statusEvent('Auto Compress finished — continue from the handoff below'));

  // P1: bump the monotonic compaction count so the next compaction can decide
  // between an incremental merge and a periodic full rewrite.
  const priorContextHead = await getContextHead(targetSessionId);
  const priorCompactionCount = Number.isInteger(priorContextHead?.compactionCount) && priorContextHead.compactionCount > 0
    ? priorContextHead.compactionCount
    : 0;

  await setContextHead(targetSessionId, {
    mode: 'summary',
    summary,
    toolIndex: manifest?.compactionToolIndex || '',
    activeFromSeq: compactEvent.seq,
    compactedThroughSeq: Number.isInteger(manifest?.compactionSourceSeq) ? manifest.compactionSourceSeq : compactEvent.seq,
    inputTokens: run.contextInputTokens || null,
    updatedAt: services.nowIso(),
    source: 'context_compaction',
    barrierSeq: barrierEvent.seq,
    handoffSeq: handoffEvent.seq,
    compactionSessionId: run.sessionId,
    compactionCount: priorCompactionCount + 1,
  });

  await services.clearPersistedResumeIds(targetSessionId);
  return true;
}
