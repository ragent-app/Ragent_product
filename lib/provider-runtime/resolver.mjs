// RuntimeConfigResolver + immutable RunConfigSnapshot + EnvSanitizer.
//
// This is the heart of the native provider runtime: provider selection is
// resolved exactly once per Run, frozen into a snapshot with a content hash,
// and never re-resolved.  Changing a Session's provider afterwards creates a
// different snapshot on the next Run; it can never mutate a live Run.
//
// Invariants implemented here (see docs/adr/0005-native-provider-runtime.md):
//   I2 changing session provider must not mutate an existing run
//   I5 host environment must not determine provider authentication
//   I6 provider selection is resolved before process spawn
//   I8 frontend selected state is not effective runtime state (resolution
//      fails closed when the desired selection cannot resolve)

import { createHash } from 'crypto';
import { WORKBENCH_EXECUTION_POLICY, assertWorkbenchExecution } from '../workbench-execution-policy.mjs';
import { resolveCodexServiceTier } from '../codex-service-tier.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Native model catalogs scope ids as `model@providerId` so identical model
// names can coexist across credentials. The provider CLI must receive only
// the upstream model id; the profile id is resolved separately.
export function bareProviderModel(value) {
  const raw = trimString(value);
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return raw;
  return /^[A-Za-z0-9._-]+$/.test(raw.slice(at + 1)) ? raw.slice(0, at) : raw;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value ?? null);
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

// —— EnvSanitizer ——
//
// The host environment must never decide provider auth.  Strip every LLM
// provider/credential-shaped variable, keep OS basics, then let the runtime
// adapter inject the snapshot-resolved values.

export const PROVIDER_ENV_STRIP_PATTERNS = [
  /^OPENAI_API_KEY$/i,
  /^OPENAI_BASE_URL$/i,
  /^OPENAI_API_BASE$/i,
  /^CODEX_API_KEY$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^ANTHROPIC_AUTH_TOKEN$/i,
  /^ANTHROPIC_BASE_URL$/i,
  /^ANTHROPIC_MODEL$/i,
  /^ANTHROPIC_DEFAULT_(HAIKU|SONNET|OPUS|FABLE)_MODEL(_NAME)?$/i,
  /^ANTHROPIC_SMALL_FAST_MODEL$/i,
  /^CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST$/i,
  /^CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP$/i,
  /^GEMINI_API_KEY$/i,
  /^GOOGLE_API_KEY$/i,
  /^OPENROUTER_API_KEY$/i,
  /^DEEPSEEK_API_KEY$/i,
  // Credential-shaped catch-all (mirrors runner-env SECRET_ENV_KEY_PATTERN):
  // anything token/secret/key/auth-shaped that an adapter did not inject on
  // purpose is host pollution.
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|API_KEY|APIKEY|CREDENTIAL|AUTH)/,
];

export const ENV_BASE_ALLOWLIST = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'USER', 'LOGNAME',
  'SHELL', 'EDITOR', 'VISUAL', 'PAGER', 'TMPDIR', 'TMP', 'TEMP',
];

export function sanitizeRuntimeEnvironment(source = {}) {
  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined || value === null) continue;
    if (ENV_BASE_ALLOWLIST.includes(key)) {
      env[key] = String(value);
      continue;
    }
    if (PROVIDER_ENV_STRIP_PATTERNS.some((pattern) => pattern.test(key))) continue;
    // Non-allowlisted, non-provider keys (AGENTOC_* runtime hints etc.) pass
    // through; the launch layer's runner-env strip gate still removes
    // control-plane secrets before spawn.
    env[key] = String(value);
  }
  // HOME is decided by the launch layer (runner OS user), never inherited
  // verbatim from a possibly control-plane environment.
  return env;
}

// —— Resolution ——

export class RuntimeConfigResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeConfigResolutionError';
    this.code = code;
  }
}

// Selection precedence: explicit run request > session default.  The caller
// owns where those come from; the resolver only merges them deterministically.
export function resolveRunSelection({ runRequest = {}, sessionDefaults = {} } = {}) {
  const agentType = trimString(runRequest.agentType) || trimString(sessionDefaults.agentType);
  const providerProfileId = trimString(runRequest.providerProfileId)
    || trimString(sessionDefaults.providerProfileId);
  const model = trimString(runRequest.model) || trimString(sessionDefaults.model);
  const serviceTier = trimString(runRequest.serviceTier)
    || trimString(sessionDefaults.serviceTier);
  return { agentType, providerProfileId, model, serviceTier };
}

function providerModelSupportsFast(provider, model) {
  const modelId = bareProviderModel(model);
  const models = Array.isArray(provider?.modelPolicy?.models)
    ? provider.modelPolicy.models
    : [];
  const entry = models.find((candidate) => bareProviderModel(candidate?.id) === modelId);
  return entry?.capabilities?.serviceTier?.supportsFast === true;
}

// Resolve the effective runtime for one Run.  Reads registries + secret
// metadata (never the secret value itself — the adapter resolves that at
// spawn), freezes a snapshot, and computes its config hash.  The snapshot is a
// plain frozen object; any attempt to mutate it in-process throws.
export async function resolveRuntimeConfig({
  runRequest = {},
  sessionDefaults = {},
  registry,
  secretStore,
  // Internal catalog preparation can enumerate official models before one is selected.
  allowModelLessCodexOAuthCatalog = false,
  now = () => new Date().toISOString(),
} = {}) {
  if (!registry || typeof registry.getProviderProfile !== 'function') {
    throw new RuntimeConfigResolutionError('registry-missing', 'A provider registry is required');
  }
  const selection = resolveRunSelection({ runRequest, sessionDefaults });
  assertWorkbenchExecution({ agentType: selection.agentType, providerProfileId: selection.providerProfileId });
  if (!selection.agentType) {
    throw new RuntimeConfigResolutionError('agent-type-missing', 'No agent type resolved for the run');
  }
  if (!selection.providerProfileId) {
    throw new RuntimeConfigResolutionError('provider-missing', 'No provider profile resolved for the run');
  }

  const provider = await registry.getProviderProfile(selection.providerProfileId);
  if (!provider) {
    throw new RuntimeConfigResolutionError(
      'provider-not-found',
      `Provider profile does not exist: ${selection.providerProfileId}`,
    );
  }
  if (selection.agentType !== 'harness' && provider.agentType !== selection.agentType) {
    throw new RuntimeConfigResolutionError(
      'provider-agent-mismatch',
      `Provider ${provider.id} serves ${provider.agentType}, run requested ${selection.agentType}`,
    );
  }

  const authProfile = await registry.getAuthProfile(provider.authProfileId);
  if (!authProfile) {
    throw new RuntimeConfigResolutionError(
      'auth-profile-not-found',
      `Auth profile does not exist: ${provider.authProfileId}`,
    );
  }
  if (selection.agentType !== 'harness' && authProfile.agentType !== selection.agentType) {
    throw new RuntimeConfigResolutionError(
      'auth-agent-mismatch',
      `Auth profile ${authProfile.id} serves ${authProfile.agentType}, run requested ${selection.agentType}`,
    );
  }
  if (selection.agentType === 'claude' && authProfile.authType === 'oauth') {
    throw new RuntimeConfigResolutionError(
      'claude-oauth-unsupported',
      'Claude normal OAuth is no longer supported; use claude setup-token on this machine or an API key.',
    );
  }

  // Credential presence check without resolving the value: fail closed at
  // resolve time when the vault entry is missing, instead of at spawn.
  const secretStatus = secretStore ? await secretStore.describeSecret(authProfile.storageRef) : null;
  if (secretStore && !secretStatus?.ok) {
    throw new RuntimeConfigResolutionError(
      'credential-missing',
      `Credential ${authProfile.storageRef} is not available (${secretStatus?.reason || 'unknown'})`,
    );
  }

  const model = bareProviderModel(selection.model)
    || WORKBENCH_EXECUTION_POLICY?.model
    || bareProviderModel(provider.modelPolicy?.defaultModel)
    || '';
  assertWorkbenchExecution({ agentType: selection.agentType, model, authType: authProfile.authType, providerProfileId: provider.id });
  // AgY delegates model defaulting to its CLI.  A missing model is therefore a
  // valid native snapshot and must not be replaced with a fake --model value.
  if (!model && selection.agentType !== 'agy'
      && !(allowModelLessCodexOAuthCatalog && selection.agentType === 'codex' && authProfile.authType === 'oauth')) {
    throw new RuntimeConfigResolutionError('model-missing', 'No model resolved for the run');
  }

  // Codex fast mode is enabled for official OAuth and for an API-key model only
  // when that model's upstream catalog explicitly declared support.  A caller
  // cannot turn an unknown or stale provider into fast mode by sending the
  // serviceTier value alone.
  const serviceTier = selection.agentType === 'codex'
    ? resolveCodexServiceTier(selection.serviceTier, {
      official: authProfile.authType === 'oauth'
        || providerModelSupportsFast(provider, model),
    })
    : 'standard';

  const accountMetadata = authProfile.accountMetadata
    && typeof authProfile.accountMetadata === 'object'
    && !Array.isArray(authProfile.accountMetadata)
    ? authProfile.accountMetadata
    : {};
  const credentialVersion = Number(accountMetadata.credentialVersion);
  const credentialInstanceId = trimString(accountMetadata.credentialInstanceId);

  const snapshot = Object.freeze({
    schemaVersion: 1,
    runId: trimString(runRequest.runId),
    // Third-party harnesses consume a source ProviderProfile. Keep the
    // profile's native agent type in the snapshot so credential/protocol
    // semantics remain explicit while the run selection records `harness`.
    agentType: provider.agentType,
    providerProfileId: provider.id,
    providerRevision: provider.revision,
    authProfileId: authProfile.id,
    authRevision: authProfile.revision,
    authType: authProfile.authType,
    // Vault pointer (not a secret) so adapters resolve the credential without
    // any other module knowing where secrets live.
    authStorageRef: authProfile.storageRef,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    model,
    serviceTier,
    credentialFingerprint: secretStatus?.fingerprint || null,
    ...(Number.isSafeInteger(credentialVersion) && credentialVersion >= 0
      ? { credentialVersion }
      : {}),
    ...(credentialInstanceId ? { credentialInstanceId } : {}),
    resolvedAt: now(),
  });
  const configHash = computeSnapshotHash(snapshot);
  return Object.freeze({ ...snapshot, configHash });
}

export function computeSnapshotHash(snapshot) {
  const { configHash: _omitted, ...hashable } = snapshot || {};
  return `sha256:${createHash('sha256').update(stableJson(hashable)).digest('hex').slice(0, 32)}`;
}

// Effective-vs-desired attestation helper: compare a snapshot against what
// the runtime reports it actually loaded (adapter ACK).  Any mismatch fails
// closed (RUNTIME_CONFIG_MISMATCH).
export function assertSnapshotMatches(snapshot, effective) {
  if (!snapshot || !effective) {
    return { ok: false, reason: 'missing-input' };
  }
  const mismatches = [];
  for (const key of ['agentType', 'providerProfileId', 'authProfileId', 'model', 'baseUrl', 'serviceTier']) {
    if (trimString(snapshot[key]) !== trimString(effective[key])) {
      mismatches.push(key);
    }
  }
  if (trimString(snapshot.configHash) !== trimString(effective.configHash)) {
    mismatches.push('configHash');
  }
  return { ok: mismatches.length === 0, mismatches };
}
