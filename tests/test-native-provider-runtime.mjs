#!/usr/bin/env node
// Native provider runtime core contract.
//
// Covers the architecture invariants that kill the historical drift class:
//   I2  switching the session provider must not mutate an existing snapshot
//   I4  credentials never live in ProviderProfile rows
//   I5  host environment cannot smuggle provider auth into a Run
//   I6  resolution happens before spawn and fails closed
//   per-Run isolation: two concurrent Runs on different providers/accounts
//   never share or overwrite each other's runtime home
import assert from 'assert/strict';
import { createHash } from 'crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'node:net';

const root = mkdtempSync(join(tmpdir(), 'agentoc-native-provider-runtime-'));

const {
  createNativeProviderRegistry,
  validateProviderProfile,
  validateAuthProfile,
} = await import('../lib/provider-runtime/registry.mjs');
const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
const { codexAppServerBrokerSocketPath } = await import('../chat/codex-app-server-broker.mjs');
const {
  resolveRuntimeConfig,
  sanitizeRuntimeEnvironment,
  assertSnapshotMatches,
  RuntimeConfigResolutionError,
} = await import('../lib/provider-runtime/resolver.mjs');
const {
  prepareCodexRuntime,
  prepareClaudeRuntime,
  runScopedRuntimeDir,
} = await import('../lib/provider-runtime/adapters.mjs');
const {
  nativeOAuthTokenFingerprint,
  nativeOAuthGenerationExpiresAt,
  isNativeOAuthGenerationNewer,
  resolveNativeSelectionFromManifest,
  resolveDefaultProviderProfileId,
  prepareNativeRunProviderHome,
} = await import('../lib/provider-runtime/run-provider-prepare.mjs');

const configDir = join(root, 'config');
mkdirSync(configDir, { recursive: true });
const registry = createNativeProviderRegistry({ configDir });
const secretStore = createSecretStore({ configDir });

try {
  // —— SecretStore: secrets live only in the vault ——

  await secretStore.writeSecret('cred-a', { authType: 'api-key', apiKey: 'sk-test-aaaaaaaa' });
  await secretStore.writeSecret('cred-oauth', {
    authType: 'oauth',
    tokens: { access_token: 'at-1', refresh_token: 'rt-1', account_id: 'account-a', expiresAt: 1000 },
  });
  const resolvedA = await secretStore.resolveSecret('cred-a');
  assert.equal(resolvedA.apiKey, 'sk-test-aaaaaaaa');
  const described = await secretStore.describeSecret('cred-a');
  assert.ok(described.fingerprint && described.fingerprint.length === 8);
  assert.ok(!JSON.stringify(described).includes('sk-test-aaaaaaaa'), 'describe must not leak the secret');
  await secretStore.writeSecret('cred-setup-token', {
    authType: 'oauth-token',
    token: 'claude-setup-token-test',
  });
  const describedSetupToken = await secretStore.describeSecret('cred-setup-token');
  assert.equal(describedSetupToken.authType, 'oauth-token');
  assert.equal(describedSetupToken.hasRefreshToken, false);
  assert.equal(describedSetupToken.hasLongLivedToken, true);
  assert.ok(!JSON.stringify(describedSetupToken).includes('claude-setup-token-test'));

  const badRef = await secretStore.resolveSecret('../etc/passwd');
  assert.equal(badRef.ok, false, 'path-shaped refs must be rejected');

  // —— Registry: provider rows carry no credentials (I4) ——

  const invalid = validateProviderProfile({ id: 'p1', agentType: 'codex', protocol: 'openai-responses', baseUrl: 'https://relay.example/v1' });
  assert.equal(invalid.ok, false, 'provider without authProfileId must be invalid');
  assert.equal(validateAuthProfile({
    id: 'claude-oauth-removed',
    agentType: 'claude',
    authType: 'oauth',
    displayName: 'Legacy Claude OAuth',
    storageType: 'secret-store',
    storageRef: 'cred-legacy-claude-oauth',
  }).ok, false, 'Claude normal OAuth must not be accepted by the registry');
  assert.equal(validateProviderProfile({
    id: 'copilot-github',
    agentType: 'copilot',
    protocol: 'github-copilot',
    baseUrl: '',
    authProfileId: 'auth-copilot-github',
  }).ok, true, 'official Copilot profiles may omit a base URL');
  assert.equal(validateProviderProfile({
    id: 'copilot-gateway',
    agentType: 'copilot',
    protocol: 'openai-chat',
    baseUrl: '',
    authProfileId: 'auth-copilot-gateway',
  }).ok, false, 'custom Copilot profiles require an HTTP(S) base URL');

  const upCodexRelay = await registry.upsertProviderProfile({
    id: 'openrouter-main',
    agentType: 'codex',
    protocol: 'openai-responses',
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.example/api/v1',
    authProfileId: 'auth-openrouter',
    modelPolicy: {
      defaultModel: 'gpt-x',
      models: [{
        id: 'gpt-x',
        label: 'GPT X',
        capabilities: {
          serviceTier: { supportsFast: true, values: ['standard', 'fast'], source: 'upstream' },
        },
      }],
    },
  });
  assert.equal(upCodexRelay.ok, true, upCodexRelay.errors?.join(';'));
  await registry.upsertAuthProfile({
    id: 'auth-openrouter',
    agentType: 'codex',
    authType: 'api-key',
    displayName: 'OpenRouter Key A',
    storageType: 'secret-store',
    storageRef: 'cred-a',
  });

  // Second provider + account on the SAME agent (the multi-account case).
  await registry.upsertProviderProfile({
    id: 'deepseek-relay',
    agentType: 'codex',
    protocol: 'openai-responses',
    baseUrl: 'https://deepseek.example/v1',
    authProfileId: 'auth-deepseek',
    modelPolicy: { defaultModel: 'ds-flash' },
  });
  await registry.upsertAuthProfile({
    id: 'auth-deepseek',
    agentType: 'codex',
    authType: 'api-key',
    displayName: 'DeepSeek Key',
    storageType: 'secret-store',
    storageRef: 'cred-a2',
  });
  await secretStore.writeSecret('cred-a2', { authType: 'api-key', apiKey: 'sk-test-bbbbbb' });

  // Official OAuth provider row.
  await registry.upsertProviderProfile({
    id: 'openai-official-a',
    agentType: 'codex',
    protocol: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    authProfileId: 'auth-official-a',
    modelPolicy: { defaultModel: 'gpt-5.5' },
  });
  await registry.upsertAuthProfile({
    id: 'auth-official-a',
    agentType: 'codex',
    authType: 'oauth',
    displayName: 'ChatGPT Plus A',
    storageType: 'secret-store',
    storageRef: 'cred-oauth',
  });

  await secretStore.writeSecret('cred-oauth-b', {
    authType: 'oauth',
    tokens: { access_token: 'bt-1', refresh_token: 'brt-1', account_id: 'account-b', expiresAt: 1000 },
  });
  await registry.upsertProviderProfile({
    id: 'openai-official-b',
    agentType: 'codex',
    protocol: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    authProfileId: 'auth-official-b',
    modelPolicy: { defaultModel: 'gpt-5.5' },
  });
  await registry.upsertAuthProfile({
    id: 'auth-official-b',
    agentType: 'codex',
    authType: 'oauth',
    displayName: 'ChatGPT Plus B',
    storageType: 'secret-store',
    storageRef: 'cred-oauth-b',
  });

  const profiles = await registry.listProviderProfiles();
  assert.ok(!JSON.stringify(profiles).includes('sk-test-'), 'registry file content must never contain credential values');

  assert.equal(nativeOAuthGenerationExpiresAt({ expiresAt: 1000 }), 1_000_000);
  assert.equal(
    isNativeOAuthGenerationNewer({ expiresAt: 2000 }, { expiresAt: 1000 }),
    true,
    'a later OAuth expiry must identify the newer credential generation',
  );
  assert.equal(
    isNativeOAuthGenerationNewer({ expiresAt: 1000 }, { expiresAt: 2000 }),
    false,
    'an older OAuth generation must never win the ordering check',
  );

  // Referenced auth profiles cannot be deleted.
  const deleteReferenced = await registry.deleteAuthProfile('auth-openrouter');
  assert.equal(deleteReferenced.ok, false);
  assert.equal(deleteReferenced.reason, 'referenced-by-provider');

  // —— Resolution: frozen snapshot, fail-closed ——

  let clock = 0;
  const snapshotA = await resolveRuntimeConfig({
    runRequest: { runId: 'run_100', agentType: 'codex', providerProfileId: 'openrouter-main', model: 'gpt-x' },
    registry,
    secretStore,
    now: () => `t${clock++}`,
  });
  assert.equal(snapshotA.providerProfileId, 'openrouter-main');
  assert.equal(snapshotA.model, 'gpt-x');
  assert.equal(snapshotA.serviceTier, 'standard', 'API-key Codex providers default to standard mode');
  assert.ok(snapshotA.configHash.startsWith('sha256:'));
  assert.throws(() => { snapshotA.model = 'mutated'; }, TypeError, 'snapshot must be frozen (I1)');

  const scopedSnapshot = await resolveRuntimeConfig({
    runRequest: {
      runId: 'run_100-scoped',
      agentType: 'codex',
      providerProfileId: 'openrouter-main',
      model: 'gpt-x@openrouter-main',
    },
    registry,
    secretStore,
  });
  assert.equal(scopedSnapshot.model, 'gpt-x', 'provider scope must never reach the provider CLI');

  // I2: re-resolving with a DIFFERENT selection produces a different snapshot;
  // the first snapshot is untouched.
  const snapshotB = await resolveRuntimeConfig({
    runRequest: { runId: 'run_101', agentType: 'codex', providerProfileId: 'deepseek-relay', model: 'ds-flash' },
    registry,
    secretStore,
    now: () => `t${clock++}`,
  });
  assert.notEqual(snapshotA.configHash, snapshotB.configHash);
  assert.equal(snapshotA.providerProfileId, 'openrouter-main');
  assert.equal(snapshotB.serviceTier, 'standard');

  const forgedFastApiSnapshot = await resolveRuntimeConfig({
    runRequest: {
      runId: 'run_101-fast',
      agentType: 'codex',
      providerProfileId: 'openrouter-main',
      model: 'unlisted-gpt',
      serviceTier: 'fast',
    },
    registry,
    secretStore,
    now: () => `t${clock++}`,
  });
  assert.equal(forgedFastApiSnapshot.serviceTier, 'standard', 'API-key Codex providers must ignore fast mode');

  const upstreamFastApiSnapshot = await resolveRuntimeConfig({
    runRequest: {
      runId: 'run_101-upstream-fast',
      agentType: 'codex',
      providerProfileId: 'openrouter-main',
      model: 'gpt-x',
      serviceTier: 'fast',
    },
    registry,
    secretStore,
    now: () => `t${clock++}`,
  });
  assert.equal(upstreamFastApiSnapshot.serviceTier, 'fast', 'API-key model may use fast only after explicit upstream declaration');

  // Fail closed: unknown provider, missing credential, agent mismatch.
  await assert.rejects(
    () => resolveRuntimeConfig({
      runRequest: { runId: 'r', agentType: 'codex', providerProfileId: 'nope' },
      registry, secretStore,
    }),
    (error) => error instanceof RuntimeConfigResolutionError && error.code === 'provider-not-found',
  );
  await assert.rejects(
    () => resolveRuntimeConfig({
      runRequest: { runId: 'r', agentType: 'codex', providerProfileId: 'deepseek-relay', model: 'm' },
      registry, secretStore: nullProxyStore(),
    }),
    (error) => error.code === 'credential-missing',
  );

  // Deterministic: same inputs → same hash (stable key ordering).
  const snapshotA2 = await resolveRuntimeConfig({
    runRequest: { runId: 'run_100', agentType: 'codex', providerProfileId: 'openrouter-main', model: 'gpt-x' },
    registry, secretStore,
    now: () => 't0',
  });
  assert.equal(snapshotA.configHash, snapshotA2.configHash);

  // Attestation mismatch detection.
  const match = assertSnapshotMatches(snapshotA, snapshotA);
  assert.equal(match.ok, true);
  const mismatch = assertSnapshotMatches(snapshotA, { ...snapshotA, model: 'other' });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.mismatches.includes('model'));

  // —— EnvSanitizer (I5) ——

  const polluted = sanitizeRuntimeEnvironment({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'host-key',
    ANTHROPIC_BASE_URL: 'https://evil.example',
    ANTHROPIC_AUTH_TOKEN: 'host-token',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'evil-sonnet',
    MY_SERVICE_TOKEN: 'x',
    LANG: 'C.UTF-8',
    RANDOM_TOOL_FLAG: '1',
  });
  assert.equal(polluted.PATH, '/usr/bin');
  assert.equal(polluted.LANG, 'C.UTF-8');
  assert.equal(polluted.RANDOM_TOOL_FLAG, '1');
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'MY_SERVICE_TOKEN']) {
    assert.equal(polluted[key], undefined, `${key} must be stripped from host env`);
  }

  // —— Adapters: per-Run isolated homes ——

  const runtimeRoot = join(root, 'runtime');
  const codexA = await prepareCodexRuntime(snapshotA, { runtimeRoot, secretStore, baseEnv: {} });
  assert.equal(codexA.ok, true, codexA.reason);
  const codexB = await prepareCodexRuntime(snapshotB, { runtimeRoot, secretStore, baseEnv: {} });
  assert.equal(codexB.ok, true);
  assert.notEqual(codexA.codexHomeDir, codexB.codexHomeDir, 'two runs must not share a runtime home');
  const configA = readFileSync(join(codexA.codexHomeDir, 'config.toml'), 'utf8');
  const configB = readFileSync(join(codexB.codexHomeDir, 'config.toml'), 'utf8');
  assert.ok(configA.includes('https://openrouter.example/api/v1'));
  assert.ok(configB.includes('https://deepseek.example/v1'));
  assert.ok(!configA.includes('deepseek'), 'run A config must not reference run B provider');
  assert.ok(configA.includes('env_key = "AGENTOC_RUNTIME_API_KEY"'));
  assert.ok(configA.includes('cli_auth_credentials_store = true'));
  assert.ok(!configA.includes('cli_auth_credentials_store = "file"'));
  assert.equal(codexA.env.CODEX_HOME, codexA.codexHomeDir);
  assert.equal(codexA.env.AGENTOC_RUNTIME_API_KEY, 'sk-test-aaaaaaaa');
  assert.equal(codexB.env.AGENTOC_RUNTIME_API_KEY, 'sk-test-bbbbbb');

  // OAuth home carries auth.json, no env key.
  const snapshotOfficial = await resolveRuntimeConfig({
    runRequest: {
      runId: 'run_102',
      agentType: 'codex',
      providerProfileId: 'openai-official-a',
      model: 'gpt-5.5',
      serviceTier: 'fast',
    },
    registry, secretStore,
    now: () => 't1',
  });
  assert.equal(snapshotOfficial.serviceTier, 'fast', 'official OAuth Codex supports fast mode');
  const tierMismatch = assertSnapshotMatches(snapshotOfficial, { ...snapshotOfficial, serviceTier: 'standard' });
  assert.equal(tierMismatch.ok, false);
  assert.ok(tierMismatch.mismatches.includes('serviceTier'));
  const codexOfficial = await prepareCodexRuntime(snapshotOfficial, { runtimeRoot, secretStore, baseEnv: {} });
  assert.equal(codexOfficial.ok, true, codexOfficial.reason);
  const officialConfig = readFileSync(join(codexOfficial.codexHomeDir, 'config.toml'), 'utf8');
  assert.ok(officialConfig.includes('requires_openai_auth = true'));
  assert.ok(officialConfig.includes('service_tier = "fast"'));
  const officialAuth = JSON.parse(readFileSync(join(codexOfficial.codexHomeDir, 'auth.json'), 'utf8'));
  assert.equal(officialAuth.tokens.access_token, 'at-1');
  assert.equal(codexOfficial.env.AGENTOC_RUNTIME_API_KEY, undefined, 'oauth runs must not carry an env api key');

  // Adapter auth storage ref flows via snapshot (prepared prepare path injects it).
  const claudeGatewaySnapshot = {
    ...snapshotA,
    agentType: 'claude',
    protocol: 'anthropic-messages',
    baseUrl: 'https://gw.example',
    authStorageRef: 'cred-a',
  };
  const claudeRun = await prepareClaudeRuntime(claudeGatewaySnapshot, { runtimeRoot, secretStore, baseEnv: {} });
  assert.equal(claudeRun.ok, true, claudeRun.reason);
  assert.equal(claudeRun.env.ANTHROPIC_BASE_URL, 'https://gw.example');
  assert.equal(claudeRun.env.ANTHROPIC_API_KEY, 'sk-test-aaaaaaaa');
  assert.equal(claudeRun.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1');
  const claudeSetupRun = await prepareClaudeRuntime({
    ...claudeGatewaySnapshot,
    authType: 'oauth-token',
    authStorageRef: 'cred-setup-token',
  }, { runtimeRoot, secretStore, baseEnv: {} });
  assert.equal(claudeSetupRun.ok, true, claudeSetupRun.reason);
  assert.equal(claudeSetupRun.env.CLAUDE_CODE_OAUTH_TOKEN, 'claude-setup-token-test');
  assert.equal(claudeSetupRun.env.ANTHROPIC_API_KEY, undefined);
  const removedClaudeOAuthRun = await prepareClaudeRuntime({
    ...claudeGatewaySnapshot,
    authType: 'oauth',
    authStorageRef: 'cred-oauth',
  }, { runtimeRoot, secretStore, baseEnv: {} });
  assert.equal(removedClaudeOAuthRun.ok, false);
  assert.equal(removedClaudeOAuthRun.reason, 'claude-oauth-unsupported');

  // runScopedRuntimeDir is deterministic and collision-free per (provider, run).
  const d1 = runScopedRuntimeDir(runtimeRoot, 'p1', 'run_1');
  const d2 = runScopedRuntimeDir(runtimeRoot, 'p1', 'run_2');
  const d3 = runScopedRuntimeDir(runtimeRoot, 'p2', 'run_1');
  assert.notEqual(d1, d2);
  assert.notEqual(d1, d3);

  // Native registry profiles are the only provider source. Add the same
  // relay shape directly through the supported registry API.
  await secretStore.writeSecret('cred-luna', { authType: 'api-key', apiKey: 'sk-luna' });
  await registry.upsertAuthProfile({
    id: 'auth-luna', agentType: 'codex', authType: 'api-key',
    displayName: 'Luna', storageType: 'secret-store', storageRef: 'cred-luna',
  });
  await registry.upsertProviderProfile({
    id: 'newapi-luna', agentType: 'codex', protocol: 'openai-responses',
    baseUrl: 'https://luna.example/v1', authProfileId: 'auth-luna',
  });
  await secretStore.writeSecret('cred-claude-gw', { authType: 'api-key', apiKey: 'tok' });
  await registry.upsertAuthProfile({
    id: 'auth-claude-gw', agentType: 'claude', authType: 'api-key',
    displayName: 'GW', storageType: 'secret-store', storageRef: 'cred-claude-gw',
  });
  await registry.upsertProviderProfile({
    id: 'claude-gw', agentType: 'claude', protocol: 'anthropic-messages',
    baseUrl: 'https://cgw.example', authProfileId: 'auth-claude-gw',
  });
  const importedSnapshot = await resolveRuntimeConfig({
    runRequest: { runId: 'run_200', agentType: 'codex', providerProfileId: 'newapi-luna', model: 'luna-model' },
    registry, secretStore,
    now: () => 't2',
  });
  assert.equal(importedSnapshot.baseUrl, 'https://luna.example/v1');

  // —— Native-only prepare: manifest mapping + scoped home ——

  const selCodex = resolveNativeSelectionFromManifest({
    tool: 'codex',
    options: { providerProfile: 'newapi-luna', model: 'luna-model' },
  });
  assert.equal(selCodex.agentType, 'codex');
  assert.equal(selCodex.providerProfileId, 'newapi-luna');
  const selScoped = resolveNativeSelectionFromManifest({
    tool: 'codex',
    options: { model: 'gpt-x@deepseek-relay' },
  });
  assert.equal(selScoped.providerProfileId, 'deepseek-relay');
  const selClaude = resolveNativeSelectionFromManifest({
    tool: 'claude-bidi',
    options: { providerProfile: 'claude-gw' },
  });
  assert.equal(selClaude.agentType, 'claude');

  const selCopilotScoped = resolveNativeSelectionFromManifest({
    tool: 'copilot',
    options: { model: 'gpt-5.3-codex@copilot-github' },
  });
  assert.equal(selCopilotScoped.agentType, 'harness');
  assert.equal(selCopilotScoped.harnessId, 'copilot');
  assert.equal(selCopilotScoped.providerProfileId, 'copilot-github');
  const selHermesScoped = resolveNativeSelectionFromManifest({
    tool: 'hermes',
    options: { model: 'claude-sonnet@hermes-anthropic' },
  });
  assert.equal(selHermesScoped.agentType, 'harness');
  assert.equal(selHermesScoped.harnessId, 'hermes');
  assert.equal(selHermesScoped.providerProfileId, 'hermes-anthropic');

  const selClineScoped = resolveNativeSelectionFromManifest({
    tool: 'cline',
    options: { model: 'gpt-cline@cline-gateway' },
  });
  assert.equal(selClineScoped.agentType, 'harness');
  assert.equal(selClineScoped.harnessId, 'cline');
  assert.equal(selClineScoped.providerProfileId, 'cline-gateway');
  const selKiloAlias = resolveNativeSelectionFromManifest({
    tool: 'kilo-code',
    options: { model: 'gpt-kilo@kilo-gateway' },
  });
  assert.equal(selKiloAlias.agentType, 'harness');
  assert.equal(selKiloAlias.harnessId, 'kilo');
  assert.equal(selKiloAlias.providerProfileId, 'kilo-gateway');

  await secretStore.writeSecret('cred-copilot', { authType: 'api-key', apiKey: 'github-pat' });
  await registry.upsertAuthProfile({
    id: 'auth-copilot', agentType: 'copilot', authType: 'api-key',
    displayName: 'Copilot', storageType: 'secret-store', storageRef: 'cred-copilot',
  });
  await registry.upsertProviderProfile({
    id: 'copilot-account-a', agentType: 'copilot', protocol: 'github-copilot',
    baseUrl: '', authProfileId: 'auth-copilot',
  });
  await registry.upsertProviderProfile({
    id: 'copilot-account-b', agentType: 'copilot', protocol: 'github-copilot',
    baseUrl: '', authProfileId: 'auth-copilot',
  });
  await secretStore.writeSecret('cred-cline', { authType: 'api-key', apiKey: 'cline-secret' });
  await registry.upsertAuthProfile({
    id: 'auth-cline', agentType: 'cline', authType: 'api-key',
    displayName: 'Cline', storageType: 'secret-store', storageRef: 'cred-cline',
  });
  await registry.upsertProviderProfile({
    id: 'cline-gateway', agentType: 'cline', protocol: 'openai-chat',
    baseUrl: 'https://cline.example/v1', authProfileId: 'auth-cline',
    modelPolicy: { defaultModel: 'gpt-cline' },
  });
  await secretStore.writeSecret('cred-kilo', { authType: 'api-key', apiKey: 'kilo-secret' });
  await registry.upsertAuthProfile({
    id: 'auth-kilo', agentType: 'kilo', authType: 'api-key',
    displayName: 'Kilo', storageType: 'secret-store', storageRef: 'cred-kilo',
  });
  await registry.upsertProviderProfile({
    id: 'kilo-gateway', agentType: 'kilo', protocol: 'openai-chat',
    baseUrl: 'https://kilo.example/v1', authProfileId: 'auth-kilo',
    modelPolicy: { defaultModel: 'gpt-kilo' },
  });
  await secretStore.writeSecret('cred-kimi', { authType: 'api-key', apiKey: 'kimi-secret' });
  await registry.upsertAuthProfile({
    id: 'auth-kimi', agentType: 'kimi-code', authType: 'api-key',
    displayName: 'Kimi', storageType: 'secret-store', storageRef: 'cred-kimi',
  });
  await registry.upsertProviderProfile({
    id: 'kimi-gateway', agentType: 'kimi-code', protocol: 'openai-chat',
    baseUrl: 'https://kimi.example/v1', authProfileId: 'auth-kimi',
    modelPolicy: { defaultModel: 'kimi-test-model' },
  });
  writeFileSync(
    join(configDir, 'native-provider-runtime', 'selection-usage.json'),
    JSON.stringify({ usage: {
      'harness:copilot': { providerId: 'copilot-account-a', at: '2026-08-28T00:00:00.000Z' },
    } }),
  );
  assert.equal(
    await resolveDefaultProviderProfileId('harness', {
      configDir,
      registry,
      readFileImpl: (path) => readFileSync(path, 'utf8'),
      harnessId: 'copilot',
    }),
    'copilot-account-a',
    'generic harness selection usage must remain scoped to the harness id',
  );

  const harnessHomesRoot = join(root, 'harness-provider-homes');
  const preparedCline = await prepareNativeRunProviderHome('run_cline_1', {
    tool: 'cline',
    options: { providerProfile: 'cline-gateway', model: 'gpt-cline' },
  }, { configDir, providerHomesRoot: harnessHomesRoot, runnerReadable: true });
  assert.equal(preparedCline.ok, true, preparedCline.error || preparedCline.reason);
  const clineHome = join(preparedCline.homeDir, 'cline');
  const clineSettings = JSON.parse(readFileSync(join(clineHome, 'settings', 'providers.json'), 'utf8'));
  assert.equal(clineSettings.lastUsedProvider, 'openai-native');
  assert.equal(clineSettings.providers['openai-native'].settings.model, 'gpt-cline');
  assert.doesNotMatch(readFileSync(join(clineHome, 'settings', 'providers.json'), 'utf8'), /cline-secret/);
  assert.equal(readFileSync(join(clineHome, '.agentoc-provider.env'), 'utf8').includes('cline-secret'), true);

  const preparedKilo = await prepareNativeRunProviderHome('run_kilo_1', {
    tool: 'kilo-code',
    options: { providerProfile: 'kilo-gateway', model: 'gpt-kilo' },
  }, { configDir, providerHomesRoot: harnessHomesRoot, runnerReadable: true });
  assert.equal(preparedKilo.ok, true, preparedKilo.error || preparedKilo.reason);
  const kiloHome = join(preparedKilo.homeDir, 'kilo');
  const kiloConfig = readFileSync(join(kiloHome, 'kilo.jsonc'), 'utf8');
  assert.match(kiloConfig, /"model": "agentoc\/gpt-kilo"/);
  assert.match(kiloConfig, /"npm": "@ai-sdk\/openai-compatible"/);
  assert.match(kiloConfig, /"env": \[\s*"AGENTOC_PROVIDER_API_KEY"\s*\]/);
  assert.match(kiloConfig, /"baseURL": "https:\/\/kilo\.example\/v1"/);
  assert.match(kiloConfig, /"context": 128000/);
  assert.doesNotMatch(kiloConfig, /"apiKey"/);
  assert.doesNotMatch(kiloConfig, /kilo-secret/);

  const preparedKimi = await prepareNativeRunProviderHome('run_kimi_1', {
    tool: 'kimi-code',
    options: { providerProfile: 'kimi-gateway', model: 'kimi-test-model' },
  }, { configDir, providerHomesRoot: harnessHomesRoot, runnerReadable: true });
  assert.equal(preparedKimi.ok, true, preparedKimi.error || preparedKimi.reason);
  const kimiHome = join(preparedKimi.homeDir, 'kimi-code');
  const kimiConfig = readFileSync(join(kimiHome, '.kimi-code', 'config.toml'), 'utf8');
  assert.match(kimiConfig, /default_model = "kimi-test-model"/);
  assert.match(kimiConfig, /base_url = "https:\/\/kimi\.example\/v1"/);
  assert.match(kimiConfig, /api_key = "kimi-secret"/);
  assert.match(readFileSync(join(kimiHome, '.agentoc-provider.env'), 'utf8'), /kimi-secret/);

  const homesRoot = join(root, 'provider-homes');
  // Regression: the root lifecycle broker may have created this provider key
  // before the transient runner starts.  Preparation must repair the whole
  // chain through the runner owner; a chmod on only the leaf is insufficient.
  const providerKey = createHash('sha256')
    .update('codex:newapi-luna')
    .digest('hex')
    .slice(0, 32);
  const staleKey = join(homesRoot, 'by-provider', providerKey);
  mkdirSync(staleKey, { recursive: true, mode: 0o700 });
  chmodSync(homesRoot, 0o700);
  chmodSync(join(homesRoot, 'by-provider'), 0o700);
  chmodSync(staleKey, 0o700);
  const prepared = await prepareNativeRunProviderHome('run_300', {
    tool: 'codex',
    options: { providerProfile: 'newapi-luna', model: 'luna-model' },
  }, {
    configDir,
    providerHomesRoot: homesRoot,
    runnerReadable: true,
    runnerOwnerUid: process.getuid?.() ?? null,
    runnerOwnerGid: process.getgid?.() ?? null,
  });
  assert.equal(prepared.ok, true, prepared.error || prepared.reason);
  assert.deepEqual(prepared.preparation, {
    state: 'ready',
    stage: 'verified',
    attempt: 1,
    maxAttempts: 1,
  }, 'native provider preparation must return verified Run evidence');
  // Windows ACLs are validated by the Windows Harness/runner checks; Node's
  // POSIX mode mask does not expose those ACLs and reports 0666-style values.
  if (process.platform !== 'win32') {
    for (const directory of [homesRoot, join(homesRoot, 'by-provider'), staleKey, join(staleKey, 'codex')]) {
      assert.equal(statSync(directory).mode & 0o777, 0o770, `runner directory must be group traversable: ${directory}`);
    }
  }
  const preparedHome = join(prepared.homeDir, 'codex');
  const preparedConfig = readFileSync(join(preparedHome, 'config.toml'), 'utf8');
  assert.ok(preparedConfig.includes('https://luna.example/v1'));
  assert.match(
    preparedConfig,
    /requires_openai_auth = true/,
    'native Codex API-key runs must load OPENAI_API_KEY from the isolated auth store',
  );

  const scopedPrepared = await prepareNativeRunProviderHome('run_301', {
    tool: 'codex',
    options: { model: 'luna-model@newapi-luna' },
  }, {
    configDir,
    providerHomesRoot: homesRoot,
    runnerReadable: true,
  });
  assert.equal(scopedPrepared.ok, true, scopedPrepared.error || scopedPrepared.reason);
  assert.match(
    readFileSync(join(scopedPrepared.homeDir, 'codex', 'config.toml'), 'utf8'),
    /model = "luna-model"/,
    'scoped model ids must be written to Codex config without the provider suffix',
  );
  const preparedAuth = JSON.parse(readFileSync(join(preparedHome, 'auth.json'), 'utf8'));
  assert.equal(preparedAuth.OPENAI_API_KEY, 'sk-luna');
  assert.equal(readFileSync(join(preparedHome, '.agentoc-provider-id'), 'utf8').trim(), 'newapi-luna');
  assert.ok(prepared.snapshot?.configHash, 'native prepare must return the frozen snapshot for provenance');

  // Native OAuth persistence: a provider refresh written by Codex into the
  // persistent home must be returned to the SecretStore before the next Run.
  const oauthHomeRoot = join(root, 'oauth-provider-homes');
  const preparedOAuth1 = await prepareNativeRunProviderHome('run_oauth_1', {
    tool: 'codex',
    options: { providerProfile: 'openai-official-a', model: 'gpt-5.5' },
  }, { configDir, providerHomesRoot: oauthHomeRoot, holdNativeOAuthLock: true });
  assert.ok(preparedOAuth1.oauthLock?.path, 'Codex OAuth preparation should return a handoff lock when requested');
  await preparedOAuth1.oauthLock.release();
  const oauthCodexHome = join(preparedOAuth1.homeDir, 'codex');
  const oauthAuthPath = join(oauthCodexHome, 'auth.json');
  const oauthStatePath = join(oauthCodexHome, '.agentoc-oauth-state.json');
  const oauthAuth1 = JSON.parse(readFileSync(oauthAuthPath, 'utf8'));
  const oauthState1 = JSON.parse(readFileSync(oauthStatePath, 'utf8'));
  assert.equal(oauthAuth1.tokens.access_token, 'at-1');
  assert.equal(oauthState1.sourceFingerprint, nativeOAuthTokenFingerprint(oauthAuth1.tokens));
  writeFileSync(oauthAuthPath, JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { access_token: 'at-2', refresh_token: 'rt-2', account_id: 'account-a', expiresAt: 2000 },
    last_refresh: '2026-08-16T12:00:00.000Z',
  }) + '\n');
  const preparedOAuth2 = await prepareNativeRunProviderHome('run_oauth_2', {
    tool: 'codex',
    options: { providerProfile: 'openai-official-a', model: 'gpt-5.5' },
  }, { configDir, providerHomesRoot: oauthHomeRoot });
  const storedOAuth = await secretStore.resolveSecret('cred-oauth');
  assert.equal(storedOAuth.tokens.access_token, 'at-2');
  assert.equal(storedOAuth.tokens.refresh_token, 'rt-2');
  assert.equal(JSON.parse(readFileSync(join(preparedOAuth2.homeDir, 'codex', 'auth.json'), 'utf8')).tokens.access_token, 'at-2');
  assert.equal(JSON.parse(readFileSync(oauthStatePath, 'utf8')).sourceFingerprint, nativeOAuthTokenFingerprint(storedOAuth.tokens));

  // A newer external re-login in the SecretStore must win over the runtime
  // file that still matches the previous recorded snapshot.
  await secretStore.writeSecret('cred-oauth', {
    authType: 'oauth',
    tokens: { access_token: 'at-3', refresh_token: 'rt-3', account_id: 'account-a', expiresAt: 3000 },
  });
  await prepareNativeRunProviderHome('run_oauth_3', {
    tool: 'codex',
    options: { providerProfile: 'openai-official-a', model: 'gpt-5.5' },
  }, { configDir, providerHomesRoot: oauthHomeRoot });
  const externallyUpdatedOAuth = await secretStore.resolveSecret('cred-oauth');
  assert.equal(externallyUpdatedOAuth.tokens.access_token, 'at-3');
  assert.equal(JSON.parse(readFileSync(oauthAuthPath, 'utf8')).tokens.access_token, 'at-3');

  // A concurrent refresh of the old account must not replace a newly logged
  // in different account, even when the old token has a later expiry.
  writeFileSync(oauthAuthPath, JSON.stringify({ OPENAI_API_KEY: null,
    tokens: { access_token: 'at-old-refresh', refresh_token: 'rt-old-refresh', account_id: 'account-a', expiresAt: 4000 } }) + '\n');
  await secretStore.writeSecret('cred-oauth', { authType: 'oauth',
    tokens: { access_token: 'at-new-account', refresh_token: 'rt-new-account', account_id: 'account-other', expiresAt: 3000 } });
  const brokerSocket = codexAppServerBrokerSocketPath(oauthCodexHome);
  const fakeLiveBroker = createServer(socket => socket.once('data', () => {
    socket.end(JSON.stringify({ type:'agentoc-codex-broker-pong', ready:true }) + '\n');
  }));
  await new Promise((resolve, reject) => fakeLiveBroker.once('error', reject).listen(brokerSocket, resolve));
  try {
    const blocked = await prepareNativeRunProviderHome('run_active_account_switch', { tool:'codex', options:{ providerProfile:'openai-official-a', model:'gpt-5.5' } },
      { configDir, providerHomesRoot:oauthHomeRoot });
    assert.equal(blocked.reason, 'codex-broker-account-changed');
    assert.equal(JSON.parse(readFileSync(oauthAuthPath, 'utf8')).tokens.account_id, 'account-a');
  } finally { await new Promise(resolve => fakeLiveBroker.close(resolve)); }
  const switchedAccount = await prepareNativeRunProviderHome('run_account_switch', { tool:'codex', options:{ providerProfile:'openai-official-a', model:'gpt-5.5' } },
    { configDir, providerHomesRoot:oauthHomeRoot });
  assert.equal(switchedAccount.ok, true, switchedAccount.error || switchedAccount.reason);
  assert.equal((await secretStore.resolveSecret('cred-oauth')).tokens.access_token, 'at-new-account');
  assert.equal(JSON.parse(readFileSync(oauthAuthPath, 'utf8')).tokens.account_id, 'account-other');
  await secretStore.writeSecret('cred-oauth', { authType: 'oauth',
    tokens: { access_token: 'at-3', refresh_token: 'rt-3', account_id: 'account-a', expiresAt: 3000 } });
  await prepareNativeRunProviderHome('run_account_restore', { tool:'codex', options:{ providerProfile:'openai-official-a', model:'gpt-5.5' } },
    { configDir, providerHomesRoot:oauthHomeRoot });

  if (process.platform === 'linux' && process.getuid?.() === 0) {
    let migrationCall = null;
    const migrated = await prepareNativeRunProviderHome('run_oauth_migration', {
      tool:'codex', options:{providerProfile:'openai-official-a',model:'gpt-5.5'},
    }, { configDir, providerHomesRoot:oauthHomeRoot, runnerReadable:true,
      runnerOwnerUid:1001, runnerOwnerGid:1002, previousRunnerOwnerUid:1000,
      chownImpl:async()=>{},
      migrateManagedHomeOwnershipImpl:async (home, identity) => {
        migrationCall = {home,identity,lockHeld:existsSync(join(home,'..','.agentoc-native-oauth.lock'))};
      },
    });
    assert.equal(migrated.ok,true, migrated.error || migrated.reason);
    assert.equal(migrationCall.home,oauthCodexHome);
    assert.deepEqual(migrationCall.identity,{targetUid:1001,targetGid:1002,additionalSourceUid:1000});
    assert.equal(migrationCall.lockHeld,true);
  }

  // External Codex ownership: a matching account_id keeps the external
  // auth.json as the single rotating credential source. The Run must still
  // use its generated CODEX_HOME config instead of importing external Codex
  // providers, MCP servers, or stale local config references.
  const externalCodexAuthFile = join(root, 'external-codex', 'auth.json');
  mkdirSync(join(root, 'external-codex'), { recursive: true });
  writeFileSync(externalCodexAuthFile, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: 'external-id-token',
      access_token: 'external-at-1',
      refresh_token: 'external-rt-1',
      account_id: 'account-a',
    },
    last_refresh: '2026-08-16T13:00:00.000Z',
  }) + '\n');
  // Pure-native Codex must ignore the external home even when it contains a
  // matching account. The native SecretStore remains the refresh owner.
  const nativeOnlyHomes = join(root, 'native-only-provider-homes');
  const preparedNativeOnly = await prepareNativeRunProviderHome('run_native_only', {
    tool: 'codex',
    options: { providerProfile: 'openai-official-a', model: 'gpt-5.5' },
  }, {
    configDir,
    providerHomesRoot: nativeOnlyHomes,
    externalCodexAuthFile,
    externalOAuthOwnership: false,
  });
  assert.equal(preparedNativeOnly.oauthOwner, 'agentoc');
  assert.equal(
    JSON.parse(readFileSync(join(preparedNativeOnly.homeDir, 'codex', 'auth.json'), 'utf8')).tokens.refresh_token,
    'rt-3',
  );
  // The old external-owner path must fail closed even when a caller explicitly
  // supplies ~/.codex/auth.json. Native Codex OAuth is machine-local and the
  // external file must remain untouched.
  const externalOwnerHomes = join(root, 'external-owner-provider-homes');
  const rejectedExternalOwner = await prepareNativeRunProviderHome('run_external_owner_rejected', {
    tool: 'codex',
    options: { providerProfile: 'openai-official-a', model: 'gpt-5.5' },
  }, {
    configDir,
    providerHomesRoot: externalOwnerHomes,
    externalCodexAuthFile,
    externalOAuthOwnership: true,
  });
  assert.equal(rejectedExternalOwner.ok, false);
  assert.equal(rejectedExternalOwner.reason, 'external-codex-oauth-disabled');
  assert.equal(JSON.parse(readFileSync(externalCodexAuthFile, 'utf8')).tokens.refresh_token, 'external-rt-1');

  // Claude setup-token is deliberately static: every Run gets its own config
  // directory and settings file, with no rotating refresh-token bundle.
  await secretStore.writeSecret('cred-claude-setup-token', {
    authType: 'oauth-token',
    token: 'claude-setup-token-test',
  });
  await registry.upsertProviderProfile({
    id: 'claude-setup-token',
    agentType: 'claude',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    authProfileId: 'auth-claude-setup-token',
    modelPolicy: { defaultModel: 'claude-sonnet' },
  });
  await registry.upsertAuthProfile({
    id: 'auth-claude-setup-token',
    agentType: 'claude',
    authType: 'oauth-token',
    displayName: 'Claude Setup Token',
    storageType: 'secret-store',
    storageRef: 'cred-claude-setup-token',
  });
  const [preparedSetupTokenA, preparedSetupTokenB] = await Promise.all([
    prepareNativeRunProviderHome('run_claude_setup_a', {
      tool: 'claude-bidi',
      options: { providerProfile: 'claude-setup-token', model: 'claude-sonnet' },
    }, { configDir, providerHomesRoot: oauthHomeRoot }),
    prepareNativeRunProviderHome('run_claude_setup_b', {
      tool: 'claude-bidi',
      options: { providerProfile: 'claude-setup-token', model: 'claude-sonnet' },
    }, { configDir, providerHomesRoot: oauthHomeRoot }),
  ]);
  assert.equal(preparedSetupTokenA.ok, true, preparedSetupTokenA.error || preparedSetupTokenA.reason);
  assert.equal(preparedSetupTokenB.ok, true, preparedSetupTokenB.error || preparedSetupTokenB.reason);
  assert.notEqual(preparedSetupTokenA.homeDir, preparedSetupTokenB.homeDir);
  for (const preparedSetupToken of [preparedSetupTokenA, preparedSetupTokenB]) {
    const claudeHome = join(preparedSetupToken.homeDir, 'claude');
    const settings = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8'));
    assert.equal(settings.env.CLAUDE_CODE_OAUTH_TOKEN, 'claude-setup-token-test');
    assert.equal(existsSync(join(claudeHome, '.credentials.json')), false);
  }

  // Claude gateway prepare writes the settings.json env contract.
  const preparedClaude = await prepareNativeRunProviderHome('run_301', {
    tool: 'claude-bidi',
    options: { providerProfile: 'claude-gw', model: 'claude-x' },
  }, { configDir, providerHomesRoot: homesRoot, runnerReadable: true });
  assert.equal(preparedClaude.ok, true, preparedClaude.error || preparedClaude.reason);
  const claudeSettings = JSON.parse(readFileSync(join(preparedClaude.homeDir, 'claude', 'settings.json'), 'utf8'));
  assert.equal(claudeSettings.env.ANTHROPIC_BASE_URL, 'https://cgw.example');
  assert.equal(claudeSettings.env.ANTHROPIC_API_KEY, 'tok');

  // Claude scoped ids select the provider exactly like codex ones.
  const selClaudeScoped = resolveNativeSelectionFromManifest({
    tool: 'claude-bidi',
    options: { model: 'opus@claude-gw' },
  });
  assert.equal(selClaudeScoped.providerProfileId, 'claude-gw');

  // Implicit selection resolves to the deterministic default instead of a
  // refusal. External Codex observations no longer mutate this local choice.
  const implicitSelection = await prepareNativeRunProviderHome('run_302', {
    tool: 'codex',
    options: { model: 'gpt-x' },
  }, { configDir, providerHomesRoot: homesRoot });
  assert.equal(implicitSelection.ok, true, implicitSelection.error || implicitSelection.reason);
  assert.equal(implicitSelection.providerId, 'openai-official-a');
  assert.equal(
    readFileSync(join(implicitSelection.homeDir, 'codex', '.agentoc-provider-id'), 'utf8').trim(),
    'openai-official-a',
  );

  // Two different providers prepare into different scoped homes; no overwrite.
  const preparedDeepseek = await prepareNativeRunProviderHome('run_303', {
    tool: 'codex',
    options: { providerProfile: 'deepseek-relay', model: 'ds-flash' },
  }, { configDir, providerHomesRoot: homesRoot, runnerReadable: true });
  assert.notEqual(preparedDeepseek.homeDir, prepared.homeDir);
  assert.equal(
    readFileSync(join(prepared.homeDir, 'codex', '.agentoc-provider-id'), 'utf8').trim(),
    'newapi-luna',
    'preparing another provider must not disturb the first scoped home',
  );

  console.log('test-native-provider-runtime: all assertions passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

function nullProxyStore() {
  return {
    describeSecret: async () => ({ ok: false, reason: 'not-found' }),
  };
}
