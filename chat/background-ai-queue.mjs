/**
 * Low-priority background AI queue.
 *
 * Serializes post-turn background LLM calls (task-card suggestions,
 * workflow-state suggestions, memory-writeback review) so a batch of
 * completed runs cannot spawn many heavy subprocesses at once and starve
 * the chat server's event loop.
 *
 * The queue is in-memory only: pending work is dropped on restart, which is
 * acceptable for best-effort suggestions. When the queue is disabled
 * (RAGENT_BACKGROUND_AI_QUEUE=off), tasks run directly for easy rollback.
 *
 * Observability (DS-03): when an enqueue carries an `operationId` (from
 * chat/operation-ledger.mjs), the queue records structured events
 * `enqueue` / `skipped` / `started` (stage "queue") for the scheduled unit.
 * The call site owns the provider-call events (started/succeeded/failed/
 * timeout, stage "call"). Optional per-task `timeoutMs` hard deadline emits
 * a `timeout` event and rejects the caller; the task itself keeps running
 * unless the caller self-aborts (summarizer kills its child process).
 *
 * Bounds and safety (DS-04):
 *   - maxQueue default 50 — the queue never grows past it (queue_full).
 *   - `deadlineMs` hard deadline (default 10 min): an entry that has not
 *     STARTED by enqueuedAt + deadline is dropped with a `skipped/deadline`
 *     event instead of running stale work.
 *   - per-session budget (default 8 starts per session per rolling hour):
 *     sessions cannot hog the queue (skipped/session_budget).
 *   - provider/capability circuit breaker (chat/ai-circuit-breaker.mjs):
 *     open breakers (auth cooldown / unsupported / code_error) gate
 *     enqueues; terminal outcomes are fed back into the breaker.
 *   - per-session status projection for the UI (getSessionProjection).
 */

import { isEnvToggleEnabled } from '../lib/env-toggle.mjs';
import { aiCircuitBreaker } from './ai-circuit-breaker.mjs';
import { OperationTimeoutError, classifyProviderError, recordOperationEvent } from './operation-ledger.mjs';
import { registerCache } from './memory-registry.mjs';
import { createAdaptiveConcurrencyBudget } from './adaptive-concurrency.mjs';
import { getAdaptiveConcurrencyBudget } from './adaptive-concurrency-registry.mjs';

const QUEUE_ENV = 'RAGENT_BACKGROUND_AI_QUEUE';
const CONCURRENCY_ENV = 'RAGENT_BACKGROUND_AI_CONCURRENCY';
const DELAY_ENV = 'RAGENT_BACKGROUND_AI_DELAY_MS';
const MAX_QUEUE_ENV = 'RAGENT_BACKGROUND_AI_MAX_QUEUE';
const TIMEOUT_ENV = 'RAGENT_BACKGROUND_AI_TIMEOUT_MS';
const DEADLINE_ENV = 'RAGENT_BACKGROUND_AI_DEADLINE_MS';
const SESSION_BUDGET_ENV = 'RAGENT_BACKGROUND_AI_SESSION_BUDGET';
const SESSION_BUDGET_WINDOW_ENV = 'RAGENT_BACKGROUND_AI_SESSION_BUDGET_WINDOW_MS';

// Background work is best-effort and must have a finite upper bound by
// default. Callers that own a stronger cancellation mechanism may still set
// timeoutMs=0 explicitly, but an unset environment must never mean forever.
const DEFAULT_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_DEADLINE_MS = 10 * 60_000;
const DEFAULT_SESSION_BUDGET = 8;
const DEFAULT_SESSION_BUDGET_WINDOW_MS = 60 * 60_000;
// Cap on per-session projection entries (last terminal outcome per session)
// so a long-lived server cannot grow this map without bound.
const MAX_SESSION_STATUSES = 5000;

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readBackgroundAiQueueOptions(env = process.env) {
  return {
    enabled: isEnvToggleEnabled(env[QUEUE_ENV], { defaultValue: true }),
    concurrency: readPositiveInt(env[CONCURRENCY_ENV], 1),
    delayMs: readNonNegativeInt(env[DELAY_ENV], 0),
    maxQueue: readPositiveInt(env[MAX_QUEUE_ENV], 50),
    timeoutMs: readNonNegativeInt(env[TIMEOUT_ENV], DEFAULT_TIMEOUT_MS),
    deadlineMs: readNonNegativeInt(env[DEADLINE_ENV], DEFAULT_DEADLINE_MS),
    sessionBudget: readPositiveInt(env[SESSION_BUDGET_ENV], DEFAULT_SESSION_BUDGET),
    sessionBudgetWindowMs: readPositiveInt(env[SESSION_BUDGET_WINDOW_ENV], DEFAULT_SESSION_BUDGET_WINDOW_MS),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimStringField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function createBackgroundAiQueue(options = {}) {
  const opts = { ...readBackgroundAiQueueOptions(), ...options };
  // The singleton queue uses the process-wide adaptive budget. Tests and
  // explicit fixed-concurrency callers get an isolated fixed budget so their
  // active work cannot affect production diagnostics or another test.
  const adaptiveBudget = options.budget
    || (Object.prototype.hasOwnProperty.call(options, 'concurrency')
      ? createAdaptiveConcurrencyBudget({
        name: 'backgroundAI:test',
        mode: 'off',
        minLimit: 1,
        initialLimit: opts.concurrency,
        maxLimit: opts.concurrency,
        targetLatencyMs: opts.timeoutMs || 30_000,
      })
      : getAdaptiveConcurrencyBudget('backgroundAI'));
  const breaker = opts.breaker || aiCircuitBreaker;
  const queue = [];
  const queuedKeys = new Set();
  const runningKeys = new Set();
  let active = 0;
  let worker = null;
  // Observability counters (DS-06), exposed via counters() — never the key
  // strings themselves (they embed session ids).
  let totalStarted = 0;
  let totalCompleted = 0;
  let totalSkippedDedupe = 0;
  let totalSkippedFull = 0;
  const skippedByReason = new Map();
  // Per-session start timestamps within the budget window (rolling).
  const sessionStartedAt = new Map();
  // Per-session status projection: current queued/running state plus the last
  // terminal outcome (succeeded/failed/skipped) with error details.
  const sessionStatuses = new Map();

  function log(message) {
    console.log(`[background-ai] ${message}`);
  }

  function recordSkippedCount(reason) {
    skippedByReason.set(reason, (skippedByReason.get(reason) || 0) + 1);
  }

  function updateSessionStatus(sessionId, status, extra = {}) {
    if (!sessionId) return;
    if (sessionStatuses.size >= MAX_SESSION_STATUSES && !sessionStatuses.has(sessionId)) {
      // Prune the least recently updated entries to keep the map bounded.
      const oldest = [...sessionStatuses.entries()]
        .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
        .slice(0, Math.ceil(MAX_SESSION_STATUSES * 0.2))
        .map(([key]) => key);
      for (const key of oldest) sessionStatuses.delete(key);
    }
    const previous = sessionStatuses.get(sessionId) || {};
    sessionStatuses.set(sessionId, {
      status,
      operation: extra.operation || previous.operation || '',
      provider: extra.provider || previous.provider || '',
      model: extra.model || previous.model || '',
      enqueuedAt: extra.enqueuedAt ?? previous.enqueuedAt ?? null,
      startedAt: extra.startedAt ?? previous.startedAt ?? null,
      finishedAt: extra.finishedAt ?? previous.finishedAt ?? null,
      errorCode: extra.errorCode || previous.errorCode || '',
      errorMessage: extra.errorMessage || previous.errorMessage || '',
      skippedReason: extra.skippedReason || previous.skippedReason || '',
      retryAfterMs: extra.retryAfterMs ?? previous.retryAfterMs ?? null,
      attempt: extra.attempt ?? previous.attempt ?? 1,
      updatedAt: Date.now(),
    });
  }

  function recordQueueEvent(kind, entry, extra = {}) {
    if (!entry?.operationId) return;
    recordOperationEvent({
      kind,
      operationId: entry.operationId,
      operation: entry.operation,
      sessionId: entry.sessionId,
      provider: entry.provider,
      model: entry.model,
      attempt: entry.attempt,
      ts: new Date().toISOString(),
      stage: 'queue',
      queueDepth: queue.length + active,
      ...extra,
    });
  }

  function startWorker() {
    if (worker || !opts.enabled || queue.length === 0) return;
    worker = (async () => {
      try {
        while (queue.length > 0 || active > 0) {
          if (active >= adaptiveBudget.effectiveLimit) {
            await sleep(50);
            continue;
          }
          const next = queue[0];
          if (!next) {
            await sleep(50);
            continue;
          }
          const now = Date.now();
          // Hard deadline: entries that waited too long are dropped instead
          // of running stale work (DS-04).
          if (next.deadlineMs > 0 && now - next.enqueuedAt >= next.deadlineMs) {
            queue.shift();
            queuedKeys.delete(next.key);
            recordSkippedCount('deadline');
            log(`Skipped ${next.key || '<unkeyed>'}: deadline expired (${next.deadlineMs}ms)`);
            recordQueueEvent('skipped', next, {
              reason: 'deadline',
              queueDepth: queue.length + active,
              durationMs: now - next.enqueuedAt,
            });
            updateSessionStatus(next.sessionId, 'skipped', {
              operation: next.operation,
              provider: next.provider,
              model: next.model,
              enqueuedAt: next.enqueuedAt,
              finishedAt: now,
              skippedReason: 'deadline',
            });
            next.resolve({ ok: false, skipped: 'deadline' });
            continue;
          }
          const waitMs = next.readyAt - now;
          if (waitMs > 0) {
            await sleep(Math.min(waitMs, 200));
            continue;
          }
          // Re-check the rolling budget at start time. Multiple calls can be
          // enqueued before the single worker records their starts; checking
          // only in enqueue() would let a burst bypass the per-session cap.
          if (next.sessionId && opts.sessionBudget > 0) {
            const windowStart = now - opts.sessionBudgetWindowMs;
            const starts = (sessionStartedAt.get(next.sessionId) || []).filter((ts) => ts >= windowStart);
            sessionStartedAt.set(next.sessionId, starts);
            if (starts.length >= opts.sessionBudget) {
              queue.shift();
              queuedKeys.delete(next.key);
              recordSkippedCount('session_budget');
              recordQueueEvent('skipped', next, {
                reason: 'session_budget',
                budget: opts.sessionBudget,
                windowMs: opts.sessionBudgetWindowMs,
                queueDepth: queue.length + active,
                durationMs: now - next.enqueuedAt,
              });
              updateSessionStatus(next.sessionId, 'skipped', {
                operation: next.operation,
                provider: next.provider,
                model: next.model,
                enqueuedAt: next.enqueuedAt,
                finishedAt: now,
                skippedReason: 'session_budget',
              });
              next.resolve({ ok: false, skipped: 'session_budget', budget: opts.sessionBudget, windowMs: opts.sessionBudgetWindowMs });
              continue;
            }
          }
          queue.shift();
          // This is a non-waiting gate. Use the synchronous fast path so the
          // existing queued -> running status projection remains observable
          // in the same turn as enqueue().
          const budgetLease = adaptiveBudget.tryAcquire({ priority: 'background' });
          if (!budgetLease) {
            queue.unshift(next);
            queuedKeys.add(next.key);
            await sleep(50);
            continue;
          }
          // Keep the dedupe key claimed across the asynchronous budget
          // acquisition. Otherwise a duplicate enqueue can slip into the
          // small await gap before the task is marked active.
          queuedKeys.delete(next.key);
          active += 1;
          totalStarted += 1;
          runningKeys.add(next.key);
          if (next.sessionId) {
            const starts = sessionStartedAt.get(next.sessionId) || [];
            starts.push(now);
            sessionStartedAt.set(next.sessionId, starts);
          }
          next.budgetLease = budgetLease;
          next.startedAt = now;
          log(`Running ${next.key || '<unkeyed>'} (queued=${queue.length}, active=${active})`);
          recordQueueEvent('started', next, { durationMs: now - next.enqueuedAt });
          updateSessionStatus(next.sessionId, 'running', {
            operation: next.operation,
            provider: next.provider,
            model: next.model,
            enqueuedAt: next.enqueuedAt,
            startedAt: now,
            attempt: next.attempt,
          });
          const taskPromise = Promise.resolve().then(() => next.task());
          if (next.timeoutMs > 0) {
            const timer = setTimeout(() => {
              onTaskDone(next, null, new OperationTimeoutError(`Background AI task timed out after ${next.timeoutMs}ms`), true);
            }, next.timeoutMs);
            taskPromise.then(
              (value) => { clearTimeout(timer); onTaskDone(next, value, null); },
              (error) => { clearTimeout(timer); onTaskDone(next, null, error); },
            );
          } else {
            taskPromise.then(
              (value) => onTaskDone(next, value, null),
              (error) => onTaskDone(next, null, error),
            );
          }
        }
      } finally {
        worker = null;
      }
    })();
  }

  function onTaskDone(entry, value, error, timedOut = false) {
    if (entry.settled) {
      // Late settlement after a timeout fired: the task is still running in
      // the background; ignore it but surface the event so the caller knows.
      log(`Late completion ignored for ${entry.key || '<unkeyed>'}: ${timedOut ? 'timed out' : 'already settled'}`);
      return;
    }
    entry.settled = true;
    active -= 1;
    totalCompleted += 1;
    runningKeys.delete(entry.key);
    const durationMs = Date.now() - entry.enqueuedAt;
    // A timeout is a logical completion for the queue. The task may still be
    // running if its provider cannot be aborted, matching the existing queue
    // contract; callers should abort their child process where possible.
    entry.budgetLease?.release({
      durationMs: Math.max(0, Date.now() - (entry.startedAt || entry.enqueuedAt)),
      outcome: timedOut ? 'timeout' : error ? 'error' : 'success',
    });
    entry.budgetLease = null;
    if (timedOut) {
      log(`Timed out ${entry.key || '<unkeyed>'} after ${entry.timeoutMs}ms`);
      recordQueueEvent('timeout', entry, { durationMs, errorCode: 'timeout' });
      breaker.observeOutcome({
        provider: entry.provider,
        operation: entry.operation,
        errorCode: 'timeout',
        errorMessage: String(error?.message || ''),
        ok: false,
      });
      updateSessionStatus(entry.sessionId, 'failed', {
        operation: entry.operation,
        provider: entry.provider,
        model: entry.model,
        enqueuedAt: entry.enqueuedAt,
        finishedAt: Date.now(),
        errorCode: 'timeout',
        errorMessage: String(error?.message || '').slice(0, 200),
        attempt: entry.attempt,
      });
      entry.reject(error);
    } else if (error) {
      const errorCode = classifyProviderError(error, { context: 'call' });
      log(`Failed ${entry.key || '<unkeyed>'}: ${error.message}`);
      recordQueueEvent('failed', entry, {
        durationMs,
        errorCode,
        errorMessage: String(error?.message || '').slice(0, 200),
      });
      breaker.observeOutcome({
        provider: entry.provider,
        operation: entry.operation,
        errorCode,
        errorMessage: String(error?.message || ''),
        ok: false,
      });
      updateSessionStatus(entry.sessionId, 'failed', {
        operation: entry.operation,
        provider: entry.provider,
        model: entry.model,
        enqueuedAt: entry.enqueuedAt,
        finishedAt: Date.now(),
        errorCode,
        errorMessage: String(error?.message || '').slice(0, 200),
        attempt: entry.attempt,
      });
      entry.reject(error);
    } else {
      // Successes are observed at the call sites (runToolJsonPrompt /
      // memory-writeback) because a task may swallow a per-kind failure and
      // still resolve — the queue cannot tell "all fine" from "kind failed".
      recordQueueEvent('succeeded', entry, { durationMs, result: 'ok' });
      updateSessionStatus(entry.sessionId, 'succeeded', {
        operation: entry.operation,
        provider: entry.provider,
        model: entry.model,
        enqueuedAt: entry.enqueuedAt,
        finishedAt: Date.now(),
        attempt: entry.attempt,
      });
      entry.resolve(value);
    }
    if (queue.length > 0) startWorker();
  }

  /**
   * Enqueue a background AI task.
   *
   * @param {string} key Dedup key (e.g. `session-suggestion:<sessionId>`).
   *   Empty for tasks that should always run (still serialized by the queue).
   * @param {Function} task Async task returning the suggestion result.
   * @param {{ delayMs?: number, operationId?: string, operation?: string,
   *   sessionId?: string, provider?: string, model?: string, attempt?: number,
   *   timeoutMs?: number, deadlineMs?: number }} enqueueOptions Optional
   *   per-task options. When `operationId` is present, structured queue
   *   events are recorded in the operation ledger.
   * @returns {Promise<*>} The task result, or `{ ok:false, skipped }` when
   *   deduped, dropped because the queue is full, past the hard deadline,
   *   over the per-session budget, or gated by the circuit breaker.
   */
  function enqueue(key, task, enqueueOptions = {}) {
    if (!opts.enabled) {
      return task();
    }
    const normalizedKey = key ? String(key) : '';
    const taskDelayMs = Number.isFinite(enqueueOptions?.delayMs) && enqueueOptions.delayMs >= 0
      ? enqueueOptions.delayMs
      : opts.delayMs;
    const sessionId = trimStringField(enqueueOptions?.sessionId);
    const provider = trimStringField(enqueueOptions?.provider);
    const operation = trimStringField(enqueueOptions?.operation);
    const skip = (reason, extra = {}) => {
      recordSkippedCount(reason);
      log(`Skipped ${normalizedKey}: ${reason}`);
      if (enqueueOptions?.operationId) {
        recordOperationEvent({
          kind: 'skipped',
          operationId: enqueueOptions.operationId,
          operation: operation || 'background_prompt',
          sessionId,
          provider,
          model: enqueueOptions.model,
          attempt: enqueueOptions.attempt || 1,
          ts: new Date().toISOString(),
          stage: 'queue',
          reason,
          queueDepth: queue.length + active,
        });
      }
      updateSessionStatus(sessionId, 'skipped', {
        operation,
        provider,
        model: enqueueOptions.model,
        enqueuedAt: Date.now(),
        finishedAt: Date.now(),
        skippedReason: reason,
        retryAfterMs: extra.retryAfterMs ?? null,
        attempt: enqueueOptions.attempt || 1,
      });
      return Promise.resolve({ ok: false, skipped: reason, ...extra });
    };
    if (normalizedKey) {
      if (queuedKeys.has(normalizedKey) || runningKeys.has(normalizedKey)) {
        totalSkippedDedupe += 1;
        return skip('dedupe');
      }
      if (queue.length >= opts.maxQueue) {
        totalSkippedFull += 1;
        return skip('queue_full');
      }
    }
    // Circuit breaker gate (DS-04): auth cooldown / unsupported / code_error
    // block new calls for the provider:capability pair.
    if (provider && operation) {
      const gate = breaker.shouldEnqueue(provider, operation);
      if (!gate.allow) {
        const reason = gate.status === 'open' ? 'breaker_open' : gate.status;
        return skip(reason, { retryAfterMs: gate.retryAfterMs ?? null });
      }
    }
    // Per-session budget (DS-04): bounded starts per rolling window.
    if (sessionId && opts.sessionBudget > 0) {
      const now = Date.now();
      const windowStart = now - opts.sessionBudgetWindowMs;
      const starts = (sessionStartedAt.get(sessionId) || []).filter((ts) => ts >= windowStart);
      if (starts.length >= opts.sessionBudget) {
        sessionStartedAt.set(sessionId, starts);
        return skip('session_budget', { budget: opts.sessionBudget, windowMs: opts.sessionBudgetWindowMs });
      }
      sessionStartedAt.set(sessionId, starts);
    }
    if (normalizedKey) {
      queuedKeys.add(normalizedKey);
    }
    const taskTimeoutMs = Number.isFinite(enqueueOptions?.timeoutMs) && enqueueOptions.timeoutMs >= 0
      ? enqueueOptions.timeoutMs
      : opts.timeoutMs;
    const taskDeadlineMs = Number.isFinite(enqueueOptions?.deadlineMs) && enqueueOptions.deadlineMs > 0
      ? enqueueOptions.deadlineMs
      : opts.deadlineMs;
    return new Promise((resolve, reject) => {
      const entry = {
        key: normalizedKey,
        task,
        resolve,
        reject,
        readyAt: Date.now() + Math.max(0, taskDelayMs),
        enqueuedAt: Date.now(),
        timeoutMs: taskTimeoutMs,
        deadlineMs: taskDeadlineMs,
        settled: false,
        // Always carry session/provider/operation so the per-session budget
        // and status projection work even without an operationId (ledger
        // events are still gated on operationId by recordQueueEvent).
        operationId: enqueueOptions?.operationId || '',
        operation: operation || 'background_prompt',
        sessionId,
        provider,
        model: enqueueOptions.model || '',
        attempt: enqueueOptions.attempt || 1,
      };
      queue.push(entry);
      updateSessionStatus(sessionId, 'queued', {
        operation: entry.operation,
        provider: entry.provider,
        model: entry.model,
        enqueuedAt: entry.enqueuedAt,
        attempt: entry.attempt,
      });
      recordQueueEvent('enqueue', entry);
      startWorker();
    });
  }

  function stats() {
    return {
      enabled: opts.enabled,
      concurrency: opts.concurrency,
      effectiveConcurrency: adaptiveBudget.effectiveLimit,
      delayMs: opts.delayMs,
      maxQueue: opts.maxQueue,
      timeoutMs: opts.timeoutMs,
      deadlineMs: opts.deadlineMs,
      sessionBudget: opts.sessionBudget,
      sessionBudgetWindowMs: opts.sessionBudgetWindowMs,
      queued: queue.length,
      active,
      adaptive: adaptiveBudget.snapshot(),
      queuedKeys: [...queuedKeys],
      runningKeys: [...runningKeys],
    };
  }

  // Counts-only view for the memory registry / healthz (DS-06): exposes queue
  // depth and monotonic throughput counters, never key strings.
  function counters() {
    return {
      enabled: opts.enabled,
      concurrency: opts.concurrency,
      effectiveConcurrency: adaptiveBudget.effectiveLimit,
      delayMs: opts.delayMs,
      maxQueue: opts.maxQueue,
      timeoutMs: opts.timeoutMs,
      deadlineMs: opts.deadlineMs,
      sessionBudget: opts.sessionBudget,
      sessionBudgetWindowMs: opts.sessionBudgetWindowMs,
      queued: queue.length,
      active,
      adaptive: adaptiveBudget.snapshot(),
      queuedKeys: queuedKeys.size,
      runningKeys: runningKeys.size,
      totalStarted,
      totalCompleted,
      totalSkippedDedupe,
      totalSkippedFull,
      totalSkippedOther: [...skippedByReason.values()].reduce((sum, count) => sum + count, 0),
      skippedByReason: [...skippedByReason.entries()].map(([reason, count]) => ({ reason, count })),
    };
  }

  /**
   * Per-session status projection (DS-04) for the UI: current queued/running
   * state or the last terminal outcome (succeeded/failed/skipped) with error
   * details. Returns null for sessions with no tracked background AI work.
   */
  function getSessionProjection(sessionId) {
    if (!sessionId) return null;
    const status = sessionStatuses.get(sessionId);
    if (!status) return null;
    return {
      status: status.status,
      operation: status.operation || '',
      provider: status.provider || '',
      model: status.model || '',
      enqueuedAt: status.enqueuedAt,
      startedAt: status.startedAt,
      finishedAt: status.finishedAt,
      errorCode: status.errorCode || '',
      errorMessage: status.errorMessage || '',
      skippedReason: status.skippedReason || '',
      retryAfterMs: status.retryAfterMs,
      attempt: status.attempt || 1,
      queueDepth: queue.length + active,
    };
  }

  function stop() {
    const pending = queue.splice(0);
    queuedKeys.clear();
    for (const entry of pending) {
      if (entry.settled) continue;
      entry.settled = true;
      recordSkippedCount('shutdown');
      recordQueueEvent('skipped', entry, { reason: 'shutdown' });
      updateSessionStatus(entry.sessionId, 'skipped', {
        operation: entry.operation,
        provider: entry.provider,
        model: entry.model,
        enqueuedAt: entry.enqueuedAt,
        finishedAt: Date.now(),
        skippedReason: 'shutdown',
      });
      entry.resolve({ ok: false, skipped: 'shutdown' });
    }
    return { dropped: pending.length, active };
  }

  return { enqueue, stats, counters, getSessionProjection, stop };
}

// Module-level singleton used by the chat server; tests create their own
// instances via createBackgroundAiQueue().
export const backgroundAiQueue = createBackgroundAiQueue();

// Memory registry (DS-06): expose the singleton queue gauges to /healthz and
// the owner-only diagnostics route.
registerCache('backgroundQueue', {
  kind: 'background-queue',
  snapshot: () => {
    const c = backgroundAiQueue.counters();
    return {
      entries: c.queued + c.active,
      bytes: 0,
      hits: c.totalStarted,
      misses: c.totalSkippedDedupe + c.totalSkippedFull,
      evictions: 0,
      hitRate: null,
      oldestEntryAgeMs: null,
      maxEntries: c.maxQueue,
      maxBytes: null,
      ...c,
    };
  },
});
