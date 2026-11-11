#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildProviderContractFields,
  classifyProviderError,
  getGatedPermissionModeId,
  getProviderCapabilities,
  getProviderPermissionModes,
  hasProviderCapability,
  resolveProviderPermissionPolicy,
  resolveProviderCapabilities,
} from '../chat/provider-contract.mjs';
import { buildRuntimeInvocation } from '../chat/process-runner.mjs';

const claudeCapabilities = getProviderCapabilities('claude-stream-json');
assert.equal(claudeCapabilities.provider, 'claude');
assert.equal(claudeCapabilities.supportsTextDelta, true);
assert.equal(claudeCapabilities.supportsToolEvents, true);
assert.equal(claudeCapabilities.supportsPlanArtifact, false);
assert.equal(claudeCapabilities.supportsStructuredPlanFallback, true);
assert.equal(claudeCapabilities.supportsResume, true);
assert.equal(hasProviderCapability({ runtimeFamily: 'claude-stream-json' }, 'supportsManagedActionMcp'), false);
assert.equal(claudeCapabilities.supportsExternalUsageProjection, false);
assert.equal(claudeCapabilities.permissionModel, 'claude-code-tools');
assert.deepEqual(
  getProviderPermissionModes('claude-stream-json').map((mode) => mode.id),
  ['acceptEdits', 'auto', 'dontAsk', 'default', 'plan', 'bypassPermissions'],
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json', { dangerouslySkipPermissions: true }).id,
  'bypassPermissions',
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json', { permissionMode: 'skip-permissions' }).claudePermissionMode,
  'bypassPermissions',
);

const codexCliCapabilities = getProviderCapabilities('codex-json');
assert.equal(codexCliCapabilities.provider, 'codex');
assert.equal(codexCliCapabilities.supportsPlanArtifact, true);
assert.equal(codexCliCapabilities.supportsInterrupt, false);
assert.equal(codexCliCapabilities.supportsExternalUsageProjection, true);
assert.equal(codexCliCapabilities.permissionModel, 'codex-approval-sandbox');
assert.deepEqual(
  getProviderPermissionModes('codex-json').map((mode) => mode.id),
  [
    'untrusted-read-only',
    'untrusted-workspace-write',
    'untrusted-danger-full-access',
    'on-request-read-only',
    'on-request-workspace-write',
    'on-request-danger-full-access',
    'on-failure-read-only',
    'on-failure-workspace-write',
    'on-failure-danger-full-access',
    'never-read-only',
    'never-workspace-write',
    'never-danger-full-access',
    'bypass-approvals-and-sandbox',
  ],
);
assert.equal(
  resolveProviderPermissionPolicy('codex-json', { interactionMode: 'plan' }).sandbox,
  'read-only',
);
// Claude plan mode is an approval mode: the bidi runtime (which has a
// permission channel) resolves interactionMode 'plan' to the plan permission
// mode so the composer Plan agent actually enters plan mode.
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { interactionMode: 'plan' }).id,
  'plan',
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { interactionMode: 'plan' }).claudePermissionMode,
  'plan',
);
assert.equal(hasProviderCapability({ runtimeFamily: 'claude-stream-json-bidi' }, 'supportsManagedActionMcp'), true);
// An explicit permissionMode still wins over interactionMode.
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { interactionMode: 'plan', permissionMode: 'bypassPermissions' }).id,
  'bypassPermissions',
);
// One-shot claude-stream-json has no permission channel, so plan mode must NOT
// be forced there (a run would stall waiting for a prompt nobody can answer).
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json', { interactionMode: 'plan' }).id,
  'bypassPermissions',
);
assert.equal(
  resolveProviderPermissionPolicy('codex-json', { permissionMode: 'full-access' }).canonicalId,
  'never-danger-full-access',
);
assert.equal(
  resolveProviderPermissionPolicy('codex-json', { permissionMode: 'bypass-approvals-and-sandbox' }).dangerouslyBypassApprovalsAndSandbox,
  true,
);

const codexAppServerCapabilities = getProviderCapabilities('codex-app-server-json');
assert.equal(codexAppServerCapabilities.transport, 'json-rpc-stdio');
assert.equal(codexAppServerCapabilities.supportsInterrupt, true);
assert.equal(codexAppServerCapabilities.supportsManagedActionMcp, true);
assert.equal(codexAppServerCapabilities.supportsRevise, true);
assert.equal(codexAppServerCapabilities.supportsExternalUsageProjection, false);

const copilotCapabilities = getProviderCapabilities('copilot-json');
assert.equal(copilotCapabilities.provider, 'copilot');
assert.equal(copilotCapabilities.supportsExternalUsageProjection, false);

const clineCapabilities = getProviderCapabilities('cline-json');
assert.equal(clineCapabilities.provider, 'cline');
assert.equal(clineCapabilities.supportsResume, true);
assert.equal(clineCapabilities.supportsTextDelta, true);
assert.equal(clineCapabilities.supportsReasoningDelta, true);
assert.equal(clineCapabilities.supportsToolEvents, true);

const kiloCapabilities = getProviderCapabilities('kilo-json');
assert.equal(kiloCapabilities.provider, 'kilo');
assert.equal(kiloCapabilities.supportsResume, true);
assert.equal(kiloCapabilities.supportsToolEvents, true);
assert.equal(kiloCapabilities.supportsApproval, false);

const agyLegacyCapabilities = getProviderCapabilities('agy-json');
assert.equal(agyLegacyCapabilities.supportsToolEvents, false);
const agyStreamCapabilities = getProviderCapabilities('agy-stream-json');
assert.equal(agyStreamCapabilities.provider, 'antigravity');
assert.equal(agyStreamCapabilities.transport, 'process-jsonl');
assert.equal(agyStreamCapabilities.supportsToolEvents, true);
assert.equal(agyStreamCapabilities.supportsInterrupt, false);
assert.equal(agyStreamCapabilities.supportsSteer, false);
assert.equal(agyStreamCapabilities.supportsQueuedMessageMutations, true);
assert.equal(hasProviderCapability('agy-stream-json', 'supportsManagedActionMcp'), false);
const codexContract = buildProviderContractFields('codex-app-server-json');
assert.equal(codexContract.providerCapabilities.supportsSemanticHydrate, true);
assert.equal(codexContract.providerCapabilities.contextCompiler, 'runtime-context-compiler-v1');
const agyContract = buildProviderContractFields('agy-stream-json');
assert.equal(agyContract.providerCapabilities.supportsSemanticHydrate, true);
assert.equal(agyContract.providerCapabilities.supportsResume, false);

assert.equal(getProviderCapabilities('missing-runtime'), null);
assert.deepEqual(
  buildProviderContractFields('missing-runtime', {
    provider: 'custom',
    providerCapabilities: {
      provider: 'custom',
      runtimeFamily: 'missing-runtime',
      supportsTextDelta: false,
    },
  }),
  {
    provider: 'custom',
    runtimeFamily: 'missing-runtime',
    providerCapabilities: {
      provider: 'custom',
      runtimeFamily: 'missing-runtime',
      supportsTextDelta: false,
    },
  },
);

assert.deepEqual(
  classifyProviderError('unexpected status 401 Unauthorized: Missing bearer token'),
  {
    type: 'auth_missing',
    retryable: false,
    message: 'unexpected status 401 Unauthorized: Missing bearer token',
  },
);
assert.equal(classifyProviderError('HTTP 429 rate limit exceeded').type, 'rate_limited');
assert.equal(classifyProviderError('Operation not permitted by sandbox').type, 'sandbox_denied');
assert.equal(classifyProviderError('socket hang up').type, 'transport_broken');
assert.equal(classifyProviderError({ error: { message: 'model unavailable' } }).type, 'model_unavailable');

const invocation = buildRuntimeInvocation('codex-app-server-json', 'hello', {
  interactionMode: 'plan',
}, 'codex');
assert.equal(invocation.capabilities.provider, 'codex');
assert.equal(invocation.capabilities.supportsInterrupt, true);
assert.equal(invocation.capabilities.supportsExternalUsageProjection, false);
assert.equal(invocation.permissionMode, 'never-read-only');
assert.equal(invocation.isCodexAppServerFamily, true);

// `full-auto` is an AgentoC risk mode, not a provider CLI flag. The runtime
// contract maps it to the selected harness's native permission behavior.
if (process.platform === 'win32') {
  assert.throws(() => buildRuntimeInvocation('codex-json', 'hello', { riskMode: 'full-auto' }, 'codex-cli'), { code: 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME' });
} else {
  const codexFullAutoInvocation = buildRuntimeInvocation('codex-json', 'hello', { riskMode: 'full-auto' }, 'codex-cli');
  assert.equal(codexFullAutoInvocation.args.includes('--full-auto'), false);
  assert.equal(codexFullAutoInvocation.args.includes('--dangerously-bypass-approvals-and-sandbox'), true);
}
const codexGatedInvocation = buildRuntimeInvocation('codex-app-server-json', 'hello', {
  riskMode: 'recommended',
}, 'codex');
assert.equal(codexGatedInvocation.args.includes('--full-auto'), false);
assert.equal(codexGatedInvocation.permissionMode, 'untrusted-danger-full-access');

const claudeBidiInvocation = buildRuntimeInvocation('claude-stream-json-bidi', 'hello', {}, 'claude-bidi');
assert.equal(claudeBidiInvocation.capabilities.provider, 'claude');
assert.equal(claudeBidiInvocation.capabilities.transport, 'process-jsonl-bidi');
assert.equal(claudeBidiInvocation.capabilities.supportsSteer, true);
assert.equal(claudeBidiInvocation.capabilities.supportsInterrupt, true);
assert.equal(claudeBidiInvocation.capabilities.supportsPlanArtifact, false);

assert.equal(hasProviderCapability('codex-json', 'supportsExternalUsageProjection'), true);
assert.equal(hasProviderCapability(invocation, 'supportsExternalUsageProjection'), false);
assert.equal(hasProviderCapability({ capabilities: { supportsExternalUsageProjection: true } }, 'supportsExternalUsageProjection'), true);
assert.deepEqual(
  resolveProviderCapabilities({
    runtimeFamily: 'custom-runtime',
    providerCapabilities: {
      provider: 'custom',
      runtimeFamily: 'custom-runtime',
      supportsExternalUsageProjection: true,
    },
  }),
  {
    provider: 'custom',
    runtimeFamily: 'custom-runtime',
    supportsExternalUsageProjection: true,
  },
);

// --- privileged-approval gate (design §13–§14, Path G) ---
// Gated mode ids per supported runtime. Claude bidi uses `default` for
// recommended/full-auto and legacy privileged sessions.
assert.equal(getGatedPermissionModeId('claude-stream-json-bidi'), 'default');
assert.equal(getGatedPermissionModeId('codex-app-server-json'), 'on-request-danger-full-access');
// Unsupported runtimes (classic stream, no mid-turn permission channel) -> ''.
assert.equal(getGatedPermissionModeId('claude-stream-json'), '');
assert.equal(getGatedPermissionModeId('codex-json'), '');
assert.equal(getGatedPermissionModeId(''), '');

// Claude bidi uses default when a session enables the privileged approval path.
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { privilegedMode: true }).claudePermissionMode,
  'default',
);
assert.equal(
  resolveProviderPermissionPolicy('codex-app-server-json', { privilegedMode: true }).approvalPolicy,
  'untrusted',
);
assert.equal(
  resolveProviderPermissionPolicy('codex-app-server-json', { privilegedMode: true }).sandbox,
  'danger-full-access',
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { privilegedMode: true, permissionMode: 'bypassPermissions' }).claudePermissionMode,
  'default',
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { permissionMode: 'default' }).claudePermissionMode,
  'default',
  'Claude default preferences must preserve the approval-capable native mode',
);

// DEFAULT-OFF no-op: privilegedMode absent/false/unsupported MUST reproduce the
// exact current behavior (bypass default), proving the change touches no live path.
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', {}).claudePermissionMode,
  'bypassPermissions',
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { privilegedMode: false }).claudePermissionMode,
  'bypassPermissions',
);
assert.equal(
  resolveProviderPermissionPolicy('codex-app-server-json', {}).id,
  'never-danger-full-access',
);
// Unsupported runtime with privilegedMode ON falls through to normal resolution.
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json', { privilegedMode: true }).claudePermissionMode,
  'bypassPermissions',
);

// Claude bidi uses its supported default gate for both risk-gated modes.
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'recommended' }).claudePermissionMode,
  'default',
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'safe' }).claudePermissionMode,
  'default',
);
assert.equal(
  resolveProviderPermissionPolicy('codex-app-server-json', { riskMode: 'recommended' }).approvalPolicy,
  'untrusted',
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'recommended', permissionMode: 'bypassPermissions' }).claudePermissionMode,
  'default',
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'recommended', permissionMode: 'default' }).claudePermissionMode,
  'default',
  'Claude bidi uses a supported approval channel for risk-gated sessions',
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'full-auto' }).claudePermissionMode,
  'default',
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { privilegedMode: true, riskMode: 'full-auto' }).claudePermissionMode,
  'default',
);
for (const platform of ['win32', 'linux', 'darwin']) {
  assert.equal(resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'full-auto', platform }).claudePermissionMode, 'default');
}
for (const riskMode of ['recommended', 'full-auto']) {
  const gated = buildRuntimeInvocation('claude-stream-json-bidi', 'hello', { riskMode }, 'claude-bidi');
  const index = gated.args.indexOf('--settings');
  assert.ok(index >= 0);
  assert.deepEqual(JSON.parse(gated.args[index + 1]).permissions.ask, ['Bash', 'PowerShell']);
}
assert.throws(() => buildRuntimeInvocation('claude-stream-json', 'hello', { riskMode: 'full-auto' }, 'claude'), { code: 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME' });
assert.equal(
  resolveProviderPermissionPolicy('codex-app-server-json', { riskMode: 'full-auto' }).id,
  'untrusted-danger-full-access',
);
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'conservative-auto', permissionMode: 'bypassPermissions' }).id,
  'auto',
);
assert.equal(
  resolveProviderPermissionPolicy('codex-app-server-json', { riskMode: 'conservative-auto', permissionMode: 'never-danger-full-access' }).id,
  'untrusted-workspace-write',
);
assert.equal(
  resolveProviderPermissionPolicy('codex-json', { riskMode: 'conservative-auto' }).id,
  'never-workspace-write',
);
for (const runtimeFamily of ['cline-json', 'kilo-json']) {
  assert.equal(resolveProviderPermissionPolicy(runtimeFamily, { riskMode: 'conservative-auto' }).id, 'headless-deny');
}
assert.equal(resolveProviderPermissionPolicy('cline-json', { riskMode: 'full-auto', platform: 'linux' }).id, 'yolo');
assert.equal(resolveProviderPermissionPolicy('kilo-json', { riskMode: 'full-auto', platform: 'linux' }).id, 'auto');
assert.equal(resolveProviderPermissionPolicy('opencode-json', { riskMode: 'full-auto', platform: 'linux' }).id, 'auto');
assert.equal(resolveProviderPermissionPolicy('opencode-json', { riskMode: 'conservative-auto' }), null);
assert.equal(resolveProviderPermissionPolicy('qwen-code-acp', { riskMode: 'full-auto', platform: 'linux' }).id, 'yolo');
assert.equal(resolveProviderPermissionPolicy('qwen-code-acp', { riskMode: 'conservative-auto' }).id, 'auto');
assert.equal(resolveProviderPermissionPolicy('kimi-code-acp', { riskMode: 'full-auto', platform: 'linux' }).id, 'yolo');
assert.equal(resolveProviderPermissionPolicy('kimi-code-acp', { riskMode: 'conservative-auto' }).id, 'auto');
assert.equal(resolveProviderPermissionPolicy('kimi-code-acp', { riskMode: 'conservative-auto', permissionMode: 'yolo' }).id, 'auto',
  'the conservative profile must not inherit Kimi 2.x approve-everything mode');
assert.equal(resolveProviderPermissionPolicy('kimi-code-acp', {}), null);
assert.equal(resolveProviderPermissionPolicy('qwen-code-acp', {}), null);
assert.equal(resolveProviderPermissionPolicy('kimi-code-acp', { riskMode: 'unexpected' }), null);
assert.equal(resolveProviderPermissionPolicy('qwen-code-acp', { riskMode: 'unexpected' }), null);
assert.equal(resolveProviderPermissionPolicy('hermes-acp', { riskMode: 'full-auto' }), null);
// Unsupported runtime with a gated riskMode falls through to normal resolution
// (observation-only for classic stream runtimes — no stdin channel to gate).
assert.equal(
  resolveProviderPermissionPolicy('claude-stream-json', { riskMode: 'recommended' }).claudePermissionMode,
  'bypassPermissions',
);

console.log('test-provider-contract: ok');
