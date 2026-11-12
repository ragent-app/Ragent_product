import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { resolveBoundCodexAccountHome } from './codex-account-route.mjs';
import { resolveCodexProfileAccountHome } from './codex-profile-account-home.mjs';

// Keep provider-home identity shared by runtime preparation and control-plane
// discovery. The caller is responsible for selecting the actual root/scope.
export function nativeProviderHomeKey(agentType, providerProfileId) {
  return createHash('sha256').update(`${agentType}:${providerProfileId}`).digest('hex').slice(0, 32);
}

export function nativeProviderHomeRoot(providerHomesRoot, agentType, providerProfileId) {
  return join(providerHomesRoot, 'by-provider', nativeProviderHomeKey(agentType, providerProfileId));
}

export function nativeCodexAccountId(tokens) {
  for (const key of ['account_id', 'accountId', 'account_uuid', 'accountUuid', 'user_id', 'userId']) {
    if (typeof tokens?.[key] === 'string' && tokens[key].trim()) return tokens[key].trim();
  }
  return '';
}

// Preserve the existing home for its original account; subsequent accounts
// get distinct homes, brokers, thread stores and native MCP credential files.
export async function resolveCodexAccountHomeRoot({ configDir, providerHomeRoot, providerProfileId, accountId, initialize = false, route = true }) {
  const account = typeof accountId === 'string' ? accountId.trim() : '';
  if (!account) return providerHomeRoot;
  const candidate = await resolveCodexProfileAccountHome({ configDir, providerHomeRoot, providerProfileId, accountId: account, initialize });
  if (!route) return candidate;
  // Runtime and control-plane readers follow only a completed, verified
  // migration. Resolving a Run must not claim or migrate a home by itself.
  return resolveBoundCodexAccountHome({ configDir,
    providerHomesRoot: dirname(dirname(providerHomeRoot)), candidateHomeRoot: candidate, accountId: account });
}
