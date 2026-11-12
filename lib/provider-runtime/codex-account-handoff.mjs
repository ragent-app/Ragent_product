import { isAbsolute, join, resolve } from 'node:path';
import { acquireNativeOAuthLock } from './oauth-lock.mjs';
import { codexAppServerBrokerLockPath } from '../../chat/codex-app-server-broker.mjs';
import { retireCodexBrokerAndAcquireHome } from '../../chat/codex-broker-retirement.mjs';
import { fenceLegacyCodexHome } from './codex-home-fence.mjs';

// The legacy creation and OAuth locks remain held through reconciliation and
// startup of the canonical owner. This prevents an old broker from starting in
// the gap between inspection, credential reconciliation and the handoff.
export async function withCodexAccountHomeHandoff({
  accountId, legacyHomeRoot, canonicalHomeRoot, reconcileCredentials, startCanonical,
  timeoutMs = 15000, pollMs = 200, acquireCreationLock = acquireNativeOAuthLock,
  retireAndAcquireHome = retireCodexBrokerAndAcquireHome,
  installFence = fenceLegacyCodexHome,
}) {
  if (typeof accountId !== 'string' || !accountId.trim()
      || ![legacyHomeRoot, canonicalHomeRoot].every((path) => typeof path === 'string' && isAbsolute(path))
      || typeof reconcileCredentials !== 'function' || typeof startCanonical !== 'function') {
    throw Object.assign(new Error('Codex account handoff inputs are incomplete'), { code: 'CODEX_HANDOFF_INVALID' });
  }
  const legacy = resolve(legacyHomeRoot);
  const canonical = resolve(canonicalHomeRoot);
  if (process.platform === 'win32' ? legacy.toLowerCase() === canonical.toLowerCase() : legacy === canonical) {
    return startCanonical({ canonicalHomeRoot: canonical });
  }
  const creationLock = await acquireCreationLock(codexAppServerBrokerLockPath(join(legacy, 'codex')), { waitMs: timeoutMs });
  let ownership;
  try {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      try {
        ownership = await retireAndAcquireHome({ homeRoot: legacy, accountId, timeoutMs: Math.max(1, deadline - Date.now()) });
        break;
      } catch (error) {
        if (error?.code !== 'CODEX_RETIRE_BUSY' || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(1, Number(pollMs) || 1), deadline - Date.now())));
      }
    }
    await reconcileCredentials({ accountId: accountId.trim(), legacyHomeRoot: legacy, canonicalHomeRoot: canonical });
    await installFence({ accountId: accountId.trim(), legacyHomeRoot: legacy, canonicalHomeRoot: canonical });
    return await startCanonical({ canonicalHomeRoot: canonical });
  } finally {
    try { await ownership?.release(); } finally { await creationLock.release(); }
  }
}
