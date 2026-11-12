import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'agentoc-native-provider-oauth-login-'));
const home = join(root, 'home');
const configDir = join(home, '.config', 'agentoc');
const binDir = join(root, 'bin');
const codexEnvFile = join(root, 'codex-env.txt');
const agyArgsFile = join(root, 'agy-args.txt');
await Promise.all([
  mkdir(home, { recursive: true }),
  mkdir(configDir, { recursive: true }),
  mkdir(binDir, { recursive: true }),
]);

const originalHome = process.env.HOME;
const originalAgyHome = process.env.AGY_HOME;
const originalPath = process.env.PATH;
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = configDir;
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.PATH = `${binDir}:${originalPath || ''}`;
process.env.AGY_HOME = join(home, 'terminal-agy');
process.env.AGENTOC_TEST_CODEX_ENV_FILE = codexEnvFile;
process.env.AGENTOC_TEST_AGY_ARGS_FILE = agyArgsFile;
await mkdir(join(home, 'terminal-agy', '.gemini', 'antigravity-cli'), { recursive: true });
await writeFile(join(home, 'terminal-agy', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'terminal-token\n', 'utf8');

async function install(name, body) {
  const file = join(binDir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(file, 0o755);
}

await install('codex', `
mkdir -p "$CODEX_HOME"
printf '%s\\n' "http=$HTTP_PROXY|https=$HTTPS_PROXY|all=$ALL_PROXY|no=$NO_PROXY|lower=$http_proxy|home=$HOME|codex_home=$CODEX_HOME|api_key=\${OPENAI_API_KEY-unset}" > "$CODEX_HOME/env.txt"
cp "$CODEX_HOME/env.txt" "$AGENTOC_TEST_CODEX_ENV_FILE"
printf '%s\\n' 'https://auth.openai.com/codex/device' >&2
printf '%s\\n' 'ABCD-EFGH1' >&2
printf '%s\\n' '{"tokens":{"access_token":"codex-access","refresh_token":"codex-refresh"}}' > "$CODEX_HOME/auth.json"
exit 0
`);
await install('codex-fail', `
printf '%s\\n' 'OAuth failed: access_token=secret-token https://auth.openai.com/codex/device?code=private-code' >&2
exit 7
`);
await install('codex-auth-fail', `
printf '%s\\n' 'https://auth.openai.com/codex/device' >&2
printf '%s\\n' 'AUTH-FAIL1' >&2
printf '%s\\n' 'Failed to authorize this device' >&2
exit 8
`);
await install('codex-cloudflare-fail', `
printf '%s\\n' 'https://auth.openai.com/codex/device' >&2
printf '%s\\n' 'CLOU-DFLR1' >&2
printf '%s\\n' 'Cloudflare verification required' >&2
exit 9
`);
await install('codex-no-code', `
printf '%s\\n' 'Preparing device code login' >&2
exit 10
`);
await install('codex-relogin', `
printf '%s\\n' 'https://auth.openai.com/codex/device' >&2
printf '%s\\n' 'WXYZ-RELOGIN' >&2
printf '%s\\n' '{"tokens":{"access_token":"codex-access-new","refresh_token":"codex-refresh-new"}}' > "$CODEX_HOME/auth.json"
exit 0
`);
await install('agy', `
printf '%s\\n' "arg1=\$1" "arg2=\${2-}" >> "\$AGENTOC_TEST_AGY_ARGS_FILE"
if [ "\${1-}" != "--print" ] || [ -z "\${2-}" ]; then
  printf '%s\\n' 'AgY OAuth login requires print mode with a non-empty prompt' >&2
  exit 19
fi
printf '%s\\n' 'https://accounts.google.com/o/oauth2/auth?state=agy-test' >&2
IFS= read -r credential
target="\${AGY_HOME:-\$HOME}"
if [ "$credential" = "https://example.test/callback?text=browser-credential&state=preserve" ]; then
  mkdir -p "$target/.gemini/antigravity-cli"
  printf '%s\\n' 'agy-token' > "$target/.gemini/antigravity-cli/antigravity-oauth-token"
  exit 0
fi
if [ "$credential" = "browser-credential-new" ]; then
  mkdir -p "$target/.gemini/antigravity-cli"
  printf '%s\\n' 'agy-token-new' > "$target/.gemini/antigravity-cli/antigravity-oauth-token"
  exit 0
fi
exit 1
`);

const { createNativeProviderRegistry } = await import('../lib/provider-runtime/registry.mjs');
const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
const { createProviderSyncLedger } = await import('../lib/provider-runtime/sync-ledger.mjs');
const { createCredentialMutationLedger } = await import('../lib/provider-runtime/credential-mutation.mjs');
const { migrateLegacyAgyProvider } = await import('../lib/provider-runtime/run-provider-prepare.mjs');
const management = await import('../chat/native-provider-management.mjs');
assert.deepEqual(
  management.projectLoginOutput("OpenAI's command-line coding agent"),
  { url: '', code: '' },
  'Codex welcome text must not be mistaken for a device code',
);
assert.deepEqual(
  management.projectLoginOutput([
    "OpenAI's command-line coding agent",
    'https://auth.openai.com/codex/device',
    'O2UN-1CZA1',
  ].join('\n')),
  { url: 'https://auth.openai.com/codex/device', code: 'O2UN-1CZA1' },
  'Codex device output should expose the real code after the welcome text',
);
const context = {
  configDir,
  registry: createNativeProviderRegistry({ configDir }),
  secretStore: createSecretStore({ configDir }),
  ledger: createProviderSyncLedger({ configDir }),
  credentialLedger: createCredentialMutationLedger({ configDir }),
  sourceInstanceId: 'inst_oauth_test',
};

async function waitForJob(id, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = management.getNativeOAuthLoginJob(id);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for login job ${id}: ${JSON.stringify(management.getNativeOAuthLoginJob(id))}`);
}

let syncCalls = 0;
const codex = await management.startNativeOAuthLogin({
  ...context,
  onProviderChanged: () => { syncCalls += 1; },
  agentType: 'codex',
  commandPath: join(binDir, 'codex'),
  displayName: 'Codex test',
  resolveProxyEnvironment: async () => ({
    HTTP_PROXY: 'http://127.0.0.1:43123',
    HTTPS_PROXY: 'http://127.0.0.1:43123',
    ALL_PROXY: 'http://127.0.0.1:43123',
    NO_PROXY: '127.0.0.1,localhost,::1',
    http_proxy: 'http://127.0.0.1:43123',
    https_proxy: 'http://127.0.0.1:43123',
    all_proxy: 'http://127.0.0.1:43123',
    no_proxy: '127.0.0.1,localhost,::1',
  }),
});
assert.equal(codex.url, management.CODEX_DEVICE_LOGIN_URL);
const codexDone = await waitForJob(codex.id, (job) => job.state === 'completed');
assert.equal(codexDone.code, 'ABCD-EFGH1');
assert.equal(codexDone.profile.agentType, 'codex');
assert.equal((await context.secretStore.describeSecret(`secret-${codexDone.providerId}`)).ok, true);
const codexEnv = await readFile(codexEnvFile, 'utf8');
assert.match(codexEnv, /http=http:\/\/127\.0\.0\.1:43123/);
assert.match(codexEnv, /https=http:\/\/127\.0\.0\.1:43123/);
assert.match(codexEnv, /all=http:\/\/127\.0\.0\.1:43123/);
assert.match(codexEnv, /lower=http:\/\/127\.0\.0\.1:43123/);
assert.match(codexEnv, /codex_home=.+\/codex/);
assert.match(codexEnv, /api_key=unset/);
assert.equal(syncCalls, 1, 'OAuth completion should trigger the provider sync callback');
assert.deepEqual(
  (await context.ledger.readState()).records,
  [],
  'Codex OAuth credentials remain machine-local and must not create a peer-sync ledger record',
);

const failedRelogin = await management.startNativeOAuthLogin({
  ...context,
  agentType: 'codex',
  commandPath: join(binDir, 'codex-fail'),
  providerId: codexDone.providerId,
  replaceExisting: true,
  displayName: 'Codex test',
});
const failedReloginDone = await waitForJob(failedRelogin.id, (job) => job.state === 'failed');
assert.match(failedReloginDone.error, /^LOGIN_FAILED \(exit 7\):/);
assert.equal(
  (await context.secretStore.resolveSecret(`secret-${codexDone.providerId}`)).tokens.refresh_token,
  'codex-refresh',
  'a failed Codex re-login must leave the active credential untouched',
);

const codexRelogin = await management.startNativeOAuthLogin({
  ...context,
  onProviderChanged: () => { syncCalls += 1; },
  agentType: 'codex',
  commandPath: join(binDir, 'codex-relogin'),
  providerId: codexDone.providerId,
  replaceExisting: true,
  displayName: 'Codex reauthenticated',
});
assert.equal(codexRelogin.targetProviderId, codexDone.providerId);
const codexReloginDone = await waitForJob(codexRelogin.id, (job) => job.state === 'completed');
assert.equal(codexReloginDone.profile.id, codexDone.providerId, 're-login must update the existing Provider');
assert.equal(
  (await context.secretStore.resolveSecret(`secret-${codexDone.providerId}`)).tokens.refresh_token,
  'codex-refresh-new',
);
assert.equal(
  (await management.listNativeProviderProfiles({ ...context })).filter((row) => row.agentType === 'codex').length,
  1,
  're-login must not create a duplicate Codex Provider',
);
assert.equal(syncCalls, 2, 'Codex re-login should trigger the provider sync callback');

const failedCodex = await management.startNativeOAuthLogin({
  ...context,
  agentType: 'codex',
  commandPath: join(binDir, 'codex-fail'),
  displayName: 'Codex failed test',
  resolveProxyEnvironment: async () => ({}),
});
const failedCodexDone = await waitForJob(failedCodex.id, (job) => job.state === 'failed');
assert.match(failedCodexDone.error, /^LOGIN_FAILED \(exit 7\):/);
assert.match(failedCodexDone.error, /\[redacted\]/);
assert.doesNotMatch(failedCodexDone.error, /secret-token|private-code/);
assert.equal(failedCodexDone.failureCode, 'device-code');

const authFailedCodex = await management.startNativeOAuthLogin({
  ...context,
  agentType: 'codex',
  commandPath: join(binDir, 'codex-auth-fail'),
  displayName: 'Codex auth failure test',
});
const authFailedCodexDone = await waitForJob(authFailedCodex.id, (job) => job.state === 'failed');
assert.equal(authFailedCodexDone.failureCode, 'official-auth');
assert.equal(authFailedCodexDone.phase, 'official-auth-failed');
assert.doesNotMatch(authFailedCodexDone.error, /AUTH-FAIL1/);

const cloudflareFailedCodex = await management.startNativeOAuthLogin({
  ...context,
  agentType: 'codex',
  commandPath: join(binDir, 'codex-cloudflare-fail'),
  displayName: 'Codex Cloudflare failure test',
});
const cloudflareFailedCodexDone = await waitForJob(cloudflareFailedCodex.id, (job) => job.state === 'failed');
assert.equal(cloudflareFailedCodexDone.failureCode, 'cloudflare');
assert.equal(cloudflareFailedCodexDone.phase, 'cloudflare-failed');

const noCodeCodex = await management.startNativeOAuthLogin({
  ...context,
  agentType: 'codex',
  commandPath: join(binDir, 'codex-no-code'),
  displayName: 'Codex no code test',
});
const noCodeCodexDone = await waitForJob(noCodeCodex.id, (job) => job.state === 'failed');
assert.equal(noCodeCodexDone.failureCode, 'device-code');
assert.equal(noCodeCodexDone.phase, 'device-code-failed');

await assert.rejects(
  () => management.startNativeOAuthLogin({ ...context, agentType: 'claude', commandPath: join(binDir, 'claude'), displayName: 'Claude test' }),
  (error) => error?.code === 'CLAUDE_OAUTH_REMOVED' && error?.statusCode === 410,
  'Claude normal OAuth login must be rejected; use setup-token instead',
);

const agy = await management.startNativeOAuthLogin({ ...context, agentType: 'agy', commandPath: join(binDir, 'agy'), displayName: 'agy test' });
const agyReady = await waitForJob(agy.id, (job) => job.state === 'awaiting-input' && Boolean(job.url));
assert.match(agyReady.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/);
assert.equal(Object.hasOwn(agyReady, 'raw'), false);
const agyArgs = await readFile(agyArgsFile, 'utf8');
assert.match(agyArgs, /arg1=--print\narg2=Sign in to Ragent in your browser\./, 'AgY OAuth must use print mode so the CLI emits its browser URL');
const agyInput = await management.sendNativeOAuthLoginInput(agy.id, 'https://example.test/callback?text=browser-credential&state=preserve');
assert.equal(agyInput.inputSubmitted, true);
assert.equal(agyInput.requiresInput, false);
const agyDone = await waitForJob(agy.id, (job) => job.state === 'completed');
assert.equal(agyDone.profile.credentialStored, true);
assert.equal((await management.getAgyOfficialProviderProfile({ checkCommand: false, ...context })), null);
assert.equal((await management.listNativeProviderProfiles({ ...context, includeAgy: true })).filter((row) => row.agentType === 'agy').length, 1);

const agySecond = await management.startNativeOAuthLogin({
  ...context,
  agentType: 'agy',
  commandPath: join(binDir, 'agy'),
  displayName: 'agy second account',
});
await waitForJob(agySecond.id, (job) => job.state === 'awaiting-input');
await management.sendNativeOAuthLoginInput(agySecond.id, 'browser-credential-new');
const agySecondDone = await waitForJob(agySecond.id, (job) => job.state === 'completed');
assert.notEqual(agySecondDone.providerId, agyDone.providerId, 'adding an account must create a separate provider');
assert.equal((await management.listNativeProviderProfiles({ ...context, includeAgy: true })).filter((row) => row.agentType === 'agy').length, 2);
assert.equal(
  (await context.secretStore.resolveSecret(`secret-${agyDone.providerId}`)).tokens.tokenFile.trim(),
  'agy-token',
);
assert.equal(
  (await context.secretStore.resolveSecret(`secret-${agySecondDone.providerId}`)).tokens.tokenFile.trim(),
  'agy-token-new',
);
assert.equal(
  (await readFile(join(home, 'terminal-agy', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).trim(),
  'terminal-token',
  'terminal AgY HOME must not be touched by AgentoC login',
);

const failedRelink = await management.startNativeOAuthLogin({
  ...context,
  agentType: 'agy',
  commandPath: join(binDir, 'agy'),
  providerId: agyDone.providerId,
  replaceExisting: true,
  displayName: 'agy failed rebound',
});
await waitForJob(failedRelink.id, (job) => job.state === 'awaiting-input');
assert.equal(
  (await context.secretStore.resolveSecret(`secret-${agyDone.providerId}`)).tokens.tokenFile.trim(),
  'agy-token',
  'a failed relink must leave the active account untouched',
);
await management.sendNativeOAuthLoginInput(failedRelink.id, 'invalid-credential');
await waitForJob(failedRelink.id, (job) => job.state === 'failed');
assert.equal(
  (await context.secretStore.resolveSecret(`secret-${agyDone.providerId}`)).tokens.tokenFile.trim(),
  'agy-token',
  'a failed relink must not delete the active account',
);

const relink = await management.startNativeOAuthLogin({
  ...context,
  agentType: 'agy',
  commandPath: join(binDir, 'agy'),
  providerId: agyDone.providerId,
  replaceExisting: true,
  displayName: 'agy rebound',
});
await waitForJob(relink.id, (job) => job.state === 'awaiting-input');
assert.equal(
  (await context.secretStore.resolveSecret(`secret-${agyDone.providerId}`)).tokens.tokenFile.trim(),
  'agy-token',
  'the active account must remain available while a relink is pending',
);
await management.sendNativeOAuthLoginInput(relink.id, 'browser-credential-new');
const relinkDone = await waitForJob(relink.id, (job) => job.state === 'completed');
assert.equal(relinkDone.profile.id, agyDone.providerId);
assert.equal(
  (await context.secretStore.resolveSecret(`secret-${agyDone.providerId}`)).tokens.tokenFile.trim(),
  'agy-token-new',
);

const legacyAuthFile = join(configDir, 'provider-runtime-homes', 'agy-control', '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
await mkdir(join(configDir, 'provider-runtime-homes', 'agy-control', '.gemini', 'antigravity-cli'), { recursive: true });
await writeFile(legacyAuthFile, 'agy-legacy-token\n', 'utf8');
const migrated = await migrateLegacyAgyProvider({ ...context, displayName: 'agy legacy account' });
assert.equal(migrated.id, management.AGY_OFFICIAL_PROVIDER_ID);
assert.equal((await context.secretStore.resolveSecret(`secret-${management.AGY_OFFICIAL_PROVIDER_ID}`)).tokens.tokenFile.trim(), 'agy-legacy-token');

process.env.HOME = originalHome;
if (originalAgyHome === undefined) delete process.env.AGY_HOME;
else process.env.AGY_HOME = originalAgyHome;
process.env.PATH = originalPath;
console.log('test-native-provider-oauth-login: Codex device login, Claude OAuth removal, AgY multi-account isolation, migration, and relink OK');
