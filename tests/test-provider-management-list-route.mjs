import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ragent-provider-list-'));
process.env.HOME = root;
process.env.RAGENT_CONFIG_DIR = join(root, 'config');
process.env.RAGENT_HARNESS_ROOT = join(root, 'harnesses');
delete process.env.RAGENT_INSTANCE_ROOT;

try {
  const { createNativeProviderRegistry, createSecretStore } = await import('../lib/provider-runtime/index.mjs');
  const registry = createNativeProviderRegistry({ configDir: process.env.RAGENT_CONFIG_DIR });
  const secretStore = createSecretStore({ configDir: process.env.RAGENT_CONFIG_DIR });
  const { createNativeApiProvider } = await import('../chat/native-provider-management.mjs');
  const created = await createNativeApiProvider({ configDir: process.env.RAGENT_CONFIG_DIR, registry, secretStore,
    sourceInstanceId: 'inst_fixture', payload: { agentType: 'claude', displayName: 'Test Claude',
      baseUrl: 'https://example.invalid', apiKey: 'fixture-only', discoverModels: false } });
  const id = created.provider.id;
  const { handleControlRoutes } = await import('../chat/router-control-routes.mjs');
  async function request(method, path, query = {}) {
    const res = { setHeader() {} };
    let status, body;
    const handled = await handleControlRoutes({ req: { method, headers: {} }, res, pathname: path,
      parsedUrl: { query }, authSession: { role: 'owner' },
      writeJson: (_res, code, data) => { status = code; body = data; } });
    assert.equal(handled, true);
    assert.equal(status, 200);
    return body;
  }
  const managed = await request('GET', '/api/native-providers');
  assert.ok(managed.providers.some((p) => p.id === id), 'management must show saved profiles even without an installed harness');
  const runnable = await request('GET', '/api/native-providers', { tool: 'claude' });
  assert.ok(!runnable.providers.some((p) => p.id === id), 'runtime picker must still exclude profiles with no installed harness');
  assert.equal((await request('DELETE', `/api/native-providers/${id}`)).ok, true);
  assert.ok(!(await request('GET', '/api/native-providers')).providers.some((p) => p.id === id));
  console.log('provider management list and deletion passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
