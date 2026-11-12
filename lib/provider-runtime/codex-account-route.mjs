import { isCodexAccountHomeBound, resolveCanonicalCodexAccountHome } from './codex-account-home-registry.mjs';

// Routing never initiates migration. The registry only exposes a candidate as
// an alias after its old owner has been fenced and handoff has succeeded.
export async function resolveBoundCodexAccountHome({ configDir, providerHomesRoot, candidateHomeRoot, accountId }) {
  if (typeof accountId !== 'string' || !accountId.trim()) return candidateHomeRoot;
  const record = await resolveCanonicalCodexAccountHome({ configDir, providerHomesRoot, candidateHomeRoot,
    accountId, includeSources: true });
  if (!record) return candidateHomeRoot;
  if (isCodexAccountHomeBound(record, candidateHomeRoot)) return record.home;
  throw Object.assign(new Error('Codex account home requires a guarded handoff before use'), { code: 'CODEX_ACCOUNT_HANDOFF_REQUIRED' });
}
