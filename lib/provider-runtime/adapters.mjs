// Runtime adapters: turn a frozen RunConfigSnapshot into an isolated Codex or
// Claude process environment.  Each Run gets its own runtime home directory
// (one per provider+run), so two Runs using different providers or accounts
// never share mutable state.  The adapter owns WHERE credentials live; no
// other module may know auth.json paths.
//
// Contract with the launch layer: prepareRuntime(snapshot) returns
//   { env, codexHomeDir?/claudeConfigDir?, attestation }
// The caller merges env over the sanitized base environment, spawns the agent
// process, and fails closed when attestation.ok is false.

import { createHash } from 'crypto';
import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Deterministic per-(provider, run) home: two concurrent Runs on the same
// provider never write into one shared directory mid-flight.
export function runScopedRuntimeDir(runtimeRoot, providerProfileId, runId) {
  const providerKey = createHash('sha256')
    .update(String(providerProfileId || 'unknown'))
    .digest('hex')
    .slice(0, 16);
  const runKey = createHash('sha256')
    .update(String(runId || 'unknown'))
    .digest('hex')
    .slice(0, 16);
  return join(runtimeRoot, 'run-scoped', `${providerKey}-${runKey}`);
}

// —— Codex ——
//
// API-key providers: config.toml declares a named model_provider whose
// env_key points at AGENTOC_RUNTIME_API_KEY; the adapter injects that env var
// at spawn.  Codex reads credentials from the process env, so nothing secret
// needs to be written into the runtime home at all.
//
// OAuth (official ChatGPT) providers: the runtime home carries auth.json
// (the boolean file-store switch keeps cli_auth_credentials_store enabled so
// CODEX_HOME isolation actually isolates), written fresh from the vault at
// Run preparation.  Official rows keep codex's own refresh flow intact.
export async function prepareCodexRuntime(snapshot, {
  runtimeRoot,
  secretStore,
  baseEnv = {},
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  chmodImpl = chmod,
  readFileImpl = readFile,
} = {}) {
  if (!snapshot || snapshot.agentType !== 'codex') {
    return { ok: false, reason: 'agent-type-mismatch' };
  }
  const homeDir = runScopedRuntimeDir(runtimeRoot, snapshot.providerProfileId, snapshot.runId);
  await mkdirImpl(join(homeDir), { recursive: true, mode: 0o700 });

  const env = { ...baseEnv, CODEX_HOME: homeDir };
  const isOAuth = snapshot.authType === 'oauth';
  let authMode = '';
  if (isOAuth) {
    const secret = await secretStore.resolveSecret(storageRefOf(snapshot));
    if (!secret?.ok || secret.authType !== 'oauth') {
      return { ok: false, reason: 'credential-not-oauth' };
    }
    await writeFileImpl(
      join(homeDir, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: null, tokens: secret.tokens, last_refresh: null }) + '\n',
      { mode: 0o600 },
    );
    await chmodImpl(join(homeDir, 'auth.json'), 0o600).catch(() => {});
    authMode = 'chatgpt-oauth';
  } else {
    const secret = await secretStore.resolveSecret(storageRefOf(snapshot));
    if (!secret?.ok || secret.authType !== 'api-key') {
      return { ok: false, reason: 'credential-not-api-key' };
    }
    env.AGENTOC_RUNTIME_API_KEY = secret.apiKey;
    authMode = 'env-api-key';
  }

  const configToml = renderCodexConfigToml(snapshot, { authMode });
  await writeFileImpl(join(homeDir, 'config.toml'), configToml, { mode: 0o600 });
  await chmodImpl(join(homeDir, 'config.toml'), 0o600).catch(() => {});

  // Attestation: read back what codex will actually load and compare against
  // the frozen snapshot (fail closed on drift).
  const loadedConfig = await readFileImpl(join(homeDir, 'config.toml'), 'utf8')
    .catch(() => '');
  const attestation = loadedConfig.includes(`model = ${JSON.stringify(snapshot.model)}`)
    && (authMode === 'env-api-key'
      ? loadedConfig.includes(`base_url = ${JSON.stringify(snapshot.baseUrl)}`)
      : loadedConfig.includes('requires_openai_auth = true'))
    ? { ok: true, authMode, codexHomeDir: homeDir }
    : { ok: false, reason: 'runtime-config-mismatch', authMode, codexHomeDir: homeDir };

  return {
    ok: attestation.ok,
    reason: attestation.ok ? null : attestation.reason,
    env,
    codexHomeDir: homeDir,
    authMode,
    attestation,
  };
}

function storageRefOf(snapshot) {
  return snapshot.authStorageRef || '';
}

function isOfficialCodexEndpoint(baseUrl) {
  const url = trimString(baseUrl);
  if (!url) return true; // official rows may omit the endpoint override
  try {
    const host = new URL(url).hostname;
    return /(^|\.)openai\.com$/.test(host) || /(^|\.)chatgpt\.com$/.test(host);
  } catch {
    return false;
  }
}

function renderCodexConfigToml(snapshot, { authMode }) {
  const lines = [
    '# AgentoC native runtime — generated per Run; do not edit.',
    `# snapshot ${snapshot.configHash}`,
    `model = ${JSON.stringify(snapshot.model)}`,
  ];
  if (snapshot.serviceTier === 'fast') {
    lines.push('service_tier = "fast"');
  }
  if (authMode === 'env-api-key') {
    lines.push(
      'model_provider = "agentoc-runtime-provider"',
      '',
      '[model_providers.agentoc-runtime-provider]',
      'name = "AgentoC Runtime Provider"',
      `base_url = ${JSON.stringify(snapshot.baseUrl)}`,
      // Codex is the client of this runtime. Its wire protocol stays
      // Responses; snapshot.protocol describes the upstream format and is
      // consumed by the compatible conversion gateway, when one is used.
      'wire_api = "responses"',
      'env_key = "AGENTOC_RUNTIME_API_KEY"',
    );
  } else {
    // Official ChatGPT-auth provider: requires_openai_auth keeps codex on its
    // own OAuth credential in $CODEX_HOME/auth.json.
    lines.push(
      'model_provider = "agentoc-official"',
      '',
      '[model_providers.agentoc-official]',
      'name = "AgentoC Official ChatGPT"',
      `base_url = ${JSON.stringify(snapshot.baseUrl || 'https://chatgpt.com/backend-api/codex')}`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
    );
  }
  lines.push(
    '',
    '[features]',
    'plugins = false',
    'unified_exec = false',
    '',
    // Force the file credential store so CODEX_HOME isolation is the real
    // account boundary (OS keyring would be shared across CODEX_HOMEs).
    'cli_auth_credentials_store = true',
    '',
  );
  return lines.join('\n');
}

// —— Claude ——
//
// API/gateway providers are pure env: ANTHROPIC_BASE_URL + auth token or API
// key, nothing written to disk.  Claude's rotating normal OAuth bundle is not
// an AgentoC credential mode; subscription accounts must use setup-token so
// independent Runs never receive a copy of a refresh-token chain.
export async function prepareClaudeRuntime(snapshot, {
  runtimeRoot,
  secretStore,
  baseEnv = {},
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  chmodImpl = chmod,
} = {}) {
  if (!snapshot || snapshot.agentType !== 'claude') {
    return { ok: false, reason: 'agent-type-mismatch' };
  }
  const env = { ...baseEnv };
  const isSetupToken = snapshot.authType === 'oauth-token';
  let authMode = '';
  let claudeConfigDir = '';
  if (snapshot.authType === 'oauth') {
    return {
      ok: false,
      reason: 'claude-oauth-unsupported',
      error: 'Claude normal OAuth is unsupported; use claude setup-token and save the setup token in Ragent.',
    };
  } else if (isSetupToken) {
    const secret = await secretStore.resolveSecret(storageRefOf(snapshot));
    if (!secret?.ok || secret.authType !== 'oauth-token') {
      return { ok: false, reason: 'credential-not-oauth-token' };
    }
    env.CLAUDE_CODE_OAUTH_TOKEN = secret.token;
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP = '1';
    authMode = 'env-oauth-token';
  } else {
    const secret = await secretStore.resolveSecret(storageRefOf(snapshot));
    if (!secret?.ok || secret.authType !== 'api-key') {
      return { ok: false, reason: 'credential-not-api-key' };
    }
    env.ANTHROPIC_BASE_URL = snapshot.baseUrl;
    env.ANTHROPIC_API_KEY = secret.apiKey;
    // Managed-provider hardening mirrored from runtime-policy: stop Claude
    // Code from remapping model aliases through legacy provider defaults.
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP = '1';
    authMode = 'env-api-key';
  }
  return {
    ok: true,
    env,
    claudeConfigDir,
    authMode,
    attestation: { ok: true, authMode, claudeConfigDir },
  };
}

function isOfficialClaudeEndpoint(baseUrl) {
  const url = trimString(baseUrl);
  if (!url) return true;
  try {
    const host = new URL(url).hostname;
    return /(^|\.)anthropic\.com$/.test(host) || /(^|\.)claude\.ai$/.test(host);
  } catch {
    return false;
  }
}
