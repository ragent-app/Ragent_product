#!/usr/bin/env node
// Native provider model discovery: /api/models' server-side probe must read
// the API key from the vault, while returning only model metadata.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'ragent-native-models-api-'));
const configDir = join(root, 'config');
process.env.HOME = root;
process.env.RAGENT_CONFIG_DIR = configDir;

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), authorization: options.headers?.Authorization || '' });
  assert.equal(String(url), 'https://relay.example/v1/models');
  assert.equal(options.headers?.Authorization, 'Bearer native-test-key');
  return new Response(JSON.stringify({
    data: [
      { id: 'gpt-native-fast', display_name: 'GPT Native Fast' },
      { id: 'gpt-native-reasoning', display_name: 'GPT Native Reasoning' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

try {
  const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });
  assert.equal((await secretStore.writeSecret('native-relay-secret', {
    authType: 'api-key',
    apiKey: 'native-test-key',
  })).ok, true);
  assert.equal((await registry.upsertAuthProfile({
    id: 'native-relay-auth',
    agentType: 'codex',
    authType: 'api-key',
    displayName: 'Native relay auth',
    storageType: 'secret-store',
    storageRef: 'native-relay-secret',
  })).ok, true);
  assert.equal((await registry.upsertProviderProfile({
    id: 'native-relay',
    agentType: 'codex',
    protocol: 'openai-responses',
    displayName: 'Native relay',
    baseUrl: 'https://relay.example/v1',
    authProfileId: 'native-relay-auth',
    modelPolicy: { defaultModel: 'gpt-native-fast' },
  })).ok, true);

  const { getModelsForTool } = await import('../chat/models.mjs');
  const result = await getModelsForTool('codex');
  assert.deepEqual(result.models.map((model) => model.id), [
    'gpt-native-fast@native-relay',
    'gpt-native-reasoning@native-relay',
  ]);
  assert.deepEqual(result.models.map((model) => model.label), [
    'GPT Native Fast · Native relay',
    'GPT Native Reasoning · Native relay',
  ]);
  assert.equal(result.models[0].capabilities.effort.supported, null, 'standard /models must not imply effort support');
  assert.equal(result.models[0].capabilities.serviceTier.supportsFast, null, 'standard /models must not imply Codex fast support');
  assert.equal(result.models.some((model) => model.serviceTiers?.includes('fast')), false);
  assert.equal(result.models.some((model) => JSON.stringify(model).includes('native-test-key')), false);
  assert.equal(calls.length, 1);
  console.log('test-native-models-api: vault-backed native /models discovery OK');
} finally {
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
}
