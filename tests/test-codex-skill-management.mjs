import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCodexSkillPreference } from '../chat/codex-skill-management.mjs';
import { managedCodexMcpAccountBinding } from '../lib/provider-runtime/codex-mcp-config.mjs';
import { codexSkillId, listCodexSkillPreferences } from '../lib/provider-runtime/codex-skill-preferences.mjs';
import { resolveCanonicalCodexAccountHome } from '../lib/provider-runtime/codex-account-home-registry.mjs';
import { codexAppServerBrokerSocketPath } from '../chat/codex-app-server-broker.mjs';
import { nativeProviderHomeRoot } from '../lib/provider-runtime/provider-home.mjs';
const root = await mkdtemp(join(tmpdir(), 'ragent-skill-manage-'));
const skill = join(root, 'skills', 'review', 'SKILL.md');
let account = 'account-a';
let calls = 0;
const secret = () => ({ ok: true, authType: 'oauth', tokens: { account_id: account } });
const registry = { getProviderProfile: async () => ({ id: 'profile', agentType: 'codex', authProfileId: 'auth' }), getAuthProfile: async () => ({ storageRef: 'ref' }) };
const secretStore = { resolveSecret: async () => secret() };
const requestBroker = async (_path, method, _params, options) => {
  calls++;
  assert.equal(method, 'skills/list'); assert.equal(options.expectedAccountId, 'account-a');
  return { data: [{ skills: [{ name: 'review', path: skill }] }] };
};
const args = { providerId: 'profile', cwd: root, id: codexSkillId(skill), enabled: false,
  configDir: root, managedHomeDir: join(root, 'homes', 'codex'), registry, secretStore, requestBroker };
try {
  const result = await setCodexSkillPreference(args);
  assert.equal(result.appliesOn, 'next-runtime-refresh');
  assert.equal(result.effectiveEnabled, null, 'saving a preference must not claim the running broker has changed');
  const binding = managedCodexMcpAccountBinding(secret());
  assert.deepEqual(await listCodexSkillPreferences(root, 'profile', binding), [{ path: skill, enabled: false }]);
  const canonicalHome = join(root, 'homes', 'by-provider', 'shared-owner');
  await resolveCanonicalCodexAccountHome({ configDir: root, providerHomesRoot: join(root, 'homes'),
    candidateHomeRoot: canonicalHome, accountId: account, initialize: true });
  const candidateHome = nativeProviderHomeRoot(join(root, 'homes'), 'codex', 'profile');
  await resolveCanonicalCodexAccountHome({ configDir: root, providerHomesRoot: join(root, 'homes'),
    candidateHomeRoot: candidateHome, accountId: account, initialize: true, assertMigrationSafe: async () => ({ retainLegacySource: false }) });
  await setCodexSkillPreference({ ...args, requestBroker: async (socket) => {
    assert.equal(socket, codexAppServerBrokerSocketPath(join(canonicalHome, 'codex')));
    return { data: [{ skills: [{ path: skill }] }] };
  } });
  await assert.rejects(setCodexSkillPreference({ ...args, id: codexSkillId(join(root, 'unlisted')) }), { code: 'CODEX_SKILL_STALE' });
  await assert.rejects(setCodexSkillPreference({ ...args, id: '../../outside' }), { code: 'CODEX_SKILL_INVALID' });
  await assert.rejects(setCodexSkillPreference({ ...args, verifySelection: async () => false }), { code: 'CODEX_SKILL_ACCOUNT_CHANGED' });
  await assert.rejects(setCodexSkillPreference({ ...args, requestBroker: async () => { account = 'account-b'; return { data: [{ skills: [{ path: skill }] }] }; } }), { code: 'CODEX_SKILL_ACCOUNT_CHANGED' });
  assert.equal(calls, 3);
  console.log('Codex Skill management tests passed');
} finally { await rm(root, { recursive: true, force: true }); }
