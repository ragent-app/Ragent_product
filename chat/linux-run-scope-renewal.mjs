// Best-effort renewal of existing root registrations. A fresh grant cannot
// create a registration or revive an expired/revoked one at the broker.
import { listRunIndexEntries } from './runs.mjs';
import { assertRunLaunchBoundary } from './run-execution-boundary.mjs';
import { matchesLinuxRunControlBinding } from './linux-run-control-binding.mjs';
import { issueLinuxRunScopeGrant } from './linux-run-scope-issuance.mjs';
import { renewLinuxRunScope } from './linux-run-scope-lifecycle.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const RENEW_INTERVAL_MS = 5 * 60 * 1000;

export async function issueLinuxRunScopeRenewal(runId, launchAttempt, {
  readBoundary = assertRunLaunchBoundary, matchesBinding = matchesLinuxRunControlBinding,
  issueGrant = issueLinuxRunScopeGrant,
} = {}) {
  return issueGrant(runId, launchAttempt, {
    readBoundary: async (id) => {
      const { run, manifest } = await readBoundary(id);
      if (run?.id !== runId || run.runnerLaunchMode !== 'runner-lifecycle' ||
          run.runnerLaunchAttempt !== launchAttempt || run.cancelRequested === true || TERMINAL.has(run.state) ||
          !await matchesBinding({ run, manifest, launchAttempt })) throw new Error('Run is not eligible for scope renewal');
      return { run, manifest };
    },
    // Initial issuance alone may create the immutable binding.
    persistBinding: async () => {},
  });
}

// One instance belongs to the control service; success is cached only in
// memory so a restarted service immediately retries all candidate Runs.
export function createLinuxRunScopeRenewalSweep({ listEntries = listRunIndexEntries,
  readBoundary = assertRunLaunchBoundary, issueRenewal = issueLinuxRunScopeRenewal,
  renew = renewLinuxRunScope, now = Date.now, concurrency = 8 } = {}) {
  const lastSuccess = new Map();
  return async function sweep({ scanAll = false } = {}) {
    const entries = await listEntries();
    const candidates = entries.filter((entry) => scanAll ||
      (entry.runnerLaunchMode === 'runner-lifecycle' && !entry.cancelRequested && !TERMINAL.has(entry.state)));
    const stillPresent = new Set(entries.map((entry) => entry.id));
    for (const key of lastSuccess.keys()) if (!stillPresent.has(key.split(':')[0])) lastSuccess.delete(key);
    let next = 0, attempted = 0, renewed = 0;
    async function worker() {
      while (next < candidates.length) {
        const entry = candidates[next++];
        try {
          const { run } = await readBoundary(entry.id);
          const attempt = run?.runnerLaunchAttempt;
          if (run?.runnerLaunchMode !== 'runner-lifecycle' || run.cancelRequested || TERMINAL.has(run.state) ||
              !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 10000) continue;
          const key = `${run.id}:${attempt}`;
          if (now() - (lastSuccess.get(key) ?? -Infinity) < RENEW_INTERVAL_MS) continue;
          attempted++;
          const grant = await issueRenewal(run.id, attempt);
          if (!grant) continue;
          if ((await renew(run, grant)).state === 'renewed') {
            lastSuccess.set(key, now());
            renewed++;
          }
        } catch { /* No privilege is granted on an unavailable or stale Run. */ }
      }
    }
    const workers = Math.max(1, Math.min(32, Math.floor(concurrency) || 1, candidates.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return { attempted, renewed };
  };
}
