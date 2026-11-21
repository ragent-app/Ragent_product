import { getRun, isTerminalRunState } from './runs.mjs';

const AUTH_RECOVERY_STATES = new Set([
  'auth_retrying',
  'auth_recovered',
  'auth_retry_exhausted',
  'reauth_required',
]);

function timestampMs(value) {
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function classifyRunOutputActivity(run, {
  nowMs = Date.now(),
  projectionGraceMs = 5000,
  providerSilenceMs = 30_000,
  heartbeatFreshMs = 30_000,
} = {}) {
  if (!run || ['completed', 'failed', 'cancelled'].includes(String(run.state || '').toLowerCase())) {
    return 'idle';
  }
  const providerByteMs = timestampMs(run.providerLastByteAt);
  const reasoningMs = timestampMs(run.providerLastReasoningAt);
  const semanticMs = timestampMs(run.providerLastSemanticEventAt);
  const visibleMs = timestampMs(run.lastVisibleActivityAt);
  const firstTextMs = timestampMs(run.firstTextDeltaAt);
  const heartbeatMs = timestampMs(run.runnerHeartbeatAt);
  const startedMs = timestampMs(run.runnerStartedAt || run.startedAt || run.createdAt);

  if (providerByteMs > 0 && (
    (semanticMs > 0 && providerByteMs - semanticMs > projectionGraceMs)
    || (!semanticMs && nowMs - providerByteMs > projectionGraceMs)
  )) {
    return 'projection_stalled';
  }
  if (semanticMs > 0 && (
    (visibleMs > 0 && semanticMs - visibleMs > projectionGraceMs)
    || (!visibleMs && nowMs - semanticMs > projectionGraceMs)
  )) {
    return 'visible_activity_starved';
  }
  if (reasoningMs > 0
      && nowMs - reasoningMs <= providerSilenceMs
      && (!firstTextMs || reasoningMs >= firstTextMs)) {
    return 'active_reasoning';
  }
  if (heartbeatMs > 0
      && nowMs - heartbeatMs <= heartbeatFreshMs
      && (
        (providerByteMs > 0 && nowMs - providerByteMs > providerSilenceMs)
        || (!providerByteMs && startedMs > 0 && nowMs - startedMs > providerSilenceMs)
      )) {
    return 'upstream_silent';
  }
  if (!providerByteMs && !semanticMs && heartbeatMs > 0) return 'awaiting_provider_output';
  return 'active';
}

export function normalizeAuthRecoveryForActivity(value) {
  if (!value || typeof value !== 'object') return null;
  const state = typeof value.state === 'string'
    ? value.state.trim()
    : typeof value.authRetryState === 'string'
      ? value.authRetryState.trim()
      : '';
  if (!AUTH_RECOVERY_STATES.has(state)) return null;
  const retryCountValue = value.retryCount ?? value.authRetryCount;
  const retryLimitValue = value.retryLimit ?? value.authRetryLimit;
  const retryCount = Number.isSafeInteger(Number(retryCountValue))
    ? Math.max(0, Math.floor(Number(retryCountValue)))
    : 0;
  const retryLimit = Number.isSafeInteger(Number(retryLimitValue))
    ? Math.max(0, Math.floor(Number(retryLimitValue)))
    : 0;
  return {
    state,
    retryCount,
    retryLimit,
  };
}

export async function resolveSessionRunActivity(meta) {
  if (meta?.activeRunId) {
    const run = await getRun(meta.activeRunId);
    if (!run) return { state: 'unknown', run: { id: meta.activeRunId, state: 'unknown' }, authRecovery: null };
    if (!isTerminalRunState(run.state)) {
      return {
        state: 'running',
        run,
        authRecovery: normalizeAuthRecoveryForActivity(run.authRecovery),
      };
    }
    return {
      state: 'idle',
      run: null,
      authRecovery: normalizeAuthRecoveryForActivity(run?.authRecovery),
    };
  }

  return {
    state: 'idle',
    run: null,
    authRecovery: null,
  };
}

export function getSessionRunState(session) {
  return session?.activity?.run?.state === 'running' ? 'running' : 'idle';
}

export function isSessionRunning(session) {
  return getSessionRunState(session) === 'running';
}

export function getSessionQueueCount(session) {
  return Number.isInteger(session?.activity?.queue?.count) ? session.activity.queue.count : 0;
}

export function getSessionRunId(session) {
  return typeof session?.activity?.run?.runId === 'string' && session.activity.run.runId
    ? session.activity.run.runId
    : null;
}

export function buildSessionActivity(meta, runtimeState, { runState, run, queuedCount, authRecovery } = {}) {
  const renameState = runtimeState?.renameState === 'pending' || runtimeState?.renameState === 'failed'
    ? runtimeState.renameState
    : 'idle';
  const renameError = typeof runtimeState?.renameError === 'string' ? runtimeState.renameError : '';
  const compactState = runtimeState?.pendingCompact === true ? 'pending' : 'idle';
  const queueCount = Number.isInteger(queuedCount) ? queuedCount : 0;
  const planningQueue = Array.isArray(meta?.pendingPlanningQueue) ? meta.pendingPlanningQueue : [];
  const planningCount = planningQueue.length;
  const activePlanningEntry = planningCount > 0 ? planningQueue[0] : null;
  const projectedAuthRecovery = runState === 'running'
    ? normalizeAuthRecoveryForActivity(run?.authRecovery)
    : normalizeAuthRecoveryForActivity(authRecovery)
      || normalizeAuthRecoveryForActivity(meta?.lastAuthRecovery);

  return {
    run: {
      state: runState === 'unknown' ? 'unknown' : runState === 'running' ? 'running' : 'idle',
      phase: runState === 'running'
        ? (typeof run?.state === 'string' ? run.state : null)
        : null,
      startedAt: runState === 'running'
        ? (typeof run?.startedAt === 'string' ? run.startedAt : null)
        : null,
      runId: runState === 'running' || runState === 'unknown'
        ? (typeof run?.id === 'string'
          ? run.id
          : (typeof meta?.activeRunId === 'string' ? meta.activeRunId : null))
        : null,
      provider: runState === 'running' && typeof run?.provider === 'string' && run.provider
        ? run.provider
        : null,
      runtimeFamily: runState === 'running' && typeof run?.runtimeFamily === 'string' && run.runtimeFamily
        ? run.runtimeFamily
        : null,
      providerCapabilities: runState === 'running' && run?.providerCapabilities && typeof run.providerCapabilities === 'object'
        ? run.providerCapabilities
        : null,
      permissionMode: runState === 'running' && typeof run?.permissionMode === 'string' && run.permissionMode
        ? run.permissionMode
        : null,
      reasoning: runState === 'running'
        ? {
            enabled: typeof run?.reasoningEnabled === 'boolean'
              ? run.reasoningEnabled
              : (typeof run?.effort === 'string' && run.effort.trim()
                ? run.effort.trim().toLowerCase() !== 'none'
                : run?.thinking === true),
            effort: typeof run?.effort === 'string' && run.effort ? run.effort : null,
            visibility: ['hidden', 'collapsed', 'expanded'].includes(run?.reasoningVisibility)
              ? run.reasoningVisibility
              : 'collapsed',
          }
        : null,
      outputActivity: runState === 'running'
        ? {
            phase: classifyRunOutputActivity(run),
            providerLastByteAt: typeof run?.providerLastByteAt === 'string' ? run.providerLastByteAt : null,
            firstProviderReasoningAt: typeof run?.firstProviderReasoningAt === 'string' ? run.firstProviderReasoningAt : null,
            providerLastReasoningAt: typeof run?.providerLastReasoningAt === 'string' ? run.providerLastReasoningAt : null,
            firstProviderSemanticEventAt: typeof run?.firstProviderSemanticEventAt === 'string' ? run.firstProviderSemanticEventAt : null,
            providerLastSemanticEventAt: typeof run?.providerLastSemanticEventAt === 'string' ? run.providerLastSemanticEventAt : null,
            firstVisibleActivityAt: typeof run?.firstVisibleActivityAt === 'string' ? run.firstVisibleActivityAt : null,
            lastVisibleActivityAt: typeof run?.lastVisibleActivityAt === 'string' ? run.lastVisibleActivityAt : null,
            firstTextDeltaAt: typeof run?.firstTextDeltaAt === 'string' ? run.firstTextDeltaAt : null,
          }
        : null,
      cancelRequested: runState === 'running' && run?.cancelRequested === true,
      authRecovery: projectedAuthRecovery,
      providerSlot: runState === 'running' && run?.agyQueue?.reason === 'agy-account-busy'
        ? {
          state: 'waiting',
          queuedAt: typeof run.agyQueue.queuedAt === 'string' ? run.agyQueue.queuedAt : null,
        }
        : null,
    },
    queue: {
      state: queueCount > 0 ? 'queued' : 'idle',
      count: queueCount,
    },
    rename: {
      state: renameState,
      error: renameError || null,
    },
    compact: {
      state: compactState,
    },
    planning: {
      state: planningCount > 0 ? 'checking' : 'idle',
      count: planningCount,
      requestId: typeof activePlanningEntry?.requestId === 'string' && activePlanningEntry.requestId
        ? activePlanningEntry.requestId
        : null,
    },
  };
}
