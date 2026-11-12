// Process-local adaptive budgets shared by all harness and timeline paths.
// Budgets are created once per chat-server process. The registry owns the
// sampler cadence; individual modules only acquire/release leases and never
// start their own control loops.

import { performance } from 'node:perf_hooks';

import { createAdaptiveConcurrencyBudget } from './adaptive-concurrency.mjs';
import { registerCache } from './memory-registry.mjs';

const MODE_ENV = 'AGENTOC_ADAPTIVE_CONCURRENCY';
const WINDOW_ENV = 'AGENTOC_ADAPTIVE_SAMPLE_WINDOW_MS';
const COOLDOWN_ENV = 'AGENTOC_ADAPTIVE_COOLDOWN_MS';
const DECREASE_ENV = 'AGENTOC_ADAPTIVE_DECREASE_FACTOR';
const HISTORY_INITIAL_ENV = 'AGENTOC_HISTORY_READ_CONCURRENCY';
const HISTORY_MAX_ENV = 'AGENTOC_HISTORY_READ_MAX_CONCURRENCY';
const HISTORY_BACKGROUND_INITIAL_ENV = 'AGENTOC_HISTORY_BACKGROUND_CONCURRENCY';
const HISTORY_BACKGROUND_MAX_ENV = 'AGENTOC_HISTORY_BACKGROUND_MAX_CONCURRENCY';
const PROJECTION_INITIAL_ENV = 'AGENTOC_PROJECTION_CONCURRENCY';
const PROJECTION_MAX_ENV = 'AGENTOC_PROJECTION_MAX_CONCURRENCY';
const BACKGROUND_INITIAL_ENV = 'AGENTOC_BACKGROUND_AI_CONCURRENCY';
const BACKGROUND_MAX_ENV = 'AGENTOC_BACKGROUND_AI_MAX_CONCURRENCY';
const PROVIDER_IO_INITIAL_ENV = 'AGENTOC_PROVIDER_IO_CONCURRENCY';
const PROVIDER_IO_MAX_ENV = 'AGENTOC_PROVIDER_IO_MAX_CONCURRENCY';
const RUN_INITIAL_ENV = 'AGENTOC_RUN_CAPACITY_MAX_CONCURRENT';
const RUN_MIN_ENV = 'AGENTOC_RUN_MIN_CONCURRENT';
const RUN_MAX_ENV = 'AGENTOC_RUN_ADAPTIVE_MAX_CONCURRENT';
const RUN_PROVIDER_MAX_ENV = 'AGENTOC_RUN_PROVIDER_MAX_CONCURRENT';

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function modeFromEnvironment(environment = process.env) {
  // The controller has completed its shadow rollout.  Adaptive admission is
  // now the safe default; operators can still pin legacy capacity with `off`
  // or collect decisions without applying them with `shadow`.
  const raw = String(environment[MODE_ENV] ?? 'on').trim().toLowerCase();
  return raw === 'off' || raw === 'shadow' || raw === 'on' ? raw : 'on';
}

function buildBudgetOptions(environment = process.env) {
  const mode = modeFromEnvironment(environment);
  const sampleWindowMs = Math.max(250, nonNegativeInt(environment[WINDOW_ENV], 5_000));
  const cooldownMs = Math.max(0, nonNegativeInt(environment[COOLDOWN_ENV], 20_000));
  const decreaseFactor = Math.max(0.1, Math.min(0.95, finiteNumber(environment[DECREASE_ENV], 0.7)));
  // Keep a reserved foreground lane for session entry/refreshes. Background
  // scans used to share one 2,000-item queue with those requests, so a burst
  // of compaction/recovery work could make localhost requests wait behind
  // thousands of unrelated file reads.
  const historyInitial = positiveInt(environment[HISTORY_INITIAL_ENV], 16);
  const historyMax = Math.max(historyInitial, positiveInt(environment[HISTORY_MAX_ENV], historyInitial));
  const historyBackgroundInitial = positiveInt(environment[HISTORY_BACKGROUND_INITIAL_ENV], 4);
  const historyBackgroundMax = Math.max(
    historyBackgroundInitial,
    positiveInt(environment[HISTORY_BACKGROUND_MAX_ENV], historyBackgroundInitial),
  );
  const projectionInitial = positiveInt(environment[PROJECTION_INITIAL_ENV], 2);
  const projectionMax = Math.max(projectionInitial, positiveInt(environment[PROJECTION_MAX_ENV], 4));
  const backgroundInitial = positiveInt(environment[BACKGROUND_INITIAL_ENV], 1);
  const backgroundMax = Math.max(backgroundInitial, positiveInt(environment[BACKGROUND_MAX_ENV], 4));
  const providerIoInitial = positiveInt(environment[PROVIDER_IO_INITIAL_ENV], 4);
  const providerIoMax = Math.max(providerIoInitial, positiveInt(environment[PROVIDER_IO_MAX_ENV], 8));
  const runInitial = positiveInt(environment[RUN_INITIAL_ENV], 12);
  const runMin = Math.max(1, positiveInt(environment[RUN_MIN_ENV], 2));
  const runMax = Math.max(runInitial, positiveInt(environment[RUN_MAX_ENV], runInitial));
  const providerMax = Math.max(1, positiveInt(environment[RUN_PROVIDER_MAX_ENV], Math.min(4, runInitial)));
  const common = { mode, sampleWindowMs, cooldownMs, decreaseFactor };
  return {
    historyIO: {
      ...common,
      minLimit: 4,
      initialLimit: historyInitial,
      maxLimit: historyMax,
      targetLatencyMs: 150,
      maxQueue: 128,
    },
    historyBackgroundIO: {
      ...common,
      minLimit: 1,
      initialLimit: historyBackgroundInitial,
      maxLimit: historyBackgroundMax,
      targetLatencyMs: 250,
      maxQueue: 128,
    },
    projectionCPU: {
      ...common,
      minLimit: 1,
      initialLimit: projectionInitial,
      maxLimit: projectionMax,
      targetLatencyMs: 250,
      maxQueue: 256,
    },
    backgroundAI: {
      ...common,
      minLimit: 1,
      initialLimit: backgroundInitial,
      maxLimit: backgroundMax,
      targetLatencyMs: 30_000,
      maxQueue: 512,
    },
    providerIO: {
      ...common,
      minLimit: 1,
      initialLimit: providerIoInitial,
      maxLimit: providerIoMax,
      targetLatencyMs: 500,
      maxQueue: 512,
    },
    harnessRuns: {
      ...common,
      minLimit: Math.min(runMin, runInitial),
      initialLimit: runInitial,
      maxLimit: runMax,
      targetLatencyMs: 60_000,
      maxQueue: 0,
    },
    harnessProvider: {
      ...common,
      minLimit: 1,
      initialLimit: Math.min(providerMax, runInitial),
      maxLimit: providerMax,
      targetLatencyMs: 60_000,
      maxQueue: 0,
    },
  };
}

const budgetOptions = buildBudgetOptions();
const budgets = new Map(
  Object.entries(budgetOptions)
    .filter(([name]) => name !== 'harnessProvider')
    .map(([name, options]) => [
    name,
    createAdaptiveConcurrencyBudget({ name, ...options }),
    ]),
);
const providerBudgets = new Map();

let controllerTimer = null;
let controllerStartedAt = null;
let runtimeSignals = {};
let previousEventLoopUtilization = performance.eventLoopUtilization();

function heapMemoryUtilization() {
  const memory = process.memoryUsage();
  if (!Number.isFinite(memory.heapTotal) || memory.heapTotal <= 0) return null;
  return Math.max(0, Math.min(1, memory.heapUsed / memory.heapTotal));
}

function defaultRuntimeSignals() {
  const utilization = performance.eventLoopUtilization(previousEventLoopUtilization);
  previousEventLoopUtilization = performance.eventLoopUtilization();
  return {
    eventLoopUtilization: Number.isFinite(utilization?.utilization) ? utilization.utilization : null,
    memoryUtilization: heapMemoryUtilization(),
    ...runtimeSignals,
  };
}

function snapshot() {
  return {
    mode: modeFromEnvironment(),
    controllerStartedAt,
    budgets: [
      ...[...budgets.values()].map((budget) => budget.snapshot()),
      ...[...providerBudgets.values()].map((budget) => budget.snapshot()),
    ],
  };
}

function registerBudget(name, budget) {
  registerCache(`adaptive.${name}`, {
    kind: 'timing',
    snapshot: () => budget.snapshot(),
  });
}
for (const [name, budget] of budgets) registerBudget(name, budget);
registerCache('adaptiveConcurrency', {
  kind: 'counters',
  snapshot: () => {
    const current = snapshot();
    return {
      mode: current.mode,
      controllerStartedAt: current.controllerStartedAt,
      budgetCount: current.budgets.length,
      active: current.budgets.reduce((sum, budget) => sum + (budget.active || 0), 0),
      queued: current.budgets.reduce((sum, budget) => sum + (budget.queued || 0), 0),
      totalAcquired: current.budgets.reduce((sum, budget) => sum + (budget.totalAcquired || 0), 0),
      totalCompleted: current.budgets.reduce((sum, budget) => sum + (budget.totalCompleted || 0), 0),
    };
  },
});

export function getAdaptiveConcurrencyBudget(name) {
  const budget = budgets.get(String(name || '').trim());
  if (!budget) throw new Error(`Unknown adaptive concurrency budget: ${name}`);
  return budget;
}

export function getAdaptiveHarnessBudget(provider) {
  const normalized = String(provider || 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'unknown';
  const name = `harness:${normalized}`;
  let budget = providerBudgets.get(name);
  if (!budget) {
    budget = createAdaptiveConcurrencyBudget({
      name,
      ...budgetOptions.harnessProvider,
      // Ordinary Codex runs multiplex threads over one account broker. Keep
      // two lanes available so transient failures cannot make the shared
      // process behave like an exclusive per-account lock. The global budget
      // still enforces host pressure, and an explicit max of one is respected.
      ...(normalized === 'codex' ? { minLimit: Math.min(2, budgetOptions.harnessProvider.initialLimit, budgetOptions.harnessProvider.maxLimit) } : {}),
    });
    providerBudgets.set(name, budget);
    registerBudget(name, budget);
  }
  return budget;
}

export function getAdaptiveConcurrencySnapshot() {
  return snapshot();
}

export function setAdaptiveRuntimeSignals(signals = {}) {
  if (!signals || typeof signals !== 'object' || Array.isArray(signals)) return runtimeSignals;
  runtimeSignals = { ...runtimeSignals, ...signals };
  return { ...runtimeSignals };
}

export function tickAdaptiveConcurrency(signals = {}) {
  const mergedSignals = { ...defaultRuntimeSignals(), ...signals };
  return [
    ...[...budgets.values()].map((budget) => budget.tick(mergedSignals)),
    ...[...providerBudgets.values()].map((budget) => budget.tick(mergedSignals)),
  ];
}

export function startAdaptiveConcurrencyController({ readSignals = null, intervalMs = null } = {}) {
  if (controllerTimer) return () => stopAdaptiveConcurrencyController();
  const cadence = Math.max(
    250,
    nonNegativeInt(intervalMs, Math.max(250, nonNegativeInt(process.env[WINDOW_ENV], 5_000))),
  );
  controllerStartedAt = Date.now();
  controllerTimer = setInterval(() => {
    let external = {};
    try {
      external = typeof readSignals === 'function' ? readSignals() || {} : {};
    } catch {
      external = {};
    }
    tickAdaptiveConcurrency(external);
  }, cadence);
  controllerTimer.unref?.();
  return () => stopAdaptiveConcurrencyController();
}

export function stopAdaptiveConcurrencyController() {
  if (controllerTimer) clearInterval(controllerTimer);
  controllerTimer = null;
  controllerStartedAt = null;
}

export function __resetAdaptiveConcurrencyForTest() {
  stopAdaptiveConcurrencyController();
  runtimeSignals = {};
  previousEventLoopUtilization = performance.eventLoopUtilization();
  for (const [name, options] of Object.entries(budgetOptions)) {
    if (name === 'harnessProvider') continue;
    const budget = budgets.get(name);
    budget.setLimit(options.initialLimit, { reason: 'test_reset', source: 'reset' });
  }
  for (const budget of providerBudgets.values()) {
    budget.setLimit(budgetOptions.harnessProvider.initialLimit, { reason: 'test_reset', source: 'reset' });
  }
  return snapshot();
}
