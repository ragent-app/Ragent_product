import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
import { createCredentialMutationLedger } from '../lib/provider-runtime/credential-mutation.mjs';
import { createProviderSyncLedger } from '../lib/provider-runtime/sync-ledger.mjs';
import {
  applyAccountSyncRecords,
  createNativeApiProvider,
  deleteNativeProvider,
  listAccountSyncRecords,
  listNativeProviderProfiles,
  updateNativeProvider,
} from '../chat/native-provider-management.mjs';

const configDir = await mkdtemp(join(tmpdir(), 'ragent-native-provider-management-'));
const context = {
  configDir,
  registry: createNativeProviderRegistry({ configDir }),
  secretStore: createSecretStore({ configDir }),
  ledger: createProviderSyncLedger({ configDir }),
  credentialLedger: createCredentialMutationLedger({ configDir }),
  sourceInstanceId: 'inst_management_test',
};

const discoverModels = async (providerId) => ({
  models: [
    {
      id: `gpt-native-fast@${providerId}`,
      label: 'GPT Native Fast · Work Codex',
      capabilities: {
        effort: { supported: true, levels: ['low', 'medium'], default: 'medium', source: 'upstream' },
        serviceTier: { supportsFast: true, values: ['standard', 'fast'], source: 'upstream' },
      },
    },
    { id: `gpt-native-reasoning@${providerId}`, label: 'GPT Native Reasoning · Work Codex' },
    { id: `gpt-native-vision@${providerId}`, label: 'GPT Native Vision · Work Codex' },
  ],
});

const first = await createNativeApiProvider({
  ...context,
  payload: {
    agentType: 'codex',
    displayName: 'Work Codex',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'secret-work',
    protocol: 'chat',
    defaultModel: 'gpt-5',
    discoverModels,
  },
});
const second = await createNativeApiProvider({
  ...context,
  payload: {
    agentType: 'codex',
    displayName: 'Personal Codex',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'secret-personal',
    protocol: 'responses',
    defaultModel: 'gpt-5',
    discoverModels: async () => ({ models: [] }),
  },
});

const qwen = await createNativeApiProvider({
  ...context,
  payload: {
    agentType: 'qwen-code',
    displayName: 'Qwen Gateway',
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'secret-qwen',
    protocol: 'chat',
    defaultModel: 'qwen-model',
    discoverModels: false,
  },
});
assert.equal(qwen.provider.agentType, 'qwen-code');
assert.equal(qwen.provider.protocol, 'openai-chat');
const qwenEdited = await updateNativeProvider({
  ...context,
  providerId: qwen.provider.id,
  payload: { protocol: 'anthropic', baseUrl: 'https://anthropic.example', defaultModel: 'claude-model' },
});
assert.equal(qwenEdited.provider.protocol, 'anthropic-messages');
assert.equal(qwenEdited.provider.modelPolicy.defaultModel, 'claude-model');

const copilotOfficial = await createNativeApiProvider({
  ...context,
  payload: {
    agentType: 'copilot',
    displayName: 'GitHub Copilot',
    baseUrl: '',
    apiKey: 'github-pat',
    protocol: 'github-copilot',
    defaultModel: 'gpt-4o',
    discoverModels: false,
  },
});
assert.equal(copilotOfficial.provider.protocol, 'github-copilot');
assert.equal(copilotOfficial.provider.baseUrl, '');

await assert.rejects(
  createNativeApiProvider({
    ...context,
    payload: {
      agentType: 'copilot',
      displayName: 'Invalid Copilot',
      baseUrl: '',
      apiKey: 'custom-key',
      protocol: 'openai-chat',
      defaultModel: 'custom-model',
      discoverModels: false,
    },
  }),
  /baseUrl must be an http\(s\) URL/,
);

const copilotCustom = await createNativeApiProvider({
  ...context,
  payload: {
    agentType: 'copilot',
    displayName: 'Copilot Gateway',
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'custom-key',
    protocol: 'openai-chat',
    defaultModel: 'custom-model',
    discoverModels: false,
  },
});
assert.equal(copilotCustom.provider.protocol, 'openai-chat');
assert.equal(copilotCustom.provider.baseUrl, 'https://gateway.example/v1');

const hermes = await createNativeApiProvider({
  ...context,
  payload: {
    agentType: 'hermes',
    displayName: 'Hermes Anthropic',
    baseUrl: 'https://anthropic.example/v1',
    apiKey: 'hermes-key',
    protocol: 'anthropic-messages',
    defaultModel: 'claude-sonnet',
    discoverModels: false,
  },
});
assert.equal(hermes.provider.agentType, 'hermes');
assert.equal(hermes.provider.protocol, 'anthropic-messages');

const cline = await createNativeApiProvider({
  ...context,
  payload: {
    agentType: 'cline',
    displayName: 'Cline Gateway',
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'cline-key',
    protocol: 'openai-chat',
    defaultModel: 'cline-model',
    discoverModels: false,
  },
});
assert.equal(cline.provider.agentType, 'cline');
assert.equal(cline.provider.protocol, 'openai-chat');

const kilo = await createNativeApiProvider({
  ...context,
  payload: {
    agentType: 'kilo',
    displayName: 'Kilo Gateway',
    baseUrl: 'https://gateway.example/v1',
    apiKey: 'kilo-key',
    protocol: 'openai-chat',
    defaultModel: 'kilo-model',
    discoverModels: false,
  },
});
assert.equal(kilo.provider.agentType, 'kilo');
assert.equal(kilo.provider.protocol, 'openai-chat');

const claudeSetupToken = await createNativeApiProvider({
  ...context,
  payload: {
    agentType: 'claude',
    authType: 'oauth-token',
    displayName: 'Claude Setup Token',
    oauthToken: 'claude-setup-token-test',
    defaultModel: 'claude-sonnet',
  },
});
assert.equal(claudeSetupToken.provider.agentType, 'claude');
assert.equal(claudeSetupToken.authProfile.authType, 'oauth-token');
assert.deepEqual(
  await context.secretStore.resolveSecret(claudeSetupToken.authProfile.storageRef),
  { ok: true, authType: 'oauth-token', token: 'claude-setup-token-test' },
);
assert.equal((await listAccountSyncRecords(context)).some((record) => record.key === claudeSetupToken.provider.id), false);
const claudeSetupUpdated = await updateNativeProvider({
  ...context,
  providerId: claudeSetupToken.provider.id,
  payload: { oauthToken: 'claude-setup-token-rotated', defaultModel: 'claude-opus' },
});
assert.equal(claudeSetupUpdated.authProfile.authType, 'oauth-token');
assert.equal(
  (await context.secretStore.resolveSecret(claudeSetupUpdated.authProfile.storageRef)).token,
  'claude-setup-token-rotated',
);

assert.notEqual(first.provider.id, second.provider.id, 'each add creates an independent provider');
assert.equal(first.provider.protocol, 'openai-chat');
assert.equal(first.authProfile.accountMetadata.credentialVersion, 1);
assert.match(first.authProfile.accountMetadata.accountKey, /^provider:codex:/);
assert.deepEqual(first.provider.modelPolicy, {
  defaultModel: 'gpt-native-fast',
  models: [
    {
      id: 'gpt-native-fast',
      label: 'GPT Native Fast',
      capabilities: {
        effort: { supported: true, levels: ['low', 'medium'], default: 'medium', source: 'upstream' },
        serviceTier: { supportsFast: true, values: ['standard', 'fast'], source: 'upstream' },
      },
    },
    { id: 'gpt-native-reasoning', label: 'GPT Native Reasoning' },
    { id: 'gpt-native-vision', label: 'GPT Native Vision' },
  ],
});
assert.equal(second.provider.protocol, 'openai-responses');
let profiles = await listNativeProviderProfiles(context);
assert.deepEqual(profiles.map((profile) => profile.displayName), [
  'Work Codex', 'Personal Codex', 'Qwen Gateway', 'GitHub Copilot', 'Copilot Gateway', 'Hermes Anthropic', 'Cline Gateway', 'Kilo Gateway', 'Claude Setup Token',
]);
assert.deepEqual(profiles.map((profile) => profile.modelCount), [3, 0, 0, 0, 0, 0, 0, 0, 0]);
assert.ok(profiles.every((profile) => profile.credentialOk));
assert.ok(profiles.every((profile) => profile.syncId && typeof profile.enabled === 'boolean'), 'management projection exposes stable sync identity and enabled state');
assert.ok(profiles.every((profile) => !('apiKey' in profile)), 'list projection must not expose API keys');

const updated = await updateNativeProvider({
  ...context,
  providerId: first.provider.id,
  payload: {
    displayName: 'Work Codex Updated',
    baseUrl: 'https://gateway.example/v1',
    protocol: 'responses',
    defaultModel: 'gpt-native-reasoning',
    apiKey: '',
  },
});
assert.equal(updated.provider.displayName, 'Work Codex Updated');
assert.equal(updated.provider.baseUrl, 'https://gateway.example/v1');
assert.equal(updated.provider.protocol, 'openai-responses');
assert.equal(updated.provider.modelPolicy.defaultModel, 'gpt-native-reasoning');
assert.equal(updated.provider.modelPolicy.models.length, 3, 'editing should preserve discovered model choices');
assert.equal((await context.secretStore.resolveSecret(first.authProfile.storageRef)).apiKey, 'secret-work', 'blank edit key keeps the existing credential');
assert.equal(
  (await context.credentialLedger.getRecord(first.authProfile.accountMetadata.accountKey)).credentialVersion,
  1,
  'editing provider metadata without a new key must not rotate the credential',
);

const rotated = await updateNativeProvider({
  ...context,
  providerId: first.provider.id,
  payload: { apiKey: 'secret-work-rotated' },
});
assert.equal(
  (await context.secretStore.resolveSecret(rotated.authProfile.storageRef)).apiKey,
  'secret-work-rotated',
);
assert.equal(
  (await context.credentialLedger.getRecord(rotated.authProfile.accountMetadata.accountKey)).credentialVersion,
  2,
  'a new API key must advance the credential chain',
);

const originalUpsertAuthProfile = context.registry.upsertAuthProfile;
context.registry.upsertAuthProfile = async (profile) => {
  if (profile?.accountMetadata?.credentialVersion === 3) {
    return { ok: false, errors: ['synthetic metadata failure'] };
  }
  return originalUpsertAuthProfile(profile);
};
await assert.rejects(
  updateNativeProvider({
    ...context,
    providerId: first.provider.id,
    payload: { apiKey: 'secret-work-should-rollback' },
  }),
  /synthetic metadata failure/,
);
context.registry.upsertAuthProfile = originalUpsertAuthProfile;
assert.equal(
  (await context.secretStore.resolveSecret(rotated.authProfile.storageRef)).apiKey,
  'secret-work-rotated',
  'metadata failure must roll back the SecretStore mutation',
);
assert.equal(
  (await context.credentialLedger.getRecord(rotated.authProfile.accountMetadata.accountKey)).credentialVersion,
  2,
  'metadata failure must not advance the credential ledger',
);

assert.deepEqual(
  await deleteNativeProvider({ ...context, providerId: first.provider.id }),
  { ok: true },
);
profiles = await listNativeProviderProfiles(context);
assert.deepEqual(profiles.map((profile) => profile.displayName), [
  'Personal Codex', 'Qwen Gateway', 'GitHub Copilot', 'Copilot Gateway', 'Hermes Anthropic',
  'Cline Gateway', 'Kilo Gateway', 'Claude Setup Token',
]);
assert.equal(await context.secretStore.resolveSecret(first.authProfile.storageRef).then((result) => result.ok), false);
const deletedCredential = await context.credentialLedger.getRecord(first.authProfile.accountMetadata.accountKey);
assert.ok(deletedCredential.deletedAt, 'provider deletion must leave a credential tombstone');
assert.ok(
  (await listAccountSyncRecords(context)).some((record) => record.scope === 'provider-credential' && record.deletedAt),
  'credential tombstones must be included in encrypted account sync snapshots',
);

// Official native OAuth and Claude setup-token credentials are deliberately
// machine-local. They must be omitted from outgoing peer snapshots and
// ignored if an older peer still sends a full provider/credential payload.
const localOAuthAuth = await context.registry.upsertAuthProfile({
  id: 'auth-local-codex-oauth',
  agentType: 'codex',
  authType: 'oauth',
  displayName: 'Local Codex OAuth',
  storageType: 'secret-store',
  storageRef: 'secret-local-codex-oauth',
  accountMetadata: { accountId: 'local-account' },
});
const localOAuthProvider = await context.registry.upsertProviderProfile({
  id: 'local-codex-oauth',
  agentType: 'codex',
  protocol: 'openai-responses',
  displayName: 'Local Codex OAuth',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  authProfileId: localOAuthAuth.profile.id,
  modelPolicy: { defaultModel: 'gpt-5.5' },
});
await context.secretStore.writeSecret('secret-local-codex-oauth', {
  authType: 'oauth',
  tokens: { access_token: 'local-at', refresh_token: 'local-rt', account_id: 'local-account' },
});
const localAgyAuth = await context.registry.upsertAuthProfile({
  id: 'auth-local-agy-oauth',
  agentType: 'agy',
  authType: 'oauth',
  displayName: 'Local AgY OAuth',
  storageType: 'secret-store',
  storageRef: 'secret-local-agy-oauth',
  accountMetadata: { accountId: 'local-agy-account' },
});
const localAgyProvider = await context.registry.upsertProviderProfile({
  id: 'local-agy-oauth',
  agentType: 'agy',
  protocol: 'agy',
  displayName: 'Local AgY OAuth',
  baseUrl: '',
  authProfileId: localAgyAuth.profile.id,
  modelPolicy: { defaultModel: 'gemini-3.7-flash' },
});
await context.secretStore.writeSecret('secret-local-agy-oauth', {
  authType: 'oauth',
  tokens: { tokenFile: 'local-agy-token' },
});
const outgoing = await listAccountSyncRecords(context);
assert.equal(outgoing.some((record) => record.key === localOAuthProvider.profile.id), false);
assert.equal(outgoing.some((record) => record.key === 'account:codex:local-account'), false);
assert.equal(outgoing.some((record) => record.key === localAgyProvider.profile.id), false);
assert.equal(outgoing.some((record) => record.key === 'account:agy:local-agy-account'), false);
const imported = await applyAccountSyncRecords({
  ...context,
  incoming: [
    {
      scope: 'provider',
      key: 'remote-codex-oauth',
      version: { updatedAt: new Date().toISOString(), counter: 99, writerId: 'remote' },
      provider: { ...localOAuthProvider.profile, id: 'remote-codex-oauth' },
      auth: { ...localOAuthAuth.profile, id: 'auth-remote-codex-oauth', storageRef: 'secret-remote-codex-oauth' },
      secret: { authType: 'oauth', tokens: { access_token: 'remote-at', refresh_token: 'remote-rt' } },
    },
    {
      scope: 'provider',
      key: 'remote-agy-oauth',
      version: { updatedAt: new Date().toISOString(), counter: 100, writerId: 'remote' },
      provider: { ...localAgyProvider.profile, id: 'remote-agy-oauth' },
      auth: { ...localAgyAuth.profile, id: 'auth-remote-agy-oauth', storageRef: 'secret-remote-agy-oauth' },
      secret: { authType: 'oauth', tokens: { tokenFile: 'remote-agy-token' } },
    },
  ],
});
assert.equal(imported.machineLocalIgnored, 2);
assert.equal((await context.secretStore.resolveSecret('secret-remote-codex-oauth')).ok, false);
assert.equal((await context.secretStore.resolveSecret('secret-remote-agy-oauth')).ok, false);

console.log('test-native-provider-management: multiple profiles and secret isolation OK');
