import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('temporary runtime catalog reports only runnable public tools and safe status', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ragent-temporary-runtimes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createTemporaryRuntimeCatalog } = await import('../lib/temporary-runtime-catalog.mjs');
  const providers = [
    { id: 'private-provider-id', agentType: 'claude', protocol: 'anthropic-messages',
      authProfileId: 'private-auth-id', baseUrl: 'https://private.example.test', enabled: true, status: 'ready',
      modelPolicy: { defaultModel: 'claude-sonnet' } },
  ];
  const auth = [{ id: 'private-auth-id', agentType: 'claude', authType: 'api-key',
    storageRef: 'private-secret-ref', displayName: 'Private auth' }];
  const registry = {
    listProviderProfiles: async () => providers,
    listAuthProfiles: async () => auth,
    getProviderProfile: async id => providers.find(profile => profile.id === id) || null,
    getAuthProfile: async id => auth.find(profile => profile.id === id) || null,
  };
  let credentialAvailable = true;
  const secretStore = { describeSecret: async () => credentialAvailable
    ? ({ ok: true, authType: 'api-key', fingerprint: 'secret-fingerprint' })
    : ({ ok: false, reason: 'not-found' }) };
  const tools = [
    { id: 'claude-bidi', name: 'Claude Code', runtimeFamily: 'claude-stream-json-bidi' },
    { id: 'codex', name: 'CodeX', runtimeFamily: 'codex-app-server-json' },
    { id: 'claude', name: 'Hidden compatibility tool', runtimeFamily: 'claude-stream-json', internalFallback: true },
  ];
  const rows = await createTemporaryRuntimeCatalog(tools, { configDir: root, registry, secretStore });
  assert.deepEqual(rows, [
    { id: 'claude-bidi', name: 'Claude Code', ready: true, status: 'ready' },
    { id: 'codex', name: 'CodeX', ready: false, status: 'provider-not-configured' },
  ]);
  const serialized = JSON.stringify(rows);
  for (const privateValue of ['private-provider-id', 'private-auth-id', 'private.example.test',
    'private-secret-ref', 'secret-fingerprint']) assert.equal(serialized.includes(privateValue), false);

  providers[0].enabled = false;
  const disabled = await createTemporaryRuntimeCatalog(tools.slice(0, 1), { configDir: root, registry, secretStore });
  assert.equal(disabled[0].ready, false);
  assert.equal(disabled[0].status, 'provider-disabled');

  providers[0].enabled = true;
  credentialAvailable = false;
  const missingCredential = await createTemporaryRuntimeCatalog(tools.slice(0, 1), { configDir: root, registry, secretStore });
  assert.equal(missingCredential[0].ready, false);
  assert.equal(missingCredential[0].status, 'credential-missing');
});
