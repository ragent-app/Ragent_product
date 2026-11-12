import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireNativeOAuthLock } from '../lib/provider-runtime/oauth-lock.mjs';
import { codexAppServerBrokerLockPath } from './codex-app-server-broker.mjs';
import { retireCodexBrokerAndAcquireHome } from './codex-broker-retirement.mjs';

// Plugin feature flags are read when the native app server starts. Never stop
// an active broker: the retirement protocol checks its account, active turns,
// pending approvals, clients and OAuth requests while the creation lock fences
// new starts. An unsuccessful attempt remains an explicit pending preference.
export async function retireIdleCodexBrokerForPluginChange({ homeRoot, accountId }) {
  const codexHome = join(homeRoot, 'codex');
  try { await stat(codexHome); } catch (error) { if (error?.code === 'ENOENT') return 'not-running'; throw error; }
  const creationLock = await acquireNativeOAuthLock(codexAppServerBrokerLockPath(codexHome), { waitMs: 2_000 });
  try {
    const homeLock = await retireCodexBrokerAndAcquireHome({ homeRoot, accountId, timeoutMs: 2_000 });
    try { return 'retired'; } finally { await homeLock.release(); }
  } finally { await creationLock.release(); }
}
