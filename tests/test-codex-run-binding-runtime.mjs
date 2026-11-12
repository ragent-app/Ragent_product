import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';
const { prepareNativeRunProviderHome } = await import(process.env.RAGENT_TEST_CODEX_PREP_ENTRY
  ? pathToFileURL(process.env.RAGENT_TEST_CODEX_PREP_ENTRY).href
  : '../lib/provider-runtime/run-provider-prepare.mjs');
import { codexRunBindingPath, verifyCodexRunBinding } from '../lib/provider-runtime/codex-run-binding.mjs';
import { createHash } from 'node:crypto';
import { resolveCanonicalCodexAccountHome } from '../lib/provider-runtime/codex-account-home-registry.mjs';
import { codexAppServerBrokerSocketPath, codexBrokerAccountDigest } from '../chat/codex-app-server-broker.mjs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

test('native preparation writes distinct account-bound records for concurrent runs', async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'ragent-run-binding-'));
  t.after(async () => {
    const suffix = relative(parent, root);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Unsafe test cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const configDir = join(root, 'config');
  await mkdir(configDir);
  const registry = createNativeProviderRegistry({ configDir });
  const secretStore = createSecretStore({ configDir });
  await secretStore.writeSecret('credential', { authType: 'oauth', tokens: { access_token: 'access', refresh_token: 'refresh', account_id: 'account-a' } });
  await registry.upsertAuthProfile({ id: 'auth-a', agentType: 'codex', authType: 'oauth', storageType: 'secret-store', storageRef: 'credential' });
  await registry.upsertProviderProfile({ id: 'profile-a', agentType: 'codex', protocol: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex', authProfileId: 'auth-a', modelPolicy: { defaultModel: 'gpt-5.5' } });
  const options = { configDir, providerHomesRoot: join(root, 'homes') };
  const manifest = { tool: 'codex', options: { providerProfile: 'profile-a', model: 'gpt-5.5' } };
  const first = await prepareNativeRunProviderHome('run_binding_first', manifest, options);
  const second = await prepareNativeRunProviderHome('run_binding_second', manifest, options);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const home = first.codexHomeDir;
  const firstBinding = JSON.parse(await readFile(codexRunBindingPath(home, 'run_binding_first'), 'utf8'));
  const secondBinding = JSON.parse(await readFile(codexRunBindingPath(home, 'run_binding_second'), 'utf8'));
  assert.equal(verifyCodexRunBinding(firstBinding, { runId: 'run_binding_first', providerId: 'profile-a', accountId: 'account-a' }), true);
  assert.equal(verifyCodexRunBinding(secondBinding, { runId: 'run_binding_second', providerId: 'profile-a', accountId: 'account-a' }), true);
  assert.equal(verifyCodexRunBinding(firstBinding, { runId: 'run_binding_second', providerId: 'profile-a', accountId: 'account-a' }), false);

  await registry.upsertProviderProfile({ id: 'profile-b', agentType: 'codex', protocol: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex', authProfileId: 'auth-a', modelPolicy: { defaultModel: 'gpt-5.5' } });
  const candidate = join(options.providerHomesRoot, 'by-provider', createHash('sha256').update('codex:profile-b').digest('hex').slice(0, 32));
  const account = { configDir, providerHomesRoot: options.providerHomesRoot, accountId: 'account-a' };
  await resolveCanonicalCodexAccountHome({ ...account, candidateHomeRoot: first.homeDir, initialize: true });
  const otherManifest = { tool: 'codex', options: { providerProfile: 'profile-b', model: 'gpt-5.5' } };
  const broker = createServer((socket) => {
    createInterface({ input: socket }).on('line', (line) => {
      const ping = JSON.parse(line);
      socket.write(`${JSON.stringify({ type: 'agentoc-codex-broker-pong', ready: true,
        accountMatches: ping.expectedAccountDigest === codexBrokerAccountDigest('account-a') })}\n`);
    });
  });
  broker.listen(codexAppServerBrokerSocketPath(home));
  await once(broker, 'listening');
  t.after(() => new Promise((done) => broker.close(done)));
  const other = await prepareNativeRunProviderHome('run_binding_third', otherManifest, options);
  assert.equal(other.ok, true);
  assert.equal(other.homeDir, first.homeDir);
  const otherBinding = JSON.parse(await readFile(codexRunBindingPath(home, 'run_binding_third'), 'utf8'));
  assert.equal(verifyCodexRunBinding(otherBinding, { runId: 'run_binding_third', providerId: 'profile-b', accountId: 'account-a' }), true);
  const ownership = await resolveCanonicalCodexAccountHome({ ...account, candidateHomeRoot: candidate, includeSources: true });
  assert.deepEqual(ownership.aliases, [candidate]);
});
