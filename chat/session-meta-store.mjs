import { dirname } from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isEnvToggleEnabled } from '../lib/env-toggle.mjs';
import { CHAT_SESSIONS_FILE } from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  ensureDir,
  readJson,
  readJsonStrict,
  statOrNull,
  writeJsonAtomic,
} from './fs-utils.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';
import { normalizeSessionAgreements } from './session-agreements.mjs';
import {
  SESSION_API_RECEIPT_LIMIT, applySessionApiChange, captureSessionApiRevisions,
  parseSessionApiMutation, projectSessionApiContext, sessionApiError, sessionApiFingerprint,
  sessionApiIdentifier, sessionApiProject, sessionApiReceipts, sessionApiScopeFingerprint,
  stampSessionApiRevisions, validateSessionApiStoredMeta,
} from './session-api-mutation-contract.mjs';
import { assertSessionApiScope, parseSessionApiScope } from './session-api-scope-contract.mjs';
import { messagePreparations } from './message-preparation-contract.mjs';
import { currentMessageExecution, withoutMessageExecution } from './message-execution-context.mjs';
import { normalizeSessionEntryMode } from './session-entry-mode.mjs';
import { normalizeStoredSessionFolder } from './session-folder.mjs';
import { normalizeSessionTaskCard } from './session-task-card.mjs';
import { normalizeSessionGoal } from './session-goal.mjs';
import { DEFAULT_APP_ID, getBuiltinApp, normalizeAppId } from './apps.mjs';
import { normalizeSessionStarterPreset } from './session-starter-preset.mjs';
import {
  MANAGED_SESSION_CLASSES,
  normalizeSessionClass,
} from './managed-input.mjs';

let sessionsMetaCache = null;
let sessionsMetaCacheMtimeMs = null;
let sessionsMetaWritesInFlight = 0;
// Perf (RAGENT_PERF_WRITE_DEBOUNCE=off / RAGENT_PERF_COMPACT_JSON=off):
// every session-meta mutation used to rewrite the whole chat-sessions.json
// (1.76MB, pretty-printed) through one global serial queue, so each mutation
// blocked every session's meta writes. Now the in-memory cache updates
// immediately and the file rewrite is debounced (≤800ms), with boot-recovery
// critical mutations (session creation and activeRunId) flushing
// immediately. A hard crash inside the window loses at most rearrangeable UI
// state (name/pin/taskCard/goal/...); scope changes and explicit API mutations
// now persist before returning. activeRunId — the only field
// boot rehydration reads — and run state (which lives in chat-runs) survive.
const RAGENT_PERF_WRITE_DEBOUNCE_ENV = 'RAGENT_PERF_WRITE_DEBOUNCE';
const PERF_WRITE_DEBOUNCE_ENABLED = isEnvToggleEnabled(process.env[RAGENT_PERF_WRITE_DEBOUNCE_ENV], { defaultValue: true });
const RAGENT_PERF_COMPACT_JSON_ENV = 'RAGENT_PERF_COMPACT_JSON';
const PERF_COMPACT_JSON_ENABLED = isEnvToggleEnabled(process.env[RAGENT_PERF_COMPACT_JSON_ENV], { defaultValue: true });
const SESSIONS_META_FLUSH_DELAY_MS = 800;
const COMPACT_JSON_OPTIONS = PERF_COMPACT_JSON_ENABLED ? { spaces: 0 } : {};
let sessionsMetaFlushTimer = null;
let sessionsMetaDirty = false;
const runSessionsMetaMutation = createSerialTaskQueue();
const sessionsMetaTransactionContext = new AsyncLocalStorage();
const runSessionsMetaFileWrite = createSerialTaskQueue();
let sessionApiRevisionBaselines = new Map();
let activeSessionApiScopeGuard = null;

function currentMetaTransaction() {
  const context = sessionsMetaTransactionContext.getStore();
  return context?.transaction || context;
}

/** Upload staging/asset locks must be acquired before this metadata actor. */
export function assertOutsideSessionMetaTransaction() {
  if (currentMetaTransaction()?.active)
    throw sessionApiError('REVISION_CONFLICT', 409, 'Acquire upload resources outside the Session metadata transaction');
}

function checkGuardedScope(list) {
  const transaction = currentMetaTransaction();
  const guard = transaction?.active && transaction.scopeGuard;
  if (!guard) return;
  const meta = list.find(row => row.id === guard.scope.sessionId);
  assertSessionApiScope(meta, guard.scope);
  if (sessionApiScopeFingerprint(meta) !== guard.fingerprint)
    throw sessionApiError('REVISION_CONFLICT', 409, 'Scoped operation cannot change its resource scope');
}

function runSessionsMetaTransaction(task) {
  const execution = currentMessageExecution();
  if (execution) return withCurrentMessageScope(task);
  const transaction = currentMetaTransaction();
  if (transaction?.active && transaction.scopeGuard) {
    const context = sessionsMetaTransactionContext.getStore();
    // Reads can reuse their current transaction through loadSessionsMeta.
    // Nested mutation callbacks must not reenter: parallel async children
    // would otherwise read separate drafts and silently overwrite each other.
    if (context?.nested?.active)
      throw sessionApiError('REVISION_CONFLICT', 409, 'Nested Session metadata transactions are unsupported');
    return transaction.scopeGuard.nestedQueue(() => {
      const nested = { active: true };
      return sessionsMetaTransactionContext.run({ transaction, nested }, async () => {
        try { return await task(); }
        finally { nested.active = false; }
      });
    });
  }
  return runSessionsMetaMutation(() => {
    const transaction = { active: true };
    return sessionsMetaTransactionContext.run(transaction, async () => {
      try { return await task(); }
      finally { transaction.active = false; }
    });
  });
}

function normalizeStoredTimestamp(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function normalizeStoredSidebarOrder(value) {
  const parsed = typeof value === 'number'
    ? value
    : parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeStoredSessionSourceName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeStoredSessionTemplateName(value) {
  return normalizeStoredSessionSourceName(value);
}

function formatStoredSourceNameFromId(sourceId) {
  const normalized = typeof sourceId === 'string' ? sourceId.trim() : '';
  if (!normalized) return 'Chat';
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeStoredSessionSourceFields(normalized) {
  let changed = false;

  const explicitSourceId = normalizeAppId(normalized.sourceId);
  const nextSourceId = explicitSourceId || DEFAULT_APP_ID;

  if (normalized.sourceId !== nextSourceId) {
    normalized.sourceId = nextSourceId;
    changed = true;
  }

  const explicitSourceName = normalizeStoredSessionSourceName(normalized.sourceName);
  let nextSourceName = explicitSourceName;
  if (!nextSourceName && nextSourceId !== DEFAULT_APP_ID) {
    const builtinSource = getBuiltinApp(nextSourceId);
    nextSourceName = builtinSource?.name || formatStoredSourceNameFromId(nextSourceId);
  }

  if (nextSourceName) {
    if (normalized.sourceName !== nextSourceName) {
      normalized.sourceName = nextSourceName;
      changed = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(normalized, 'sourceName')) {
    delete normalized.sourceName;
    changed = true;
  }

  return changed;
}

function normalizeStoredSessionTemplateFields(normalized) {
  let changed = false;

  const nextTemplateId = normalizeAppId(normalized.templateId || normalized.agentId);
  if (nextTemplateId) {
    if (normalized.templateId !== nextTemplateId) {
      normalized.templateId = nextTemplateId;
      changed = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(normalized, 'templateId')) {
    delete normalized.templateId;
    changed = true;
  }

  const nextTemplateName = normalizeStoredSessionTemplateName(normalized.templateName);
  if (nextTemplateName) {
    if (normalized.templateName !== nextTemplateName) {
      normalized.templateName = nextTemplateName;
      changed = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(normalized, 'templateName')) {
    delete normalized.templateName;
    changed = true;
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'agentId')) {
    delete normalized.agentId;
    changed = true;
  }

  return changed;
}

function normalizeStoredStarterPreset(normalized) {
  let changed = false;
  const nextStarterPreset = normalizeSessionStarterPreset(normalized.starterPreset);

  if (nextStarterPreset) {
    if (normalized.starterPreset !== nextStarterPreset) {
      normalized.starterPreset = nextStarterPreset;
      changed = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(normalized, 'starterPreset')) {
    delete normalized.starterPreset;
    changed = true;
  }

  return changed;
}

// Before the risk-gated default shipped, ordinary sessions persisted
// `riskMode: full-auto` as their default. Keep an explicit opt-out distinct
// from that historical default so the rollout can migrate old sessions without
// taking away a deliberate full-auto choice made after the migration.
function normalizeStoredSessionRiskFields(normalized) {
  let changed = false;
  const riskMode = typeof normalized.riskMode === 'string'
    ? normalized.riskMode.trim().toLowerCase()
    : '';
  const explicit = normalized.riskModeExplicit === true;

  if (riskMode && !['safe', 'recommended', 'full-auto', 'conservative-auto'].includes(riskMode)) {
    delete normalized.riskMode;
    changed = true;
  } else if (riskMode && normalized.riskMode !== riskMode) {
    normalized.riskMode = riskMode;
    changed = true;
  }

  if (riskMode === 'full-auto' && !explicit) {
    normalized.riskMode = 'recommended';
    changed = true;
  }

  if (explicit && riskMode !== 'full-auto') {
    delete normalized.riskModeExplicit;
    changed = true;
  } else if (Object.prototype.hasOwnProperty.call(normalized, 'riskModeExplicit') && !explicit) {
    delete normalized.riskModeExplicit;
    changed = true;
  }

  return changed;
}

function normalizeStoredSessionMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { meta: null, changed: true };
  }

  const normalized = { ...meta };
  let changed = false;

  for (const legacyField of ['activeRun', 'status', 'queuedMessageCount', 'pendingCompact', 'renameState', 'renameError', 'recoverable']) {
    if (Object.prototype.hasOwnProperty.call(normalized, legacyField)) {
      delete normalized[legacyField];
      changed = true;
    }
  }

  for (const derivedField of ['managerState', 'workState']) {
    if (Object.prototype.hasOwnProperty.call(normalized, derivedField)) {
      delete normalized[derivedField];
      changed = true;
    }
  }

  for (const legacyField of ['appId', 'appName', 'templateAppId', 'templateAppName']) {
    if (Object.prototype.hasOwnProperty.call(normalized, legacyField)) {
      delete normalized[legacyField];
      changed = true;
    }
  }

  changed = normalizeStoredSessionSourceFields(normalized) || changed;
  changed = normalizeStoredSessionTemplateFields(normalized) || changed;
  changed = normalizeStoredStarterPreset(normalized) || changed;
  changed = normalizeStoredSessionRiskFields(normalized) || changed;

  // S15 compatibility projection. Historical user sessions become explicit
  // root-addressable sessions on read; system sessions stay unclassified.
  const plane = typeof normalized.sessionPlane === 'string'
    ? normalized.sessionPlane.trim().toLowerCase()
    : 'user';
  const explicitClass = Object.prototype.hasOwnProperty.call(normalized, 'sessionClass');
  const sessionClass = normalizeSessionClass(normalized.sessionClass);
  const isLegacyDelegatedSession = !explicitClass
    && plane === 'user'
    && (typeof normalized.delegatedFromSessionId === 'string' && normalized.delegatedFromSessionId.trim());
  if (!explicitClass && plane === 'user' && !isLegacyDelegatedSession) {
    normalized.sessionClass = 'ROOT_LEADERSHIP';
    normalized.userAddressable = true;
  } else if (sessionClass === 'ROOT_LEADERSHIP' && plane === 'user') {
    if (!Object.prototype.hasOwnProperty.call(normalized, 'userAddressable')) {
      normalized.userAddressable = true;
    }
  } else if (MANAGED_SESSION_CLASSES.includes(sessionClass) || (plane === 'organization' && !explicitClass)) {
    if (normalized.userAddressable !== false) {
      normalized.userAddressable = false;
    }
    if (plane === 'organization' && !explicitClass && normalized.bindingRepairRequired !== true) {
      normalized.bindingRepairRequired = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'folder')) {
    const nextFolder = normalizeStoredSessionFolder(normalized.folder);
    if (nextFolder.changed) {
      normalized.folder = nextFolder.folder;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'workflowState')) {
    const nextWorkflowState = normalizeSessionWorkflowState(normalized.workflowState || '');
    if (nextWorkflowState) {
      if (normalized.workflowState !== nextWorkflowState) {
        normalized.workflowState = nextWorkflowState;
        changed = true;
      }
    } else {
      delete normalized.workflowState;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'workflowPriority')) {
    const nextWorkflowPriority = normalizeSessionWorkflowPriority(normalized.workflowPriority || '');
    if (nextWorkflowPriority) {
      if (normalized.workflowPriority !== nextWorkflowPriority) {
        normalized.workflowPriority = nextWorkflowPriority;
        changed = true;
      }
    } else {
      delete normalized.workflowPriority;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'lastReviewedAt')) {
    const nextLastReviewedAt = normalizeStoredTimestamp(normalized.lastReviewedAt);
    if (nextLastReviewedAt) {
      if (normalized.lastReviewedAt !== nextLastReviewedAt) {
        normalized.lastReviewedAt = nextLastReviewedAt;
        changed = true;
      }
    } else {
      delete normalized.lastReviewedAt;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'sidebarOrder')) {
    const nextSidebarOrder = normalizeStoredSidebarOrder(normalized.sidebarOrder);
    if (nextSidebarOrder) {
      if (normalized.sidebarOrder !== nextSidebarOrder) {
        normalized.sidebarOrder = nextSidebarOrder;
        changed = true;
      }
    } else {
      delete normalized.sidebarOrder;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'entryMode')) {
    const nextEntryMode = normalizeSessionEntryMode(normalized.entryMode);
    if (nextEntryMode) {
      if (normalized.entryMode !== nextEntryMode) {
        normalized.entryMode = nextEntryMode;
        changed = true;
      }
    } else {
      delete normalized.entryMode;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'activeAgreements')) {
    const nextActiveAgreements = normalizeSessionAgreements(normalized.activeAgreements);
    if (nextActiveAgreements.length > 0) {
      if (JSON.stringify(normalized.activeAgreements) !== JSON.stringify(nextActiveAgreements)) {
        normalized.activeAgreements = nextActiveAgreements;
        changed = true;
      }
    } else {
      delete normalized.activeAgreements;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'taskCard')) {
    const nextTaskCard = normalizeSessionTaskCard(normalized.taskCard);
    if (nextTaskCard) {
      if (JSON.stringify(normalized.taskCard) !== JSON.stringify(nextTaskCard)) {
        normalized.taskCard = nextTaskCard;
        changed = true;
      }
    } else {
      delete normalized.taskCard;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'goal')) {
    const nextGoal = normalizeSessionGoal(normalized.goal);
    if (nextGoal) {
      if (JSON.stringify(normalized.goal) !== JSON.stringify(nextGoal)) {
        normalized.goal = nextGoal;
        changed = true;
      }
    } else {
      delete normalized.goal;
      changed = true;
    }
  }

  return { meta: normalized, changed };
}

function normalizeStoredSessionsMeta(list) {
  let changed = false;
  const normalized = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const result = normalizeStoredSessionMeta(entry);
    if (!result.meta) {
      changed = true;
      continue;
    }
    normalized.push(result.meta);
    changed = changed || result.changed;
  }
  return { list: normalized, changed };
}

async function writeSessionsMetaFile(list = sessionsMetaCache, { install = false, durable = false } = {}) {
  const snapshot = structuredClone(list);
  sessionsMetaWritesInFlight += 1;
  try {
    // A debounced old rewrite must finish before a conditional API commit; it
    // cannot overwrite that commit later with an older captured snapshot.
    await runSessionsMetaFileWrite(async () => {
      await writeJsonAtomic(CHAT_SESSIONS_FILE, snapshot, { ...COMPACT_JSON_OPTIONS, mode: 0o600, durable });
      if (install) {
        sessionsMetaCache = snapshot;
        sessionApiRevisionBaselines = captureSessionApiRevisions(snapshot);
        sessionsMetaDirty = false;
      }
      sessionsMetaCacheMtimeMs = (await statOrNull(CHAT_SESSIONS_FILE))?.mtimeMs ?? null;
    });
  } finally {
    sessionsMetaWritesInFlight -= 1;
  }
}

async function saveSessionsMetaUnlocked(list, { immediate = false, durable = false } = {}) {
  checkGuardedScope(list);
  list.forEach(messagePreparations);
  const dir = dirname(CHAT_SESSIONS_FILE);
  await ensureDir(dir);
  const { scopeChanged } = stampSessionApiRevisions(list, sessionApiRevisionBaselines);
  checkGuardedScope(list);
  if (durable) { await commitSessionApiSnapshot(list); return; }
  sessionsMetaCache = list;
  sessionApiRevisionBaselines = captureSessionApiRevisions(list);
  if (immediate || scopeChanged || !PERF_WRITE_DEBOUNCE_ENABLED) {
    await writeSessionsMetaFile(list, { durable: scopeChanged });
    return;
  }
  sessionsMetaDirty = true;
  if (sessionsMetaFlushTimer) clearTimeout(sessionsMetaFlushTimer);
  sessionsMetaFlushTimer = setTimeout(() => {
    sessionsMetaFlushTimer = null;
    void (async () => {
      if (!sessionsMetaDirty) return;
      sessionsMetaDirty = false;
      try {
        await writeSessionsMetaFile();
      } catch (error) {
        console.error(`[session-meta] flush failed: ${error.message}`);
        sessionsMetaDirty = true; // retry on the next mutation
      }
    })();
  }, SESSIONS_META_FLUSH_DELAY_MS);
  if (typeof sessionsMetaFlushTimer.unref === 'function') sessionsMetaFlushTimer.unref();
}

// Flush a pending chat-sessions.json rewrite immediately. Wired into the chat
// server's shutdown hook so a graceful stop never loses the debounced window.
export async function flushSessionsMetaNow() {
  if (sessionsMetaFlushTimer) {
    clearTimeout(sessionsMetaFlushTimer);
    sessionsMetaFlushTimer = null;
  }
  if (!sessionsMetaDirty) return;
  sessionsMetaDirty = false;
  try { await writeSessionsMetaFile(); }
  catch (error) { sessionsMetaDirty = true; throw error; }
}

export async function loadSessionsMeta() {
  // Existing mutation callbacks may read metadata again. Their read stays in
  // the current transaction, while external normalization/cache installation
  // waits for the active write. Inherited callbacks cannot reuse an ended scope.
  const transaction = currentMetaTransaction();
  if (transaction?.active) {
    const list = await loadSessionsMetaUnlocked();
    // Scope effects receive detached reads. A local edit becomes authoritative
    // only through the guarded save, where its scope is checked again.
    return transaction.scopeGuard ? structuredClone(list) : list;
  }
  return runSessionsMetaTransaction(loadSessionsMetaUnlocked);
}

async function loadSessionsMetaUnlocked() {
  const stats = await runSessionsMetaFileWrite(() => statOrNull(CHAT_SESSIONS_FILE));
  if (!stats) {
    if (sessionsMetaCache && sessionsMetaWritesInFlight > 0) return sessionsMetaCache;
    sessionsMetaCache = [];
    sessionApiRevisionBaselines = new Map();
    sessionsMetaCacheMtimeMs = null;
    return sessionsMetaCache;
  }

  const mtimeMs = stats.mtimeMs;
  if (sessionsMetaCache && (sessionsMetaCacheMtimeMs === mtimeMs || sessionsMetaDirty)) {
    // While a debounced rewrite is pending, the in-memory cache is the
    // authoritative state — an external file change in the window must not
    // replace it (the pending flush would then overwrite the file with a
    // reloaded, mutation-losing list).
    return sessionsMetaCache;
  }

  const parsed = await runSessionsMetaFileWrite(() => readJson(CHAT_SESSIONS_FILE, []));
  const normalized = normalizeStoredSessionsMeta(parsed);
  sessionsMetaCache = normalized.list;
  sessionApiRevisionBaselines = captureSessionApiRevisions(Array.isArray(parsed)
    ? parsed.filter(meta => meta && typeof meta === 'object' && typeof meta.id === 'string') : []);
  if (normalized.changed) {
    await saveSessionsMetaUnlocked(sessionsMetaCache);
  } else {
    sessionsMetaCacheMtimeMs = mtimeMs;
  }
  return sessionsMetaCache;
}

export function findSessionMetaCached(sessionId) {
  if (!Array.isArray(sessionsMetaCache)) return null;
  const meta = sessionsMetaCache.find((meta) => meta.id === sessionId) || null;
  return activeSessionApiScopeGuard && meta ? structuredClone(meta) : meta;
}

export async function findSessionMeta(sessionId) {
  const metas = await loadSessionsMeta();
  return metas.find((meta) => meta.id === sessionId) || null;
}

export async function findSessionByExternalTriggerId(externalTriggerId) {
  const normalized = typeof externalTriggerId === 'string' ? externalTriggerId.trim() : '';
  if (!normalized) return null;
  const metas = await loadSessionsMeta();
  return metas.find((meta) => meta.externalTriggerId === normalized) || null;
}

export async function withSessionsMetaMutation(mutator) {
  return runSessionsMetaTransaction(async () => {
    const metas = await loadSessionsMeta();
    return mutator(metas, saveSessionsMetaUnlocked);
  });
}

export async function mutateSessionMeta(sessionId, mutator) {
  return withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
    const index = metas.findIndex((meta) => meta.id === sessionId);
    if (index === -1) return { meta: null, changed: false };

    const current = metas[index];
    const draft = { ...current };
    const changed = mutator(draft, current) === true;
    if (!changed) {
      return { meta: current, changed: false };
    }

    metas[index] = draft;
    // Boot-recovery and session-visibility fields flush the whole-file rewrite
    // immediately; everything else is debounced (see the perf note above).
    const critical = (current.activeRunId ?? null) !== (draft.activeRunId ?? null)
      || current.archived !== draft.archived;
    await saveSessionsMeta(metas, { immediate: critical });
    return { meta: draft, changed: true };
  });
}

/** Durable private bookkeeping inside an already verified bounded scope effect. */
export async function mutateScopedSessionMetaDurably(sessionId, mutator) {
  const guard = currentMetaTransaction()?.active && currentMetaTransaction()?.scopeGuard;
  if (!guard || guard.scope.sessionId !== sessionId)
    throw sessionApiError('REVISION_CONFLICT', 409, 'A matching active Session scope transaction is required');
  return runSessionsMetaTransaction(async () => {
    const snapshot = structuredClone(await loadSessionsMeta());
    const index = snapshot.findIndex(meta => meta.id === sessionId);
    if (index < 0) throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Session is unavailable');
    const before = structuredClone(snapshot[index]);
    const changed = mutator(snapshot[index], before);
    if (typeof changed !== 'boolean') throw new TypeError('Scoped metadata mutators must return a synchronous boolean');
    if (!changed) return { meta: before, changed: false };
    checkGuardedScope(snapshot);
    stampSessionApiRevisions(snapshot, sessionApiRevisionBaselines);
    await commitSessionApiSnapshot(snapshot);
    return { meta: structuredClone(snapshot[index]), changed: true };
  });
}

export async function removeSessionMeta(sessionId) {
  const normalizedId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedId) return false;
  return withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
    const index = metas.findIndex((meta) => meta.id === normalizedId);
    if (index < 0) return false;
    metas.splice(index, 1);
    await saveSessionsMeta(metas, { immediate: true });
    return true;
  });
}


async function loadSessionApiMetaStrict({ diskOnly = false } = {}) {
  let stored;
  try { stored = await runSessionsMetaFileWrite(() => readJsonStrict(CHAT_SESSIONS_FILE)); }
  catch (error) {
    if (!diskOnly && error.code === 'JSON_NOT_FOUND' && !sessionsMetaDirty && !sessionsMetaCache?.length) return loadSessionsMeta();
    throw sessionApiError('SESSION_MUTATION_STORE_INVALID', 503, 'Session mutation storage is unavailable');
  }
  if (!Array.isArray(stored) || stored.some(meta => !meta || typeof meta !== 'object' || typeof meta.id !== 'string') ||
      new Set(stored.map(meta => meta.id)).size !== stored.length)
    throw sessionApiError('SESSION_MUTATION_STORE_INVALID', 503, 'Invalid Session mutation storage');
  stored.forEach(meta => { validateSessionApiStoredMeta(meta); messagePreparations(meta); });
  return diskOnly ? stored : loadSessionsMeta();
}

/** Compare a retained scope without publishing metadata or taking a long IO lease. */
export async function readSessionApiScope(sessionId, input) {
  const scope = parseSessionApiScope(input, sessionId);
  return runSessionsMetaTransaction(async () => {
    const list = await loadSessionApiMetaStrict({ diskOnly: true });
    const meta = list.find(row => row.id === sessionId);
    if (!meta) throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Session is unavailable');
    requireSessionApiUserResource(meta);
    assertSessionApiScope(meta, scope);
    if (sessionsMetaDirty) {
      const pending = sessionsMetaCache?.find(row => row.id === sessionId);
      if (!pending) throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Session is unavailable');
      requireSessionApiUserResource(pending);
      assertSessionApiScope(pending, scope);
    }
    return projectSessionApiContext(meta);
  });
}

function requireSessionApiUserResource(meta) {
  const plane = typeof meta.sessionPlane === 'string' ? meta.sessionPlane.trim().toLowerCase() : 'user';
  if (plane !== 'user' || meta.userAddressable === false ||
      (typeof meta.internalRole === 'string' && meta.internalRole.trim()) ||
      MANAGED_SESSION_CLASSES.includes(normalizeSessionClass(meta.sessionClass)))
    throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Session is unavailable');
}

async function commitSessionApiSnapshot(list) {
  checkGuardedScope(list);
  list.forEach(messagePreparations);
  const wasDirty = sessionsMetaDirty;
  if (sessionsMetaFlushTimer) { clearTimeout(sessionsMetaFlushTimer); sessionsMetaFlushTimer = null; }
  try { await writeSessionsMetaFile(list, { install: true, durable: true }); }
  catch (error) {
    // Keep the old live list on a failed commit; a receipt is not visible merely
    // because serialization or disk writing was attempted.
    if (wasDirty) await saveSessionsMetaUnlocked(sessionsMetaCache).catch(() => { sessionsMetaDirty = true; });
    throw sessionApiError('SESSION_MUTATION_STORE_UNAVAILABLE', 503, 'Session mutation commit is unconfirmed');
  }
}

/** Strict private identity lookup, including managed internal legacy ingress. */
export async function readSessionMessagePreparations(sessionId) {
  return runSessionsMetaTransaction(async () => {
    const snapshot = structuredClone(await loadSessionApiMetaStrict());
    stampSessionApiRevisions(snapshot, sessionApiRevisionBaselines);
    const meta = snapshot.find(row => row.id === sessionId);
    return meta ? messagePreparations(meta) : [];
  });
}

/**
 * Linearize a bounded effect with all PC metadata writes. Request bodies and
 * upload streams must be staged before entry; a scope condition is not auth.
 */
export async function withSessionApiScope(sessionId, input, effect) {
  const scope = parseSessionApiScope(input, sessionId);
  if (typeof effect !== 'function') throw new TypeError('A scoped effect is required');
  return runSessionsMetaTransaction(async () => {
    const transaction = currentMetaTransaction();
    if (transaction.scopeGuard)
      throw sessionApiError('REVISION_CONFLICT', 409, 'Nested scope effects are unsupported');
    const list = await loadSessionApiMetaStrict();
    const snapshot = structuredClone(list);
    stampSessionApiRevisions(snapshot, sessionApiRevisionBaselines);
    const current = snapshot.find(row => row.id === sessionId);
    if (!current) throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Session is unavailable');
    requireSessionApiUserResource(current);
    assertSessionApiScope(current, scope);
    // Durably publish the compared scope and detach every earlier cache alias
    // before the effect can observe or change metadata.
    await commitSessionApiSnapshot(snapshot);
    const guard = { scope, fingerprint: sessionApiScopeFingerprint(current), nestedQueue: createSerialTaskQueue() };
    transaction.scopeGuard = guard;
    activeSessionApiScopeGuard = guard;
    try {
      const result = await effect(scope);
      await guard.nestedQueue(() => {});
      checkGuardedScope(sessionsMetaCache);
      return result;
    } finally {
      await guard.nestedQueue(() => {});
      activeSessionApiScopeGuard = null;
      transaction.scopeGuard = null;
    }
  });
}

/** Scope only a bounded writer phase of the validated message continuation. */
export function withCurrentMessageScope(effect) {
  const execution = currentMessageExecution();
  if (!execution) return effect();
  if (Date.parse(execution.expiresAt) <= Date.now())
    throw sessionApiError('REQUEST_EXPIRED', 410, 'Prepared message expired before a new effect');
  return withoutMessageExecution(() => withSessionApiScope(execution.scope.sessionId, execution.scope, async () => {
    if (execution.temporaryAuthority) {
      if (typeof execution.authorizeScope !== 'function')
        throw sessionApiError('PERMISSION_DENIED', 403, 'Temporary message continuation authority is unavailable');
      await execution.authorizeScope(await findSessionMeta(execution.scope.sessionId));
    }
    return effect();
  }));
}

export async function readSessionApiContext(sessionId) {
  sessionApiIdentifier(sessionId, 256);
  return runSessionsMetaTransaction(async () => {
    const list = await loadSessionApiMetaStrict();
    const existing = list.find(meta => meta.id === sessionId);
    if (!existing) return null;
    requireSessionApiUserResource(existing);
    sessionApiReceipts(existing);
    const snapshot = structuredClone(list);
    stampSessionApiRevisions(snapshot, sessionApiRevisionBaselines);
    const context = projectSessionApiContext(snapshot.find(meta => meta.id === sessionId));
    await commitSessionApiSnapshot(snapshot);
    return context;
  });
}

export async function applySessionApiMutation(sessionId, input) {
  sessionApiIdentifier(sessionId, 256);
  const request = parseSessionApiMutation(input);
  const fingerprint = sessionApiFingerprint(request);
  return runSessionsMetaTransaction(async () => {
    const list = await loadSessionApiMetaStrict();
    const current = list.find(meta => meta.id === sessionId);
    if (!current) throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Session is unavailable');
    requireSessionApiUserResource(current);
    const receipts = sessionApiReceipts(current);
    const retained = receipts.find(row => row.requestId === request.requestId);
    if (retained && retained.fingerprint !== fingerprint)
      throw sessionApiError('REVISION_CONFLICT', 409, 'Mutation request identity has different input');
    if (retained) {
      if (current.appApiScopeRevision !== retained.scopeRevision || sessionApiProject(current) !== request.expectedProjectId)
        throw sessionApiError('REVISION_CONFLICT', 409, 'Session resource scope changed');
      // Also flush a pending normal metadata rewrite before confirming retained facts.
      await commitSessionApiSnapshot(structuredClone(list));
      return { ...structuredClone(retained.receipt), duplicate: true };
    }
    if (current.appApiRevision !== request.expectedRevision || current.appApiScopeRevision !== request.expectedScopeRevision ||
        sessionApiProject(current) !== request.expectedProjectId)
      throw sessionApiError('REVISION_CONFLICT', 409, 'Session context changed before mutation');
    if (receipts.length >= SESSION_API_RECEIPT_LIMIT)
      throw sessionApiError('RESOURCE_LIMIT', 429, 'Retained mutation receipt budget is full');
    const snapshot = structuredClone(list);
    const next = snapshot.find(meta => meta.id === sessionId);
    const timestamp = new Date().toISOString();
    const changed = applySessionApiChange(next, request, timestamp);
    stampSessionApiRevisions(snapshot, sessionApiRevisionBaselines, { forceRevisionId: sessionId });
    const receipt = { version: 1, requestId: request.requestId, sessionId, kind: request.kind, changed,
      revision: next.appApiRevision, scopeRevision: next.appApiScopeRevision, observedAt: timestamp,
      projectId: sessionApiProject(next), duplicate: false };
    next.appApiMutationReceipts = [...receipts.map(row => structuredClone(row)), {
      requestId: request.requestId, fingerprint, scopeRevision: next.appApiScopeRevision, receipt,
    }];
    await commitSessionApiSnapshot(snapshot);
    return structuredClone(receipt);
  });
}

export async function readSessionApiMutationReceipt(sessionId, requestId) {
  sessionApiIdentifier(sessionId, 256); sessionApiIdentifier(requestId);
  return runSessionsMetaTransaction(async () => {
    const list = await loadSessionApiMetaStrict();
    const current = list.find(meta => meta.id === sessionId);
    if (!current) throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Session is unavailable');
    requireSessionApiUserResource(current);
    const retained = sessionApiReceipts(current).find(row => row.requestId === requestId);
    if (!retained) return null;
    if (current.appApiScopeRevision !== retained.scopeRevision || sessionApiProject(current) !== retained.receipt.projectId)
      throw sessionApiError('REVISION_CONFLICT', 409, 'Retained mutation resource scope changed');
    await commitSessionApiSnapshot(structuredClone(list));
    return structuredClone(retained.receipt);
  });
}
