import { resolveCanonicalCodexAccountHome } from './codex-account-home-registry.mjs';
import { withCodexAccountHomeHandoff } from './codex-account-handoff.mjs';

// The supplied starter must return only after the canonical broker owns its
// OAuth lock. The reconciliation callback must reject any credential state it
// cannot safely reconcile; it may return retainLegacySource:false when the old
// home never contained history. The caller must derive and verify the candidate
// home for this account before calling. No alias is published on failure.
export async function startCoordinatedCodexAccount({
  configDir, providerHomesRoot, candidateHomeRoot, accountId,
  reconcileCredentials, startCanonical,
  handoff = withCodexAccountHomeHandoff,
}) {
  if (typeof reconcileCredentials !== 'function' || typeof startCanonical !== 'function') {
    throw Object.assign(new Error('Codex account coordination requires reconciliation and startup'), { code: 'CODEX_COORDINATION_INVALID' });
  }
  let started = false;
  let result;
  const canonicalHomeRoot = await resolveCanonicalCodexAccountHome({ configDir, providerHomesRoot, candidateHomeRoot, accountId, initialize: true,
    assertMigrationSafe: async ({ canonicalHomeRoot: canonical, legacyHomeRoot }) => {
      let retainLegacySource = true;
      await handoff({ accountId, canonicalHomeRoot: canonical, legacyHomeRoot,
        reconcileCredentials: async (context) => {
          const outcome = await reconcileCredentials(context);
          retainLegacySource = outcome?.retainLegacySource !== false;
        },
        startCanonical: async (context) => {
          result = await startCanonical(context);
          started = true;
        },
      });
      if (!started) throw Object.assign(new Error('Codex handoff did not start the canonical broker'), { code: 'CODEX_COORDINATION_INCOMPLETE' });
      return { retainLegacySource };
    },
  });
  if (!started) result = await startCanonical({ canonicalHomeRoot });
  return { canonicalHomeRoot, result };
}
