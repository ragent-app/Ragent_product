import { execFile } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { access } from 'fs/promises';
import { join, resolve } from 'path';
import { promisify } from 'util';
import {
  createNode,
  createOrganization,
  getOrganization,
  getOrganizationByRootSession,
  openOrganizationDatabase,
  withOrganizationDatabase,
} from './organization-store.mjs';
import {
  createBoardChannel,
  ensureOrganizationBoardSchema,
  isSwarmMarkedDoneSync,
  listBoardChannels,
  markBoardWakeupDeferred,
  markBoardWakeupDelivered,
  postBoardMessage,
  readBoardMessages,
  subscribeBoardChannel,
} from './organization-board-store.mjs';
import { deriveOrganizationGrant } from './organization-role-contract.mjs';
import {
  getBudgetCounter,
  releaseOrganizationBudgetReservation,
  reserveOrganizationBudget,
} from './organization-governor.mjs';
import { getOrganizationRuntimeCapabilities } from './organization-runtime-capabilities.mjs';
import {
  assertRuntimeConstraints,
  queryRuntimeCandidates,
  selectRuntimeConstraints,
} from './organization-runtime-decision.mjs';
import { buildOrganizationRuntimeCatalog, TOOL_SET } from './organization-runtime-selection.mjs';
import { getModelsForTool } from './models.mjs';
import { readSessionRuntimeConstraints } from './session-collaboration-settings.mjs';
import { invalidateOrganizationProjectionCache } from './organization-projection-cache.mjs';
import { createGitWorktree, removeGitWorktree } from './collaboration-workspace.mjs';
import { createStagingWorkspace, discardStaging, resolveStagingDiff } from './managed-writer.mjs';
import { acquireWorkspaceLease, releaseLease } from './workspace-leases.mjs';
import { createFactoryTaskHandoff, remoteFactoryTaskSummary } from './factory-task-handoff.mjs';

const execFileAsync = promisify(execFile);

export const SWARM_WORKSPACE_UNMERGED_CHANGES = 'SWARM_WORKSPACE_UNMERGED_CHANGES';
export const SWARM_MODEL_FORBIDDEN = 'SWARM_MODEL_FORBIDDEN';
export const SWARM_MODEL_LOCKED_BY_OWNER = 'SWARM_MODEL_LOCKED_BY_OWNER';
export const SWARM_MEMBER_BUSY = 'SWARM_MEMBER_BUSY';
export const SWARM_MEMBER_KILLED = 'SWARM_MEMBER_KILLED';
export const SWARM_MODEL_CANDIDATE_INVALID = 'SWARM_MODEL_CANDIDATE_INVALID';
export const SWARM_MODEL_POLICY_DENIED = 'SWARM_MODEL_POLICY_DENIED';
export const SWARM_BINDING_CONFLICT = 'SWARM_BINDING_CONFLICT';
export const SWARM_STATES = Object.freeze(['waiting', 'working', 'stopped', 'killed']);
export const SWARM_WORKSPACE_MODES = Object.freeze(['inherit', 'worktree', 'staging']);

const DEFAULT_STALL_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_STALL_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_STALL_MAX_ALERTS = 3;
const MAX_SHARD_COUNT = 16;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function encodeJson(value, fallback = null) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function swarmError(code, message, statusCode = 400, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function isDbHandle(value) {
  return Boolean(value && typeof value.prepare === 'function' && typeof value.exec === 'function');
}

function splitDbOrDeps(firstArg, secondArg) {
  if (isDbHandle(firstArg)) {
    return { db: firstArg, deps: {}, options: secondArg && typeof secondArg === 'object' ? secondArg : {} };
  }
  if (secondArg && typeof secondArg === 'object') {
    const deps = firstArg && typeof firstArg === 'object' ? firstArg : {};
    return { db: isDbHandle(deps.db) ? deps.db : null, deps, options: secondArg };
  }
  const single = firstArg && typeof firstArg === 'object' ? firstArg : {};
  return { db: isDbHandle(single.db) ? single.db : null, deps: single, options: single };
}

async function runWithOrgDb(explicitDb, fn, { mutate = false, organizationId = '' } = {}) {
  if (isDbHandle(explicitDb)) {
    ensureOrganizationBoardSchema(explicitDb);
    const result = await fn(explicitDb);
    if (mutate && organizationId) invalidateOrganizationProjectionCache(organizationId);
    return result;
  }
  return withOrganizationDatabase(async (conn) => fn(conn), { mutate });
}

function normalizeSwarmName(value, fallback = 'worker') {
  const raw = trimString(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return raw || fallback;
}

function resolveSwarmRoleContractName(role, workspace = 'inherit') {
  const lower = trimString(role).toLowerCase();
  if (['reviewer', 'verifier', 'auditor', 'qa', 'researcher', 'observer', 'inspector', 'monitor'].includes(lower)) {
    return 'reviewer';
  }
  if (['manager', 'coordinator', 'phase_lead', 'lead'].includes(lower)) {
    return lower === 'phase_lead' ? 'phase_lead' : 'manager';
  }
  if (['specialist', 'writer', 'worker', 'author', 'executor'].includes(lower)) {
    return lower === 'author' ? 'worker' : lower;
  }
  if (workspace === 'inherit' && ['reader', 'analyst'].includes(lower)) return 'reviewer';
  return 'worker';
}

function resolveSwarmSessionClass(contractRole) {
  const lower = trimString(contractRole).toLowerCase();
  if (lower === 'reviewer') return 'REVIEWER';
  if (lower === 'manager' || lower === 'phase_lead') return 'MANAGER';
  return 'WORKER';
}

function isCoordinatorNodeRow(row) {
  if (!row) return false;
  const role = trimString(row.node_role ?? row.contractRole).toLowerCase();
  const sessionClass = trimString(row.session_class ?? row.sessionClass).toUpperCase();
  return role === 'root_leadership' || sessionClass === 'ROOT_LEADERSHIP';
}

function resolveMemberSwarmState(row) {
  if (!row) return 'killed';
  const explicit = trimString(row.swarm_state).toLowerCase();
  if (SWARM_STATES.includes(explicit)) return explicit;
  if (row.lifecycle_state === 'retired' || row.retired_revision !== null) return 'killed';
  if (!trimString(row.current_session_id)) return 'stopped';
  return 'waiting';
}

function redactSecrets(text) {
  return String(text || '')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/g, '[REDACTED]');
}

function normalizeRuntimeTuple(input = {}) {
  const tool = trimString(input.tool || input.harness).toLowerCase();
  const provider = trimString(input.provider || input.providerProfile);
  const model = trimString(input.model);
  const effort = trimString(input.effort).toLowerCase();
  return {
    ...(tool ? { tool } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function normalizeUsageFields(rawUsage = null) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const pickInt = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.trunc(Number(v)) : 0);
  const pickCost = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const inputTokens = pickInt(rawUsage.inputTokens ?? rawUsage.contextInputTokens ?? rawUsage.promptTokens);
  const outputTokens = pickInt(rawUsage.outputTokens ?? rawUsage.completionTokens);
  const cachedInputTokens = pickInt(rawUsage.cachedInputTokens ?? rawUsage.cached_input_tokens);
  const cacheReadTokens = pickInt(
    rawUsage.cacheReadTokens ?? rawUsage.cachedReadTokens ?? rawUsage.cache_read_input_tokens ?? rawUsage.cache_read_tokens,
  );
  const cacheCreationTokens = pickInt(rawUsage.cacheCreationTokens ?? rawUsage.cache_creation_input_tokens);
  const reasoningTokens = pickInt(rawUsage.reasoningTokens ?? rawUsage.thoughtTokens);
  const explicitTotal = pickInt(rawUsage.totalTokens ?? rawUsage.contextWindowTokens);
  const cachedTotal = Math.max(cachedInputTokens, cacheReadTokens);
  const totalTokens = explicitTotal > 0
    ? explicitTotal
    : (inputTokens + outputTokens + reasoningTokens + cachedTotal + cacheCreationTokens);
  const costUsd = pickCost(rawUsage.costUsd ?? rawUsage.estimatedCostUsd ?? rawUsage.cost);
  if (inputTokens === 0 && outputTokens === 0 && reasoningTokens === 0 && totalTokens === 0 && costUsd === 0 && cachedInputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    costUsd,
  };
}

function emptyEpochUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    runCount: 0,
    runIds: [],
  };
}

function createModelEpoch({
  epochIndex = 1,
  bindingGeneration = 1,
  startedAt = nowIso(),
  endedAt = null,
  reason = 'initial_spawn',
  requestedConfig = {},
  resolvedConfig = {},
  actualReportedConfig = null,
  usage = null,
} = {}) {
  const baseUsage = emptyEpochUsage();
  if (usage && typeof usage === 'object') {
    for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'costUsd', 'runCount']) {
      if (Number.isFinite(Number(usage[key])) && Number(usage[key]) >= 0) {
        baseUsage[key] = key === 'costUsd' ? Number(usage[key]) : Math.trunc(Number(usage[key]));
      }
    }
    if (Array.isArray(usage.runIds)) {
      baseUsage.runIds = [...new Set(usage.runIds.map((id) => trimString(id)).filter(Boolean))].slice(-64);
    }
  }
  return {
    epochIndex: Math.max(1, Number(epochIndex) || 1),
    bindingGeneration: Math.max(1, Number(bindingGeneration) || 1),
    startedAt: trimString(startedAt) || nowIso(),
    endedAt: trimString(endedAt) || null,
    reason: trimString(reason) || 'initial_spawn',
    requestedConfig: normalizeRuntimeTuple(requestedConfig),
    resolvedConfig: normalizeRuntimeTuple(resolvedConfig),
    actualReportedConfig: actualReportedConfig && typeof actualReportedConfig === 'object'
      ? normalizeRuntimeTuple(actualReportedConfig)
      : null,
    usage: baseUsage,
  };
}

function ensureGrantModelHistory(grant = {}, fallbackBindingGeneration = 1) {
  const runtimePolicy = grant?.runtimePolicy && typeof grant.runtimePolicy === 'object' ? grant.runtimePolicy : {};
  const existing = Array.isArray(grant?.modelHistory) ? grant.modelHistory : [];
  if (existing.length > 0) {
    return existing.map((epoch, idx) => createModelEpoch({ ...epoch, epochIndex: epoch?.epochIndex ?? (idx + 1) }));
  }
  const initialConfig = normalizeRuntimeTuple({
    tool: runtimePolicy.tool || grant?.harness,
    provider: runtimePolicy.providerProfile || grant?.provider,
    model: runtimePolicy.model || grant?.model,
    effort: runtimePolicy.effort || grant?.effort,
  });
  return [
    createModelEpoch({
      epochIndex: 1,
      bindingGeneration: Math.max(1, Number(fallbackBindingGeneration) || 1),
      reason: 'initial_spawn',
      requestedConfig: initialConfig,
      resolvedConfig: initialConfig,
    }),
  ];
}

function extractRunUsageAndActualConfig(run = null, session = null) {
  if (!run && !session) return { usage: null, actualReportedConfig: null };
  const usage = normalizeUsageFields(run?.usage || run?.tokenUsage || run);
  const actualTuple = normalizeRuntimeTuple({
    tool: run?.tool || run?.actualTool || session?.tool,
    provider: run?.providerProfile || run?.actualProvider || run?.agyQueue?.providerId || run?.agyProviderProfileId || session?.providerProfile,
    model: run?.actualModel || run?.model || run?.codexThreadModel || session?.model,
    effort: run?.effort || run?.codexThreadEffort || session?.effort,
  });
  return {
    usage,
    actualReportedConfig: Object.keys(actualTuple).length > 0 ? actualTuple : null,
  };
}

function recordEpochRunTelemetry(grant = {}, {
  bindingGeneration = 1,
  runId = '',
  run = null,
  session = null,
  usage = null,
  actualReportedConfig = null,
  endedAt = '',
} = {}) {
  const history = ensureGrantModelHistory(grant, bindingGeneration);
  let targetEpoch = null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (!history[i].endedAt && history[i].bindingGeneration === Number(bindingGeneration || history[i].bindingGeneration)) {
      targetEpoch = history[i];
      break;
    }
  }
  if (!targetEpoch) {
    targetEpoch = history[history.length - 1];
  }
  const normalizedRunId = trimString(runId || run?.id || run?.runId);
  const extracted = extractRunUsageAndActualConfig(run, session);
  const resolvedUsage = normalizeUsageFields(usage) || extracted.usage;
  const resolvedActual = actualReportedConfig && typeof actualReportedConfig === 'object'
    ? normalizeRuntimeTuple(actualReportedConfig)
    : extracted.actualReportedConfig;
  if (resolvedActual && Object.keys(resolvedActual).length > 0) {
    targetEpoch.actualReportedConfig = {
      ...(targetEpoch.actualReportedConfig || {}),
      ...resolvedActual,
    };
  }
  const alreadyRecorded = Boolean(normalizedRunId && targetEpoch.usage.runIds.includes(normalizedRunId));
  if (!alreadyRecorded && (normalizedRunId || resolvedUsage)) {
    if (resolvedUsage) {
      targetEpoch.usage.inputTokens += resolvedUsage.inputTokens;
      targetEpoch.usage.outputTokens += resolvedUsage.outputTokens;
      targetEpoch.usage.reasoningTokens += Number(resolvedUsage.reasoningTokens || 0);
      targetEpoch.usage.cachedInputTokens += resolvedUsage.cachedInputTokens;
      targetEpoch.usage.cacheReadTokens += resolvedUsage.cacheReadTokens;
      targetEpoch.usage.cacheCreationTokens += resolvedUsage.cacheCreationTokens;
      targetEpoch.usage.totalTokens += resolvedUsage.totalTokens;
      targetEpoch.usage.costUsd = Math.round((targetEpoch.usage.costUsd + resolvedUsage.costUsd) * 1e6) / 1e6;
    }
    if (normalizedRunId) {
      targetEpoch.usage.runCount += 1;
      targetEpoch.usage.runIds.push(normalizedRunId);
      if (targetEpoch.usage.runIds.length > 64) {
        targetEpoch.usage.runIds = targetEpoch.usage.runIds.slice(-64);
      }
    }
  }
  if (endedAt && !targetEpoch.endedAt) {
    targetEpoch.endedAt = endedAt;
  }
  grant.modelHistory = history;
  return history;
}

function mergeNonEmptyRuntimeConfig(...configs) {
  const merged = {};
  for (const raw of configs) {
    if (!raw || typeof raw !== 'object') continue;
    const tool = trimString(raw.tool || raw.harness);
    const provider = trimString(raw.provider || raw.providerProfile);
    const model = trimString(raw.model);
    const effort = trimString(raw.effort).toLowerCase();
    if (tool) merged.tool = tool;
    if (provider) merged.provider = provider;
    if (model) merged.model = model;
    if (effort) merged.effort = effort;
  }
  return merged;
}

function summarizeUsageByModel(modelHistory = []) {
  const byModel = new Map();
  for (const epoch of modelHistory) {
    const cfg = mergeNonEmptyRuntimeConfig(
      epoch?.requestedConfig,
      epoch?.resolvedConfig,
      epoch?.actualReportedConfig,
    );
    const key = `${cfg.tool || 'unknown'}:${cfg.model || cfg.provider || 'default'}`;
    if (!byModel.has(key)) {
      byModel.set(key, {
        modelKey: key,
        tool: cfg.tool || '',
        provider: cfg.provider || '',
        model: cfg.model || '',
        effort: cfg.effort || '',
        epochs: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        runCount: 0,
      });
    }
    const bucket = byModel.get(key);
    const u = epoch?.usage || {};
    bucket.epochs.push(epoch.epochIndex);
    bucket.inputTokens += Number(u.inputTokens || 0);
    bucket.outputTokens += Number(u.outputTokens || 0);
    bucket.reasoningTokens += Number(u.reasoningTokens || 0);
    bucket.cachedInputTokens += Number(u.cachedInputTokens || 0);
    bucket.cacheReadTokens += Number(u.cacheReadTokens || 0);
    bucket.cacheCreationTokens += Number(u.cacheCreationTokens || 0);
    bucket.totalTokens += Number(u.totalTokens || 0);
    bucket.costUsd = Math.round((bucket.costUsd + Number(u.costUsd || 0)) * 1e6) / 1e6;
    bucket.runCount += Number(u.runCount || 0);
  }
  return [...byModel.values()];
}

function serializeSwarmMember(row, subscriptionsByNode = new Map()) {
  if (!row) return null;
  const grant = parseJson(row.grant_json, {});
  const runtimePolicy = grant?.runtimePolicy && typeof grant.runtimePolicy === 'object' ? grant.runtimePolicy : {};
  const workspaceMeta = grant?.swarmWorkspace && typeof grant.swarmWorkspace === 'object' ? grant.swarmWorkspace : {};
  const bindingGeneration = Number(row.binding_generation || 0);
  const modelHistory = ensureGrantModelHistory(grant, bindingGeneration);
  const usageByModel = summarizeUsageByModel(modelHistory);
  const activeModelEpoch = modelHistory[modelHistory.length - 1] || null;
  return {
    nodeId: row.id,
    id: row.id,
    organizationId: row.organization_id,
    name: row.stable_key,
    stableKey: row.stable_key,
    role: trimString(grant?.swarmDisplayRole) || row.node_role,
    contractRole: row.node_role,
    domain: trimString(grant?.swarmDomain),
    lifecycleMode: row.lifecycle_mode || 'formal_org',
    lifecycleState: row.lifecycle_state,
    swarmState: resolveMemberSwarmState(row),
    sessionClass: row.session_class || '',
    roleInstanceId: row.role_instance_id || '',
    parentNodeId: row.parent_node_id || '',
    depth: Number(row.depth || 0),
    currentSessionId: row.current_session_id || '',
    bindingGeneration,
    harness: trimString(runtimePolicy.tool || grant?.harness),
    provider: trimString(runtimePolicy.providerProfile || grant?.provider),
    model: trimString(runtimePolicy.model || grant?.model),
    effort: trimString(runtimePolicy.effort || grant?.effort),
    workspaceMode: row.workspace_mode || 'inherit',
    workspacePath: row.workspace_path || '',
    workspaceBranch: row.workspace_branch || '',
    baseRef: trimString(workspaceMeta.baseRef),
    sealedCandidateId: trimString(workspaceMeta.sealedCandidateId),
    promotedWorkItemId: trimString(workspaceMeta.promotedWorkItemId),
    parentWorkItemId: trimString(grant?.parentWorkItemId || grant?.workItemId),
    channels: subscriptionsByNode.get(row.id) || ['main'],
    canDelegate: grant?.canDelegate === true,
    canWrite: grant?.canWrite === true,
    canReview: grant?.canReview === true,
    certifiedReadOnly: grant?.certifiedReadOnly === true,
    modelSwitchCount: Number(grant?.modelSwitchCount || 0),
    pendingModelSwitchHandoff: Boolean(grant?.pendingModelSwitchHandoff),
    activeModelEpoch,
    modelHistory,
    usageByModel,
    ...(trimString(grant?.lastRunId) ? { lastRunId: trimString(grant.lastRunId) } : {}),
    ...(trimString(grant?.lastStateReason) ? { lastStateReason: trimString(grant.lastStateReason) } : {}),
    ...(grant?.lastRunFailure && typeof grant.lastRunFailure === 'object' ? { lastRunFailure: grant.lastRunFailure } : {}),
  };
}

function buildCoordinatorGrant(policy = {}, actor = {}) {
  const maxDepth = Math.max(1, Number(actor.maxDepth ?? policy.maxDepth ?? 3) || 3);
  const maxChildren = Math.max(1, Number(actor.maxChildren ?? policy.maxChildren ?? 16) || 16);
  const maxConcurrent = Math.max(1, Number(actor.maxConcurrent ?? policy.maxConcurrent ?? 6) || 6);
  const capabilities = Array.isArray(actor.allowedCapabilities) && actor.allowedCapabilities.length > 0
    ? actor.allowedCapabilities
    : ['read', 'write', 'review'];
  return {
    organizationRole: 'manager',
    swarmDisplayRole: 'coordinator',
    allowedCapabilities: capabilities,
    writablePaths: Array.isArray(actor.writablePaths) ? actor.writablePaths : [],
    workspaceScope: trimString(actor.workspaceScope || policy.workspaceScope),
    projectId: trimString(actor.projectId || policy.projectId),
    accessMode: actor.accessMode === 'read_only' ? 'read_only' : 'writer',
    executionIsolation: 'shared',
    maxDepth,
    maxChildren,
    maxConcurrent,
    canDelegate: true,
    canWrite: actor.accessMode !== 'read_only',
    canReview: true,
    ...(actor.runtimePolicy && typeof actor.runtimePolicy === 'object' ? { runtimePolicy: actor.runtimePolicy } : {}),
  };
}

export async function ensureSwarmOrganization(storeOrDb, maybeOptions) {
  const isCustomStore = Boolean(
    storeOrDb
    && !isDbHandle(storeOrDb)
    && typeof storeOrDb.getOrganizationByRootSession === 'function'
    && typeof storeOrDb.createOrganization === 'function',
  );
  const { db, options } = isCustomStore
    ? { db: null, options: maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {} }
    : splitDbOrDeps(storeOrDb, maybeOptions);
  const {
    rootSessionId,
    projectId = '',
    title = '',
    policy = {},
    budget = {},
    actor = {},
    idempotencyKey = '',
  } = options;
  const normalizedRoot = trimString(rootSessionId);
  if (!normalizedRoot) throw swarmError('BAD_REQUEST', 'rootSessionId is required', 400);

  if (isCustomStore) {
    let org = await storeOrDb.getOrganizationByRootSession(normalizedRoot);
    if (org && org.state === 'archived') {
      throw swarmError('ORG_ARCHIVED', `Organization ${org.id} is archived`, 409);
    }
    if (!org) {
      org = await storeOrDb.createOrganization({
        projectId,
        rootSessionId: normalizedRoot,
        state: 'active',
        policy: { ...policy, mode: 'ragent_swarm', swarmEnabled: true, ...(title ? { swarmTitle: trimString(title) } : {}) },
        budget,
        currentRevision: 0,
        idempotencyKey,
      });
    }
    const existingNodes = typeof storeOrDb.listOrganizationNodes === 'function'
      ? await storeOrDb.listOrganizationNodes(org.id)
      : [];
    let coordinator = existingNodes.find((n) => n.currentSessionId === normalizedRoot || n.nodeRole === 'root_leadership');
    if (!coordinator && typeof storeOrDb.createNode === 'function') {
      coordinator = await storeOrDb.createNode({
        organizationId: org.id,
        stableKey: normalizeSwarmName(actor?.name, 'coordinator'),
        nodeRole: 'root_leadership',
        createdRevision: org.currentRevision || 0,
        lifecycleState: 'active',
        lifecycleMode: 'ephemeral_swarm',
        swarmState: 'working',
        grant: buildCoordinatorGrant(policy, { ...actor, projectId: projectId || org.projectId }),
        currentSessionId: normalizedRoot,
        bindingGeneration: 1,
        depth: 0,
        sessionClass: 'ROOT_LEADERSHIP',
      });
    }
    return { organization: org, coordinatorNode: coordinator, headSeq: 0 };
  }

  let org = db
    ? (() => {
      ensureOrganizationBoardSchema(db);
      const row = db.prepare('SELECT * FROM organizations WHERE root_session_id = ?').get(normalizedRoot);
      return row ? {
        id: row.id,
        projectId: row.project_id || '',
        rootSessionId: row.root_session_id,
        state: row.state,
        currentRevision: row.current_revision,
        policy: parseJson(row.policy_json, {}),
        budget: parseJson(row.budget_json, {}),
      } : null;
    })()
    : await getOrganizationByRootSession(normalizedRoot);

  if (org && org.state === 'archived') {
    throw swarmError('ORG_ARCHIVED', `Organization ${org.id} is archived`, 409);
  }
  if (!org) {
    const mergedPolicy = {
      ...policy,
      mode: 'ragent_swarm',
      swarmEnabled: true,
      ...(trimString(title) ? { swarmTitle: trimString(title) } : {}),
    };
    if (db) {
      const orgId = makeId('org');
      const ts = nowIso();
      db.prepare(`INSERT INTO organizations
        (id, project_id, root_session_id, state, current_revision, progress_epoch, version, policy_json, budget_json, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, 'active', 0, 0, 1, ?, ?, ?, ?, ?)`)
        .run(orgId, projectId || null, normalizedRoot, encodeJson(mergedPolicy, {}), encodeJson(budget, {}), idempotencyKey || null, ts, ts);
      org = {
        id: orgId,
        projectId: projectId || '',
        rootSessionId: normalizedRoot,
        state: 'active',
        currentRevision: 0,
        policy: mergedPolicy,
        budget,
      };
    } else {
      org = await createOrganization({
        projectId,
        rootSessionId: normalizedRoot,
        state: 'active',
        policy: mergedPolicy,
        budget,
        currentRevision: 0,
        idempotencyKey,
      });
    }
  } else {
    // Upgrade org policy in-place to flag swarmEnabled without requiring freezeRevision.
    await runWithOrgDb(db, (conn) => {
      const existingPolicy = parseJson(
        conn.prepare('SELECT policy_json FROM organizations WHERE id = ?').get(org.id)?.policy_json,
        {},
      );
      if (existingPolicy.swarmEnabled !== true || (trimString(title) && existingPolicy.swarmTitle !== trimString(title))) {
        const nextPolicy = {
          ...existingPolicy,
          swarmEnabled: true,
          mode: existingPolicy.mode || 'ragent_swarm',
          ...(trimString(title) ? { swarmTitle: trimString(title) } : {}),
        };
        conn.prepare('UPDATE organizations SET policy_json = ?, updated_at = ? WHERE id = ?')
          .run(encodeJson(nextPolicy, {}), nowIso(), org.id);
        org.policy = nextPolicy;
      }
    }, { mutate: true, organizationId: org.id });
  }

  let coordinatorNode = await runWithOrgDb(db, (conn) => {
    const existing = conn.prepare(`
      SELECT * FROM organization_nodes
      WHERE organization_id = ? AND (current_session_id = ? OR node_role = 'root_leadership')
      ORDER BY depth ASC LIMIT 1
    `).get(org.id, normalizedRoot);
    return existing ? serializeSwarmMember(existing) : null;
  });

  if (!coordinatorNode) {
    const coordGrant = buildCoordinatorGrant(org.policy, { ...actor, projectId: projectId || org.projectId });
    const coordKey = normalizeSwarmName(actor?.name, 'coordinator');
    if (db) {
      const nodeId = makeId('node');
      db.prepare(`INSERT INTO organization_nodes
        (id, organization_id, stable_key, node_role, created_revision, retired_revision, lifecycle_state, version, grant_json,
         current_session_id, binding_generation, role_instance_id, parent_node_id, depth, session_class, idempotency_key,
         lifecycle_mode, swarm_state)
        VALUES (?, ?, ?, 'root_leadership', ?, NULL, 'active', 1, ?, ?, 1, NULL, NULL, 0, 'ROOT_LEADERSHIP', NULL, 'ephemeral_swarm', 'working')`)
        .run(nodeId, org.id, coordKey, org.currentRevision || 0, encodeJson(coordGrant, {}), normalizedRoot);
      coordinatorNode = serializeSwarmMember(db.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(nodeId));
    } else {
      const created = await createNode({
        organizationId: org.id,
        stableKey: coordKey,
        nodeRole: 'root_leadership',
        createdRevision: org.currentRevision || 0,
        lifecycleState: 'active',
        lifecycleMode: 'ephemeral_swarm',
        swarmState: 'working',
        grant: coordGrant,
        currentSessionId: normalizedRoot,
        bindingGeneration: 1,
        depth: 0,
        sessionClass: 'ROOT_LEADERSHIP',
      });
      coordinatorNode = created;
    }
  }

  await createBoardChannel(db || undefined, {
    organizationId: org.id,
    name: 'main',
    topic: trimString(title) || 'Coordinator decisions, contracts, and completion announcements',
    createdByNodeId: coordinatorNode.id || coordinatorNode.nodeId,
  });
  await subscribeBoardChannel(db || undefined, {
    organizationId: org.id,
    channel: 'main',
    nodeId: coordinatorNode.id || coordinatorNode.nodeId,
  });

  const boardInfo = await readBoardMessages(db || undefined, {
    organizationId: org.id,
    limit: 1,
    advanceCursor: false,
  });
  return { organization: org, coordinatorNode, headSeq: boardInfo.headSeq };
}

function intersectActorGrant(nodeGrant = {}, suppliedGrant = null) {
  if (!suppliedGrant || typeof suppliedGrant !== 'object') return nodeGrant;
  const baseCaps = Array.isArray(nodeGrant.allowedCapabilities) ? nodeGrant.allowedCapabilities : [];
  const capSet = Array.isArray(suppliedGrant.allowedCapabilities)
    ? (baseCaps.length > 0
      ? suppliedGrant.allowedCapabilities.filter((c) => baseCaps.includes(c))
      : suppliedGrant.allowedCapabilities)
    : baseCaps;
  const maxDepth = Math.min(
    Number(nodeGrant.maxDepth ?? 3),
    Number(suppliedGrant.maxDepth ?? nodeGrant.maxDepth ?? 3),
  );
  const maxChildren = Math.min(
    Number(nodeGrant.maxChildren ?? 16),
    Number(suppliedGrant.maxChildren ?? nodeGrant.maxChildren ?? 16),
  );
  const maxConcurrent = Math.min(
    Number(nodeGrant.maxConcurrent ?? 4),
    Number(suppliedGrant.maxConcurrent ?? nodeGrant.maxConcurrent ?? 4),
  );
  return {
    ...nodeGrant,
    allowedCapabilities: capSet,
    canDelegate: nodeGrant.canDelegate !== false && suppliedGrant.canDelegate !== false,
    accessMode: nodeGrant.accessMode === 'read_only' || suppliedGrant.accessMode === 'read_only'
      ? 'read_only'
      : 'writer',
    maxDepth,
    maxChildren,
    maxConcurrent,
  };
}

function buildForkHandoffBundle(conn, {
  organizationId,
  forkFromNode,
  forkSinceSeq = 0,
  messages = [],
  workItemSummary = null,
}) {
  const sourceGrant = parseJson(forkFromNode.grant_json, {});
  return {
    schemaVersion: 1,
    kind: 'swarm_fork_handoff',
    untrustedPeerContext: true,
    organizationId,
    sourceNodeId: forkFromNode.id,
    sourceName: forkFromNode.stable_key,
    sourceRole: trimString(sourceGrant?.swarmDisplayRole) || forkFromNode.node_role,
    workspaceMode: forkFromNode.workspace_mode || 'inherit',
    workspaceBranch: forkFromNode.workspace_branch || '',
    sinceSeq: Math.max(0, Number(forkSinceSeq) || 0),
    boardDigest: messages.map((msg) => ({
      seq: msg.seq,
      channel: msg.channel,
      sender: msg.sender,
      kind: msg.kind,
      text: redactSecrets(msg.text).slice(0, 600),
      createdAt: msg.createdAt,
    })),
    ...(workItemSummary ? { workItemSummary } : {}),
  };
}

async function resolveGitHeadRef(projectRoot, execFileFn = execFileAsync) {
  try {
    const { stdout } = await execFileFn('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot,
      maxBuffer: 256 * 1024,
    });
    const branch = trimString(stdout);
    if (branch && branch !== 'HEAD') return branch;
    const shaRes = await execFileFn('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
      cwd: projectRoot,
      maxBuffer: 256 * 1024,
    });
    return trimString(shaRes.stdout) || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

async function createSwarmMemberWorkspace(deps, {
  workspaceMode,
  projectRoot,
  organizationId,
  memberName,
  writablePaths = [],
  runtimeId = '',
}) {
  if (workspaceMode === 'inherit') {
    return {
      workspaceMode: 'inherit',
      workspacePath: trimString(projectRoot),
      workspaceBranch: '',
      baseRef: '',
      lease: null,
      cleanup: async () => {},
    };
  }
  const root = trimString(projectRoot) || process.cwd();
  if (workspaceMode === 'staging') {
    const createStagingFn = deps.createStagingWorkspace || createStagingWorkspace;
    const discardStagingFn = deps.discardStaging || discardStaging;
    const created = await createStagingFn(root, writablePaths, deps.stagingOptions || {});
    return {
      workspaceMode: 'staging',
      workspacePath: created.stagingDir,
      workspaceBranch: '',
      baseRef: '',
      lease: null,
      cleanup: async () => {
        await discardStagingFn(created.stagingDir).catch(() => {});
      },
    };
  }

  // worktree mode
  const execFn = deps.execFile || execFileAsync;
  const baseRef = await resolveGitHeadRef(root, execFn);
  const shortOrg = organizationId.replace(/^org_/, '').slice(0, 8) || 'swarm';
  const branchName = `swarm/${shortOrg}/${memberName}-${randomBytes(3).toString('hex')}`;
  let worktreePath = '';
  if (typeof deps.createWorktree === 'function') {
    const custom = await deps.createWorktree({ rootPath: root, organizationId, memberName, branchName, baseRef });
    worktreePath = typeof custom === 'string' ? custom : trimString(custom?.worktreePath);
  } else {
    worktreePath = await createGitWorktree({
      rootPath: root,
      collaborationId: organizationId,
      taskId: memberName,
      ref: baseRef,
      execFileFn: execFn,
    });
    await execFn('git', ['-C', worktreePath, 'checkout', '-b', branchName], {
      cwd: worktreePath,
      maxBuffer: 512 * 1024,
    });
  }

  let lease = null;
  const acquireLeaseFn = deps.acquireWorkspaceLease || (deps.useWorkspaceLeases === true ? acquireWorkspaceLease : null);
  if (typeof acquireLeaseFn === 'function') {
    lease = await acquireLeaseFn({
      lockKey: worktreePath,
      mode: 'write',
      sessionId: `pending:${memberName}`,
      runId: `swarm_ws:${organizationId}:${memberName}`,
      runtimeId: runtimeId || memberName,
    });
  }

  return {
    workspaceMode: 'worktree',
    workspacePath: worktreePath,
    workspaceBranch: branchName,
    baseRef,
    lease,
    cleanup: async () => {
      if (lease?.leaseId || lease?.id) {
        await (deps.releaseLease || releaseLease)(lease.leaseId || lease.id, lease.generation || 1, { reason: 'swarm_rollback' }).catch(() => {});
      }
      if (typeof deps.removeWorktree === 'function') {
        await deps.removeWorktree({ rootPath: root, worktreePath, branchName, force: true }).catch(() => {});
      } else {
        await removeGitWorktree({ rootPath: root, worktreePath, execFileFn: execFn }).catch(() => {});
        await execFn('git', ['-C', root, 'branch', '-D', branchName], { cwd: root }).catch(() => {});
      }
    },
  };
}

export async function spawnSwarmMembers(firstArg, secondArg) {
  const { db, deps, options } = splitDbOrDeps(firstArg, secondArg);
  const {
    organizationId,
    actorNodeId = '',
    actorSessionId = '',
    actorGrant = null,
    name,
    role = 'worker',
    domain = '',
    responsibility = '',
    brief = '',
    tasks = null,
    n = 1,
    workspace = 'inherit',
    harness = '',
    provider = '',
    model = '',
    effort = '',
    channels = [],
    forkFromNodeId = '',
    forkSinceSeq = 0,
    workItemId = '',
    parentWorkItemId = '',
    projectRoot = '',
    capabilities = null,
    writablePaths = [],
    certifiedReadOnly = false,
    idempotencyKey = '',
    deferDelivery = false,
  } = options;

  const normalizedOrgId = trimString(organizationId);
  if (!normalizedOrgId) throw swarmError('BAD_REQUEST', 'organizationId is required', 400);
  const baseName = normalizeSwarmName(name, '');
  if (!baseName) throw swarmError('BAD_REQUEST', 'Member name is required', 400);
  const workspaceMode = SWARM_WORKSPACE_MODES.includes(trimString(workspace).toLowerCase())
    ? trimString(workspace).toLowerCase()
    : '';
  if (!workspaceMode) {
    throw swarmError('SWARM_INVALID_WORKSPACE', `Unsupported workspace mode: ${workspace}`, 400);
  }
  const shardTasks = Array.isArray(tasks) && tasks.length > 0 ? tasks : null;
  const count = shardTasks ? shardTasks.length : Math.max(1, Number.isInteger(n) ? n : Number(n) || 1);
  if (count > MAX_SHARD_COUNT) {
    throw swarmError('SWARM_SHARD_LIMIT_EXCEEDED', `Cannot spawn more than ${MAX_SHARD_COUNT} members in one call`, 400);
  }
  const cleanBrief = trimString(brief);
  if (!cleanBrief && !shardTasks) {
    throw swarmError('BAD_REQUEST', 'brief (or non-empty tasks[]) is required', 400);
  }

  const targetNames = [];
  if (shardTasks || count > 1) {
    for (let i = 1; i <= count; i += 1) {
      targetNames.push(`${baseName}-${i}`);
    }
  } else {
    targetNames.push(baseName);
  }

  const normalizedChannels = [...new Set([
    'main',
    ...(Array.isArray(channels) ? channels.map((c) => trimString(c).replace(/^#/, '').toLowerCase()).filter(Boolean) : []),
  ])];

  // Phase 1: Validate org, actor delegation authority, concurrency, fork source, and idempotency.
  const preflight = await runWithOrgDb(db, (conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrgId);
    if (!orgRow) throw swarmError('ORGANIZATION_NOT_FOUND', `organization ${normalizedOrgId} not found`, 404);
    if (['archived', 'lifecycle_pending'].includes(orgRow.state)) {
      throw swarmError('ORG_STATE_CONFLICT', `Organization ${normalizedOrgId} is ${orgRow.state}`, 409);
    }
    const orgPolicy = parseJson(orgRow.policy_json, {});
    const orgBudget = parseJson(orgRow.budget_json, {});

    const cleanIdem = trimString(idempotencyKey);
    if (cleanIdem) {
      const replayed = conn.prepare(
        'SELECT * FROM organization_nodes WHERE organization_id = ? AND idempotency_key LIKE ? ORDER BY stable_key',
      ).all(normalizedOrgId, `${cleanIdem}:%`);
      if (replayed.length > 0) {
        return { replay: true, members: replayed.map((r) => serializeSwarmMember(r)) };
      }
    }

    const actorRow = actorNodeId
      ? conn.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?').get(actorNodeId, normalizedOrgId)
      : (actorSessionId
        ? conn.prepare('SELECT * FROM organization_nodes WHERE current_session_id = ? AND organization_id = ?').get(actorSessionId, normalizedOrgId)
        : null);
    if (!actorRow) {
      throw swarmError('SWARM_ACTOR_NOT_FOUND', 'Spawning actor node does not belong to this organization', 403);
    }
    if (actorRow.lifecycle_state !== 'active' || actorRow.retired_revision !== null || actorRow.swarm_state === 'killed') {
      throw swarmError('SWARM_ACTOR_INACTIVE', 'Spawning actor node is no longer active', 409);
    }

    const effectiveActorGrant = intersectActorGrant(parseJson(actorRow.grant_json, {}), actorGrant);
    if (effectiveActorGrant.canDelegate !== true) {
      throw swarmError('SWARM_DELEGATION_FORBIDDEN', 'Caller does not have canDelegate permission', 403);
    }
    const maxDepth = Number(effectiveActorGrant.maxDepth ?? 3);
    const remainingDepth = maxDepth - Number(actorRow.depth || 0);
    if (remainingDepth < 1) {
      throw swarmError('SWARM_DEPTH_EXCEEDED', 'Delegation depth exhausted (remainingDepth < 1)', 403);
    }

    const existingNodes = conn.prepare('SELECT * FROM organization_nodes WHERE organization_id = ?').all(normalizedOrgId);
    for (const candidateName of targetNames) {
      if (existingNodes.some((nRow) => nRow.stable_key === candidateName)) {
        throw swarmError('SWARM_NAME_CONFLICT', `Swarm member "${candidateName}" already exists in organization`, 409);
      }
    }

    const activeWorkers = existingNodes.filter((nRow) => nRow.lifecycle_state === 'active'
      && nRow.retired_revision === null
      && resolveMemberSwarmState(nRow) !== 'killed');
    const maxConcurrent = Number(orgPolicy.maxConcurrent ?? effectiveActorGrant.maxConcurrent ?? 16);
    if (activeWorkers.length + count > maxConcurrent) {
      throw swarmError(
        'SWARM_CONCURRENCY_EXCEEDED',
        `Active members (${activeWorkers.length}) + ${count} exceeds concurrency limit (${maxConcurrent})`,
        409,
      );
    }
    const maxChildren = Number(effectiveActorGrant.maxChildren ?? 64);
    const actorChildren = existingNodes.filter((nRow) => nRow.parent_node_id === actorRow.id
      && nRow.lifecycle_state === 'active' && resolveMemberSwarmState(nRow) !== 'killed');
    if (actorChildren.length + count > maxChildren) {
      throw swarmError('SWARM_CHILDREN_EXCEEDED', `Actor child count would exceed maxChildren (${maxChildren})`, 409);
    }

    const contractRole = resolveSwarmRoleContractName(role, workspaceMode);
    const childRuntimePolicy = {
      ...(trimString(harness) ? { tool: trimString(harness) } : {}),
      ...(trimString(provider) ? { providerProfile: trimString(provider) } : {}),
      ...(trimString(model) ? { model: trimString(model) } : {}),
      ...(trimString(effort) ? { effort: trimString(effort) } : {}),
    };
    const requestedCaps = Array.isArray(capabilities) && capabilities.length > 0
      ? capabilities
      : (contractRole === 'reviewer' ? ['read', 'review'] : ['read', 'write']);
    const derivedGrant = deriveOrganizationGrant({
      role: contractRole,
      capabilities: requestedCaps,
      parentGrant: effectiveActorGrant,
      scope: {
        writablePaths: contractRole === 'reviewer' ? [] : (Array.isArray(writablePaths) ? writablePaths : []),
        executionIsolation: effectiveActorGrant.executionIsolation || 'shared',
        projectId: orgRow.project_id || effectiveActorGrant.projectId || '',
      },
      maxDepth: Math.max(0, maxDepth - 1),
      runtimePolicy: Object.keys(childRuntimePolicy).length > 0 ? childRuntimePolicy : null,
    });
    derivedGrant.swarmDisplayRole = trimString(role) || contractRole;
    if (contractRole === 'reviewer' && certifiedReadOnly === true) {
      derivedGrant.certifiedReadOnly = true;
    }
    if (trimString(domain)) derivedGrant.swarmDomain = trimString(domain);
    if (trimString(responsibility)) derivedGrant.swarmResponsibility = trimString(responsibility);

    let handoffBundle = null;
    if (trimString(forkFromNodeId)) {
      const forkRow = conn.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?')
        .get(trimString(forkFromNodeId), normalizedOrgId);
      if (!forkRow) {
        throw swarmError('SWARM_FORK_SOURCE_NOT_FOUND', `forkFromNodeId ${forkFromNodeId} does not belong to organization ${normalizedOrgId}`, 404);
      }
      const afterSeq = Math.max(0, Number(forkSinceSeq) || 0);
      const boardRows = conn.prepare(`
        SELECT * FROM organization_board_messages
        WHERE organization_id = ? AND seq > ?
        ORDER BY seq DESC LIMIT 20
      `).all(normalizedOrgId, afterSeq).reverse().map((r) => ({
        seq: r.seq,
        channel: r.channel_name,
        sender: r.sender_name,
        kind: r.kind,
        text: r.body_markdown,
        createdAt: r.created_at,
      }));
      let workItemSummary = null;
      if (trimString(workItemId) && typeof deps.compileFactoryHandoffSummary === 'function') {
        workItemSummary = deps.compileFactoryHandoffSummary(conn, { organizationId: normalizedOrgId, workItemId });
      } else if (trimString(workItemId)) {
        try {
          workItemSummary = remoteFactoryTaskSummary(conn, {
            organizationId: normalizedOrgId,
            workItemId: trimString(workItemId),
            contractDigest: '',
            payload: { contract: { organizationRevision: orgRow.current_revision || 0 } },
          }, 4096);
        } catch {}
      }
      handoffBundle = buildForkHandoffBundle(conn, {
        organizationId: normalizedOrgId,
        forkFromNode: forkRow,
        forkSinceSeq: afterSeq,
        messages: boardRows,
        workItemSummary,
      });
    }

    return {
      replay: false,
      org: {
        id: orgRow.id,
        projectId: orgRow.project_id || '',
        rootSessionId: orgRow.root_session_id,
        currentRevision: Number(orgRow.current_revision || 0),
        policy: orgPolicy,
        budget: orgBudget,
      },
      actor: serializeSwarmMember(actorRow),
      contractRole,
      derivedGrant,
      handoffBundle,
    };
  });

  if (preflight.replay) {
    return {
      organizationId: normalizedOrgId,
      members: preflight.members,
      messages: [],
      wakeups: [],
      replay: true,
    };
  }

  // Phase 2: Reserve atomic organization budget + provision workspaces + sessions with rollback on failure.
  const preparedMembers = [];
  const rollbackAll = async () => {
    for (const item of preparedMembers) {
      if (item.reservation && typeof item.releaseBudget === 'function') {
        await item.releaseBudget().catch(() => {});
      }
      if (item.workspace?.cleanup) {
        await item.workspace.cleanup().catch(() => {});
      }
    }
  };

  const effectiveProjectRoot = trimString(projectRoot)
    || trimString(preflight.org.policy?.projectRoot)
    || trimString(preflight.org.policy?.workspaceScope)
    || process.cwd();

  try {
    const stallGovernorActive = getOrganizationRuntimeCapabilities().stallGovernor === true;
    const reserveFn = typeof deps.reserveOrganizationBudget === 'function'
      ? deps.reserveOrganizationBudget
      : (!db && stallGovernorActive ? reserveOrganizationBudget : null);
    const releaseFn = typeof deps.releaseOrganizationBudgetReservation === 'function'
      ? deps.releaseOrganizationBudgetReservation
      : releaseOrganizationBudgetReservation;

    for (let idx = 0; idx < targetNames.length; idx += 1) {
      const memberName = targetNames[idx];
      const nodeId = makeId('node');
      const taskText = shardTasks ? trimString(shardTasks[idx]) : '';
      const combinedBrief = shardTasks
        ? (cleanBrief ? `${cleanBrief}\n\nAssigned slice: ${taskText}` : taskText)
        : cleanBrief;
      if (!combinedBrief) {
        throw swarmError('BAD_REQUEST', `Empty brief/task slice for member ${memberName}`, 400);
      }

      let reservation = null;
      let releaseBudget = null;
      const effectiveAgentLimit = preflight.org.budget?.maxTotalAgents ?? preflight.org.budget?.agents;
      const governorLimits = {
        ...preflight.org.budget,
        ...(preflight.org.budget?.agents !== undefined && preflight.org.budget?.maxTotalAgents === undefined
          ? { maxTotalAgents: preflight.org.budget.agents }
          : {}),
      };
      if (reserveFn) {
        const reservationId = `swarm_spawn:${nodeId}`;
        const resOutcome = await reserveFn({
          organizationId: normalizedOrgId,
          revision: preflight.org.currentRevision,
          reservationId,
          idempotencyKey: reservationId,
          delta: { agents: 1, runs: 0 },
          limits: governorLimits,
        });
        reservation = {
          reservationId,
          idempotencyKey: reservationId,
          revision: preflight.org.currentRevision,
          delta: { agents: 1, runs: 0 },
        };
        releaseBudget = () => releaseFn({
          organizationId: normalizedOrgId,
          revision: preflight.org.currentRevision,
          reservationId,
          idempotencyKey: reservationId,
          reason: 'swarm_spawn_rollback',
        });
        void resOutcome;
      } else if (Number.isFinite(Number(effectiveAgentLimit))
          && preparedMembers.length + 1 > Number(effectiveAgentLimit)) {
        throw swarmError('ORG_BUDGET_EXCEEDED', 'agents budget exhausted', 409, { dimension: 'agents' });
      }

      const memberWorkspace = await createSwarmMemberWorkspace(deps, {
        workspaceMode,
        projectRoot: effectiveProjectRoot,
        organizationId: normalizedOrgId,
        memberName,
        writablePaths,
        runtimeId: nodeId,
      });

      const memberSessionClass = resolveSwarmSessionClass(preflight.contractRole);
      const memberRoleInstanceId = makeId('rinst');
      const parentSessId = trimString(actorSessionId) || preflight.actor.currentSessionId || preflight.org.rootSessionId;
      const memberTool = trimString(harness) || trimString(preflight.actor.harness) || 'codex';
      const isReviewer = preflight.contractRole === 'reviewer';
      const requireCertifiedReadOnly = isReviewer && certifiedReadOnly === true;
      let managedSessionId = '';
      if (typeof deps.createSession === 'function') {
        const createdSession = await deps.createSession(
          memberWorkspace.workspacePath || effectiveProjectRoot,
          memberTool,
          `${memberName} (${preflight.derivedGrant.swarmDisplayRole || preflight.contractRole})`,
          {
            ...(trimString(provider) ? { providerProfile: trimString(provider) } : {}),
            ...(trimString(model) ? { model: trimString(model) } : {}),
            ...(trimString(effort) ? { effort: trimString(effort) } : {}),
            ...(trimString(preflight.org.projectId) ? { projectId: trimString(preflight.org.projectId) } : {}),
            organizationId: normalizedOrgId,
            organizationNodeId: nodeId,
            organizationRootSessionId: preflight.org.rootSessionId,
            organizationRevision: preflight.org.currentRevision,
            roleInstanceId: memberRoleInstanceId,
            controllerSessionId: parentSessId,
            parentSessionId: parentSessId,
            delegatedFromSessionId: parentSessId,
            delegationDepth: Number(preflight.actor.depth || 0) + 1,
            sessionPlane: 'organization',
            sessionClass: memberSessionClass,
            managedScope: 'organization',
            lifecycleMode: 'ephemeral_swarm',
            workspaceMode: memberWorkspace.workspaceMode,
            ...(memberWorkspace.workspaceMode !== 'inherit' && memberWorkspace.workspacePath
              ? {
                  workspacePath: memberWorkspace.workspacePath,
                  executionIsolation: memberWorkspace.workspaceMode === 'staging' ? 'container' : 'worktree',
                }
              : {}),
            ...(memberWorkspace.workspaceBranch ? { workspaceBranch: memberWorkspace.workspaceBranch } : {}),
            userAddressable: false,
            ...(isReviewer ? {
              accessMode: 'read',
              readOnlyRequired: requireCertifiedReadOnly,
              ...(requireCertifiedReadOnly ? {} : { readOnlyAdvisory: true }),
            } : {
              readOnlyRequired: false,
            }),
            handoffBundle: preflight.handoffBundle,
          },
        );
        managedSessionId = trimString(createdSession?.id || createdSession?.sessionId || createdSession);
      } else {
        managedSessionId = `swarm_sess_${randomBytes(8).toString('hex')}`;
      }

      preparedMembers.push({
        nodeId,
        roleInstanceId: memberRoleInstanceId,
        sessionClass: memberSessionClass,
        memberName,
        combinedBrief,
        reservation,
        releaseBudget,
        workspace: memberWorkspace,
        managedSessionId,
        idempotencyKey: trimString(idempotencyKey) ? `${trimString(idempotencyKey)}:${idx}` : '',
      });
    }
  } catch (error) {
    await rollbackAll();
    throw error;
  }

  // Phase 3: Atomically insert organization_nodes, MANAGES edges, subscriptions, and brief @mentions.
  const spawnedMembers = [];
  const postedMessages = [];
  const createdWakeups = [];
  try {
    await runWithOrgDb(db, async (conn) => {
      const ts = nowIso();
      for (const chanName of normalizedChannels) {
        await createBoardChannel(conn, {
          organizationId: normalizedOrgId,
          name: chanName,
          createdByNodeId: preflight.actor.id,
        });
      }
      conn.exec('BEGIN IMMEDIATE');
      try {

        for (const item of preparedMembers) {
          const initialConfig = normalizeRuntimeTuple({
            tool: preflight.derivedGrant?.runtimePolicy?.tool || harness || preflight.actor?.harness || 'codex',
            provider: preflight.derivedGrant?.runtimePolicy?.providerProfile || provider,
            model: preflight.derivedGrant?.runtimePolicy?.model || model,
            effort: preflight.derivedGrant?.runtimePolicy?.effort || effort,
          });
          const effectiveParentWorkItemId = trimString(parentWorkItemId || workItemId);
          const memberGrant = {
            ...preflight.derivedGrant,
            swarmName: item.memberName,
            ...(effectiveParentWorkItemId ? { parentWorkItemId: effectiveParentWorkItemId, workItemId: effectiveParentWorkItemId } : {}),
            modelHistory: [
              createModelEpoch({
                epochIndex: 1,
                bindingGeneration: 1,
                startedAt: ts,
                reason: 'initial_spawn',
                requestedConfig: initialConfig,
                resolvedConfig: initialConfig,
              }),
            ],
            ...(item.reservation ? { swarmReservation: item.reservation } : {}),
            swarmWorkspace: {
              mode: item.workspace.workspaceMode,
              path: item.workspace.workspacePath,
              branch: item.workspace.workspaceBranch,
              baseRef: item.workspace.baseRef,
              projectRoot: effectiveProjectRoot,
              leaseId: item.workspace.lease?.leaseId || item.workspace.lease?.id || '',
              leaseGeneration: item.workspace.lease?.generation || 0,
            },
            ...(preflight.handoffBundle ? { forkHandoff: preflight.handoffBundle } : {}),
          };

          conn.prepare(`INSERT INTO organization_nodes
            (id, organization_id, stable_key, node_role, created_revision, retired_revision, lifecycle_state, version, grant_json,
             current_session_id, binding_generation, role_instance_id, parent_node_id, depth, session_class, idempotency_key,
             lifecycle_mode, swarm_state, workspace_mode, workspace_path, workspace_branch)
            VALUES (?, ?, ?, ?, ?, NULL, 'active', 1, ?, ?, 1, ?, ?, ?, ?, ?, 'ephemeral_swarm', 'waiting', ?, ?, ?)`)
            .run(
              item.nodeId,
              normalizedOrgId,
              item.memberName,
              preflight.contractRole,
              preflight.org.currentRevision,
              encodeJson(memberGrant, {}),
              item.managedSessionId || null,
              item.roleInstanceId,
              preflight.actor.id,
              Number(preflight.actor.depth || 0) + 1,
              item.sessionClass,
              item.idempotencyKey || null,
              item.workspace.workspaceMode,
              item.workspace.workspacePath || null,
              item.workspace.workspaceBranch || null,
            );

          conn.prepare(`INSERT OR IGNORE INTO organization_edges
            (id, organization_id, organization_revision, stable_key, edge_type, parent_node_id, child_node_id, idempotency_key, created_at)
            VALUES (?, ?, ?, ?, 'MANAGES', ?, ?, NULL, ?)`)
            .run(
              makeId('oedge'),
              normalizedOrgId,
              preflight.org.currentRevision,
              `manages:${preflight.actor.id}:${item.nodeId}`,
              preflight.actor.id,
              item.nodeId,
              ts,
            );

          for (const chanName of normalizedChannels) {
            conn.prepare(`INSERT OR IGNORE INTO organization_board_channel_subscriptions
              (organization_id, channel_name, node_id, subscribed_at) VALUES (?, ?, ?, ?)`)
              .run(normalizedOrgId, chanName, item.nodeId, ts);
          }
        }
        conn.exec('COMMIT');
      } catch (error) {
        try { conn.exec('ROLLBACK'); } catch {}
        throw error;
      }

      const primaryChannel = normalizedChannels.find((c) => c !== 'main') || 'main';
      for (const item of preparedMembers) {
        const postRes = await postBoardMessage(conn, {
          organizationId: normalizedOrgId,
          channel: primaryChannel,
          senderKind: 'node',
          senderNodeId: preflight.actor.id,
          senderName: preflight.actor.stableKey,
          bodyMarkdown: `@${item.memberName} ${item.combinedBrief}`,
          kind: 'brief',
          isDoneSignal: false,
        });
        postedMessages.push(postRes.message);
        createdWakeups.push(...postRes.wakeups);
        const nodeRow = conn.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(item.nodeId);
        spawnedMembers.push(serializeSwarmMember(nodeRow, new Map([[item.nodeId, normalizedChannels]])));
      }
    }, { mutate: true, organizationId: normalizedOrgId });
  } catch (error) {
    await rollbackAll();
    throw error;
  }

  if (!deferDelivery && (typeof deps.deliverSessionMessage === 'function' || typeof deps.sendMessage === 'function')) {
    await deliverPendingSwarmWakeups({ ...deps, ...(db ? { db } : {}) }, { organizationId: normalizedOrgId }).catch(() => {});
  }

  return {
    organizationId: normalizedOrgId,
    members: spawnedMembers,
    messages: postedMessages,
    wakeups: createdWakeups,
    handoffBundle: preflight.handoffBundle,
    replay: false,
  };
}

export async function getSwarmStatus(firstArg, secondArg) {
  const { db, options } = splitDbOrDeps(firstArg, secondArg);
  const { organizationId, includeKilled = false } = options;
  const normalizedOrgId = trimString(organizationId);
  if (!normalizedOrgId) throw swarmError('BAD_REQUEST', 'organizationId is required', 400);

  return runWithOrgDb(db, async (conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrgId);
    if (!orgRow) throw swarmError('ORGANIZATION_NOT_FOUND', `organization ${normalizedOrgId} not found`, 404);
    const orgPolicy = parseJson(orgRow.policy_json, {});
    const orgBudget = parseJson(orgRow.budget_json, {});

    const subRows = conn.prepare(
      'SELECT node_id, channel_name FROM organization_board_channel_subscriptions WHERE organization_id = ? ORDER BY channel_name ASC',
    ).all(normalizedOrgId);
    const subsByNode = new Map();
    for (const sub of subRows) {
      const list = subsByNode.get(sub.node_id) || [];
      list.push(sub.channel_name);
      subsByNode.set(sub.node_id, list);
    }

    const nodeRows = conn.prepare(`
      SELECT * FROM organization_nodes
      WHERE organization_id = ?
      ORDER BY depth ASC, stable_key ASC
    `).all(normalizedOrgId);
    const allMembers = nodeRows.map((row) => serializeSwarmMember(row, subsByNode));
    const counts = { waiting: 0, working: 0, stopped: 0, killed: 0, active: 0, total: allMembers.length };
    for (const m of allMembers) {
      counts[m.swarmState] = (counts[m.swarmState] || 0) + 1;
      if (m.swarmState !== 'killed') counts.active += 1;
    }

    const members = includeKilled ? allMembers : allMembers.filter((m) => m.swarmState !== 'killed');
    const channels = await listBoardChannels(conn, { organizationId: normalizedOrgId });
    const headSeq = Number(conn.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS head_seq FROM organization_board_messages WHERE organization_id = ?',
    ).get(normalizedOrgId)?.head_seq || 0);
    const isDone = isSwarmMarkedDoneSync(conn, normalizedOrgId, orgPolicy);

    const activeStalls = conn.prepare(
      "SELECT * FROM organization_swarm_stall_alerts WHERE organization_id = ? AND state = 'active' ORDER BY last_alert_at DESC",
    ).all(normalizedOrgId).map((row) => ({
      id: row.id,
      dedupeKey: row.dedupe_key,
      conditionKind: row.condition_kind,
      targetRole: row.target_role,
      targetNodeId: row.target_node_id || '',
      boardSeq: row.board_seq ?? null,
      details: parseJson(row.details_json, {}),
      alertCount: Number(row.alert_count || 1),
      lastAlertAt: row.last_alert_at,
    }));

    const hasBudgetTable = Boolean(
      conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'organization_budget_counters'").get(),
    );
    const counterRow = hasBudgetTable
      ? conn.prepare(
        'SELECT * FROM organization_budget_counters WHERE organization_id = ? AND revision = ?',
      ).get(normalizedOrgId, Number(orgRow.current_revision || 0))
      : null;
    const budget = {
      limits: orgBudget,
      totals: counterRow ? parseJson(counterRow.totals_json, {}) : {},
      reserved: counterRow ? parseJson(counterRow.reserved_json, {}) : {},
    };

    const usageByModel = summarizeUsageByModel(
      allMembers.flatMap((member) => (Array.isArray(member.modelHistory) ? member.modelHistory : [])),
    );

    return {
      organizationId: normalizedOrgId,
      title: trimString(orgPolicy?.swarmTitle || orgPolicy?.title) || null,
      headSeq,
      isDone,
      counts,
      members,
      channels,
      budget,
      usageByModel,
      activeStalls,
    };
  });
}

export async function markSwarmMemberState(firstArg, secondArg) {
  const { db, options } = splitDbOrDeps(firstArg, secondArg);
  const { organizationId, nodeId, swarmState, reason = '', lastRunId = '' } = options;
  const normalizedOrgId = trimString(organizationId);
  const targetNodeId = trimString(nodeId);
  const nextState = trimString(swarmState).toLowerCase();
  if (!normalizedOrgId || !targetNodeId) throw swarmError('BAD_REQUEST', 'organizationId and nodeId are required', 400);
  if (!SWARM_STATES.includes(nextState)) throw swarmError('BAD_REQUEST', `Invalid swarmState "${swarmState}"`, 400);

  return runWithOrgDb(db, (conn) => {
    const row = conn.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?').get(targetNodeId, normalizedOrgId);
    if (!row) throw swarmError('ORGANIZATION_NODE_NOT_FOUND', `node ${targetNodeId} not found`, 404);
    const current = resolveMemberSwarmState(row);
    if (current === 'killed' && nextState !== 'killed') {
      throw swarmError('SWARM_MEMBER_KILLED', `Member ${row.stable_key} is permanently killed and cannot be revived`, 409);
    }
    const grant = parseJson(row.grant_json, {});
    if (trimString(reason)) grant.lastStateReason = trimString(reason).slice(0, 300);
    if (trimString(lastRunId)) grant.lastRunId = trimString(lastRunId);
    conn.prepare(`UPDATE organization_nodes
      SET swarm_state = ?,
          lifecycle_state = CASE WHEN ? = 'killed' THEN 'retired' ELSE lifecycle_state END,
          grant_json = ?,
          version = version + 1
      WHERE id = ? AND organization_id = ?`)
      .run(nextState, nextState, encodeJson(grant, {}), targetNodeId, normalizedOrgId);
    if (nextState === 'working' && trimString(reason) !== 'stall_wakeup_delivery') {
      conn.prepare("UPDATE organization_swarm_stall_alerts SET state = 'resolved', resolved_at = ? WHERE organization_id = ? AND state = 'active'")
        .run(nowIso(), normalizedOrgId);
    }
    return serializeSwarmMember(conn.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(targetNodeId));
  }, { mutate: true, organizationId: normalizedOrgId });
}

export async function markSwarmDone(firstArg, secondArg) {
  const { db, options } = splitDbOrDeps(firstArg, secondArg);
  const { organizationId, actorNodeId = '', summary = '', postToBoard = false } = options;
  const normalizedOrgId = trimString(organizationId);
  if (!normalizedOrgId) throw swarmError('BAD_REQUEST', 'organizationId is required', 400);

  return runWithOrgDb(db, async (conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrgId);
    if (!orgRow) throw swarmError('ORGANIZATION_NOT_FOUND', `organization ${normalizedOrgId} not found`, 404);
    if (trimString(actorNodeId)) {
      const actor = conn.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?').get(trimString(actorNodeId), normalizedOrgId);
      if (!actor) throw swarmError('SWARM_ACTOR_NOT_FOUND', 'actorNodeId does not belong to organization', 403);
      if (!isCoordinatorNodeRow(actor)) {
        throw swarmError('SWARM_DONE_FORBIDDEN', 'Only Coordinator or Owner may mark the Swarm done', 403);
      }
    }

    const ts = nowIso();
    const policy = parseJson(orgRow.policy_json, {});
    const nextPolicy = {
      ...policy,
      swarmDone: true,
      swarmDoneAt: ts,
      ...(trimString(summary) ? { swarmDoneSummary: trimString(summary).slice(0, 1000) } : {}),
    };
    conn.exec('BEGIN IMMEDIATE');
    try {
      conn.prepare('UPDATE organizations SET policy_json = ?, updated_at = ? WHERE id = ?')
        .run(encodeJson(nextPolicy, {}), ts, normalizedOrgId);
      conn.prepare("UPDATE organization_swarm_stall_alerts SET state = 'resolved', resolved_at = ? WHERE organization_id = ? AND state = 'active'")
        .run(ts, normalizedOrgId);
      conn.exec('COMMIT');
    } catch (error) {
      try { conn.exec('ROLLBACK'); } catch {}
      throw error;
    }

    let message = null;
    if (postToBoard || trimString(summary)) {
      const bodyText = trimString(summary)
        ? `[done] ${trimString(summary)}`
        : '[done] Swarm coordination marked complete.';
      const res = await postBoardMessage(conn, {
        organizationId: normalizedOrgId,
        channel: 'main',
        senderKind: trimString(actorNodeId) ? 'node' : 'owner',
        senderNodeId: trimString(actorNodeId),
        bodyMarkdown: bodyText,
        kind: 'done',
        isDoneSignal: true,
      });
      message = res.message;
    }

    const headSeq = Number(conn.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS head_seq FROM organization_board_messages WHERE organization_id = ?',
    ).get(normalizedOrgId)?.head_seq || 0);
    return { organizationId: normalizedOrgId, isDone: true, headSeq, message };
  }, { mutate: true, organizationId: normalizedOrgId });
}

export async function inspectWorkspaceUnmergedChanges(deps, node, projectRoot) {
  const mode = node.workspace_mode || 'inherit';
  const wsPath = trimString(node.workspace_path);
  const grant = parseJson(node.grant_json, {});
  const wsMeta = grant?.swarmWorkspace || {};
  if (mode === 'inherit' || !wsPath) return { unmerged: false };
  if (trimString(wsMeta.sealedCandidateId)) return { unmerged: false };

  if (mode === 'worktree') {
    if (typeof deps.checkWorktreeDirty === 'function') {
      return deps.checkWorktreeDirty({ node, workspacePath: wsPath, workspaceBranch: node.workspace_branch || '', baseRef: wsMeta.baseRef || '' });
    }
    const execFn = deps.execFile || execFileAsync;
    let exists = true;
    await access(wsPath).catch(() => { exists = false; });
    if (!exists) return { unmerged: false };
    const statusRes = await execFn('git', ['-C', wsPath, 'status', '--porcelain'], { cwd: wsPath, maxBuffer: 512 * 1024 });
    const dirtyLines = trimString(statusRes.stdout).split(/\r?\n/).filter(Boolean);
    let unmergedCommits = 0;
    const branch = trimString(node.workspace_branch);
    const baseRef = trimString(wsMeta.baseRef) || 'HEAD';
    if (branch && trimString(projectRoot)) {
      try {
        const revRes = await execFn('git', ['-C', projectRoot, 'rev-list', '--count', `${baseRef}..${branch}`], { cwd: projectRoot });
        unmergedCommits = Number(trimString(revRes.stdout) || 0);
      } catch {}
    }
    if (dirtyLines.length > 0 || unmergedCommits > 0) {
      return {
        unmerged: true,
        reason: dirtyLines.length > 0
          ? `Worktree has ${dirtyLines.length} uncommitted file(s)`
          : `Branch ${branch} has ${unmergedCommits} unmerged commit(s)`,
        dirtyFiles: dirtyLines,
        unmergedCommits,
      };
    }
    return { unmerged: false };
  }

  if (mode === 'staging') {
    const resolveDiffFn = deps.resolveStagingDiff || resolveStagingDiff;
    const writablePaths = Array.isArray(grant.writablePaths) ? grant.writablePaths : [];
    const diff = await resolveDiffFn(wsPath, projectRoot || process.cwd(), writablePaths).catch(() => []);
    if (Array.isArray(diff) && diff.length > 0) {
      return {
        unmerged: true,
        reason: `Staging workspace has ${diff.length} unsealed change(s)`,
        dirtyFiles: diff.map((d) => d.path || String(d)),
        unmergedCommits: 0,
      };
    }
  }
  return { unmerged: false };
}

export async function killSwarmMember(firstArg, secondArg) {
  const { db, deps, options } = splitDbOrDeps(firstArg, secondArg);
  const {
    organizationId,
    actorNodeId = '',
    targetNameOrNodeId = '',
    targetNodeId = '',
    forceDiscard = false,
    projectRoot = '',
  } = options;
  const normalizedOrgId = trimString(organizationId);
  const targetQuery = trimString(targetNameOrNodeId || targetNodeId);
  if (!normalizedOrgId || !targetQuery) {
    throw swarmError('BAD_REQUEST', 'organizationId and targetNameOrNodeId are required', 400);
  }

  const lookup = await runWithOrgDb(db, (conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrgId);
    if (!orgRow) throw swarmError('ORGANIZATION_NOT_FOUND', `organization ${normalizedOrgId} not found`, 404);
    const targetRow = conn.prepare(`
      SELECT * FROM organization_nodes
      WHERE organization_id = ? AND (id = ? OR LOWER(stable_key) = LOWER(?))
      LIMIT 1
    `).get(normalizedOrgId, targetQuery, targetQuery);
    if (!targetRow) {
      throw swarmError('ORGANIZATION_NODE_NOT_FOUND', `Swarm member "${targetQuery}" not found`, 404);
    }
    if (isCoordinatorNodeRow(targetRow)) {
      throw swarmError('SWARM_CANNOT_KILL_COORDINATOR', 'Cannot kill the root Coordinator node', 409);
    }
    if (trimString(actorNodeId)) {
      const actorRow = conn.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?').get(trimString(actorNodeId), normalizedOrgId);
      if (!actorRow) throw swarmError('SWARM_ACTOR_NOT_FOUND', 'actorNodeId does not belong to organization', 403);
      const isCoord = isCoordinatorNodeRow(actorRow);
      const isDirectAdder = targetRow.parent_node_id === actorRow.id;
      if (!isCoord && !isDirectAdder) {
        throw swarmError('SWARM_KILL_FORBIDDEN', 'Only Coordinator or the spawning parent may kill this member', 403);
      }
    }
    return { orgRow, targetRow, orgPolicy: parseJson(orgRow.policy_json, {}) };
  });

  if (resolveMemberSwarmState(lookup.targetRow) === 'killed') {
    return { killed: true, alreadyKilled: true, node: serializeSwarmMember(lookup.targetRow) };
  }

  const targetGrant = parseJson(lookup.targetRow.grant_json, {});
  const targetWsMeta = targetGrant?.swarmWorkspace || {};
  const effectiveProjectRoot = trimString(projectRoot)
    || trimString(targetWsMeta.projectRoot)
    || trimString(lookup.orgPolicy?.projectRoot)
    || trimString(lookup.orgPolicy?.workspaceScope)
    || process.cwd();

  if (forceDiscard !== true) {
    const dirtyCheck = await inspectWorkspaceUnmergedChanges(deps, lookup.targetRow, effectiveProjectRoot);
    if (dirtyCheck?.unmerged) {
      throw swarmError(
        SWARM_WORKSPACE_UNMERGED_CHANGES,
        `Refusing to kill "${lookup.targetRow.stable_key}": ${dirtyCheck.reason || 'workspace has unmerged changes'}. Merge, seal a candidate, or pass forceDiscard=true.`,
        409,
        {
          workspaceMode: lookup.targetRow.workspace_mode || 'inherit',
          workspacePath: lookup.targetRow.workspace_path || '',
          workspaceBranch: lookup.targetRow.workspace_branch || '',
          dirtyFiles: dirtyCheck.dirtyFiles || [],
          unmergedCommits: dirtyCheck.unmergedCommits || 0,
        },
      );
    }
  }

  // Cancel any active Run on the member's bound session.
  const memberSessionId = trimString(lookup.targetRow.current_session_id);
  if (memberSessionId && typeof deps.requestRunCancel === 'function'
      && (typeof deps.getMemberRunStatus === 'function' || typeof deps.getRunState === 'function')) {
    const targetMember = serializeSwarmMember(lookup.targetRow);
    const runState = await resolveMemberRunInfo(deps, targetMember);
    const activeRunId = trimString(runState?.runId || runState?.activeRunId || runState?.id);
    const activeRunStatus = trimString(runState?.state || runState?.status).toLowerCase();
    const isRunActive = Boolean(runState?.running)
      || ['queued', 'preparing', 'accepted', 'running', 'waiting_user'].includes(activeRunStatus);
    if (activeRunId && isRunActive) {
      await deps.requestRunCancel(activeRunId).catch(() => {});
    }
  }

  // Clean up dedicated workspace and release any held lease.
  const grant = parseJson(lookup.targetRow.grant_json, {});
  const wsMeta = grant?.swarmWorkspace || {};
  if (wsMeta.leaseId) {
    await (deps.releaseLease || releaseLease)(wsMeta.leaseId, wsMeta.leaseGeneration || 1, { reason: 'swarm_killed' }).catch(() => {});
  }
  const wsPath = trimString(lookup.targetRow.workspace_path);
  const wsMode = lookup.targetRow.workspace_mode || 'inherit';
  if (wsMode === 'worktree' && wsPath) {
    const execFn = deps.execFile || execFileAsync;
    if (typeof deps.removeWorktree === 'function') {
      await deps.removeWorktree({
        rootPath: effectiveProjectRoot,
        worktreePath: wsPath,
        branchName: lookup.targetRow.workspace_branch || '',
        force: true,
      }).catch(() => {});
    } else {
      await removeGitWorktree({ rootPath: effectiveProjectRoot, worktreePath: wsPath, execFileFn: execFn }).catch(() => {});
      if (trimString(lookup.targetRow.workspace_branch)) {
        await execFn('git', ['-C', effectiveProjectRoot, 'branch', '-D', lookup.targetRow.workspace_branch], { cwd: effectiveProjectRoot }).catch(() => {});
      }
    }
  } else if (wsMode === 'staging' && wsPath) {
    await (deps.discardStaging || discardStaging)(wsPath).catch(() => {});
  }

  // Release budget reservation if held.
  if (grant?.swarmReservation?.reservationId) {
    const releaseFn = typeof deps.releaseOrganizationBudgetReservation === 'function'
      ? deps.releaseOrganizationBudgetReservation
      : (!db && getOrganizationRuntimeCapabilities().stallGovernor === true ? releaseOrganizationBudgetReservation : null);
    if (releaseFn) {
      await releaseFn({
        organizationId: normalizedOrgId,
        revision: Number(grant.swarmReservation.revision ?? lookup.orgRow.current_revision ?? 0),
        reservationId: grant.swarmReservation.reservationId,
        idempotencyKey: grant.swarmReservation.idempotencyKey || grant.swarmReservation.reservationId,
        reason: 'swarm_member_killed',
      }).catch(() => {});
    }
  }

  const killedNode = await runWithOrgDb(db, (conn) => {
    const ts = nowIso();
    conn.exec('BEGIN IMMEDIATE');
    try {
      conn.prepare(`UPDATE organization_nodes
        SET swarm_state = 'killed',
            lifecycle_state = 'retired',
            retired_revision = ?,
            version = version + 1
        WHERE id = ? AND organization_id = ?`)
        .run(Number(lookup.orgRow.current_revision || 0), lookup.targetRow.id, normalizedOrgId);
      conn.prepare(`UPDATE organization_board_wakeups
        SET state = 'cancelled', updated_at = ?
        WHERE organization_id = ? AND target_node_id = ? AND state IN ('pending', 'deferred')`)
        .run(ts, normalizedOrgId, lookup.targetRow.id);
      conn.exec('COMMIT');
    } catch (error) {
      try { conn.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return serializeSwarmMember(conn.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(lookup.targetRow.id));
  }, { mutate: true, organizationId: normalizedOrgId });

  return { killed: true, alreadyKilled: false, node: killedNode };
}

async function verifyStoppedSwarmMember(deps, member, organizationRow) {
  if (typeof deps.verifyStoppedMemberBinding === 'function') {
    return deps.verifyStoppedMemberBinding({ member, organization: organizationRow });
  }
  if (!member.currentSessionId) {
    return { ok: false, reason: 'Member has no bound sessionId' };
  }
  if (typeof deps.getSession === 'function') {
    const session = await deps.getSession(member.currentSessionId).catch(() => null);
    if (!session) return { ok: false, reason: 'Bound session no longer exists' };
  }
  if (['worktree', 'staging'].includes(member.workspaceMode) && member.workspacePath) {
    try {
      await access(member.workspacePath);
    } catch {
      return { ok: false, reason: `Workspace directory is unavailable: ${member.workspacePath}` };
    }
  }
  return { ok: true };
}

export async function deliverPendingSwarmWakeups(firstArg, secondArg) {
  const { db, deps, options } = splitDbOrDeps(firstArg, secondArg);
  const { organizationId = '' } = options;
  const deliverFn = deps.deliverSessionMessage || deps.sendMessage;
  if (typeof deliverFn !== 'function') {
    return { attempted: 0, delivered: 0, deferred: 0, cancelled: 0, failed: 0 };
  }

  const pending = await runWithOrgDb(db, (conn) => {
    const query = trimString(organizationId)
      ? conn.prepare("SELECT * FROM organization_board_wakeups WHERE organization_id = ? AND state IN ('pending', 'deferred') ORDER BY created_at ASC")
        .all(trimString(organizationId))
      : conn.prepare("SELECT * FROM organization_board_wakeups WHERE state IN ('pending', 'deferred') ORDER BY created_at ASC")
        .all();
    return query.map((w) => {
      const nodeRow = conn.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?')
        .get(w.target_node_id, w.organization_id);
      const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(w.organization_id);
      const msgRow = conn.prepare('SELECT body_markdown, sender_name FROM organization_board_messages WHERE organization_id = ? AND seq = ?')
        .get(w.organization_id, w.latest_seq);
      return {
        wakeup: w,
        orgRow,
        nodeRow,
        preview: trimString(msgRow?.body_markdown).slice(0, 320),
        senderName: trimString(msgRow?.sender_name),
      };
    });
  });

  const stats = { attempted: 0, delivered: 0, deferred: 0, cancelled: 0, failed: 0 };
  for (const entry of pending) {
    const { wakeup, orgRow, nodeRow, preview, senderName } = entry;
    const member = nodeRow ? serializeSwarmMember(nodeRow) : null;
    if (!orgRow || ['archived', 'lifecycle_pending'].includes(orgRow.state)
        || !member || member.lifecycleState !== 'active' || member.swarmState === 'killed' || !member.currentSessionId) {
      await runWithOrgDb(db, (conn) => {
        conn.prepare("UPDATE organization_board_wakeups SET state = 'cancelled', updated_at = ? WHERE id = ?")
          .run(nowIso(), wakeup.id);
      }, { mutate: true, organizationId: wakeup.organization_id });
      stats.cancelled += 1;
      continue;
    }

    stats.attempted += 1;
    if (member.swarmState === 'stopped') {
      const verified = await verifyStoppedSwarmMember(deps, member, orgRow);
      if (!verified?.ok) {
        await markBoardWakeupDeferred(db || undefined, {
          wakeupId: wakeup.id,
          reason: verified?.reason || 'Stopped member binding/workspace verification failed',
        });
        stats.failed += 1;
        continue;
      }
    }

    const rawNodeGrant = nodeRow ? parseJson(nodeRow.grant_json, {}) : {};
    const pendingSwitchHandoff = rawNodeGrant?.pendingModelSwitchHandoff && typeof rawNodeGrant.pendingModelSwitchHandoff === 'object'
      ? rawNodeGrant.pendingModelSwitchHandoff
      : null;
    const handoffLines = pendingSwitchHandoff ? [
      `[Swarm Verified Model Switch Handoff]`,
      `Handoff: ${pendingSwitchHandoff.handoffId} | Binding generation: ${pendingSwitchHandoff.nextBindingGeneration} | Switched to ${pendingSwitchHandoff.resolvedConfig?.tool || member.harness}:${pendingSwitchHandoff.resolvedConfig?.model || pendingSwitchHandoff.resolvedConfig?.provider || 'default'}`,
      pendingSwitchHandoff.factoryTaskHandoffId ? `FactoryTaskHandoff: ${pendingSwitchHandoff.factoryTaskHandoffId}` : '',
      pendingSwitchHandoff.workspace && pendingSwitchHandoff.workspace.mode !== 'inherit'
        ? `Workspace (${pendingSwitchHandoff.workspace.mode}): branch=${pendingSwitchHandoff.workspace.branch || '(none)'}, dirtyFiles=${Array.isArray(pendingSwitchHandoff.workspace.dirtyFiles) ? pendingSwitchHandoff.workspace.dirtyFiles.length : 0}, unmergedCommits=${Number(pendingSwitchHandoff.workspace.unmergedCommits || 0)}`
        : '',
      pendingSwitchHandoff.boardRange
        ? `Unread board range: #${pendingSwitchHandoff.boardRange.unreadFromSeq}..#${pendingSwitchHandoff.boardRange.headSeq}`
        : '',
      pendingSwitchHandoff.briefSummary ? `Brief: ${pendingSwitchHandoff.briefSummary}` : '',
      pendingSwitchHandoff.handoffNotes ? `Handoff notes: ${pendingSwitchHandoff.handoffNotes}` : '',
    ] : [];

    const digest = [
      `[Swarm Board Doorbell — Untrusted Peer Content]`,
      `Channel #${wakeup.channel_name} | Trigger #${wakeup.trigger_seq} (latest #${wakeup.latest_seq}, coalesced=${wakeup.coalesced_count})`,
      senderName ? `From: ${senderName}` : '',
      preview ? `Preview: ${preview}` : '',
      ...handoffLines,
      `Call ragent_organization_read (action: "board.read", channel: "${wakeup.channel_name}", sinceSeq: ${Math.max(0, Number(wakeup.trigger_seq) - 1)}) for full messages.`,
    ].filter(Boolean).join('\n');

    try {
      const isReviewerMember = member.contractRole === 'reviewer' || String(member.sessionClass || '').toUpperCase() === 'REVIEWER';
      const requireCertifiedReadOnly = isReviewerMember && member.certifiedReadOnly === true;
      const res = await deliverFn(member.currentSessionId, digest, [], {
        queueIfBusy: false,
        deferIfBusy: true,
        skipPendingDispatchLookup: true,
        internalOrganizationWakeup: true,
        internalOperation: 'swarm_wakeup',
        ...(member.workspaceMode === 'worktree'
          ? { executionIsolation: 'worktree' }
          : (member.workspaceMode === 'staging' ? { executionIsolation: 'container' } : {})),
        ...(isReviewerMember ? {
          accessMode: 'read',
          readOnlyRequired: requireCertifiedReadOnly,
          ...(requireCertifiedReadOnly ? {} : { readOnlyAdvisory: true }),
        } : {}),
        ...(pendingSwitchHandoff ? { modelSwitchHandoff: pendingSwitchHandoff } : {}),
        organizationId: wakeup.organization_id,
        organizationNodeId: member.id,
        bindingGeneration: member.bindingGeneration,
        requestId: `swarm_wake_${wakeup.id}_seq_${wakeup.latest_seq}`,
      });
      if (res?.deferred === true) {
        await markBoardWakeupDeferred(db || undefined, {
          wakeupId: wakeup.id,
          reason: 'target_busy_deferred',
        });
        stats.deferred += 1;
        continue;
      }
      await markBoardWakeupDelivered(db || undefined, { wakeupId: wakeup.id });
      if (pendingSwitchHandoff) {
        await runWithOrgDb(db, (conn) => {
          const latestRow = conn.prepare('SELECT grant_json FROM organization_nodes WHERE id = ? AND organization_id = ?').get(member.id, wakeup.organization_id);
          if (!latestRow) return;
          const latestGrant = parseJson(latestRow.grant_json, {});
          if (latestGrant?.pendingModelSwitchHandoff?.handoffId === pendingSwitchHandoff.handoffId) {
            latestGrant.lastDeliveredModelSwitchHandoffId = pendingSwitchHandoff.handoffId;
            delete latestGrant.pendingModelSwitchHandoff;
            conn.prepare('UPDATE organization_nodes SET grant_json = ? WHERE id = ? AND organization_id = ?')
              .run(encodeJson(latestGrant, {}), member.id, wakeup.organization_id);
          }
        }, { mutate: true, organizationId: wakeup.organization_id });
      }
      const wakeupRunId = trimString(res?.run?.id || res?.runId);
      await markSwarmMemberState(db || undefined, {
        organizationId: wakeup.organization_id,
        nodeId: member.id,
        swarmState: 'working',
        ...(wakeupRunId ? { lastRunId: wakeupRunId } : {}),
        ...(wakeup.reason === 'stall' ? { reason: 'stall_wakeup_delivery' } : {}),
      });
      stats.delivered += 1;
    } catch (error) {
      await markBoardWakeupDeferred(db || undefined, {
        wakeupId: wakeup.id,
        reason: error?.message || 'Wakeup delivery failed',
      });
      stats.failed += 1;
    }
  }

  return stats;
}

const TERMINAL_SWARM_RUN_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
  'crashed',
  'error',
  'quota_exhausted',
  'approval_timeout',
]);
const FAILED_SWARM_RUN_STATES = new Set([
  'failed',
  'cancelled',
  'crashed',
  'error',
  'quota_exhausted',
  'approval_timeout',
]);

async function resolveMemberRunInfo(deps, member) {
  if (!member?.currentSessionId) return null;
  if (typeof deps.getMemberRunStatus === 'function') {
    return deps.getMemberRunStatus(member).catch(() => null);
  }
  if (typeof deps.getRunState !== 'function') return null;
  const session = typeof deps.getSession === 'function'
    ? await deps.getSession(member.currentSessionId).catch(() => null)
    : null;
  const activeRunId = trimString(session?.activeRunId);
  const candidateRunId = activeRunId || trimString(session?.lastRunId || member.lastRunId);
  if (candidateRunId) {
    const byRunId = await deps.getRunState(candidateRunId).catch(() => null);
    if (byRunId) return { ...byRunId, hasSessionActiveRun: Boolean(activeRunId) };
  }
  const fallback = await deps.getRunState(member.currentSessionId).catch(() => null);
  return fallback ? { ...fallback, hasSessionActiveRun: Boolean(activeRunId) } : null;
}

function hasEpochRecordedRun(memberOrGrant = {}, runId = '') {
  const normalizedRunId = trimString(runId);
  if (!normalizedRunId) return false;
  const history = Array.isArray(memberOrGrant?.modelHistory) ? memberOrGrant.modelHistory : [];
  return history.some((epoch) => Array.isArray(epoch?.usage?.runIds) && epoch.usage.runIds.includes(normalizedRunId));
}

export async function settleSwarmMemberRunState(firstArg, secondArg) {
  const { db, deps, options } = splitDbOrDeps(firstArg, secondArg);
  const {
    sessionId = '',
    runId = '',
    state = '',
    failureReason = '',
    usage = null,
    actualReportedConfig = null,
    run: explicitRun = null,
    session: explicitSession = null,
  } = options;
  const targetSessionId = trimString(sessionId);
  if (!targetSessionId) return { settled: false, count: 0, nodes: [] };

  const normalizedState = trimString(state).toLowerCase();
  const isFailure = FAILED_SWARM_RUN_STATES.has(normalizedState);
  const cleanReason = isFailure
    ? `run_failed:${normalizedState}${trimString(failureReason) ? `: ${redactSecrets(trimString(failureReason))}` : ''}`.slice(0, 300)
    : 'run_completed_without_wait';

  let resolvedRun = explicitRun;
  const normalizedRunId = trimString(runId);
  if (!resolvedRun && normalizedRunId && !db) {
    if (typeof deps.getRun === 'function') {
      resolvedRun = await deps.getRun(normalizedRunId).catch(() => null);
    } else if (deps.skipRunLookup !== true) {
      try {
        const runsMod = await import('./runs.mjs');
        resolvedRun = await runsMod.getRun(normalizedRunId).catch(() => null);
      } catch {}
    }
  }
  let resolvedSession = explicitSession;
  if (!resolvedSession && typeof deps.getSession === 'function') {
    resolvedSession = await deps.getSession(targetSessionId).catch(() => null);
  }

  return runWithOrgDb(db, (conn) => {
    const activeNodes = conn.prepare(`
      SELECT n.*
      FROM organization_nodes n
      JOIN organizations o ON o.id = n.organization_id
      WHERE n.current_session_id = ?
        AND n.lifecycle_mode = 'ephemeral_swarm'
        AND n.lifecycle_state = 'active'
        AND n.retired_revision IS NULL
        AND COALESCE(NULLIF(LOWER(TRIM(n.swarm_state)), ''), 'waiting') != 'killed'
        AND o.state = 'active'
    `).all(targetSessionId);
    if (!activeNodes.length) return { settled: false, count: 0, nodes: [] };

    const settledNodes = [];
    for (const row of activeNodes) {
      const currentState = resolveMemberSwarmState(row);
      const isWorking = currentState === 'working';
      const grant = parseJson(row.grant_json, {});
      const beforeGrantJson = encodeJson(grant, {});
      if (isWorking) {
        grant.lastStateReason = cleanReason;
        if (normalizedRunId) grant.lastRunId = normalizedRunId;
      } else if (normalizedRunId) {
        grant.lastRunId = normalizedRunId;
      }
      recordEpochRunTelemetry(grant, {
        bindingGeneration: Number(row.binding_generation || 1),
        runId: normalizedRunId || trimString(grant.lastRunId),
        run: resolvedRun,
        session: resolvedSession,
        usage,
        actualReportedConfig,
      });
      if (isFailure && (isWorking || !grant.lastRunFailure || grant.lastRunFailure.runId !== normalizedRunId)) {
        if (!isWorking) grant.lastStateReason = cleanReason;
        grant.lastRunFailure = {
          runId: normalizedRunId,
          state: normalizedState,
          reason: redactSecrets(trimString(failureReason) || normalizedState).slice(0, 240),
          failedAt: nowIso(),
        };
      }
      const afterGrantJson = encodeJson(grant, {});
      if (!isWorking && beforeGrantJson === afterGrantJson) {
        continue;
      }
      const info = conn.prepare(`
        UPDATE organization_nodes
        SET swarm_state = CASE WHEN swarm_state = 'working' THEN 'waiting' ELSE swarm_state END,
            grant_json = ?,
            version = version + 1
        WHERE id = ?
          AND organization_id = ?
          AND version = ?
          AND COALESCE(NULLIF(LOWER(TRIM(swarm_state)), ''), 'waiting') != 'killed'
      `).run(afterGrantJson, row.id, row.organization_id, row.version);
      if (info.changes > 0) {
        settledNodes.push(serializeSwarmMember(
          conn.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(row.id),
        ));
      }
    }
    return { settled: settledNodes.length > 0, count: settledNodes.length, nodes: settledNodes };
  }, { mutate: true });
}

export async function reconcileSwarmMemberStates(firstArg, secondArg) {
  const { db, deps, options } = splitDbOrDeps(firstArg, secondArg);
  const { organizationId } = options;
  const normalizedOrgId = trimString(organizationId);
  if (!normalizedOrgId) return { checked: 0, settled: 0, nodes: [] };
  if (typeof deps.getMemberRunStatus !== 'function' && typeof deps.getRunState !== 'function') {
    return { checked: 0, settled: 0, nodes: [] };
  }

  const candidateNodes = await runWithOrgDb(db, (conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrgId);
    if (!orgRow || ['archived', 'lifecycle_pending'].includes(orgRow.state)) return [];
    return conn.prepare(`
      SELECT * FROM organization_nodes
      WHERE organization_id = ?
        AND lifecycle_mode = 'ephemeral_swarm'
        AND lifecycle_state = 'active'
        AND retired_revision IS NULL
        AND COALESCE(NULLIF(LOWER(TRIM(swarm_state)), ''), 'waiting') != 'killed'
    `).all(normalizedOrgId).map((row) => serializeSwarmMember(row));
  });

  let settled = 0;
  const nodes = [];
  for (const member of candidateNodes) {
    const isWorking = member.swarmState === 'working';
    if (!isWorking && member.lastRunId && hasEpochRecordedRun(member, member.lastRunId)) {
      continue;
    }
    const runInfo = await resolveMemberRunInfo(deps, member);
    if (!runInfo) continue;
    const terminalState = trimString(runInfo?.state || runInfo?.status).toLowerCase();
    if (!TERMINAL_SWARM_RUN_STATES.has(terminalState)
        || runInfo?.running === true
        || runInfo?.hasSessionActiveRun === true) {
      continue;
    }
    const candidateRunId = trimString(runInfo?.runId || runInfo?.id || member.lastRunId);
    if (!isWorking && (!candidateRunId || hasEpochRecordedRun(member, candidateRunId))) {
      continue;
    }
    const res = await settleSwarmMemberRunState({ ...deps, ...(db ? { db } : {}) }, {
      sessionId: member.currentSessionId,
      runId: candidateRunId,
      state: terminalState,
      failureReason: trimString(runInfo?.failureReason || runInfo?.error),
      ...(runInfo?.usage ? { usage: runInfo.usage } : {}),
      ...(runInfo?.actualReportedConfig ? { actualReportedConfig: runInfo.actualReportedConfig } : {}),
      run: runInfo,
    });
    if (res.settled) {
      settled += res.count;
      nodes.push(...res.nodes);
    }
  }
  return { checked: candidateNodes.length, settled, nodes };
}

function parseMs(iso) {
  const t = Date.parse(trimString(iso));
  return Number.isFinite(t) ? t : 0;
}

export async function evaluateSwarmStalls(firstArg, secondArg) {
  const { db, deps, options } = splitDbOrDeps(firstArg, secondArg);
  const {
    organizationId,
    nowMs = Date.now(),
    stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
    cooldownMs = DEFAULT_STALL_COOLDOWN_MS,
    maxAlerts = DEFAULT_STALL_MAX_ALERTS,
  } = options;
  const normalizedOrgId = trimString(organizationId);
  if (!normalizedOrgId) throw swarmError('BAD_REQUEST', 'organizationId is required', 400);

  const snapshot = await runWithOrgDb(db, (conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrgId);
    if (!orgRow) return null;
    const orgPolicy = parseJson(orgRow.policy_json, {});
    if (isSwarmMarkedDoneSync(conn, normalizedOrgId, orgPolicy) || ['archived', 'lifecycle_pending'].includes(orgRow.state)) {
      return { skip: true };
    }
    const nodes = conn.prepare('SELECT * FROM organization_nodes WHERE organization_id = ? ORDER BY depth ASC, stable_key ASC')
      .all(normalizedOrgId).map((r) => serializeSwarmMember(r));
    const wakeups = conn.prepare("SELECT * FROM organization_board_wakeups WHERE organization_id = ? AND state IN ('pending', 'deferred')")
      .all(normalizedOrgId);
    const cursors = conn.prepare('SELECT reader_id, COALESCE(MAX(last_read_seq), 0) AS last_read_seq FROM organization_board_cursors WHERE organization_id = ? GROUP BY reader_id')
      .all(normalizedOrgId);
    const cursorByReader = new Map(cursors.map((c) => [c.reader_id, Number(c.last_read_seq || 0)]));
    const lastNonStallMsg = conn.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq, MAX(created_at) AS last_at FROM organization_board_messages WHERE organization_id = ? AND is_stall_alert = 0',
    ).get(normalizedOrgId);
    const existingAlerts = conn.prepare('SELECT * FROM organization_swarm_stall_alerts WHERE organization_id = ?')
      .all(normalizedOrgId);
    return {
      skip: false,
      orgRow,
      orgPolicy,
      nodes,
      wakeups,
      cursorByReader,
      headSeq: Number(lastNonStallMsg?.max_seq || 0),
      lastBoardActivityMs: parseMs(lastNonStallMsg?.last_at) || parseMs(orgRow.updated_at) || parseMs(orgRow.created_at),
      existingAlertsByKey: new Map(existingAlerts.map((a) => [a.dedupe_key, a])),
    };
  });

  if (!snapshot || snapshot.skip) {
    return { evaluated: false, alertsEmitted: [], alertsSkipped: [] };
  }

  const activeNodes = snapshot.nodes.filter((n) => n.swarmState !== 'killed' && n.lifecycleState === 'active');
  const coordinator = activeNodes.find((n) => isCoordinatorNodeRow(n)) || null;
  const candidates = [];

  // Condition 3 (checked early so run status can inform Condition 1): crashed / failed member without recovery.
  const runInfoByNode = new Map();
  if (typeof deps.getMemberRunStatus === 'function' || typeof deps.getRunState === 'function') {
    for (const member of activeNodes) {
      if (!member.currentSessionId) continue;
      const runInfo = await resolveMemberRunInfo(deps, member);
      if (runInfo) runInfoByNode.set(member.nodeId, runInfo);
      const terminalState = trimString(runInfo?.state || runInfo?.status).toLowerCase();
      if (['failed', 'crashed', 'error', 'quota_exhausted', 'approval_timeout'].includes(terminalState)) {
        const errorSummary = redactSecrets(trimString(runInfo?.failureReason || runInfo?.error || terminalState)).slice(0, 200);
        const runKey = trimString(runInfo?.runId || runInfo?.id) || `${terminalState}:${member.bindingGeneration}`;
        candidates.push({
          dedupeKey: `crashed_member:${member.nodeId}:${runKey}`,
          conditionKind: 'crashed_member',
          affectedNode: member,
          summary: `Member @${member.name} terminated unexpectedly (${errorSummary}).`,
          details: { nodeId: member.nodeId, memberName: member.name, state: terminalState, reason: errorSummary },
        });
      }
    }
  }

  // Condition 2: Overdue unread @mention wakeup.
  for (const w of snapshot.wakeups) {
    const ageMs = nowMs - parseMs(w.created_at);
    const target = activeNodes.find((n) => n.nodeId === w.target_node_id);
    const readSeq = snapshot.cursorByReader.get(w.target_node_id) || 0;
    if (target && ageMs >= stallThresholdMs && target.swarmState !== 'working' && readSeq < Number(w.trigger_seq)) {
      candidates.push({
        dedupeKey: `overdue_mention:${target.nodeId}:${w.trigger_seq}`,
        conditionKind: 'overdue_mention',
        affectedNode: target,
        summary: `Member @${target.name} has an unconsumed @mention (#${w.trigger_seq}..#${w.latest_seq} in #${w.channel_name}) idle for ${Math.round(ageMs / 1000)}s.`,
        details: { nodeId: target.nodeId, memberName: target.name, channel: w.channel_name, triggerSeq: Number(w.trigger_seq), latestSeq: Number(w.latest_seq), ageMs },
      });
    }
  }

  // Condition 1: All non-killed members waiting/stopped while Swarm is not [done].
  if (activeNodes.length > 0 && activeNodes.every((n) => ['waiting', 'stopped'].includes(n.swarmState))) {
    const idleMs = nowMs - snapshot.lastBoardActivityMs;
    if (idleMs >= stallThresholdMs) {
      candidates.push({
        dedupeKey: `all_waiting:${snapshot.orgRow.current_revision || 0}:${snapshot.headSeq}`,
        conditionKind: 'all_waiting',
        affectedNode: null,
        summary: `All ${activeNodes.length} active members are idle (waiting/stopped) for ${Math.round(idleMs / 1000)}s and Swarm is not finished.`,
        details: { memberNames: activeNodes.map((n) => n.name), headSeq: snapshot.headSeq, idleMs },
      });
    }
  }

  const alertsEmitted = [];
  const alertsSkipped = [];
  const nowStr = nowIso(nowMs);

  for (const cand of candidates) {
    const prior = snapshot.existingAlertsByKey.get(cand.dedupeKey);
    if (prior) {
      const priorCount = Number(prior.alert_count || 1);
      const sinceLast = nowMs - parseMs(prior.last_alert_at);
      if (priorCount >= maxAlerts || sinceLast < cooldownMs) {
        alertsSkipped.push({ dedupeKey: cand.dedupeKey, reason: priorCount >= maxAlerts ? 'max_alerts_reached' : 'cooldown_active' });
        continue;
      }
    }

    const coordinatorCrashed = Boolean(
      !coordinator
      || cand.affectedNode?.nodeId === coordinator.nodeId
      || ['crashed', 'failed'].includes(trimString(runInfoByNode.get(coordinator.nodeId)?.state).toLowerCase())
      || (cand.conditionKind === 'all_waiting' && prior && Number(prior.alert_count || 1) >= 1),
    );
    const targetRole = coordinatorCrashed ? 'owner' : 'coordinator';
    const targetMention = targetRole === 'coordinator' && coordinator ? `@${coordinator.name} ` : '';
    const postRes = await postBoardMessage(db || undefined, {
      organizationId: normalizedOrgId,
      channel: 'main',
      senderKind: 'system',
      senderName: 'stall-watchdog',
      bodyMarkdown: `${targetMention}[stall] (${cand.conditionKind}) ${cand.summary}`,
      kind: 'stall',
      isDoneSignal: false,
      isStallAlert: true,
    });

    if (targetRole === 'owner' && typeof deps.notifyOwner === 'function') {
      await deps.notifyOwner({
        organizationId: normalizedOrgId,
        conditionKind: cand.conditionKind,
        summary: cand.summary,
        boardSeq: postRes.headSeq,
        details: cand.details,
      }).catch(() => {});
    }

    await runWithOrgDb(db, (conn) => {
      if (prior) {
        conn.prepare(`UPDATE organization_swarm_stall_alerts
          SET alert_count = alert_count + 1, target_role = ?, target_node_id = ?, board_seq = ?,
              details_json = ?, state = 'active', last_alert_at = ?
          WHERE id = ?`)
          .run(targetRole, targetRole === 'coordinator' && coordinator ? coordinator.nodeId : null, postRes.headSeq, encodeJson(cand.details, {}), nowStr, prior.id);
      } else {
        conn.prepare(`INSERT INTO organization_swarm_stall_alerts
          (id, organization_id, dedupe_key, condition_kind, target_role, target_node_id, board_seq, details_json, alert_count, state, last_alert_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`)
          .run(makeId('stall'), normalizedOrgId, cand.dedupeKey, cand.conditionKind, targetRole, targetRole === 'coordinator' && coordinator ? coordinator.nodeId : null, postRes.headSeq, encodeJson(cand.details, {}), nowStr, nowStr);
      }
    }, { mutate: true, organizationId: normalizedOrgId });

    alertsEmitted.push({
      dedupeKey: cand.dedupeKey,
      conditionKind: cand.conditionKind,
      targetRole,
      boardSeq: postRes.headSeq,
      message: postRes.message,
    });
  }

  return {
    evaluated: true,
    alertsEmitted,
    alertsSkipped,
  };
}

export async function listActiveSwarmOrganizations(db = null) {
  return runWithOrgDb(db, (conn) => {
    const rows = conn.prepare("SELECT id, policy_json FROM organizations WHERE state = 'active'").all();
    return rows
      .filter((r) => {
        const policy = parseJson(r.policy_json, {});
        return policy?.swarmEnabled === true && !isSwarmMarkedDoneSync(conn, r.id, policy);
      })
      .map((r) => r.id);
  });
}

function findSwarmNodeRow(conn, organizationId, query) {
  return conn.prepare(
    'SELECT * FROM organization_nodes WHERE organization_id = ? AND (id = ? OR LOWER(stable_key) = LOWER(?)) LIMIT 1',
  ).get(organizationId, query, query);
}

function normalizeRuntimeLockEntries(rawConstraints = null) {
  if (!rawConstraints || typeof rawConstraints !== 'object' || Array.isArray(rawConstraints)) return {};
  const result = {};
  for (const field of ['tool', 'provider', 'model', 'effort']) {
    const entry = rawConstraints[field];
    if (!entry) continue;
    if (Array.isArray(entry)) {
      result[field] = entry;
      continue;
    }
    if (typeof entry === 'string' && trimString(entry)) {
      result[field] = {
        value: ['tool', 'effort'].includes(field) ? trimString(entry).toLowerCase() : trimString(entry),
        mode: 'locked',
        source: 'owner',
        scope: 'organization',
        version: 1,
      };
    } else if (typeof entry === 'object') {
      result[field] = entry;
    }
  }
  return result;
}

function assertOwnerRuntimeLocksAllowSwitch({
  constraintsSources = [],
  scopes = ['organization'],
  candidateRuntime = {},
}) {
  const merged = {};
  for (const src of constraintsSources) {
    const normalizedSrc = normalizeRuntimeLockEntries(src);
    for (const [field, entry] of Object.entries(normalizedSrc)) {
      const list = Array.isArray(entry) ? entry : [entry];
      merged[field] = [...(merged[field] || []), ...list];
    }
  }
  if (Object.keys(merged).length === 0) return;
  let selected = {};
  try {
    selected = selectRuntimeConstraints(merged, scopes);
    assertRuntimeConstraints(candidateRuntime, selected);
  } catch (error) {
    if (error?.code === 'ORG_RUNTIME_USER_LOCKED') {
      const lockedEntries = Object.entries(selected)
        .filter(([, entry]) => entry?.mode === 'locked')
        .map(([field, entry]) => `${field}=${entry.value}`);
      throw swarmError(
        SWARM_MODEL_LOCKED_BY_OWNER,
        `Cannot switch member runtime (${error.message}${lockedEntries.length ? `: ${lockedEntries.join(', ')}` : ''})`,
        409,
        { lockedConstraints: selected },
      );
    }
    throw error;
  }
}

async function validateModelSwitchCandidateAndBudget(conn, deps, {
  orgRow,
  orgPolicy = {},
  orgBudget = {},
  targetGrant = {},
  previousRuntime = {},
  proposedRuntime = {},
}) {
  if (orgPolicy?.allowModelSwitch === false) {
    throw swarmError(SWARM_MODEL_POLICY_DENIED, 'Organization policy disables runtime/model switching', 403);
  }
  const targetTool = trimString(proposedRuntime.tool).toLowerCase();
  if (!targetTool || (deps.allowCustomTools !== true && !TOOL_SET.has(targetTool))) {
    throw swarmError(
      SWARM_MODEL_CANDIDATE_INVALID,
      `Unsupported target harness/tool "${targetTool || '(empty)'}"`,
      422,
    );
  }
  if (Array.isArray(orgPolicy?.allowedHarnesses) && orgPolicy.allowedHarnesses.length > 0) {
    const allowedTools = new Set(orgPolicy.allowedHarnesses.map((t) => trimString(t).toLowerCase()).filter(Boolean));
    if (!allowedTools.has(targetTool)) {
      throw swarmError(SWARM_MODEL_POLICY_DENIED, `Harness "${targetTool}" is not allowed by organization policy`, 403);
    }
  }
  const targetModel = trimString(proposedRuntime.model);
  const policyAllowedModels = Array.isArray(orgPolicy?.allowedModels) ? orgPolicy.allowedModels : targetGrant?.runtimePolicy?.allowedModels;
  if (targetModel && Array.isArray(policyAllowedModels) && policyAllowedModels.length > 0) {
    const allowedSet = new Set(policyAllowedModels.map((m) => trimString(m)).filter(Boolean));
    if (!allowedSet.has(targetModel)) {
      throw swarmError(SWARM_MODEL_POLICY_DENIED, `Model "${targetModel}" is not in organization allowedModels policy`, 403);
    }
  }
  if (targetModel && Array.isArray(orgPolicy?.disallowedModels) && orgPolicy.disallowedModels.includes(targetModel)) {
    throw swarmError(SWARM_MODEL_POLICY_DENIED, `Model "${targetModel}" is disallowed by organization policy`, 403);
  }

  if (typeof deps.validateRuntimeCandidate === 'function') {
    const verdict = await deps.validateRuntimeCandidate({
      organizationId: orgRow.id,
      previousRuntime,
      proposedRuntime,
      orgPolicy,
      orgBudget,
    });
    if (verdict === false || verdict?.allowed === false) {
      throw swarmError(
        verdict?.code || SWARM_MODEL_CANDIDATE_INVALID,
        verdict?.reason || `Candidate ${targetTool}:${targetModel || '(default)'} is not permitted`,
        verdict?.statusCode || 422,
      );
    }
  }

  let catalog = Array.isArray(deps.runtimeCatalog) ? deps.runtimeCatalog : null;
  if (!catalog && typeof deps.getRuntimeCatalog === 'function') {
    catalog = await deps.getRuntimeCatalog().catch(() => null);
  }
  if (!catalog && deps.validateCatalog === true) {
    catalog = await buildOrganizationRuntimeCatalog().catch(() => null);
  }
  if (Array.isArray(catalog)) {
    const toolEntry = catalog.find((entry) => trimString(entry?.tool).toLowerCase() === targetTool);
    if (!toolEntry) {
      throw swarmError(SWARM_MODEL_CANDIDATE_INVALID, `Harness "${targetTool}" is not present in runtime catalog`, 422);
    }
    const providerCatalogModels = Array.isArray(toolEntry.providerCatalogs)
      && toolEntry.providerCatalogs.some((pc) => Array.isArray(pc?.models) && pc.models.length > 0);
    const directModels = Array.isArray(toolEntry.models) ? toolEntry.models : [];
    if (providerCatalogModels) {
      const candidateQuery = queryRuntimeCandidates(catalog, {
        tool: targetTool,
        ...(trimString(proposedRuntime.provider) ? { provider: trimString(proposedRuntime.provider) } : {}),
        ...(targetModel ? { model: targetModel } : {}),
      });
      if (candidateQuery.total === 0 || candidateQuery.items.every((item) => item.eligible === false)) {
        throw swarmError(
          SWARM_MODEL_CANDIDATE_INVALID,
          `Target runtime ${targetTool}:${targetModel || proposedRuntime.provider || '(default)'} failed catalog validation`,
          422,
        );
      }
    } else if (targetModel && directModels.length > 0) {
      const matched = directModels.some((m) => m?.id === targetModel || m?.model === targetModel);
      if (!matched) {
        throw swarmError(
          SWARM_MODEL_CANDIDATE_INVALID,
          `Model "${targetModel}" is not present in ${targetTool} runtime catalog`,
          422,
        );
      }
    }
    const effort = trimString(proposedRuntime.effort).toLowerCase();
    if (effort) {
      const modelMeta = Array.isArray(toolEntry.models)
        ? toolEntry.models.find((m) => m.id === targetModel)
        : null;
      const validEfforts = modelMeta?.effortLevels?.length ? modelMeta.effortLevels : toolEntry.effortLevels;
      if (Array.isArray(validEfforts) && validEfforts.length > 0 && !validEfforts.includes(effort)) {
        throw swarmError(
          SWARM_MODEL_CANDIDATE_INVALID,
          `Effort "${effort}" is unsupported for ${targetTool}${targetModel ? `/${targetModel}` : ''}`,
          422,
        );
      }
    }
  } else if (targetModel && deps.skipCatalogCheck !== true) {
    const modelsRes = await getModelsForTool(targetTool).catch(() => null);
    const knownModels = Array.isArray(modelsRes?.models) ? modelsRes.models : [];
    if (knownModels.length > 0 && !knownModels.some((entry) => entry?.id === targetModel || entry?.model === targetModel)) {
      throw swarmError(
        SWARM_MODEL_CANDIDATE_INVALID,
        `Model "${targetModel}" is not available in ${targetTool} model catalog`,
        422,
      );
    }
  }

  // Budget policy gate via organization_budget_counters
  if (typeof deps.checkModelBudget === 'function') {
    await deps.checkModelBudget({ organizationId: orgRow.id, orgBudget, previousRuntime, proposedRuntime });
  }
  const hasCounterTable = Boolean(
    conn?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'organization_budget_counters'").get(),
  );
  const counterRow = hasCounterTable
    ? conn.prepare('SELECT totals_json, reserved_json FROM organization_budget_counters WHERE organization_id = ? AND revision = ?')
      .get(orgRow.id, Number(orgRow.current_revision || 0))
    : null;
  const totals = counterRow ? parseJson(counterRow.totals_json, {}) : {};
  const reserved = counterRow ? parseJson(counterRow.reserved_json, {}) : {};
  const checkLimit = (limitVal, usedVal, dimension) => {
    if (limitVal === undefined || limitVal === null) return;
    const limitNum = Number(limitVal);
    if (!Number.isFinite(limitNum) || limitNum < 0) return;
    if (Number(usedVal || 0) >= limitNum) {
      throw swarmError('ORG_BUDGET_EXCEEDED', `${dimension} budget exhausted (${usedVal}/${limitNum})`, 409, { dimension });
    }
  };
  checkLimit(orgBudget?.maxCost ?? orgBudget?.cost, Number(totals.cost || 0) + Number(reserved.cost || 0), 'cost');
  checkLimit(orgBudget?.maxTokens ?? orgBudget?.tokens, Number(totals.tokens || 0) + Number(reserved.tokens || 0), 'tokens');
  checkLimit(
    orgBudget?.maxSessionReplacements ?? orgBudget?.sessionReplacements,
    Number(totals.sessionReplacements || 0) + Number(reserved.sessionReplacements || 0),
    'sessionReplacements',
  );
}

async function rebindSwarmSessionRuntime(deps, { sessionId, resolvedConfig }) {
  const normalizedSessionId = trimString(sessionId);
  if (!normalizedSessionId) return { rebound: false, reason: 'missing_session_id' };
  const patch = {
    tool: resolvedConfig.tool || 'codex',
    providerProfile: resolvedConfig.provider || '',
    model: resolvedConfig.model || '',
    effort: resolvedConfig.effort || '',
  };
  if (typeof deps.updateSessionRuntime === 'function') {
    const out = await deps.updateSessionRuntime(normalizedSessionId, patch);
    return { rebound: true, session: out };
  }
  const sm = await import('./session-manager.mjs');
  const existing = typeof sm.getSessionMeta === 'function'
    ? await sm.getSessionMeta(normalizedSessionId).catch(() => null)
    : (typeof sm.getSession === 'function' ? await sm.getSession(normalizedSessionId).catch(() => null) : null);
  if (!existing) {
    return { rebound: false, reason: 'synthetic_or_unregistered_session' };
  }
  const updated = await sm.updateSessionRuntimePreferences(normalizedSessionId, patch);
  return { rebound: Boolean(updated), session: updated };
}

export async function switchSwarmMemberModel(firstArg, secondArg) {
  const { db, deps, options } = splitDbOrDeps(firstArg, secondArg);
  const {
    organizationId,
    actorNodeId = '',
    targetNameOrNodeId = '',
    targetNodeId = '',
    harness = '',
    tool = '',
    provider = '',
    providerProfile = '',
    model = '',
    effort = '',
    reason = '',
    handoffNotes = '',
    expectedBindingGeneration = null,
    workItemId = '',
    projectRoot = '',
    postToBoard = false,
    wakeNow = false,
    idempotencyKey = '',
  } = options;

  const normalizedOrgId = trimString(organizationId);
  const targetQuery = trimString(targetNameOrNodeId || targetNodeId);
  if (!normalizedOrgId || !targetQuery) {
    throw swarmError('BAD_REQUEST', 'organizationId and targetNameOrNodeId are required', 400);
  }
  const reqHarness = trimString(harness || tool).toLowerCase();
  const reqProvider = trimString(provider || providerProfile);
  const reqModel = trimString(model);
  const reqEffort = trimString(effort).toLowerCase();
  if (!reqHarness && !reqProvider && !reqModel && !reqEffort) {
    throw swarmError('BAD_REQUEST', 'At least one target runtime field (harness, provider, model, or effort) is required', 400);
  }
  const normalizedKey = trimString(idempotencyKey);

  // Step 1: Read current org, actor, and target node state.
  const preflight = await runWithOrgDb(db, (conn) => {
    const orgRow = conn.prepare('SELECT * FROM organizations WHERE id = ?').get(normalizedOrgId);
    if (!orgRow) throw swarmError('ORGANIZATION_NOT_FOUND', `organization ${normalizedOrgId} not found`, 404);
    if (['archived', 'lifecycle_pending'].includes(orgRow.state)) {
      throw swarmError('ORG_ARCHIVED', `Organization ${normalizedOrgId} is ${orgRow.state}`, 409);
    }
    if (trimString(actorNodeId)) {
      const actorRow = conn.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?')
        .get(trimString(actorNodeId), normalizedOrgId);
      if (!actorRow) throw swarmError(SWARM_MODEL_FORBIDDEN, 'Actor node does not belong to this organization', 403);
      const actorGrant = parseJson(actorRow.grant_json, {});
      if (!isCoordinatorNodeRow(actorRow) && actorGrant?.canDelegate !== true) {
        throw swarmError(SWARM_MODEL_FORBIDDEN, 'Only Coordinator, delegator, or Owner may switch member model', 403);
      }
    }
    const targetRow = findSwarmNodeRow(conn, normalizedOrgId, targetQuery);
    if (!targetRow) {
      throw swarmError('ORGANIZATION_NODE_NOT_FOUND', `Swarm member "${targetQuery}" not found`, 404);
    }
    if (targetRow.lifecycle_state !== 'active' || targetRow.retired_revision !== null || resolveMemberSwarmState(targetRow) === 'killed') {
      throw swarmError(SWARM_MEMBER_KILLED, `Swarm member "${targetRow.stable_key}" is permanently killed`, 409);
    }
    const targetMember = serializeSwarmMember(targetRow);
    const targetGrant = parseJson(targetRow.grant_json, {});
    const orgPolicy = parseJson(orgRow.policy_json, {});
    const orgBudget = parseJson(orgRow.budget_json, {});

    const harnessChanged = Boolean(reqHarness && reqHarness !== targetMember.harness);
    const providerChanged = Boolean(reqProvider && reqProvider !== targetMember.provider);
    const requestedConfig = normalizeRuntimeTuple({
      tool: reqHarness || targetMember.harness || 'codex',
      provider: reqProvider || (harnessChanged ? '' : targetMember.provider),
      model: reqModel || ((harnessChanged || providerChanged) ? '' : targetMember.model),
      effort: reqEffort || (harnessChanged ? '' : targetMember.effort),
    });

    const receipts = targetGrant?.modelSwitchReceipts && typeof targetGrant.modelSwitchReceipts === 'object'
      ? targetGrant.modelSwitchReceipts
      : {};
    if (normalizedKey && receipts[normalizedKey]) {
      const prevReceipt = receipts[normalizedKey];
      if (JSON.stringify(prevReceipt.requestedConfig) !== JSON.stringify(requestedConfig)) {
        throw swarmError(SWARM_BINDING_CONFLICT, 'Idempotency key reused with a different target model configuration', 409);
      }
      return {
        replay: true,
        result: {
          organizationId: normalizedOrgId,
          member: targetMember,
          handoff: prevReceipt.handoff || null,
          previousBindingGeneration: prevReceipt.previousBindingGeneration,
          bindingGeneration: prevReceipt.bindingGeneration,
          replay: true,
        },
      };
    }

    if (expectedBindingGeneration !== null && expectedBindingGeneration !== undefined) {
      const expectedGen = Number(expectedBindingGeneration);
      if (Number.isInteger(expectedGen) && expectedGen !== targetMember.bindingGeneration) {
        throw swarmError(
          SWARM_BINDING_CONFLICT,
          `Binding generation mismatch (expected ${expectedGen}, current ${targetMember.bindingGeneration})`,
          409,
        );
      }
    }
    return {
      replay: false,
      orgRow,
      orgPolicy,
      orgBudget,
      targetRow,
      targetGrant,
      targetMember,
      requestedConfig,
    };
  });

  if (preflight.replay) {
    return preflight.result;
  }

  const { orgRow, orgPolicy, orgBudget, targetRow, targetGrant, targetMember, requestedConfig } = preflight;

  // Step 2: Fail closed on owner runtime locks BEFORE busy checks! NEVER silently replace a locked field.
  const readConstraintsFn = typeof deps.readSessionRuntimeConstraints === 'function'
    ? deps.readSessionRuntimeConstraints
    : (id) => readSessionRuntimeConstraints(id).catch(() => null);
  const rootSessionMeta = !deps.session?.runtimeConstraints && orgRow.root_session_id && typeof deps.getSession === 'function'
    ? await deps.getSession(orgRow.root_session_id).catch(() => null)
    : null;
  const loadedRootConstraints = deps.session?.runtimeConstraints
    ? { constraints: deps.session.runtimeConstraints }
    : (rootSessionMeta?.runtimeConstraints
      ? { constraints: rootSessionMeta.runtimeConstraints }
      : (orgRow.root_session_id ? await readConstraintsFn(orgRow.root_session_id) : null));
  const memberScopes = [
    ...(isCoordinatorNodeRow(targetRow) ? ['root'] : []),
    'organization',
    'collaboration',
    `node:${targetMember.stableKey}`,
    `node:${targetMember.id}`,
  ];
  assertOwnerRuntimeLocksAllowSwitch({
    constraintsSources: [
      loadedRootConstraints?.constraints || loadedRootConstraints,
      orgPolicy?.runtimeConstraints,
      orgPolicy?.ownerRuntimeLocks,
      targetGrant?.ownerRuntimeLocks,
    ],
    scopes: memberScopes,
    candidateRuntime: requestedConfig,
  });

  // Step 3: Refuse while member is working or has an active Run.
  if (targetMember.swarmState === 'working') {
    throw swarmError(
      SWARM_MEMBER_BUSY,
      `Cannot switch model while "${targetMember.stableKey}" is working; wait for current turn to settle`,
      409,
    );
  }
  const runInfo = await resolveMemberRunInfo(deps, targetMember);
  if (runInfo?.running === true || runInfo?.hasSessionActiveRun === true) {
    throw swarmError(
      SWARM_MEMBER_BUSY,
      `Cannot switch model while "${targetMember.stableKey}" has an active Run`,
      409,
    );
  }

  // Step 4: Validate candidate catalog, org policy, and governor budget.
  await runWithOrgDb(db, async (conn) => {
    await validateModelSwitchCandidateAndBudget(conn, deps, {
      orgRow,
      orgPolicy,
      orgBudget,
      targetGrant,
      previousRuntime: normalizeRuntimeTuple({
        tool: targetMember.harness,
        provider: targetMember.provider,
        model: targetMember.model,
        effort: targetMember.effort,
      }),
      proposedRuntime: requestedConfig,
    });
  });

  const resolvedConfig = { ...requestedConfig };

  // Step 5: Inspect dirty workspace state + unread board #seq range + outgoing run telemetry cleanly.
  const effectiveProjectRoot = trimString(projectRoot)
    || trimString(targetGrant?.swarmWorkspace?.projectRoot)
    || trimString(orgPolicy?.projectRoot)
    || trimString(orgPolicy?.workspaceScope);
  const workspaceState = await inspectWorkspaceUnmergedChanges(deps, targetRow, effectiveProjectRoot)
    .catch(() => ({ unmerged: false, dirtyFiles: [], unmergedCommits: 0 }));

  const outgoingRunId = trimString(targetMember.lastRunId || runInfo?.runId || runInfo?.id);
  let outgoingRun = runInfo && (runInfo.usage || runInfo.model || runInfo.actualReportedConfig) ? runInfo : null;
  if (!outgoingRun && outgoingRunId && typeof deps.getRun === 'function') {
    outgoingRun = await deps.getRun(outgoingRunId).catch(() => null);
  } else if (!outgoingRun && outgoingRunId && deps.skipRunLookup !== true) {
    try {
      const runsMod = await import('./runs.mjs');
      outgoingRun = await runsMod.getRun(outgoingRunId).catch(() => null);
    } catch {}
  }
  const outgoingSession = typeof deps.getSession === 'function' && targetMember.currentSessionId
    ? await deps.getSession(targetMember.currentSessionId).catch(() => null)
    : null;

  const effectiveWorkItemId = trimString(workItemId || targetGrant?.parentWorkItemId || targetGrant?.workItemId);
  let factoryTaskHandoffId = '';
  if (effectiveWorkItemId) {
    let liveWorkItemVersion = Number.isInteger(options.workItemExpectedVersion) ? options.workItemExpectedVersion : null;
    if (liveWorkItemVersion === null) {
      liveWorkItemVersion = await runWithOrgDb(db, (conn) => {
        const hasWi = Boolean(conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'factory_work_items'").get());
        if (!hasWi) return null;
        const row = conn.prepare('SELECT row_version FROM factory_work_items WHERE id = ? AND organization_id = ?')
          .get(effectiveWorkItemId, normalizedOrgId);
        return row ? Number(row.row_version) : null;
      }).catch(() => null);
    }
    if (liveWorkItemVersion !== null) {
      try {
        const factoryHandoff = await createFactoryTaskHandoff({
          organizationId: normalizedOrgId,
          workItemId: effectiveWorkItemId,
          commandId: `swarm_model_${targetMember.id}_${targetMember.bindingGeneration}_${randomUUID()}`,
          expectedVersion: liveWorkItemVersion,
        }, { kind: 'user', role: 'owner', principalId: trimString(actorNodeId) || 'owner' });
        factoryTaskHandoffId = trimString(factoryHandoff?.id);
      } catch {
        // Standalone tests without full Work Graph state degrade cleanly to Swarm handoff facts.
      }
    }
  }

  // Step 6: Atomically execute CAS in SQLite FIRST (never mutating live session prefs if CAS loses a race!).
  const committed = await runWithOrgDb(db, (conn) => {
    const ts = nowIso();
    const freshRow = conn.prepare('SELECT * FROM organization_nodes WHERE id = ? AND organization_id = ?')
      .get(targetRow.id, normalizedOrgId);
    if (!freshRow || freshRow.lifecycle_state !== 'active' || freshRow.retired_revision !== null || resolveMemberSwarmState(freshRow) === 'killed') {
      throw swarmError(SWARM_MEMBER_KILLED, `Swarm member "${targetMember.stableKey}" was killed concurrently`, 409);
    }
    if (Number(freshRow.binding_generation || 0) !== targetMember.bindingGeneration) {
      throw swarmError(SWARM_BINDING_CONFLICT, 'Member bindingGeneration changed concurrently during model switch', 409);
    }
    if (resolveMemberSwarmState(freshRow) === 'working') {
      throw swarmError(SWARM_MEMBER_BUSY, 'Member became working during model switch', 409);
    }

    const headRow = conn.prepare('SELECT COALESCE(MAX(seq), 0) AS head_seq FROM organization_board_messages WHERE organization_id = ?').get(normalizedOrgId);
    const headSeq = Number(headRow?.head_seq || 0);
    const deliveredRow = conn.prepare(
      "SELECT COALESCE(MAX(latest_seq), 0) AS last_seq FROM organization_board_wakeups WHERE organization_id = ? AND target_node_id = ? AND state = 'delivered'",
    ).get(normalizedOrgId, freshRow.id);
    const lastDeliveredSeq = Number(deliveredRow?.last_seq || 0);
    const recentRows = conn.prepare(
      'SELECT seq, channel_name, sender_name, kind, body_markdown, created_at FROM organization_board_messages WHERE organization_id = ? AND seq > ? ORDER BY seq ASC LIMIT 12',
    ).all(normalizedOrgId, lastDeliveredSeq);
    const briefRow = conn.prepare(
      "SELECT seq, body_markdown, created_at FROM organization_board_messages WHERE organization_id = ? AND kind = 'brief' AND LOWER(body_markdown) LIKE ? ORDER BY seq ASC LIMIT 1",
    ).get(normalizedOrgId, `%@${targetMember.stableKey.toLowerCase()}%`);

    let workItemSummary = null;
    if (effectiveWorkItemId) {
      try {
        workItemSummary = remoteFactoryTaskSummary(conn, {
          organizationId: normalizedOrgId,
          workItemId: effectiveWorkItemId,
          contractDigest: '',
          payload: { contract: { organizationRevision: orgRow.current_revision || 0 } },
        }, 4096);
      } catch {}
    }

    const previousBindingGeneration = Number(freshRow.binding_generation || 1);
    const nextBindingGeneration = previousBindingGeneration + 1;
    const handoffId = `smh_${randomBytes(10).toString('hex')}`;
    const previousRuntime = normalizeRuntimeTuple({
      tool: targetMember.harness,
      provider: targetMember.provider,
      model: targetMember.model,
      effort: targetMember.effort,
    });
    const handoffBundle = {
      schemaVersion: 1,
      kind: 'swarm_model_switch_handoff',
      handoffId,
      organizationId: normalizedOrgId,
      nodeId: freshRow.id,
      stableKey: freshRow.stable_key,
      role: targetMember.role,
      previousBindingGeneration,
      nextBindingGeneration,
      previousRuntime,
      requestedConfig,
      resolvedConfig,
      reason: trimString(reason).slice(0, 300),
      handoffNotes: redactSecrets(trimString(handoffNotes)).slice(0, 600),
      briefSummary: redactSecrets(trimString(briefRow?.body_markdown)).slice(0, 500),
      workspace: {
        mode: freshRow.workspace_mode || 'inherit',
        path: freshRow.workspace_path || '',
        branch: freshRow.workspace_branch || '',
        baseRef: trimString(targetGrant?.swarmWorkspace?.baseRef),
        unmerged: workspaceState?.unmerged === true,
        dirtyFiles: Array.isArray(workspaceState?.dirtyFiles) ? workspaceState.dirtyFiles.slice(0, 50) : [],
        unmergedCommits: Number(workspaceState?.unmergedCommits || 0),
      },
      boardRange: {
        unreadFromSeq: lastDeliveredSeq + 1,
        lastDeliveredSeq,
        headSeq,
        recentMessages: recentRows.map((m) => ({
          seq: m.seq,
          channel: m.channel_name,
          sender: m.sender_name,
          kind: m.kind,
          text: redactSecrets(m.body_markdown).slice(0, 300),
          createdAt: m.created_at,
        })),
      },
      ...(effectiveWorkItemId ? { workItemId: effectiveWorkItemId } : {}),
      ...(factoryTaskHandoffId ? { factoryTaskHandoffId } : {}),
      ...(workItemSummary ? { workItemSummary } : {}),
      createdAt: ts,
    };

    const nextGrant = parseJson(freshRow.grant_json, {});
    recordEpochRunTelemetry(nextGrant, {
      bindingGeneration: previousBindingGeneration,
      runId: outgoingRunId,
      run: outgoingRun,
      session: outgoingSession,
      usage: options.previousRunUsage || null,
      actualReportedConfig: options.previousActualConfig || null,
      endedAt: ts,
    });
    const nextEpochIndex = nextGrant.modelHistory.length + 1;
    nextGrant.modelHistory.push(
      createModelEpoch({
        epochIndex: nextEpochIndex,
        bindingGeneration: nextBindingGeneration,
        startedAt: ts,
        reason: trimString(reason) || 'swarm_model_switch',
        requestedConfig,
        resolvedConfig,
      }),
    );
    nextGrant.runtimePolicy = {
      tool: resolvedConfig.tool,
      ...(resolvedConfig.provider ? { providerProfile: resolvedConfig.provider } : {}),
      ...(resolvedConfig.model ? { model: resolvedConfig.model } : {}),
      ...(resolvedConfig.effort ? { effort: resolvedConfig.effort } : {}),
      ...(Array.isArray(nextGrant.runtimePolicy?.allowedModels) ? { allowedModels: nextGrant.runtimePolicy.allowedModels } : {}),
    };
    nextGrant.pendingModelSwitchHandoff = handoffBundle;
    nextGrant.lastStateReason = 'model_switched';
    nextGrant.modelSwitchCount = Number(nextGrant.modelSwitchCount || 0) + 1;
    if (normalizedKey) {
      nextGrant.modelSwitchReceipts = {
        ...(nextGrant.modelSwitchReceipts && typeof nextGrant.modelSwitchReceipts === 'object' ? nextGrant.modelSwitchReceipts : {}),
        [normalizedKey]: {
          requestedConfig,
          resolvedConfig,
          previousBindingGeneration,
          bindingGeneration: nextBindingGeneration,
          handoff: handoffBundle,
          switchedAt: ts,
        },
      };
    }

    conn.exec('BEGIN IMMEDIATE');
    try {
      const updateInfo = conn.prepare(`
        UPDATE organization_nodes
        SET binding_generation = ?,
            grant_json = ?,
            version = version + 1
        WHERE id = ? AND organization_id = ? AND version = ? AND binding_generation = ?
      `).run(
        nextBindingGeneration,
        encodeJson(nextGrant, {}),
        freshRow.id,
        normalizedOrgId,
        freshRow.version,
        freshRow.binding_generation,
      );
      if (updateInfo.changes === 0) {
        throw swarmError(SWARM_BINDING_CONFLICT, 'Concurrent modification detected during model switch', 409);
      }
      conn.exec('COMMIT');
    } catch (error) {
      try { conn.exec('ROLLBACK'); } catch {}
      throw error;
    }

    const updatedMember = serializeSwarmMember(conn.prepare('SELECT * FROM organization_nodes WHERE id = ?').get(freshRow.id));
    return {
      nodeId: freshRow.id,
      updatedMember,
      handoff: handoffBundle,
      handoffId,
      previousBindingGeneration,
      bindingGeneration: nextBindingGeneration,
      rollbackSnapshot: {
        previousBindingGeneration: freshRow.binding_generation,
        previousGrantJson: freshRow.grant_json,
      },
    };
  }, { mutate: true, organizationId: normalizedOrgId });

  // Step 7: Rebind live session runtime strictly AFTER DB CAS succeeds, with compensating DB rollback on error!
  let rebindResult;
  try {
    rebindResult = await rebindSwarmSessionRuntime(deps, {
      sessionId: targetMember.currentSessionId,
      resolvedConfig,
    });
  } catch (rebindError) {
    await runWithOrgDb(db, (conn) => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        conn.prepare(`
          UPDATE organization_nodes
          SET binding_generation = ?,
              grant_json = ?,
              version = version + 1
          WHERE id = ? AND organization_id = ? AND binding_generation = ?
        `).run(
          committed.rollbackSnapshot.previousBindingGeneration,
          committed.rollbackSnapshot.previousGrantJson,
          committed.nodeId,
          normalizedOrgId,
          committed.bindingGeneration,
        );
        conn.exec('COMMIT');
      } catch (rollbackErr) {
        try { conn.exec('ROLLBACK'); } catch {}
        throw rollbackErr;
      }
    }, { mutate: true, organizationId: normalizedOrgId }).catch(() => {});
    throw rebindError;
  }

  let boardPost = null;
  if (postToBoard || wakeNow) {
    const mentionPrefix = wakeNow ? `@${committed.updatedMember.stableKey} ` : '';
    const runtimeLabel = `${resolvedConfig.tool}:${resolvedConfig.model || resolvedConfig.provider || 'default'}${resolvedConfig.effort ? ` (${resolvedConfig.effort})` : ''}`;
    boardPost = await runWithOrgDb(db, (conn) => postBoardMessage(conn, {
      organizationId: normalizedOrgId,
      channel: 'main',
      senderKind: trimString(actorNodeId) ? 'node' : 'owner',
      senderNodeId: trimString(actorNodeId),
      bodyMarkdown: `${mentionPrefix}[handoff] Switched ${committed.updatedMember.stableKey} runtime to ${runtimeLabel} (gen ${committed.bindingGeneration}, handoff ${committed.handoffId}).`,
      kind: 'handoff',
      isDoneSignal: false,
    }), { mutate: true, organizationId: normalizedOrgId });
  }

  if (wakeNow && (typeof deps.deliverSessionMessage === 'function' || typeof deps.sendMessage === 'function')) {
    await deliverPendingSwarmWakeups({ ...deps, ...(db ? { db } : {}) }, { organizationId: normalizedOrgId }).catch(() => {});
  }

  return {
    organizationId: normalizedOrgId,
    member: committed.updatedMember,
    handoff: committed.handoff,
    previousBindingGeneration: committed.previousBindingGeneration,
    bindingGeneration: committed.bindingGeneration,
    sessionRebound: rebindResult.rebound,
    boardPost,
    replay: false,
  };
}
