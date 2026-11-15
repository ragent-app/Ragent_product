#!/usr/bin/env node
// Route-level contract coverage for provider-scoped /api/models metadata.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-model-catalog-route-'));
const configDir = join(root, 'config');
process.env.HOME = root;
process.env.RAGENT_CONFIG_DIR = configDir;
delete process.env.RAGENT_INSTANCE_ROOT;
await mkdir(configDir, { recursive: true });
await writeFile(join(configDir, 'auth.json'), JSON.stringify({
  username: 'testowner',
  passwordHash: 'not-a-real-hash',
}), 'utf8');

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  assert.equal(String(url), 'https://relay.example/v1/models');
  assert.equal(options.headers?.Authorization, 'Bearer route-test-key');
  return new Response(JSON.stringify({
    data: [
      { id: 'shared-model', display_name: 'Shared model' },
      { id: 'provider-only', display_name: 'Provider only' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = body;
    },
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

try {
  const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });
  assert.equal((await secretStore.writeSecret('route-test-secret', {
    authType: 'api-key',
    apiKey: 'route-test-key',
  })).ok, true);
  assert.equal((await registry.upsertAuthProfile({
    id: 'route-test-auth',
    agentType: 'codex',
    authType: 'api-key',
    displayName: 'Route test auth',
    storageType: 'secret-store',
    storageRef: 'route-test-secret',
  })).ok, true);
  assert.equal((await registry.upsertProviderProfile({
    id: 'route-test-provider',
    agentType: 'codex',
    protocol: 'openai-responses',
    displayName: 'Route test provider',
    baseUrl: 'https://relay.example/v1',
    authProfileId: 'route-test-auth',
    modelPolicy: { defaultModel: 'shared-model' },
  })).ok, true);

  const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
  const response = makeResponse();
  const handled = await handleControlRoutes({
    req: { method: 'GET', headers: {} },
    res: response,
    parsedUrl: {
      pathname: '/api/models',
      query: { tool: 'codex', provider: 'route-test-provider', refresh: '1' },
    },
    pathname: '/api/models',
    authSession: { role: 'owner' },
    writeJson,
    writeJsonCached: (_req, res, payload) => writeJson(res, 200, payload),
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.ok(Array.isArray(payload.models), 'legacy models field remains present');
  assert.ok(Array.isArray(payload.catalogs), 'provider catalog list is present');
  assert.equal(payload.catalogs.length, 1);
  assert.equal(payload.catalogs[0].providerProfileId, 'route-test-provider');
  assert.equal(payload.catalogs[0].status, 'fresh');
  assert.equal(payload.catalog.providerProfileId, 'route-test-provider');
  assert.deepEqual(payload.catalog.models.map((model) => model.id), [
    'shared-model@route-test-provider',
    'provider-only@route-test-provider',
  ]);
  assert.equal(JSON.stringify(payload).includes('route-test-key'), false);
  assert.equal(JSON.stringify(payload).includes('Authorization'), false);

  console.log('test-router-model-catalog-route: provider-scoped /api/models response OK');
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
