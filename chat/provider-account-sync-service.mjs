// Background convergence for account-owned provider/Agent metadata.
//
// Credentials remain local to each machine for machine-local OAuth (Codex and
// Claude setup-token).  This worker only asks the existing peer-sync client to
// publish metadata and pull encrypted, synchronizable records.  It is a
// convergence loop, not a remote execution path.

import { CONFIG_DIR } from '../lib/config.mjs';
import {
  createCredentialMutationLedger,
  createNativeProviderRegistry,
  createProviderSyncLedger,
  createSecretStore,
  syncAccountSyncFromAccountPeers,
} from '../lib/provider-runtime/index.mjs';

const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_INTERVAL_MS = 60 * 1_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 30 * 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30 * 60 * 1_000;

let schedulerTimer = null;
let schedulerStarted = false;
let consecutiveFailures = 0;

function readDelayEnv(name, fallback, { min = 0, max = 24 * 60 * 60 * 1_000 } = {}) {
  const value = Number.parseInt(String(process.env[name] || '').trim(), 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function buildSyncContext() {
  return {
    registry: createNativeProviderRegistry({ configDir: CONFIG_DIR }),
    secretStore: createSecretStore({ configDir: CONFIG_DIR }),
    ledger: createProviderSyncLedger({ configDir: CONFIG_DIR }),
    credentialLedger: createCredentialMutationLedger({ configDir: CONFIG_DIR }),
  };
}

function schedule(delayMs) {
  if (!schedulerStarted) return;
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = setTimeout(() => {
    schedulerTimer = null;
    void runSyncCycle();
  }, Math.max(0, delayMs));
  schedulerTimer.unref?.();
}

function nextRetryDelay() {
  const base = readDelayEnv('AGENTOC_PROVIDER_SYNC_RETRY_BASE_DELAY_MS', DEFAULT_RETRY_BASE_DELAY_MS, {
    min: 1_000,
    max: DEFAULT_RETRY_MAX_DELAY_MS,
  });
  const max = readDelayEnv('AGENTOC_PROVIDER_SYNC_RETRY_MAX_DELAY_MS', DEFAULT_RETRY_MAX_DELAY_MS, {
    min: base,
    max: 24 * 60 * 60 * 1_000,
  });
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 10);
  return Math.min(max, base * (2 ** exponent));
}

async function runSyncCycle() {
  if (!schedulerStarted) return;
  try {
    const result = await syncAccountSyncFromAccountPeers(buildSyncContext());
    const failedPeers = Array.isArray(result?.peers)
      ? result.peers.filter((peer) => peer?.ok === false).length
      : 0;
    if (failedPeers > 0) {
      consecutiveFailures += 1;
      // Do not include peer errors: an upstream response must never become a
      // control-plane log sink for untrusted or credential-shaped text.
      console.warn(`[provider-sync] ${failedPeers} peer pull(s) failed; retry scheduled`);
      schedule(nextRetryDelay());
      return;
    }
    consecutiveFailures = 0;
    schedule(readDelayEnv('AGENTOC_PROVIDER_SYNC_INTERVAL_MS', DEFAULT_INTERVAL_MS, {
      min: 60_000,
      max: 24 * 60 * 60 * 1_000,
    }));
  } catch (error) {
    consecutiveFailures += 1;
    console.warn(`[provider-sync] cycle failed (${error?.code || 'unavailable'}); retry scheduled`);
    schedule(nextRetryDelay());
  }
}

export function startProviderAccountSync() {
  if (schedulerStarted) return { started: false, reason: 'already-running' };
  schedulerStarted = true;
  consecutiveFailures = 0;
  schedule(readDelayEnv('AGENTOC_PROVIDER_SYNC_INITIAL_DELAY_MS', DEFAULT_INITIAL_DELAY_MS, {
    min: 0,
    max: 5 * 60 * 1_000,
  }));
  return { started: true };
}

export function stopProviderAccountSync() {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  schedulerStarted = false;
  consecutiveFailures = 0;
  void import('../lib/provider-runtime/peer-transport.mjs').then(({ stopProviderPeerSessions }) => stopProviderPeerSessions());
}
