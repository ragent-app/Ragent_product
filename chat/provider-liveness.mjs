export const PROVIDER_LIVENESS_SCHEMA_VERSION = 1;
export const DEFAULT_PROVIDER_HEARTBEAT_INTERVAL_MS = 15 * 1000;
export const DEFAULT_PROVIDER_OUTPUT_IDLE_DIAGNOSTIC_MS = 90 * 1000;

const AGY_RUNTIME_FAMILIES = new Set(['agy-json', 'agy-stream-json']);

function finitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function isoFromMs(value, fallbackMs) {
  const ms = finitePositiveNumber(value) || fallbackMs;
  return new Date(ms).toISOString();
}

export function isAgyRuntimeFamily(runtimeFamily) {
  return AGY_RUNTIME_FAMILIES.has(String(runtimeFamily || '').trim().toLowerCase());
}

export function resolveProviderHeartbeatIntervalMs(environment = process.env) {
  return finitePositiveNumber(environment?.RAGENT_PROVIDER_HEARTBEAT_INTERVAL_MS)
    || DEFAULT_PROVIDER_HEARTBEAT_INTERVAL_MS;
}

export function resolveProviderOutputIdleDiagnosticMs(environment = process.env) {
  return finitePositiveNumber(environment?.RAGENT_PROVIDER_OUTPUT_IDLE_DIAGNOSTIC_MS)
    || DEFAULT_PROVIDER_OUTPUT_IDLE_DIAGNOSTIC_MS;
}

export function buildProviderLivenessSnapshot({
  runtimeFamily,
  nowMs = Date.now(),
  lastOutputAtMs = nowMs,
  heartbeatCount = 0,
  outputIdleDiagnosticMs = DEFAULT_PROVIDER_OUTPUT_IDLE_DIAGNOSTIC_MS,
} = {}) {
  if (!isAgyRuntimeFamily(runtimeFamily)) return null;
  const now = finitePositiveNumber(nowMs) || Date.now();
  const lastOutput = finitePositiveNumber(lastOutputAtMs) || now;
  const outputIdleMs = Math.max(0, now - lastOutput);
  const count = Number.isInteger(heartbeatCount) && heartbeatCount > 0 ? heartbeatCount : 1;
  const diagnosticMs = finitePositiveNumber(outputIdleDiagnosticMs)
    || DEFAULT_PROVIDER_OUTPUT_IDLE_DIAGNOSTIC_MS;
  return {
    schemaVersion: PROVIDER_LIVENESS_SCHEMA_VERSION,
    state: 'alive',
    phase: outputIdleMs >= diagnosticMs
      ? 'awaiting_provider_output'
      : 'provider_output_recent',
    heartbeatAt: new Date(now).toISOString(),
    lastOutputAt: isoFromMs(lastOutput, now),
    outputIdleMs,
    heartbeatCount: count,
  };
}

export function normalizeProviderLiveness(value) {
  if (!value || typeof value !== 'object') return null;
  const heartbeatAt = typeof value.heartbeatAt === 'string' ? value.heartbeatAt.trim() : '';
  const lastOutputAt = typeof value.lastOutputAt === 'string' ? value.lastOutputAt.trim() : '';
  if (
    !heartbeatAt
    || !lastOutputAt
    || !Number.isFinite(Date.parse(heartbeatAt))
    || !Number.isFinite(Date.parse(lastOutputAt))
  ) return null;
  const outputIdleMs = finiteNonNegativeNumber(value.outputIdleMs);
  const heartbeatCount = Number.isInteger(value.heartbeatCount) && value.heartbeatCount > 0
    ? value.heartbeatCount
    : 1;
  return {
    schemaVersion: Number.isInteger(value.schemaVersion) ? value.schemaVersion : PROVIDER_LIVENESS_SCHEMA_VERSION,
    state: value.state === 'alive' ? 'alive' : 'unknown',
    phase: value.phase === 'awaiting_provider_output'
      ? 'awaiting_provider_output'
      : 'provider_output_recent',
    heartbeatAt,
    lastOutputAt,
    ...(outputIdleMs !== null ? { outputIdleMs } : {}),
    heartbeatCount,
  };
}
