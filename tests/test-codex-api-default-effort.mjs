import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'ragent-codex-default-effort-'));
const configDir = join(home, 'config');
mkdirSync(configDir, { recursive: true });
process.env.HOME = home;
process.env.RAGENT_CONFIG_DIR = configDir;
const originalFetch = globalThis.fetch;
try {
  const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
  const registry = createNativeProviderRegistry({ configDir });
  await createSecretStore({ configDir }).writeSecret('fixture-key', { authType: 'api-key', apiKey: 'fixture-only' });
  await registry.upsertAuthProfile({ id: 'fixture-auth', agentType: 'codex', authType: 'api-key', displayName: 'Fixture', storageType: 'secret-store', storageRef: 'fixture-key' });
  await registry.upsertProviderProfile({ id: 'fixture-provider', agentType: 'codex', protocol: 'openai-responses', displayName: 'Fixture', baseUrl: 'https://example.test/v1', authProfileId: 'fixture-auth', modelPolicy: { defaultModel: 'gpt-5.6-luna' } });
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: 'gpt-5.6-luna' }, { id: 'generic' },
    { id: 'declared', effortLevels: ['low', 'high'], defaultEffort: 'high' },
    { id: 'disabled', supports_reasoning: false },
  ] }), { status: 200 });
  const { getModelsForTool } = await import('../chat/models.mjs');
  const result = await getModelsForTool('codex', { providerProfile: 'fixture-provider' });
  const get = id => result.models.find(model => model.id === `${id}@fixture-provider`);
  assert.deepEqual(get('gpt-5.6-luna').effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(get('generic').effortLevels, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(get('declared').effortLevels, ['low', 'high']);
  assert.equal(get('declared').defaultEffort, 'high');
  assert.equal(get('disabled').capabilities.effort.supported, false);
  assert.equal(get('disabled').effortLevels, undefined);
  console.log('test-codex-api-default-effort: ok');
} finally { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true }); }
