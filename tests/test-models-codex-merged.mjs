#!/usr/bin/env node
// Native provider model catalog contract:
// - every model is scoped as model@providerId;
// - official OAuth rows use their account's discovered catalog or last successful cache;
// - API-key rows use their own /models endpoint and never bleed into another row.
import assert from 'assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'agentoc-models-native-'));
const configDir = join(tempHome, 'config');
const nativeRuntimeDir = join(configDir, 'native-provider-runtime');
const secretsDir = join(nativeRuntimeDir, 'secrets');
const binDir = join(tempHome, 'bin');
mkdirSync(secretsDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

const fakeCodexPath = join(binDir, 'codex');
writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.0.0-fixture');
  process.exit(0);
}

let providerId = '';
try {
  providerId = readFileSync(join(process.env.CODEX_HOME || '', '.agentoc-provider-id'), 'utf8').trim();
} catch {}

const effort = (...levels) => levels.map((reasoningEffort) => ({ reasoningEffort }));
const catalog = [
  { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6 Astra', defaultReasoningEffort: 'high', supportedReasoningEfforts: effort('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
  { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', defaultReasoningEffort: 'medium', supportedReasoningEfforts: effort('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
  { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', defaultReasoningEffort: 'medium', supportedReasoningEfforts: effort('low', 'medium', 'high', 'xhigh', 'max') },
  { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', defaultReasoningEffort: 'medium', supportedReasoningEfforts: effort('low', 'medium', 'high', 'xhigh', 'max') },
  { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', model: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini' },
  { id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4' },
  { id: 'gpt-official-extra', model: 'gpt-official-extra', displayName: 'Official Extra' },
];

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n');
    } else if (message.method === 'model/list') {
      const recovery = process.env.FIXTURE_MODEL_RECOVERY_FILE && existsSync(process.env.FIXTURE_MODEL_RECOVERY_FILE)
        ? readFileSync(process.env.FIXTURE_MODEL_RECOVERY_FILE, 'utf8').trim() : '';
      const response = providerId === 'codex-official' || recovery
        ? { id: message.id, result: { data: recovery === 'trimmed' ? catalog.filter((model) => model.id !== 'gpt-5.4-mini') : catalog, nextCursor: null } }
        : { id: message.id, error: { code: -32001, message: 'fixture account unavailable' } };
      process.stdout.write(JSON.stringify(response) + '\\n');
      setTimeout(() => process.exit(0), 50);
    }
  }
});
`, 'utf8');
chmodSync(fakeCodexPath, 0o755);
const fakeCodexCommand = process.platform === 'win32' ? `${fakeCodexPath}.cmd` : fakeCodexPath;
if (process.platform === 'win32') writeFileSync(fakeCodexCommand, `@"${process.execPath}" "${fakeCodexPath}" %*\r\n`, 'utf8');

const providers = [
  {
    id: 'codex-official-2', displayName: 'person-4@example.test', protocol: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex', authType: 'oauth',
    modelPolicy: { defaultModel: 'gpt-5.6-luna' },
  },
  {
    id: 'codex-official', displayName: 'person-5@example.test', protocol: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex', authType: 'oauth',
    modelPolicy: { defaultModel: '' },
  },
  {
    id: 'deepseek-v4-flash-codex', displayName: 'deepseek-v4-flash-codex', protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1', authType: 'api-key', apiKey: 'sk-deepseek-test',
    modelPolicy: { defaultModel: 'deepseek-v4-flash' },
  },
  {
    id: 'custom-gpt-5.6-luna', displayName: 'custom gpt-5.6-luna', protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:9/v1', authType: 'api-key', apiKey: 'sk-custom-test',
    modelPolicy: { defaultModel: 'gpt-5.6-luna' },
  },
  {
    id: 'opencode-go-chat-deepseek-v4-flash-free', displayName: 'opencode_go_chat', protocol: 'openai-chat',
    baseUrl: 'https://opencode.ai/zen/v1', authType: 'api-key', apiKey: 'sk-zen-test',
    modelPolicy: { defaultModel: 'deepseek-v4-flash-free' },
  },
  {
    id: 'broken-upstream', displayName: 'broken-upstream', protocol: 'openai-chat',
    baseUrl: 'https://broken.invalid/v1', authType: 'api-key', apiKey: 'sk-broken-test',
    modelPolicy: { defaultModel: 'fallback-only' },
  },
];

const upstreamModels = {
  'https://api.deepseek.com/v1/models': {
    data: [
      { id: 'deepseek-v4-flash', display_name: 'deepseek-v4-flash' },
      { id: 'deepseek-v4-pro', display_name: 'deepseek-v4-pro' },
    ],
  },
  'http://127.0.0.1:9/v1/models': {
    data: [
      { id: 'gpt-5.6-sol', display_name: 'gpt-5.6-sol' },
      { id: 'gpt-5.6-luna', display_name: 'gpt-5.6-luna' },
      { id: 'gpt-5.4', display_name: 'gpt-5.4' },
      { id: 'gpt-5.5', display_name: 'gpt-5.5' },
      { id: 'gpt-5.4-mini', display_name: 'gpt-5.4-mini' },
      {
        id: 'gpt-image-2',
        display_name: 'gpt-image-2',
        supported_reasoning_levels: ['low', 'medium'],
        default_effort: 'low',
        supports_fast: true,
      },
    ],
  },
  'https://opencode.ai/zen/v1/models': {
    data: [
      { id: 'deepseek-v4-flash-free', display_name: 'deepseek-v4-flash-free' },
      { id: 'gpt-5.4', display_name: 'gpt-5.4' },
      { id: 'gpt-5.4-mini', display_name: 'gpt-5.4-mini' },
      { id: 'gpt-5.5', display_name: 'gpt-5.5' },
    ],
  },
};

function writeNativeRegistry() {
  const providerProfiles = [];
  const authProfiles = [];
  for (const provider of providers) {
    const authProfileId = `auth-${provider.id}`;
    const secretRef = `secret-${provider.id}`;
    providerProfiles.push({
      id: provider.id,
      agentType: 'codex',
      protocol: provider.protocol,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      authProfileId,
      modelPolicy: provider.modelPolicy,
    });
    authProfiles.push({
      id: authProfileId,
      agentType: 'codex',
      authType: provider.authType,
      displayName: provider.displayName,
      storageType: 'secret-store',
      storageRef: secretRef,
    });
    writeFileSync(join(secretsDir, `${secretRef}.json`), JSON.stringify(provider.authType === 'oauth'
      ? { authType: 'oauth', tokens: { access_token: `access-${provider.id}`, refresh_token: `refresh-${provider.id}`, account_id: `account-${provider.id}` } }
      : { authType: 'api-key', apiKey: provider.apiKey }));
  }
  writeFileSync(join(nativeRuntimeDir, 'providers.json'), JSON.stringify({ version: 1, profiles: providerProfiles }));
  writeFileSync(join(nativeRuntimeDir, 'auth-profiles.json'), JSON.stringify({ version: 1, profiles: authProfiles }));
}

let fetchCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const body = upstreamModels[String(url)];
  if (!body) return new Response('nope', { status: 500 });
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

process.env.HOME = tempHome;
process.env.AGENTOC_INSTANCE_ROOT = tempHome;
process.env.AGENTOC_CONFIG_DIR = configDir;
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.AGENTOC_HARNESS_ROOT = join(tempHome, 'harnesses');
const originalPackagedHarnessRoot = process.env.AGENTOC_PACKAGED_HARNESS_ROOT;
process.env.AGENTOC_PACKAGED_HARNESS_ROOT = binDir;
const originalPath = process.env.PATH;
const originalRecoveryFile = process.env.FIXTURE_MODEL_RECOVERY_FILE;
const originalNow = Date.now;
process.env.FIXTURE_MODEL_RECOVERY_FILE = join(tempHome, 'model-recovered');
process.env.PATH = `${binDir}${delimiter}${originalPath || ''}`;

const { getModelsForTool, getToolModelCatalogs, parseScopedCodexModel } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'models.mjs')).href,
);
const { resolveToolCommandPathAsync } = await import(
  pathToFileURL(join(repoRoot, 'lib', 'tools.mjs')).href,
);

try {
  writeNativeRegistry();
  assert.equal(await resolveToolCommandPathAsync('codex'), fakeCodexCommand, 'fixture codex must own app-server discovery');
  assert.deepEqual(parseScopedCodexModel('gpt-5.6-sol@codex-official-2'), { model: 'gpt-5.6-sol', providerId: 'codex-official-2' });
  assert.deepEqual(parseScopedCodexModel('a@b@c'), { model: 'a@b', providerId: 'c' });
  assert.deepEqual(parseScopedCodexModel('m@bad id!'), { model: 'm@bad id!', providerId: '' });

  const result = await getModelsForTool('codex');
  const ids = result.models.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length, 'scoped ids must be unique');
  assert.equal(result.defaultModel, null, 'Native catalog leaves selection to the session/provider picker');
  assert.equal(result.models.some((m) => m.id.endsWith('@codex-official-2')), false, 'failed first discovery must not fabricate model choices');
  assert.equal(result.models.find((m) => m.id === 'gpt-5.6-sol@codex-official').label, 'GPT-5.6-Sol · person-5@example.test');
  assert.equal(result.models.find((m) => m.id === 'gpt-6-astra@codex-official').label, 'GPT-6 Astra · person-5@example.test');
  assert.deepEqual(
    result.models.find((m) => m.id === 'gpt-5.6-sol@codex-official').effortLevels,
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'official GPT-5.6-Sol should expose max and ultra effort levels',
  );
  assert.deepEqual(
    result.models.find((m) => m.id === 'gpt-5.6-luna@codex-official').effortLevels,
    ['low', 'medium', 'high', 'xhigh', 'max'],
    'official GPT-5.6 models should expose max effort level',
  );
  assert.equal(result.models.some((m) => m.id === 'gpt-official-extra@codex-official'), true, 'official row uses its own dynamic app-server catalog');
  assert.equal(result.models.some((m) => m.id === 'gpt-official-extra@codex-official-2'), false, 'a failed account falls back without borrowing another account catalog');
  const catalogs = await getToolModelCatalogs('codex');
  assert.equal(catalogs.find((entry) => entry.providerProfileId === 'codex-official').source, 'discovered');
  assert.equal(catalogs.find((entry) => entry.providerProfileId === 'codex-official-2').status, 'unavailable');
  assert.match(catalogs.find((entry) => entry.providerProfileId === 'codex-official-2').error?.code || '', /^MODEL_LIST_[A-Z_]+$/);
  assert.equal(catalogs.find((entry) => entry.providerProfileId === 'codex-official').error, undefined);
  assert.equal(result.models.find((m) => m.id === 'gpt-6-astra@codex-official').capabilities.effort.source, 'upstream');
  assert.equal(result.models.find((m) => m.id === 'deepseek-v4-flash@deepseek-v4-flash-codex').label, 'deepseek-v4-flash · DeepSeek');
  const deepseekModel = result.models.find((m) => m.id === 'deepseek-v4-flash@deepseek-v4-flash-codex');
  assert.deepEqual(deepseekModel.effortLevels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(deepseekModel.capabilities.effort.source, 'builtin');
  assert.deepEqual(result.models.find((m) => m.id === 'gpt-5.6-luna@custom-gpt-5.6-luna').effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(deepseekModel.capabilities.serviceTier.supportsFast, null, 'missing upstream fast metadata must stay unknown');
  assert.equal(result.models.find((m) => m.id === 'gpt-5.6-sol@custom-gpt-5.6-luna').label, 'gpt-5.6-sol · Custom');
  assert.equal(result.models.find((m) => m.id === 'deepseek-v4-flash-free@opencode-go-chat-deepseek-v4-flash-free').label, 'deepseek-v4-flash-free · Zen Free');
  assert.equal(result.models.some((m) => m.id === 'gpt-5.4@custom-gpt-5.6-luna'), true, 'custom keeps gpt-5.4');
  assert.equal(result.models.some((m) => m.id === 'gpt-5.4@codex-official'), true, 'official discovery retains advertised models');
  assert.equal(result.models.some((m) => m.id === 'gpt-5.4@opencode-go-chat-deepseek-v4-flash-free'), false, 'zen filters gpt-5.4');
  assert.equal(result.models.some((m) => m.id === 'gpt-5.5@opencode-go-chat-deepseek-v4-flash-free'), false, 'zen filters gpt-5.5');
  assert.equal(result.models.some((m) => m.id === 'fallback-only@broken-upstream'), true, 'failed upstream falls back to configured model');
  assert.equal(result.models.some((m) => m.id === 'gpt-image-2@codex-official-2'), false, 'API-key catalogs must not bleed into official rows');
  assert.equal(result.models.some((m) => m.id === 'gpt-image-2@custom-gpt-5.6-luna'), true, 'API-key catalog stays scoped to its Native provider');
  const customImage = result.models.find((m) => m.id === 'gpt-image-2@custom-gpt-5.6-luna');
  assert.deepEqual(customImage.effortLevels, ['low', 'medium']);
  assert.equal(customImage.capabilities.effort.source, 'upstream');
  assert.equal(customImage.capabilities.serviceTier.supportsFast, true);
  assert.deepEqual(customImage.serviceTiers, ['standard', 'fast']);
  assert.equal(fetchCalls.filter((url) => url.includes('/models')).length, 4, 'each API-key row probes its own endpoint');

  // Retry a previously failed official account after its failure cooldown,
  // before the longer merged catalog TTL would have expired.
  writeFileSync(process.env.FIXTURE_MODEL_RECOVERY_FILE, 'ready');
  const baseNow = originalNow();
  Date.now = () => baseNow + 61_000;
  const recovered = await getModelsForTool('codex');
  assert.equal(recovered.models.some((m) => m.id === 'gpt-official-extra@codex-official-2'), true,
    'official discovery recovers after its failure cooldown');
  const recoveredCatalogs = await getToolModelCatalogs('codex');
  assert.equal(recoveredCatalogs.find((entry) => entry.providerProfileId === 'codex-official-2').error, undefined);
  assert.equal(recoveredCatalogs.find((entry) => entry.providerProfileId === 'codex-official-2').source, 'discovered');

  // A newly loaded server module has empty in-memory maps. Its fast path
  // must recover only the verified account's last discovered catalog.
  const restartedModule = await import(`${pathToFileURL(join(repoRoot, 'chat', 'models.mjs')).href}?restart-fixture`);
  const afterRestart = await restartedModule.getModelsForTool('codex', { providerProfile: 'codex-official-2', fast: true });
  assert.equal(afterRestart.models.some((m) => m.id === 'gpt-official-extra@codex-official-2'), true,
    'a cold process can serve the persisted discovered catalog immediately');

  await new Promise((resolve) => setTimeout(resolve, 200));
  writeFileSync(process.env.FIXTURE_MODEL_RECOVERY_FILE, 'trimmed');
  Date.now = () => baseNow + 182_000;
  const refreshed = await getModelsForTool('codex', { providerProfile: 'codex-official-2' });
  assert.equal(refreshed.models.some((m) => m.id === 'gpt-5.4-mini@codex-official-2'), false,
    'a successful refresh removes models no longer advertised by the account');
  await new Promise((resolve) => setTimeout(resolve, 200));
  rmSync(process.env.FIXTURE_MODEL_RECOVERY_FILE);
  Date.now = () => baseNow + 303_000;
  const stale = await getModelsForTool('codex', { providerProfile: 'codex-official-2' });
  assert.equal(stale.models.some((m) => m.id === 'gpt-official-extra@codex-official-2'), true,
    'a transient discovery failure retains the last successful catalog');
  assert.equal(stale.models.some((m) => m.id === 'gpt-5.4-mini@codex-official-2'), false);
  assert.equal((await getToolModelCatalogs('codex', 'codex-official-2'))[0].status, 'stale');

  // Reusing a provider profile for another account must never reuse the old
  // account's successful catalog, even during its freshness window.
  writeFileSync(join(secretsDir, 'secret-codex-official-2.json'), JSON.stringify({ authType: 'oauth',
    tokens: { access_token: 'replacement', refresh_token: 'replacement', account_id: 'replacement-account' } }));
  const switched = await getModelsForTool('codex', { providerProfile: 'codex-official-2' });
  assert.equal(switched.models.length, 0, 'a replacement account must not inherit another account catalog');
  const switchedCatalog = (await getToolModelCatalogs('codex', 'codex-official-2'))[0];
  assert.equal(switchedCatalog.status, 'unavailable');

  console.log('test-models-codex-merged: ok');
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  if (originalRecoveryFile === undefined) delete process.env.FIXTURE_MODEL_RECOVERY_FILE;
  else process.env.FIXTURE_MODEL_RECOVERY_FILE = originalRecoveryFile;
  process.env.PATH = originalPath;
  if (originalPackagedHarnessRoot === undefined) delete process.env.AGENTOC_PACKAGED_HARNESS_ROOT;
  else process.env.AGENTOC_PACKAGED_HARNESS_ROOT = originalPackagedHarnessRoot;
  await new Promise((resolve) => setTimeout(resolve, 150));
  rmSync(tempHome, { recursive: true, force: true });
}
