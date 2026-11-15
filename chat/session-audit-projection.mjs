import { createHash } from 'crypto';
import { join } from 'path';

import { isEnvToggleEnabled } from '../lib/env-toggle.mjs';
import { CHAT_HISTORY_DIR } from '../lib/config.mjs';
import { normalizeFileChangeType } from './normalizer.mjs';
import { readJson, writeJsonAtomic } from './fs-utils.mjs';

const SCHEMA_VERSION = 2;
const MAX_DIFF_PREVIEW_LINES = 80;
const MAX_DIFF_CELLS = Math.max(
  100_000,
  Number.parseInt(process.env.RAGENT_MAX_DIFF_CELLS || '1000000', 10) || 1_000_000,
);
const MAX_AUDIT_ARTIFACT_FILES = 2000;
const MAX_AUDIT_CHANGED_FILES = 1000;
const MAX_AUDIT_PROGRESS_PLANS = 500;
const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Perf (RAGENT_PERF_WRITE_DEBOUNCE=off / RAGENT_PERF_COMPACT_JSON=off):
// the projection file (up to ~1.4MB, pretty-printed) was rewritten wholesale
// on every appended event batch. Now the in-process value updates
// immediately and the disk write is debounced per session; the projection is
// derived, rebuildable data (scripts/rebuild-session-audit-projections.mjs),
// so a hard crash inside the window costs at most the last 750ms of derived
// rows — and the stale-rebuild path in updateSessionAuditProjectionForEvents
// already handles a lagging file after restart.
const RAGENT_PERF_WRITE_DEBOUNCE_ENV = 'RAGENT_PERF_WRITE_DEBOUNCE';
const PERF_WRITE_DEBOUNCE_ENABLED = isEnvToggleEnabled(process.env[RAGENT_PERF_WRITE_DEBOUNCE_ENV], { defaultValue: true });
const RAGENT_PERF_COMPACT_JSON_ENV = 'RAGENT_PERF_COMPACT_JSON';
const PERF_COMPACT_JSON_ENABLED = isEnvToggleEnabled(process.env[RAGENT_PERF_COMPACT_JSON_ENV], { defaultValue: true });
const PROJECTION_FLUSH_DELAY_MS = 750;
const COMPACT_JSON_OPTIONS = PERF_COMPACT_JSON_ENABLED ? { spaces: 0 } : {};
const PROJECTION_READ_CACHE_TTL_MS = 1_000;
const PROJECTION_READ_CACHE_MAX_ENTRIES = 32;

const pendingProjectionBySession = new Map(); // sessionId -> { projection, timer }
const projectionReadCache = new Map(); // sessionId -> { projection, cachedAt }

function setProjectionReadCache(sessionId, projection, cachedAt = Date.now()) {
  projectionReadCache.delete(sessionId);
  projectionReadCache.set(sessionId, { projection, cachedAt });
  while (projectionReadCache.size > PROJECTION_READ_CACHE_MAX_ENTRIES) {
    const oldest = projectionReadCache.keys().next().value;
    if (oldest === undefined) break;
    projectionReadCache.delete(oldest);
  }
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function eventSeq(event) {
  return Number.isInteger(event?.seq) && event.seq > 0 ? event.seq : 0;
}

function eventBoundarySeq(event) {
  if (Number.isInteger(event?.endSeq) && event.endSeq > 0) return event.endSeq;
  if (Number.isInteger(event?.blockEndSeq) && event.blockEndSeq > 0) return event.blockEndSeq;
  if (Number.isInteger(event?.mergedEndSeq) && event.mergedEndSeq > 0) return event.mergedEndSeq;
  return eventSeq(event);
}

function projectionPath(sessionId) {
  return join(CHAT_HISTORY_DIR, sessionId, 'audit-projection.json');
}

function stableHash(value) {
  return createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);
}

function isMarkdownMimeType(mimeType) {
  return /^text\/(?:x-)?markdown(?:[;\s]|$)/i.test(trim(mimeType));
}

function isMarkdownName(name) {
  return /\.(?:md|markdown|mdown|mkdn)$/i.test(trim(name));
}

function isPdfMimeType(mimeType) {
  return trim(mimeType).toLowerCase() === 'application/pdf';
}

function isPdfName(name) {
  return /\.pdf$/i.test(trim(name));
}

function attachmentName(attachment) {
  return trim(attachment?.originalName)
    || trim(attachment?.filename)
    || trim(attachment?.name)
    || trim(attachment?.title)
    || 'artifact';
}

function attachmentAssetId(attachment) {
  return trim(attachment?.assetId) || trim(attachment?.asset_id);
}

function attachmentUrl(attachment) {
  const explicit = trim(attachment?.url)
    || trim(attachment?.downloadUrl)
    || trim(attachment?.objectUrl)
    || trim(attachment?.src);
  if (explicit) return explicit;
  const assetId = attachmentAssetId(attachment);
  if (assetId) return `/api/assets/${encodeURIComponent(assetId)}/download`;
  const filename = trim(attachment?.filename);
  if (filename) return `/api/images/${encodeURIComponent(filename)}`;
  return '';
}

function artifactDownloadUrl(record) {
  const explicit = trim(record?.downloadUrl);
  if (explicit) return explicit;
  const source = trim(record?.url);
  if (!source) return '';
  if (
    /\/api\/assets\/[^/?#]+\/download(?:[?#]|$)|\/api\/images\//i.test(source)
    || /^share-asset\//i.test(source)
    || /\/share-asset\//i.test(source)
  ) {
    return `${source}${source.includes('?') ? '&' : '?'}download=1`;
  }
  return source;
}

export function getArtifactFileId(sessionId, event, attachment, index = 0) {
  const assetId = attachmentAssetId(attachment);
  if (assetId) return `artifact_asset_${assetId}`;
  const identity = [
    sessionId,
    eventSeq(event),
    trim(event?.id),
    trim(event?.messageId),
    trim(event?.role),
    attachmentName(attachment),
    trim(attachment?.mimeType),
    Number.isFinite(attachment?.sizeBytes) ? attachment.sizeBytes : '',
    trim(attachment?.url) || trim(attachment?.filename),
    index,
  ].join(':');
  return `artifact_${stableHash(identity)}`;
}

export function buildArtifactFileRecord(event, attachment, { sessionId = '', index = 0, order = 0 } = {}) {
  if (!(attachment && typeof attachment === 'object')) return null;
  const name = attachmentName(attachment);
  const url = attachmentUrl(attachment);
  if (!name && !url) return null;
  const assetId = attachmentAssetId(attachment);
  const mimeType = trim(attachment?.mimeType);
  const sizeBytes = Number.isFinite(attachment?.sizeBytes) ? attachment.sizeBytes : null;
  const record = {
    id: getArtifactFileId(sessionId, event, attachment, index),
    kind: 'file',
    sessionId,
    runId: trim(event?.runId),
    sourceRunId: trim(event?.runId),
    sourceSeq: eventSeq(event),
    sourceEventId: trim(event?.id),
    sourceMessageSeq: eventSeq(event),
    assetId,
    name,
    mimeType,
    sizeBytes,
    url,
    downloadUrl: trim(attachment?.downloadUrl),
    isMarkdown: isMarkdownMimeType(mimeType) || isMarkdownName(name),
    isPdf: isPdfMimeType(mimeType) || isPdfName(name),
    sourceRole: trim(event?.role),
    sourceType: trim(event?.type),
    order,
  };
  record.downloadUrl = artifactDownloadUrl(record);
  return record;
}

export function annotateAttachmentsWithArtifactIds(event, sessionId) {
  if (!(event && typeof event === 'object')) return event;
  const next = { ...event };
  const annotate = (attachments) => attachments.map((attachment, index) => {
    if (!(attachment && typeof attachment === 'object')) return attachment;
    return {
      ...attachment,
      artifactFileId: attachment.artifactFileId || getArtifactFileId(sessionId, event, attachment, index),
    };
  });
  if (Array.isArray(next.attachments)) next.attachments = annotate(next.attachments);
  if (Array.isArray(next.images)) next.images = annotate(next.images);
  return next;
}

function collectAttachments(event) {
  if (Array.isArray(event?.attachments)) return event.attachments;
  if (Array.isArray(event?.images)) return event.images;
  return [];
}

function parseToolInput(toolInput) {
  if (!toolInput) return {};
  if (typeof toolInput === 'object') return toolInput;
  if (typeof toolInput !== 'string') return {};
  try {
    const parsed = JSON.parse(toolInput);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseFileEdit(event) {
  const toolName = trim(event?.toolName);
  if (!FILE_EDIT_TOOLS.has(toolName)) return null;
  const input = parseToolInput(event.toolInput);
  const filePath = trim(input.file_path) || trim(input.path) || trim(input.notebook_path);
  if (!filePath) return null;
  if (toolName === 'Write') {
    return {
      filePath,
      changeType: 'add',
      source: toolName,
      edits: [{ oldText: '', newText: input.content || '' }],
    };
  }
  if (toolName === 'Edit') {
    return {
      filePath,
      changeType: 'edit',
      source: toolName,
      edits: [{
        oldText: input.old_string || '',
        newText: input.new_string || '',
      }],
    };
  }
  const edits = toolName === 'NotebookEdit'
    ? (
        String(input.edit_mode || '').toLowerCase() === 'insert'
        || typeof input.old_source === 'string'
          ? [{ oldText: input.old_source || '', newText: input.new_source || input.source || '' }]
          : []
      )
    : (Array.isArray(input.edits)
        ? input.edits.map((edit) => ({
            oldText: edit?.old_string || '',
            newText: edit?.new_string || '',
          }))
        : []);
  return {
    filePath,
    changeType: toolName === 'NotebookEdit' && String(input.edit_mode || '').toLowerCase() === 'delete'
      ? 'delete'
      : 'edit',
    source: toolName,
    edits,
  };
}

function computeLineDiff(oldText, newText) {
  const oldLines = String(oldText || '').split('\n');
  const newLines = String(newText || '').split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > MAX_DIFF_CELLS) return null;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const diff = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: 'equal', text: oldLines[i - 1], oldLine: i, newLine: j });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'add', text: newLines[j - 1], newLine: j });
      j -= 1;
    } else {
      diff.unshift({ type: 'remove', text: oldLines[i - 1], oldLine: i });
      i -= 1;
    }
  }
  return diff;
}

function summarizeEditDiff(edits) {
  let added = 0;
  let removed = 0;
  const preview = [];
  for (const edit of Array.isArray(edits) ? edits : []) {
    const diff = computeLineDiff(edit.oldText, edit.newText);
    if (!diff) {
      const oldLineCount = String(edit.oldText || '').split('\n').length;
      const newLineCount = String(edit.newText || '').split('\n').length;
      removed += oldLineCount;
      added += newLineCount;
      if (preview.length < MAX_DIFF_PREVIEW_LINES) {
        preview.push({
          type: 'equal',
          text: `[diff omitted: ${oldLineCount} old lines → ${newLineCount} new lines]`,
          truncated: true,
        });
      }
      continue;
    }
    for (const line of diff) {
      if (line.type === 'add') added += 1;
      if (line.type === 'remove') removed += 1;
      if (line.type !== 'equal' && preview.length < MAX_DIFF_PREVIEW_LINES) {
        preview.push(line);
      }
    }
  }
  return { added, removed, preview };
}

function readNumber(event, keys) {
  for (const key of keys) {
    const value = Number(event?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function normalizeDiffPreviewType(value) {
  if (value === ' ') return 'equal';
  const normalized = String(value || '').trim().toLowerCase();
  if (['add', 'added', 'insert', '+'].includes(normalized)) return 'add';
  if (['remove', 'removed', 'delete', 'deleted', '-'].includes(normalized)) return 'remove';
  if (['equal', 'context'].includes(normalized)) return 'equal';
  return '';
}

function readDiffPreviewLine(value) {
  if (typeof value === 'string') {
    const marker = value.slice(0, 1);
    const type = normalizeDiffPreviewType(marker) || 'equal';
    return { type, text: type === 'equal' ? value : value.slice(1) };
  }
  if (!(value && typeof value === 'object')) return null;
  const type = normalizeDiffPreviewType(value.type || value.kind || value.op || value.marker);
  if (!type) return null;
  const oldLine = Number(value.oldLine || value.old_line || value.beforeLine || value.before_line);
  const newLine = Number(value.newLine || value.new_line || value.afterLine || value.after_line);
  const text = typeof value.text === 'string'
    ? value.text
    : (typeof value.content === 'string'
      ? value.content
      : (typeof value.value === 'string' ? value.value : ''));
  return {
    type,
    text,
    ...(Number.isInteger(oldLine) && oldLine > 0 ? { oldLine } : {}),
    ...(Number.isInteger(newLine) && newLine > 0 ? { newLine } : {}),
  };
}

function readFileChangePreview(event) {
  const source = Array.isArray(event?.preview)
    ? event.preview
    : (Array.isArray(event?.diffPreview) ? event.diffPreview : []);
  return source
    .slice(0, MAX_DIFF_PREVIEW_LINES)
    .map((line) => readDiffPreviewLine(line))
    .filter(Boolean);
}

function countPreview(preview) {
  let added = 0;
  let removed = 0;
  for (const line of Array.isArray(preview) ? preview : []) {
    if (line?.type === 'add') added += 1;
    if (line?.type === 'remove') removed += 1;
  }
  return { added, removed };
}

function applyChangedFile(files, change) {
  if (!change?.filePath) return;
  const existing = files.get(change.filePath) || {
    filePath: change.filePath,
    changeType: change.changeType || 'update',
    added: 0,
    removed: 0,
    preview: [],
    source: change.source || '',
    latestSeq: 0,
    hasLineStats: false,
  };
  existing.changeType = change.changeType || existing.changeType;
  existing.added += change.added || 0;
  existing.removed += change.removed || 0;
  existing.preview.push(...(Array.isArray(change.preview) ? change.preview : []));
  existing.preview = existing.preview.slice(0, MAX_DIFF_PREVIEW_LINES);
  existing.source = change.source || existing.source;
  existing.latestSeq = Math.max(existing.latestSeq || 0, change.latestSeq || 0);
  existing.hasLineStats = existing.hasLineStats === true
    || change.hasLineStats === true
    || existing.added > 0
    || existing.removed > 0
    || existing.preview.length > 0;
  files.set(change.filePath, existing);
}

function normalizePlanItemStatus(value) {
  const status = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(status)) return 'completed';
  if (['in_progress', 'active', 'current', 'running', 'started'].includes(status)) return 'in_progress';
  return 'pending';
}

function normalizePlanItems(event) {
  const sourceItems = Array.isArray(event?.items)
    ? event.items
    : (Array.isArray(event?.plan) ? event.plan : []);
  return sourceItems
    .map((item) => (item && typeof item === 'object' ? item : { text: item }))
    .map((item) => ({
      text: String(item.text || item.title || item.step || '').trim(),
      status: normalizePlanItemStatus(item.status || item.state || (item.completed === true ? 'completed' : 'pending')),
    }))
    .filter((item) => item.text);
}

function getPlanState(event, items) {
  const state = String(event?.status || event?.state || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['drafting', 'running', 'in_progress', 'started'].includes(state)) return 'drafting';
  if (['awaiting_decision', 'ready'].includes(state)) return 'awaiting_decision';
  if (['completed', 'complete', 'done'].includes(state)) return 'completed';
  if (['revising', 'approved', 'executing', 'superseded', 'failed'].includes(state)) return state;
  if (items.length > 0 && items.every((item) => item.status === 'completed')) return 'awaiting_decision';
  return 'drafting';
}

function formatPlanText(plan) {
  const bodyMarkdown = trim(plan?.bodyMarkdown);
  if (bodyMarkdown) return bodyMarkdown;
  const lines = (Array.isArray(plan?.items) ? plan.items : []).map((item) => {
    const marker = item.status === 'completed' ? '[x]' : '[ ]';
    return `${marker} ${item.text}`;
  });
  return [plan?.name || 'Plan', '', ...lines].join('\n').trim();
}

function normalizePlanEvent(event) {
  const seq = eventSeq(event);
  const planId = trim(event?.planId) || trim(event?.artifactId) || trim(event?.id) || `plan-${seq}`;
  if (!planId) return null;
  const items = normalizePlanItems(event);
  const plan = {
    kind: 'plan',
    name: trim(event?.title) || 'Plan',
    planId,
    sourceRunId: trim(event?.runId),
    runId: trim(event?.runId),
    state: getPlanState(event, items),
    items,
    bodyMarkdown: trim(event?.bodyMarkdown),
    source: trim(event?.source),
    interactionMode: trim(event?.interactionMode),
    planIntent: trim(event?.planIntent),
    revision: Number.isInteger(event?.revision) ? event.revision : 1,
    seq,
  };
  plan.text = formatPlanText(plan);
  return plan;
}

function isProgressPlan(plan) {
  const planIntent = trim(plan?.planIntent).toLowerCase();
  if (planIntent) return planIntent === 'progress';
  return trim(plan?.interactionMode).toLowerCase() === 'agent';
}

function emptyProjection(sessionId, latestSeq = 0) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    sourceLatestSeq: latestSeq,
    coveredFromSeq: latestSeq > 0 ? 1 : 0,
    projectionStale: false,
    updatedAt: new Date().toISOString(),
    artifactFiles: [],
    changedFiles: [],
    progressPlans: [],
  };
}

export function buildSessionAuditProjection(sessionId, events = [], options = {}) {
  const normalizedSessionId = trim(sessionId);
  const projection = emptyProjection(normalizedSessionId, 0);
  const artifactFiles = new Map();
  const changedFiles = new Map();
  const progressPlans = new Map();
  let artifactOrder = 0;
  let sourceLatestSeq = 0;

  for (const rawEvent of Array.isArray(events) ? events : []) {
    if (!(rawEvent && typeof rawEvent === 'object')) continue;
    const event = annotateAttachmentsWithArtifactIds(rawEvent, normalizedSessionId);
    const seq = eventBoundarySeq(event);
    sourceLatestSeq = Math.max(sourceLatestSeq, seq);
    const attachments = collectAttachments(event);
    attachments.forEach((attachment, index) => {
      const record = buildArtifactFileRecord(event, attachment, {
        sessionId: normalizedSessionId,
        index,
        order: artifactOrder,
      });
      if (!record) return;
      artifactOrder += 1;
      if (!artifactFiles.has(record.id)) {
        artifactFiles.set(record.id, record);
      }
    });

    if (event.type === 'tool_use') {
      const edit = parseFileEdit(event);
      if (edit) {
        const diff = summarizeEditDiff(edit.edits);
        applyChangedFile(changedFiles, {
          filePath: edit.filePath,
          changeType: edit.changeType,
          added: diff.added,
          removed: diff.removed,
          preview: diff.preview,
          source: edit.source,
          latestSeq: eventSeq(event),
          hasLineStats: diff.added > 0 || diff.removed > 0 || diff.preview.length > 0,
        });
      }
    }

    if (event.type === 'file_change') {
      const filePath = trim(event.filePath) || trim(event.path);
      if (filePath) {
        const preview = readFileChangePreview(event);
        const previewStats = countPreview(preview);
        const rawStats = {
          added: readNumber(event, ['added', 'additions', 'linesAdded', 'addedLines']),
          removed: readNumber(event, ['removed', 'deletions', 'linesRemoved', 'removedLines']),
        };
        const added = rawStats.added || previewStats.added;
        const removed = rawStats.removed || previewStats.removed;
        applyChangedFile(changedFiles, {
          filePath,
          changeType: normalizeFileChangeType(event.changeType || event.kind || event.status),
          added,
          removed,
          preview,
          source: trim(event.source) || 'file_change',
          latestSeq: eventSeq(event),
          hasLineStats: added > 0 || removed > 0 || preview.length > 0,
        });
      }
    }

    if (event.type === 'plan') {
      const plan = normalizePlanEvent(event);
      if (plan && isProgressPlan(plan)) {
        const previous = progressPlans.get(plan.planId);
        if (!previous || plan.seq >= previous.seq) {
          progressPlans.set(plan.planId, plan);
        }
      }
    }
  }

  projection.sourceLatestSeq = Math.max(sourceLatestSeq, Number.isInteger(options.latestSeq) ? options.latestSeq : 0);
  projection.coveredFromSeq = projection.sourceLatestSeq > 0 ? 1 : 0;
  projection.artifactFiles = Array.from(artifactFiles.values())
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .slice(-MAX_AUDIT_ARTIFACT_FILES);
  projection.changedFiles = Array.from(changedFiles.values())
    .sort((a, b) => (b.latestSeq || 0) - (a.latestSeq || 0))
    .slice(0, MAX_AUDIT_CHANGED_FILES);
  projection.progressPlans = Array.from(progressPlans.values())
    .sort((a, b) => (b.seq || 0) - (a.seq || 0))
    .slice(0, MAX_AUDIT_PROGRESS_PLANS);
  projection.updatedAt = new Date().toISOString();
  return projection;
}

export async function readSessionAuditProjection(sessionId) {
  const pending = pendingProjectionBySession.get(sessionId);
  if (pending?.projection) return pending.projection;
  const cached = projectionReadCache.get(sessionId);
  if (cached && Date.now() - cached.cachedAt <= PROJECTION_READ_CACHE_TTL_MS) {
    setProjectionReadCache(sessionId, cached.projection, cached.cachedAt);
    return cached.projection;
  }
  const projection = await readJson(projectionPath(sessionId), null);
  if (!projection || ![1, SCHEMA_VERSION].includes(projection.schemaVersion)) return null;
  const normalized = {
    ...emptyProjection(sessionId, projection.sourceLatestSeq || 0),
    sourceLatestSeq: projection.sourceLatestSeq || 0,
    coveredFromSeq: projection.coveredFromSeq || 0,
    projectionStale: projection.projectionStale === true,
    updatedAt: projection.updatedAt || null,
    artifactFiles: Array.isArray(projection.artifactFiles) ? projection.artifactFiles : [],
    changedFiles: Array.isArray(projection.changedFiles) ? projection.changedFiles : (projection.files || []),
    progressPlans: Array.isArray(projection.progressPlans)
      ? projection.progressPlans
      : (projection.planArtifacts || []).filter(isProgressPlan),
  };
  setProjectionReadCache(sessionId, normalized);
  return normalized;
}

export async function writeSessionAuditProjection(sessionId, projection) {
  const normalized = {
    ...emptyProjection(sessionId, projection?.sourceLatestSeq || 0),
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    sourceLatestSeq: projection?.sourceLatestSeq || 0,
    coveredFromSeq: projection?.coveredFromSeq || 0,
    projectionStale: projection?.projectionStale === true,
    artifactFiles: Array.isArray(projection?.artifactFiles) ? projection.artifactFiles : [],
    changedFiles: Array.isArray(projection?.changedFiles) ? projection.changedFiles : [],
    progressPlans: Array.isArray(projection?.progressPlans) ? projection.progressPlans : [],
    updatedAt: new Date().toISOString(),
  };
  if (!PERF_WRITE_DEBOUNCE_ENABLED) {
    await writeJsonAtomic(projectionPath(sessionId), normalized, COMPACT_JSON_OPTIONS);
    setProjectionReadCache(sessionId, normalized);
    return normalized;
  }
  const existing = pendingProjectionBySession.get(sessionId);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingProjectionBySession.delete(sessionId);
    void writeJsonAtomic(projectionPath(sessionId), normalized, COMPACT_JSON_OPTIONS).catch((error) => {
      console.error(`[audit-projection] flush failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
    });
  }, PROJECTION_FLUSH_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  pendingProjectionBySession.set(sessionId, { projection: normalized, timer });
  setProjectionReadCache(sessionId, normalized);
  return normalized;
}

// Flush every pending projection to disk. Wired into the chat server's
// shutdown hook so a graceful stop never loses the debounced window.
export async function flushPendingAuditProjections() {
  const entries = [...pendingProjectionBySession.entries()];
  pendingProjectionBySession.clear();
  for (const [sessionId, { projection, timer }] of entries) {
    if (timer) clearTimeout(timer);
    try {
      await writeJsonAtomic(projectionPath(sessionId), projection, COMPACT_JSON_OPTIONS);
    } catch (error) {
      console.error(`[audit-projection] flush failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
    }
  }
}

export async function updateSessionAuditProjectionForEvents(sessionId, events, meta = {}) {
  const incoming = (Array.isArray(events) ? events : [])
    .filter((event) => event && typeof event === 'object')
    .sort((a, b) => eventSeq(a) - eventSeq(b));
  if (incoming.length === 0) return readSessionAuditProjection(sessionId);

  const existing = await readSessionAuditProjection(sessionId);
  const firstSeq = eventSeq(incoming[0]);
  const latestSeq = Math.max(
    Number.isInteger(meta.latestSeq) ? meta.latestSeq : 0,
    ...incoming.map(eventBoundarySeq),
  );

  if (!existing || existing.projectionStale === true || (existing.sourceLatestSeq || 0) + 1 !== firstSeq) {
    const rebuilt = buildSessionAuditProjection(sessionId, incoming, { latestSeq });
    rebuilt.coveredFromSeq = firstSeq || 0;
    rebuilt.projectionStale = firstSeq > 1;
    return writeSessionAuditProjection(sessionId, rebuilt);
  }

  const mergedEvents = [
    ...incoming,
  ];
  const rebuilt = buildSessionAuditProjection(sessionId, mergedEvents, { latestSeq });
  const previousMaxArtifactOrder = Math.max(
    -1,
    ...(Array.isArray(existing.artifactFiles)
      ? existing.artifactFiles.map((item) => Number.isFinite(item?.order) ? item.order : -1)
      : []),
  );
  rebuilt.artifactFiles = rebuilt.artifactFiles.map((item, index) => ({
    ...item,
    order: previousMaxArtifactOrder + 1 + index,
  }));
  rebuilt.artifactFiles = mergeById(existing.artifactFiles, rebuilt.artifactFiles, 'id', { sortKey: 'order', ascending: true })
    .slice(-MAX_AUDIT_ARTIFACT_FILES);
  rebuilt.changedFiles = mergeChangedFiles(existing.changedFiles, rebuilt.changedFiles)
    .slice(0, MAX_AUDIT_CHANGED_FILES);
  rebuilt.progressPlans = mergeById(existing.progressPlans, rebuilt.progressPlans, 'planId', { sortKey: 'seq', ascending: false })
    .slice(0, MAX_AUDIT_PROGRESS_PLANS);
  rebuilt.coveredFromSeq = existing.coveredFromSeq || 1;
  rebuilt.projectionStale = false;
  rebuilt.sourceLatestSeq = Math.max(existing.sourceLatestSeq || 0, latestSeq);
  return writeSessionAuditProjection(sessionId, rebuilt);
}

function mergeById(previous = [], next = [], key, { sortKey = '', ascending = false } = {}) {
  const map = new Map();
  for (const item of Array.isArray(previous) ? previous : []) {
    if (item?.[key]) map.set(item[key], clone(item));
  }
  for (const item of Array.isArray(next) ? next : []) {
    if (!item?.[key]) continue;
    const old = map.get(item[key]);
    map.set(item[key], old ? { ...old, ...item } : clone(item));
  }
  const rows = Array.from(map.values());
  if (sortKey) {
    rows.sort((a, b) => ascending
      ? (a[sortKey] || 0) - (b[sortKey] || 0)
      : (b[sortKey] || 0) - (a[sortKey] || 0));
  }
  return rows;
}

function mergeChangedFiles(previous = [], next = []) {
  const map = new Map();
  for (const item of Array.isArray(previous) ? previous : []) {
    if (item?.filePath) map.set(item.filePath, clone(item));
  }
  for (const item of Array.isArray(next) ? next : []) {
    if (!item?.filePath) continue;
    const old = map.get(item.filePath);
    if (!old) {
      map.set(item.filePath, clone(item));
      continue;
    }
    const latestIsIncoming = (item.latestSeq || 0) >= (old.latestSeq || 0);
    map.set(item.filePath, {
      ...old,
      ...item,
      changeType: latestIsIncoming ? (item.changeType || old.changeType) : (old.changeType || item.changeType),
      added: (old.added || 0) + (item.added || 0),
      removed: (old.removed || 0) + (item.removed || 0),
      preview: [
        ...(Array.isArray(old.preview) ? old.preview : []),
        ...(Array.isArray(item.preview) ? item.preview : []),
      ].slice(0, MAX_DIFF_PREVIEW_LINES),
      source: latestIsIncoming ? (item.source || old.source) : (old.source || item.source),
      latestSeq: Math.max(old.latestSeq || 0, item.latestSeq || 0),
      hasLineStats: old.hasLineStats === true || item.hasLineStats === true,
    });
  }
  return Array.from(map.values()).sort((a, b) => (b.latestSeq || 0) - (a.latestSeq || 0));
}

export async function ensureSessionAuditProjection(sessionId, { latestSeq = 0, loadEvents = null } = {}) {
  const existing = await readSessionAuditProjection(sessionId);
  if (
    existing
    && existing.projectionStale !== true
    && (existing.sourceLatestSeq || 0) >= latestSeq
  ) {
    return existing;
  }
  if (typeof loadEvents !== 'function') {
    const empty = emptyProjection(sessionId, latestSeq);
    empty.coveredFromSeq = 0;
    empty.projectionStale = latestSeq > 0;
    return existing || empty;
  }
  const source = await loadEvents();
  if (source && typeof source[Symbol.asyncIterator] === 'function') {
    // Rebuild from bounded batches so a background fork-index job does not
    // materialize a 100K-event transcript merely to refresh a derived audit
    // projection. updateSessionAuditProjectionForEvents merges each contiguous
    // batch into its bounded artifact/file/plan projections.
    const batch = [];
    let projected = existing;
    for await (const event of source) {
      if (!event || typeof event !== 'object') continue;
      batch.push(event);
      if (batch.length < 256) continue;
      projected = await updateSessionAuditProjectionForEvents(sessionId, batch.splice(0, batch.length), { latestSeq });
    }
    if (batch.length > 0) {
      projected = await updateSessionAuditProjectionForEvents(sessionId, batch, { latestSeq });
    }
    return projected || await readSessionAuditProjection(sessionId);
  }
  const events = Array.isArray(source) ? source : [];
  const rebuilt = buildSessionAuditProjection(sessionId, events, { latestSeq });
  return writeSessionAuditProjection(sessionId, rebuilt);
}

export function buildProjectionModel(projection, { session = null } = {}) {
  const source = projection || emptyProjection(session?.id || '', 0);
  return {
    session: session || { id: source.sessionId },
    tools: [],
    files: clone(source.changedFiles || []),
    activity: [],
    artifacts: clone(source.progressPlans || []),
    planArtifacts: clone(source.progressPlans || []),
    progressPlans: clone(source.progressPlans || []),
    artifactFiles: clone(source.artifactFiles || []),
    hiddenActivity: [],
    sourceLatestSeq: source.sourceLatestSeq || 0,
    projectionStale: source.projectionStale === true,
  };
}
