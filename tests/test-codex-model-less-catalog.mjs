import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRuntimeConfig } from '../lib/provider-runtime/resolver.mjs';

function fixture(authType) {
  return {
    runRequest: { runId: 'catalog_fixture', agentType: 'codex', providerProfileId: 'official' },
    registry: {
      getProviderProfile: async () => ({ id: 'official', agentType: 'codex', authProfileId: 'auth',
        protocol: 'openai-responses', baseUrl: 'https://example.invalid', modelPolicy: {} }),
      getAuthProfile: async () => ({ id: 'auth', agentType: 'codex', authType, storageRef: 'secret-fixture' }),
    },
    secretStore: { describeSecret: async () => ({ ok: true, fingerprint: 'fixture' }) },
  };
}

test('only internal official catalog discovery may prepare without a model', async () => {
  await assert.rejects(resolveRuntimeConfig(fixture('oauth')), { code: 'model-missing' });
  const discovered = await resolveRuntimeConfig({ ...fixture('oauth'), allowModelLessCodexOAuthCatalog: true });
  assert.equal(discovered.model, '');
  await assert.rejects(resolveRuntimeConfig({ ...fixture('api-key'), allowModelLessCodexOAuthCatalog: true }),
    { code: 'model-missing' });
});
