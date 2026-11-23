import { createHash, randomBytes } from 'crypto';

import { CHAT_TRIGGERS_FILE } from '../lib/config.mjs';
import { appendEvent, findLatestAssistantMessage, loadMeta } from './history.mjs';
import { statusEvent } from './normalizer.mjs';
import { createSerialTaskQueue, readJson, statOrNull, writeJsonAtomic } from './fs-utils.mjs';
import { getSession, getSessionReplyPublication, submitHttpMessage } from './session-manager.mjs';
import { findRunByRequest, getRun, getRunManifest } from './runs.mjs';

const DEFAULT_TRIGGER_POLL_MS = 15000;
const MAX_TRIGGER_IDLE_DELAY_MS = 15 * 60 * 1000;
const MIN_TRIGGER_POLL_MS = 250;
const DELIVERY_CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
const TRIGGER_STATUS_PENDING = 'pending';
const TRIGGER_STATUS_DELIVERING = 'delivering';
const TRIGGER_STATUS_DELIVERED = 'delivered';
const TRIGGER_STATUS_FAILED = 'failed';
const TRIGGER_STATUS_CANCELLED = 'cancelled';
const TRIGGER_TYPE_AT_TIME = 'at_time';
const TRIGGER_TYPE_EVENT = 'event';
const TRIGGER_ACTION_SESSION_MESSAGE = 'session_message';
const TRIGGER_ACTION_RESPONSIBILITY_WAKE = 'responsibility_wake';
// `deliveryMode` records the observed delivery result (run/queued/status).
// Keep the intended input semantics separate so a control-plane event can
// never accidentally become a user transcript message.
const TRIGGER_INPUT_MODE_USER_MESSAGE = 'user_message';
const TRIGGER_INPUT_MODE_INTERNAL_CONTINUATION = 'internal_continuation';
const TRIGGER_INPUT_MODE_STATUS_NOTIFICATION = 'status_notification';
const TRIGGER_INPUT_MODES = new Set([
  TRIGGER_INPUT_MODE_USER_MESSAGE,
  TRIGGER_INPUT_MODE_INTERNAL_CONTINUATION,
  TRIGGER_INPUT_MODE_STATUS_NOTIFICATION,
]);
const TRIGGER_EVENT_TYPES = new Set([
  'run_terminal',
  'collaboration_terminal',
  'process_terminal',
  'process_output',
  'session_event',
]);
const MIN_RECURRENCE_INTERVAL_MS = 100;
const MAX_RECURRENCE_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;
const MAX_EVENT_KEYS = 64;
const MAX_DELIVERY_RESULTS = 64;
const MAX_DEDUPE_KEY_CHARS = 256;

let triggersCache = null;
let triggersCacheMtimeMs = 0;
let triggerSchedulerTimer = null;
let triggerTickPromise = null;
let triggerSchedulerOptions = {};

const triggerMutationQueue = createSerialTaskQueue();

function nowIso() {
  return new Date().toISOString();
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function validTriggerId(value) {
  return /^trg_[a-f0-9]{24}$/.test(trimString(value));
}

function createTriggerId() {
  return `trg_${randomBytes(12).toString('hex')}`;
}

function buildTriggerRequestId(triggerId) {
  return `trigger:${triggerId}`;
}

function normalizeTimestamp(value) {
  const normalized = trimString(value);
  if (!normalized) return '';
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString();
}

function normalizeEventType(value) {
  const normalized = trimString(value).toLowerCase();
  return TRIGGER_EVENT_TYPES.has(normalized) ? normalized : '';
}

function normalizeInputMode(value) {
  const normalized = trimString(value).toLowerCase();
  return TRIGGER_INPUT_MODES.has(normalized)
    ? normalized
    : TRIGGER_INPUT_MODE_USER_MESSAGE;
}

function normalizeRecurrence(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const type = trimString(raw.type || raw.kind).toLowerCase();
  if (!type || type === 'once') return null;
  if (type !== 'interval') return null;
  const intervalMs = Number(raw.intervalMs ?? raw.everyMs);
  if (!Number.isInteger(intervalMs)
      || intervalMs < MIN_RECURRENCE_INTERVAL_MS
      || intervalMs > MAX_RECURRENCE_INTERVAL_MS) return null;
  const maxOccurrences = Number(raw.maxOccurrences);
  return {
    type: 'interval',
    intervalMs,
    ...(Number.isInteger(maxOccurrences) && maxOccurrences > 0 ? { maxOccurrences } : {}),
  };
}

function normalizeEventFilter(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, raw] of Object.entries(value).slice(0, 24)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(key)) continue;
    if (['string', 'number', 'boolean'].includes(typeof raw)) result[key] = raw;
  }
  return result;
}

function clipEventPayload(value) {
  let serialized = '{}';
  try { serialized = JSON.stringify(value && typeof value === 'object' ? value : {}); } catch {}
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    serialized = `${serialized.slice(0, MAX_EVENT_PAYLOAD_BYTES - 32)}...[truncated]`;
  }
  try { return JSON.parse(serialized); } catch { return { truncated: true }; }
}

function eventKey(eventType, payload = {}) {
  const explicit = trimString(payload?.eventId || payload?.id || payload?.eventKey);
  if (explicit) return `${eventType}:${explicit}`;
  return `${eventType}:${createHash('sha256').update(JSON.stringify(payload || {}), 'utf8').digest('hex').slice(0, 32)}`;
}

function eventFilterMatches(filter, payload = {}) {
  return Object.entries(filter || {}).every(([key, expected]) => {
    const actual = key.split('.').reduce((value, part) => (
      value && typeof value === 'object' ? value[part] : undefined
    ), payload);
    return actual === expected;
  });
}

function requireTimestamp(value, fieldName) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be a valid timestamp`);
  }
  return normalized;
}

function normalizeTriggerStatus(value, fallback = TRIGGER_STATUS_PENDING) {
  const normalized = trimString(value).toLowerCase();
  if ([
    TRIGGER_STATUS_PENDING,
    TRIGGER_STATUS_DELIVERING,
    TRIGGER_STATUS_DELIVERED,
    TRIGGER_STATUS_FAILED,
    TRIGGER_STATUS_CANCELLED,
  ].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTriggerPollMs(value = process.env.RAGENT_TRIGGER_POLL_MS) {
  return Math.max(MIN_TRIGGER_POLL_MS, parsePositiveInteger(value, DEFAULT_TRIGGER_POLL_MS));
}

function normalizeStoredTrigger(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const triggerType = trimString(raw.triggerType).toLowerCase() === TRIGGER_TYPE_EVENT
    ? TRIGGER_TYPE_EVENT
    : TRIGGER_TYPE_AT_TIME;
  const scheduledAt = normalizeTimestamp(raw.scheduledAt);
  const sessionId = trimString(raw.sessionId);
  const text = trimString(raw.text);
  if ((!scheduledAt && triggerType !== TRIGGER_TYPE_EVENT) || !sessionId || !text) {
    return null;
  }

  const status = normalizeTriggerStatus(raw.status, TRIGGER_STATUS_PENDING);
  const enabled = normalizeBoolean(
    raw.enabled,
    status !== TRIGGER_STATUS_DELIVERED && status !== TRIGGER_STATUS_CANCELLED,
  );
  const createdAt = normalizeTimestamp(raw.createdAt) || nowIso();
  const updatedAt = normalizeTimestamp(raw.updatedAt) || createdAt;
  const id = validTriggerId(raw.id) ? raw.id : createTriggerId();
  const requestId = trimString(raw.requestId) || buildTriggerRequestId(id);
  const dedupeKey = trimString(raw.dedupeKey).slice(0, MAX_DEDUPE_KEY_CHARS);

  return {
    id,
    triggerType,
    actionType: raw.actionType === TRIGGER_ACTION_RESPONSIBILITY_WAKE ? TRIGGER_ACTION_RESPONSIBILITY_WAKE : TRIGGER_ACTION_SESSION_MESSAGE,
    status,
    enabled,
    title: trimString(raw.title),
    sessionId,
    scheduledAt: scheduledAt || '',
    text,
    tool: trimString(raw.tool),
    model: trimString(raw.model),
    effort: trimString(raw.effort),
    thinking: normalizeBoolean(raw.thinking, false),
    inputMode: normalizeInputMode(raw.inputMode),
    requestId,
    dedupeKey,
    createdAt,
    updatedAt,
    claimedAt: normalizeTimestamp(raw.claimedAt),
    lastAttemptAt: normalizeTimestamp(raw.lastAttemptAt),
    nextAttemptAt: normalizeTimestamp(raw.nextAttemptAt),
    deliveredAt: normalizeTimestamp(raw.deliveredAt),
    lastErrorAt: normalizeTimestamp(raw.lastErrorAt),
    lastError: trimString(raw.lastError),
    deliveryAttempts: Math.max(0, parsePositiveInteger(raw.deliveryAttempts, 0)),
    runId: trimString(raw.runId),
    deliveryMode: trimString(raw.deliveryMode),
    deliveryResults: Array.isArray(raw.deliveryResults) ? raw.deliveryResults.slice(-MAX_DELIVERY_RESULTS) : [],
    eventType: normalizeEventType(raw.eventType),
    eventFilter: normalizeEventFilter(raw.eventFilter),
    recurrence: normalizeRecurrence(raw.recurrence || raw.schedule),
    occurrence: Math.max(0, Number.parseInt(raw.occurrence, 10) || 0),
    lastDeliveredAt: normalizeTimestamp(raw.lastDeliveredAt),
    pendingEventKey: trimString(raw.pendingEventKey),
    pendingEvent: raw.pendingEvent && typeof raw.pendingEvent === 'object'
      ? clipEventPayload(raw.pendingEvent)
      : null,
    deliveredEventKeys: Array.isArray(raw.deliveredEventKeys)
      ? raw.deliveredEventKeys.map(trimString).filter(Boolean).slice(-MAX_EVENT_KEYS)
      : [],
    repeat: raw.repeat === true,
  };
}

function normalizeStoredTriggers(entries) {
  const list = [];
  let changed = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeStoredTrigger(entry);
    if (!normalized) {
      changed = true;
      continue;
    }
    // Versions before semantic trigger delivery created this exact private
    // trigger for every collaboration.  It was an implementation detail, not
    // an owner-authored automation, and it reinjected terminal state through
    // the user message path.  Disable it once during normalization; explicit
    // owner-created collaboration event triggers remain untouched.
    const legacyCollaborationWake = normalized.triggerType === TRIGGER_TYPE_EVENT
      && normalized.eventType === 'collaboration_terminal'
      && normalized.dedupeKey.startsWith('collaboration-terminal:');
    if (legacyCollaborationWake && (normalized.enabled || normalized.status === TRIGGER_STATUS_DELIVERING)) {
      normalized.enabled = false;
      normalized.status = TRIGGER_STATUS_CANCELLED;
      normalized.claimedAt = '';
      normalized.nextAttemptAt = '';
      normalized.pendingEventKey = '';
      normalized.pendingEvent = null;
      normalized.lastError = 'Retired legacy collaboration wake; collaboration status now uses the dedicated control channel.';
      normalized.lastErrorAt = nowIso();
      normalized.updatedAt = nowIso();
      changed = true;
    }
    if (JSON.stringify(normalized) !== JSON.stringify(entry)) {
      changed = true;
    }
    list.push(normalized);
  }
  return { list, changed };
}

async function saveTriggersUnlocked(triggers) {
  triggersCache = Array.isArray(triggers) ? triggers : [];
  await writeJsonAtomic(CHAT_TRIGGERS_FILE, triggersCache);
  const stats = await statOrNull(CHAT_TRIGGERS_FILE);
  triggersCacheMtimeMs = stats?.mtimeMs || Date.now();
  // A write may introduce an earlier due time or a retry deadline than the
  // timer currently installed. Replace that timer so persistence also
  // re-arms the scheduler immediately.
  rescheduleTriggerWake(0);
}

async function loadTriggers() {
  const stats = await statOrNull(CHAT_TRIGGERS_FILE);
  const mtimeMs = stats?.mtimeMs || 0;
  if (triggersCache && triggersCacheMtimeMs === mtimeMs) {
    return triggersCache;
  }

  const parsed = await readJson(CHAT_TRIGGERS_FILE, []);
  const normalized = normalizeStoredTriggers(parsed);
  triggersCache = normalized.list;
  if (normalized.changed) {
    await saveTriggersUnlocked(triggersCache);
  } else {
    triggersCacheMtimeMs = mtimeMs;
  }
  return triggersCache;
}

async function withTriggerMutation(mutator) {
  return triggerMutationQueue(async () => {
    const triggers = await loadTriggers();
    return mutator(triggers, saveTriggersUnlocked);
  });
}

function cloneTrigger(trigger) {
  return trigger ? JSON.parse(JSON.stringify(trigger)) : null;
}

function sortTriggers(triggers) {
  return [...(Array.isArray(triggers) ? triggers : [])].sort((left, right) => {
    const leftState = left?.status === TRIGGER_STATUS_PENDING ? 0 : 1;
    const rightState = right?.status === TRIGGER_STATUS_PENDING ? 0 : 1;
    if (leftState !== rightState) return leftState - rightState;
    const leftTime = Date.parse(left?.scheduledAt || left?.updatedAt || left?.createdAt || 0) || 0;
    const rightTime = Date.parse(right?.scheduledAt || right?.updatedAt || right?.createdAt || 0) || 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left?.id || '').localeCompare(String(right?.id || ''));
  });
}

function isClaimStale(trigger, nowMs = Date.now()) {
  if (trigger?.status !== TRIGGER_STATUS_DELIVERING) return false;
  const claimedAtMs = Date.parse(trigger?.claimedAt || '');
  if (!Number.isFinite(claimedAtMs)) return true;
  return (nowMs - claimedAtMs) >= DELIVERY_CLAIM_TIMEOUT_MS;
}

function isDueTrigger(trigger, nowMs = Date.now()) {
  if (!trigger?.enabled) return false;
  if (trigger?.triggerType !== TRIGGER_TYPE_AT_TIME) return false;
  if (![TRIGGER_ACTION_SESSION_MESSAGE,TRIGGER_ACTION_RESPONSIBILITY_WAKE].includes(trigger?.actionType)) return false;
  if (![TRIGGER_STATUS_PENDING, TRIGGER_STATUS_DELIVERING].includes(trigger?.status)) return false;
  if (trigger?.status === TRIGGER_STATUS_DELIVERING && !isClaimStale(trigger, nowMs)) return false;
  const scheduledAtMs = Date.parse(trigger?.scheduledAt || '');
  if (!Number.isFinite(scheduledAtMs) || scheduledAtMs > nowMs) return false;
  const nextAttemptAtMs = Date.parse(trigger?.nextAttemptAt || '');
  if (Number.isFinite(nextAttemptAtMs) && nextAttemptAtMs > nowMs) return false;
  return true;
}

function isDueEventRetry(trigger, nowMs = Date.now()) {
  if (!trigger?.enabled || trigger.triggerType !== TRIGGER_TYPE_EVENT
      || trigger.actionType !== TRIGGER_ACTION_SESSION_MESSAGE
      || ![TRIGGER_STATUS_PENDING, TRIGGER_STATUS_DELIVERING].includes(trigger.status)
      || (trigger.status === TRIGGER_STATUS_DELIVERING && !isClaimStale(trigger, nowMs))
      || !trigger.pendingEventKey || !trigger.pendingEvent) return false;
  const nextAttemptAtMs = Date.parse(trigger.nextAttemptAt || '');
  return !Number.isFinite(nextAttemptAtMs) || nextAttemptAtMs <= nowMs;
}

function isTriggerTerminal(trigger) {
  return [TRIGGER_STATUS_DELIVERED, TRIGGER_STATUS_FAILED, TRIGGER_STATUS_CANCELLED].includes(trigger?.status);
}

function buildTriggerStatusText(trigger, { queued = false } = {}) {
  const prefix = queued ? 'trigger queued' : trigger?.triggerType === TRIGGER_TYPE_EVENT ? 'event trigger fired' : 'scheduled trigger fired';
  const title = trimString(trigger?.title);
  return title ? `${prefix}: ${title}` : `${prefix}: ${trigger?.id || 'unknown trigger'}`;
}

function resolveRetryDelayMs(attempts) {
  const index = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, attempts - 1));
  return RETRY_DELAYS_MS[index] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
}

function isPermanentTriggerError(error) {
  return ['SESSION_NOT_FOUND', 'TRIGGER_RUN_TERMINAL', 'TRIGGER_STATUS_UNCERTAIN', 'TRIGGER_RESULT_UNCERTAIN', 'TRIGGER_RESULT_CAPACITY','RESPONSIBILITY_TRIGGER_INACTIVE'].includes(error?.code);
}

function occurrenceRequestId(trigger, eventContext = null) {
  if (eventContext?.eventKey) return `${trigger.requestId}:${eventContext.eventKey}`;
  const recorded = (trigger.deliveryResults || []).find((entry) => entry.occurrence === trigger.occurrence);
  if (recorded?.requestId) return recorded.requestId;
  if (!trigger.recurrence || !trigger.occurrence) return trigger.requestId;
  // An old claim may already have submitted the legacy identity before upgrade.
  if (trigger.status === TRIGGER_STATUS_DELIVERING && !trigger.deliveryResults?.length
      && trigger.deliveryAttempts > 1) return trigger.requestId;
  return `${trigger.requestId}:occurrence:${trigger.occurrence}`;
}

async function recordDeliveryResult(triggerId, requestId, change) {
  await withTriggerMutation(async (triggers, save) => {
    const trigger = triggers.find((entry) => entry.id === triggerId);
    if (!trigger) return;
    const results = [...(trigger.deliveryResults || [])];
    const index = results.findIndex((entry) => entry.requestId === requestId);
    const previous = index < 0 ? {} : results[index];
    if (previous.deliveryState === 'published' && change.deliveryState && change.deliveryState !== 'published') return;
    if (index >= 0 && Object.entries(change).every(([key, value]) => previous[key] === value)) return;
    const next = { ...previous, ...change, requestId, responseId: requestId, updatedAt: nowIso() };
    if (change.deliveryState && change.deliveryState !== 'pending' && previous.deliveryState === 'pending') next.terminalAt = previous.terminalAt || nowIso();
    if (change.lastError) {
      next.errors = [...(previous.errors || []), { at: nowIso(), message: change.lastError, attempt: change.attempts || 0 }].slice(-MAX_DELIVERY_ATTEMPTS);
    }
    if (index < 0) {
      if (results.length >= MAX_DELIVERY_RESULTS) {
        const removable = results.findIndex((entry) => entry.deliveryState !== 'pending' && entry.tracking !== true);
        if (removable < 0) throw Object.assign(new Error('Trigger delivery result capacity is exhausted'), { code: 'TRIGGER_RESULT_CAPACITY' });
        results.splice(removable, 1);
      }
      results.push(next);
    } else results[index] = next;
    trigger.deliveryResults = results;
    await save(triggers);
  });
}

async function reconcileDeliveryResult(trigger, result, historyCache) {
  if (!result?.requestId || (result.deliveryState !== 'pending' && result.tracking !== true)) return;
  const rootRun = result.runId ? await getRun(result.runId) : await findRunByRequest(trigger.sessionId, result.requestId);
  let chain;
  try {
    chain = await resolveFailoverRuns(trigger.sessionId, rootRun);
  } catch (error) {
    if (error?.code !== 'TRIGGER_FAILOVER_CHAIN_INVALID') throw error;
    await recordDeliveryResult(trigger.id, result.requestId, {
      deliveryState: 'unknown', tracking: false, lastError: error.message, errorCode: error.code,
    });
    return;
  }
  const run = chain.at(-1) || null;
  const state = trimString(run?.state).toLowerCase();
  const publication = run?.replyPublication || (!run ? await getSessionReplyPublication(trigger.sessionId, result.responseId || result.requestId) : null);
  let published = false;
  let fingerprint = '';
  if (chain.some((entry) => ['completed', 'failed', 'cancelled'].includes(trimString(entry.state).toLowerCase()))) {
    let history;
    try {
      if (!historyCache.has(trigger.sessionId)) {
        historyCache.set(trigger.sessionId, loadMeta(trigger.sessionId, { strict: true }));
      }
      history = await historyCache.get(trigger.sessionId);
      if (!Number.isSafeInteger(history?.latestSeq) || history.latestSeq < 0) throw new Error('History sequence is unavailable');
    } catch (error) {
      await recordDeliveryResult(trigger.id, result.requestId, {
        deliveryState: 'unknown', tracking: true, observationError: trimString(error?.message) || 'History metadata is unavailable',
      });
      return;
    }
    fingerprint = createHash('sha256').update(JSON.stringify({
      latestSeq: history.latestSeq, historyRevision: history.historyRevision,
      runs: chain.map((entry) => [entry.id, entry.state, entry.updatedAt, entry.finalizedAt, entry.supersededByRunId, entry.replyPublication]),
    })).digest('hex');
    if (fingerprint !== result.observationFingerprint) {
      for (const entry of chain) {
        const observed = await hasPublishedReply(trigger.sessionId, entry.requestId, entry, null);
        if (observed === null) { published = null; break; }
        if (observed) { published = true; break; }
      }
    }
  }
  const terminalFailure = ['failed', 'cancelled'].includes(state);
  const publicationState = trimString(publication?.state).toLowerCase();
  const settled = Boolean(run?.finalizedAt && ['ready', 'failed', 'cancelled'].includes(publicationState));
  await recordDeliveryResult(trigger.id, result.requestId, {
    runId: trimString(rootRun?.id) || result.runId || '',
    effectiveRunId: trimString(run?.id) || '',
    executionState: state || (publication?.state === 'queued' ? 'queued' : 'unknown'),
    deliveryState: resolveDeliveryState(run, publication, published),
    tracking: !published && (published === null || !settled),
    observationError: published === null ? 'Reply history could not be read' : '',
    ...(fingerprint && published !== null ? { observationFingerprint: fingerprint } : {}),
    ...(terminalFailure ? { lastError: trimString(run?.failureReason || run?.error?.message || run?.error || publication?.lastError) } : {}),
  });
}

async function resolveFailoverRuns(sessionId, rootRun) {
  if (!rootRun || rootRun.sessionId !== sessionId) return [];
  const seen = new Set([rootRun.id]);
  const chain = [rootRun];
  let current = rootRun;
  for (let depth = 0; depth < 8; depth += 1) {
    const nextId = trimString(current.supersededByRunId);
    if (!nextId) return chain;
    if (seen.has(nextId)) throw Object.assign(new Error('Trigger failover Run chain contains a cycle'), { code: 'TRIGGER_FAILOVER_CHAIN_INVALID' });
    const child = await getRun(nextId);
    const manifest = child ? await getRunManifest(nextId) : null;
    // Ordinary manual regeneration is not a retry of this trigger occurrence.
    if (!child || child.sessionId !== sessionId || manifest?.sessionId !== sessionId
        || manifest?.regenerateParentRunId !== current.id || manifest?.options?.providerFailover !== true) return chain;
    seen.add(nextId);
    current = child;
    chain.push(child);
  }
  if (trimString(current.supersededByRunId)) throw Object.assign(new Error('Trigger failover Run chain exceeds the limit'), { code: 'TRIGGER_FAILOVER_CHAIN_INVALID' });
  return chain;
}

function resolveDeliveryState(run, publication, published) {
  if (published) return 'published';
  const state = trimString(run?.state).toLowerCase();
  return ['completed', 'failed', 'cancelled'].includes(state) ? 'unknown' : 'pending';
}

async function hasPublishedReply(sessionId, requestId, run, publication) {
  if (!run || !['completed', 'failed', 'cancelled'].includes(trimString(run.state).toLowerCase())) return false;
  try {
    const ids = new Set([run.id]);
    const children = new Set([...(run.replyPublication?.continuationRunIds || []), run.replyPublication?.finalRunId].filter(Boolean));
    for (const id of children) {
      if (id === run.id) continue;
      const child = await getRun(id);
      if (child?.sessionId === sessionId && child.replyPublicationRootRunId === run.id) ids.add(id);
    }
    return Boolean(await findLatestAssistantMessage(sessionId, {
    includeBodies: false, strict: true,
    match: (event) => {
      const eventRunId = trimString(event.runId || event.resultRunId);
      return eventRunId ? ids.has(eventRunId) : trimString(event.responseId || event.requestId) === requestId;
    },
    }));
  } catch { return null; }
}

async function assertWritableTargetSession(sessionId) {
  const normalizedSessionId = trimString(sessionId);
  if (!normalizedSessionId) {
    throw new Error('sessionId is required');
  }
  const session = await getSession(normalizedSessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.code = 'SESSION_NOT_FOUND';
    throw error;
  }
  return session;
}

function resetTriggerDeliveryState(trigger) {
  delete trigger.claimedAt;
  delete trigger.deliveredAt;
  delete trigger.lastError;
  delete trigger.lastErrorAt;
  delete trigger.nextAttemptAt;
  delete trigger.runId;
  delete trigger.deliveryMode;
  delete trigger.pendingEventKey;
  delete trigger.pendingEvent;
  trigger.deliveryAttempts = 0;
}

export async function listTriggers(options = {}) {
  const triggers = await loadTriggers();
  const normalizedSessionId = trimString(options.sessionId);
  const filtered = normalizedSessionId
    ? triggers.filter((trigger) => trigger.sessionId === normalizedSessionId)
    : triggers;
  return sortTriggers(filtered).map(cloneTrigger);
}

export async function getTrigger(triggerId) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;
  const triggers = await loadTriggers();
  return cloneTrigger(triggers.find((trigger) => trigger.id === normalizedTriggerId) || null);
}

// Only the server-owned responsibility bridge calls this function; generic
// trigger creation cannot select this action or change its binding.
export async function ensureResponsibilityTrigger(binding) {
  const config=JSON.parse(binding.config_json);
  if(!validTriggerId(binding.trigger_id)||!['at_time','weekly_report'].includes(config.type)||!normalizeTimestamp(config.scheduledAt)) throw new Error('Invalid responsibility trigger binding');
  return withTriggerMutation(async (triggers,saveTriggers)=>{
    const existing=triggers.find(item=>item.id===binding.trigger_id);
    if(existing) {
      if(existing.actionType!==TRIGGER_ACTION_RESPONSIBILITY_WAKE||existing.sessionId!==binding.session_id) throw new Error('Trigger identity conflict');
      if(existing.status===TRIGGER_STATUS_FAILED) { existing.status=TRIGGER_STATUS_PENDING;existing.enabled=true;existing.deliveryAttempts=0;existing.nextAttemptAt='';existing.lastError='';existing.updatedAt=nowIso();await saveTriggers(triggers); }
      return cloneTrigger(existing);
    }
    const timestamp=nowIso();
    const completed=!config.intervalMs&&binding.schedule_occurrence>0;
    const trigger=normalizeStoredTrigger({id:binding.trigger_id,triggerType:TRIGGER_TYPE_AT_TIME,actionType:TRIGGER_ACTION_RESPONSIBILITY_WAKE,status:completed?TRIGGER_STATUS_DELIVERED:TRIGGER_STATUS_PENDING,enabled:!completed,sessionId:binding.session_id,text:'Responsibility wake',scheduledAt:binding.schedule_at,occurrence:binding.schedule_occurrence,recurrence:config.intervalMs?{type:'interval',intervalMs:config.intervalMs}:null,createdAt:timestamp,updatedAt:timestamp});
    if(!trigger) throw new Error('Invalid responsibility trigger');
    triggers.push(trigger);await saveTriggers(triggers);return cloneTrigger(trigger);
  });
}
export async function stopResponsibilityTrigger(triggerId) {
  return withTriggerMutation(async (triggers,saveTriggers)=>{const trigger=triggers.find(item=>item.id===triggerId);if(!trigger)return;if(trigger.actionType!==TRIGGER_ACTION_RESPONSIBILITY_WAKE) throw new Error('Trigger identity conflict');if(trigger.status!==TRIGGER_STATUS_CANCELLED||trigger.enabled){trigger.enabled=false;trigger.status=TRIGGER_STATUS_CANCELLED;trigger.claimedAt='';trigger.nextAttemptAt='';trigger.updatedAt=nowIso();await saveTriggers(triggers);}});
}

export async function createTrigger(input = {}) {
  const session = await assertWritableTargetSession(input.sessionId);
  const eventType = normalizeEventType(input.eventType || input.event?.type);
  const triggerType = eventType ? TRIGGER_TYPE_EVENT : TRIGGER_TYPE_AT_TIME;
  const scheduledAt = triggerType === TRIGGER_TYPE_EVENT
    ? ''
    : requireTimestamp(input.scheduledAt, 'scheduledAt');
  const text = trimString(input.text);
  if (!text) {
    throw new Error('text is required');
  }
  if (triggerType === TRIGGER_TYPE_EVENT && !eventType) {
    throw new Error('eventType is required');
  }
  const recurrence = normalizeRecurrence(input.recurrence || input.schedule);
  const rawRecurrenceType = trimString(
    input.recurrence?.type || input.recurrence?.kind || input.schedule?.type || input.schedule?.kind,
  ).toLowerCase();
  if (rawRecurrenceType && rawRecurrenceType !== 'once' && !recurrence) {
    throw new Error('recurrence must be an interval with intervalMs between 100ms and 365d');
  }

  const id = createTriggerId();
  const createdAt = nowIso();
  const enabled = normalizeBoolean(input.enabled, true);
  const trigger = {
    id,
    triggerType,
    actionType: TRIGGER_ACTION_SESSION_MESSAGE,
    status: enabled ? TRIGGER_STATUS_PENDING : TRIGGER_STATUS_CANCELLED,
    enabled,
    title: trimString(input.title),
    sessionId: session.id,
    scheduledAt,
    text,
    tool: trimString(input.tool),
    model: trimString(input.model),
    effort: trimString(input.effort),
    thinking: input.thinking === true,
    inputMode: normalizeInputMode(input.inputMode),
    requestId: buildTriggerRequestId(id),
    dedupeKey: trimString(input.dedupeKey).slice(0, MAX_DEDUPE_KEY_CHARS),
    createdAt,
    updatedAt: createdAt,
    deliveryAttempts: 0,
    eventType,
    eventFilter: normalizeEventFilter(input.eventFilter),
    recurrence,
    occurrence: 0,
    deliveredEventKeys: [],
    repeat: input.repeat === true,
  };

  await withTriggerMutation(async (triggers, saveTriggers) => {
    if (trigger.dedupeKey) {
      const existing = triggers.find((candidate) => candidate.dedupeKey === trigger.dedupeKey);
      if (existing) {
        trigger.id = existing.id;
        trigger.requestId = existing.requestId;
        Object.assign(trigger, cloneTrigger(existing));
        return;
      }
    }
    triggers.push(trigger);
    await saveTriggers(triggers);
  });
  return cloneTrigger(trigger);
}

export async function updateTrigger(triggerId, patch = {}) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;

  const nextSessionId = Object.prototype.hasOwnProperty.call(patch, 'sessionId')
    ? trimString(patch.sessionId)
    : '';
  if (nextSessionId) {
    await assertWritableTargetSession(nextSessionId);
  }

  let updatedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) {
      updatedTrigger = null;
      return;
    }

    const current = triggers[index];
    if (current.actionType === TRIGGER_ACTION_RESPONSIBILITY_WAKE) throw new Error('Responsibility triggers require owner binding management');
    if (current.status === TRIGGER_STATUS_DELIVERING && !isClaimStale(current)) {
      throw new Error('Trigger is currently delivering');
    }

    const affectsDelivery = [
      'scheduledAt',
      'text',
      'tool',
      'model',
      'effort',
      'thinking',
      'sessionId',
      'enabled',
      'eventType',
      'eventFilter',
      'recurrence',
      'inputMode',
    ].some((key) => Object.prototype.hasOwnProperty.call(patch, key));

    if (current.status === TRIGGER_STATUS_DELIVERED && affectsDelivery) {
      throw new Error('Delivered triggers cannot be modified; create a new trigger instead');
    }

    const next = { ...current };
    let changed = false;

    if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
      const title = trimString(patch.title);
      if (title !== current.title) {
        next.title = title;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'sessionId')) {
      const sessionId = nextSessionId;
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      if (sessionId !== current.sessionId) {
        next.sessionId = sessionId;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'scheduledAt')) {
      if (current.triggerType === TRIGGER_TYPE_EVENT) {
        throw new Error('Event triggers do not use scheduledAt');
      }
      const scheduledAt = requireTimestamp(patch.scheduledAt, 'scheduledAt');
      if (scheduledAt !== current.scheduledAt) {
        next.scheduledAt = scheduledAt;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'eventType')) {
      const eventType = normalizeEventType(patch.eventType);
      if (!eventType) throw new Error('eventType is invalid');
      if (eventType !== current.eventType) {
        next.eventType = eventType;
        next.triggerType = TRIGGER_TYPE_EVENT;
        next.scheduledAt = '';
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'eventFilter')) {
      const eventFilter = normalizeEventFilter(patch.eventFilter);
      if (JSON.stringify(eventFilter) !== JSON.stringify(current.eventFilter || {})) {
        next.eventFilter = eventFilter;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'recurrence')) {
      const recurrence = normalizeRecurrence(patch.recurrence);
      const recurrenceType = trimString(patch.recurrence?.type || patch.recurrence?.kind).toLowerCase();
      if (recurrenceType && recurrenceType !== 'once' && !recurrence) {
        throw new Error('recurrence must be an interval with intervalMs between 100ms and 365d');
      }
      if (JSON.stringify(recurrence) !== JSON.stringify(current.recurrence || null)) {
        next.recurrence = recurrence;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'text')) {
      const text = trimString(patch.text);
      if (!text) {
        throw new Error('text is required');
      }
      if (text !== current.text) {
        next.text = text;
        changed = true;
      }
    }

    for (const field of ['tool', 'model', 'effort']) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
      const value = trimString(patch[field]);
      if (value !== current[field]) {
        next[field] = value;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'thinking')) {
      if (typeof patch.thinking !== 'boolean') {
        throw new Error('thinking must be a boolean');
      }
      if (patch.thinking !== current.thinking) {
        next.thinking = patch.thinking;
        changed = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'inputMode')) {
      const inputMode = normalizeInputMode(patch.inputMode);
      if (inputMode !== current.inputMode) {
        next.inputMode = inputMode;
        changed = true;
      }
    }

    let nextEnabled = current.enabled;
    if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') {
        throw new Error('enabled must be a boolean');
      }
      nextEnabled = patch.enabled;
      if (nextEnabled !== current.enabled) {
        next.enabled = nextEnabled;
        changed = true;
      }
    }

    if (!changed) {
      updatedTrigger = cloneTrigger(current);
      return;
    }

    if (affectsDelivery) {
      if (!nextEnabled) {
        next.status = TRIGGER_STATUS_CANCELLED;
      } else if (current.status === TRIGGER_STATUS_FAILED || current.status === TRIGGER_STATUS_CANCELLED || current.status === TRIGGER_STATUS_DELIVERING) {
        next.status = TRIGGER_STATUS_PENDING;
      }
      if (!isTriggerTerminal(current) || next.status === TRIGGER_STATUS_PENDING || next.status === TRIGGER_STATUS_CANCELLED) {
        resetTriggerDeliveryState(next);
      }
    }

    next.updatedAt = nowIso();
    triggers[index] = next;
    await saveTriggers(triggers);
    updatedTrigger = cloneTrigger(next);
  });

  return updatedTrigger;
}

export async function deleteTrigger(triggerId) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;

  let deletedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) {
      deletedTrigger = null;
      return;
    }
    if (triggers[index].actionType === TRIGGER_ACTION_RESPONSIBILITY_WAKE) throw new Error('Responsibility triggers require owner binding management');
    deletedTrigger = cloneTrigger(triggers[index]);
    triggers.splice(index, 1);
    await saveTriggers(triggers);
  });

  return deletedTrigger;
}

async function claimTriggerForDelivery(triggerId) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;
  const claimAt = nowIso();
  const claimAtMs = Date.parse(claimAt);

  let claimedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) return;
    const current = triggers[index];
    if (!isDueTrigger(current, claimAtMs)) return;
    const next = {
      ...current,
      status: TRIGGER_STATUS_DELIVERING,
      claimedAt: claimAt,
      lastAttemptAt: claimAt,
      nextAttemptAt: '',
      deliveryAttempts: Math.max(0, Number(current.deliveryAttempts) || 0) + 1,
      updatedAt: claimAt,
    };
    triggers[index] = next;
    await saveTriggers(triggers);
    claimedTrigger = cloneTrigger(next);
  });

  return claimedTrigger;
}

async function markTriggerDelivered(triggerId, deliveryResult) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;
  const deliveredAt = nowIso();

  let updatedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) return;
    const current = triggers[index];
    const isEvent = current.triggerType === TRIGGER_TYPE_EVENT;
    if(current.actionType===TRIGGER_ACTION_RESPONSIBILITY_WAKE&&(!current.enabled||current.status!==TRIGGER_STATUS_DELIVERING)) return;
    if(current.actionType===TRIGGER_ACTION_RESPONSIBILITY_WAKE&&(current.occurrence!==deliveryResult?.expectedOccurrence||current.deliveryAttempts!==deliveryResult?.expectedAttempt)) return;
    const repeatingEvent = isEvent && current.repeat === true;
    const recurrence = current.recurrence;
    const nextOccurrence = Math.max(0, Number(current.occurrence) || 0) + 1;
    const recurrenceComplete = Boolean(recurrence?.maxOccurrences && nextOccurrence >= recurrence.maxOccurrences);
    const next = {
      ...current,
      status: repeatingEvent || (recurrence && !isEvent && !recurrenceComplete) ? TRIGGER_STATUS_PENDING : TRIGGER_STATUS_DELIVERED,
      enabled: repeatingEvent || (recurrence && !isEvent && !recurrenceComplete) ? true : false,
      deliveredAt,
      lastDeliveredAt: deliveredAt,
      updatedAt: deliveredAt,
      claimedAt: '',
      nextAttemptAt: '',
      lastError: '',
      lastErrorAt: '',
      runId: trimString(deliveryResult?.runId),
      deliveryMode: deliveryResult?.statusNotified === true
        ? 'status'
        : deliveryResult?.queued ? 'queued' : 'run',
      occurrence: nextOccurrence,
      deliveryAttempts: 0,
      pendingEventKey: '',
      pendingEvent: null,
      ...(isEvent && deliveryResult?.eventKey
        ? { deliveredEventKeys: [...(current.deliveredEventKeys || []), deliveryResult.eventKey].slice(-MAX_EVENT_KEYS) }
        : {}),
    };
    if (recurrence && !isEvent && !recurrenceComplete) {
      next.scheduledAt = deliveryResult?.nextScheduledAt || new Date(Date.parse(deliveredAt) + recurrence.intervalMs).toISOString();
      next.deliveredAt = '';
      next.runId = '';
      next.deliveryMode = '';
    }
    triggers[index] = next;
    await saveTriggers(triggers);
    updatedTrigger = cloneTrigger(next);
  });

  return updatedTrigger;
}

async function markTriggerDeliveryFailure(triggerId, error, attemptCount = 1) {
  const normalizedTriggerId = trimString(triggerId);
  if (!normalizedTriggerId) return null;
  const failedAt = nowIso();
  // An incident may still be acquiring its durable binding, or its authorized
  // continuation configuration may later become available. Keep it queued.
  const waitingForRuntime = error?.code === 'TRIGGER_INCIDENT_RUNTIME_PENDING';
  const exhausted = !waitingForRuntime && (isPermanentTriggerError(error) || attemptCount >= MAX_DELIVERY_ATTEMPTS);
  const retryDelayMs = resolveRetryDelayMs(attemptCount);

  let updatedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) return;
    const current = triggers[index];
    if(current.actionType===TRIGGER_ACTION_RESPONSIBILITY_WAKE&&(!current.enabled||current.status!==TRIGGER_STATUS_DELIVERING||current.deliveryAttempts!==attemptCount)) return;
    const next = {
      ...current,
      status: exhausted ? TRIGGER_STATUS_FAILED : TRIGGER_STATUS_PENDING,
      enabled: exhausted ? false : current.enabled,
      claimedAt: '',
      updatedAt: failedAt,
      lastError: trimString(error?.message) || 'Trigger delivery failed',
      lastErrorAt: failedAt,
      runId: trimString(error?.runId) || current.runId,
      nextAttemptAt: exhausted ? '' : new Date(Date.now() + retryDelayMs).toISOString(),
    };
    triggers[index] = next;
    await saveTriggers(triggers);
    updatedTrigger = cloneTrigger(next);
  });

  return updatedTrigger;
}

async function appendTriggerStatusEvent(trigger, outcome) {
  const event = statusEvent(buildTriggerStatusText(trigger, { queued: outcome?.queued === true }));
  event.requestId = trigger.requestId;
  if (trimString(outcome?.runId)) {
    event.runId = trimString(outcome.runId);
  }
  await appendEvent(trigger.sessionId, event);
}

function renderTriggerText(trigger, eventContext = null) {
  if (!eventContext) return trigger.text;
  const payload = eventContext.payload || {};
  const rendered = trigger.text.replace(/\{\{\s*event\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_, path) => {
    const value = path.split('.').reduce((current, part) => (
      current && typeof current === 'object' ? current[part] : undefined
    ), payload);
    return value === undefined || value === null ? '' : String(value);
  });
  return `${rendered}\n\nRagent event: ${eventContext.type}\n${JSON.stringify(payload)}`.slice(0, 64 * 1024);
}

async function deliverTrigger(trigger, eventContext = null) {
  if (trigger.actionType === TRIGGER_ACTION_RESPONSIBILITY_WAKE) {
    if(eventContext) throw new Error('Event responsibility triggers are unsupported');
    const {deliverResponsibilityTrigger}=await import('./responsibility-trigger-bridge.mjs');
    const outcome=await deliverResponsibilityTrigger(trigger);
    await markTriggerDelivered(trigger.id,{nextScheduledAt:outcome.nextScheduledAt,expectedOccurrence:trigger.occurrence,expectedAttempt:trigger.deliveryAttempts});
    return outcome;
  }
  const session = await assertWritableTargetSession(trigger.sessionId);
  const requestId = occurrenceRequestId(trigger, eventContext);
  const inputMode = normalizeInputMode(trigger.inputMode);
  const priorResult = (trigger.deliveryResults || []).find((entry) => entry.requestId === requestId);
  if (priorResult?.deliveryState === 'published') {
    const outcome = { duplicate: true, run: priorResult.runId ? { id: priorResult.runId } : null };
    if (!eventContext) await markTriggerDelivered(trigger.id, { runId: priorResult.runId });
    return outcome;
  }
  if (inputMode === TRIGGER_INPUT_MODE_STATUS_NOTIFICATION && priorResult?.statusAttempted) {
    if (priorResult.statusRecorded) {
      const outcome = { statusNotified: true };
      if (!eventContext) await markTriggerDelivered(trigger.id, outcome);
      return outcome;
    }
    throw Object.assign(new Error('Status notification outcome is uncertain'), { code: 'TRIGGER_STATUS_UNCERTAIN' });
  }
  await recordDeliveryResult(trigger.id, requestId, {
    occurrence: trigger.occurrence, scheduledAt: trigger.scheduledAt, firedAt: priorResult?.firedAt || trigger.lastAttemptAt,
    executionState: 'preparing', deliveryState: 'pending', attempts: trigger.deliveryAttempts,
  });
  if (inputMode === TRIGGER_INPUT_MODE_STATUS_NOTIFICATION) {
    const outcome = { duplicate: false, queued: false, run: null, statusNotified: true };
    await recordDeliveryResult(trigger.id, requestId, { statusAttempted: true });
    await appendTriggerStatusEvent({ ...trigger, requestId }, outcome);
    await recordDeliveryResult(trigger.id, requestId, { acceptedAt: nowIso(), executionState: 'completed', deliveryState: 'unknown', deliveryMode: 'status', statusRecorded: true });
    if (!eventContext) {
      await markTriggerDelivered(trigger.id, outcome);
    }
    return outcome;
  }

  const internalContinuation = inputMode === TRIGGER_INPUT_MODE_INTERNAL_CONTINUATION;
  let selectedTool = trigger.tool || undefined;
  const sameSessionTool = !trigger.tool || trigger.tool === session.tool;
  let selectedModel = trigger.model || undefined;
  let selectedProvider;
  let selectedEffort = trigger.effort || undefined;
  let boundContinuation = false;
  const incidentWake = trigger.dedupeKey?.startsWith('agent-interruption:');
  const childWake = eventContext?.type === 'run_terminal' && trigger.dedupeKey?.startsWith('delegated-child-terminal:');
  const nativeWake = trigger.dedupeKey?.startsWith('native:');
  if (incidentWake || childWake || nativeWake) {
    const { incidentContinuationRuntime, validateIncidentContinuationRuntime } = await import('./incident-continuation-runtime.mjs');
    const context = await incidentContinuationRuntime(trigger, session, eventContext);
    if (context?.ordinary) {
      selectedTool = trigger.tool || undefined;
      selectedModel = trigger.model || undefined;
      selectedProvider = undefined;
      selectedEffort = trigger.effort || undefined;
    } else {
      selectedTool = trigger.tool || session.tool || undefined;
      selectedModel = trigger.model || (sameSessionTool ? session.model : undefined) || undefined;
      selectedProvider = !trigger.model && sameSessionTool ? session.providerProfile || undefined : undefined;
      selectedEffort = trigger.effort || (!trigger.model && sameSessionTool && session.model ? session.effort : undefined) || undefined;
      const manifest = context?.manifest;
      const sourceTool = manifest?.tool;
      const sourceModel = manifest?.options?.model;
      const sourceProvider = manifest?.options?.providerProfile;
      const { parseScopedCodexModel } = await import('./models.mjs');
      const scopedProvider = parseScopedCodexModel(sourceModel).providerId;
      if (!context || (!selectedModel && (!sourceModel || (selectedTool && selectedTool !== sourceTool)
          || (sourceProvider && scopedProvider && sourceProvider !== scopedProvider)
          || (selectedProvider && selectedProvider !== (sourceProvider || scopedProvider))))) {
        throw Object.assign(new Error('Incident continuation runtime is unavailable; notification remains pending'), { code: 'TRIGGER_INCIDENT_RUNTIME_PENDING' });
      }
      if (!selectedModel) {
        selectedTool = sourceTool;
        selectedModel = sourceModel;
        selectedProvider = selectedProvider || sourceProvider || scopedProvider || undefined;
        selectedEffort = selectedEffort || manifest.options.effort || undefined;
      }
      try {
        const validated = await validateIncidentContinuationRuntime(context, session, { tool: selectedTool,
          model: selectedModel, provider: selectedProvider || parseScopedCodexModel(selectedModel).providerId || undefined, effort: selectedEffort });
        selectedTool = validated.tool; selectedModel = validated.model;
        selectedProvider = validated.provider || undefined; selectedEffort = validated.effort || undefined;
      } catch {
        throw Object.assign(new Error('Incident continuation runtime no longer meets current policy; notification remains pending'), { code: 'TRIGGER_INCIDENT_RUNTIME_PENDING' });
      }
      boundContinuation = true;
    }
  }
  const outcome = await submitHttpMessage(session.id, renderTriggerText(trigger, eventContext), [], {
    requestId,
    tool: selectedTool,
    model: selectedModel,
    providerProfile: selectedProvider,
    effort: selectedEffort,
    ...(boundContinuation ? { providerFailover: false } : {}),
    thinking: trigger.thinking === true,
    internalOperation: internalContinuation ? 'trigger_internal_continuation' : 'trigger_delivery',
    ...(internalContinuation ? {
      recordUserMessage: false,
      queueIfBusy: false,
      deferIfBusy: true,
      skipSessionContinuation: true,
      sourceContext: {
        kind: 'trigger_internal_continuation',
        triggerId: trigger.id,
        ...(eventContext ? { eventType: eventContext.type, eventKey: eventContext.eventKey } : {}),
      },
    } : {}),
  });

  if (outcome?.deferred === true) {
    const error = new Error('Trigger target session is busy');
    error.code = 'TRIGGER_TARGET_BUSY';
    throw error;
  }

  const run = outcome?.run || await findRunByRequest(session.id, requestId);
  const publication = await getSessionReplyPublication(session.id, requestId);
  const published = await hasPublishedReply(session.id, requestId, run, publication);
  const runState = trimString(run?.state).toLowerCase();
  if (outcome?.duplicate && !priorResult?.acceptedAt && ['failed', 'cancelled'].includes(runState) && !published) {
    const error = new Error(trimString(run?.failureReason || run?.error?.message || run?.error || publication?.lastError) || `Trigger run ${runState}`);
    error.code = published === null ? 'TRIGGER_RESULT_UNCERTAIN' : 'TRIGGER_RUN_TERMINAL';
    error.runId = run.id;
    throw error;
  }
  if (!run && !outcome.queued && !['queued', 'checking', 'preparing', 'running'].includes(publication?.state)) {
    const error = new Error('Trigger submission result is uncertain');
    error.code = 'TRIGGER_RESULT_UNCERTAIN';
    throw error;
  }
  await recordDeliveryResult(trigger.id, requestId, {
    acceptedAt: nowIso(), runId: trimString(run?.id),
    executionState: runState || (outcome.queued || publication?.state === 'queued' ? 'queued' : 'unknown'),
    deliveryState: resolveDeliveryState(run, publication, published),
    tracking: !published,
  });

  if (!outcome.duplicate) {
    await appendTriggerStatusEvent({ ...trigger, requestId }, {
      queued: outcome.queued === true,
      runId: trimString(outcome?.run?.id),
    }).catch((error) => console.error(`[triggers] failed to append status event for ${trigger.id}: ${error.message}`));
  }

  if (!eventContext) {
    await markTriggerDelivered(trigger.id, {
      queued: outcome.queued === true,
      runId: trimString(outcome?.run?.id),
    });
  }
  return outcome;
}

async function attemptTriggerDelivery(triggerId) {
  const trigger = await claimTriggerForDelivery(triggerId);
  if (!trigger) return null;

  try {
    await deliverTrigger(trigger);
    return await getTrigger(trigger.id);
  } catch (error) {
    if(trigger.actionType===TRIGGER_ACTION_RESPONSIBILITY_WAKE) {
      await markTriggerDeliveryFailure(trigger.id,error,trigger.deliveryAttempts||1);
      return getTrigger(trigger.id);
    }
    const requestId = occurrenceRequestId(trigger);
    const run = await findRunByRequest(trigger.sessionId, requestId);
    const published = await hasPublishedReply(trigger.sessionId, requestId, run, null);
    if (published) {
      await recordDeliveryResult(trigger.id, requestId, { runId: run.id, executionState: trimString(run.state), deliveryState: 'published' });
      return await markTriggerDelivered(trigger.id, { runId: run.id });
    }
    const terminal = ['failed', 'cancelled'].includes(trimString(run?.state).toLowerCase());
    const sourceCode = trimString(error?.code);
    if (terminal) { error.code = published === null ? 'TRIGGER_RESULT_UNCERTAIN' : 'TRIGGER_RUN_TERMINAL'; error.runId = run.id; }
    await recordDeliveryResult(trigger.id, requestId, {
      runId: trimString(run?.id), executionState: trimString(run?.state) || 'unknown',
      deliveryState: terminal || isPermanentTriggerError(error) || (sourceCode !== 'TRIGGER_INCIDENT_RUNTIME_PENDING' && trigger.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) ? 'unknown' : 'pending',
      lastError: trimString(error?.message), errorCode: sourceCode,
      causeCode: trimString(error?.causeCode || error?.providerPreparation?.causeCode),
      stage: trimString(error?.launchStage || error?.stage), attempts: trigger.deliveryAttempts,
    }).catch((recordError) => console.error(`[triggers] could not record delivery failure: ${recordError.message}`));
    await markTriggerDeliveryFailure(trigger.id, error, trigger.deliveryAttempts || 1);
    console.error(`[triggers] failed to deliver ${trigger.id}: ${error.message}`);
    return await getTrigger(trigger.id);
  }
}

async function claimEventTriggerForDelivery(triggerId, eventContext) {
  const normalizedTriggerId = trimString(triggerId);
  const key = trimString(eventContext?.eventKey);
  if (!normalizedTriggerId || !key) return null;
  let claimedTrigger = null;
  await withTriggerMutation(async (triggers, saveTriggers) => {
    const index = triggers.findIndex((trigger) => trigger.id === normalizedTriggerId);
    if (index === -1) return;
    const current = triggers[index];
    const staleDelivery = current.status === TRIGGER_STATUS_DELIVERING && isClaimStale(current);
    const pendingRetry = current.status === TRIGGER_STATUS_PENDING && Boolean(current.pendingEventKey);
    const nextAttemptAtMs = Date.parse(current.nextAttemptAt || '');
    if (!current.enabled || current.triggerType !== TRIGGER_TYPE_EVENT
        || (current.status !== TRIGGER_STATUS_PENDING && !staleDelivery)
        || current.eventType !== eventContext.type
        || !eventFilterMatches(current.eventFilter, eventContext.payload)
        || (current.deliveredEventKeys || []).includes(key)
        || (pendingRetry && current.pendingEventKey !== key)
        || (pendingRetry && Number.isFinite(nextAttemptAtMs) && nextAttemptAtMs > Date.now())) return;
    const now = nowIso();
    const next = {
      ...current,
      status: TRIGGER_STATUS_DELIVERING,
      claimedAt: now,
      lastAttemptAt: now,
      nextAttemptAt: '',
      pendingEventKey: key,
      pendingEvent: clipEventPayload({ type: eventContext.type, payload: eventContext.payload }),
      deliveryAttempts: Math.max(0, Number(current.deliveryAttempts) || 0) + 1,
      updatedAt: now,
    };
    triggers[index] = next;
    await saveTriggers(triggers);
    claimedTrigger = cloneTrigger(next);
  });
  return claimedTrigger;
}

async function attemptEventTriggerDelivery(triggerId, eventContext) {
  const trigger = await claimEventTriggerForDelivery(triggerId, eventContext);
  if (!trigger) return null;
  try {
    const outcome = await deliverTrigger(trigger, eventContext);
    return await markTriggerDelivered(trigger.id, {
      eventKey: eventContext.eventKey,
      queued: outcome?.queued === true,
      statusNotified: outcome?.statusNotified === true,
      runId: trimString(outcome?.run?.id),
    });
  } catch (error) {
    const requestId = occurrenceRequestId(trigger, eventContext);
    const run = await findRunByRequest(trigger.sessionId, requestId);
    const published = await hasPublishedReply(trigger.sessionId, requestId, run, null);
    if (published) {
      await recordDeliveryResult(trigger.id, requestId, { runId: run.id, executionState: trimString(run.state), deliveryState: 'published' });
      return await markTriggerDelivered(trigger.id, { eventKey: eventContext.eventKey, runId: run.id });
    }
    const terminal = ['failed', 'cancelled'].includes(trimString(run?.state).toLowerCase());
    const sourceCode = trimString(error?.code);
    if (terminal) { error.code = published === null ? 'TRIGGER_RESULT_UNCERTAIN' : 'TRIGGER_RUN_TERMINAL'; error.runId = run.id; }
    await recordDeliveryResult(trigger.id, requestId, {
      runId: trimString(run?.id), executionState: trimString(run?.state) || 'unknown',
      deliveryState: terminal || isPermanentTriggerError(error) || (sourceCode !== 'TRIGGER_INCIDENT_RUNTIME_PENDING' && trigger.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) ? 'unknown' : 'pending',
      lastError: trimString(error?.message), errorCode: sourceCode,
      causeCode: trimString(error?.causeCode || error?.providerPreparation?.causeCode),
      stage: trimString(error?.launchStage || error?.stage), attempts: trigger.deliveryAttempts,
    }).catch((recordError) => console.error(`[triggers] could not record delivery failure: ${recordError.message}`));
    await markTriggerDeliveryFailure(trigger.id, error, trigger.deliveryAttempts || 1);
    console.error(`[triggers] failed to deliver event ${trigger.id}: ${error.message}`);
    return await getTrigger(trigger.id);
  }
}

export async function emitTriggerEvent(type, payload = {}, { suppressDelegatedChildWake = false } = {}) {
  const eventType = normalizeEventType(type);
  if (!eventType) throw new Error(`Unsupported trigger event type: ${type}`);
  const eventPayload = clipEventPayload(payload);
  const context = { type: eventType, payload: eventPayload, eventKey: eventKey(eventType, eventPayload) };
  const triggers = await loadTriggers();
  let delivered = 0;
  for (const trigger of sortTriggers(triggers)) {
    if (trigger.triggerType !== TRIGGER_TYPE_EVENT || trigger.eventType !== eventType
        || !eventFilterMatches(trigger.eventFilter, eventPayload)) continue;
    // Only the server's automatically created delegated-child wake is
    // suppressed after an incident for this exact terminal Run is durable.
    // Owner-created event subscriptions are never filtered here.
    if (suppressDelegatedChildWake === true && eventType === 'run_terminal'
        && trimString(eventPayload.runId) && eventPayload.eventId === eventPayload.runId
        && trigger.dedupeKey === `delegated-child-terminal:${trigger.sessionId}:${eventPayload.sessionId}`) continue;
    const result = await attemptEventTriggerDelivery(trigger.id, context);
    if (result?.deliveredEventKeys?.includes(context.eventKey)) delivered += 1;
  }
  return { eventType, eventKey: context.eventKey, delivered };
}

export async function processDueTriggersNow() {
  if (triggerTickPromise) return triggerTickPromise;

  triggerTickPromise = (async () => {
    try { const {reconcileResponsibilityTriggerBindings}=await import('./responsibility-trigger-bridge.mjs'); await reconcileResponsibilityTriggerBindings(); const {processResponsibilityTriggerEvents}=await import('./responsibility-trigger-events.mjs'); await processResponsibilityTriggerEvents(); }
    catch(error) { console.error(`[triggers] responsibility binding reconciliation unavailable: ${error.message}`); }
    const nowMs = Date.now();
    const triggers = await loadTriggers();
    const historyCache = new Map();
    for (const trigger of triggers) {
      for (const result of trigger.deliveryResults || []) {
        if (result.deliveryState === 'pending' || result.tracking === true) await reconcileDeliveryResult(trigger, result, historyCache).catch((error) => console.error(`[triggers] result reconciliation failed for ${trigger.id}: ${error.message}`));
      }
    }
    const due = sortTriggers(triggers).filter((trigger) => isDueTrigger(trigger, nowMs));
    for (const trigger of due) {
      await attemptTriggerDelivery(trigger.id);
    }
    const eventRetries = sortTriggers(triggers).filter((trigger) => isDueEventRetry(trigger, nowMs));
    for (const trigger of eventRetries) {
      const pending = trigger.pendingEvent;
      await attemptEventTriggerDelivery(trigger.id, {
        type: pending?.type || trigger.eventType,
        payload: pending?.payload || {},
        eventKey: trigger.pendingEventKey,
      });
    }
    return due.length + eventRetries.length;
  })().finally(() => {
    if (triggerTickPromise) {
      triggerTickPromise = null;
    }
  });

  return triggerTickPromise.finally(() => {
    scheduleTriggerWake();
  });
}

async function resolveNextTriggerDelayMs() {
  const triggers = await loadTriggers();
  const nowMs = Date.now();
  const future = triggers
    .filter((trigger) => trigger?.enabled
      && trigger?.status === TRIGGER_STATUS_PENDING
      && (trigger.triggerType === TRIGGER_TYPE_AT_TIME
        || (trigger.triggerType === TRIGGER_TYPE_EVENT && trigger.pendingEventKey && trigger.pendingEvent)))
    .map((trigger) => {
      const scheduledAt = trigger.triggerType === TRIGGER_TYPE_EVENT
        ? nowMs
        : Date.parse(trigger.scheduledAt || '');
      const nextAttemptAt = Date.parse(trigger.nextAttemptAt || '');
      return Math.max(nowMs, scheduledAt, Number.isFinite(nextAttemptAt) ? nextAttemptAt : nowMs) - nowMs;
    })
    .filter((delay) => Number.isFinite(delay) && delay >= 0);
  const pollMs = Number.isInteger(triggerSchedulerOptions.pollMs) && triggerSchedulerOptions.pollMs > 0
    ? triggerSchedulerOptions.pollMs
    : MAX_TRIGGER_IDLE_DELAY_MS;
  if (triggers.some((trigger) => trigger.deliveryResults?.some((result) => result.deliveryState === 'pending' || result.tracking === true))) {
    future.push(DEFAULT_TRIGGER_POLL_MS);
  }
  if (future.length === 0) return Math.min(MAX_TRIGGER_IDLE_DELAY_MS, pollMs);
  return Math.max(0, Math.min(...future, MAX_TRIGGER_IDLE_DELAY_MS, pollMs));
}

function scheduleTriggerWake(delayMs = null) {
  if (!triggerSchedulerOptions.enabled || triggerSchedulerTimer) return;
  const wake = async () => {
    triggerSchedulerTimer = null;
    await processDueTriggersNow().catch(() => {});
    if (triggerSchedulerOptions.enabled) scheduleTriggerWake();
  };
  if (delayMs == null) {
    void resolveNextTriggerDelayMs().then((delay) => scheduleTriggerWake(delay)).catch(() => scheduleTriggerWake(MAX_TRIGGER_IDLE_DELAY_MS));
    return;
  }
  triggerSchedulerTimer = setTimeout(() => { void wake(); }, Math.max(0, delayMs));
  triggerSchedulerTimer.unref?.();
}

function rescheduleTriggerWake(delayMs = 0) {
  if (triggerSchedulerTimer) {
    clearTimeout(triggerSchedulerTimer);
    triggerSchedulerTimer = null;
  }
  scheduleTriggerWake(delayMs);
}

export function startTriggerScheduler(options = {}) {
  if (triggerSchedulerOptions.enabled) return triggerSchedulerTimer;
  triggerSchedulerOptions = { enabled: true, pollMs: resolveTriggerPollMs(options.pollMs) };
  scheduleTriggerWake(0);
  return triggerSchedulerTimer;
}

export function stopTriggerScheduler() {
  const wasRunning = triggerSchedulerOptions.enabled || Boolean(triggerSchedulerTimer);
  triggerSchedulerOptions = { enabled: false };
  if (triggerSchedulerTimer) clearTimeout(triggerSchedulerTimer);
  triggerSchedulerTimer = null;
  return wasRunning;
}

export const TRIGGER_TYPES = Object.freeze({ AT_TIME: TRIGGER_TYPE_AT_TIME, EVENT: TRIGGER_TYPE_EVENT });
export const TRIGGER_EVENT_NAMES = Object.freeze([...TRIGGER_EVENT_TYPES]);
