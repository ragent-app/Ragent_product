import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'win32') {
  console.log('SKIP: native Windows managed OAuth command discovery');
  process.exit(0);
}
const root = await mkdtemp(join(tmpdir(), 'ragent-managed-oauth-'));
const configDir = join(root, 'config');
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_HARNESS_ROOT = join(root, 'harnesses');
process.env.RAGENT_PACKAGED_HARNESS_ROOT = join(root, 'no-bundled-runtime');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.RAGENT_HARNESS_POLICY_URL = 'http://invalid.test';
process.env.PATH = 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
await mkdir(configDir, { recursive: true });
const { resolveToolCommandPathAsync } = await import('../lib/tools.mjs');
// Reproduce a service started without any user npm globals on its PATH. Cache
// the miss first, then add the managed installation without changing PATH.
assert.equal(await resolveToolCommandPathAsync('codex'), null);
const binDir = join(root, 'harnesses', 'codex', 'node_modules', '.bin');
await mkdir(binDir, { recursive: true });
const helper = join(root, 'fixture-login.mjs');
await writeFile(helper, `
if (process.argv.includes('--version')) { console.log('codex-cli 0.153.4'); }
else {
  console.error('https://auth.openai.com/codex/device');
  console.error('ABCD-EFGH1');
  setInterval(() => {}, 1000);
}
`);
await writeFile(join(binDir, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`);
const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
const management = await import('../chat/native-provider-management.mjs');
const context = {
  configDir, registry: createNativeProviderRegistry({ configDir }),
  secretStore: createSecretStore({ configDir }), sourceInstanceId: 'managed-oauth-fixture',
  agentType: 'codex', resolveProxyEnvironment: async () => ({}),
};
let job;
try {
  // No commandPath override: exercise the same discovery as the product route.
  job = await management.startNativeOAuthLogin(context);
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    const current = management.getNativeOAuthLoginJob(job.id);
    if (current.state === 'failed') throw new Error(current.error);
    if (current.code) {
      assert.equal(current.url, management.CODEX_DEVICE_LOGIN_URL);
      assert.equal(current.phase, 'awaiting-device-auth');
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, 'managed CLI must start and provide its device-code handoff');
} finally {
  if (job) await management.cancelNativeOAuthLogin(job.id);
}
assert.equal(await resolveToolCommandPathAsync('codex'), join(binDir, 'codex.cmd'), 'a prior miss must not hide a newly installed internal runtime');
await writeFile(join(configDir, 'harness-installations.json'), JSON.stringify({ codex: { installed: false } }));
await assert.rejects(management.startNativeOAuthLogin(context), (error) => error.code === 'HARNESS_RUNTIME_UNAVAILABLE',
  'explicitly uninstalled Harness must not be resurrected by login');
console.log('PASS: managed-only Codex login bypasses a cached PATH miss; uninstall visibility remains enforced');
