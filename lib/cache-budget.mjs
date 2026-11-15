// Keep read-through caches inside one process-wide budget. Cache misses are
// safe because all registered caches sit in front of durable files.
const DEFAULT_BUDGET_BYTES = 128 * 1024 * 1024;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveCacheBudgetBytes(env = process.env) {
  return positiveInt(env.RAGENT_CACHE_BUDGET_BYTES, DEFAULT_BUDGET_BYTES);
}

export function cacheBudget(name, weight, { env = process.env, minimumBytes = 64 * 1024 } = {}) {
  const budget = resolveCacheBudgetBytes(env);
  const normalizedWeight = Number.isFinite(weight) && weight > 0 ? weight : 1;
  const totalWeight = positiveInt(env.RAGENT_CACHE_BUDGET_WEIGHT_TOTAL, 8);
  return Math.max(minimumBytes, Math.floor((budget * normalizedWeight) / totalWeight));
}

export const DEFAULT_CACHE_BUDGET_BYTES = DEFAULT_BUDGET_BYTES;
