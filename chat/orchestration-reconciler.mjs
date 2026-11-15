// Provider-neutral reconciliation for the common orchestration ledger.
//
// Domain stores (collaboration, organization, approval) remain authoritative
// while they migrate one operation at a time. This service only repairs the
// derived ledger, expires explicit human-wait deadlines, and reports stale
// work. It never claims a generic Command or infers a successful external
// effect, so starting it cannot create duplicate child Runs.
import {
  expireDueInterrupts,
  initializeOrchestrationStore,
  listStalledExecutions,
} from './orchestration-store.mjs';

export const ORCHESTRATION_RECONCILER_SCHEMA_VERSION = 1;

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
let timer = null;
let inFlight = false;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function resolveNow(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
}

function errorSummary(error, area) {
  return {
    area,
    code: typeof error?.code === 'string' ? error.code : 'ORCHESTRATION_RECONCILIATION_ERROR',
    message: typeof error?.message === 'string' ? error.message : String(error),
  };
}

function stalledSummary(execution) {
  return {
    executionId: execution.id,
    scopeKind: execution.scopeKind,
    scopeId: execution.scopeId,
    rootSessionId: execution.rootSessionId,
    state: execution.state,
    checkpointStage: typeof execution.checkpoint?.stage === 'string' ? execution.checkpoint.stage : '',
    nextWakeAt: execution.nextWakeAt,
    lastHeartbeatAt: execution.lastHeartbeatAt,
    updatedAt: execution.updatedAt,
  };
}

export async function reconcileOrchestrationLedger({
  now = new Date(),
  limit = 200,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  mirrorCollaborations = true,
  collaborationOrchestrator = null,
} = {}) {
  const currentTime = resolveNow(now);
  const boundedLimit = positiveInteger(limit, 200, 2_000);
  const boundedStaleAfterMs = positiveInteger(staleAfterMs, DEFAULT_STALE_AFTER_MS, 7 * 24 * 60 * 60 * 1000);
  const errors = [];
  const report = {
    schemaVersion: ORCHESTRATION_RECONCILER_SCHEMA_VERSION,
    enabled: true,
    generatedAt: currentTime.toISOString(),
    mirroredCollaborations: { scanned: 0, mirrored: 0, failed: 0, truncated: false },
    expiredInterrupts: [],
    stalledExecutions: [],
    errors,
  };
  try {
    await initializeOrchestrationStore();
  } catch (error) {
    errors.push(errorSummary(error, 'initialize'));
    return { ...report, status: 'blocked' };
  }

  if (mirrorCollaborations) {
    try {
      const runtime = collaborationOrchestrator
        || (await import('./collaboration-orchestrator.mjs')).getDefaultCollaborationOrchestrator();
      if (typeof runtime?.reconcileLedger === 'function') {
        report.mirroredCollaborations = await runtime.reconcileLedger({ limit: boundedLimit });
      }
    } catch (error) {
      errors.push(errorSummary(error, 'mirror_collaborations'));
    }
  }
  try {
    report.expiredInterrupts = (await expireDueInterrupts({ now: currentTime, limit: boundedLimit }))
      .map((interrupt) => ({
        interruptId: interrupt.id,
        executionId: interrupt.executionId,
        stableKey: interrupt.stableKey,
        generation: interrupt.generation,
        kind: interrupt.kind,
        deadlineAt: interrupt.deadlineAt,
      }));
  } catch (error) {
    errors.push(errorSummary(error, 'expire_interrupts'));
  }
  try {
    report.stalledExecutions = (await listStalledExecutions({
      olderThanMs: boundedStaleAfterMs,
      now: currentTime,
      limit: boundedLimit,
    })).map(stalledSummary);
  } catch (error) {
    errors.push(errorSummary(error, 'list_stalled'));
  }
  return {
    ...report,
    status: errors.length > 0 ? 'degraded'
      : (report.expiredInterrupts.length > 0 || report.stalledExecutions.length > 0 ? 'attention' : 'ok'),
  };
}

export async function startOrchestrationReconciler(options = {}) {
  if (timer) return null;
  const report = await reconcileOrchestrationLedger(options);
  const intervalMs = positiveInteger(
    options.intervalMs ?? process.env.RAGENT_ORCHESTRATION_RECONCILE_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    60 * 60 * 1000,
  );
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void reconcileOrchestrationLedger(options)
      .then((next) => {
        if (next.status === 'blocked' || next.status === 'degraded') {
          console.warn(`[orchestration-reconciler] pass status=${next.status} errors=${next.errors.length}`);
        }
      })
      .catch((error) => console.warn(`[orchestration-reconciler] pass failed: ${error?.message || error}`))
      .finally(() => { inFlight = false; });
  }, intervalMs);
  timer.unref?.();
  return report;
}

export function stopOrchestrationReconciler() {
  if (timer) clearInterval(timer);
  timer = null;
  inFlight = false;
}
