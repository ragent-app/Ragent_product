import { getRun, isTerminalRunState, updateRun } from './runs.mjs';
import { buildPrivilegedShimTerminalUpdate } from './privileged-approval.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The shim returns a pending acknowledgement to its provider. Keep the Run
// unit alive after the provider exits until the owner decides, the deadline
// expires, or the Run is cancelled. A live unit is required by the privileged
// executor and terminalizing first would close the approval before review.
export async function waitForPrivilegedShimResolution(runId, {
  getRunImpl = getRun, updateRunImpl = updateRun, sleepImpl = sleep,
  now = Date.now, pollIntervalMs = 250,
} = {}) {
  if (typeof runId !== 'string' || !runId.trim()) return null;
  const interval = Math.max(25, Number(pollIntervalMs) || 250);
  while (true) {
    let current;
    try { current = await getRunImpl(runId); }
    catch { await sleepImpl(interval); continue; }
    if (!current) return null;
    const pending = current.privilegedShimPending;
    if (!pending?.batchId || current.privilegedShimResult?.batchId === pending.batchId) return current;
    const deadline = Date.parse(pending.expiresAt || '');
    const cancelled = current.cancelRequested === true || isTerminalRunState(current.state);
    if (cancelled || !Number.isFinite(deadline) || now() >= deadline) {
      const updater = buildPrivilegedShimTerminalUpdate(current, pending, {
        status: cancelled ? 'cancelled' : 'timeout',
        ...(!Number.isFinite(deadline) ? { reason: 'privileged approval deadline is unavailable' } : {}),
      });
      if (!updater) return current;
      try { return await updateRunImpl(runId, updater); }
      catch { await sleepImpl(interval); continue; }
    }
    if (current.state === 'running') {
      try {
        await updateRunImpl(runId, (latest) => (
          latest?.state === 'running' && latest.cancelRequested !== true
          && latest.privilegedShimPending?.batchId === pending.batchId
            ? { ...latest, state: 'waiting_user' } : latest
        ));
      } catch { await sleepImpl(interval); continue; }
    }
    await sleepImpl(interval);
  }
}
