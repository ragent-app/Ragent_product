import { buildProviderContractFields, hasProviderCapability } from './provider-contract.mjs';
import { registerCache, registerLruOrMap } from './memory-registry.mjs';
import { getAdaptiveConcurrencyBudget } from './adaptive-concurrency-registry.mjs';
import { createProviderNativeDelegationMapper } from './provider-native-delegation-mapper.mjs';
import { isProviderNativeChildFrame } from './provider-native-delegation-runtime.mjs';
import { computeExecutionScopeDigest } from './execution-scope.mjs';
import { classifyRisk } from './risk-classifier.mjs';
import { BoundedLruMap } from './cache-utils.mjs';
import { cacheBudget } from '../lib/cache-budget.mjs';
import { getRunSpoolCursor } from './runs.mjs';

const APPROVAL_METHOD_KINDS = Object.freeze({
  execCommandApproval: 'command',
  applyPatchApproval: 'file_change',
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'file_change',
  'item/permissions/requestApproval': 'permissions',
  'mcpServer/elicitation/request': 'permissions',
});

const projectionBudget = getAdaptiveConcurrencyBudget('projectionCPU');
// Normalized events are persisted to session history by the caller.  A large
// harness spool can yield thousands of small frames, so crossing that callback
// for each raw line repeatedly acquires history locks and sends redundant WS
// invalidations.  Keep critical approval/terminal state prompt, but batch the
// ordinary stream in a small, bounded unit.
const NORMALIZED_EVENT_EMIT_BATCH_SIZE = 32;
const CRITICAL_NORMALIZED_EVENT_TYPES = new Set([
  'approval_request',
  'approval_response',
  'privileged_batch_request',
  'privileged_batch_response',
  'approved_action_batch_request',
  'approved_action_batch_response',
  'approved_action_state',
  'status',
]);

const APPROVAL_METRIC_FIELDS = Object.freeze([
  'received',
  'autoAllowed',
  'autoDenied',
  'presentedToOwner',
  'ownerApproved',
  'ownerDenied',
  'echoes',
  'requestsSeen',
  'projected',
  'suppressed',
]);
const MAX_APPROVAL_METRIC_RUNS = 128;
const MAX_APPROVAL_METRIC_DIMENSIONS = 64;
const MAX_APPROVAL_METRIC_KEY_LENGTH = 96;

function createApprovalMetricBucket() {
  return Object.fromEntries(APPROVAL_METRIC_FIELDS.map((field) => [field, 0]));
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatCommandValue(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(trimString).filter(Boolean).join(' ');
  return '';
}

function providerForApprovalPayload(payload, fallback = '') {
  const explicit = trimString(payload?.provider).toLowerCase();
  if (explicit === 'claude' || explicit === 'codex') return explicit;
  if (trimString(fallback)) return trimString(fallback).toLowerCase();
  if (payload?.type === 'control_request') return 'claude';
  const method = trimString(payload?.method);
  if (method && Object.prototype.hasOwnProperty.call(APPROVAL_METHOD_KINDS, method)) return 'codex';
  const approvalId = trimString(payload?.approvalId);
  if (approvalId.startsWith('claude:')) return 'claude';
  if (approvalId.includes('Approval:') || approvalId.startsWith('item/')) return 'codex';
  return 'unknown';
}

function readApprovalRequestInfo(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type === 'control_request' && payload.request?.subtype === 'can_use_tool') {
    const requestId = trimString(payload.request_id);
    if (!requestId) return null;
    const request = payload.request;
    const toolName = trimString(request.tool_name);
    return {
      approvalId: `claude:${requestId}`,
      provider: 'claude',
      kind: ['Bash', 'PowerShell'].includes(toolName) ? 'command' : toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'permissions',
      toolName,
      toolInput: request.input && typeof request.input === 'object' ? request.input : {},
      command: ['Bash', 'PowerShell'].includes(toolName) ? formatCommandValue(request.input?.command) : '',
    };
  }
  const method = trimString(payload.method);
  const kind = APPROVAL_METHOD_KINDS[method] || '';
  if (!kind || (typeof payload.id !== 'string' && typeof payload.id !== 'number')) return null;
  const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
  return {
    approvalId: `${method}:${String(payload.id)}`,
    provider: 'codex',
    kind,
    toolName: '',
    toolInput: {},
    command: formatCommandValue(params.command),
  };
}

function readRunRiskContext(run) {
  const scope = run?.executionScope;
  const context = scope?.riskContext;
  const expectedDigest = trimString(run?.executionScopeDigest);
  if (!scope || typeof scope !== 'object' || !context || typeof context !== 'object' || !expectedDigest) return null;
  try {
    if (computeExecutionScopeDigest(scope) !== expectedDigest) return null;
  } catch {
    return null;
  }
  return context.schemaVersion === 1 ? context : null;
}

function readRiskAuditInfo(value) {
  const risk = value?.risk && typeof value.risk === 'object' ? value.risk : value;
  const tier = trimString(value?.riskTier) || trimString(risk?.tier);
  const policyVersion = trimString(value?.riskPolicyVersion) || trimString(risk?.policyVersion);
  let reasonCodes = [];
  if (Array.isArray(value?.riskReasonCodes)) {
    reasonCodes = value.riskReasonCodes;
  } else if (Array.isArray(value?.reasonCodes)) {
    reasonCodes = value.reasonCodes;
  } else if (Array.isArray(risk?.reasons)) {
    reasonCodes = risk.reasons.map((reason) => reason?.code || reason);
  }
  return {
    ...(tier ? { tier } : {}),
    ...(policyVersion ? { policyVersion } : {}),
    reasonCodes: [...new Set(reasonCodes.map(trimString).filter(Boolean))].slice(0, 8),
  };
}

function classifyApprovalRisk(info, run) {
  if (!info) return null;
  const scope = run?.executionScope || {};
  return classifyRisk({
    command: info.command,
    toolName: info.toolName,
    toolInput: info.toolInput,
    cwd: trimString(scope.cwd?.realPath) || trimString(run?.cwd),
    projectRoot: trimString(scope.scopeRoot?.realPath) || trimString(scope.workspaceRoot?.realPath) || trimString(run?.projectRoot),
    riskContext: readRunRiskContext(run),
  });
}

function buildManifestAwareRun(run, manifest) {
  const interactionMode = trimString(manifest?.options?.interactionMode).toLowerCase();
  const planAction = trimString(manifest?.options?.planAction).toLowerCase();
  return {
    ...run,
    ...(interactionMode ? { interactionMode } : {}),
    ...(planAction ? { planAction } : {}),
    ...(manifest?.executionScope ? { executionScope: manifest.executionScope } : {}),
    ...(trimString(manifest?.executionScopeDigest)
      ? { executionScopeDigest: trimString(manifest.executionScopeDigest) }
      : {}),
  };
}

export function createRunProjectionService({
  buildCodexContextMetricsPayload,
  clipPreview,
  createToolInvocation,
  materializeRunSpoolLine,
  normalizeRunEvents,
  readLatestCodexSessionMetrics,
  readRunSpoolDelta,
  readRunSpoolRecords,
  streamRunSpoolRecords,
  scanRunSpoolRecords,
} = {}) {
  function parseRecordTimestamp(record) {
    const parsed = Date.parse(record?.ts || '');
    return Number.isFinite(parsed) ? parsed : null;
  }

  function decorateSpoolRecordEvents(record, events = [], stableTimestamp = null) {
    const recordId = trimString(record?.recordId);
    return (Array.isArray(events) ? events : []).map((event, index) => {
      const hasHarnessIdentity = Boolean(trimString(event?.harnessEventId || event?.eventId));
      const hasProviderFrameIdentity = Boolean(trimString(event?.providerEventId));
      return {
        ...event,
        ...(Number.isInteger(stableTimestamp) ? { timestamp: stableTimestamp } : {}),
        // This identity is deliberately marked as spool-derived. Provider IDs
        // still win for semantically repeated snapshots that arrive in distinct
        // records; this id is the exact-replay fallback when upstream supplied
        // no stable identity at all.
        ...(recordId && !hasHarnessIdentity
          ? {
              harnessEventId: `spool:${recordId}:${index}`,
              harnessEventSource: 'spool-record',
            }
          : {}),
        // A Claude frame UUID can produce more than one normalized event. Keep
        // the within-frame ordinal so uuid-based dedup remains precise.
        ...(hasProviderFrameIdentity && !Number.isInteger(event?.providerEventIndex)
          ? { providerEventIndex: index }
          : {}),
      };
    });
  }

  async function createRunRuntimeInvocation(manifest) {
    return createToolInvocation(manifest.tool, '', {
      model: manifest.options?.model,
      effort: manifest.options?.effort,
      thinking: manifest.options?.thinking,
      runtimeFamily: manifest.runtimeFamily || manifest.options?.runtimeFamily,
      permissionMode: manifest.permissionMode || manifest.options?.permissionMode,
      riskMode: manifest.options?.riskMode || manifest.riskMode,
    });
  }

  function buildProjectionRun(run, runtimeInvocation) {
    const providerContract = buildProviderContractFields(
      run?.runtimeFamily || runtimeInvocation?.runtimeFamily,
      {
        provider: run?.provider || runtimeInvocation?.provider,
        runtimeFamily: run?.runtimeFamily || runtimeInvocation?.runtimeFamily,
        providerCapabilities: run?.providerCapabilities || runtimeInvocation?.capabilities,
      },
    );
    const permissionMode = trimString(run?.permissionMode) || trimString(runtimeInvocation?.permissionMode);
    return {
      ...run,
      ...(providerContract.provider ? { provider: providerContract.provider } : {}),
      ...(providerContract.runtimeFamily ? { runtimeFamily: providerContract.runtimeFamily } : {}),
      ...(providerContract.providerCapabilities ? { providerCapabilities: providerContract.providerCapabilities } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    };
  }

  function buildRunProjectionPreview(spoolRecords = []) {
    return (spoolRecords || [])
      .filter((record) => ['stdout', 'stderr', 'error'].includes(record.stream))
      .map((record) => {
        if (record?.json && typeof record.json === 'object') {
          try {
            return clipPreview(JSON.stringify(record.json));
          } catch {}
        }
        return typeof record?.line === 'string' ? clipPreview(record.line) : '';
      })
      .filter(Boolean)
      .slice(-3)
      .join(' | ');
  }

  function seedApprovalSuppression(adapter, ids = []) {
    const normalized = [...new Set((Array.isArray(ids) ? ids : [])
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim()))];
    if (normalized.length === 0) return 0;
    if (typeof adapter?.seedAutoApprovedIds === 'function') {
      adapter.seedAutoApprovedIds(normalized);
      return normalized.length;
    }
    // Compatibility adapters from older tests/builds do not expose the
    // seeding hook yet. Their parser still understands the synthetic echo.
    for (const approvalId of normalized) {
      try {
        adapter?.parseLine?.(JSON.stringify({
          type: 'agentoc.approval_response',
          autoApproved: true,
          approvalId,
        }));
      } catch {}
    }
    return normalized.length;
  }

  async function maybeAppendProjectedCodexUsage(run, runtimeInvocation, normalizedEvents = [], lastRecordTimestamp = null) {
    if (!hasProviderCapability(runtimeInvocation, 'supportsExternalUsageProjection') || !run?.codexThreadId) {
      return [];
    }
    if (normalizedEvents.some((event) => event?.type === 'usage')) {
      return [];
    }

    const metrics = await readLatestCodexSessionMetrics(run.codexThreadId, {
      startedAt: run.startedAt || run.createdAt || null,
      completedAt: run.completedAt || run.spoolCompletionDetectedAt || run.finalizedAt || null,
    });
    const payload = buildCodexContextMetricsPayload(metrics);
    if (!payload) {
      return normalizedEvents;
    }

    const metricsTimestamp = Date.parse(metrics?.timestamp || '');
    const stableTimestamp = Number.isFinite(metricsTimestamp) ? metricsTimestamp : lastRecordTimestamp;
    const parsedEvents = runtimeInvocation.adapter.parseLine(JSON.stringify(payload)).map((event) => ({
      ...event,
      ...(Number.isInteger(stableTimestamp) ? { timestamp: stableTimestamp } : {}),
    }));
    return normalizeRunEvents(buildProjectionRun(run, runtimeInvocation), parsedEvents);
  }

  async function normalizeRunSpoolRecordsInternal(run, runtimeInvocation, spoolRecords = [], options = {}) {
    const projectionStartedAt = projectionNowMs();
    const { adapter } = runtimeInvocation;
    const projectionRun = buildProjectionRun(run, runtimeInvocation);
    const normalizedEvents = [];
    const retainLimit = Number.isInteger(options.retainNormalizedEvents)
      ? Math.max(0, options.retainNormalizedEvents)
      : Number.POSITIVE_INFINITY;
    const skipNormalizedEvents = Number.isInteger(options.skipNormalizedEvents)
      ? Math.max(0, options.skipNormalizedEvents)
      : 0;
    let normalizedEventCount = 0;
    let previewRecords = [];
    let usageSeen = false;
    let latestUsage = null;
    let lastRecordTimestamp = null;
    let recordsSeen = 0;
    let stdoutRecords = 0;
    let materializedRecords = 0;
    let parseFailures = 0;
    const autoApprovedIdsSeen = new Set();
    const nativeProvider = String(run?.provider || runtimeInvocation?.provider || '').toLowerCase().includes('claude')
      ? 'claude'
      : String(run?.provider || runtimeInvocation?.provider || '').toLowerCase().includes('codex')
        ? 'codex'
        : '';
    const nativeMapper = nativeProvider
      ? createProviderNativeDelegationMapper({
        provider: nativeProvider,
        runId: run.id,
        parentSessionId: run.sessionId,
      })
      : null;
    const childSessionIds = new Set(
      (Array.isArray(run?.providerNativeDelegation?.delegations)
        ? run.providerNativeDelegation.delegations
        : [])
        .map((entry) => trimString(entry.childSessionId))
        .filter(Boolean),
    );
    let pendingVisibleEvents = [];

    const flushNormalizedEvents = async () => {
      if (pendingVisibleEvents.length === 0) return;
      const visible = pendingVisibleEvents;
      pendingVisibleEvents = [];
      if (typeof options.onNormalizedEvents === 'function') {
        await options.onNormalizedEvents(visible);
      }
      if (retainLimit <= 0) return;
      normalizedEvents.push(...visible);
      if (normalizedEvents.length > retainLimit) {
        normalizedEvents.splice(0, normalizedEvents.length - retainLimit);
      }
    };

    const emitNormalizedEvents = async (events = []) => {
      const source = Array.isArray(events) ? events.filter(Boolean) : [];
      if (source.length === 0) return;
      const startIndex = normalizedEventCount;
      normalizedEventCount += source.length;
      for (const event of source) {
        if (event?.type === 'usage') {
          usageSeen = true;
          latestUsage = event;
        }
      }
      const firstRetainedIndex = Math.max(skipNormalizedEvents, startIndex);
      const offset = firstRetainedIndex - startIndex;
      const visible = offset > 0 ? source.slice(offset) : source;
      if (visible.length === 0) return;
      pendingVisibleEvents.push(...visible);
      const hasCriticalEvent = visible.some((event) => CRITICAL_NORMALIZED_EVENT_TYPES.has(event?.type));
      if (hasCriticalEvent || pendingVisibleEvents.length >= NORMALIZED_EVENT_EMIT_BATCH_SIZE) {
        await flushNormalizedEvents();
      }
    };

    for await (const record of spoolRecords || []) {
      recordsSeen += 1;
      if (record?.json && typeof record.json === 'object') {
        previewRecords.push(record);
      } else if (typeof record?.line === 'string') {
        previewRecords.push(record);
      }
      if (previewRecords.length > 3) previewRecords.splice(0, previewRecords.length - 3);
      if (record?.stream !== 'stdout') continue;
      stdoutRecords += 1;
      const line = await materializeRunSpoolLine(run.id, record);
      if (!line) continue;
      const stableTimestamp = parseRecordTimestamp(record);
      if (Number.isInteger(stableTimestamp)) {
        lastRecordTimestamp = stableTimestamp;
      }
      let payload = record?.json && typeof record.json === 'object' ? record.json : null;
      if (!payload) {
        try { payload = JSON.parse(line); } catch { parseFailures += 1; }
      }
      if (payload?.type === 'agentoc.approval_response'
        && (payload.autoApproved === true || payload.autoDenied === true)
        && typeof payload.approvalId === 'string'
        && payload.approvalId.trim()) {
        autoApprovedIdsSeen.add(payload.approvalId.trim().slice(0, 256));
        if (autoApprovedIdsSeen.size > 2048) {
          const oldest = autoApprovedIdsSeen.values().next().value;
          if (oldest !== undefined) autoApprovedIdsSeen.delete(oldest);
        }
      }
      let approvalRequestInfo = null;
      let approvalRisk = null;
      if (options.countApprovals === true && payload) {
        const runId = trimString(run?.id);
        approvalRequestInfo = readApprovalRequestInfo(payload);
        if (approvalRequestInfo) {
          approvalRisk = approvalRiskForPayload(payload, run, approvalRequestInfo);
          const provider = approvalRequestInfo.provider;
          incrementApprovalMetric('received', { runId, provider, risk: approvalRisk });
          incrementApprovalMetric('requestsSeen', { runId, provider, risk: approvalRisk });
        } else if (payload.type === 'agentoc.approval_response') {
          const provider = providerForApprovalPayload(payload);
          const risk = approvalRiskForPayload(payload, run);
          if (payload.autoApproved === true) {
            incrementApprovalMetric('echoes', { runId, provider, risk });
            incrementApprovalMetric('autoAllowed', { runId, provider, risk });
          } else if (payload.autoDenied === true) {
            incrementApprovalMetric('echoes', { runId, provider, risk });
            incrementApprovalMetric('autoDenied', { runId, provider, risk });
          } else if (['denied', 'cancelled'].includes(trimString(payload.status).toLowerCase())
            || ['denied', 'cancelled', 'reject', 'decline'].includes(trimString(payload.decision).toLowerCase())) {
            incrementApprovalMetric('ownerDenied', { runId, provider, risk });
          } else {
            incrementApprovalMetric('ownerApproved', { runId, provider, risk });
          }
        }
      }
      let adapterLine = line;
      if (nativeMapper) {
        let raw = record?.json && typeof record.json === 'object' ? record.json : null;
        if (!raw) {
          try { raw = JSON.parse(line); } catch { parseFailures += 1; }
        }
        if (raw && typeof raw === 'object') {
          const mapped = nativeMapper.map(raw);
          for (const event of mapped.events) {
            if (event.childSessionId) childSessionIds.add(event.childSessionId);
          }
          const isSpawnFrame = mapped.events.some((event) => event.kind === 'spawned');
          if (!isSpawnFrame && isProviderNativeChildFrame(raw, childSessionIds)) {
            adapterLine = JSON.stringify({ ...raw, agentoc_intermediate: true });
          }
        }
      }
      const parsedEvents = decorateSpoolRecordEvents(
        record,
        adapter.parseLine(adapterLine),
        stableTimestamp,
      );
      if (options.countApprovals === true) {
        let projectedApprovalCount = 0;
        for (const event of parsedEvents) {
          if (event?.type !== 'approval_request') continue;
          const risk = approvalRisk || classifyApprovalRisk(approvalRequestInfo, run);
          const provider = providerForApprovalPayload(payload, event.provider);
          incrementApprovalMetric('projected', { runId: trimString(run?.id), provider, risk });
          incrementApprovalMetric('presentedToOwner', { runId: trimString(run?.id), provider, risk });
          projectedApprovalCount += 1;
        }
        if (approvalRequestInfo && projectedApprovalCount === 0) {
          incrementApprovalMetric('suppressed', {
            runId: trimString(run?.id),
            provider: approvalRequestInfo.provider,
            risk: approvalRisk || classifyApprovalRisk(approvalRequestInfo, run),
          });
        }
      }
      await emitNormalizedEvents(normalizeRunEvents(projectionRun, parsedEvents));
    }

    if (options.flush !== false) {
      const flushedEvents = adapter.flush().map((event) => ({
        ...event,
        ...(Number.isInteger(lastRecordTimestamp) ? { timestamp: lastRecordTimestamp } : {}),
      }));
      await emitNormalizedEvents(normalizeRunEvents(projectionRun, flushedEvents));
    }
    if (options.includeCodexContextMetrics === true) {
      const usageEvents = await maybeAppendProjectedCodexUsage(
        run,
        runtimeInvocation,
        usageSeen ? [{ type: 'usage' }] : normalizedEvents,
        lastRecordTimestamp,
      );
      await emitNormalizedEvents(usageEvents);
    }
    await flushNormalizedEvents();

    finishProjectionMetrics(options.flush === false ? 'delta' : 'full', projectionStartedAt, {
      recordsSeen,
      stdoutRecords,
      materializedRecords,
      parseFailures,
      normalizedEvents: normalizedEventCount,
    });

    return {
      normalizedEvents,
      normalizedEventCount,
      latestUsage,
      preview: buildRunProjectionPreview(previewRecords),
      autoApprovedIds: [...autoApprovedIdsSeen],
    };
  }

  // Projection can be triggered concurrently by the observer, terminal
  // reconciliation, and a browser refresh. Keep the work bounded while
  // allowing the shared adaptive budget to lower fan-out when parsing starts
  // delaying the control-plane event loop. The lease is released on every
  // path; reducing the budget never interrupts a projection already running.
  async function normalizeRunSpoolRecords(run, runtimeInvocation, spoolRecords = [], options = {}) {
    const lease = await projectionBudget.acquire({
      priority: options.priority || 'normal',
      wait: true,
      deadlineMs: Number.isFinite(options.budgetDeadlineMs) && options.budgetDeadlineMs > 0
        ? options.budgetDeadlineMs
        : 60_000,
    });
    if (!lease) throw new Error('projectionCPU adaptive budget unavailable');
    const startedAt = projectionNowMs();
    try {
      const result = await normalizeRunSpoolRecordsInternal(run, runtimeInvocation, spoolRecords, options);
      lease.release({ durationMs: projectionNowMs() - startedAt, outcome: 'success' });
      return result;
    } catch (error) {
      lease.release({ durationMs: projectionNowMs() - startedAt, outcome: 'error' });
      throw error;
    }
  }

  // Per-run adapter cache for delta ticks. The claude-bidi and
  // codex-app-server adapters keep their auto-approval suppression in an
  // instance-local Set; the sidecar writes the autoApproved echo before the
  // control_request it answers, but those land ~1-3s apart while the observer
  // ticks every 250ms-1s — so echo and request routinely fall in DIFFERENT
  // ticks. A fresh adapter per tick loses the echo's id, and the auto-approved
  // request pops a card + push. One adapter instance per run keeps the Set
  // alive across ticks (the full-spool replay path in collectNormalizedRunEvents
  // keeps its own fresh instance — a single in-order pass works there).
  const deltaRuntimeInvocationByRunId = new Map();
  const terminalProjectionCache = new BoundedLruMap({
    maxEntries: 8,
    maxBytes: cacheBudget('run.terminalProjection', 0.5),
    bytesOf: (value) => {
      try { return JSON.stringify(value).length; } catch { return 0; }
    },
  });
  registerLruOrMap('run.terminalProjection', terminalProjectionCache);

  // Approval observability is kept on the delta path so each spool record is
  // counted once. The legacy fields remain stable; the additional dimensions
  // let us compare Claude and Codex gate behavior without inspecting commands.
  const approvalCounters = {
    echoes: 0,
    requestsSeen: 0,
    projected: 0,
    suppressed: 0,
    received: 0,
    autoAllowed: 0,
    autoDenied: 0,
    presentedToOwner: 0,
    ownerApproved: 0,
    ownerDenied: 0,
    byProvider: Object.create(null),
    byRiskTier: Object.create(null),
    byReasonCode: Object.create(null),
    byPolicyVersion: Object.create(null),
  };
  const approvalCountersByRunId = new Map();

  const projectionCounters = {
    runs: 0,
    fullRuns: 0,
    deltaRuns: 0,
    cacheHits: 0,
    recordsSeen: 0,
    stdoutRecords: 0,
    materializedRecords: 0,
    parseFailures: 0,
    normalizedEvents: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    lastDurationMs: null,
    lastMode: null,
    lastRecordsSeen: 0,
    lastNormalizedEvents: 0,
  };

  function projectionNowMs() {
    return Number(process.hrtime.bigint()) / 1e6;
  }

  function finishProjectionMetrics(mode, startedAt, {
    recordsSeen = 0,
    stdoutRecords = 0,
    materializedRecords = 0,
    parseFailures = 0,
    normalizedEvents = 0,
  } = {}) {
    const durationMs = Math.max(0, projectionNowMs() - startedAt);
    projectionCounters.runs += 1;
    if (mode === 'delta') projectionCounters.deltaRuns += 1;
    else projectionCounters.fullRuns += 1;
    projectionCounters.recordsSeen += recordsSeen;
    projectionCounters.stdoutRecords += stdoutRecords;
    projectionCounters.materializedRecords += materializedRecords;
    projectionCounters.parseFailures += parseFailures;
    projectionCounters.normalizedEvents += normalizedEvents;
    projectionCounters.totalDurationMs += durationMs;
    projectionCounters.maxDurationMs = Math.max(projectionCounters.maxDurationMs, durationMs);
    projectionCounters.lastDurationMs = durationMs;
    projectionCounters.lastMode = mode;
    projectionCounters.lastRecordsSeen = recordsSeen;
    projectionCounters.lastNormalizedEvents = normalizedEvents;
  }

  // Aggregates only; raw spool lines and prompts never enter diagnostics.
  registerCache('run.projection', {
    kind: 'timing',
    snapshot: () => ({
      ...projectionCounters,
      avgDurationMs: projectionCounters.runs > 0
        ? projectionCounters.totalDurationMs / projectionCounters.runs
        : 0,
    }),
  });

  function metricDimensionKey(value) {
    return trimString(value).slice(0, MAX_APPROVAL_METRIC_KEY_LENGTH);
  }

  function incrementMetricBucket(counters, dimension, key, field) {
    const buckets = counters[dimension];
    let normalizedKey = metricDimensionKey(key);
    if (!normalizedKey) return;
    if (!Object.prototype.hasOwnProperty.call(buckets, normalizedKey)
      && Object.keys(buckets).length >= MAX_APPROVAL_METRIC_DIMENSIONS) {
      normalizedKey = 'other';
      if (!Object.prototype.hasOwnProperty.call(buckets, normalizedKey)) {
        const oldest = Object.keys(buckets)[0];
        if (oldest !== undefined) delete buckets[oldest];
      }
    }
    const bucket = buckets[normalizedKey]
      || (buckets[normalizedKey] = createApprovalMetricBucket());
    bucket[field] += 1;
  }

  function touchRunApprovalCounters(runId) {
    const id = metricDimensionKey(runId);
    if (!id) return null;
    let counters = approvalCountersByRunId.get(id);
    if (counters) {
      approvalCountersByRunId.delete(id);
      approvalCountersByRunId.set(id, counters);
      return counters;
    }
    if (approvalCountersByRunId.size >= MAX_APPROVAL_METRIC_RUNS) {
      const oldest = approvalCountersByRunId.keys().next().value;
      if (oldest !== undefined) approvalCountersByRunId.delete(oldest);
    }
    counters = {
      ...createApprovalMetricBucket(),
      byProvider: Object.create(null),
      byRiskTier: Object.create(null),
      byReasonCode: Object.create(null),
      byPolicyVersion: Object.create(null),
    };
    approvalCountersByRunId.set(id, counters);
    return counters;
  }

  function updateApprovalCounters(counters, field, provider, audit) {
    counters[field] += 1;
    const normalizedProvider = provider === 'claude' || provider === 'codex' ? provider : 'unknown';
    incrementMetricBucket(counters, 'byProvider', normalizedProvider, field);
    if (audit.tier) incrementMetricBucket(counters, 'byRiskTier', audit.tier, field);
    if (audit.policyVersion) incrementMetricBucket(counters, 'byPolicyVersion', audit.policyVersion, field);
    for (const code of audit.reasonCodes) incrementMetricBucket(counters, 'byReasonCode', code, field);
  }

  function snapshotApprovalCounters(counters) {
    const cloneBuckets = (buckets) => Object.fromEntries(
      Object.entries(buckets).map(([key, value]) => [key, { ...value }]),
    );
    return {
      ...counters,
      byProvider: cloneBuckets(counters.byProvider),
      byRiskTier: cloneBuckets(counters.byRiskTier),
      byReasonCode: cloneBuckets(counters.byReasonCode),
      byPolicyVersion: cloneBuckets(counters.byPolicyVersion),
    };
  }

  function incrementApprovalMetric(field, { runId = '', provider = 'unknown', risk = null } = {}) {
    if (!APPROVAL_METRIC_FIELDS.includes(field)) return;
    const audit = readRiskAuditInfo(risk);
    updateApprovalCounters(approvalCounters, field, provider, audit);
    const perRun = touchRunApprovalCounters(runId);
    if (perRun) updateApprovalCounters(perRun, field, provider, audit);
  }

  function approvalRiskForPayload(payload, run, requestInfo = null) {
    const explicit = readRiskAuditInfo(payload);
    if (explicit.tier || explicit.policyVersion || explicit.reasonCodes.length > 0) return explicit;
    return classifyApprovalRisk(requestInfo || readApprovalRequestInfo(payload), run);
  }
  registerCache('approvalSuppression', {
    kind: 'counters',
    snapshot: () => snapshotApprovalCounters(approvalCounters),
  });
  registerCache('run.approvalSuppression', {
    kind: 'counters',
    snapshot: () => Object.fromEntries(
      [...approvalCountersByRunId].map(([runId, counters]) => [runId, snapshotApprovalCounters(counters)]),
    ),
  });

  async function getOrCreateDeltaRuntimeInvocation(run, manifest) {
    const cached = deltaRuntimeInvocationByRunId.get(run.id);
    if (cached) return cached;
    const invocation = await createRunRuntimeInvocation(manifest);
    // The first observer invocation for a legacy Run may still need to scan
    // the spool to discover auto-approval echoes. Subsequent restarts use the
    // bounded, durable id list written by the previous projection tick and do
    // not re-read a multi-million-line spool merely to rebuild this Set.
    const seededIds = Array.isArray(run?.approvalSuppressionIds)
      ? run.approvalSuppressionIds
      : [];
    if (run?.approvalSuppressionSeeded === true) {
      seedApprovalSuppression(invocation.adapter, seededIds);
    } else {
      try {
        const seed = async (record) => {
          if (record?.stream !== 'stdout') return;
          const payload = record?.json;
          if (!payload || typeof payload !== 'object') return;
          if (payload.type !== 'agentoc.approval_response' || payload.autoApproved !== true) return;
          if (typeof payload.approvalId === 'string' && payload.approvalId.trim()) {
            seedApprovalSuppression(invocation.adapter, [payload.approvalId]);
          }
        };
        if (typeof scanRunSpoolRecords === 'function') {
          await scanRunSpoolRecords(run.id, seed);
        } else {
          const records = await readRunSpoolRecords(run.id);
          for (const record of records) await seed(record);
        }
      } catch {}
    }
    deltaRuntimeInvocationByRunId.set(run.id, invocation);
    return invocation;
  }

  function releaseRunRuntimeInvocation(runId) {
    deltaRuntimeInvocationByRunId.delete(runId);
    terminalProjectionCache.delete(runId);
  }

  function terminalProjectionKey(run) {
    return [
      run?.id || '',
      run?.state || '',
      run?.completedAt || '',
      run?.spoolCompletionDetectedAt || '',
      Number.isInteger(run?.normalizedByteOffset) ? run.normalizedByteOffset : 0,
      Number.isInteger(run?.normalizedLineCount) ? run.normalizedLineCount : 0,
    ].join('|');
  }

  async function collectNormalizedRunEvents(run, manifest, options = {}) {
    const cacheKey = terminalProjectionKey(run);
    const cached = terminalProjectionCache.get(run.id);
    // A streaming terminal replay may have a session-bound persistence
    // callback; never reuse a cached projection for that path because the
    // callback is part of the caller's side effects.
    if (!options.onNormalizedEvents && cached?.key === cacheKey) {
      projectionCounters.cacheHits += 1;
      return cached.value;
    }
    const runtimeInvocation = await createRunRuntimeInvocation(manifest);
    const spoolRecords = typeof streamRunSpoolRecords === 'function'
      ? streamRunSpoolRecords(run.id)
      : await readRunSpoolRecords(run.id);
    const parsed = await normalizeRunSpoolRecords(buildManifestAwareRun(run, manifest), runtimeInvocation, spoolRecords, {
      includeCodexContextMetrics: true,
      skipNormalizedEvents: options.skipNormalizedEvents,
      retainNormalizedEvents: options.retainNormalizedEvents,
      onNormalizedEvents: options.onNormalizedEvents,
    });
    const value = {
      runtimeInvocation,
      ...parsed,
    };
    terminalProjectionCache.set(run.id, { key: cacheKey, value });
    return value;
  }

  async function collectNormalizedRunEventDelta(run, manifest) {
    const runtimeInvocation = await getOrCreateDeltaRuntimeInvocation(run, manifest);
    const cursor = getRunSpoolCursor(run, 'normalized');
    const delta = await readRunSpoolDelta(run.id, {
      startOffset: cursor.byteOffset,
      skipLines: cursor.lineCount,
    });
    const parsed = await normalizeRunSpoolRecords(
      buildManifestAwareRun(run, manifest),
      runtimeInvocation,
      delta.records,
      { flush: false, countApprovals: true },
    );
    return {
      runtimeInvocation,
      ...parsed,
      nextOffset: delta.nextOffset,
      processedLineCount: delta.processedLineCount,
      skippedLineCount: delta.skippedLineCount,
      autoApprovedIds: parsed.autoApprovedIds,
    };
  }

  return {
    collectNormalizedRunEvents,
    collectNormalizedRunEventDelta,
    getApprovalSuppressionCounters: (runId = '') => {
      const perRun = runId ? approvalCountersByRunId.get(metricDimensionKey(runId)) : null;
      return snapshotApprovalCounters(perRun || approvalCounters);
    },
    releaseRunRuntimeInvocation,
  };
}
