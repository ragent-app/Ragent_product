import { WORKBENCH_EXECUTION_POLICY } from '../lib/workbench-execution-policy.mjs';
const CODEX_APPROVAL_POLICIES = [
  { id: 'untrusted', label: 'untrusted' },
  { id: 'on-request', label: 'on-request' },
  { id: 'on-failure', label: 'on-failure', deprecated: true },
  { id: 'never', label: 'never' },
];

const CODEX_SANDBOX_MODES = [
  {
    id: 'read-only',
    label: 'read-only',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  },
  {
    id: 'workspace-write',
    label: 'workspace-write',
    sandboxPolicy: {
      type: 'workspaceWrite',
      networkAccess: false,
      writableRoots: [],
    },
  },
  {
    id: 'danger-full-access',
    label: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
  },
];

function buildCodexApprovalSandboxModes() {
  const modes = [];
  for (const approval of CODEX_APPROVAL_POLICIES) {
    for (const sandbox of CODEX_SANDBOX_MODES) {
      modes.push({
        id: `${approval.id}-${sandbox.id}`,
        label: `${approval.label} / ${sandbox.label}${approval.deprecated ? ' (deprecated)' : ''}`,
        approvalPolicy: approval.id,
        sandbox: sandbox.id,
        sandboxPolicy: sandbox.sandboxPolicy,
        ...(approval.deprecated ? { deprecated: true } : {}),
        ...(
          approval.id === 'never' && sandbox.id === 'read-only'
            ? { aliases: ['read-only'] }
            : {}
        ),
        ...(
          approval.id === 'never' && sandbox.id === 'danger-full-access'
            ? { aliases: ['full-access'] }
            : {}
        ),
      });
    }
  }
  return modes;
}

const CODEX_APPROVAL_SANDBOX_PERMISSION_MODES = buildCodexApprovalSandboxModes();

const CODEX_CLI_PERMISSION_MODES = [
  ...CODEX_APPROVAL_SANDBOX_PERMISSION_MODES,
  {
    id: 'bypass-approvals-and-sandbox',
    label: 'bypass approvals+sandbox',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
    dangerouslyBypassApprovalsAndSandbox: true,
  },
];

const CLAUDE_PERMISSION_MODES = [
  {
    id: 'acceptEdits',
    label: 'acceptEdits',
    claudePermissionMode: 'acceptEdits',
    dangerouslySkipPermissions: false,
  },
  {
    id: 'auto',
    label: 'auto',
    claudePermissionMode: 'auto',
    dangerouslySkipPermissions: false,
  },
  {
    id: 'dontAsk',
    label: 'dontAsk',
    claudePermissionMode: 'dontAsk',
    dangerouslySkipPermissions: false,
  },
  {
    id: 'default',
    label: 'default',
    claudePermissionMode: 'default',
    dangerouslySkipPermissions: false,
  },
  {
    id: 'plan',
    label: 'plan',
    claudePermissionMode: 'plan',
    dangerouslySkipPermissions: false,
  },
  {
    id: 'bypassPermissions',
    label: 'bypassPermissions',
    claudePermissionMode: 'bypassPermissions',
    dangerouslySkipPermissions: true,
    aliases: ['skip-permissions'],
  },
];

const PROVIDER_CAPABILITIES = {
  'claude-stream-json': {
    provider: 'claude',
    runtimeFamily: 'claude-stream-json',
    transport: 'process-jsonl',
    permissionModel: 'claude-code-tools',
    defaultPermissionMode: 'bypassPermissions',
    permissionModes: CLAUDE_PERMISSION_MODES,
    supportsAllowedToolsPermissionList: true,
    supportsTextDelta: true,
    supportsReasoningDelta: true,
    supportsToolEvents: true,
    supportsFileEvents: true,
    supportsFileStats: true,
    supportsPlanArtifact: false,
    supportsStructuredPlanFallback: true,
    supportsRevise: false,
    supportsExecute: true,
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'claude-stream-json-bidi': {
    provider: 'claude',
    runtimeFamily: 'claude-stream-json-bidi',
    transport: 'process-jsonl-bidi',
    permissionModel: 'claude-code-tools',
    defaultPermissionMode: 'bypassPermissions',
    permissionModes: CLAUDE_PERMISSION_MODES,
    supportsAllowedToolsPermissionList: true,
    supportsTextDelta: true,
    supportsReasoningDelta: true,
    supportsToolEvents: true,
    supportsFileEvents: true,
    supportsFileStats: true,
    supportsPlanArtifact: false,
    supportsStructuredPlanFallback: true,
    supportsRevise: false,
    supportsExecute: true,
    supportsResume: true,
    // Long-lived bidirectional process enables turn interrupt (signal) and
    // stop-and-redirect steer (interrupt + next-turn user message). See
    // chat/claude-bidi-protocol.mjs for the honest semantics.
    supportsSteer: true,
    supportsInterrupt: true,
    supportsManagedActionMcp: true,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'codex-json': {
    provider: 'codex',
    runtimeFamily: 'codex-json',
    transport: 'process-jsonl',
    permissionModel: 'codex-approval-sandbox',
    defaultPermissionMode: 'bypass-approvals-and-sandbox',
    planDefaultPermissionMode: 'never-read-only',
    permissionModes: CODEX_CLI_PERMISSION_MODES,
    supportsTextDelta: true,
    supportsReasoningDelta: true,
    supportsToolEvents: true,
    supportsFileEvents: true,
    supportsFileStats: true,
    supportsPlanArtifact: true,
    supportsStructuredPlanFallback: false,
    supportsRevise: true,
    supportsExecute: true,
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsExternalUsageProjection: true,
    rawEventPersistence: true,
  },
  'codex-app-server-json': {
    provider: 'codex',
    runtimeFamily: 'codex-app-server-json',
    transport: 'json-rpc-stdio',
    permissionModel: 'codex-approval-sandbox',
    defaultPermissionMode: 'never-danger-full-access',
    planDefaultPermissionMode: 'never-read-only',
    permissionModes: CODEX_APPROVAL_SANDBOX_PERMISSION_MODES,
    supportsTextDelta: true,
    supportsReasoningDelta: true,
    supportsToolEvents: true,
    supportsFileEvents: true,
    supportsFileStats: true,
    supportsPlanArtifact: true,
    supportsStructuredPlanFallback: false,
    supportsRevise: true,
    supportsExecute: true,
    supportsResume: true,
    supportsSteer: true,
    supportsInterrupt: true,
    supportsManagedActionMcp: true,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'copilot-json': {
    provider: 'copilot',
    runtimeFamily: 'copilot-json',
    transport: 'process-jsonl',
    permissionModel: 'process-boundary',
    supportsTextDelta: true,
    supportsReasoningDelta: true,
    supportsToolEvents: true,
    supportsFileEvents: true,
    supportsFileStats: true,
    supportsPlanArtifact: true,
    supportsStructuredPlanFallback: false,
    supportsRevise: true,
    supportsExecute: true,
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'hermes-acp': {
    provider: 'hermes',
    runtimeFamily: 'hermes-acp',
    transport: 'process-jsonl',
    permissionModel: 'process-boundary',
    supportsTextDelta: true,
    supportsReasoningDelta: true,
    supportsToolEvents: true,
    supportsFileEvents: false,
    supportsFileStats: false,
    supportsPlanArtifact: false,
    supportsStructuredPlanFallback: true,
    supportsRevise: false,
    supportsExecute: true,
    // Hermes ACP supports session/load. AgentoC does not yet translate ACP
    // request_permission into the privileged approval response channel, so
    // approval remains explicitly unsupported until that bridge exists.
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsApproval: false,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'agy-json': {
    provider: 'antigravity',
    runtimeFamily: 'agy-json',
    transport: 'process-jsonl',
    permissionModel: 'process-boundary',
    supportsTextDelta: true,
    supportsReasoningDelta: false,
    supportsToolEvents: false,
    supportsFileEvents: false,
    supportsFileStats: false,
    supportsPlanArtifact: false,
    supportsStructuredPlanFallback: true,
    supportsRevise: false,
    supportsExecute: true,
    supportsQueuedMessageMutations: true,
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'agy-stream-json': {
    provider: 'antigravity',
    runtimeFamily: 'agy-stream-json',
    transport: 'process-jsonl',
    permissionModel: 'process-boundary',
    supportsTextDelta: true,
    supportsReasoningDelta: false,
    supportsToolEvents: true,
    supportsFileEvents: true,
    supportsFileStats: false,
    supportsPlanArtifact: false,
    supportsStructuredPlanFallback: true,
    supportsRevise: false,
    supportsExecute: true,
    supportsQueuedMessageMutations: true,
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'pi-rpc-jsonl': {
    provider: 'pi',
    runtimeFamily: 'pi-rpc-jsonl',
    transport: 'process-jsonl-bidi',
    permissionModel: 'process-boundary',
    supportsTextDelta: true,
    supportsReasoningDelta: true,
    supportsToolEvents: true,
    supportsFileEvents: true,
    supportsFileStats: false,
    supportsPlanArtifact: false,
    supportsStructuredPlanFallback: true,
    supportsRevise: false,
    supportsExecute: true,
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'deepseek-harness-acp': {
    provider: 'deepseek-harness',
    runtimeFamily: 'deepseek-harness-acp',
    transport: 'process-jsonl',
    permissionModel: 'process-boundary',
    supportsTextDelta: true,
    supportsReasoningDelta: true,
    supportsToolEvents: true,
    supportsFileEvents: false,
    supportsFileStats: false,
    supportsPlanArtifact: false,
    supportsStructuredPlanFallback: true,
    supportsRevise: false,
    supportsExecute: true,
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'qwen-code-acp': {
    provider: 'qwen-code',
    runtimeFamily: 'qwen-code-acp',
    transport: 'process-jsonl',
    permissionModel: 'process-boundary',
    defaultPermissionMode: 'yolo',
    permissionModes: [{ id: 'yolo', label: 'yolo' }, { id: 'auto', label: 'auto' }],
    supportsTextDelta: true,
    supportsReasoningDelta: true,
    supportsToolEvents: true,
    supportsFileEvents: false,
    supportsFileStats: false,
    supportsPlanArtifact: false,
    supportsStructuredPlanFallback: true,
    supportsRevise: false,
    supportsExecute: true,
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'opencode-json': {
    provider: 'opencode',
    runtimeFamily: 'opencode-json',
    transport: 'process-jsonl',
    permissionModel: 'process-boundary',
    defaultPermissionMode: 'auto',
    permissionModes: [{ id: 'auto', label: 'auto' }],
    supportsTextDelta: true,
    supportsReasoningDelta: true,
    supportsToolEvents: true,
    supportsFileEvents: true,
    supportsFileStats: false,
    supportsPlanArtifact: false,
    supportsStructuredPlanFallback: true,
    supportsRevise: false,
    supportsExecute: true,
    supportsResume: true,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'kimi-code-acp': {
    provider: 'kimi-code',
    runtimeFamily: 'kimi-code-acp',
    transport: 'process-jsonl',
    permissionModel: 'process-boundary',
    defaultPermissionMode: 'yolo',
    permissionModes: [{ id: 'auto', label: 'auto' }, { id: 'yolo', label: 'yolo' }],
    supportsTextDelta: true,
    supportsReasoningDelta: true,
    supportsToolEvents: true,
    supportsFileEvents: false,
    supportsFileStats: false,
    supportsPlanArtifact: false,
    supportsStructuredPlanFallback: true,
    supportsRevise: false,
    supportsExecute: true,
    supportsResume: false,
    supportsSteer: false,
    supportsInterrupt: false,
    supportsExternalUsageProjection: false,
    rawEventPersistence: true,
  },
  'goose-headless': {
    provider: 'goose', runtimeFamily: 'goose-headless', transport: 'process-jsonl',
    permissionModel: 'process-boundary', supportsTextDelta: true, supportsReasoningDelta: true,
    supportsToolEvents: true, supportsFileEvents: true, supportsFileStats: false,
    supportsPlanArtifact: false, supportsStructuredPlanFallback: true, supportsRevise: false,
    supportsExecute: true, supportsResume: false, supportsSteer: false, supportsInterrupt: false,
    supportsExternalUsageProjection: false, rawEventPersistence: true,
  },
  'openhands-headless': {
    provider: 'openhands', runtimeFamily: 'openhands-headless', transport: 'process-jsonl',
    permissionModel: 'process-boundary', supportsTextDelta: false, supportsReasoningDelta: false,
    supportsToolEvents: false, supportsFileEvents: false, supportsFileStats: false,
    supportsPlanArtifact: false, supportsStructuredPlanFallback: true, supportsRevise: false,
    supportsExecute: true, supportsResume: false, supportsSteer: false, supportsInterrupt: false,
    supportsExternalUsageProjection: false, rawEventPersistence: true,
  },
  'cline-json': {
    provider: 'cline', runtimeFamily: 'cline-json', transport: 'process-jsonl',
    permissionModel: 'process-boundary', supportsTextDelta: true, supportsReasoningDelta: true,
    defaultPermissionMode: 'yolo',
    permissionModes: [{ id: 'yolo', label: 'yolo' }, { id: 'headless-deny', label: 'headless deny' }],
    supportsToolEvents: true, supportsFileEvents: true, supportsFileStats: false,
    supportsPlanArtifact: false, supportsStructuredPlanFallback: true, supportsRevise: false,
    supportsExecute: true, supportsResume: true, supportsSteer: false, supportsInterrupt: false,
    supportsApproval: false, supportsExternalUsageProjection: false, rawEventPersistence: true,
  },
  'kilo-json': {
    provider: 'kilo', runtimeFamily: 'kilo-json', transport: 'process-jsonl',
    permissionModel: 'process-boundary', supportsTextDelta: false, supportsReasoningDelta: true,
    defaultPermissionMode: 'auto',
    permissionModes: [{ id: 'auto', label: 'auto' }, { id: 'headless-deny', label: 'headless deny' }],
    supportsToolEvents: true, supportsFileEvents: true, supportsFileStats: false,
    supportsPlanArtifact: false, supportsStructuredPlanFallback: true, supportsRevise: false,
    supportsExecute: true, supportsResume: true, supportsSteer: false, supportsInterrupt: false,
    supportsApproval: false, supportsExternalUsageProjection: false, rawEventPersistence: true,
  },
};

const ERROR_RULES = [
  {
    type: 'auth_missing',
    retryable: false,
    test: /missing bearer token|unauthorized|not authenticated|authentication required|api key/i,
  },
  {
    type: 'rate_limited',
    retryable: true,
    test: /rate limit|too many requests|429/i,
  },
  {
    type: 'model_unavailable',
    retryable: true,
    test: /model .*not (?:found|available)|unknown model|model unavailable|temporarily unavailable/i,
  },
  {
    type: 'sandbox_denied',
    retryable: false,
    test: /sandbox|permission denied|operation not permitted|read-only/i,
  },
  {
    type: 'tool_denied',
    retryable: false,
    test: /tool .*denied|user denied|approval denied|not allowed/i,
  },
  {
    type: 'transport_broken',
    retryable: true,
    test: /econnreset|econnrefused|broken pipe|socket hang up|connection .*closed|transport|stdio/i,
  },
  {
    type: 'process_crashed',
    retryable: true,
    test: /process .*crash|exit code|signal|terminated|spawn .*enoent|command not found/i,
  },
  {
    type: 'user_cancelled',
    retryable: false,
    test: /cancelled|canceled|interrupted by user|abort/i,
  },
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

export function getProviderCapabilities(runtimeFamily) {
  const key = trimString(runtimeFamily);
  const capabilities = PROVIDER_CAPABILITIES[key];
  return capabilities ? cloneJson(capabilities) : null;
}

export function resolveProviderCapabilities(input) {
  if (typeof input === 'string') return getProviderCapabilities(input);
  const runtimeFamily = trimString(input?.runtimeFamily);
  const fallbackCapabilities =
    (input?.providerCapabilities && typeof input.providerCapabilities === 'object' && input.providerCapabilities)
    || (input?.capabilities && typeof input.capabilities === 'object' && input.capabilities)
    || null;
  return getProviderCapabilities(runtimeFamily)
    || (fallbackCapabilities ? cloneJson(fallbackCapabilities) : null);
}

export function hasProviderCapability(input, capabilityName) {
  const key = trimString(capabilityName);
  if (!key) return false;
  return resolveProviderCapabilities(input)?.[key] === true;
}

export function getProviderPermissionModes(input) {
  const capabilities = resolveProviderCapabilities(input);
  return Array.isArray(capabilities?.permissionModes)
    ? cloneJson(capabilities.permissionModes)
    : [];
}

function findPermissionMode(capabilities, modeId) {
  const normalizedModeId = trimString(modeId);
  if (!normalizedModeId || !Array.isArray(capabilities?.permissionModes)) return null;
  for (const mode of capabilities.permissionModes) {
    if (trimString(mode?.id) === normalizedModeId) return mode;
    if (Array.isArray(mode?.aliases) && mode.aliases.some((alias) => trimString(alias) === normalizedModeId)) {
      return {
        ...mode,
        id: normalizedModeId,
        canonicalId: mode.id,
      };
    }
  }
  return null;
}

function findPermissionModeByField(capabilities, field, value) {
  const normalizedValue = trimString(value);
  if (!normalizedValue || !Array.isArray(capabilities?.permissionModes)) return null;
  return capabilities.permissionModes.find((mode) => trimString(mode?.[field]) === normalizedValue) || null;
}

// Privileged-approval gate (design §13–§14, Path G). Claude Code 2.1.247
// accepts `default` for an AgentoC-controlled bidirectional gate:
// ordinary/full-auto runs use bypassPermissions, while safe/recommended runs
// enter default so the sidecar can auto-allow ordinary work and surface only
// danger-tier operations for the owner.
const PRIVILEGED_GATED_MODES = Object.freeze({
  'claude-stream-json-bidi': 'default',
  'codex-app-server-json': 'on-request-danger-full-access',
});

// The gated permission-mode id a runtime must run in for the privileged gate to
// fire, or '' if the runtime cannot host privileged mode. Pure lookup.
export function getGatedPermissionModeId(runtimeFamily) {
  return PRIVILEGED_GATED_MODES[trimString(runtimeFamily)] || '';
}

function getProfileGatedPermissionModeId(runtimeFamily) {
  // App Server project trust creates a per-command approval boundary on every
  // supported host. Keep this separate from the sandbox, which controls what
  // the command can reach after Ragent responds to the approval request.
  if (runtimeFamily === 'codex-app-server-json') return 'untrusted-danger-full-access';
  return getGatedPermissionModeId(runtimeFamily);
}

// These ACP adapters currently start in the Harness's own default mode and
// cannot prove an unattended mode switch before sending the first prompt.
export function requiresExplicitAcpAutoMode(runtimeFamily) {
  return trimString(runtimeFamily) === 'hermes-acp';
}

// Permission mode ids are passed through unchanged after capability validation.
// In particular, `default` must never be rewritten to bypassPermissions because
// it is the Claude Code 2.1.247+ mode that preserves the stdio approval gate.
export function normalizeProviderPermissionMode(input, permissionMode) {
  void input;
  return trimString(permissionMode);
}

export function resolveProviderPermissionPolicy(input, options = {}) {
  const capabilities = resolveProviderCapabilities(input);
  if (!capabilities || !Array.isArray(capabilities.permissionModes)) return null;

  if (WORKBENCH_EXECUTION_POLICY && ['codex-json', 'codex-app-server-json'].includes(capabilities.runtimeFamily)) {
    return cloneJson(findPermissionMode(capabilities, WORKBENCH_EXECUTION_POLICY.codexPermissionProfile ? 'never-read-only' : 'untrusted-read-only'));
  }
  const requestedMode = normalizeProviderPermissionMode(capabilities, options.permissionMode);
  const riskMode = trimString(options.riskMode);

  // These ACP modes require a recognized autonomous product profile. Legacy
  // or malformed riskMode values must not inherit an autonomous default.
  if (['qwen-code-acp', 'kimi-code-acp'].includes(capabilities.runtimeFamily)
      && !['full-auto', 'conservative-auto'].includes(riskMode)) return null;

  // Product profiles select the effective Harness boundary. A caller's old
  // permissionMode field cannot silently widen the conservative profile.
  if (riskMode === 'conservative-auto') {
    const profileMode = capabilities.provider === 'claude'
      ? 'auto'
      : capabilities.provider === 'codex'
        ? (capabilities.runtimeFamily === 'codex-app-server-json'
          ? 'untrusted-workspace-write'
          : 'never-workspace-write')
        : capabilities.runtimeFamily === 'qwen-code-acp'
          ? 'auto'
        : capabilities.runtimeFamily === 'kimi-code-acp'
          ? 'auto'
        : ['cline-json', 'kilo-json'].includes(capabilities.runtimeFamily)
          ? 'headless-deny'
        : '';
    const mode = findPermissionMode(capabilities, profileMode);
    return mode ? cloneJson(mode) : null;
  }
  if (riskMode === 'full-auto' && trimString(options.interactionMode) !== 'plan') {
    // Windows autonomous runs must reach the same AgentoC decision gate as
    // approval runs; only the treatment of an ASK differs. Keep unsupported
    // harnesses explicit instead of silently claiming that bypass is gated.
    if ((options.platform || process.platform) === 'win32'
        || capabilities.runtimeFamily === 'claude-stream-json-bidi'
        || capabilities.runtimeFamily === 'codex-app-server-json') {
      const gatedId = getProfileGatedPermissionModeId(capabilities.runtimeFamily);
      return gatedId ? cloneJson(findPermissionMode(capabilities, gatedId)) : null;
    }
    const mode = findPermissionMode(capabilities, capabilities.defaultPermissionMode);
    return mode ? cloneJson(mode) : null;
  }

  // Gated modes (design §13–§14 Path G + 统一风险门控计划 phase 3): an explicit
  // per-session opt-in — legacy `privilegedMode` or the new `riskMode`
  // safe/recommended — forces a provider gate. Claude bidi uses `default`.
  // This deliberately takes precedence over a requested bypass so
  // a session's risk policy cannot be silently disabled by the provider mode.
  const gatedByRiskMode = riskMode === 'safe' || riskMode === 'recommended';
  if ((options.privilegedMode === true && riskMode !== 'full-auto' && riskMode !== 'conservative-auto') || gatedByRiskMode) {
    const gatedId = getProfileGatedPermissionModeId(capabilities.runtimeFamily);
    if (gatedId) {
      const gatedMode = findPermissionMode(capabilities, gatedId);
      if (gatedMode) return cloneJson(gatedMode);
    }
  }

  let mode = requestedMode ? findPermissionMode(capabilities, requestedMode) : null;

  if (!mode && capabilities.provider === 'codex' && trimString(options.interactionMode) === 'plan') {
    mode = findPermissionMode(capabilities, capabilities.planDefaultPermissionMode);
  }

  // Claude Code plan mode is an approval mode (`--permission-mode plan`), not a
  // separate CLI switch like Codex. When the composer Plan agent requests
  // interactionMode 'plan' for the bidi runtime (the only claude family with a
  // permission channel), resolve it to the plan permission mode so the run
  // actually drafts a plan and surfaces the ExitPlanMode approval. Explicit
  // permissionMode above always wins; one-shot claude-stream-json has no
  // permission channel, so plan mode there would stall — leave it untouched.
  if (!mode && capabilities.provider === 'claude'
    && capabilities.runtimeFamily === 'claude-stream-json-bidi'
    && trimString(options.interactionMode) === 'plan') {
    mode = findPermissionMode(capabilities, 'plan');
  }

  if (!mode && capabilities.provider === 'claude'
    && Object.prototype.hasOwnProperty.call(options, 'dangerouslySkipPermissions')) {
    mode = capabilities.permissionModes.find((candidate) =>
      candidate?.dangerouslySkipPermissions === (options.dangerouslySkipPermissions === true),
    ) || null;
  }

  if (!mode) {
    mode = findPermissionMode(capabilities, capabilities.defaultPermissionMode)
      || capabilities.permissionModes[0]
      || null;
  }

  return mode ? cloneJson(mode) : null;
}

export function buildProviderContractFields(runtimeFamily, fallback = {}) {
  const fallbackCapabilities = fallback?.providerCapabilities && typeof fallback.providerCapabilities === 'object'
    ? cloneJson(fallback.providerCapabilities)
    : null;
  const resolvedCapabilities = getProviderCapabilities(runtimeFamily)
    || fallbackCapabilities;
  const capabilities = resolvedCapabilities
    ? {
        ...resolvedCapabilities,
        ...(getProviderCapabilities(runtimeFamily)
          ? {
              supportsSemanticHydrate: resolvedCapabilities.supportsSemanticHydrate !== false,
              contextCompiler: resolvedCapabilities.contextCompiler || 'runtime-context-compiler-v1',
              contextTokenizer: resolvedCapabilities.contextTokenizer || 'conservative-char-estimate',
            }
          : {}),
      }
    : null;
  const normalizedRuntimeFamily = trimString(
    capabilities?.runtimeFamily
      || runtimeFamily
      || fallback?.runtimeFamily,
  );
  const provider = trimString(
    capabilities?.provider
      || fallback?.provider,
  );

  return {
    ...(provider ? { provider } : {}),
    ...(normalizedRuntimeFamily ? { runtimeFamily: normalizedRuntimeFamily } : {}),
    ...(capabilities ? { providerCapabilities: cloneJson(capabilities) } : {}),
  };
}

export function classifyProviderError(input) {
  const message = readProviderErrorMessage(input);
  for (const rule of ERROR_RULES) {
    if (rule.test.test(message)) {
      return {
        type: rule.type,
        retryable: rule.retryable,
        message,
      };
    }
  }
  return {
    type: message ? 'provider_error' : 'malformed_provider_event',
    retryable: false,
    message: message || 'unknown error',
  };
}

export function readProviderErrorMessage(input) {
  if (typeof input === 'string') return input.trim();
  if (!input || typeof input !== 'object') return '';
  const candidates = [
    input.message,
    input.additionalDetails,
    input.error,
    input.error?.message,
    input.error?.additionalDetails,
    input.params?.message,
    input.params?.error?.message,
    input.params?.error?.additionalDetails,
    input.result?.error,
  ];
  const parts = [];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() && !parts.includes(candidate.trim())) {
      parts.push(candidate.trim());
    }
  }
  if (parts.length > 0) {
    return parts.join(' | ');
  }
  try {
    const serialized = JSON.stringify(input);
    return serialized && serialized !== '{}' ? serialized : '';
  } catch {
    return '';
  }
}

function redactProviderErrorSecrets(text) {
  return String(text || '')
    .replace(/\bsk-[A-Za-z0-9_.*-]{12,}\b/g, (value) => (
      value.includes('*') ? value : `${value.slice(0, 8)}...redacted`
    ));
}

function clipProviderErrorMessage(text, maxChars = 800) {
  const normalized = redactProviderErrorSecrets(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

export function annotateProviderError(fields = {}, input) {
  const classification = classifyProviderError(input);
  const message = clipProviderErrorMessage(readProviderErrorMessage(input));
  return {
    ...fields,
    providerErrorType: classification.type,
    providerErrorRetryable: classification.retryable,
    ...(message ? { providerErrorMessage: message } : {}),
  };
}
