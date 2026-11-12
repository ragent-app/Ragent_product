import { resolve } from 'node:path';
import { resolveCanonicalCodexAccountHome } from './codex-account-home-registry.mjs';

// Called by the trusted launcher with its prepared home and account identity.
// Never accept source paths from a session request or the parent environment.
export async function resolveCodexRuntimeRolloutSources({ configDir, providerHomesRoot, homeRoot, accountId }) {
  if (!accountId) return [];
  const record = await resolveCanonicalCodexAccountHome({ configDir, providerHomesRoot, candidateHomeRoot: homeRoot, accountId, includeSources: true });
  if (!record) return [];
  const identity = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (identity(record.home) !== identity(homeRoot)) {
    // This run has not been switched to the canonical owner yet. Do not use a
    // different account home's history merely because a registry exists.
    return [];
  }
  return record.sources;
}
