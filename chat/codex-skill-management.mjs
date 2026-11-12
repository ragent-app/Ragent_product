import { dirname, isAbsolute, join } from 'node:path';
import { CONFIG_DIR, CODEX_MANAGED_HOME_DIR } from '../lib/config.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { nativeCodexAccountId, nativeProviderHomeRoot, resolveCodexAccountHomeRoot } from '../lib/provider-runtime/provider-home.mjs';
import { managedCodexMcpAccountBinding } from '../lib/provider-runtime/codex-mcp-config.mjs';
import { codexSkillId, saveCodexSkillPreference } from '../lib/provider-runtime/codex-skill-preferences.mjs';
import { codexAppServerBrokerSocketPath } from './codex-app-server-broker.mjs';
import { requestExistingCodexBroker } from './codex-app-server-client.mjs';

const fail = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });

// Resolve IDs only through a fresh native catalog; client-supplied file paths
// are never accepted. The desired value is written first and takes effect on
// the next provider runtime preparation, which owns generated config.toml.
export async function setCodexSkillPreference({ providerId, cwd, id, enabled,
  configDir = CONFIG_DIR, managedHomeDir = CODEX_MANAGED_HOME_DIR,
  registry = createNativeProviderRegistry({ configDir }), secretStore = createSecretStore({ configDir }),
  requestBroker = requestExistingCodexBroker, savePreference = saveCodexSkillPreference, verifySelection = async () => true } = {}) {
  if (typeof providerId !== 'string' || !providerId.trim() || !/^codex:skill:[a-f0-9]{20}$/.test(id || '')
      || typeof enabled !== 'boolean' || typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw fail('Invalid Skill selection', 'CODEX_SKILL_INVALID', 400);
  }
  const current = async () => {
    const profile = await registry.getProviderProfile(providerId).catch(() => null);
    if (!profile || profile.agentType !== 'codex') throw fail('Codex provider not found', 'CODEX_SKILL_PROVIDER_NOT_FOUND', 404);
    const auth = await registry.getAuthProfile(profile.authProfileId).catch(() => null);
    const secret = auth?.storageRef ? await secretStore.resolveSecret(auth.storageRef).catch(() => null) : null;
    const binding = managedCodexMcpAccountBinding(secret);
    const accountId = secret?.authType === 'oauth' ? nativeCodexAccountId(secret.tokens) : '';
    if (!binding || (secret?.authType === 'oauth' && !accountId)) throw fail('Codex account identity is unavailable', 'CODEX_SKILL_ACCOUNT_UNVERIFIED');
    return { profile, secret, binding, accountId };
  };
  const selected = await current();
  const providerHomeRoot = nativeProviderHomeRoot(dirname(managedHomeDir), 'codex', selected.profile.id);
  const homeRoot = selected.accountId ? await resolveCodexAccountHomeRoot({ configDir, providerHomeRoot,
    providerProfileId: selected.profile.id, accountId: selected.accountId }) : providerHomeRoot;
  const socketPath = codexAppServerBrokerSocketPath(join(homeRoot, 'codex'));
  let catalog;
  try { catalog = await requestBroker(socketPath, 'skills/list', { cwds: [cwd], forceReload: true }, { expectedAccountId: selected.accountId, timeoutMs: 8_000 }); }
  catch { throw fail('Start a Codex task for this account, then retry', 'CODEX_SKILL_BROKER_REQUIRED'); }
  const skills = (Array.isArray(catalog?.data) ? catalog.data : []).flatMap((entry) => Array.isArray(entry?.skills) ? entry.skills : []);
  const matches = skills.filter((skill) => {
    const path = typeof skill?.path === 'string' ? skill.path.trim().slice(0, 2000) : '';
    return isAbsolute(path) && codexSkillId(path) === id;
  });
  if (matches.length !== 1) throw fail('Skill is no longer available; refresh the list', 'CODEX_SKILL_STALE');
  const again = await current();
  if (again.binding !== selected.binding) throw fail('Codex account changed; refresh the list', 'CODEX_SKILL_ACCOUNT_CHANGED');
  if (!await verifySelection()) throw fail('The session account changed; refresh the list', 'CODEX_SKILL_ACCOUNT_CHANGED');
  await savePreference(configDir, selected.profile.id, selected.binding, matches[0].path.trim(), enabled);
  return { id, desiredEnabled: enabled, effectiveEnabled: null, appliesOn: 'next-runtime-refresh' };
}
