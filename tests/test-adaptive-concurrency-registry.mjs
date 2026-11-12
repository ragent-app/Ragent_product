import assert from 'node:assert/strict';
import {
  getAdaptiveConcurrencyBudget,
  getAdaptiveConcurrencySnapshot,
  getAdaptiveHarnessBudget,
} from '../chat/adaptive-concurrency-registry.mjs';
import { collectCacheMetrics } from '../chat/memory-registry.mjs';

const globalBudget = getAdaptiveConcurrencyBudget('harnessRuns');
assert.ok(globalBudget.maxLimit >= globalBudget.currentLimit);
const foregroundHistory = getAdaptiveConcurrencyBudget('historyIO');
const backgroundHistory = getAdaptiveConcurrencyBudget('historyBackgroundIO');
assert.ok(foregroundHistory.snapshot().queueCapacity <= 128);
assert.ok(backgroundHistory.snapshot().queueCapacity <= 128);
const foregroundLease = foregroundHistory.tryAcquire({ priority: 'interactive' });
const backgroundLease = backgroundHistory.tryAcquire({ priority: 'background' });
assert.ok(foregroundLease, 'foreground history lane should admit an interactive read');
assert.ok(backgroundLease, 'background history lane should have independent capacity');
foregroundLease.release({ durationMs: 1 });
backgroundLease.release({ durationMs: 1 });

const codex = getAdaptiveHarnessBudget('Codex');
assert.equal(codex.snapshot().minLimit, Math.min(2, codex.snapshot().initialLimit, codex.snapshot().maxLimit));
codex.setLimit(1, { reason: 'test_failure_backoff' });
assert.equal(codex.currentLimit, codex.snapshot().minLimit, 'Codex keeps the configured minimum during backoff');
codex.setLimit(codex.snapshot().initialLimit, { reason: 'test_restore' });
const first = codex.tryAcquire({ priority: 'interactive' });
const second = codex.tryAcquire({ priority: 'interactive' });
const third = codex.tryAcquire({ priority: 'background' });
const fourth = codex.tryAcquire({ priority: 'background' });
assert.ok(first && second && third && fourth, 'provider budget should expose its bounded slots');
assert.equal(codex.tryAcquire(), null, 'provider budget must reject work above its limit');
first.release({ durationMs: 1 });
second.release({ durationMs: 1 });
third.release({ durationMs: 1 });
fourth.release({ durationMs: 1 });

const snapshot = getAdaptiveConcurrencySnapshot();
assert.ok(snapshot.budgets.some((budget) => budget.name === 'harness:codex'));
assert.ok(snapshot.budgets.some((budget) => budget.name === 'harnessRuns'));
assert.ok(collectCacheMetrics().some((entry) => entry.name === 'adaptive.historyIO'));
assert.ok(collectCacheMetrics().some((entry) => entry.name === 'adaptive.historyBackgroundIO'));
assert.ok(collectCacheMetrics().some((entry) => entry.name === 'adaptiveConcurrency'));

console.log('test-adaptive-concurrency-registry: passed');
