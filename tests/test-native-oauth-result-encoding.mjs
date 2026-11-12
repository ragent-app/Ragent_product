import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'agentoc-oauth-encoding-'));
const configDir = join(root, 'config');
process.env.AGENTOC_CONFIG_DIR = configDir;
process.env.AGENTOC_INSTANCE_ROOT = root;
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
await mkdir(configDir, { recursive: true });
const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
const { createCredentialMutationLedger } = await import('../lib/provider-runtime/credential-mutation.mjs');
const { managedCodexMcpAccountBinding } = await import('../lib/provider-runtime/codex-mcp-config.mjs');
const { readCodexCapabilitySync } = await import('../chat/codex-capability-sync.mjs');
const management = await import(process.env.AGENTOC_TEST_OAUTH_MODULE
  ? pathToFileURL(process.env.AGENTOC_TEST_OAUTH_MODULE).href
  : '../chat/native-provider-management.mjs');
const context = {
  configDir,
  registry: createNativeProviderRegistry({ configDir }),
  secretStore: createSecretStore({ configDir }),
  credentialLedger: createCredentialMutationLedger({ configDir }),
  sourceInstanceId: 'oauth-encoding-test',
  resolveProxyEnvironment: async () => ({}),
};

for (const encoding of ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'malformed']) {
  const helper = join(root, `${encoding}.mjs`);
  await writeFile(helper, `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const text = JSON.stringify({tokens:{account_id:'fixture-account',access_token:'fixture-access',refresh_token:'fixture-refresh'}});
let bytes = Buffer.from(text);
if (${JSON.stringify(encoding)} === 'utf8-bom') bytes = Buffer.concat([Buffer.from([239,187,191]), bytes]);
if (${JSON.stringify(encoding)} === 'utf16le') bytes = Buffer.concat([Buffer.from([255,254]), Buffer.from(text,'utf16le')]);
if (${JSON.stringify(encoding)} === 'utf16be') bytes = Buffer.concat([Buffer.from([254,255]), Buffer.from(text,'utf16le').swap16()]);
if (${JSON.stringify(encoding)} === 'malformed') bytes = Buffer.from('fixture-secret-must-not-appear invalid JSON');
writeFileSync(join(process.env.CODEX_HOME,'auth.json'),bytes,{mode:0o600});
console.error('https://auth.openai.com/codex/device');
console.error('ABCD-EFGH1');
`);
  const commandPath = join(root, process.platform === 'win32' ? `${encoding}.cmd` : encoding);
  await writeFile(commandPath, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${helper}"\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${helper.replaceAll("'", "'\\''")}'\n`);
  await chmod(commandPath, 0o700);
  // Explicit commandPath is the existing test seam, never exposed by HTTP.
  const started = await management.startNativeOAuthLogin({
    ...context, commandPath, agentType: 'codex', displayName: `Fixture ${encoding}`,
  });
  let current;
  const deadline = Date.now() + 15_000;
  do {
    current = management.getNativeOAuthLoginJob(started.id);
    if (['completed', 'failed'].includes(current.state)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  if (encoding === 'malformed') {
    assert.equal(current.state, 'failed');
    assert.equal(current.phase, 'finalize-failed');
    assert.match(current.error, /Codex login result is not valid JSON/);
    assert.doesNotMatch(JSON.stringify(current), /fixture-secret-must-not-appear/);
  } else {
    assert.equal(current.state, 'completed', `${encoding}: ${current.error}`);
    const provider = await context.registry.getProviderProfile(current.providerId);
    const auth = await context.registry.getAuthProfile(provider.authProfileId);
    const secret = await context.secretStore.resolveSecret(auth.storageRef);
    assert.equal(secret.ok, true);
    assert.equal(secret.tokens.refresh_token === 'fixture-refresh', true, 'complete credential persisted');
    const record = await context.credentialLedger.getRecord(auth.accountMetadata.accountKey);
    assert.equal(record.credentialVersion, auth.accountMetadata.credentialVersion);
    assert.doesNotMatch(await readFile(context.credentialLedger.path, 'utf8'), /fixture-access|fixture-refresh/);
    if (encoding === 'utf8') {
      const binding = managedCodexMcpAccountBinding(secret);
      let sync = null;
      const syncDeadline = Date.now() + 5_000;
      while (!sync && Date.now() < syncDeadline) {
        sync = await readCodexCapabilitySync(configDir, binding, current.providerId);
        if (!sync) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(sync?.status, 'waiting_for_runtime', 'successful login schedules discovery without starting another broker');
    }
  }
  assert.doesNotMatch(JSON.stringify(current), /fixture-access|fixture-refresh|providerHome|stagingDir/);
  console.log(`PASS: native OAuth ${encoding} ${encoding === 'malformed' ? 'rejects without credential excerpt' : 'persists Provider and credential'}`);
}
assert.equal((await context.registry.listProviderProfiles()).length, 4);
