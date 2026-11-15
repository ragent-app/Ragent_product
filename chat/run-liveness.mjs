// Provider-neutral Run liveness policy. A detached process being alive is not
// sufficient evidence that it is making progress: a wedged sidecar can keep a
// Session's activeRunId forever. The sidecar already persists a heartbeat, so
// the control plane can request cancellation without guessing from stdout.

export const DEFAULT_RUN_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

function finitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseTimestampMs(value) {
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveRunHeartbeatStaleMs(environment = process.env) {
  return finitePositiveNumber(environment?.RAGENT_RUN_HEARTBEAT_STALE_MS)
    || DEFAULT_RUN_HEARTBEAT_STALE_MS;
}

export function getRunHeartbeatAgeMs(run, nowMs = Date.now()) {
  const now = finitePositiveNumber(nowMs) || Date.now();
  const anchorMs = parseTimestampMs(run?.runnerHeartbeatAt)
    ?? parseTimestampMs(run?.runnerStartedAt)
    ?? parseTimestampMs(run?.startedAt)
    ?? parseTimestampMs(run?.createdAt);
  if (!Number.isFinite(anchorMs)) return null;
  return Math.max(0, now - anchorMs);
}

export function shouldMarkRunStalled(run, {
  nowMs = Date.now(),
  staleAfterMs = DEFAULT_RUN_HEARTBEAT_STALE_MS,
} = {}) {
  if (!run || typeof run !== 'object') return false;
  if (['completed', 'failed', 'cancelled', 'waiting_user'].includes(run.state)) return false;
  if (run.cancelRequested === true || run.stalledAt) return false;
  const threshold = finitePositiveNumber(staleAfterMs) || DEFAULT_RUN_HEARTBEAT_STALE_MS;
  const ageMs = getRunHeartbeatAgeMs(run, nowMs);
  return Number.isFinite(ageMs) && ageMs >= threshold;
}
