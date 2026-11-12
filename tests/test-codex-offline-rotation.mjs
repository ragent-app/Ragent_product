import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
const { prepareNativeRunProviderHome } = await import(process.env.RAGENT_TEST_CODEX_PREP_ENTRY
  ? pathToFileURL(process.env.RAGENT_TEST_CODEX_PREP_ENTRY).href
  : '../lib/provider-runtime/run-provider-prepare.mjs');

test('offline Codex owner preserves a proven rotation even with a shorter expiry', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-offline-rotation-'));
  t.after(async () => {
    const part = relative(parent, root);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const configDir = join(root, 'config');
  await mkdir(configDir);
  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });
  await secretStore.writeSecret('credential', { authType: 'oauth', tokens: {
    account_id: 'account-a', access_token: 'old-access', refresh_token: 'old-refresh', expiresAt: 5000,
  } });
  await registry.upsertAuthProfile({ id: 'auth-a', agentType: 'codex', authType: 'oauth', storageType: 'secret-store', storageRef: 'credential' });
  await registry.upsertProviderProfile({ id: 'profile-a', agentType: 'codex', protocol: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex', authProfileId: 'auth-a', modelPolicy: { defaultModel: 'gpt-5.5' } });
  const manifest = { tool: 'codex', options: { providerProfile: 'profile-a', model: 'gpt-5.5' } };
  const options = { configDir, providerHomesRoot: join(root, 'homes') };
  const first = await prepareNativeRunProviderHome('run_rotation_first', manifest, options);
  assert.equal(first.ok, true);
  const authPath = join(first.codexHomeDir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ tokens: {
    account_id: 'account-a', access_token: 'new-access', refresh_token: 'new-refresh', expiresAt: 1000,
  } }));
  const resumed = await prepareNativeRunProviderHome('run_rotation_resumed', manifest, options);
  assert.equal(resumed.ok, true);
  assert.equal((await secretStore.resolveSecret('credential')).tokens.refresh_token, 'new-refresh');
  assert.equal(JSON.parse(await readFile(authPath, 'utf8')).tokens.refresh_token, 'new-refresh');
});
